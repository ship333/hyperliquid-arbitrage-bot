/**
 * Signal Executor
 * Bridges SignalGenerator with ExecutionManager
 */

import { EventEmitter } from 'events';
import * as winston from 'winston';
import { SignalGenerator } from '../feeds/SignalGenerator';
import { ExecutionManager, ExecutionResult } from './ExecutionManager';
import { Signal as FeedSignal } from '../feeds/types';
import { Signal as ExecutionSignal, ExecutableOpportunity } from './types';

export interface SignalExecutorConfig {
  autoExecute?: boolean;
  minConfidence?: number;
  maxConcurrentExecutions?: number;
  executionDelayMs?: number;
  executionTimeoutMs?: number;
  retryAttempts?: number;
  retryDelayMs?: number;
  profitTarget?: number;
  stopLoss?: number;
}

export interface ExecutionMetrics {
  signalsReceived: number;
  signalsExecuted: number;
  signalsRejected: number;
  totalPnL: number;
  winRate: number;
  avgExecutionTime: number;
  lastExecutionTime?: number;
  activeExecutions: number;
  queuedSignals: number;
}

export class SignalExecutor extends EventEmitter {
  private signalGenerator?: SignalGenerator;
  private executionManager: ExecutionManager;
  private activeExecutions: Set<string> = new Set();
  private signalQueue: ExecutionSignal[] = [];
  private isRunning: boolean = false;
  private config: SignalExecutorConfig;
  
  private metrics: ExecutionMetrics = {
    signalsReceived: 0,
    signalsExecuted: 0,
    signalsRejected: 0,
    totalPnL: 0,
    winRate: 0,
    avgExecutionTime: 0,
    activeExecutions: 0,
    queuedSignals: 0
  };

  private logger: winston.Logger;

  constructor(params: {
    executionManager: ExecutionManager;
    config?: SignalExecutorConfig;
  }) {
    super();
    this.executionManager = params.executionManager;
    this.config = params.config || {
      maxConcurrentExecutions: 5,
      executionTimeoutMs: 30000,
      retryAttempts: 3,
      retryDelayMs: 1000,
      executionDelayMs: 100
    };
    this.logger = winston.createLogger({
      level: 'info',
      format: winston.format.json(),
      transports: [
        new winston.transports.Console()
      ]
    });

    this.setupEventHandlers();
  }

  /**
   * Connect to signal generator
   */
  connectSignalGenerator(generator: SignalGenerator): void {
    this.signalGenerator = generator;
    
    // Listen for new signals
    generator.on('signal', async (signal: FeedSignal) => {
      await this.handleNewSignal(signal);
    });

    // Listen for signal updates
    generator.on('signalUpdate', async (signal: FeedSignal) => {
      await this.handleSignalUpdate(signal);
    });

    console.log('[SignalExecutor] Connected to SignalGenerator');
  }

  /**
   * Setup execution event handlers
   */
  private setupEventHandlers(): void {
    this.executionManager.on('orderExecuted', (result: ExecutionResult) => {
      this.handleExecutionComplete(result);
    });

    this.executionManager.on('orderFailed', (result: ExecutionResult) => {
      this.handleExecutionFailed(result);
    });

    this.executionManager.on('positionUpdate', (update: any) => {
      this.handlePositionUpdate(update);
    });
  }

  /**
   * Convert feed signal to execution signal
   */
  private convertFeedToExecutionSignal(feedSignal: FeedSignal): ExecutionSignal {
    const opportunity = feedSignal.opportunity;
    // Convert ArbitrageOpportunity to ExecutableOpportunity
    const executableOpp: ExecutableOpportunity = {
      pair: opportunity.path[0] + '/' + opportunity.path[opportunity.path.length - 1],
      buyExchange: 'hyperliquid',
      sellExchange: 'hyperliquid',
      expectedProfit: opportunity.netProfitUsd,
      expectedPrice: opportunity.estimatedProfitUsd,
      exchanges: ['hyperliquid'],
      priceDiff: opportunity.estimatedProfitUsd,
      buyPrice: 0,
      sellPrice: 0,
      confidence: opportunity.confidence,
      timestamp: Date.now(),
      expiresAt: feedSignal.expirationTime
    };
    
    return {
      id: feedSignal.id,
      opportunity: executableOpp,
      timestamp: feedSignal.createdAt,
      expectedValue: opportunity.netProfitUsd,
      confidenceScore: opportunity.confidence,
      riskScore: 1 - opportunity.confidence,
      source: opportunity.source,
      shouldExecute: feedSignal.status === 'active',
      priority: feedSignal.priority || 0.5,
      metadata: {
        source: opportunity.source,
        model: 'v1',
        gasEstimate: opportunity.estimatedGasUsd
      }
    };
  }

