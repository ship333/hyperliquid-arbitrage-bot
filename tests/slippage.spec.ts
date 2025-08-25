import { describe, it, expect } from 'vitest';
import { effectiveSlipBps } from '../src/eval/slippage';

// Note: empirical slippage is monotone increasing w.r.t size in our model.

describe('slippage', () => {
  it('empirical slippage increases with trade size', () => {
    const model = { kind: 'empirical' as const, k: 1.0, alpha: 1.2, liquidityRefUsd: 1_000_000 };
    const s1 = effectiveSlipBps(model, 1_000);
    const s2 = effectiveSlipBps(model, 10_000);
    const s3 = effectiveSlipBps(model, 100_000);
    expect(s1).toBeGreaterThanOrEqual(0);
    expect(s2).toBeGreaterThanOrEqual(s1);
    expect(s3).toBeGreaterThanOrEqual(s2);
  });

  it('empirical slippage is near-zero if k=0 (degenerate)', () => {
    const model = { kind: 'empirical' as const, k: 0.0, alpha: 1.0, liquidityRefUsd: 1_000_000 };
    const s = effectiveSlipBps(model, 50_000);
    expect(s).toBe(0);
  });
});
