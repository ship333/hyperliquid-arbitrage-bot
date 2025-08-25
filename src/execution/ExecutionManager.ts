/**
 * Execution Manager
 * Orchestrates trade execution from signals to orders
 */

import { EventEmitter } from 'events';
import { HyperliquidClient } from './HyperliquidClient';
import { Signal, ExecutableOpportunity, OrderRequest, OrderResponse, Position } from './types';
import { incOrder, setExecutionGauges, setEquityMetrics, setDailyLoss, setDrawdown, incRiskRejection, incCircuitBreakerTrip, setCircuitBreakerState } from '../metrics/execution';

export interface ExecutionConfig {
  maxOrderRetries: number;
  orderTimeoutMs: number;
  maxSlippagePercent: number;
  minOrderSize: number;
  maxOrderSize: number;
  maxOpenOrders: number;
  dryRun: boolean;  // Paper trading mode
  // Optional risk controls (fallback to sensible defaults if undefined)
  maxPositionUsd?: number;           // e.g., RISK_MAX_POSITION_SIZE
  maxDailyLossUsd?: number;          // e.g., RISK_MAX_DAILY_LOSS
  maxDrawdown?: number;              // fraction, e.g., 0.05 for 5%
  circuitBreakerEnabled?: boolean;   // e.g., RISK_CIRCUIT_BREAKER_ENABLED
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

export interface ExecutionState {
  activeExecutions: Map<string, ExecutionTask>;
  completedExecutions: ExecutionResult[];
  failedExecutions: ExecutionResult[];
  totalVolume: number;
  totalPnL: number;
  successRate: number;
}

interface ExecutionTask {
  signal: Signal;
  orders: OrderRequest[];
  status: 'pending' | 'executing' | 'completed' | 'failed';
  startTime: number;
  retryCount: number;
  results: ExecutionResult[];
}

export class ExecutionManager extends EventEmitter {
  private client: HyperliquidClient;
  private activeExecutions = new Map<string, ExecutionTask>();
  private completedExecutions: ExecutionResult[] = [];
  private failedExecutions: ExecutionResult[] = [];
  private executionQueue: Signal[] = [];
  private isProcessing = false;
  
  // Statistics
  private totalVolume = 0;
  private totalPnL = 0;
  private successCount = 0;
  private failureCount = 0;

  // Risk state
  private dailyBaselineUsd = 0;     // equity at start-of-day
  private peakEquityUsd = 0;        // peak observed equity for drawdown
  private lastEquityUsd = 0;        // last observed equity
  private lastRiskResetDate = '';
  private circuitBreakerTripped = false;

  constructor(
    private config: ExecutionConfig,
    clientOrConfig: any
  ) {
    super();
    // Accept either a HyperliquidClient instance or a config object
    if (clientOrConfig instanceof HyperliquidClient) {
      this.client = clientOrConfig as HyperliquidClient;
    } else {
      this.client = new HyperliquidClient(clientOrConfig);
    }
    this.setupEventHandlers();
  }

  /**
   * Initialize the execution manager
   */
  async initialize(): Promise<void> {
    console.log('[ExecutionManager] Initializing...');
    
    // Connect to Hyperliquid
    await this.client.connect();
    
    // Get initial account state
    const accountState = await this.client.getAccountState();
    console.log('[ExecutionManager] Account state:', {
      accountValue: accountState.marginSummary.accountValue,
      withdrawable: accountState.marginSummary.withdrawable,
      positions: accountState.assetPositions.length
    });
    // Initialize risk baselines
    const equity = accountState.marginSummary.accountValue;
    this.peakEquityUsd = equity;
    this.lastEquityUsd = equity;
    const today = new Date().toISOString().slice(0, 10);
    this.lastRiskResetDate = today;
    this.dailyBaselineUsd = equity;
    
    // Start execution processor
    this.startExecutionProcessor();
    
    console.log('[ExecutionManager] Initialized');
  }

  /**
   * Setup event handlers
   */
  private setupEventHandlers(): void {
    // Handle order fills
    this.client.on('fill', (fill) => {
      this.handleFill(fill);
    });

    // Handle order errors
    this.client.on('orderError', (error) => {
      this.handleOrderError(error);
    });

    // Handle position updates
    this.client.on('userUpdate', (update) => {
      this.handleUserUpdate(update);
    });
  }

