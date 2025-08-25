/**
 * Mathematical utilities for arbitrage calculations
 */

import { env } from '../config/env.js';

/**
 * Convert USD amount to basis points
 */
export function usdToBps(usd: number, notionalUsd: number): number {
  if (notionalUsd === 0) return 0;
  return (usd / notionalUsd) * 10000;
}

/**
 * Convert basis points to USD amount
 */
export function bpsToUsd(bps: number, notionalUsd: number): number {
  return (bps / 10000) * notionalUsd;
}

/**
 * Calculate total flash loan cost in USD
 */
export function flashCostUsd(notionalUsd: number, cfg: {
  flashFeeBps: number;
  flashFixedUsd: number;
}): number {
  const percentageFee = bpsToUsd(cfg.flashFeeBps, notionalUsd);
  return percentageFee + cfg.flashFixedUsd;
}

/**
 * Combine multiple fee components in basis points
 */
export function combineFeesBps(
  routerBps: number,
  lpBps: number,
  extraBps: number = 0
): number {
  return routerBps + lpBps + extraBps;
}

/**
 * Calculate effective slippage for a given size
 */
export function calculateSlippage(
  sizeUsd: number,
  liquidityUsd: number,
  alpha: number = env.SLIP_ALPHA,
  k: number = env.SLIP_K
): number {
  if (liquidityUsd === 0) return Infinity;
  return k * Math.pow(sizeUsd / liquidityUsd, alpha);
}

/**
 * Calculate fill probability with latency decay
 */
export function calculateFillProbability(
  latencyMs: number,
  baseFillProb: number = env.BASE_FILL_PROB,
  theta: number = env.FILL_THETA
): number {
  const latencySec = latencyMs / 1000;
  return baseFillProb * Math.exp(-theta * latencySec);
}

/**
 * Apply edge decay based on latency
 */
export function applyEdgeDecay(
  edgeBps: number,
  latencyMs: number,
  decayRate: number = env.EDGE_DECAY_BPS_PER_SEC
): number {
  const latencySec = latencyMs / 1000;
  const decay = decayRate * latencySec;
  return Math.max(0, edgeBps - decay);
}

/**
 * Calculate breakeven threshold in basis points
 */
export function calculateBreakevenBps(
  totalFeesBps: number,
  fixedCostsUsd: number,
  notionalUsd: number
): number {
  const fixedCostsBps = usdToBps(fixedCostsUsd, notionalUsd);
  return totalFeesBps + fixedCostsBps;
}

/**
 * Calculate expected value with failure probability
 */
export function calculateExpectedValue(
  profitUsd: number,
  pSuccess: number,
  failureCostUsd: number = 0
): number {
  return profitUsd * pSuccess - failureCostUsd * (1 - pSuccess);
}

/**
 * Apply mean-variance adjustment
 */
export function applyMeanVarianceAdjustment(
  expectedValue: number,
  variance: number,
  riskAversion: number = env.RISK_AVERSION_LAMBDA
): number {
  return expectedValue - riskAversion * variance;
}

/**
 * Sample from normal distribution (Box-Muller transform)
 */
export function sampleNormal(mean: number, std: number): number {
  const u1 = Math.random();
  const u2 = Math.random();
  const z = Math.sqrt(-2 * Math.log(u1)) * Math.cos(2 * Math.PI * u2);
  return mean + std * z;
}

/**
 * Calculate profit after all fees and costs
 */
export function calculateNetProfit(
  grossProfitBps: number,
  sizeUsd: number,
  fees: {
    totalFeesBps: number;
    flashFeeBps: number;
    flashFixedUsd: number;
    executorFeeUsd: number;
    gasUsd: number;
  }
): number {
  const grossProfitUsd = bpsToUsd(grossProfitBps, sizeUsd);
  const tradingFeesUsd = bpsToUsd(fees.totalFeesBps, sizeUsd);
  const flashFeesUsd = flashCostUsd(sizeUsd, {
    flashFeeBps: fees.flashFeeBps,
    flashFixedUsd: fees.flashFixedUsd,
  });
  
  return grossProfitUsd - tradingFeesUsd - flashFeesUsd - fees.executorFeeUsd - fees.gasUsd;
}

/**
 * Check if trade meets minimum profit threshold
 */
export function meetsMinimumProfit(
  netProfitUsd: number,
  minThresholdUsd: number = 1
): boolean {
  return netProfitUsd >= minThresholdUsd;
}

/**
 * Calculate optimal size for linear impact model
 */
export function calculateOptimalSizeLinear(
  edgeBps: number,
  totalCostBps: number,
  impactCoefficient: number
): number {
  if (impactCoefficient === 0) return Infinity;
  return (edgeBps - totalCostBps) / (2 * impactCoefficient);
}

/**
 * Estimate variance of profit
 */
export function estimateProfitVariance(
  profitUsd: number,
  priceVolatility: number,
  executionUncertainty: number = 0.1
): number {
  const priceVar = Math.pow(profitUsd * priceVolatility, 2);
  const execVar = Math.pow(profitUsd * executionUncertainty, 2);
  const gasVar = Math.pow(env.GAS_USD_STD, 2);
  const adverseVar = Math.pow(env.ADVERSE_USD_STD, 2);
  
  return priceVar + execVar + gasVar + adverseVar;
}

/**
 * Calculate Sharpe ratio for a trade
 */
export function calculateSharpeRatio(
  expectedReturn: number,
  variance: number,
  riskFreeRate: number = 0
): number {
  const std = Math.sqrt(variance);
  if (std === 0) return 0;
  return (expectedReturn - riskFreeRate) / std;
}

/**
 * Convert Wei to USD given a price
 */
export function weiToUsd(wei: bigint, decimals: number, priceUsd: number): number {
  const divisor = BigInt(10 ** decimals);
  const tokens = Number(wei) / Number(divisor);
  return tokens * priceUsd;
}

/**
 * Convert USD to Wei given a price
 */
export function usdToWei(usd: number, decimals: number, priceUsd: number): bigint {
  const tokens = usd / priceUsd;
  const multiplier = BigInt(10 ** decimals);
  return BigInt(Math.floor(tokens * Number(multiplier)));
}