  /**
   * Handle incoming signal
   */
  private async handleNewSignal(signal: FeedSignal): Promise<void> {
    this.metrics.signalsReceived++;
    
    console.log(`[SignalExecutor] Received signal ${signal.id}:`, {
      opportunity: signal.opportunity,
      status: signal.status,
      priority: signal.priority
    });

    // Convert to execution signal
    const execSignal = this.convertFeedToExecutionSignal(signal);

    // Check if we should execute
    if (!this.validateSignal(execSignal)) {
      this.metrics.signalsRejected++;
      this.emit('signalRejected', { signal, reason: 'Failed validation' });
      return;
    }

    // Check concurrent execution limit
    if (this.activeExecutions.size >= (this.config.maxConcurrentExecutions || 5)) {
      console.log('[SignalExecutor] Max concurrent executions reached, queueing signal');
      this.signalQueue.push(execSignal);
      this.emit('signalQueued', signal);
      return;
    }

    // Add artificial delay if configured (for safety)
    if (this.config.executionDelayMs && this.config.executionDelayMs > 0) {
      setTimeout(() => this.executeSignal(execSignal), this.config.executionDelayMs);
    } else {
      await this.executeSignal(execSignal);
    }
  }

  /**
   * Handle signal updates
   */
  private async handleSignalUpdate(signal: FeedSignal): Promise<void> {
    // If signal is being executed, check if we need to modify orders
    if (this.activeExecutions.has(signal.id)) {
      console.log(`[SignalExecutor] Signal ${signal.id} updated during execution`);
      
      // Check if signal should be cancelled based on status
      if (signal.status === 'expired' || signal.status === 'invalidated') {
        // Cancel via execution manager
        this.activeExecutions.delete(signal.id);
        this.emit('executionCancelled', signal);
      }
    }
  }

  /**
   * Determine if signal should be executed
   */
  private validateSignal(signal: FeedSignal | ExecutionSignal): boolean {
    // Check auto-execute setting
    if (!this.config.autoExecute) {
      console.log('[SignalExecutor] Auto-execute disabled');
      return false;
    }

    // Check signal validity
    if (!signal.shouldExecute) {
      console.log('[SignalExecutor] Signal marked as should not execute');
      return false;
    }

    // For execution signals, check additional properties
    if ('confidenceScore' in signal) {
      const execSignal = signal as ExecutionSignal;
      
      // Check confidence threshold
      if (this.config.minConfidence && execSignal.confidenceScore < this.config.minConfidence) {
        console.log(`[SignalExecutor] Signal confidence ${execSignal.confidenceScore} below threshold ${this.config.minConfidence}`);
        return false;
      }

      // Check profit threshold
      if (this.config.profitTarget && execSignal.expectedValue < this.config.profitTarget) {
        console.log(`[SignalExecutor] Expected value ${execSignal.expectedValue} below profit target ${this.config.profitTarget}`);
        return false;
      }
    }

    // Check if already executing
    if (this.activeExecutions.has(signal.id)) {
      console.log(`[SignalExecutor] Signal ${signal.id} already executing`);
      return false;
    }

    return true;
  }

  /**
   * Execute a signal
   */
  public async executeSignal(signal: ExecutionSignal): Promise<{success: boolean; error?: string}> {
    const startTime = Date.now();
    this.activeExecutions.add(signal.id);
    
    try {
      console.log(`[SignalExecutor] Executing signal ${signal.id}`);
      this.emit('executionStarted', signal);
      
      // Execute via ExecutionManager
      const result = await this.executionManager.executeSignal(signal);
      
      // Track execution
      this.metrics.signalsExecuted++;
      
      // Update metrics
      if (result.status === 'success') {
        this.metrics.signalsExecuted++;
        
        // Mark signal as executed in SignalGenerator
        if (this.signalGenerator) {
          const profit = this.calculateProfit(signal, result);
          this.signalGenerator.markExecuted(signal.id, profit);
        }
      }
      
      // Calculate execution time
      const executionTime = Date.now() - startTime;
      this.updateAvgExecutionTime(executionTime);
      this.metrics.lastExecutionTime = Date.now();
      
      this.emit('executionComplete', { signal, result, executionTime });
      
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : String(error);
      this.logger.error('Error executing signal', { error: errorMessage });
      this.emit('executionError', {
        signalId: signal.id,
        error: errorMessage,
        timestamp: Date.now()
      });
      return { success: false, error: errorMessage };
    } finally {
      this.activeExecutions.delete(signal.id);
      this.emitExecutionMetrics();
      this.processQueuedSignals();
    }
    
    return { success: true };
  }

