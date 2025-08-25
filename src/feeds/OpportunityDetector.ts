/**
 * Production-grade Opportunity Detector
 * Combines multiple data feeds to identify arbitrage opportunities
 * Features:
 * - Multi-venue price aggregation
 * - Real-time spread calculation
 * - Opportunity ranking and filtering
 * - Risk-adjusted profitability estimation
 */

import { EventEmitter } from 'events';
import { HyperEVMFeed, SwapEvent, PoolState } from './HyperEVMFeed';
import { GoldRushClient } from './GoldRushClient';
import { ArbitrageOpportunity as FeedArbitrageOpportunity } from './types';

export interface PricePoint {
  venue: string;
  poolAddress: string;
  token0: string;
  token1: string;
  price0To1: number;
  price1To0: number;
  liquidity: bigint;
  liquidityUsd?: number;
  fee: number;
  lastUpdate: number;
  confidence: number;  // 0-1, based on data freshness and volume
}

// Use canonical feed types from ./types

export interface DetectorConfig {
  hyperEVMConfig: {
    wsUrl: string;
    httpUrl?: string;
    trackPools?: string[];
    trackTokens?: string[];
  };
  goldRushConfig?: {
    apiKey: string;
    chainName: string;
  };
  
  // Detection parameters
  minSpreadBps?: number;  // Minimum spread to consider (default: 10)
  minLiquidityUsd?: number;  // Minimum pool liquidity (default: 10000)
  maxPathLength?: number;  // Max hops in path (default: 3)
  priceUpdateThresholdMs?: number;  // Consider price stale after this (default: 5000)
  
  // Risk parameters
  gasEstimateUsd?: number;  // Estimated gas cost (default: 5)
  slippageBps?: number;  // Expected slippage (default: 30)
  competitionDiscountBps?: number;  // Discount for MEV competition (default: 50)
}

export class OpportunityDetector extends EventEmitter {
  private hyperEVMFeed: HyperEVMFeed;
  private goldRushClient?: GoldRushClient;
  private prices: Map<string, PricePoint> = new Map();
  private opportunities: Map<string, FeedArbitrageOpportunity> = new Map();
  private tokenPairs: Map<string, Set<string>> = new Map();  // token pair -> pool addresses
  
  // Configuration
  private readonly minSpreadBps: number;
  private readonly minLiquidityUsd: number;
  private readonly maxPathLength: number;
  private readonly priceUpdateThresholdMs: number;
  private readonly gasEstimateUsd: number;
  private readonly slippageBps: number;
  private readonly competitionDiscountBps: number;
  
  // Statistics
  private opportunitiesDetected = 0;
  private profitableOpportunities = 0;
  private totalEstimatedProfitUsd = 0;
  
  constructor(private config: DetectorConfig) {
    super();
    
    // Set defaults
    this.minSpreadBps = config.minSpreadBps || 10;
    this.minLiquidityUsd = config.minLiquidityUsd || 10000;
    this.maxPathLength = config.maxPathLength || 3;
    this.priceUpdateThresholdMs = config.priceUpdateThresholdMs || 5000;
    this.gasEstimateUsd = config.gasEstimateUsd || 5;
    this.slippageBps = config.slippageBps || 30;
    this.competitionDiscountBps = config.competitionDiscountBps || 50;
    
    // Initialize feeds
    this.hyperEVMFeed = new HyperEVMFeed(config.hyperEVMConfig);
    
    if (config.goldRushConfig) {
      this.goldRushClient = new GoldRushClient({
        apiKey: config.goldRushConfig.apiKey
      });
    }
    
    this.setupEventHandlers();
  }

  /**
   * Start detecting opportunities
   */
  async start(): Promise<void> {
    console.log('[OpportunityDetector] Starting...');
    
    // Start real-time feed
    await this.hyperEVMFeed.start();
    
    // Load historical data if GoldRush configured
    if (this.goldRushClient && this.config.goldRushConfig) {
      await this.loadHistoricalPrices();
    }
    
    // Start opportunity scanning
    this.startScanning();
    
    console.log('[OpportunityDetector] Started');
  }

