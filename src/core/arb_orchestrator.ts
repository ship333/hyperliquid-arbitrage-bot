/**
 * Main arbitrage orchestrator - coordinates all components
 */

import { MarketSnapshot } from '../types/market.js';
import { ArbInputs, OptimizationResult, ArbOpportunity } from '../types/arbitrage.js';
import { ExecutionPlan, FlashParams, ExecutionResult } from '../types/execution.js';
import { FinBloomContext } from '../types/ml.js';
import { marketAggregator } from '../data/markets.js';
import { finBloomAdapter } from '../ml/finbloom.js';
import { deepSeekOptimizer } from '../ml/deepseek.js';
import { regimePolicy } from '../policy/regime.js';
import * as math from '../eval/arb_math.js';
import { env } from '../config/env.js';

interface OrchestratorConfig {
  enableML: boolean;
  enableFlashLoans: boolean;
  maxLatencyMs: number;
  minEvUsd: number;
}

export class ArbOrchestrator {
  private config: OrchestratorConfig;
  private telemetry: Map<string, any> = new Map();
  
  constructor(config?: Partial<OrchestratorConfig>) {
    this.config = {
      enableML: true,
      enableFlashLoans: true,
      maxLatencyMs: 5000,
      minEvUsd: 1,
      ...config
    };
  }

  /**
   * Main evaluation pipeline
   */
  async evaluateOpportunity(inputs: ArbInputs): Promise<ArbOpportunity> {
    const startTime = Date.now();
    console.log(`Evaluating arb opportunity for ${inputs.base}/${inputs.quote}`);
    
    try {
      // Step 1: Build market snapshot
      const snapshot = await this.buildMarketSnapshot(inputs);
      
      // Step 2: Get ML context (or defaults)
      const context = await this.getMLContext(snapshot);
      
      // Step 3: Apply regime adjustments
      const adjustedInputs = regimePolicy.applyRegime(context, inputs);
      
      // Step 4: Check if trade should proceed
      if (adjustedInputs.edgeBpsAtSignal <= 0) {
        return this.createNoTradeOpportunity('Edge eliminated by regime policy');
      }
      
      // Step 5: Optimize parameters
      const optimization = await this.optimizeParameters(snapshot, adjustedInputs, context);
      
      // Step 6: Check regime approval
      if (!regimePolicy.shouldAllowTrade(context, optimization.evAdjUsd, optimization.pSuccess)) {
        return this.createNoTradeOpportunity('Trade blocked by regime policy');
      }
      
      // Step 7: Build execution plan
      const plan = this.buildExecutionPlan(optimization, adjustedInputs, context);
      
      // Step 8: Create opportunity
      const opportunity: ArbOpportunity = {
        id: this.generateOpportunityId(),
        timestamp: Date.now(),
        pair: `${inputs.base}/${inputs.quote}`,
        edgeBps: adjustedInputs.edgeBpsAtSignal,
        optimization,
        context,
        plan,
        telemetry: {
          snapshotLatencyMs: snapshot.wsLatencyMs || 0,
          mlLatencyMs: this.telemetry.get('mlLatency') || 0,
          optimizationLatencyMs: this.telemetry.get('optimizationLatency') || 0,
          totalLatencyMs: Date.now() - startTime,
        }
      };
      
      console.log('Opportunity evaluation complete:', {
        id: opportunity.id,
        evUsd: optimization.evUsd.toFixed(2),
        size: optimization.sizeUsd.toFixed(0),
        latency: opportunity.telemetry.totalLatencyMs
      });
      
      return opportunity;
      
    } catch (error) {
      console.error('Evaluation failed:', error);
      return this.createNoTradeOpportunity(`Evaluation error: ${error}`);
    }
  }

  /**
   * Build market snapshot with retries
   */
  private async buildMarketSnapshot(inputs: ArbInputs): Promise<MarketSnapshot> {
    const maxRetries = 3;
    let lastError: any;
    
    for (let attempt = 1; attempt <= maxRetries; attempt++) {
      try {
        const snapshot = await marketAggregator.buildSnapshot(
          `${inputs.base}${inputs.quote}`
        );
        
        // Validate snapshot freshness
        if (!marketAggregator.isDataFresh(snapshot)) {
          throw new Error('Market data is stale');
        }
        
        return snapshot;
      } catch (error) {
        lastError = error;
        console.warn(`Snapshot attempt ${attempt} failed:`, error);
        
        if (attempt < maxRetries) {
          await new Promise(resolve => setTimeout(resolve, 500 * attempt));
        }
      }
    }
    
    throw new Error(`Failed to build market snapshot: ${lastError}`);
  }

