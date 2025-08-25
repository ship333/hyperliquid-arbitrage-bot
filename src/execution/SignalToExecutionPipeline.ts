/**
 * Signal to Execution Pipeline
 * Connects signal generation to trade execution with risk checks
 */

import { EventEmitter } from 'events';
import { Signal, ExecutableOpportunity } from './types';
import { ExecutionManager } from './ExecutionManager';
import { ExecutionStrategies, StrategyConfig } from './ExecutionStrategies';
import HyperliquidClient from './HyperliquidClient';
import { OrderBuilder } from '../connectors/hyperliquid/OrderBuilder';

export interface PipelineConfig {
  riskLimits: {
    maxPositionSize: number;
    maxOrderValue: number;
    maxDailyLoss: number;
    maxOpenPositions: number;
    minConfidenceScore: number;
  };
  execution: {
    defaultStrategy: 'immediate' | 'twap' | 'iceberg' | 'adaptive';
    maxConcurrentOrders: number;
    orderTimeout: number;
    retryAttempts: number;
  };
  monitoring: {
    logLevel: 'debug' | 'info' | 'warn' | 'error';
    metricsInterval: number;
    alertThresholds: {
      lossThreshold: number;
      slippageThreshold: number;
      errorRateThreshold: number;
    };
  };
}

export interface PipelineStats {
  signalsReceived: number;
  signalsExecuted: number;
  signalsRejected: number;
  totalVolume: number;
  totalPnL: number;
  avgSlippage: number;
  successRate: number;
  activePositions: number;
  dailyLoss: number;
}

interface RiskCheckResult {
  passed: boolean;
  reason?: string;
  adjustedSize?: number;
  warnings: string[];
}

export class SignalToExecutionPipeline extends EventEmitter {
  private executionManager: ExecutionManager;
  private executionStrategies: ExecutionStrategies;
  private orderBuilder: OrderBuilder;
  
  // Pipeline state
  private isRunning = false;
  private signalQueue: Signal[] = [];
  private activeExecutions = new Map<string, any>();
  
  // Statistics
  private stats: PipelineStats = {
    signalsReceived: 0,
    signalsExecuted: 0,
    signalsRejected: 0,
    totalVolume: 0,
    totalPnL: 0,
    avgSlippage: 0,
    successRate: 0,
    activePositions: 0,
    dailyLoss: 0
  };
  
  // Risk tracking
  private dailyStartBalance = 0;
  private currentBalance = 0;
  private positionSizes = new Map<string, number>();
  
  constructor(
    private client: HyperliquidClient,
    private config: PipelineConfig
  ) {
    super();
    
    // Initialize components
    const orderBuilderConfig = {
      minOrderSize: 10,
      maxOrderSize: config.riskLimits.maxOrderValue,
      maxSlippagePercent: 0.5,
      defaultLeverage: 1,
      reduceOnly: false,
      postOnly: false,
      ioc: false
    };
    
    this.orderBuilder = new OrderBuilder(orderBuilderConfig);
    this.executionStrategies = new ExecutionStrategies(client, orderBuilderConfig);
    
    const executionConfig = {
      maxOrderRetries: config.execution.retryAttempts,
      orderTimeoutMs: config.execution.orderTimeout,
      maxSlippagePercent: 0.5,
      minOrderSize: 10,
      maxOrderSize: config.riskLimits.maxOrderValue,
      maxOpenOrders: config.execution.maxConcurrentOrders,
      dryRun: false
    };
    
    this.executionManager = new ExecutionManager(
      executionConfig,
      client
    );
    
    this.setupEventHandlers();
  }
  
  /**
   * Start the pipeline
   */
  async start(): Promise<void> {
    if (this.isRunning) {
      console.log('[Pipeline] Already running');
      return;
    }
    
    console.log('[Pipeline] Starting signal to execution pipeline...');
    
    try {
      // Initialize execution manager
      await this.executionManager.initialize();
      
      // Get initial balance for daily P&L tracking
      const accountState = await this.client.getAccountState();
      this.dailyStartBalance = accountState.marginSummary.accountValue;
      this.currentBalance = this.dailyStartBalance;
      
      // Start processing queue
      this.isRunning = true;
      this.processSignalQueue();
      
      // Start metrics collection
      this.startMetricsCollection();
      
      this.emit('started', {
        balance: this.currentBalance,
        timestamp: Date.now()
      });
      
      console.log('[Pipeline] Started successfully');
      
    } catch (error) {
      console.error('[Pipeline] Failed to start:', error);
      throw error;
    }
  }
  
