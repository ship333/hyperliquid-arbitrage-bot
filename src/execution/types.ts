/**
 * Execution System Types
 * Bridges the gap between feed types and execution requirements
 */

import { ArbitrageOpportunity as FeedOpportunity } from '../feeds/types';

/**
 * Extended ArbitrageOpportunity for execution
 */
export interface ExecutableOpportunity extends FeedOpportunity {
  // Additional fields for execution
  pair: string;  // Trading pair (e.g., "ETH-USDC")
  expectedPrice: number;  // Expected execution price
  exchanges: {
    buy: string;
    sell: string;
  };
  priceDiff: number;
  expectedProfit: number;
  requiredCapital: number;
  estimatedGas: number;
  priceImpact: number;
  volume24h: number;
  venueLiquidity: {
    buy: number;
    sell: number;
  };
}

/**
 * Signal for execution
 */
export interface Signal {
  id: string;
  opportunity: ExecutableOpportunity;
  timestamp: number;
  expectedValue: number;
  confidenceScore: number;
  riskScore: number;
  executionSize: number;
  priority: number;
  shouldExecute: boolean;
  validUntil: number;
  metadata: {
    source: string;
    model: string;
    gasEstimate: number;
    [key: string]: any;
  };
}

/**
 * Convert feed opportunity to executable opportunity
 */
export function toExecutableOpportunity(
  feedOpp: FeedOpportunity,
  additionalData?: Partial<ExecutableOpportunity>
): ExecutableOpportunity {
  // Extract pair from path (first and last tokens)
  const pair = feedOpp.path.length >= 2 
    ? `${feedOpp.path[0]}-${feedOpp.path[feedOpp.path.length - 1]}`
    : 'UNKNOWN-PAIR';

  // Calculate expected price from prices object
  const prices = Object.values(feedOpp.prices);
  const expectedPrice = prices.length > 0 ? prices[0] : 0;

  // Determine exchanges based on type
  const exchanges = {
    buy: feedOpp.type === 'cross_venue' ? 'hyperliquid' : 'dex',
    sell: feedOpp.type === 'cross_venue' ? 'uniswap' : 'dex'
  };

  return {
    ...feedOpp,
    pair,
    expectedPrice,
    exchanges,
    priceDiff: feedOpp.netProfitUsd,
    expectedProfit: feedOpp.netProfitUsd,
    requiredCapital: feedOpp.optimalSizeUsd,
    estimatedGas: feedOpp.estimatedGasUsd,
    priceImpact: 0.001, // Default 0.1%
    volume24h: Object.values(feedOpp.volumes).reduce((a, b) => a + b, 0),
    venueLiquidity: {
      buy: Object.values(feedOpp.liquidity)[0] || 0,
      sell: Object.values(feedOpp.liquidity)[1] || 0
    },
    ...additionalData
  };
}

/**
 * Order types
 */
export interface OrderRequest {
  coin: string;
  is_buy: boolean;
  sz: number;
  limit_px: number;
  order_type: 'limit' | 'market';
  reduce_only?: boolean;
  post_only?: boolean;
  ioc?: boolean;
  cloid?: string;
}

export interface OrderResponse {
  status: 'ok' | 'error';
  response?: {
    type: 'order';
    data: {
      statuses: Array<{
        resting?: { oid: number };
        filled?: { totalSz: string; avgPx: string };
        error?: string;
      }>;
    };
  };
  error?: string;
}

export interface ExecutionResult {
  signalId: string;
  orderId?: string;
  status: 'success' | 'failed' | 'partial' | 'rejected';
  executedSize: number;
  executedPrice: number;
  slippage: number;
  fees: number;
  timestamp: number;
  error?: string;
}

export interface Position {
  coin: string;
  szi: number;  // signed size
  entryPx: number;
  positionValue: number;
  unrealizedPnl: number;
  returnOnEquity: number;
  funding: number;
}

export interface AccountState {
  marginSummary: {
    accountValue: number;
    totalMarginUsed: number;
    totalNtlPos: number;
    totalRawUsd: number;
    withdrawable: number;
  };
  crossMarginSummary: {
    accountValue: number;
    totalMarginUsed: number;
  };
  assetPositions: Position[];
}
