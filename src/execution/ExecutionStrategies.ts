/**
 * Execution Strategies for Different Trading Scenarios
 * TWAP, Iceberg, Immediate, and Smart Order Routing
 */

import { EventEmitter } from 'events';
import HyperliquidClient from '../connectors/hyperliquid/HyperliquidClient';
import { OrderBuilder, BuiltOrder } from '../connectors/hyperliquid/OrderBuilder';
import { Signal, ExecutableOpportunity } from './types';

export type StrategyType = 'immediate' | 'twap' | 'iceberg' | 'adaptive';

export interface StrategyConfig {
  type: StrategyType;
  urgency: 'low' | 'medium' | 'high';
  maxSlippage: number;
  timeLimit: number;  // milliseconds
  splitCount?: number;  // For TWAP/Iceberg
  showSize?: number;  // For Iceberg
  adaptiveThreshold?: number;  // For adaptive strategy
}

export interface ExecutionPlan {
  strategyType: StrategyType;
  orders: BuiltOrder[];
  timeline: number[];  // Timestamps for each order
  estimatedCost: number;
  estimatedSlippage: number;
  riskScore: number;
}

export interface StrategyResult {
  success: boolean;
  executedOrders: string[];  // Order IDs
  totalFilled: number;
  avgPrice: number;
  totalSlippage: number;
  executionTime: number;
  error?: string;
}

export class ExecutionStrategies extends EventEmitter {
  private orderBuilder: OrderBuilder;
  private activeStrategies = new Map<string, any>();
  
  constructor(
    private client: HyperliquidClient,
    private config: {
      minOrderSize: number;
      maxOrderSize: number;
      maxSlippagePercent: number;
      defaultLeverage: number;
    }
  ) {
    super();
    this.orderBuilder = new OrderBuilder({
      minOrderSize: config.minOrderSize,
      maxOrderSize: config.maxOrderSize,
      maxSlippagePercent: config.maxSlippagePercent,
      defaultLeverage: config.defaultLeverage,
      reduceOnly: false,
      postOnly: false,
      ioc: false
    });
  }
  
  /**
   * Convert BuiltOrder to Order format for HyperliquidClient
   */
  private convertToOrder(builtOrder: BuiltOrder): any {
    return {
      coin: builtOrder.coin,
      is_buy: builtOrder.is_buy,
      sz: builtOrder.sz,
      limit_px: builtOrder.limit_px,
      order_type: builtOrder.order_type,
      reduce_only: builtOrder.reduce_only,
      post_only: builtOrder.post_only,
      ioc: builtOrder.ioc,
      cloid: builtOrder.cloid
    };
  }
  
  /**
   * Select optimal strategy based on signal characteristics
   */
  selectStrategy(signal: Signal): StrategyConfig {
    const opportunity = signal.opportunity;
    
    // High urgency + high confidence = Immediate execution
    if (signal.priority > 0.8 && signal.confidenceScore > 0.8) {
      return {
        type: 'immediate',
        urgency: 'high',
        maxSlippage: 0.5,
        timeLimit: 5000
      };
    }
    
    // Large size = TWAP to minimize market impact
    if (signal.executionSize > 10000) {
      return {
        type: 'twap',
        urgency: 'medium',
        maxSlippage: 0.3,
        timeLimit: 60000,
        splitCount: Math.ceil(signal.executionSize / 2000)
      };
    }
    
    // Medium size with low urgency = Iceberg
    if (signal.executionSize > 1000 && signal.priority < 0.5) {
      return {
        type: 'iceberg',
        urgency: 'low',
        maxSlippage: 0.2,
        timeLimit: 120000,
        splitCount: 5,
        showSize: signal.executionSize * 0.2
      };
    }
    
    // Default to adaptive strategy
    return {
      type: 'adaptive',
      urgency: 'medium',
      maxSlippage: 0.3,
      timeLimit: 30000,
      adaptiveThreshold: 0.1
    };
  }
  