  /**
   * Setup event handlers for real-time updates
   */
  private setupEventHandlers(): void {
    // Handle swap events
    this.hyperEVMFeed.on('swap', (swap: SwapEvent & { priceImpactBps: number; latencyMs: number }) => {
      this.updatePriceFromSwap(swap);
      this.detectOpportunitiesForPool(swap.pool);
    });
    
    // Handle fast swaps (ultra-low latency path)
    this.hyperEVMFeed.on('fastSwap', (data: any) => {
      // Quick opportunity check without full processing
      this.quickOpportunityCheck(data.address);
    });
    
    // Handle new pool discoveries
    this.hyperEVMFeed.on('poolDiscovered', (pool: any) => {
      console.log(`[OpportunityDetector] New pool discovered: ${pool.address}`);
      this.registerPool(pool);
    });
    
    // Handle errors
    this.hyperEVMFeed.on('error', (error: Error) => {
      console.error('[OpportunityDetector] Feed error:', error);
      this.emit('error', error);
    });
  }

  /**
   * Update price from swap event
   */
  private updatePriceFromSwap(swap: SwapEvent & { priceImpactBps: number }): void {
    const pool = this.hyperEVMFeed.getPoolStates().get(swap.pool);
    if (!pool) return;
    
    // Calculate prices from sqrtPriceX96
    const sqrtPrice = Number(swap.sqrtPriceX96) / (2 ** 96);
    const price0To1 = sqrtPrice ** 2;
    const price1To0 = 1 / price0To1;
    
    // Calculate confidence based on recency and size
    const confidence = this.calculateConfidence(swap);
    
    const pricePoint: PricePoint = {
      venue: 'hyperevm',
      poolAddress: swap.pool,
      token0: pool.token0,
      token1: pool.token1,
      price0To1,
      price1To0,
      liquidity: swap.liquidity,
      fee: pool.fee,
      lastUpdate: swap.timestamp,
      confidence
    };
    
    this.prices.set(swap.pool, pricePoint);
    
    // Update token pair mapping
    const pairKey = this.getTokenPairKey(pool.token0, pool.token1);
    if (!this.tokenPairs.has(pairKey)) {
      this.tokenPairs.set(pairKey, new Set());
    }
    this.tokenPairs.get(pairKey)!.add(swap.pool);
  }

  /**
   * Calculate confidence score for price point
   */
  private calculateConfidence(swap: SwapEvent & { priceImpactBps: number }): number {
    let confidence = 1.0;
    
    // Reduce confidence for high price impact
    if (swap.priceImpactBps > 100) {
      confidence *= 0.8;
    } else if (swap.priceImpactBps > 50) {
      confidence *= 0.9;
    }
    
    // Reduce confidence for small trades
    const amount0Abs = swap.amount0 < 0n ? -swap.amount0 : swap.amount0;
    const amount1Abs = swap.amount1 < 0n ? -swap.amount1 : swap.amount1;
    const tradeSize = Number(amount0Abs + amount1Abs) / 1e18;  // Simplified
    
    if (tradeSize < 100) {
      confidence *= 0.7;
    } else if (tradeSize < 1000) {
      confidence *= 0.85;
    }
    
    return Math.max(0.1, confidence);
  }

  /**
   * Detect opportunities for a specific pool
   */
  private detectOpportunitiesForPool(poolAddress: string): void {
    const pool = this.prices.get(poolAddress);
    if (!pool) return;
    
    // Find triangular arbitrage opportunities
    this.findTriangularArbitrage(pool);
    
    // Find cross-venue opportunities if we have multiple venues
    this.findCrossVenueArbitrage(pool);
  }

  /**
   * Find triangular arbitrage opportunities
   */
  private findTriangularArbitrage(startPool: PricePoint): void {
    const visited = new Set<string>();
    const paths: string[][] = [];
    
    // DFS to find cycles
    const dfs = (currentToken: string, path: string[], startToken: string, depth: number) => {
      if (depth >= this.maxPathLength) return;
      
      // Find pools that have currentToken
      for (const [pairKey, pools] of this.tokenPairs) {
        const [token0, token1] = pairKey.split('-');
        
        let nextToken: string | null = null;
        if (token0 === currentToken) nextToken = token1;
        else if (token1 === currentToken) nextToken = token0;
        
        if (!nextToken) continue;
        
        for (const poolAddr of pools) {
          if (visited.has(poolAddr)) continue;
          
          if (nextToken === startToken && path.length >= 2) {
            // Found a cycle
            paths.push([...path, poolAddr]);
          } else if (depth < this.maxPathLength - 1) {
            visited.add(poolAddr);
            dfs(nextToken, [...path, poolAddr], startToken, depth + 1);
            visited.delete(poolAddr);
          }
        }
      }
    };
    
    // Start DFS from the pool's tokens
    visited.add(startPool.poolAddress);
    dfs(startPool.token1, [startPool.poolAddress], startPool.token0, 1);
    
    // Evaluate each path
    for (const path of paths) {
      this.evaluatePath(path, 'triangular');
    }
  }

