/**
 * Execution Engine
 * Core trading logic - converts signals into executed trades
 * Priority: IMMEDIATE - 0% complete, critical for MVP
 */

import { EventEmitter } from 'events';
import HyperliquidClient, {
  OrderRequest,
  OrderResponse,
  AccountState,
  Position as HlPosition
} from './HyperliquidClient';
import { Signal } from './types';
import winston from 'winston';

export interface ExecutionConfig {
  maxSlippage: number;           // Maximum allowed slippage (%)
  executionDelay: number;        // Delay between executions (ms)
  maxRetries: number;            // Max retry attempts for failed orders
  emergencyStop: boolean;        // Emergency stop flag
  paperTrading: boolean;         // Paper trading mode
  minOrderSize: number;          // Minimum order size in USD
  maxOrderSize: number;          // Maximum order size in USD
}

export interface ExecutionResult {
  signalId: string;
  orderId?: string;
  status: 'success' | 'failed' | 'partial' | 'cancelled';
  executedSize: number;
  executedPrice: number;
  slippage: number;
  pnl?: number;
  error?: string;
  timestamp: number;
}

export interface ExecutionStats {
  totalSignals: number;
  executedSignals: number;
  successRate: number;
  totalPnL: number;
  avgSlippage: number;
  failedExecutions: number;
}

export class ExecutionEngine extends EventEmitter {
  private client: HyperliquidClient;
  private config: ExecutionConfig;
  private logger: winston.Logger;
  private isRunning: boolean = false;
  private executionQueue: Signal[] = [];
  private activeOrders: Map<string, {
    orderId: string;
    status: string;
    symbol: string;
    size: number;
    timestamp: number;
  }> = new Map();
  private positions: Map<string, HlPosition> = new Map();
  private stats: ExecutionStats = {
    totalSignals: 0,
    executedSignals: 0,
    successRate: 0,
    totalPnL: 0,
    avgSlippage: 0,
    failedExecutions: 0
  };

  constructor(client: HyperliquidClient, config: ExecutionConfig) {
    super();
    this.client = client;
    this.config = config;
    
    // Setup logger
    this.logger = winston.createLogger({
      level: 'info',
      format: winston.format.combine(
        winston.format.timestamp(),
        winston.format.json()
      ),
      transports: [
        new winston.transports.Console(),
        new winston.transports.File({ filename: 'logs/execution.log' })
      ]
    });

    this.setupEventHandlers();
  }

  /**
   * Start the execution engine
   */
  async start(): Promise<void> {
    if (this.isRunning) {
      this.logger.warn('Execution engine already running');
      return;
    }

    this.logger.info('Starting execution engine', {
      paperTrading: this.config.paperTrading,
      maxSlippage: this.config.maxSlippage
    });

    this.isRunning = true;
    this.emit('started');
    
    // Start processing queue
    this.processExecutionQueue();
    
    // Load current positions
    await this.loadPositions();
  }

  /**
   * Stop the execution engine
   */
  async stop(): Promise<void> {
    this.logger.info('Stopping execution engine');
    this.isRunning = false;
    
    // Cancel all pending orders
    await this.cancelAllPendingOrders();
    
    this.emit('stopped');
  }

  /**
   * Execute a trading signal
   * This is the CORE method that enables actual trading
   */
  async executeSignal(signal: Signal): Promise<ExecutionResult> {
    this.stats.totalSignals++;
    
    try {
      // Validate signal
      if (!this.validateSignal(signal)) {
        throw new Error('Signal validation failed');
      }

      // Check emergency stop
      if (this.config.emergencyStop) {
        throw new Error('Emergency stop activated');
      }

      // Paper trading mode
      if (this.config.paperTrading) {
        return await this.executePaperTrade(signal);
      }

      // Build order from signal
      const order = this.buildOrder(signal);
      
      // Check slippage before execution
      const estimatedSlippage = await this.estimateSlippage(order);
      if (estimatedSlippage > this.config.maxSlippage) {
        throw new Error(`Slippage ${estimatedSlippage}% exceeds max ${this.config.maxSlippage}%`);
      }

      // Place the order
      const orderId = await this.placeOrderWithRetry(order);
      
      // Track the order
      this.activeOrders.set(orderId, {
        orderId,
        status: 'pending',
        symbol: order.coin,
        size: order.sz,
        timestamp: Date.now()
      });
      
      // Wait for fill or timeout
      const filledOrder = await this.waitForFill(orderId, 30000);
      
      // Calculate execution metrics
      const result: ExecutionResult = {
        signalId: signal.id,
        orderId,
        status: 'success',
        executedSize: filledOrder.filledSize,
        executedPrice: filledOrder.avgFillPrice,
        slippage: this.calculateSlippage(signal.expectedValue, filledOrder.avgFillPrice),
        timestamp: Date.now()
      };

      // Update stats
      this.stats.executedSignals++;
      this.stats.successRate = this.stats.executedSignals / this.stats.totalSignals;
      
      this.logger.info('Signal executed successfully', result);
      this.emit('executionComplete', result);
      
      return result;
      
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : 'Unknown error';
      
      this.stats.failedExecutions++;
      
      const result: ExecutionResult = {
        signalId: signal.id,
        status: 'failed',
        executedSize: 0,
        executedPrice: 0,
        slippage: 0,
        error: errorMessage,
        timestamp: Date.now()
      };
      
      this.logger.error('Signal execution failed', { signal, error: errorMessage });
      this.emit('executionFailed', result);
      
      return result;
    }
  }

