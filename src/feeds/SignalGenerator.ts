/**
 * Signal Generator - Main orchestrator for arbitrage signal generation
 * Integrates opportunity detection with evaluation service
 */

import { EventEmitter } from 'events';
import { OpportunityDetector } from './OpportunityDetector';
import { ArbitrageOpportunity } from './types';
import { evaluateBatch, ArbitrageInput, ArbitrageResult } from '../eval/model';
import { SlippageModel } from '../eval/types';
import { fetchPoolState, fetchInitializedTicks } from '../chain/univ3_fetch';
import { enforceGate } from '../policy/strategyGate';

export interface Signal {
  id: string;
  timestamp: number;
  opportunity: ArbitrageOpportunity;
  evaluation: ArbitrageResult;
  
  // Execution decision
  shouldExecute: boolean;
  executionSize: number;
  executionPath: string[];
  
  // Risk metrics
  riskScore: number;  // 0-1
  confidenceScore: number;  // 0-1
  priorityScore: number;  // For ordering
  
  // Timing
  validUntil: number;  // Timestamp when signal expires
  latencyBudgetMs: number;  // Max execution time
  
  // Additional fields for compatibility
  expectedValue: number;  // Expected profit in USD
  failProb: number;  // Failure probability
  variance: number;  // Variance of returns
  sharpeRatio: number;  // Sharpe ratio
  cvar95: number;  // CVaR at 95%
  optimalSize?: number;  // Optimal size from evaluation
}

export interface SignalGeneratorConfig {
  // Detector config
  detectorConfig: {
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
  };
  
  // Evaluation parameters
  evaluationConfig?: {
    flashLoanEnabled?: boolean;
    flashLoanProvider?: string;
    maxPositionSizeUsd?: number;
    targetSharpeRatio?: number;
    maxVaR95?: number;
  };
  
  // Execution filters
  filters?: {
    minNetProfitUsd?: number;  // Default: 10
    minConfidence?: number;  // Default: 0.7
    maxRiskScore?: number;  // Default: 0.3
    maxOpenSignals?: number;  // Default: 10
  };
  
  // Pool state fetching
  rpcUrl?: string;
}

export class SignalGenerator extends EventEmitter {
  private detector: OpportunityDetector;
  private activeSignals: Map<string, Signal> = new Map();
  private executedSignals: Set<string> = new Set();
  
  // Configuration
  private readonly minNetProfitUsd: number;
  private readonly minConfidence: number;
  private readonly maxRiskScore: number;
  private readonly maxOpenSignals: number;
  
  // Statistics
  private signalsGenerated = 0;
  private signalsExecuted = 0;
  private totalProfitUsd = 0;
  private totalLossUsd = 0;
  
  constructor(private config: SignalGeneratorConfig) {
    super();
    
    // Set defaults
    this.minNetProfitUsd = config.filters?.minNetProfitUsd || 10;
    this.minConfidence = config.filters?.minConfidence || 0.7;
    this.maxRiskScore = config.filters?.maxRiskScore || 0.3;
    this.maxOpenSignals = config.filters?.maxOpenSignals || 10;
    
    // Initialize detector
    this.detector = new OpportunityDetector(config.detectorConfig);
    
    this.setupEventHandlers();
  }

  /**
   * Start generating signals
   */
  async start(): Promise<void> {
    console.log('[SignalGenerator] Starting...');
    
    // Start opportunity detection
    await this.detector.start();
    
    // Start signal management
    this.startSignalManagement();
    
    console.log('[SignalGenerator] Started');
  }

  /**
   * Setup event handlers
   */
  private setupEventHandlers(): void {
    // Handle new opportunities
    this.detector.on('opportunity', async (opp: ArbitrageOpportunity) => {
      await this.processOpportunity(opp);
    });
    
    // Handle opportunity updates (fast path)
    this.detector.on('opportunityUpdate', async (update: any) => {
      if (update.requiresRevaluation) {
        await this.revaluateSignal(update.id);
      }
    });
    
    // Handle errors
    this.detector.on('error', (error: Error) => {
      console.error('[SignalGenerator] Detector error:', error);
      this.emit('error', error);
    });
  }

