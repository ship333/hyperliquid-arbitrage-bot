import { describe, it, expect } from 'vitest';
import { simulateUniV3SlipBps, Q96 } from '../src/eval/univ3_math';

// Construct a plausible pool state.
const sqrtPriceX96 = ((): string => {
  // price ~ 1.0 => sqrtPrice ~1.0 in Q96
  return Q96.toString();
})();
const liquidity = (1_000_000n * Q96); // arbitrary large liquidity scaled by Q96

function slip(amountInRaw: bigint, feeBps = 30, zeroForOne = true) {
  return simulateUniV3SlipBps({
    sqrtPriceX96,
    liquidity: liquidity.toString(),
    feeTierBps: feeBps,
    amountIn: amountInRaw.toString(),
    zeroForOne,
  }).slipBps;
}

describe('UniV3 no-cross simulator', () => {
  it('slippage increases with amountIn', () => {
    const s1 = slip(10n * 10n ** 18n);      // 10 tokens
    const s2 = slip(100n * 10n ** 18n);     // 100 tokens
    const s3 = slip(1_000n * 10n ** 18n);   // 1,000 tokens
    expect(s1).toBeGreaterThan(0);
    expect(s2).toBeGreaterThan(s1);
    expect(s3).toBeGreaterThan(s2);
  });

  it('higher fee tier yields higher effective slippage', () => {
    const lowFee = slip(100n * 10n ** 18n, 5);
    const hiFee = slip(100n * 10n ** 18n, 100);
    expect(hiFee).toBeGreaterThan(lowFee);
  });
});
