// UniV3 Q64.96 math helpers and a simple non-crossing swap simulator.
// Assumptions: small trade that does not cross a tick; constant liquidity within range.
// For production, extend to walk initialized ticks and update liquidity per tick.

export const Q96 = BigInt(2) ** BigInt(96);

export function toBigInt(value: string | number | bigint): bigint {
  if (typeof value === "bigint") return value;
  if (typeof value === "number") return BigInt(Math.floor(value));
  return BigInt(value);
}

export type Tick = { index: number; liquidityNet: bigint; sqrtPriceX96?: bigint };

export type SimWithTicksInput = {
  sqrtPriceX96: string;
  liquidity: string;
  feeTierBps: number;
  amountIn: string;
  zeroForOne: boolean;
  ticks: Tick[]; // sorted by index ascending
  tickSpacing?: number;
};

// Conservative tick-walking: adjusts liquidity at tick boundaries if provided and simulates across segments.
export function simulateUniV3WithTicksSlipBps(inp: SimWithTicksInput): { slipBps: number } {
  try {
    let P = toBigInt(inp.sqrtPriceX96);
    let L = toBigInt(inp.liquidity);
    let remaining = toBigInt(inp.amountIn);
    const fee = inp.feeTierBps;
    const dirRight = !inp.zeroForOne; // zeroForOne moves left (lower ticks), else right

    const ticks = [...inp.ticks].sort((a, b) => a.index - b.index).map(t => ({
      index: t.index,
      liquidityNet: BigInt(t.liquidityNet),
      sqrtPriceX96: t.sqrtPriceX96 ? BigInt(t.sqrtPriceX96) : undefined,
    }));

    // iterate through segments; limit iterations to avoid infinite loops
    let safety = 0;
    let totalOut = 0n;
    while (remaining > 0n && L > 0n && safety++ < 128) {
      // Determine next boundary sqrt based on tick direction if provided
      const nextTick = dirRight ? ticks.find(t => (t.sqrtPriceX96 && t.sqrtPriceX96 > P))
                                : [...ticks].reverse().find(t => (t.sqrtPriceX96 && t.sqrtPriceX96 < P));
      // If no boundary known, perform no-cross on remainder and finish
      if (!nextTick || !nextTick.sqrtPriceX96) {
        const { amountOut } = swapNoCross(P, L, remaining, inp.zeroForOne, fee);
        totalOut += amountOut;
        remaining = 0n;
        break;
      }
      const targetP = nextTick.sqrtPriceX96;
      // Compute max input to move from P to targetP under constant L (no fee yet)
      let maxDx: bigint;
      if (inp.zeroForOne) {
        // token0 in: dx = L * (1/P' - 1/P)
        const oneOverP = mulDiv(Q96, Q96, P);
        const oneOverPt = mulDiv(Q96, Q96, targetP);
        if (oneOverPt <= oneOverP) { // cannot move past
          const { amountOut, newSqrtPriceX96 } = swapNoCross(P, L, remaining, inp.zeroForOne, fee);
          totalOut += amountOut;
          remaining = 0n;
          P = newSqrtPriceX96;
          break;
        }
        const dx = mulDiv(L, (oneOverPt - oneOverP), Q96);
        // apply fee: input needed pre-fee
        const feeDen = 10_000n; const feeN = BigInt(Math.max(0, fee));
        const inputPreFee = mulDiv(dx, feeDen, (feeDen - feeN));
        if (inputPreFee >= remaining) {
          const { amountOut, newSqrtPriceX96 } = swapNoCross(P, L, remaining, inp.zeroForOne, fee);
          totalOut += amountOut;
          remaining = 0n; P = newSqrtPriceX96; break;
        }
        // consume until boundary
        const { amountOut } = swapNoCross(P, L, inputPreFee, inp.zeroForOne, fee);
        totalOut += amountOut; remaining -= inputPreFee; P = targetP;
      } else {
        // token1 in: dy moves sqrt linearly: P' = P + dy/L
        const dyNeeded = mulDiv((targetP - P), L, Q96);
        const feeDen = 10_000n; const feeN = BigInt(Math.max(0, fee));
        const inputPreFee = mulDiv(dyNeeded, feeDen, (feeDen - feeN));
        if (inputPreFee >= remaining) {
          const { amountOut, newSqrtPriceX96 } = swapNoCross(P, L, remaining, inp.zeroForOne, fee);
          totalOut += amountOut;
          remaining = 0n; P = newSqrtPriceX96; break;
        }
        const { amountOut } = swapNoCross(P, L, inputPreFee, inp.zeroForOne, fee);
        totalOut += amountOut; remaining -= inputPreFee; P = targetP;
      }
      // cross tick: update liquidity
      if (nextTick) {
        L = L + nextTick.liquidityNet;
      }
    }

    // compute slippage vs mid at starting price
    // Note: Use starting sqrtPrice since we want impact from mid
    const startP = toBigInt(inp.sqrtPriceX96);
    const midQ96 = mulDiv(startP, startP, Q96);
    if (remaining <= 0n && totalOut > 0n) {
      const realizedQ96 = mulDiv(totalOut * Q96, 1n, toBigInt(inp.amountIn));
      const num = midQ96 > realizedQ96 ? (midQ96 - realizedQ96) : 0n;
      const slip = Number(num) / Number(midQ96 || 1n);
      return { slipBps: Math.max(0, slip * 1e4) };
    }
    // fallback if we couldn't compute
    const { slipBps } = simulateUniV3SlipBps({
      sqrtPriceX96: inp.sqrtPriceX96,
      liquidity: inp.liquidity,
      feeTierBps: inp.feeTierBps,
      amountIn: inp.amountIn,
      zeroForOne: inp.zeroForOne,
    });
    return { slipBps };
  } catch {
    return { slipBps: 0 };
  }
}