  /**
   * Execute a signal
   */
  async executeSignal(signal: Signal): Promise<ExecutionResult> {
    console.log(`[ExecutionManager] Executing signal ${signal.id}`);
    
    // Validate signal
    if (!this.validateSignal(signal)) {
      try { incOrder('rejected', 'n/a', 'validation'); } catch {}
      return {
        signalId: signal.id,
        status: 'rejected',
        executedSize: 0,
        executedPrice: 0,
        slippage: 0,
        fees: 0,
        timestamp: Date.now(),
        error: 'Signal validation failed'
      };
    }

    // Check risk limits
    if (!await this.checkRiskLimits(signal)) {
      try { incOrder('rejected', 'n/a', 'risk_limits'); } catch {}
      return {
        signalId: signal.id,
        status: 'rejected',
        executedSize: 0,
        executedPrice: 0,
        slippage: 0,
        fees: 0,
        timestamp: Date.now(),
        error: 'Risk limits exceeded'
      };
    }

    // Add to execution queue
    this.executionQueue.push(signal);
    this.emit('signalQueued', signal);
    try { setExecutionGauges(this.activeExecutions.size, this.executionQueue.length); } catch {}

    // Wait for execution to complete
    return new Promise((resolve) => {
      const checkInterval = setInterval(() => {
        const task = this.activeExecutions.get(signal.id);
        if (task && task.status === 'completed') {
          clearInterval(checkInterval);
          const result = task.results[0] || {
            signalId: signal.id,
            status: 'failed' as const,
            executedSize: 0,
            executedPrice: 0,
            slippage: 0,
            fees: 0,
            timestamp: Date.now(),
            error: 'No execution result'
          };
          resolve(result);
        } else if (task && task.status === 'failed') {
          clearInterval(checkInterval);
          resolve({
            signalId: signal.id,
            status: 'failed',
            executedSize: 0,
            executedPrice: 0,
            slippage: 0,
            fees: 0,
            timestamp: Date.now(),
            error: 'Execution failed'
          });
        }
      }, 100);

      // Timeout after configured period
      setTimeout(() => {
        clearInterval(checkInterval);
        resolve({
          signalId: signal.id,
          status: 'failed',
          executedSize: 0,
          executedPrice: 0,
          slippage: 0,
          fees: 0,
          timestamp: Date.now(),
          error: 'Execution timeout'
        });
      }, this.config.orderTimeoutMs);
    });
  }

  /**
   * Start processing execution queue
   */
  private startExecutionProcessor(): void {
    setInterval(async () => {
      if (this.isProcessing || this.executionQueue.length === 0) return;
      
      this.isProcessing = true;
      
      try {
        // Check max open orders limit
        if (this.activeExecutions.size >= this.config.maxOpenOrders) {
          console.log('[ExecutionManager] Max open orders reached, waiting...');
          try { setExecutionGauges(this.activeExecutions.size, this.executionQueue.length); } catch {}
          return;
        }

        // Get next signal from queue
        const signal = this.executionQueue.shift();
        if (!signal) return;

        // Create execution task
        const task: ExecutionTask = {
          signal,
          orders: this.buildOrders(signal),
          status: 'pending',
          startTime: Date.now(),
          retryCount: 0,
          results: []
        };

        this.activeExecutions.set(signal.id, task);
        try { setExecutionGauges(this.activeExecutions.size, this.executionQueue.length); } catch {}

        // Execute orders
        await this.processExecutionTask(task);

      } catch (error) {
        console.error('[ExecutionManager] Execution processor error:', error);
      } finally {
        this.isProcessing = false;
        try { setExecutionGauges(this.activeExecutions.size, this.executionQueue.length); } catch {}
      }
    }, 100);
  }