  /**
   * Get ML context with fallback
   */
  private async getMLContext(snapshot: MarketSnapshot): Promise<FinBloomContext> {
    if (!this.config.enableML) {
      return this.getDefaultContext();
    }
    
    const startTime = Date.now();
    
    try {
      const context = await finBloomAdapter.summarizeContext(snapshot);
      this.telemetry.set('mlLatency', Date.now() - startTime);
      return context;
    } catch (error) {
      console.warn('ML context failed, using defaults:', error);
      return this.getDefaultContext();
    }
  }

  /**
   * Optimize arbitrage parameters
   */
  private async optimizeParameters(
    snapshot: MarketSnapshot,
    inputs: ArbInputs,
    context: FinBloomContext
  ): Promise<OptimizationResult> {
    const startTime = Date.now();
    
    try {
      const result = await deepSeekOptimizer.optimizeArb(snapshot, inputs, context);
      this.telemetry.set('optimizationLatency', Date.now() - startTime);
      
      // Validate optimization result
      if (result.sizeUsd > env.MAX_NOTIONAL_USD) {
        result.sizeUsd = env.MAX_NOTIONAL_USD;
        result.constraintsHit.push('max_size_capped');
      }
      
      return result;
    } catch (error) {
      console.error('Optimization failed:', error);
      // Return zero trade on failure
      return {
        sizeUsd: 0,
        pSuccess: 0,
        evUsd: 0,
        evAdjUsd: 0,
        slipBpsEff: 0,
        breakevenBps: Infinity,
        gasUsd: 0,
        constraintsHit: ['optimization_failed'],
      };
    }
  }

  /**
   * Build execution plan from optimization
   */
  private buildExecutionPlan(
    optimization: OptimizationResult,
    inputs: ArbInputs,
    context: FinBloomContext
  ): ExecutionPlan {
    // Determine if flash loan is beneficial
    const useFlash = this.shouldUseFlashLoan(optimization, inputs);
    
    let flashParams: FlashParams | undefined;
    if (useFlash) {
      flashParams = {
        provider: 'AAVE',
        assetAddress: '0x...', // Would be resolved at execution
        amount: this.calculateFlashAmount(optimization.sizeUsd, inputs),
        feeBps: inputs.config.flashFeeBps,
      };
    }
    
    // Build order sequence
    const orders = this.buildOrderSequence(optimization, inputs);
    
    // Calculate expected costs
    const expectedCosts = {
      gasUsd: optimization.gasUsd,
      flashFeeUsd: useFlash ? math.flashCostUsd(optimization.sizeUsd, inputs.config) : 0,
      tradingFeesUsd: math.bpsToUsd(inputs.config.totalFeesBps, optimization.sizeUsd),
      executorFeeUsd: inputs.config.executorFeeUsd,
    };
    
    const plan: ExecutionPlan = {
      orders,
      flashParams,
      estimatedProfitUsd: optimization.evUsd,
      estimatedCosts: expectedCosts,
      riskMetrics: {
        pSuccess: optimization.pSuccess,
        maxSlippageBps: optimization.slipBpsEff,
        regime: context.regime,
        riskFlags: context.riskFlags,
      },
      constraints: {
        maxSizeUsd: env.MAX_NOTIONAL_USD,
        maxSlippageBps: 100,
        minProfitUsd: this.config.minEvUsd,
        timeout: 30000,
      },
    };
    
    return plan;
  }

  /**
   * Determine if flash loan should be used
   */
  private shouldUseFlashLoan(optimization: OptimizationResult, inputs: ArbInputs): boolean {
    if (!this.config.enableFlashLoans) {
      return false;
    }
    
    // Calculate profit with and without flash
    const flashCost = math.flashCostUsd(optimization.sizeUsd, inputs.config);
    const capitalCost = optimization.sizeUsd * 0.0001; // Assume 1 bps capital cost
    
    // Use flash if it's cheaper than capital cost and EV is still positive
    const evWithFlash = optimization.evUsd - flashCost;
    return evWithFlash > optimization.evUsd - capitalCost && evWithFlash > 0;
  }