  /**
   * Process queued signals
   */
  private async processQueuedSignals(): Promise<void> {
    while (this.signalQueue.length > 0) {
      const signal = this.signalQueue.shift();
      if (signal && this.activeExecutions.size < (this.config.maxConcurrentExecutions || 5)) {
        await this.executeSignal(signal);
      }
    }
  }

  /**
   * Handle execution completion
   */
  private handleExecutionComplete(result: ExecutionResult): void {
    console.log(`[SignalExecutor] Execution completed:`, result);
    
    // Update PnL if we have entry and exit
    if (result.status === 'success') {
      // TODO: Calculate actual PnL when position closes
      this.updateMetrics(result);
    }
  }

  /**
   * Handle execution failure
   */
  private handleExecutionFailed(result: ExecutionResult): void {
    console.error(`[SignalExecutor] Execution failed:`, result);
    this.metrics.signalsRejected++;
  }

  /**
   * Handle position updates
   */
  private handlePositionUpdate(update: any): void {
    // Check for stop loss or profit target hits
    if (update.unrealizedPnl) {
      const pnlPercent = update.unrealizedPnl / update.positionValue;
      
      if (pnlPercent <= -this.config.stopLoss) {
        console.log(`[SignalExecutor] Stop loss triggered for ${update.coin}`);
        this.emit('stopLossTriggered', update);
        // TODO: Close position
      } else if (pnlPercent >= this.config.profitTarget) {
        console.log(`[SignalExecutor] Profit target reached for ${update.coin}`);
        this.emit('profitTargetReached', update);
        // TODO: Consider closing position
      }
    }
  }

  /**
   * Calculate profit from execution
   */
  private calculateProfit(signal: Signal, result: ExecutionResult): number {
    // Simple calculation - actual profit would come from position close
    const expectedProfit = signal.expectedValue;
    const slippageCost = result.slippage * result.executedSize * result.executedPrice;
    const fees = result.fees;
    
    return expectedProfit - slippageCost - fees;
  }

  /**
   * Update metrics
   */
  private updateMetrics(result: ExecutionResult): void {
    const totalExecutions = this.metrics.signalsExecuted;
    const successfulExecutions = Math.floor(this.metrics.winRate * totalExecutions);
    const totalPnL = this.metrics.totalPnL;
    
    this.emit('metricsUpdated', this.metrics);
  }

  /**
   * Update average execution time
   */
  private updateAvgExecutionTime(newTime: number): void {
    const currentAvg = this.metrics.avgExecutionTime;
    const count = this.metrics.signalsExecuted;
    this.metrics.avgExecutionTime = (currentAvg * count + newTime) / (count + 1);
  }

  /**
   * Emit execution metrics
   */
  private emitExecutionMetrics(): void {
    this.emit('metrics', {
      ...this.metrics,
      activeExecutions: this.activeExecutions.size,
      queuedSignals: this.signalQueue.length
    });
  }

  /**
   * Get execution metrics
   */
  getMetrics(): ExecutionMetrics {
    return { ...this.metrics };
  }

  /**
   * Get execution history
   */
  getExecutionHistory(): Map<string, ExecutionResult> {
    // Return empty map for now - could be extended to track history
    return new Map();
  }

  /**
   * Enable/disable auto execution
   */
  setAutoExecute(enabled: boolean): void {
    this.config.autoExecute = enabled;
    console.log(`[SignalExecutor] Auto-execute ${enabled ? 'enabled' : 'disabled'}`);
    this.emit('autoExecuteChanged', enabled);
  }

  /**
   * Manually execute a specific signal
   */
  async manualExecute(signalId: string): Promise<ExecutionResult | null> {
    if (!this.signalGenerator) {
      throw new Error('Signal generator not connected');
    }

    const signals = this.signalGenerator.getActiveSignals();
    const signal = signals.find(s => s.id === signalId);
    
    if (!signal) {
      throw new Error(`Signal ${signalId} not found`);
    }

    await this.executeSignal(signal);
    return this.executionHistory.get(signalId) || null;
  }

  /**
   * Utility delay function
   */
  private delay(ms: number): Promise<void> {
    return new Promise(resolve => setTimeout(resolve, ms));
  }

  /**
   * Stop the executor
   */
  stop(): void {
    console.log('[SignalExecutor] Stopping...');
    this.config.autoExecute = false;
    this.removeAllListeners();
    console.log('[SignalExecutor] Stopped');
  }
}

export default SignalExecutor;