  /**
   * Stop the pipeline
   */
  async stop(): Promise<void> {
    console.log('[Pipeline] Stopping...');
    
    this.isRunning = false;
    
    // Cancel all pending orders
    for (const [signalId, execution] of this.activeExecutions) {
      await this.cancelExecution(signalId);
    }
    
    // Stop strategies
    await this.executionStrategies.stopAll();
    
    this.emit('stopped', {
      stats: this.getStats(),
      timestamp: Date.now()
    });
    
    console.log('[Pipeline] Stopped');
  }
  
  /**
   * Process incoming signal
   */
  async processSignal(signal: Signal): Promise<void> {
    this.stats.signalsReceived++;
    
    this.emit('signalReceived', {
      signalId: signal.id,
      confidence: signal.confidenceScore,
      expectedValue: signal.expectedValue
    });
    
    // Step 1: Risk checks
    const riskCheck = await this.performRiskChecks(signal);
    
    if (!riskCheck.passed) {
      this.stats.signalsRejected++;
      
      this.emit('signalRejected', {
        signalId: signal.id,
        reason: riskCheck.reason,
        warnings: riskCheck.warnings
      });
      
      console.log(`[Pipeline] Signal ${signal.id} rejected: ${riskCheck.reason}`);
      return;
    }
    
    // Log warnings if any
    if (riskCheck.warnings.length > 0) {
      console.warn(`[Pipeline] Signal ${signal.id} warnings:`, riskCheck.warnings);
    }
    
    // Adjust size if needed
    if (riskCheck.adjustedSize) {
      signal.executionSize = riskCheck.adjustedSize;
      console.log(`[Pipeline] Adjusted size to ${riskCheck.adjustedSize}`);
    }
    
    // Step 2: Add to queue
    this.signalQueue.push(signal);
    
    // Process immediately if not at capacity
    if (this.activeExecutions.size < this.config.execution.maxConcurrentOrders) {
      this.processSignalQueue();
    }
  }
  
  /**
   * Process signal queue
   */
  private async processSignalQueue(): Promise<void> {
    while (
      this.isRunning && 
      this.signalQueue.length > 0 && 
      this.activeExecutions.size < this.config.execution.maxConcurrentOrders
    ) {
      const signal = this.signalQueue.shift();
      if (!signal) continue;
      
      // Execute signal
      this.executeSignal(signal).catch(error => {
        console.error(`[Pipeline] Failed to execute signal ${signal.id}:`, error);
        this.emit('executionError', {
          signalId: signal.id,
          error: error.message
        });
      });
    }
  }
  
  /**
   * Execute a signal
   */
  private async executeSignal(signal: Signal): Promise<void> {
    const startTime = Date.now();
    
    try {
      // Select execution strategy
      const strategy = this.executionStrategies.selectStrategy(signal);
      
      this.emit('executionStarted', {
        signalId: signal.id,
        strategy: strategy.type,
        size: signal.executionSize
      });
      
      // Track active execution
      this.activeExecutions.set(signal.id, {
        signal,
        strategy,
        startTime
      });
      
      // Execute with selected strategy
      const result = await this.executionStrategies.executeStrategy(signal, strategy);
      
      // Update statistics
      if (result.success) {
        this.stats.signalsExecuted++;
        this.stats.totalVolume += result.totalFilled * result.avgPrice;
        
        // Update slippage average
        const totalSlippages = this.stats.avgSlippage * (this.stats.signalsExecuted - 1);
        this.stats.avgSlippage = (totalSlippages + result.totalSlippage) / this.stats.signalsExecuted;
        
        this.emit('executionSuccess', {
          signalId: signal.id,
          ...result
        });
        
        console.log(`[Pipeline] Signal ${signal.id} executed successfully`);
        
      } else {
        this.emit('executionFailed', {
          signalId: signal.id,
          error: result.error
        });
        
        console.error(`[Pipeline] Signal ${signal.id} execution failed:`, result.error);
      }
      
      // Clean up
      this.activeExecutions.delete(signal.id);
      
      // Update success rate
      this.stats.successRate = this.stats.signalsExecuted / this.stats.signalsReceived;
      
      // Continue processing queue
      this.processSignalQueue();
      
    } catch (error: any) {
      console.error(`[Pipeline] Execution error for signal ${signal.id}:`, error);
      
      this.activeExecutions.delete(signal.id);
      
      this.emit('executionError', {
        signalId: signal.id,
        error: error.message
      });
      
      // Continue processing
      this.processSignalQueue();
    }
  }
  
