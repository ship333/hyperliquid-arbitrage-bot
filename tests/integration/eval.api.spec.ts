import request from 'supertest';
import { describe, it, expect } from 'vitest';
import { app } from '../../src/api/app';

describe('API /api/eval/batch', () => {
  it('responds with extended metrics and legacy fields', async () => {
    const res = await request(app)
      .post('/api/eval/batch')
      .send({
        items: [
          {
            edgeBps: 20,
            notionalUsd: 10_000,
            fees: { totalFeesBps: 8, flashFeeBps: 0, referralBps: 0, executorFeeUsd: 0, flashFixedUsd: 0 },
            frictions: { gasUsdMean: 0.2, adverseUsdMean: 0.8 },
            latency: { latencySec: 0.8, edgeDecayBpsPerSec: 1.2, baseFillProb: 0.85, theta: 0.15 },
            slippage: { kind: 'empirical', k: 0.9, alpha: 1.2, liquidityRefUsd: 1_500_000 },
            failures: { failBeforeFillProb: 0.02, failBetweenLegsProb: 0.01, reorgOrMevProb: 0.0 },
            flashEnabled: false,
            riskAversion: 0.00005,
            capitalUsd: 20_000,
          },
        ],
      })
      .expect(200);

    expect(Array.isArray(res.body?.items)).toBe(true);
    const item = res.body.items[0];

    // Extended fields
    expect(typeof item.ev_per_sec).toBe('number');
    expect(typeof item.size_opt_usd).toBe('number');
    expect(typeof item.p_success).toBe('number');

    // Legacy compatibility
    expect(typeof item.gas_usd).toBe('number');
    expect(typeof item.seconds).toBe('number');
    expect(typeof item.slip_bps_eff).toBe('number');
  });
});