  /**
   * Create execution plan based on strategy
   */
  createExecutionPlan(
    signal: Signal,
    strategy: StrategyConfig
  ): ExecutionPlan {
    const opportunity = signal.opportunity;
    
    switch (strategy.type) {
      case 'immediate':
        return this.planImmediateExecution(opportunity, signal.executionSize);
        
      case 'twap':
        return this.planTWAPExecution(
          opportunity, 
          signal.executionSize,
          strategy.splitCount || 5,
          strategy.timeLimit
        );
        
      case 'iceberg':
        return this.planIcebergExecution(
          opportunity,
          signal.executionSize,
          strategy.showSize || signal.executionSize * 0.2,
          strategy.splitCount || 5
        );
        
      case 'adaptive':
        return this.planAdaptiveExecution(
          opportunity,
          signal.executionSize,
          strategy.adaptiveThreshold || 0.1
        );
        
      default:
        // Fallback to immediate
        return this.planImmediateExecution(opportunity, signal.executionSize);
    }
  }
  
  /**
   * Execute strategy
   */
  async executeStrategy(
    signal: Signal,
    strategy: StrategyConfig
  ): Promise<StrategyResult> {
    const startTime = Date.now();
    const plan = this.createExecutionPlan(signal, strategy);
    
    this.emit('strategyStart', {
      signalId: signal.id,
      strategy: strategy.type,
      orderCount: plan.orders.length
    });
    
    try {
      switch (strategy.type) {
        case 'immediate':
          return await this.executeImmediate(plan, strategy);
          
        case 'twap':
          return await this.executeTWAP(plan, strategy);
          
        case 'iceberg':
          return await this.executeIceberg(plan, strategy);
          
        case 'adaptive':
          return await this.executeAdaptive(plan, strategy, signal);
          
        default:
          throw new Error(`Unknown strategy type: ${strategy.type}`);
      }
    } catch (error: any) {
      this.emit('strategyError', {
        signalId: signal.id,
        error: error.message
      });
      
      return {
        success: false,
        executedOrders: [],
        totalFilled: 0,
        avgPrice: 0,
        totalSlippage: 0,
        executionTime: Date.now() - startTime,
        error: error.message
      };
    }
  }
  
  /**
   * Plan immediate execution (single order)
   */
  private planImmediateExecution(
    opportunity: ExecutableOpportunity,
    size: number
  ): ExecutionPlan {
    // Determine side based on expected profit
    const side = opportunity.expectedProfit > 0 ? 'buy' : 'sell';
    const order = this.orderBuilder.buildFromOpportunity(
      opportunity,
      side,
      size
    );
    
    if (!order) {
      throw new Error('Failed to build order');
    }
    
    return {
      strategyType: 'immediate',
      orders: [order],
      timeline: [Date.now()],
      estimatedCost: size * order.expected_fill_price,
      estimatedSlippage: order.slippage_points / 100,
      riskScore: 0.3
    };
  }
  
  /**
   * Plan TWAP execution (Time-Weighted Average Price)
   */
  private planTWAPExecution(
    opportunity: ExecutableOpportunity,
    totalSize: number,
    splitCount: number,
    timeLimit: number
  ): ExecutionPlan {
    const orders: BuiltOrder[] = [];
    const timeline: number[] = [];
    const sliceSize = totalSize / splitCount;
    const interval = timeLimit / splitCount;
    
    for (let i = 0; i < splitCount; i++) {
      const side = opportunity.expectedProfit > 0 ? 'buy' : 'sell';
      const order = this.orderBuilder.buildFromOpportunity(
        opportunity,
        side,
        sliceSize
      );
      
      if (order) {
        orders.push(order);
        timeline.push(Date.now() + (i * interval));
      }
    }
    
    const avgPrice = orders.reduce((sum, o) => sum + o.expected_fill_price, 0) / orders.length;
    
    return {
      strategyType: 'twap',
      orders,
      timeline,
      estimatedCost: totalSize * avgPrice,
      estimatedSlippage: 0.2,  // Lower slippage due to splitting
      riskScore: 0.2
    };
  }
  
