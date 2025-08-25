import { describe, it, expect } from 'vitest';
import { checkApproval } from '../src/policy/strategyGate';

describe('strategyGate.checkApproval', () => {
  it('approves when coverage and metrics meet thresholds', () => {
    const res = checkApproval(30, { pSuccess: 0.8, evAdjUsd: 1, maxDrawdown: 0 });
    expect(res.status).toBe('approved');
    expect(res.coverageHours).toBeGreaterThanOrEqual(24);
  });

  it('rejects for insufficient coverage hours', () => {
    const res = checkApproval(12, { pSuccess: 0.9, evAdjUsd: 10, maxDrawdown: 0 });
    expect(res.status).toBe('rejected');
    expect(res.reason).toBe('insufficient_coverage_hours');
  });

  it('rejects when pSuccess below threshold', () => {
    const res = checkApproval(48, { pSuccess: 0.5, evAdjUsd: 10, maxDrawdown: 0 });
    expect(res.status).toBe('rejected');
    expect(res.reason).toBe('p_success_below_threshold');
  });
});