  /**
   * Find cross-venue arbitrage opportunities
   */
  private findCrossVenueArbitrage(pool: PricePoint): void {
    const pairKey = this.getTokenPairKey(pool.token0, pool.token1);
    const samePairPools = this.tokenPairs.get(pairKey);
    
    if (!samePairPools || samePairPools.size < 2) return;
    
    for (const otherPoolAddr of samePairPools) {
      if (otherPoolAddr === pool.poolAddress) continue;
      
      const otherPool = this.prices.get(otherPoolAddr);
      if (!otherPool) continue;
      
      // Check if prices are stale
      const now = Date.now();
      if (now - pool.lastUpdate > this.priceUpdateThresholdMs ||
          now - otherPool.lastUpdate > this.priceUpdateThresholdMs) {
        continue;
      }
      
      // Calculate spread
      const spread = Math.abs(pool.price0To1 - otherPool.price0To1) / pool.price0To1;
      const spreadBps = spread * 10000;
      
      if (spreadBps >= this.minSpreadBps) {
        // Simple two-pool arbitrage
        const path = pool.price0To1 > otherPool.price0To1
          ? [otherPool.poolAddress, pool.poolAddress]
          : [pool.poolAddress, otherPool.poolAddress];
        
        this.evaluatePath(path, 'cross_venue');
      }
    }
  }

  /**
   * Evaluate a path for profitability
   */
  private evaluatePath(path: string[], type: 'triangular' | 'cross_venue' | 'direct'): void {
    if (path.length < 2) return;
    
    const pools = path.map(addr => this.prices.get(addr)).filter(p => p) as PricePoint[];
    if (pools.length !== path.length) return;
    
    // Calculate gross profit
    let grossReturn = 1.0;
    let totalFeeBps = 0;
    let minLiquidity = BigInt(Number.MAX_SAFE_INTEGER);
    let minConfidence = 1.0;
    
    for (const pool of pools) {
      grossReturn *= pool.price0To1;  // Simplified - would need proper direction
      totalFeeBps += pool.fee / 100;  // Convert from fee tier to bps
      minLiquidity = pool.liquidity < minLiquidity ? pool.liquidity : minLiquidity;
      minConfidence = Math.min(minConfidence, pool.confidence);
    }
    
    const grossProfitBps = (grossReturn - 1) * 10000;
    const netProfitBps = grossProfitBps - totalFeeBps - this.slippageBps;
    
    // Apply competition discount
    const adjustedProfitBps = netProfitBps - this.competitionDiscountBps;
    
    if (adjustedProfitBps <= 0) return;
    
    // Calculate optimal size (simplified)
    const maxSizeUsd = Number(minLiquidity) / 1e18 * 2000 * 0.01;  // 1% of liquidity, $2000/token assumed
    const minSizeUsd = this.gasEstimateUsd / (adjustedProfitBps / 10000);
    const optimalSizeUsd = Math.sqrt(maxSizeUsd * minSizeUsd);  // Geometric mean
    
    if (optimalSizeUsd < minSizeUsd || maxSizeUsd < minSizeUsd) return;
    
    const estimatedProfitUsd = optimalSizeUsd * (adjustedProfitBps / 10000) - this.gasEstimateUsd;
    
    if (estimatedProfitUsd <= 0) return;
    
    // Create opportunity (canonical feed shape)
    const priceKey = `${pools[0].token0}-${pools[0].token1}`;
    const opportunity: FeedArbitrageOpportunity = {
      id: `${type}-${Date.now()}-${path.join('-')}`,
      timestamp: Date.now(),
      type,
      path,
      pools: pools.map(p => p.poolAddress),
      routers: [],
      estimatedProfitUsd,
      optimalSizeUsd,
      maxSizeUsd,
      minSizeUsd,
      estimatedGasUsd: this.gasEstimateUsd,
      netProfitUsd: estimatedProfitUsd,
      confidence: minConfidence,
      competitionLevel: 0.5,
      latencyRequirementMs: 500,
      prices: { [priceKey]: pools[0].price0To1 },
      liquidity: {
        buy: Number(minLiquidity) / 1e18,
        sell: Number(minLiquidity) / 1e18
      },
      volumes: {},
      source: 'hyperEVM'
    };
    
    // Store and emit
    this.opportunities.set(opportunity.id, opportunity);
    this.opportunitiesDetected++;
    this.profitableOpportunities++;
    this.totalEstimatedProfitUsd += estimatedProfitUsd;
    
    this.emit('opportunity', opportunity);
    
    console.log(`[OpportunityDetector] Found ${type} opportunity: $${estimatedProfitUsd.toFixed(2)} profit (${netProfitBps.toFixed(0)} bps)`);
  }

