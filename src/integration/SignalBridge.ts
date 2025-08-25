/**
 * Signal Bridge
 * Connects SignalGenerator (feed types) to ExecutionManager (execution types)
 * 
 * HFT Design Principles:
 * - Zero-copy transformations where possible
 * - Type-safe conversions with validation
 * - Latency tracking for each transformation
 * - Maintains signal provenance for audit trail
 */

import { EventEmitter } from 'events';
import { SignalGenerator } from '../feeds/SignalGenerator';
import { ExecutionManager } from '../execution/ExecutionManager';
import { SignalExecutor } from '../execution/SignalExecutor';
import { RiskManager } from '../risk/RiskManager';
import { PositionMonitor } from '../risk/PositionMonitor';
import { 
  Signal as FeedSignal,
  ArbitrageOpportunity as FeedOpportunity 
} from '../feeds/types';
import { 
  Signal as ExecutionSignal,
  ExecutableOpportunity 
} from '../execution/types';

interface BridgeMetrics {
  signalsReceived: number;
  signalsTransformed: number;
  signalsRejected: number;
  signalsExecuted: number;
  avgTransformLatencyMs: number;
  typeConversionErrors: number;
  lastSignalTimestamp: number;
}

interface TransformationResult {
  success: boolean;
  signal?: ExecutionSignal;
  error?: string;
  latencyMs: number;
}

export class SignalBridge extends EventEmitter {
  private metrics: BridgeMetrics;
  private signalMap = new Map<string, { feed: FeedSignal; execution: ExecutionSignal }>();
  private transformLatencies: number[] = [];
  
  constructor(
    private signalGenerator: SignalGenerator,
    private executionManager: ExecutionManager,
    private signalExecutor: SignalExecutor,
    private riskManager: RiskManager,
    private positionMonitor: PositionMonitor
  ) {
    super();
    this.metrics = this.initializeMetrics();
    this.setupEventHandlers();
  }

  /**
   * Start the signal bridge
   */
  async start(): Promise<void> {
    console.log('[SignalBridge] Starting signal pipeline integration...');
    
    // Ensure all components are ready
    await this.validateComponents();
    
    // Start listening for signals
    this.connectSignalPipeline();
    
    console.log('[SignalBridge] Signal pipeline connected');
    this.emit('started');
  }

  /**
   * Validate all components are properly initialized
   */
  private async validateComponents(): Promise<void> {
    const checks = [
      { name: 'SignalGenerator', obj: this.signalGenerator },
      { name: 'ExecutionManager', obj: this.executionManager },
      { name: 'SignalExecutor', obj: this.signalExecutor },
      { name: 'RiskManager', obj: this.riskManager },
      { name: 'PositionMonitor', obj: this.positionMonitor }
    ];

    for (const check of checks) {
      if (!check.obj) {
        throw new Error(`${check.name} not initialized`);
      }
    }
  }

  /**
   * Setup event handlers for signal flow
   */
  private setupEventHandlers(): void {
    // Listen to new signals from SignalGenerator
    this.signalGenerator.on('signal', (feedSignal: FeedSignal) => {
      this.handleNewSignal(feedSignal);
    });

    // Listen to signal updates
    this.signalGenerator.on('signalUpdated', (feedSignal: FeedSignal) => {
      this.handleSignalUpdate(feedSignal);
    });

    // Listen to signal invalidation
    this.signalGenerator.on('signalInvalidated', (signalId: string) => {
      this.handleSignalInvalidation(signalId);
    });

    // Listen to execution results
    this.signalExecutor.on('executionComplete', (result) => {
      this.handleExecutionComplete(result);
    });

    // Listen to risk events
    this.riskManager.on('circuitBreakerTriggered', () => {
      this.handleCircuitBreaker();
    });

    // Listen to position events
    this.positionMonitor.on('hedgeSignal', (signal) => {
      this.handleHedgeSignal(signal);
    });
  }