  /**
   * Process a new opportunity
   */
  public async processOpportunity(opp: ArbitrageOpportunity): Promise<void> {
    try {
      // Check if we have capacity for new signals
      if (this.activeSignals.size >= this.maxOpenSignals) {
        return;
      }
      
      // Skip if already processed
      if (this.executedSignals.has(opp.id)) {
        return;
      }
      
      // Fetch fresh pool states for accurate evaluation
      const poolStates = await this.fetchPoolStates(opp.pools);
      
      // Build evaluation input
      const evalInput = await this.buildEvaluationInput(opp, poolStates);
      
      // Strategy gate: ensure an approved strategy exists for this opportunity type
      const gate = await enforceGate(opp.type);
      if (!gate.allowed) {
        // Deny execution and record a non-executable signal for observability
        const evaluation = await this.evaluate(evalInput);
        const signal: Signal = {
          id: opp.id,
          timestamp: Date.now(),
          opportunity: opp,
          evaluation,
          shouldExecute: false,
          executionSize: evaluation.size_opt_usd || opp.optimalSizeUsd,
          executionPath: opp.path,
          riskScore: this.calculateRiskScore(opp, evaluation),
          confidenceScore: this.calculateConfidenceScore(opp, evaluation),
          priorityScore: this.calculatePriorityScore(opp, evaluation),
          validUntil: Date.now() + 5000,
          latencyBudgetMs: opp.latencyRequirementMs,
          expectedValue: evaluation.net_usd_est,
          failProb: 1 - evaluation.p_success,
          variance: 0,
          sharpeRatio: evaluation.score / Math.max(1, evaluation.net_usd_est),
          cvar95: evaluation.cvar95 || -evaluation.net_usd_est * 0.5,
          optimalSize: evaluation.size_opt_usd
        } as Signal;
        this.activeSignals.set(signal.id, signal);
        this.emit('signal', signal);
        console.log(`[SignalGenerator] Gate denied execution for ${opp.id}: ${gate.reason}`);
        return;
      }

      // Merge strategy params into evaluation input where applicable
      if (gate.params) {
        evalInput.latency.edgeDecayBpsPerSec = gate.params.edgeDecayBpsPerSec ?? evalInput.latency.edgeDecayBpsPerSec;
        evalInput.latency.baseFillProb = gate.params.baseFillProb ?? evalInput.latency.baseFillProb;
        evalInput.latency.theta = gate.params.theta ?? evalInput.latency.theta;
        if (evalInput.slippage.kind === 'empirical') {
          evalInput.slippage.alpha = gate.params.slipAlpha ?? evalInput.slippage.alpha;
          evalInput.slippage.k = gate.params.slipK ?? evalInput.slippage.k;
        }
        evalInput.fees.totalFeesBps = gate.params.totalFeesBps ?? evalInput.fees.totalFeesBps;
        evalInput.fees.flashFeeBps = gate.params.flashFeeBps ?? evalInput.fees.flashFeeBps;
        evalInput.fees.referralBps = gate.params.referralBps ?? evalInput.fees.referralBps;
        evalInput.fees.executorFeeUsd = gate.params.executorFeeUsd ?? evalInput.fees.executorFeeUsd;
        evalInput.fees.flashFixedUsd = gate.params.flashFixedUsd ?? evalInput.fees.flashFixedUsd;
        evalInput.riskAversion = gate.params.riskAversionLambda ?? evalInput.riskAversion;
        evalInput.frictions.gasUsdMean = gate.params.gasUsdMean ?? evalInput.frictions.gasUsdMean;
        evalInput.frictions.gasUsdStd = gate.params.gasUsdStd ?? evalInput.frictions.gasUsdStd;
        evalInput.frictions.adverseUsdMean = gate.params.adverseUsdMean ?? evalInput.frictions.adverseUsdMean;
        evalInput.frictions.adverseUsdStd = gate.params.adverseUsdStd ?? evalInput.frictions.adverseUsdStd;
        evalInput.frictions.mevPenaltyUsd = gate.params.mevPenaltyUsd ?? evalInput.frictions.mevPenaltyUsd;
        evalInput.capitalUsd = gate.params.maxNotionalUsd ?? evalInput.capitalUsd;
      }

      // Run evaluation after applying strategy params
      const evaluation = await this.evaluate(evalInput);
      
      // Check if signal passes filters
      if (!this.passesFilters(opp, evaluation)) {
        return;
      }
      
      // Calculate scores
      const riskScore = this.calculateRiskScore(opp, evaluation);
      const confidenceScore = this.calculateConfidenceScore(opp, evaluation);
      const priorityScore = this.calculatePriorityScore(opp, evaluation);
      
      // Create signal
      const signal: Signal = {
        id: opp.id,
        timestamp: Date.now(),
        opportunity: opp,
        evaluation,
        shouldExecute: evaluation.net_usd_est > this.minNetProfitUsd && riskScore <= this.maxRiskScore,
        executionSize: evaluation.size_opt_usd || opp.optimalSizeUsd,
        executionPath: opp.path,
        riskScore,
        confidenceScore,
        priorityScore,
        validUntil: Date.now() + 5000,  // 5 second validity
        latencyBudgetMs: opp.latencyRequirementMs,
        expectedValue: evaluation.net_usd_est,
        failProb: 1 - evaluation.p_success,
        variance: 0,  // Would calculate from evaluation
        sharpeRatio: evaluation.score / Math.max(1, evaluation.net_usd_est),  // Approximation
        cvar95: evaluation.cvar95 || -evaluation.net_usd_est * 0.5,
        optimalSize: evaluation.size_opt_usd
      };
      
      // Store and emit
      this.activeSignals.set(signal.id, signal);
      this.signalsGenerated++;
      
      this.emit('signal', signal);
      
      console.log(`[SignalGenerator] New signal: ${signal.id} | Profit: $${signal.expectedValue.toFixed(2)} | Risk: ${riskScore.toFixed(2)} | Execute: ${signal.shouldExecute}`);
      
    } catch (error) {
      console.error('[SignalGenerator] Error processing opportunity:', error);
    }
  }