  /**
   * Add signal to execution queue
   */
  queueSignal(signal: Signal): void {
    if (!this.isRunning) {
      this.logger.warn('Cannot queue signal - engine not running');
      return;
    }

    this.executionQueue.push(signal);
    this.logger.info(`Signal queued: ${signal.id}, Queue size: ${this.executionQueue.length}`);
  }

  /**
   * Process execution queue
   */
  private async processExecutionQueue(): Promise<void> {
    while (this.isRunning) {
      if (this.executionQueue.length > 0) {
        const signal = this.executionQueue.shift();
        if (signal) {
          await this.executeSignal(signal);
          
          // Add delay between executions
          if (this.config.executionDelay > 0) {
            await this.delay(this.config.executionDelay);
          }
        }
      } else {
        // Check queue every 100ms when empty
        await this.delay(100);
      }
    }
  }

  /**
   * Build order from signal
   */
  private buildOrder(signal: Signal): OrderRequest {
    const opportunity = signal.opportunity as any;
    
    return {
      coin: opportunity.pair || 'ETH',
      is_buy: opportunity.side === 'buy',
      sz: this.calculateOrderSize(signal),
      limit_px: 0,  // Market orders
      order_type: 'market',
      cloid: `BOT_${signal.id}`
    };
  }

  /**
   * Calculate appropriate order size
   */
  private calculateOrderSize(signal: Signal): number {
    // Base size on confidence score and expected value
    const confidence = signal.confidenceScore || 0.5;
    const baseSize = this.config.minOrderSize * (1 + confidence * 2);
    
    // Adjust for risk
    const riskAdjustment = 1 - (signal.riskScore || 0.5);
    
    return baseSize * riskAdjustment;
  }

  /**
   * Place order with retry logic
   */
  private async placeOrderWithRetry(order: OrderRequest): Promise<string> {
    let attempts = 0;
    
    while (attempts < this.config.maxRetries) {
      try {
        const response = await this.client.placeOrder(order);
        if (response.status === 'ok' && response.response?.data.statuses[0]?.resting?.oid) {
          return response.response.data.statuses[0].resting.oid.toString();
        }
        throw new Error(response.error || 'Order placement failed');
      } catch (error) {
        attempts++;
        if (attempts < this.config.maxRetries) {
          await this.delay(1000 * attempts);
        }
      }
    }
    throw new Error('Max retries exceeded');
  }

  /**
   * Wait for order to fill
   */
  private async waitForFill(orderId: string, timeoutMs: number): Promise<{
    orderId: string;
    filledSize: number;
    avgFillPrice: number;
  }> {
    const startTime = Date.now();
    
    while (Date.now() - startTime < timeoutMs) {
      const openOrders = await this.client.getOpenOrders();
      const orderStatus = openOrders.find(o => o.cloid === orderId);
      
      if (!orderStatus) {
        // Order might be filled already
        const filledOrder = await this.client.getFills();
        const fill = filledOrder.find(f => f.cloid === orderId);
        if (fill) {
          return {
            orderId,
            filledSize: parseFloat(fill.sz),
            avgFillPrice: parseFloat(fill.px)
          };
        }
        throw new Error(`Order ${orderId} not found`);
      }
      if (orderStatus.status === 'filled') {
        return {
          orderId,
          filledSize: parseFloat(orderStatus.filledSz || '0'),
          avgFillPrice: parseFloat(orderStatus.avgPx || '0')
        };
      }
      if (orderStatus.status === 'cancelled' || orderStatus.status === 'rejected') {
        throw new Error(`Order ${orderId} was ${orderStatus.status}`);
      }
      await this.delay(500);
    }
    
    throw new Error(`Order ${orderId} timed out`);
  }