  /**
   * Plan Iceberg execution (hidden size)
   */
  private planIcebergExecution(
    opportunity: ExecutableOpportunity,
    totalSize: number,
    showSize: number,
    maxOrders: number
  ): ExecutionPlan {
    const orders: BuiltOrder[] = [];
    const timeline: number[] = [];
    let remainingSize = totalSize;
    let orderCount = 0;
    
    while (remainingSize > 0 && orderCount < maxOrders) {
      const orderSize = Math.min(showSize, remainingSize);
      
      const side = opportunity.expectedProfit > 0 ? 'buy' : 'sell';
      const price = opportunity.expectedPrice;
      
      const order = this.orderBuilder.buildLimitOrder(
        opportunity.pair,
        side,
        orderSize,
        price,
        true  // Post-only for better prices
      );
      
      orders.push(order);
      timeline.push(Date.now() + (orderCount * 5000));  // 5 second intervals
      
      remainingSize -= orderSize;
      orderCount++;
    }
    
    return {
      strategyType: 'iceberg',
      orders,
      timeline,
      estimatedCost: totalSize * orders[0].expected_fill_price,
      estimatedSlippage: 0.1,  // Very low slippage with limit orders
      riskScore: 0.4  // Higher risk of not filling
    };
  }
  
  /**
   * Plan Adaptive execution (responds to market conditions)
   */
  private planAdaptiveExecution(
    opportunity: ExecutableOpportunity,
    size: number,
    threshold: number
  ): ExecutionPlan {
    // Start with a passive limit order
    const side = opportunity.expectedProfit > 0 ? 'buy' : 'sell';
    const basePrice = opportunity.expectedPrice;
    const passivePrice = side === 'buy' 
      ? basePrice * (1 - threshold/100)
      : basePrice * (1 + threshold/100);
    
    const passiveOrder = this.orderBuilder.buildLimitOrder(
      opportunity.pair,
      side,
      size * 0.5,
      passivePrice,
      true
    );
    
    // Prepare aggressive backup
    const aggressiveOrder = this.orderBuilder.buildMarketOrder(
      opportunity.pair,
      side,
      size * 0.5,
      0.5
    );
    
    return {
      strategyType: 'adaptive',
      orders: [passiveOrder, aggressiveOrder],
      timeline: [Date.now(), Date.now() + 10000],  // Try passive first, then aggressive
      estimatedCost: size * opportunity.expectedPrice,
      estimatedSlippage: 0.25,
      riskScore: 0.3
    };
  }
  
  /**
   * Execute immediate strategy
   */
  private async executeImmediate(
    plan: ExecutionPlan,
    strategy: StrategyConfig
  ): Promise<StrategyResult> {
    const order = plan.orders[0];
    const result = await this.client.placeOrder(this.convertToOrder(order));
    
    if (result.status === 'new' || result.status === 'filled') {
      return {
        success: true,
        executedOrders: [order.cloid],
        totalFilled: order.sz,
        avgPrice: order.expected_fill_price,
        totalSlippage: order.slippage_points / 100,
        executionTime: Date.now() - plan.timeline[0]
      };
    }
    
    return {
      success: false,
      executedOrders: [],
      totalFilled: 0,
      avgPrice: 0,
      totalSlippage: 0,
      executionTime: Date.now() - plan.timeline[0],
      error: `Order rejected: ${result.status}`
    };
  }
  
  /**
   * Execute TWAP strategy
   */
  private async executeTWAP(
    plan: ExecutionPlan,
    strategy: StrategyConfig
  ): Promise<StrategyResult> {
    const executedOrders: string[] = [];
    let totalFilled = 0;
    let weightedPriceSum = 0;
    
    for (let i = 0; i < plan.orders.length; i++) {
      const order = plan.orders[i];
      const scheduledTime = plan.timeline[i];
      
      // Wait for scheduled time
      const delay = scheduledTime - Date.now();
      if (delay > 0) {
        await this.sleep(delay);
      }
      
      // Place order
      const result = await this.client.placeOrder(this.convertToOrder(order));
      
      if (result.status === 'new' || result.status === 'filled') {
        executedOrders.push(order.cloid);
        totalFilled += order.sz;
        weightedPriceSum += order.sz * order.expected_fill_price;
        
        this.emit('twapProgress', {
          current: i + 1,
          total: plan.orders.length,
          filled: totalFilled
        });
      }
    }
    
    const avgPrice = totalFilled > 0 ? weightedPriceSum / totalFilled : 0;
    
    return {
      success: executedOrders.length > 0,
      executedOrders,
      totalFilled,
      avgPrice,
      totalSlippage: 0.2,
      executionTime: Date.now() - plan.timeline[0]
    };
  }
  