  /**
   * Perform risk checks on signal
   */
  private async performRiskChecks(signal: Signal): Promise<RiskCheckResult> {
    const warnings: string[] = [];
    let adjustedSize = signal.executionSize;
    
    // Check 1: Minimum confidence
    if (signal.confidenceScore < this.config.riskLimits.minConfidenceScore) {
      return {
        passed: false,
        reason: `Confidence ${signal.confidenceScore} below minimum ${this.config.riskLimits.minConfidenceScore}`,
        warnings
      };
    }
    
    // Check 2: Maximum position size
    const currentPosition = this.positionSizes.get(signal.opportunity.pair) || 0;
    const newPosition = currentPosition + signal.executionSize;
    
    if (newPosition > this.config.riskLimits.maxPositionSize) {
      const availableSize = this.config.riskLimits.maxPositionSize - currentPosition;
      
      if (availableSize <= 0) {
        return {
          passed: false,
          reason: `Position limit reached for ${signal.opportunity.pair}`,
          warnings
        };
      }
      
      adjustedSize = availableSize;
      warnings.push(`Size adjusted from ${signal.executionSize} to ${adjustedSize} due to position limit`);
    }
    
    // Check 3: Maximum order value
    const orderValue = signal.executionSize * signal.expectedValue;
    if (orderValue > this.config.riskLimits.maxOrderValue) {
      adjustedSize = this.config.riskLimits.maxOrderValue / signal.expectedValue;
      warnings.push(`Size adjusted to meet max order value of ${this.config.riskLimits.maxOrderValue}`);
    }
    
    // Check 4: Daily loss limit
    const dailyLoss = this.dailyStartBalance - this.currentBalance;
    if (dailyLoss > this.config.riskLimits.maxDailyLoss) {
      return {
        passed: false,
        reason: `Daily loss limit of ${this.config.riskLimits.maxDailyLoss} exceeded`,
        warnings
      };
    }
    
    // Check 5: Maximum open positions
    if (this.positionSizes.size >= this.config.riskLimits.maxOpenPositions) {
      const hasPosition = this.positionSizes.has(signal.opportunity.pair);
      if (!hasPosition) {
        return {
          passed: false,
          reason: `Maximum open positions (${this.config.riskLimits.maxOpenPositions}) reached`,
          warnings
        };
      }
    }
    
    // Check 6: Signal expiry
    if (signal.validUntil && signal.validUntil < Date.now()) {
      return {
        passed: false,
        reason: 'Signal has expired',
        warnings
      };
    }
    
    return {
      passed: true,
      adjustedSize: adjustedSize !== signal.executionSize ? adjustedSize : undefined,
      warnings
    };
  }
  
  /**
   * Cancel an execution
   */
  private async cancelExecution(signalId: string): Promise<void> {
    const execution = this.activeExecutions.get(signalId);
    if (!execution) return;
    
    try {
      // Cancel all orders for this signal
      // Implementation would depend on tracking order IDs
      console.log(`[Pipeline] Cancelling execution for signal ${signalId}`);
      
      this.activeExecutions.delete(signalId);
      
      this.emit('executionCancelled', { signalId });
      
    } catch (error) {
      console.error(`[Pipeline] Failed to cancel execution ${signalId}:`, error);
    }
  }
  
  /**
   * Setup event handlers
   */
  private setupEventHandlers(): void {
    // Handle execution manager events
    this.executionManager.on('orderPlaced', (data) => {
      this.emit('orderPlaced', data);
    });
    
    this.executionManager.on('orderFilled', (data) => {
      this.updatePositionSize(data.coin, data.size);
      this.emit('orderFilled', data);
    });
    
    this.executionManager.on('orderCancelled', (data) => {
      this.emit('orderCancelled', data);
    });
    
    // Handle strategy events
    this.executionStrategies.on('strategyStart', (data) => {
      this.emit('strategyStart', data);
    });
    
    this.executionStrategies.on('twapProgress', (data) => {
      this.emit('twapProgress', data);
    });
    
    // Handle client events
    this.client.on('fill', (data) => {
      this.handleFill(data);
    });
    
    this.client.on('userUpdate', (data) => {
      this.handleUserUpdate(data);
    });
  }
  
