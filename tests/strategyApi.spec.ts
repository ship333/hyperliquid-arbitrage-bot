import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import request from 'supertest';
import os from 'os';
import path from 'path';
import fs from 'fs/promises';

let tmpDir: string;

beforeAll(async () => {
  tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'arb-strat-'));
  process.env.DATA_DIR = tmpDir; // ensure file-backed store uses isolated dir
});

afterAll(async () => {
  if (tmpDir) {
    try { await fs.rm(tmpDir, { recursive: true, force: true }); } catch {}
  }
});

describe('Strategy API integration', () => {
  it('creates, backtests, and approves a strategy', async () => {
    const { app } = await import('../src/api/app');

    // 1) Create strategy
    const createRes = await request(app)
      .post('/api/strategy')
      .send({ name: 'Test Tri', kind: 'triangular', params: {} })
      .expect(201);

    const id = createRes.body.id as string;
    expect(id).toBeTruthy();

    // 2) Upload backtest with >=24h coverage
    const now = Date.now();
    const start = now - 26 * 3600_000;
    const btRes = await request(app)
      .post(`/api/strategy/${id}/backtest`)
      .send({
        startedAt: start,
        endedAt: now,
        stats: {
          evAdjUsd: 10,
          pSuccess: 0.8,
          maxDrawdown: 0,
          hitRate: 0.75,
          pnlUsd: 100,
          samples: 1000,
        },
      })
      .expect(201);

    expect(btRes.body.coverageHours).toBeGreaterThanOrEqual(24);

    // 3) Approve per policy
    const approve = await request(app)
      .post(`/api/strategy/${id}/approve`)
      .expect(200);

    expect(approve.body.status).toBe('approved');
    expect(approve.body.strategy.status).toBe('approved');

    // 4) Fetch strategy
    const getRes = await request(app).get(`/api/strategy/${id}`).expect(200);
    expect(getRes.body.status).toBe('approved');
  });
});
