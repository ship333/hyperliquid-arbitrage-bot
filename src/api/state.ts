import { ArbitrageOpportunity } from "../feeds/types";
import { Signal } from "../feeds/SignalGenerator";

export interface SystemStats {
  activeSignals: number;
  recentOpportunities: number;
  updatedAt: number;
}

class InMemoryState {
  private _signals: Signal[] = [];
  private _opps: ArbitrageOpportunity[] = [];
  private _updated = Date.now();

  getActiveSignals(): Signal[] {
    return this._signals;
  }

  getRecentOpportunities(limit = 50): ArbitrageOpportunity[] {
    return this._opps.slice(-limit).reverse();
  }

  getStats(): SystemStats {
    return {
      activeSignals: this._signals.length,
      recentOpportunities: this._opps.length,
      updatedAt: this._updated,
    };
  }

  // Hooks for future wiring to feeds pipeline
  upsertSignal(sig: Signal) {
    const idx = this._signals.findIndex(s => s.id === sig.id);
    if (idx >= 0) this._signals[idx] = sig; else this._signals.push(sig);
    this._updated = Date.now();
  }

  addOpportunity(opp: ArbitrageOpportunity) {
    this._opps.push(opp);
    if (this._opps.length > 500) this._opps.shift();
    this._updated = Date.now();
  }
}

export const State = new InMemoryState();

// Optional seed for UI/dev
(function seed() {
  if (process.env.UI_SEED !== "1") return;
  const now = Date.now();
  const opp: ArbitrageOpportunity = {
    id: `seed-${now}`,
    timestamp: now,
    type: "cross_venue",
    path: ["ETH", "USDC"],
    pools: [
      "0x1111111111111111111111111111111111111111",
      "0x2222222222222222222222222222222222222222"
    ],
    routers: [],
    estimatedProfitUsd: 25,
    optimalSizeUsd: 10000,
    maxSizeUsd: 20000,
    minSizeUsd: 1000,
    estimatedGasUsd: 5,
    netProfitUsd: 20,
    confidence: 0.8,
    competitionLevel: 0.5,
    latencyRequirementMs: 500,
    prices: { "ETH/USDC": 3500 },
    liquidity: { buy: 100000, sell: 120000 },
    volumes: {},
    source: "combined"
  } as ArbitrageOpportunity;

  const evaluation = {
    net_usd_est: 18.5,
    ev_per_sec: 10.2,
    size_opt_usd: 9000,
    p_success: 0.92,
    slip_bps_eff: 2.1,
    breakeven_bps: 14.2,
    score: 10.2,
    gas_usd: 5,
    seconds: 0.2,
    flash_fee_bps: 9,
    referral_bps: 0,
    flash_fixed_usd: 0,
    executor_fee_usd: 0,
    flash_cost_usd: 0,
    components: {
      edge_eff_bps: 20,
      after_router_lp_usd: 30,
      slip_cost_usd: 1.2,
    }
  } as any; // keep loose for seed

  const signal: Signal = {
    id: `sig-${now}`,
    timestamp: now,
    opportunity: opp,
    evaluation,
    shouldExecute: true,
    executionSize: 9000,
    expectedValue: evaluation.net_usd_est,
    riskScore: 0.2,
    confidenceScore: opp.confidence,
    validUntil: now + 60_000
  } as Signal;

  State.addOpportunity(opp);
  State.upsertSignal(signal);
})();
