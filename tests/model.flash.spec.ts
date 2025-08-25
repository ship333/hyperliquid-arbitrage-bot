import { describe, it, expect } from 'vitest';
import { evaluateArb } from '../src/eval/model';
import { ArbInputs } from '../src/eval/types';

function makeInputs(): ArbInputs {
  return {
    edgeBps: 20,
    notionalUsd: 10_000,
    fees: { totalFeesBps: 8, flashFeeBps: 0, referralBps: 0, executorFeeUsd: 0, flashFixedUsd: 0 },
    frictions: { gasUsdMean: 0.2, adverseUsdMean: 0.8 },
    latency: { latencySec: 0.6, edgeDecayBpsPerSec: 1.0, baseFillProb: 0.85, theta: 0.15 },
    slippage: { kind: 'empirical', k: 1.0, alpha: 1.2, liquidityRefUsd: 1_200_000 },
    failures: { failBeforeFillProb: 0.02, failBetweenLegsProb: 0.01, reorgOrMevProb: 0.0 },
    flashEnabled: false,
    riskAversion: 0.00005,
    capitalUsd: 25_000,
  };
}

describe('model flash fee toggles', () => {
  it('flash on with zero flash fees ~ equal to flash off', () => {
    const a = makeInputs();
    a.flashEnabled = false;
    const ra = evaluateArb(a);

    const b = makeInputs();
    b.flashEnabled = true;
    b.fees.flashFeeBps = 0; b.fees.referralBps = 0; b.fees.executorFeeUsd = 0; b.fees.flashFixedUsd = 0;
    const rb = evaluateArb(b);

    // Expect close results
    expect(Math.abs(ra.ev_per_sec - rb.ev_per_sec)).toBeLessThan(1e-6);
    expect(Math.abs(ra.size_opt_usd - rb.size_opt_usd)).toBeLessThan(1e-6);
  });

  it('higher risk aversion reduces optimal size', () => {
    const low = makeInputs();
    low.riskAversion = 0.0;
    const rLow = evaluateArb(low);

    const high = makeInputs();
    high.riskAversion = 0.005;
    const rHigh = evaluateArb(high);

    expect(rHigh.size_opt_usd).toBeLessThanOrEqual(rLow.size_opt_usd);
  });
});