  /**
   * Connect the signal pipeline
   */
  private connectSignalPipeline(): void {
    console.log('[SignalBridge] Connecting signal pipeline components...');
    
    // Override SignalExecutor's signal handler to use our bridge
    this.signalExecutor.removeAllListeners('signal');
    
    // We'll manually trigger execution after transformation
    console.log('[SignalBridge] Signal pipeline connected');
  }

  /**
   * Handle new signal from SignalGenerator
   */
  private async handleNewSignal(feedSignal: FeedSignal): Promise<void> {
    const startTime = Date.now();
    this.metrics.signalsReceived++;
    this.metrics.lastSignalTimestamp = startTime;

    try {
      console.log(`[SignalBridge] Processing new signal: ${feedSignal.id}`);

      // Transform feed signal to execution signal
      const result = await this.transformSignal(feedSignal);

      if (!result.success || !result.signal) {
        console.warn(`[SignalBridge] Failed to transform signal: ${result.error}`);
        this.metrics.signalsRejected++;
        this.emit('signalRejected', { feedSignal, reason: result.error });
        return;
      }

      // Store mapping for later reference
      this.signalMap.set(feedSignal.id, {
        feed: feedSignal,
        execution: result.signal
      });

      // Pass to SignalExecutor for execution
      await this.signalExecutor.executeSignal(result.signal);
      
      this.metrics.signalsTransformed++;
      this.emit('signalTransformed', {
        feedSignal,
        executionSignal: result.signal,
        latencyMs: result.latencyMs
      });

    } catch (error) {
      console.error('[SignalBridge] Error handling signal:', error);
      this.metrics.typeConversionErrors++;
      this.emit('error', { error, feedSignal });
    }
  }

  /**
   * Transform feed signal to execution signal
   */
  private async transformSignal(feedSignal: FeedSignal): Promise<TransformationResult> {
    const startTime = Date.now();

    try {
      // Transform opportunity
      const executableOpp = this.transformOpportunity(feedSignal.opportunity);

      // Create execution signal with additional metadata
      const executionSignal: ExecutionSignal = {
        id: feedSignal.id,
        opportunity: executableOpp,
        timestamp: feedSignal.timestamp,
        confidence: feedSignal.confidence,
        riskScore: feedSignal.riskScore,
        executionSize: this.calculateExecutionSize(feedSignal, executableOpp),
        
        // Add execution-specific fields
        priority: this.calculatePriority(feedSignal),
        metadata: {
          source: 'SignalGenerator',
          feedSignalId: feedSignal.id,
          transformedAt: Date.now(),
          latencyMs: Date.now() - feedSignal.timestamp,
          ...this.extractMetadata(feedSignal)
        }
      };

      // Validate the transformed signal
      const validation = this.validateExecutionSignal(executionSignal);
      if (!validation.valid) {
        return {
          success: false,
          error: validation.error,
          latencyMs: Date.now() - startTime
        };
      }

      const latencyMs = Date.now() - startTime;
      this.trackTransformLatency(latencyMs);

      return {
        success: true,
        signal: executionSignal,
        latencyMs
      };

    } catch (error: any) {
      return {
        success: false,
        error: error.message,
        latencyMs: Date.now() - startTime
      };
    }
  }