export function mulDiv(a: bigint, b: bigint, denom: bigint): bigint {
  return (a * b) / denom;
}

// Computes amountOut for a given amountIn at current sqrtPriceX96 and liquidity, without crossing a tick.
// zeroForOne: token0 -> token1 when true.
// feeBps: pool fee in bps.
export function swapNoCross(
  sqrtPriceX96: bigint,
  liquidity: bigint,
  amountIn: bigint,
  zeroForOne: boolean,
  feeBps: number
): { amountOut: bigint; newSqrtPriceX96: bigint } {
  if (amountIn <= 0n || liquidity <= 0n) return { amountOut: 0n, newSqrtPriceX96: sqrtPriceX96 };
  const feeDen = 10_000n;
  const fee = BigInt(Math.max(0, feeBps));
  const amountInAfterFee = (amountIn * (feeDen - fee)) / feeDen;

  if (zeroForOne) {
    // token0 in, token1 out
    // dx in token0, price moves from P to P' where dx = L * (1/P' - 1/P)
    // Rearranged: 1/P' = 1/P + dx/L -> P' = 1 / (1/P + dx/L)
    const P = sqrtPriceX96;
    // Use exact non-crossing formula from Uniswap V3:
    // token0 -> token1: newSqrtP = (L * sqrtP * Q96) / (L*Q96 + amountInAfterFee * sqrtP)
    const num = liquidity * P * Q96;
    const den = liquidity * Q96 + amountInAfterFee * P;
    const newSqrt = den === 0n ? P : (num / den);
    // amountOut (token1) = L * (oldSqrt - newSqrt) / Q96
    const amountOutY = mulDiv(liquidity, (P - newSqrt), Q96);
    const amountOut = amountOutY > 0n ? amountOutY : 0n; // ensure non-negative
    return { amountOut, newSqrtPriceX96: newSqrt };
  } else {
    // token1 in, token0 out
    // dy in token1: newSqrtP = (L * sqrtP + dy) / L
    // And amountOut0 = L * (1/newSqrtP - 1/oldSqrtP)
    const P = sqrtPriceX96;
    const added = mulDiv(amountInAfterFee, Q96, liquidity);
    const newSqrt = P + added;
    // amountOut0 = L * (1/P - 1/P')
    const oneOverNew = mulDiv(Q96, Q96, newSqrt);
    const oneOverOld = mulDiv(Q96, Q96, P);
    const diff = oneOverOld - oneOverNew; // positive when newSqrt > P
    const amountOut0 = diff > 0n ? mulDiv(liquidity, diff, Q96) : 0n;
    return { amountOut: amountOut0, newSqrtPriceX96: newSqrt };
  }
}

export type UniV3SlipInput = {
  // pool state
  sqrtPriceX96: string; // Q96
  liquidity: string;    // raw
  feeTierBps: number;   // 5, 30, 100
  // trade
  amountIn: string;     // raw units of tokenIn (assuming 1e18 scaling external to this func)
  zeroForOne: boolean;  // token0->token1 when true
};

export function simulateUniV3SlipBps(input: UniV3SlipInput): { slipBps: number } {
  const sqrtP = toBigInt(input.sqrtPriceX96);
  const L = toBigInt(input.liquidity);
  const amtIn = toBigInt(input.amountIn);
  const { amountOut } = swapNoCross(sqrtP, L, amtIn, input.zeroForOne, input.feeTierBps);
  if (amtIn <= 0n || amountOut <= 0n) return { slipBps: 0 };
  // Use Q192 precision for price to avoid quantization: P2_Q192 = sqrtP^2 (Q192)
  const P2_Q192 = sqrtP * sqrtP; // Q192-scaled mid price
  if (amtIn === 0n || P2_Q192 === 0n) return { slipBps: 0 };
  // realized_Q192 = (amountOut/amountIn) * Q192
  const Q192 = Q96 * Q96;
  const realized_Q192 = (amountOut * Q192) / amtIn;
  const num = P2_Q192 > realized_Q192 ? (P2_Q192 - realized_Q192) : 0n;
  // Return fractional bps by scaling before integer division
  const SCALE = 1_000_000_000n; // 1e9
  const slipScaled = (num * SCALE) / P2_Q192; // fraction in [0,1] scaled by 1e9
  const slipBps = (Number(slipScaled) / 1e9) * 1e4;
  return { slipBps: Math.max(0, slipBps) };
}
