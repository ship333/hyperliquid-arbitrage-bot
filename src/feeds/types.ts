/**
 * Shared types for feed infrastructure
 */

export interface ArbitrageOpportunity {
  id: string;
  timestamp: number;
  type: 'triangular' | 'cross_venue' | 'direct';
  
  // Path information
  path: string[];  // Token addresses or pool addresses in order
  pools: string[];  // Pool addresses involved
  routers: string[];  // Router addresses for execution
  
  // Financial metrics
  estimatedProfitUsd: number;
  optimalSizeUsd: number;
  maxSizeUsd: number;
  minSizeUsd: number;
  estimatedGasUsd: number;
  netProfitUsd: number;
  
  // Risk metrics
  confidence: number;  // 0-1 score
  competitionLevel: number;  // 0-1, higher = more competition
  latencyRequirementMs: number;  // Max latency before opportunity degrades
  
  // Market data
  prices: Record<string, number>;  // Token prices at detection time
  liquidity: Record<string, number>;  // Pool liquidity levels
  volumes: Record<string, number>;  // Recent volume data
  
  // Metadata
  source: 'hyperEVM' | 'goldRush' | 'combined';
  blockNumber?: number;
  transactionHash?: string;
}

export interface PoolState {
  address: string;
  token0: string;
  token1: string;
  reserve0: bigint;
  reserve1: bigint;
  fee: number;  // In basis points * 100 (e.g., 3000 for 0.3%)
  liquidity: bigint;
  sqrtPrice?: bigint;
  tick?: number;
  lastUpdate: number;
}

export interface TokenPrice {
  address: string;
  symbol: string;
  priceUsd: number;
  timestamp: number;
  source: string;
}

export interface ExecutionResult {
  signalId: string;
  success: boolean;
  transactionHash?: string;
  actualProfitUsd?: number;
  gasUsedUsd?: number;
  error?: string;
  timestamp: number;
}

// Signal type for feed layer
export interface Signal {
  id: string;
  opportunity: ArbitrageOpportunity;
  createdAt: number;
  updatedAt: number;
  status: 'active' | 'executing' | 'executed' | 'expired' | 'invalidated';
  expirationTime: number;
  priority: number;
  metadata?: Record<string, any>;
}
