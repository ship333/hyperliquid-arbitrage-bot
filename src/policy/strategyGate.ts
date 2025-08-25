import { StrategyParams } from '../types/strategy';
import { strategyStore } from '../storage/strategyStore';
import { env } from '../config/env';

export interface GateDecision {
  allowed: boolean;
  reason?: string;
  params?: StrategyParams;
  strategyId?: string;
}

export async function enforceGate(kind: string, preferredStrategyId?: string): Promise<GateDecision> {
  // If preferred strategy is supplied, check it first
  if (preferredStrategyId) {
    const s = await strategyStore.getStrategy(preferredStrategyId);
    if (!s) return { allowed: false, reason: 'strategy_not_found' };
    if (s.status !== 'approved') return { allowed: false, reason: 'strategy_not_approved' };
    return { allowed: true, params: s.params, strategyId: s.id };
  }

  // Otherwise, find any approved for kind
  const approved = await strategyStore.listApprovedByKind(kind);
  if (!approved.length) return { allowed: false, reason: 'no_approved_strategy_for_kind' };

  // Choose the most recently approved
  const chosen = approved.sort((a, b) => (b.updatedAt || 0) - (a.updatedAt || 0))[0];
  return { allowed: true, params: chosen.params, strategyId: chosen.id };
}

export interface ApprovalCheck {
  status: 'approved' | 'rejected';
  coverageHours: number;
  thresholds: { minHours: number; minPSuccess: number; minEvAdjUsd: number; maxDrawdown: number };
  reason?: string;
}

export function checkApproval(coverageHours: number, stats: { pSuccess: number; evAdjUsd: number; maxDrawdown: number }): ApprovalCheck {
  const minHours = env.MIN_BACKTEST_HOURS;
  const minPSuccess = env.MIN_P_SUCCESS;
  const minEvAdjUsd = env.MIN_EV_ADJ_USD;
  const maxDrawdown = env.MAX_DRAWDOWN;

  if (coverageHours < minHours) {
    return { status: 'rejected', coverageHours, thresholds: { minHours, minPSuccess, minEvAdjUsd, maxDrawdown }, reason: 'insufficient_coverage_hours' };
  }
  if (stats.pSuccess < minPSuccess) {
    return { status: 'rejected', coverageHours, thresholds: { minHours, minPSuccess, minEvAdjUsd, maxDrawdown }, reason: 'p_success_below_threshold' };
  }
  if (stats.evAdjUsd < minEvAdjUsd) {
    return { status: 'rejected', coverageHours, thresholds: { minHours, minPSuccess, minEvAdjUsd, maxDrawdown }, reason: 'ev_adj_usd_below_threshold' };
  }
  if (stats.maxDrawdown > maxDrawdown) {
    return { status: 'rejected', coverageHours, thresholds: { minHours, minPSuccess, minEvAdjUsd, maxDrawdown }, reason: 'max_drawdown_above_threshold' };
  }

  return { status: 'approved', coverageHours, thresholds: { minHours, minPSuccess, minEvAdjUsd, maxDrawdown } };
}