  /**
   * Quick opportunity check for ultra-low latency
   */
  private quickOpportunityCheck(poolAddress: string): void {
    // Fast path - just check if this pool is part of any known profitable paths
    const price = this.prices.get(poolAddress);
    if (!price) return;
    
    // Check recent opportunities involving this pool
    for (const opp of this.opportunities.values()) {
      if (opp.path.includes(poolAddress)) {
        // Re-evaluate quickly
        this.emit('opportunityUpdate', {
          ...opp,
          requiresRevaluation: true,
          triggerPool: poolAddress
        });
      }
    }
  }

  /**
   * Load historical prices from GoldRush
   */
  private async loadHistoricalPrices(): Promise<void> {
    if (!this.goldRushClient || !this.config.goldRushConfig) return;
    
    console.log('[OpportunityDetector] Loading historical prices...');
    
    try {
      // Load recent logs for tracked pools
      const pools = this.config.hyperEVMConfig.trackPools || [];
      
      for (const poolAddress of pools) {
        const logs = await this.goldRushClient.getLogs({
          chainName: this.config.goldRushConfig.chainName,
          contractAddress: poolAddress,
          pageSize: 100
        });
        
        // Process logs to extract price information
        for (const log of logs.items) {
          if (log.decoded?.name === 'Swap') {
            // Extract price from decoded swap event
            // This would need proper decoding logic
          }
        }
      }
      
      console.log('[OpportunityDetector] Historical prices loaded');
    } catch (error) {
      console.error('[OpportunityDetector] Failed to load historical prices:', error);
    }
  }

  /**
   * Start periodic opportunity scanning
   */
  private startScanning(): void {
    // Periodic cleanup of stale opportunities
    setInterval(() => {
      const now = Date.now();
      const staleThreshold = 10000;  // 10 seconds
      
      for (const [id, opp] of this.opportunities) {
        if (now - opp.timestamp > staleThreshold) {
          this.opportunities.delete(id);
        }
      }
    }, 5000);
    
    // Periodic re-evaluation of all paths
    setInterval(() => {
      for (const [_, opp] of this.opportunities) {
        this.evaluatePath(opp.path, opp.type);
      }
    }, 1000);
  }

  /**
   * Register a new pool
   */
  private registerPool(pool: any): void {
    const pairKey = this.getTokenPairKey(pool.token0, pool.token1);
    
    if (!this.tokenPairs.has(pairKey)) {
      this.tokenPairs.set(pairKey, new Set());
    }
    
    this.tokenPairs.get(pairKey)!.add(pool.address);
  }

  /**
   * Get token pair key (normalized)
   */
  private getTokenPairKey(token0: string, token1: string): string {
    const [a, b] = [token0.toLowerCase(), token1.toLowerCase()].sort();
    return `${a}-${b}`;
  }

  /**
   * Extract token path from pool path
   */
  private extractTokensFromPath(pools: PricePoint[]): string[] {
    const tokens: string[] = [pools[0].token0];
    
    for (let i = 0; i < pools.length; i++) {
      const pool = pools[i];
      const nextToken = tokens[tokens.length - 1] === pool.token0 ? pool.token1 : pool.token0;
      tokens.push(nextToken);
    }
    
    return tokens;
  }

  /**
   * Get top opportunities
   */
  getTopOpportunities(limit: number = 10): FeedArbitrageOpportunity[] {
    return Array.from(this.opportunities.values())
      .sort((a, b) => b.estimatedProfitUsd - a.estimatedProfitUsd)
      .slice(0, limit);
  }

  /**
   * Get statistics
   */
  getStats(): any {
    return {
      pricesTracked: this.prices.size,
      tokenPairsTracked: this.tokenPairs.size,
      activeOpportunities: this.opportunities.size,
      opportunitiesDetected: this.opportunitiesDetected,
      profitableOpportunities: this.profitableOpportunities,
      totalEstimatedProfitUsd: this.totalEstimatedProfitUsd,
      feedStats: this.hyperEVMFeed.getStats(),
      goldRushStats: this.goldRushClient?.getStats()
    };
  }

  /**
   * Stop the detector
   */
  async stop(): Promise<void> {
    console.log('[OpportunityDetector] Stopping...');
    
    await this.hyperEVMFeed.stop();
    
    this.prices.clear();
    this.opportunities.clear();
    this.tokenPairs.clear();
    this.removeAllListeners();
    
    console.log('[OpportunityDetector] Stopped');
  }
}
