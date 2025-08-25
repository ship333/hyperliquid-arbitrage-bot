import { SlippageModel } from "./types";
import { simulateUniV3SlipBps, simulateUniV3WithTicksSlipBps } from "./univ3_math";

// Empirical nonlinear slippage: slip_bps(size) = k * (size/usd_ref)^alpha
export function estimateSlippageBpsEmpirical(
  sizeUsd: number,
  k: number,
  alpha: number,
  liquidityRefUsd: number
): number {
  const ref = Math.max(1e-9, liquidityRefUsd);
  const ratio = Math.max(0, sizeUsd) / ref;
  const slip = Math.max(0, k) * Math.pow(ratio, Math.max(1.0, alpha));
  return slip;
}

// Placeholder for UniV3 exact sim; requires live pool state (ticks/liquidity)
// For now, we expose the API and return zeros. Integrate with on-chain or subgraph later.
export function estimateSlippageUniV3(_: any): { slipInBps: number; slipOutBps: number; minOuts: bigint[] } {
  return { slipInBps: 0, slipOutBps: 0, minOuts: [] };
}

export function effectiveSlipBps(model: SlippageModel, sizeUsd: number): number {
  if (model.kind === "empirical" || model.kind === "amm_v2") {
    const k = model.k ?? 0;
    const alpha = model.alpha ?? 1.25;
    const L = model.liquidityRefUsd ?? 1_000_000; // sane default
    return estimateSlippageBpsEmpirical(sizeUsd, k, alpha, L);
  }
  if (model.kind === "univ3") {
    const { sqrtPriceX96, liquidity, feeTierBps, usdPerTokenIn, zeroForOne } = model as any;
    if (sqrtPriceX96 && liquidity && usdPerTokenIn && Number(usdPerTokenIn) > 0) {
      const fee = Number.isFinite(feeTierBps) ? Number(feeTierBps) : (model.k ? Math.max(0, model.k) : 30);
      const tokenAmountIn = (Math.max(0, sizeUsd) / Number(usdPerTokenIn));
      // assume 18 decimals for tokens by default; callers can pre-scale in the future
      const amtInRaw = BigInt(Math.floor(tokenAmountIn * 1e18));
      if (Array.isArray((model as any).ticks) && (model as any).ticks.length > 0) {
        const uni = simulateUniV3WithTicksSlipBps({
          sqrtPriceX96: String(sqrtPriceX96),
          liquidity: String(liquidity),
          feeTierBps: fee,
          amountIn: amtInRaw.toString(),
          zeroForOne: Boolean(zeroForOne ?? true),
          ticks: (model as any).ticks.map((t: any) => ({
            index: Number(t.index),
            liquidityNet: BigInt(t.liquidityNet),
            sqrtPriceX96: t.sqrtPriceX96 ? BigInt(t.sqrtPriceX96) : undefined,
          })),
          tickSpacing: (model as any).tickSpacing,
        });
        return Math.max(0, uni.slipBps);
      } else {
        const uni = simulateUniV3SlipBps({
          sqrtPriceX96: String(sqrtPriceX96),
          liquidity: String(liquidity),
          feeTierBps: fee,
          amountIn: amtInRaw.toString(),
          zeroForOne: Boolean(zeroForOne ?? true),
        });
        return Math.max(0, uni.slipBps);
      }
    }
    // fallback if insufficient data
    const k = model.k ?? 1.0; // slight conservatism
    const alpha = model.alpha ?? 1.25;
    const L = model.liquidityRefUsd ?? 1_000_000;
    return estimateSlippageBpsEmpirical(sizeUsd, k, alpha, L);
  }
  return 0;
}