  /**
   * Transform feed opportunity to executable opportunity
   */
  private transformOpportunity(feedOpp: FeedOpportunity): ExecutableOpportunity {
    // Map feed opportunity type to execution type
    const mappedType = this.mapOpportunityType(feedOpp.type);

    // Determine exchange information
    const exchanges = this.extractExchanges(feedOpp);

    // Calculate execution-specific metrics
    const executionMetrics = this.calculateExecutionMetrics(feedOpp);

    return {
      id: feedOpp.id,
      type: mappedType,
      pair: this.extractTradingPair(feedOpp),
      path: feedOpp.path,
      pools: feedOpp.pools || [],
      routers: feedOpp.routers || [],
      exchanges,
      
      // Price information
      priceDiff: feedOpp.spotPrice - feedOpp.futuresPrice,
      expectedPrice: (feedOpp.spotPrice + feedOpp.futuresPrice) / 2,
      expectedProfit: feedOpp.netProfitUsd,
      
      // Capital requirements
      requiredCapital: feedOpp.requiredCapital,
      
      // Risk metrics
      confidence: feedOpp.confidence || 0.7,
      riskScore: feedOpp.riskMetrics?.riskScore || 0.3,
      
      // Timing
      expirationTime: feedOpp.expirationTime || Date.now() + 60000,
      latency: feedOpp.marketData?.latency || 50,
      
      // Market data
      volume24h: feedOpp.marketData?.volume24h || 0,
      liquidity: {
        buy: feedOpp.marketData?.liquidityUsd || 0,
        sell: feedOpp.marketData?.liquidityUsd || 0
      },
      
      // Execution-specific fields
      estimatedProfitUsd: executionMetrics.estimatedProfitUsd,
      optimalSizeUsd: executionMetrics.optimalSizeUsd,
      maxSizeUsd: executionMetrics.maxSizeUsd,
      minSizeUsd: executionMetrics.minSizeUsd,
      estimatedGasUsd: executionMetrics.estimatedGasUsd,
      slippageTolerance: executionMetrics.slippageTolerance,
      executionWindow: executionMetrics.executionWindow,
      priceImpact: executionMetrics.priceImpact,
      marketDepth: executionMetrics.marketDepth,
      orderBookImbalance: executionMetrics.orderBookImbalance,
      volatility: executionMetrics.volatility
    };
  }

  /**
   * Map feed opportunity type to execution type
   */
  private mapOpportunityType(feedType: string): 'cross_venue' | 'triangular' | 'direct' {
    const typeMap: Record<string, 'cross_venue' | 'triangular' | 'direct'> = {
      'cross_venue': 'cross_venue',
      'triangular': 'triangular',
      'direct': 'direct',
      'cex-dex': 'cross_venue',  // Legacy mapping
      'dex-dex': 'cross_venue',   // Legacy mapping
      'spot-futures': 'cross_venue'
    };

    return typeMap[feedType] || 'direct';
  }

  /**
   * Extract exchanges from opportunity
   */
  private extractExchanges(opp: FeedOpportunity): { buy: string; sell: string } {
    // Try to extract from routers or path
    if (opp.routers && opp.routers.length >= 2) {
      return {
        buy: opp.routers[0],
        sell: opp.routers[1]
      };
    }

    // Default to Hyperliquid for both sides
    return {
      buy: 'hyperliquid',
      sell: 'hyperliquid'
    };
  }

  /**
   * Extract trading pair from opportunity
   */
  private extractTradingPair(opp: FeedOpportunity): string {
    // Try to extract from path
    if (opp.path && opp.path.length > 0) {
      // Assume first element is the trading pair
      const pair = opp.path[0];
      // Normalize pair format (e.g., BTC-USD, BTC/USD -> BTC)
      return pair.split(/[-\/]/)[0];
    }

    // Try to extract from pools
    if (opp.pools && opp.pools.length > 0) {
      const pool = opp.pools[0];
      // Extract from pool name (e.g., "BTC-USDC-POOL" -> "BTC")
      const match = pool.match(/^([A-Z]+)/);
      return match ? match[1] : 'BTC';
    }

    return 'BTC';  // Default
  }

  /**
   * Calculate execution-specific metrics
   */
  private calculateExecutionMetrics(opp: FeedOpportunity): any {
    const baseSize = opp.requiredCapital || 1000;
    
    return {
      estimatedProfitUsd: opp.netProfitUsd,
      optimalSizeUsd: baseSize,
      maxSizeUsd: baseSize * 2,
      minSizeUsd: baseSize * 0.1,
      estimatedGasUsd: opp.transactionCosts || 1,
      slippageTolerance: 0.01,  // 1%
      executionWindow: 5000,     // 5 seconds
      priceImpact: 0.001,        // 0.1%
      marketDepth: opp.marketData?.liquidityUsd || 100000,
      orderBookImbalance: 0,     // Neutral
      volatility: opp.marketData?.volatility || 0.01
    };
  }