  /**
   * Fetch fresh pool states
   */
  private async fetchPoolStates(pools: string[]): Promise<Map<string, any>> {
    const states = new Map();
    
    // Fetch in parallel for speed
    const promises = pools.map(async (pool) => {
      try {
        const state = await fetchPoolState(pool, this.config.rpcUrl);
        const ticks = await fetchInitializedTicks(pool, this.config.rpcUrl);
        
        states.set(pool, {
          ...state,
          ticks
        });
      } catch (error) {
        console.error(`[SignalGenerator] Failed to fetch pool state for ${pool}:`, error);
      }
    });
    
    await Promise.all(promises);
    
    return states;
  }

  /**
   * Build evaluation input from opportunity
   */
  private async buildEvaluationInput(
    opp: ArbitrageOpportunity,
    poolStates: Map<string, any>
  ): Promise<ArbitrageInput> {
    // Get first pool for primary slippage model
    const firstPool = opp.pools[0];
    const poolState = poolStates.get(firstPool);
    
    // Build slippage model with UniV3 data if available
    let slippage: SlippageModel;
    
    if (poolState) {
      slippage = {
        kind: 'univ3',
        sqrtPriceX96: poolState.sqrtPriceX96,
        liquidity: poolState.liquidity,
        feeTierBps: poolState.fee / 100,
        tickSpacing: poolState.tickSpacing,
        usdPerTokenIn: 2000,  // Would fetch from price oracle
        zeroForOne: true,
        ticks: poolState.ticks?.map((t: any) => ({
          index: t.index,
          liquidityNet: t.liquidityNet,
          sqrtPriceX96: t.sqrtPriceX96
        }))
      };
    } else {
      // Fallback to empirical model
      slippage = {
        kind: 'empirical',
        k: 1.5,  // Conservative
        alpha: 1.2,
        liquidityRefUsd: Number(opp.maxSizeUsd)
      };
    }
    
    const arbiInput: ArbitrageInput = {
      edgeBps: (opp.estimatedProfitUsd / opp.optimalSizeUsd) * 10000,  // Convert profit to bps
      notionalUsd: opp.optimalSizeUsd,
      
      latency: {
        latencySec: 0.05,  // 50ms in seconds
        edgeDecayBpsPerSec: 20,  // Edge decay rate
        baseFillProb: 0.95,  // High probability baseline
        theta: 0.15
      },
      
      slippage,
      
      failures: {
        failBeforeFillProb: 0.05,
        failBetweenLegsProb: 0.02,
        reorgOrMevProb: 0.01
      },
      
      fees: {
        totalFeesBps: poolState ? poolState.fee / 100 : 30,  // Convert from fee tier to bps
        flashFeeBps: 9,  // 0.09%
        referralBps: 0,
        executorFeeUsd: 0,
        flashFixedUsd: 0
      },
      
      frictions: {
        gasUsdMean: opp.estimatedGasUsd,
        gasUsdStd: opp.estimatedGasUsd * 0.2,
        adverseUsdMean: 0,
        adverseUsdStd: 0,
        extraUsd: 0,
        mevPenaltyUsd: 0
      },
      
      flashEnabled: this.config.evaluationConfig?.flashLoanEnabled || false,
      riskAversion: 0.001,
      capitalUsd: this.config.evaluationConfig?.maxPositionSizeUsd || 100000
    };
    
    return arbiInput;
  }

