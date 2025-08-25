// Minimal Monte Carlo for VaR/CVaR estimation
import { ArbInputs } from "./types";
import { effectiveSlipBps } from "./slippage";
import { decayEdge, fillProb } from "./latency";

function randn(): number {
  // Box-Muller
  let u = 0, v = 0;
  while (u === 0) u = Math.random();
  while (v === 0) v = Math.random();
  return Math.sqrt(-2.0 * Math.log(u)) * Math.cos(2.0 * Math.PI * v);
}

export function simulatePayouts(inputs: ArbInputs, samples = 2000): number[] {
  const latSec = Math.max(0, inputs.latency.latencySec);
  const edgeEffBps = decayEdge(inputs.edgeBps, latSec, inputs.latency.edgeDecayBpsPerSec);
  const size = Math.max(0, inputs.notionalUsd);
  const theta = inputs.latency.theta ?? 0.15;
  const pS = Math.max(0, Math.min(1, fillProb(inputs.latency.baseFillProb, latSec, theta)));
  const pF0 = Math.max(0, Math.min(1, inputs.failures.failBeforeFillProb));
  const pF1 = Math.max(0, Math.min(1, inputs.failures.failBetweenLegsProb));
  const pFR = Math.max(0, Math.min(1, inputs.failures.reorgOrMevProb));
  const psum = pS + pF0 + pF1 + pFR || 1;
  const qS = pS/psum, qF0=pF0/psum, qF1=pF1/psum, qFR=pFR/psum;

  const flashVarBps = inputs.flashEnabled ? (inputs.fees.flashFeeBps + inputs.fees.referralBps)/1e4 : 0;
  const flashFixed = inputs.flashEnabled ? (inputs.fees.executorFeeUsd + inputs.fees.flashFixedUsd) : 0;

  const out: number[] = new Array(samples);
  for (let i=0;i<samples;i++){
    const gas = Math.max(0, inputs.frictions.gasUsdMean + (inputs.frictions.gasUsdStd||0)*randn());
    const adv = Math.max(0, inputs.frictions.adverseUsdMean + (inputs.frictions.adverseUsdStd||0)*randn());
    const slipBps = effectiveSlipBps(inputs.slippage, size);
    const gross = (edgeEffBps/1e4)*size;
    const postFees = gross * (1 - inputs.fees.totalFeesBps/1e4);
    const slipCost = (slipBps/1e4)*size;
    const flash = size*flashVarBps + flashFixed;

    const r = Math.random();
    let payoff = 0;
    if (r < qS) {
      payoff = postFees - slipCost - gas - adv - flash - (inputs.frictions.extraUsd||0);
    } else if (r < qS + qF0) {
      payoff = -gas;
    } else if (r < qS + qF0 + qF1) {
      payoff = -0.7*slipCost - gas - adv;
    } else {
      payoff = -gas - (inputs.frictions.mevPenaltyUsd||0);
    }
    out[i] = payoff;
  }
  return out;
}

export function varCvar(values: number[], alpha = 0.95): { var: number; cvar: number } {
  if (values.length === 0) return { var: 0, cvar: 0 };
  const sorted = [...values].sort((a,b)=>a-b);
  const idx = Math.max(0, Math.min(sorted.length-1, Math.floor((1-alpha)*sorted.length)));
  const VaR = sorted[idx];
  const tail = sorted.slice(0, idx+1);
  const CVaR = tail.length ? tail.reduce((s,x)=>s+x,0)/tail.length : VaR;
  return { var: VaR, cvar: CVaR };
}