  /**
   * Process an execution task
   */
  private async processExecutionTask(task: ExecutionTask): Promise<void> {
    task.status = 'executing';
    
    for (const order of task.orders) {
      try {
        // Pre-send slippage clamp using latest market price
        const safeOrder = this.clampOrderToSlippage(order);
        if (safeOrder.limit_px !== order.limit_px) {
          console.log('[ExecutionManager] Clamped limit price for slippage safety', {
            coin: safeOrder.coin,
            original: order.limit_px,
            clamped: safeOrder.limit_px,
            maxSlippagePercent: this.config.maxSlippagePercent,
          });
        }
        // Place order (or simulate in dry run mode)
        const response = this.config.dryRun 
          ? await this.simulateOrder(safeOrder)
          : await this.client.placeOrder(safeOrder);

        if (response.status === 'ok') {
          // Order placed successfully
          const result: ExecutionResult = {
            signalId: task.signal.id,
            orderId: response.response?.data.statuses[0]?.resting?.oid?.toString(),
            status: 'success',
            executedSize: order.sz,
            executedPrice: order.limit_px,
            slippage: this.calculateSlippage(task.signal, order.limit_px),
            fees: this.estimateFees(order.sz * order.limit_px),
            timestamp: Date.now()
          };

          task.results.push(result);
          this.completedExecutions.push(result);
          this.successCount++;
          try { incOrder('success', order.is_buy ? 'buy' : 'sell', ''); } catch {}
          
          this.emit('orderExecuted', result);
        } else {
          // Order failed
          throw new Error(response.error || 'Unknown error');
        }
      } catch (error: any) {
        console.error(`[ExecutionManager] Order execution failed:`, error);
        
        // Retry logic
        if (task.retryCount < this.config.maxOrderRetries) {
          task.retryCount++;
          console.log(`[ExecutionManager] Retrying execution (attempt ${task.retryCount})`);
          await this.delay(1000 * task.retryCount);
          return this.processExecutionTask(task);
        }

        // Max retries reached
        const result: ExecutionResult = {
          signalId: task.signal.id,
          status: 'failed',
          executedSize: 0,
          executedPrice: 0,
          slippage: 0,
          fees: 0,
          timestamp: Date.now(),
          error: error.message
        };

        task.results.push(result);
        this.failedExecutions.push(result);
        this.failureCount++;
        try { incOrder('failed', 'n/a', error?.message ? String(error.message).slice(0, 64) : 'error'); } catch {}
        
        this.emit('orderFailed', result);
      }
    }

    // Mark task as completed
    task.status = task.results.some(r => r.status === 'success') ? 'completed' : 'failed';
    
    // Update statistics
    this.updateStatistics(task);
    
    // Clean up
    setTimeout(() => {
      this.activeExecutions.delete(task.signal.id);
      try { setExecutionGauges(this.activeExecutions.size, this.executionQueue.length); } catch {}
    }, 60000); // Keep for 1 minute for reference
  }

  /**
   * Build orders from signal
   */
  private buildOrders(signal: Signal): OrderRequest[] {
    const orders: OrderRequest[] = [];
    
    // Parse the signal to determine order parameters
    const opportunity = signal.opportunity as ExecutableOpportunity;
    
    // For now, create a simple market order
    // TODO: Implement sophisticated order building based on signal type
    const rawSize = Math.min(signal.executionSize, this.config.maxOrderSize);
    const rawLimit = opportunity.expectedPrice * (1 + this.config.maxSlippagePercent / 100);
    const roundedSize = this.roundSize(rawSize);
    const roundedLimit = this.roundPrice(rawLimit);
    orders.push({
      coin: opportunity.pair,
      is_buy: opportunity.type === 'cross_venue' || opportunity.type === 'triangular',
      sz: roundedSize,
      limit_px: roundedLimit,
      order_type: 'limit',
      post_only: false,
      ioc: true,  // Immediate or cancel for arbitrage
      cloid: `${signal.id}-1`
    });

    return orders;
  }

  /**
   * Validate signal before execution
   */
  private validateSignal(signal: Signal): boolean {
    // Check signal expiry
    if (Date.now() > signal.validUntil) {
      console.log(`[ExecutionManager] Signal ${signal.id} expired`);
      return false;
    }

    // Check execution size
    if (signal.executionSize < this.config.minOrderSize) {
      console.log(`[ExecutionManager] Signal ${signal.id} size too small`);
      return false;
    }

    // Check risk score
    if (signal.riskScore > 0.5) {
      console.log(`[ExecutionManager] Signal ${signal.id} risk too high`);
      return false;
    }

    return true;
  }