  /**
   * Calculate execution size based on signal and opportunity
   */
  private calculateExecutionSize(signal: FeedSignal, opp: ExecutableOpportunity): number {
    // Start with optimal size
    let size = opp.optimalSizeUsd;

    // Adjust based on confidence
    size *= signal.confidence;

    // Adjust based on risk
    size *= (1 - signal.riskScore);

    // Apply bounds
    size = Math.max(opp.minSizeUsd, Math.min(opp.maxSizeUsd, size));

    // Convert to token units (simplified - would need actual price)
    return size / opp.expectedPrice;
  }

  /**
   * Calculate signal priority for execution
   */
  private calculatePriority(signal: FeedSignal): number {
    let priority = 0;

    // Higher profit = higher priority
    if (signal.opportunity.netProfitUsd > 100) priority += 3;
    else if (signal.opportunity.netProfitUsd > 50) priority += 2;
    else priority += 1;

    // Higher confidence = higher priority
    priority += signal.confidence * 2;

    // Lower risk = higher priority
    priority += (1 - signal.riskScore) * 2;

    // Time sensitivity
    const timeToExpiry = (signal.opportunity.expirationTime || Date.now() + 60000) - Date.now();
    if (timeToExpiry < 10000) priority += 2;  // Urgent

    return Math.min(10, priority);  // Cap at 10
  }

  /**
   * Extract additional metadata from feed signal
   */
  private extractMetadata(signal: FeedSignal): Record<string, any> {
    return {
      detectorVersion: '1.0.0',
      marketConditions: signal.opportunity.marketData || {},
      riskMetrics: signal.opportunity.riskMetrics || {},
      originalType: signal.opportunity.type
    };
  }

  /**
   * Validate execution signal
   */
  private validateExecutionSignal(signal: ExecutionSignal): { valid: boolean; error?: string } {
    // Check required fields
    if (!signal.id || !signal.opportunity || !signal.timestamp) {
      return { valid: false, error: 'Missing required fields' };
    }

    // Check execution size
    if (signal.executionSize <= 0) {
      return { valid: false, error: 'Invalid execution size' };
    }

    // Check risk bounds
    if (signal.riskScore > 0.8) {
      return { valid: false, error: 'Risk score too high' };
    }

    // Check timing
    if (signal.opportunity.expirationTime < Date.now()) {
      return { valid: false, error: 'Opportunity expired' };
    }

    return { valid: true };
  }

  /**
   * Handle signal update from SignalGenerator
   */
  private async handleSignalUpdate(feedSignal: FeedSignal): Promise<void> {
    const mapping = this.signalMap.get(feedSignal.id);
    if (!mapping) return;

    // Re-transform and update
    const result = await this.transformSignal(feedSignal);
    if (result.success && result.signal) {
      mapping.execution = result.signal;
      
      // Notify executor of update
      this.signalExecutor.updateSignal(result.signal);
    }
  }

  /**
   * Handle signal invalidation
   */
  private handleSignalInvalidation(signalId: string): void {
    const mapping = this.signalMap.get(signalId);
    if (!mapping) return;

    // Cancel execution if in progress
    this.signalExecutor.cancelSignal(signalId);
    
    // Clean up mapping
    this.signalMap.delete(signalId);
    
    this.emit('signalCancelled', signalId);
  }

  /**
   * Handle execution completion
   */
  private handleExecutionComplete(result: any): void {
    this.metrics.signalsExecuted++;
    
    // Notify SignalGenerator of execution
    const mapping = this.signalMap.get(result.signalId);
    if (mapping) {
      this.signalGenerator.markExecuted(result.signalId);
      this.signalMap.delete(result.signalId);
    }

    this.emit('executionComplete', result);
  }