  /**
   * Calculate flash loan amount
   */
  private calculateFlashAmount(sizeUsd: number, inputs: ArbInputs): string {
    // Add buffer for fees and slippage
    const buffer = 1.05;
    const amount = sizeUsd * buffer;
    
    // Convert to Wei (assuming 18 decimals for simplicity)
    const amountWei = math.usdToWei(amount, 18, 1);
    return amountWei.toString();
  }

  /**
   * Build order sequence for execution
   */
  private buildOrderSequence(optimization: OptimizationResult, inputs: ArbInputs): any[] {
    const orders = [];
    
    // Buy order
    if (optimization.optimalPath?.buyVenue) {
      orders.push({
        venue: optimization.optimalPath.buyVenue,
        side: 'buy',
        pair: `${inputs.base}/${inputs.quote}`,
        sizeUsd: optimization.sizeUsd,
        limitPrice: optimization.optimalPath.estimatedFillPrice,
        urgency: 'high',
      });
    }
    
    // Sell order
    if (optimization.optimalPath?.sellVenue) {
      orders.push({
        venue: optimization.optimalPath.sellVenue,
        side: 'sell',
        pair: `${inputs.base}/${inputs.quote}`,
        sizeUsd: optimization.sizeUsd,
        limitPrice: optimization.optimalPath.estimatedFillPrice * 1.001, // Slightly higher for sell
        urgency: 'high',
      });
    }
    
    return orders;
  }

  /**
   * Get default ML context when models are unavailable
   */
  private getDefaultContext(): FinBloomContext {
    return {
      regime: 'calm',
      riskFlags: ['ml_disabled'],
      narrative: 'ML models disabled, using conservative defaults',
      sensitivityBps: 20,
      confidence: 0.5,
      timestamp: Date.now(),
    };
  }

  /**
   * Create a no-trade opportunity response
   */
  private createNoTradeOpportunity(reason: string): ArbOpportunity {
    return {
      id: this.generateOpportunityId(),
      timestamp: Date.now(),
      pair: '',
      edgeBps: 0,
      optimization: {
        sizeUsd: 0,
        pSuccess: 0,
        evUsd: 0,
        evAdjUsd: 0,
        slipBpsEff: 0,
        breakevenBps: Infinity,
        gasUsd: 0,
        constraintsHit: ['no_trade', reason],
      },
      context: this.getDefaultContext(),
      plan: {
        orders: [],
        estimatedProfitUsd: 0,
        estimatedCosts: {
          gasUsd: 0,
          flashFeeUsd: 0,
          tradingFeesUsd: 0,
          executorFeeUsd: 0,
        },
        riskMetrics: {
          pSuccess: 0,
          maxSlippageBps: 0,
          regime: 'calm',
          riskFlags: ['no_trade'],
        },
        constraints: {
          maxSizeUsd: 0,
          maxSlippageBps: 0,
          minProfitUsd: Infinity,
          timeout: 0,
        },
      },
      telemetry: {
        snapshotLatencyMs: 0,
        mlLatencyMs: 0,
        optimizationLatencyMs: 0,
        totalLatencyMs: 0,
      },
    };
  }

  /**
   * Generate unique opportunity ID
   */
  private generateOpportunityId(): string {
    return `arb_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`;
  }

  /**
   * Execute a plan (placeholder - actual execution would involve on-chain transactions)
   */
  async executePlan(plan: ExecutionPlan): Promise<ExecutionResult> {
    console.log('Execution not implemented - would execute:', plan);
    
    // Mock result
    return {
      success: false,
      profitUsd: 0,
      actualCosts: plan.estimatedCosts,
      fills: [],
      errors: ['Execution not implemented'],
      telemetry: {
        executionTimeMs: 0,
        gasUsed: '0',
        blockNumber: 0,
      },
    };
  }
}

// Export singleton instance
export const arbOrchestrator = new ArbOrchestrator();