  /**
   * Run evaluation
   */
  private async evaluate(input: ArbitrageInput): Promise<ArbitrageResult> {
    const results = await evaluateBatch([input]);
    return results[0];
  }

  /**
   * Check if signal passes filters
   */
  private passesFilters(opp: ArbitrageOpportunity, evaluation: ArbitrageResult): boolean {
    if (!evaluation || evaluation.net_usd_est < this.minNetProfitUsd) {
      return false;
    }
    
    if (opp.confidence < this.minConfidence) {
      return false;
    }
    
    const failProb = 1 - evaluation.p_success;
    if (failProb > 0.3) {  // Max 30% failure probability
      return false;
    }
    
    return true;
  }

  /**
   * Calculate risk score (0-1, lower is better)
   */
  private calculateRiskScore(opp: ArbitrageOpportunity, evaluation: ArbitrageResult): number {
    let score = 0;
    
    // Failure probability component (0-0.4)
    const failProb = 1 - evaluation.p_success;
    score += failProb * 0.4;
    
    // Competition level component (0-0.3)
    score += opp.competitionLevel * 0.3;
    
    // Variance component (0-0.3) - simplified since variance not in ArbResult
    const normalizedVariance = 0.1;  // Conservative estimate
    score += normalizedVariance * 0.3;
    
    return Math.min(1, score);
  }

  /**
   * Calculate confidence score (0-1, higher is better)
   */
  private calculateConfidenceScore(opp: ArbitrageOpportunity, evaluation: ArbitrageResult): number {
    let score = opp.confidence;
    
    // Boost for high score (ev_per_sec)
    const normalizedScore = evaluation.score / 100;  // Normalize
    if (normalizedScore > 3) {
      score *= 1.2;
    } else if (normalizedScore > 2) {
      score *= 1.1;
    }
    
    // Penalty for high CVaR if available
    if (evaluation.cvar95 && evaluation.cvar95 < -evaluation.net_usd_est * 0.5) {
      score *= 0.8;
    }
    
    return Math.min(1, score);
  }

