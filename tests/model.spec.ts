import { describe, it, expect } from 'vitest';
import { evaluateArb } from '../src/eval/model';
import { effectiveSlipBps } from '../src/eval/slippage';
import { fillProb } from '../src/eval/latency';
import { ArbInputs } from '../src/eval/types';

function baseInputs(): ArbInputs {
  return {
    edgeBps: 25,
    notionalUsd: 10_000,
    fees: { totalFeesBps: 8, flashFeeBps: 0, referralBps: 0, executorFeeUsd: 0, flashFixedUsd: 0 },
    frictions: { gasUsdMean: 0.2, adverseUsdMean: 0.5 },
    latency: { latencySec: 0.5, edgeDecayBpsPerSec: 1.5, baseFillProb: 0.85, theta: 0.15 },
    slippage: { kind: 'empirical', k: 0.9, alpha: 1.2, liquidityRefUsd: 1_500_000 },
    failures: { failBeforeFillProb: 0.02, failBetweenLegsProb: 0.01, reorgOrMevProb: 0.0 },
    flashEnabled: false,
    riskAversion: 0.00005,
    capitalUsd: 20_000,
  };
}

describe('model.evaluateArb', () => {
  it('breakeven sanity: EV near zero when solving EV=0 edge at fixed size', () => {
    const inp = baseInputs();
    const size = inp.notionalUsd;
    const slip = effectiveSlipBps(inp.slippage, size);
    const feeUsd = (inp.fees.totalFeesBps / 1e4) * size;
    const slipUsd = (slip / 1e4) * size;
    const gasUsd = inp.frictions.gasUsdMean;
    const advUsd = inp.frictions.adverseUsdMean;
    const extraUsd = inp.frictions.extraUsd ?? 0;
    const mevUsd = inp.frictions.mevPenaltyUsd ?? 0;
    const theta = inp.latency.theta ?? 0.15;
    const pS = Math.max(0, Math.min(1, fillProb(inp.latency.baseFillProb, inp.latency.latencySec, theta)));
    const pF0 = Math.max(0, Math.min(1, inp.failures.failBeforeFillProb));
    const pF1 = Math.max(0, Math.min(1, inp.failures.failBetweenLegsProb));
    const pFR = Math.max(0, Math.min(1, inp.failures.reorgOrMevProb));
    const unwindUsd = slipUsd * 0.7;
    const failCostsWeighted = pF1 * unwindUsd + pF0 * gasUsd + pFR * (gasUsd + mevUsd);
    // Solve EV=0 for edgeBps at this fixed size
    const numeratorUsd = feeUsd + slipUsd + gasUsd + advUsd + extraUsd + (failCostsWeighted / Math.max(1e-9, pS));
    const overheadBps = (numeratorUsd / Math.max(1e-9, size)) * 1e4;
    inp.edgeBps = overheadBps;
    // Constrain size search to this notional so breakeven is evaluated at this size
    inp.capitalUsd = size;
    const res = evaluateArb(inp);
    expect(Math.abs(res.ev_per_sec)).toBeLessThan(0.05);
  });

  it('higher latency reduces success prob and EV', () => {
    const a = baseInputs();
    a.latency.latencySec = 0.2;
    const ra = evaluateArb(a);

    const b = baseInputs();
    b.latency.latencySec = 2.0;
    const rb = evaluateArb(b);

    expect(ra.p_success).toBeGreaterThan(rb.p_success);
    expect(ra.net_usd_est).toBeGreaterThan(rb.net_usd_est);
  });

  it('size search picks non-zero but bounded optimal size', () => {
    const inp = baseInputs();
    inp.capitalUsd = 50_000;
    const res = evaluateArb(inp);
    expect(res.size_opt_usd).toBeGreaterThan(0);
    expect(res.size_opt_usd).toBeLessThanOrEqual(inp.capitalUsd);
  });
});