  /**
   * Execute Iceberg strategy
   */
  private async executeIceberg(
    plan: ExecutionPlan,
    strategy: StrategyConfig
  ): Promise<StrategyResult> {
    const executedOrders: string[] = [];
    let totalFilled = 0;
    let weightedPriceSum = 0;
    
    for (const order of plan.orders) {
      const result = await this.client.placeOrder(this.convertToOrder(order));
      
      if (result.status === 'new' || result.status === 'filled') {
        executedOrders.push(order.cloid);
        
        // Monitor fill status
        await this.waitForFill(order.cloid, 10000);
        
        const fillInfo = await this.getFillInfo(order.cloid);
        if (fillInfo) {
          totalFilled += fillInfo.filled;
          weightedPriceSum += fillInfo.filled * fillInfo.avgPrice;
        }
      }
      
      // Small delay between orders
      await this.sleep(2000);
    }
    
    const avgPrice = totalFilled > 0 ? weightedPriceSum / totalFilled : 0;
    
    return {
      success: executedOrders.length > 0,
      executedOrders,
      totalFilled,
      avgPrice,
      totalSlippage: 0.1,
      executionTime: Date.now() - plan.timeline[0]
    };
  }
  
  /**
   * Execute Adaptive strategy
   */
  private async executeAdaptive(
    plan: ExecutionPlan,
    strategy: StrategyConfig,
    signal: Signal
  ): Promise<StrategyResult> {
    const passiveOrder = plan.orders[0];
    const aggressiveOrder = plan.orders[1];
    
    // Try passive first
    const passiveResult = await this.client.placeOrder(this.convertToOrder(passiveOrder));
    
    if (passiveResult.status === 'new' || passiveResult.status === 'filled') {
      // Wait for fill or timeout
      const filled = await this.waitForFill(passiveOrder.cloid, 10000);
      
      if (filled) {
        return {
          success: true,
          executedOrders: [passiveOrder.cloid],
          totalFilled: passiveOrder.sz,
          avgPrice: passiveOrder.expected_fill_price,
          totalSlippage: 0.1,
          executionTime: Date.now() - plan.timeline[0]
        };
      }
      
      // Cancel passive and go aggressive
      await this.client.cancelOrder(passiveOrder.cloid);
    }
    
    // Execute aggressive order
    const aggressiveResult = await this.client.placeOrder(this.convertToOrder(aggressiveOrder));
    
    if (aggressiveResult.status === 'new' || aggressiveResult.status === 'filled') {
      return {
        success: true,
        executedOrders: [aggressiveOrder.cloid],
        totalFilled: aggressiveOrder.sz,
        avgPrice: aggressiveOrder.expected_fill_price,
        totalSlippage: 0.5,
        executionTime: Date.now() - plan.timeline[0]
      };
    }
    
    return {
      success: false,
      executedOrders: [],
      totalFilled: 0,
      avgPrice: 0,
      totalSlippage: 0,
      executionTime: Date.now() - plan.timeline[0],
      error: 'Both passive and aggressive orders failed'
    };
  }
  
  /**
   * Wait for order fill
   */
  private async waitForFill(
    orderId: string,
    timeout: number
  ): Promise<boolean> {
    const startTime = Date.now();
    
    while (Date.now() - startTime < timeout) {
      // Check order status
      // This would need to be implemented in the client
      await this.sleep(1000);
    }
    
    return false;
  }
  
  /**
   * Get fill information
   */
  private async getFillInfo(
    orderId: string
  ): Promise<{ filled: number; avgPrice: number } | null> {
    // This would query the order status from the client
    // Placeholder implementation
    return {
      filled: 0,
      avgPrice: 0
    };
  }
  
  /**
   * Sleep utility
   */
  private sleep(ms: number): Promise<void> {
    return new Promise(resolve => setTimeout(resolve, ms));
  }
  
  /**
   * Stop all active strategies
   */
  async stopAll(): Promise<void> {
    for (const [id, strategy] of this.activeStrategies) {
      this.emit('strategyStopped', { id });
      this.activeStrategies.delete(id);
    }
  }
}

export default ExecutionStrategies;