  /**
   * Calculate priority score for execution ordering
   */
  private calculatePriorityScore(opp: ArbitrageOpportunity, evaluation: ArbitrageResult): number {
    // Combine profit, confidence, and urgency
    const profitScore = Math.min(evaluation.net_usd_est / 100, 1);  // Normalize to 0-1
    const urgencyScore = 1 / (1 + opp.latencyRequirementMs / 1000);  // Lower latency = higher priority
    
    return profitScore * 0.5 + opp.confidence * 0.3 + urgencyScore * 0.2;
  }

  /**
   * Re-evaluate an existing signal
   */
  private async revaluateSignal(signalId: string): Promise<void> {
    const signal = this.activeSignals.get(signalId);
    if (!signal) return;
    
    // Check if still valid
    if (Date.now() > signal.validUntil) {
      this.activeSignals.delete(signalId);
      return;
    }
    
    // Quick re-evaluation
    const evalInput = await this.buildEvaluationInput(signal.opportunity, new Map());
    const evaluation = await this.evaluate(evalInput);
    
    // Update signal
    signal.evaluation = evaluation;
    signal.shouldExecute = evaluation.net_usd_est > this.minNetProfitUsd && signal.riskScore <= this.maxRiskScore;
    signal.expectedValue = evaluation.net_usd_est;
    
    this.emit('signalUpdate', signal);
  }

  /**
   * Start signal management tasks
   */
  private startSignalManagement(): void {
    // Clean up expired signals
    setInterval(() => {
      const now = Date.now();
      
      for (const [id, signal] of this.activeSignals) {
        if (now > signal.validUntil) {
          this.activeSignals.delete(id);
          this.emit('signalExpired', signal);
        }
      }
    }, 1000);
    
    // Re-evaluate active signals periodically
    setInterval(() => {
      for (const signal of this.activeSignals.values()) {
        this.revaluateSignal(signal.id).catch(console.error);
      }
    }, 2000);
  }

  /**
   * Mark signal as executed
   */
  markExecuted(signalId: string, profit: number): void {
    const signal = this.activeSignals.get(signalId);
    if (!signal) return;
    
    this.activeSignals.delete(signalId);
    this.executedSignals.add(signalId);
    this.signalsExecuted++;
    
    if (profit > 0) {
      this.totalProfitUsd += profit;
    } else {
      this.totalLossUsd += Math.abs(profit);
    }
    
    this.emit('signalExecuted', {
      signal,
      actualProfit: profit,
      profitVsExpected: profit - signal.evaluation.net_usd_est
    });
  }

  /**
   * Get active signals sorted by priority
   */
  getActiveSignals(): Signal[] {
    return Array.from(this.activeSignals.values())
      .sort((a, b) => b.priorityScore - a.priorityScore);
  }

  /**
   * Get statistics
   */
  getStats(): any {
    const winRate = this.signalsExecuted > 0 
      ? this.totalProfitUsd / (this.totalProfitUsd + this.totalLossUsd)
      : 0;
    
    return {
      signalsGenerated: this.signalsGenerated,
      signalsActive: this.activeSignals.size,
      signalsExecuted: this.signalsExecuted,
      totalProfitUsd: this.totalProfitUsd,
      totalLossUsd: this.totalLossUsd,
      netPnL: this.totalProfitUsd - this.totalLossUsd,
      winRate,
      detectorStats: this.detector.getStats()
    };
  }

  /**
   * Stop the generator
   */
  async stop(): Promise<void> {
    console.log('[SignalGenerator] Stopping...');
    
    await this.detector.stop();
    
    this.activeSignals.clear();
    this.executedSignals.clear();
    this.removeAllListeners();
    
    console.log('[SignalGenerator] Stopped');
  }
}