  /**
   * Handle circuit breaker trigger
   */
  private handleCircuitBreaker(): void {
    console.log('[SignalBridge] Circuit breaker triggered - halting signal flow');
    
    // Stop processing new signals
    this.signalGenerator.removeListener('signal', this.handleNewSignal);
    
    // Cancel all pending executions
    for (const [signalId] of this.signalMap) {
      this.signalExecutor.cancelSignal(signalId);
    }
    
    this.emit('circuitBreakerTriggered');
  }

  /**
   * Handle hedge signal from position monitor
   */
  private handleHedgeSignal(hedgeSignal: any): void {
    // Create synthetic signal for hedge execution
    const syntheticSignal: ExecutionSignal = {
      id: `hedge-${Date.now()}`,
      opportunity: {
        id: `hedge-opp-${Date.now()}`,
        type: 'direct',
        pair: hedgeSignal.coin,
        path: [hedgeSignal.coin],
        pools: [],
        routers: ['hyperliquid'],
        exchanges: { buy: 'hyperliquid', sell: 'hyperliquid' },
        priceDiff: 0,
        expectedPrice: 0,  // Will use market price
        expectedProfit: 0,  // Hedge is for risk reduction, not profit
        requiredCapital: Math.abs(hedgeSignal.targetSize) * 1000,  // Estimate
        confidence: 1,  // Always execute hedges
        riskScore: 0,   // Hedges reduce risk
        expirationTime: Date.now() + 5000,  // 5 second window
        latency: 0,
        volume24h: 0,
        liquidity: { buy: 1000000, sell: 1000000 },
        estimatedProfitUsd: 0,
        optimalSizeUsd: Math.abs(hedgeSignal.targetSize) * 1000,
        maxSizeUsd: Math.abs(hedgeSignal.targetSize) * 1000,
        minSizeUsd: Math.abs(hedgeSignal.targetSize) * 1000,
        estimatedGasUsd: 1,
        slippageTolerance: 0.02,  // Higher tolerance for hedges
        executionWindow: 5000,
        priceImpact: 0.01,
        marketDepth: 1000000,
        orderBookImbalance: 0,
        volatility: 0.02
      },
      timestamp: Date.now(),
      confidence: 1,
      riskScore: 0,
      executionSize: Math.abs(hedgeSignal.targetSize),
      priority: hedgeSignal.urgency === 'critical' ? 10 : 5,
      metadata: {
        source: 'PositionMonitor',
        type: 'hedge',
        action: hedgeSignal.action,
        reason: hedgeSignal.reason,
        urgency: hedgeSignal.urgency
      }
    };

    // Execute hedge immediately
    this.signalExecutor.executeSignal(syntheticSignal);
    this.emit('hedgeSignalProcessed', hedgeSignal);
  }

  /**
   * Track transformation latency
   */
  private trackTransformLatency(latencyMs: number): void {
    this.transformLatencies.push(latencyMs);
    
    // Keep only last 100 measurements
    if (this.transformLatencies.length > 100) {
      this.transformLatencies.shift();
    }

    // Update average
    this.metrics.avgTransformLatencyMs = 
      this.transformLatencies.reduce((a, b) => a + b, 0) / this.transformLatencies.length;
  }

  /**
   * Initialize metrics
   */
  private initializeMetrics(): BridgeMetrics {
    return {
      signalsReceived: 0,
      signalsTransformed: 0,
      signalsRejected: 0,
      signalsExecuted: 0,
      avgTransformLatencyMs: 0,
      typeConversionErrors: 0,
      lastSignalTimestamp: 0
    };
  }

  /**
   * Get bridge metrics
   */
  getMetrics(): BridgeMetrics {
    return { ...this.metrics };
  }

  /**
   * Resume signal processing after circuit breaker
   */
  resume(): void {
    console.log('[SignalBridge] Resuming signal processing');
    this.signalGenerator.on('signal', (feedSignal: FeedSignal) => {
      this.handleNewSignal(feedSignal);
    });
    this.emit('resumed');
  }
}

export default SignalBridge;