  /**
   * Estimate slippage for an order
   */
  private async estimateSlippage(order: OrderRequest): Promise<number> {
    try {
      const price = this.client.getLastPrice(order.coin);
      return price ? 0.05 : 0.1;
    } catch {
      return 0.1;
    }
  }

  /**
   * Calculate actual slippage
   */
  private calculateSlippage(expectedPrice: number, executedPrice: number): number {
    return Math.abs((executedPrice - expectedPrice) / expectedPrice) * 100;
  }

  /**
   * Execute paper trade (simulation)
   */
  private async executePaperTrade(signal: Signal): Promise<ExecutionResult> {
    // Simulate execution with random fill
    await this.delay(100); // Simulate latency
    
    const simulatedPrice = signal.expectedValue * (1 + (Math.random() - 0.5) * 0.002); // ±0.1% price variation
    const simulatedSlippage = Math.random() * 0.2; // 0-0.2% slippage
    
    return {
      signalId: signal.id,
      orderId: `PAPER_${Date.now()}`,
      status: 'success',
      executedSize: 100, // Simulated size
      executedPrice: simulatedPrice,
      slippage: simulatedSlippage,
      pnl: (Math.random() - 0.4) * 10, // Random P&L for testing
      timestamp: Date.now()
    };
  }

  /**
   * Validate signal before execution
   */
  private validateSignal(signal: Signal): boolean {
    // Check signal age
    const age = Date.now() - signal.timestamp;
    if (age > 60000) { // 1 minute
      this.logger.warn(`Signal ${signal.id} too old: ${age}ms`);
      return false;
    }
    
    // Check signal has required fields
    if (!signal.opportunity || !signal.expectedValue) {
      this.logger.warn(`Signal ${signal.id} missing required fields`);
      return false;
    }
    
    return true;
  }

  /**
   * Load current positions from exchange
   */
  private async loadPositions(): Promise<void> {
    try {
      const accountState = await this.client.getAccountState();
      accountState.assetPositions.forEach(assetPos => {
        const position = assetPos.position;
        if (position) {
          this.positions.set(position.coin, {
            coin: position.coin,
            szi: parseFloat(position.szi),
            entryPx: parseFloat(position.entryPx),
            positionValue: parseFloat(position.positionValue),
            unrealizedPnl: parseFloat(position.unrealizedPnl),
            returnOnEquity: parseFloat(position.returnOnEquity),
            funding: parseFloat(position.funding)
          });
        }
      });
    } catch (error) {
      this.logger.error('Failed to load positions', { 
        error: error instanceof Error ? error.message : 'Unknown error' 
      });
    }
  }

  /**
   * Cancel all pending orders
   */
  private async cancelAllPendingOrders(): Promise<void> {
    try {
      const orders = await this.client.getOpenOrders();
      for (const order of orders) {
        if (order.cloid) {
          await this.client.cancelOrder(order.coin, parseInt(order.cloid));
        }
      }
    } catch (error) {
      this.logger.error('Failed to cancel orders', { 
        error: error instanceof Error ? error.message : 'Unknown error' 
      });
    }
  }

  /**
   * Setup event handlers
   */
  private setupEventHandlers(): void {
    // Handle order updates from client
    this.client.on('orderUpdate', (order) => {
      if (this.activeOrders.has(order.orderId)) {
        this.activeOrders.set(order.orderId, {
          orderId: order.orderId,
          status: order.status,
          symbol: order.symbol,
          size: order.size,
          timestamp: Date.now()
        });
        this.emit('orderUpdate', order);
      }
    });
    
    // Handle position updates
    this.client.on('positionUpdate', (position) => {
      this.positions.set(position.symbol, position);
      this.emit('positionUpdate', position);
    });
  }

  /**
   * Utility delay function
   */
  private delay(ms: number): Promise<void> {
    return new Promise(resolve => setTimeout(resolve, ms));
  }

  /**
   * Get execution statistics
   */
  getStats(): ExecutionStats {
    return { ...this.stats };
  }

  /**
   * Get current positions
   */
  getPositions(): Map<string, HlPosition> {
    return new Map(this.positions);
  }

  /**
   * Emergency stop
   */
  emergencyStop(): void {
    this.logger.error('EMERGENCY STOP ACTIVATED');
    this.config.emergencyStop = true;
    this.stop();
  }
}

export default ExecutionEngine;
