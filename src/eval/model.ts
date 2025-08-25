import { ArbInputs, ArbResult } from "./types";
import { effectiveSlipBps } from "./slippage";
import { decayEdge, fillProb } from "./latency";

// Re-export types for external use
export type { ArbInputs as ArbitrageInput, ArbResult as ArbitrageResult } from "./types";

function clamp01(x: number) { return Math.max(0, Math.min(1, x)); }
function normalVar(std?: number) { return Math.max(0, (std ?? 0) ** 2); }

function flashCostUsd(sizeUsd: number, fees: { flashFeeBps: number; referralBps: number; executorFeeUsd: number; flashFixedUsd: number; }): number {
  const varBps = (fees.flashFeeBps + fees.referralBps) / 1e4;
  return sizeUsd * varBps + (fees.executorFeeUsd || 0) + (fees.flashFixedUsd || 0);
}

function postRouterFees(grossUsd: number, totalFeesBps: number): number {
  return grossUsd * (1 - (totalFeesBps || 0) / 1e4);
}

function secondsFromLatency(latencySec: number) {
  return Math.max(1e-3, latencySec);
}

export function evaluateArb(inputs: ArbInputs): ArbResult {
  const latSec = Math.max(0, inputs.latency.latencySec);
  const edgeEffBps = decayEdge(inputs.edgeBps, latSec, inputs.latency.edgeDecayBpsPerSec);
  const secs = secondsFromLatency(latSec);

  // start with proposed size; later line search adjusts
  const size0 = Math.max(0, inputs.notionalUsd);

  const slipBps = effectiveSlipBps(inputs.slippage, size0);
  const grossUsd = (edgeEffBps / 1e4) * size0; // edge-based PnL
  const feeUsd = (inputs.fees.totalFeesBps / 1e4) * size0; // fees charged on notional

  const gasMean = Math.max(0, inputs.frictions.gasUsdMean);
  const gasVar = normalVar(inputs.frictions.gasUsdStd);
  const advMean = Math.max(0, inputs.frictions.adverseUsdMean);
  const advVar = normalVar(inputs.frictions.adverseUsdStd);
  const extraUsd = Math.max(0, inputs.frictions.extraUsd || 0);
  const mevPenaltyUsd = Math.max(0, inputs.frictions.mevPenaltyUsd || 0);

  const flashUsd = inputs.flashEnabled ? flashCostUsd(size0, inputs.fees) : 0;
  const slipCostUsd = (slipBps / 1e4) * size0;

  const theta = inputs.latency.theta ?? 0.15;
  const pS = clamp01(fillProb(inputs.latency.baseFillProb, latSec, theta));
  const pF0 = clamp01(inputs.failures.failBeforeFillProb);
  const pF1 = clamp01(inputs.failures.failBetweenLegsProb);
  const pFR = clamp01(inputs.failures.reorgOrMevProb);
  const pSum = pS + pF0 + pF1 + pFR;
  const pNone = pSum < 1 ? clamp01(1 - pSum) : 0;

  // Payoffs per state
  // Net payoff when success: gross edge minus fees, slippage, and frictions
  const payoffS = grossUsd - feeUsd - slipCostUsd - gasMean - advMean - flashUsd - extraUsd;
  const unwindCostUsd = slipCostUsd * 0.7; // conservative unwind approx
  const payoffF1 = - unwindCostUsd - gasMean - advMean;
  const payoffF0 = - gasMean;
  const payoffFR = - gasMean - mevPenaltyUsd;

  const EV = pS*payoffS + pF0*payoffF0 + pF1*payoffF1 + pFR*payoffFR + pNone*0;
  // variance approximation: mixture variance + exogenous gas/adverse variances
  const mean = EV;
  const terms = [payoffS, payoffF0, payoffF1, payoffFR, 0];
  const probs = [pS, pF0, pF1, pFR, pNone];
  let mixVar = 0;
  for (let i=0;i<terms.length;i++){ const d = terms[i]-mean; mixVar += probs[i]*d*d; }
  const Var = mixVar + gasVar + advVar;

  // Risk-adjusted objective
  const lambda = Math.max(0, inputs.riskAversion ?? 0);
  const EV_adj = EV - lambda * Var;

  // 1-D line search over size for EV_adj; preserve speed with coarse scan
  const cap = Math.max(size0, inputs.capitalUsd || size0);
  const steps = 12;
  let bestSize = 0, bestEVadjPerSec = -Infinity, bestSnapshot: ArbResult | null = null;
  for (let i=1;i<=steps;i++){
    const size = (i/steps) * cap;
    const slip = effectiveSlipBps(inputs.slippage, size);
    const gross = (edgeEffBps/1e4)*size;
    const fees_i = (inputs.fees.totalFeesBps/1e4)*size;
    const slipCost = (slip/1e4)*size;
    const flash = inputs.flashEnabled ? flashCostUsd(size, inputs.fees) : 0;
    const payoffS_i = gross - fees_i - slipCost - gasMean - advMean - flash - extraUsd;
    const unwind_i = slipCost*0.7;
    const payoffF1_i = - unwind_i - gasMean - advMean;
    const payoffF0_i = - gasMean;
    const payoffFR_i = - gasMean - mevPenaltyUsd;
    const EV_i = pS*payoffS_i + pF0*payoffF0_i + pF1*payoffF1_i + pFR*payoffFR_i;
    const mean_i = EV_i;
    let mixVar_i = 0; for (let j=0;j<4;j++){ const v=[payoffS_i,payoffF0_i,payoffF1_i,payoffFR_i][j]-mean_i; const pj=[pS,pF0,pF1,pFR][j]; mixVar_i += pj*v*v; }
    const Var_i = mixVar_i + gasVar + advVar;
    const EV_adj_i = EV_i - lambda*Var_i;
    const ev_per_sec_i = EV_adj_i / secs;
    if (ev_per_sec_i > bestEVadjPerSec) {
      bestEVadjPerSec = ev_per_sec_i;
      bestSize = size;
      bestSnapshot = {
        net_usd_est: EV_i,
        ev_per_sec: ev_per_sec_i,
        size_opt_usd: size,
        p_success: pS,
        slip_bps_eff: slip,
        breakeven_bps: (slip + inputs.fees.totalFeesBps) + ((gasMean+advMean+flash+extraUsd)/Math.max(1e-9,size))*1e4,
        score: ev_per_sec_i,
        gas_usd: gasMean,
        seconds: secs,
        flash_fee_bps: inputs.fees.flashFeeBps,
        referral_bps: inputs.fees.referralBps,
        flash_fixed_usd: inputs.fees.flashFixedUsd,
        executor_fee_usd: inputs.fees.executorFeeUsd,
        flash_cost_usd: flash,
        components: {
          edge_eff_bps: edgeEffBps,
          after_router_lp_usd: gross - (inputs.fees.totalFeesBps/1e4)*size,
          slip_cost_usd: slipCost,
        }
      };
    }
  }

  return bestSnapshot as ArbResult;
}

// Batch evaluation function
export async function evaluateBatch(inputs: ArbInputs[]): Promise<ArbResult[]> {
  // Process evaluations in parallel for better performance
  return Promise.all(inputs.map(input => Promise.resolve(evaluateArb(input))));
}
