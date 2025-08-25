import { describe, it, expect } from 'vitest';
import { decayEdge, fillProb } from '../src/eval/latency';

describe('latency', () => {
  it('decayEdge decreases with latency', () => {
    const edge0 = 50; // bps
    const d0 = decayEdge(edge0, 0, 2);
    const d1 = decayEdge(edge0, 1, 2);
    const d2 = decayEdge(edge0, 2, 2);
    expect(d0).toBeGreaterThan(d1);
    expect(d1).toBeGreaterThan(d2);
    expect(d2).toBeGreaterThanOrEqual(0);
  });

  it('fillProb decreases with latency and bounded [0,1]', () => {
    const p0 = fillProb(0.9, 0, 0.2);
    const p1 = fillProb(0.9, 1, 0.2);
    const p2 = fillProb(0.9, 5, 0.2);
    expect(p0).toBeLessThanOrEqual(1);
    expect(p0).toBeGreaterThanOrEqual(0);
    expect(p0).toBeGreaterThan(p1);
    expect(p1).toBeGreaterThan(p2);
  });
});