  /**
   * Check risk limits before execution
   */
  private async checkRiskLimits(signal: Signal): Promise<boolean> {
    try {
      // Circuit breaker
      if (this.config.circuitBreakerEnabled && this.circuitBreakerTripped) {
        console.log('[ExecutionManager] Circuit breaker tripped; rejecting execution');
        try { setCircuitBreakerState(true); incRiskRejection('circuit_breaker'); } catch {}
        return false;
      }

      const accountState = await this.client.getAccountState();
      const equity = accountState.marginSummary.accountValue;
      this.lastEquityUsd = equity;
      this.maybeResetDailyBaseline(equity);
      // Track peak equity for drawdown
      if (equity > this.peakEquityUsd) this.peakEquityUsd = equity;
      try { setEquityMetrics(equity, this.peakEquityUsd, this.dailyBaselineUsd); } catch {}
      
      // Check available margin
      const requiredMargin = signal.executionSize * signal.opportunity.expectedPrice;
      if (requiredMargin > accountState.marginSummary.withdrawable) {
        console.log(`[ExecutionManager] Insufficient margin for signal ${signal.id}`);
        try { incRiskRejection('insufficient_margin'); } catch {}
        return false;
      }

      // Check position limits
      const currentPositions = accountState.assetPositions;
      const coinPosition = currentPositions.find(p => p.coin === signal.opportunity.pair);
      if (coinPosition && Math.abs(coinPosition.szi) + signal.executionSize > this.config.maxOrderSize) {
        console.log(`[ExecutionManager] Position limit exceeded for ${signal.opportunity.pair}`);
        try { incRiskRejection('position_limit'); } catch {}
        return false;
      }

      // Max position in USD (optional)
      const maxPosUsd = this.config.maxPositionUsd ?? Number(process.env.RISK_MAX_POSITION_SIZE || 0);
      if (maxPosUsd > 0) {
        const currentPosSz = Math.abs(coinPosition?.szi || 0);
        const projectedUsd = (currentPosSz + signal.executionSize) * signal.opportunity.expectedPrice;
        if (projectedUsd > maxPosUsd) {
          console.log(`[ExecutionManager] Max position USD exceeded: ${projectedUsd} > ${maxPosUsd}`);
          try { incRiskRejection('max_position_usd'); } catch {}
          return false;
        }
      }

      // Daily loss limit (optional)
      const maxDailyLoss = this.config.maxDailyLossUsd ?? Number(process.env.RISK_MAX_DAILY_LOSS || 0);
      if (maxDailyLoss > 0) {
        const dailyLoss = Math.max(0, this.dailyBaselineUsd - equity);
        try { setDailyLoss(dailyLoss); } catch {}
        if (dailyLoss > maxDailyLoss) {
          console.log(`[ExecutionManager] Daily loss limit exceeded: ${dailyLoss} > ${maxDailyLoss}`);
          if (this.config.circuitBreakerEnabled ?? (process.env.RISK_CIRCUIT_BREAKER_ENABLED === 'true')) {
            this.circuitBreakerTripped = true;
            try { incCircuitBreakerTrip('daily_loss'); setCircuitBreakerState(true); } catch {}
          }
          try { incRiskRejection('daily_loss'); } catch {}
          return false;
        }
      }

      // Max drawdown (optional)
      const maxDd = this.config.maxDrawdown ?? Number(process.env.RISK_MAX_DRAWDOWN || 0);
      if (maxDd > 0 && this.peakEquityUsd > 0) {
        const dd = 1 - equity / this.peakEquityUsd;
        try { setDrawdown(dd); } catch {}
        if (dd > maxDd) {
          console.log(`[ExecutionManager] Drawdown limit exceeded: ${(dd * 100).toFixed(2)}% > ${(maxDd * 100).toFixed(2)}%`);
          if (this.config.circuitBreakerEnabled ?? (process.env.RISK_CIRCUIT_BREAKER_ENABLED === 'true')) {
            this.circuitBreakerTripped = true;
            try { incCircuitBreakerTrip('drawdown'); setCircuitBreakerState(true); } catch {}
          }
          try { incRiskRejection('drawdown'); } catch {}
          return false;
        }
      }

      return true;
    } catch (error) {
      console.error('[ExecutionManager] Risk check failed:', error);
      return false;
    }
  }

  /**
   * Simulate order for dry run mode
   */
  private async simulateOrder(order: OrderRequest): Promise<OrderResponse> {
    await this.delay(100); // Simulate network delay
    
    // Simple simulation - always succeeds with some slippage
    const simulatedSlippage = 1 + (Math.random() * 0.002 - 0.001); // ±0.1% slippage
    
    return {
      status: 'ok',
      response: {
        type: 'order',
        data: {
          statuses: [{
            filled: {
              totalSz: order.sz.toString(),
              avgPx: (order.limit_px * simulatedSlippage).toString()
            }
          }]
        }
      }
    };
  }

