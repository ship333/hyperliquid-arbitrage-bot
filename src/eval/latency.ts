export function decayEdge(edgeBps: number, latencySec: number, edgeDecayBpsPerSec: number): number {
  const e = Math.max(0, edgeBps - Math.max(0, latencySec) * Math.max(0, edgeDecayBpsPerSec));
  return e;
}

export function fillProb(baseFillProb: number, latencySec: number, theta: number = 0.15): number {
  const p = baseFillProb * Math.exp(-Math.max(0, theta) * Math.max(0, latencySec));
  return Math.max(0, Math.min(1, p));
}