  /**
   * Handle fill event
   */
  private handleFill(data: any): void {
    // Update P&L
    if (data.pnl) {
      this.stats.totalPnL += data.pnl;
    }
    
    this.emit('fill', data);
  }
  
  /**
   * Handle user update (balance changes)
   */
  private handleUserUpdate(data: any): void {
    if (data.accountValue) {
      this.currentBalance = data.accountValue;
      this.stats.dailyLoss = Math.max(0, this.dailyStartBalance - this.currentBalance);
    }
    
    if (data.positions) {
      this.updatePositions(data.positions);
    }
  }
  
  /**
   * Update position size tracking
   */
  private updatePositionSize(coin: string, sizeDelta: number): void {
    const current = this.positionSizes.get(coin) || 0;
    const newSize = current + sizeDelta;
    
    if (Math.abs(newSize) < 0.001) {
      this.positionSizes.delete(coin);
    } else {
      this.positionSizes.set(coin, newSize);
    }
    
    this.stats.activePositions = this.positionSizes.size;
  }
  
  /**
   * Update all positions
   */
  private updatePositions(positions: any[]): void {
    this.positionSizes.clear();
    
    for (const pos of positions) {
      if (Math.abs(pos.szi) > 0.001) {
        this.positionSizes.set(pos.coin, pos.szi);
      }
    }
    
    this.stats.activePositions = this.positionSizes.size;
  }
  
  /**
   * Start metrics collection
   */
  private startMetricsCollection(): void {
    setInterval(() => {
      const metrics = {
        ...this.stats,
        queueLength: this.signalQueue.length,
        activeExecutions: this.activeExecutions.size,
        timestamp: Date.now()
      };
      
      this.emit('metrics', metrics);
      
      // Check alert thresholds
      this.checkAlerts(metrics);
      
    }, this.config.monitoring.metricsInterval);
  }
  
  /**
   * Check alert thresholds
   */
  private checkAlerts(metrics: any): void {
    const { alertThresholds } = this.config.monitoring;
    
    // Daily loss alert
    if (metrics.dailyLoss > alertThresholds.lossThreshold) {
      this.emit('alert', {
        type: 'DAILY_LOSS',
        message: `Daily loss ${metrics.dailyLoss} exceeds threshold ${alertThresholds.lossThreshold}`,
        severity: 'high'
      });
    }
    
    // Slippage alert
    if (metrics.avgSlippage > alertThresholds.slippageThreshold) {
      this.emit('alert', {
        type: 'HIGH_SLIPPAGE',
        message: `Average slippage ${metrics.avgSlippage}% exceeds threshold ${alertThresholds.slippageThreshold}%`,
        severity: 'medium'
      });
    }
    
    // Error rate alert
    const errorRate = 1 - metrics.successRate;
    if (errorRate > alertThresholds.errorRateThreshold) {
      this.emit('alert', {
        type: 'HIGH_ERROR_RATE',
        message: `Error rate ${(errorRate * 100).toFixed(2)}% exceeds threshold ${alertThresholds.errorRateThreshold * 100}%`,
        severity: 'high'
      });
    }
  }
  
  /**
   * Get current statistics
   */
  getStats(): PipelineStats {
    return { ...this.stats };
  }
  
  /**
   * Get queue status
   */
  getQueueStatus(): any {
    return {
      queueLength: this.signalQueue.length,
      activeExecutions: this.activeExecutions.size,
      maxConcurrent: this.config.execution.maxConcurrentOrders,
      isProcessing: this.isRunning
    };
  }
  
  /**
   * Emergency stop
   */
  async emergencyStop(reason: string): Promise<void> {
    console.error(`[Pipeline] EMERGENCY STOP: ${reason}`);
    
    this.emit('emergencyStop', { reason, timestamp: Date.now() });
    
    // Stop immediately
    this.isRunning = false;
    
    // Cancel all active orders
    for (const [signalId] of this.activeExecutions) {
      await this.cancelExecution(signalId);
    }
    
    // Clear queue
    this.signalQueue = [];
    
    console.log('[Pipeline] Emergency stop completed');
  }
}

export default SignalToExecutionPipeline;