  /**
   * Calculate slippage from expected price
   */
  private calculateSlippage(signal: Signal, executedPrice: number): number {
    const expectedPrice = signal.opportunity.expectedPrice;
    return Math.abs(executedPrice - expectedPrice) / expectedPrice;
  }

  /**
   * Estimate trading fees
   */
  private estimateFees(notional: number): number {
    // Hyperliquid fees: 0.025% taker, 0.01% maker
    const feeRate = 0.00025; // Assume taker for now
    return notional * feeRate;
  }

  // Clamp limit price within +/- maxSlippagePercent of the latest price.
  private clampOrderToSlippage(order: OrderRequest): OrderRequest {
    const last = this.client.getLastPrice(order.coin);
    if (last === undefined || !isFinite(last) || last <= 0) return order;
    const maxSlip = this.config.maxSlippagePercent / 100;
    if (maxSlip <= 0) return order;
    const upper = last * (1 + maxSlip);
    const lower = last * (1 - maxSlip);
    let px = order.limit_px;
    if (order.is_buy && px > upper) px = upper;
    if (!order.is_buy && px < lower) px = lower;
    if (px === order.limit_px) return order;
    const clamped = { ...order, limit_px: this.roundPrice(px) };
    return clamped;
  }

  private roundPrice(px: number): number {
    // Default to 2 decimal places if tick not known
    return Math.round(px * 100) / 100;
  }

  private roundSize(sz: number): number {
    // Default to 1e-4 size precision
    return Math.round(sz * 1e4) / 1e4;
  }

  private maybeResetDailyBaseline(currentEquity: number): void {
    const today = new Date().toISOString().slice(0, 10);
    if (this.lastRiskResetDate !== today) {
      this.lastRiskResetDate = today;
      this.dailyBaselineUsd = currentEquity;
      // do not reset peak here; peak tracks across session
    }
  }

  /**
   * Handle fill events
   */
  private handleFill(fill: any): void {
    console.log('[ExecutionManager] Fill received:', fill);
    this.emit('fill', fill);
  }

  /**
   * Handle order errors
   */
  private handleOrderError(error: any): void {
    console.error('[ExecutionManager] Order error:', error);
    this.emit('orderError', error);
  }

  /**
   * Handle user updates
   */
  private handleUserUpdate(update: any): void {
    this.emit('positionUpdate', update);
  }

  /**
   * Update statistics after execution
   */
  private updateStatistics(task: ExecutionTask): void {
    const successfulResults = task.results.filter(r => r.status === 'success');
    
    for (const result of successfulResults) {
      this.totalVolume += result.executedSize * result.executedPrice;
      // PnL would be calculated after position closes
    }

    this.emit('statisticsUpdated', this.getStatistics());
  }

  /**
   * Get execution statistics
   */
  getStatistics() {
    return {
      activeExecutions: this.activeExecutions.size,
      completedExecutions: this.completedExecutions.length,
      failedExecutions: this.failedExecutions.length,
      successRate: this.successCount / (this.successCount + this.failureCount) || 0,
      totalVolume: this.totalVolume,
      totalPnL: this.totalPnL,
      queueLength: this.executionQueue.length
    };
  }

  /**
   * Get execution state
   */
  getState(): ExecutionState {
    return {
      activeExecutions: this.activeExecutions,
      completedExecutions: this.completedExecutions,
      failedExecutions: this.failedExecutions,
      totalVolume: this.totalVolume,
      totalPnL: this.totalPnL,
      successRate: this.successCount / (this.successCount + this.failureCount) || 0
    };
  }

  /**
   * Utility delay function
   */
  private delay(ms: number): Promise<void> {
    return new Promise(resolve => setTimeout(resolve, ms));
  }

  /**
   * Shutdown execution manager
   */
  async shutdown(): Promise<void> {
    console.log('[ExecutionManager] Shutting down...');
    
    // Cancel all pending orders
    for (const [signalId, task] of this.activeExecutions) {
      if (task.status === 'executing') {
        console.log(`[ExecutionManager] Cancelling execution for signal ${signalId}`);
        // TODO: Implement order cancellation
      }
    }

    // Disconnect from Hyperliquid
    this.client.disconnect();
    
    console.log('[ExecutionManager] Shutdown complete');
  }
}

export default ExecutionManager;
