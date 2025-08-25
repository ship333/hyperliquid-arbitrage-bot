/**
 * Order Builder for Hyperliquid
 * Constructs and validates orders before execution
 */

import { ethers } from 'ethers';
import { ExecutableOpportunity } from '../../execution/types';

export interface OrderConfig {
  minOrderSize: number;
  maxOrderSize: number;
  maxSlippagePercent: number;
  defaultLeverage: number;
  reduceOnly: boolean;
  postOnly: boolean;
  ioc: boolean;  // Immediate or Cancel
}

export interface BuiltOrder {
  coin: string;
  is_buy: boolean;
  sz: number;
  limit_px: number;
  order_type: 'limit' | 'market';
  reduce_only: boolean;
  post_only: boolean;
  ioc: boolean;
  cloid: string;  // Client Order ID
  slippage_points: number;
  expected_fill_price: number;
  max_acceptable_price: number;
  leverage: number;
}

export class OrderBuilder {
  private orderCounter = 0;
  
  constructor(private config: OrderConfig) {}
  
  /**
   * Build order from arbitrage opportunity
   */
  buildFromOpportunity(
    opportunity: ExecutableOpportunity,
    side: 'buy' | 'sell',
    sizeOverride?: number
  ): BuiltOrder | null {
    try {
      // Extract pair info
      const coin = this.normalizeCoin(opportunity.pair);
      
      // Calculate order size
      const orderSize = this.calculateOrderSize(
        opportunity,
        sizeOverride
      );
      
      if (!this.validateOrderSize(orderSize)) {
        console.warn(`[OrderBuilder] Invalid order size: ${orderSize}`);
        return null;
      }
      
      // Calculate prices with slippage
      const prices = this.calculatePrices(
        opportunity,
        side
      );
      
      if (!prices) {
        console.warn('[OrderBuilder] Failed to calculate prices');
        return null;
      }
      
      // Generate unique client order ID
      const cloid = this.generateClientOrderId();
      
      // Build the order
      const order: BuiltOrder = {
        coin,
        is_buy: side === 'buy',
        sz: orderSize,
        limit_px: prices.limitPrice,
        order_type: opportunity.urgency === 'high' ? 'market' : 'limit',
        reduce_only: this.config.reduceOnly,
        post_only: this.config.postOnly && opportunity.urgency !== 'high',
        ioc: this.config.ioc || opportunity.urgency === 'high',
        cloid,
        slippage_points: prices.slippagePoints,
        expected_fill_price: prices.expectedPrice,
        max_acceptable_price: prices.maxAcceptablePrice,
        leverage: this.config.defaultLeverage
      };
      
      // Final validation
      if (!this.validateOrder(order)) {
        console.warn('[OrderBuilder] Order validation failed');
        return null;
      }
      
      return order;
      
    } catch (error) {
      console.error('[OrderBuilder] Failed to build order:', error);
      return null;
    }
  }
  
  /**
   * Build market order for immediate execution
   */
  buildMarketOrder(
    coin: string,
    side: 'buy' | 'sell',
    size: number,
    maxSlippage?: number
  ): BuiltOrder {
    const cloid = this.generateClientOrderId();
    const slippage = maxSlippage || this.config.maxSlippagePercent;
    
    return {
      coin: this.normalizeCoin(coin),
      is_buy: side === 'buy',
      sz: size,
      limit_px: 0,  // Market order
      order_type: 'market',
      reduce_only: false,
      post_only: false,
      ioc: true,
      cloid,
      slippage_points: slippage * 100,
      expected_fill_price: 0,  // Will be determined by market
      max_acceptable_price: 0,
      leverage: this.config.defaultLeverage
    };
  }
  
  /**
   * Build limit order with specific parameters
   */
  buildLimitOrder(
    coin: string,
    side: 'buy' | 'sell',
    size: number,
    price: number,
    postOnly: boolean = false
  ): BuiltOrder {
    const cloid = this.generateClientOrderId();
    
    return {
      coin: this.normalizeCoin(coin),
      is_buy: side === 'buy',
      sz: size,
      limit_px: this.roundPrice(price),
      order_type: 'limit',
      reduce_only: false,
      post_only: postOnly,
      ioc: false,
      cloid,
      slippage_points: 0,
      expected_fill_price: price,
      max_acceptable_price: price,
      leverage: this.config.defaultLeverage
    };
  }
  
  /**
   * Build order for closing a position
   */
  buildClosePositionOrder(
    coin: string,
    positionSize: number,
    isLong: boolean,
    aggressive: boolean = false
  ): BuiltOrder {
    const cloid = this.generateClientOrderId();
    const side = isLong ? 'sell' : 'buy';  // Opposite of position
    
    return {
      coin: this.normalizeCoin(coin),
      is_buy: side === 'buy',
      sz: Math.abs(positionSize),
      limit_px: 0,  // Market order for closing
      order_type: aggressive ? 'market' : 'limit',
      reduce_only: true,  // Important: only reduce position
      post_only: false,
      ioc: aggressive,
      cloid,
      slippage_points: this.config.maxSlippagePercent * 100,
      expected_fill_price: 0,
      max_acceptable_price: 0,
      leverage: this.config.defaultLeverage
    };
  }
  
  /**
   * Calculate order size based on opportunity and limits
   */
  private calculateOrderSize(
    opportunity: ExecutableOpportunity,
    override?: number
  ): number {
    if (override && override > 0) {
      return Math.min(override, this.config.maxOrderSize);
    }
    
    // Base size on required capital and confidence
    let size = opportunity.requiredCapital || 100;
    
    // Adjust by confidence
    size *= opportunity.confidence || 0.5;
    
    // Apply limits
    size = Math.max(this.config.minOrderSize, size);
    size = Math.min(this.config.maxOrderSize, size);
    
    // Round to reasonable precision
    return Math.round(size * 1000) / 1000;
  }
  
  /**
   * Calculate prices with slippage protection
   */
  private calculatePrices(
    opportunity: ExecutableOpportunity,
    side: 'buy' | 'sell'
  ): {
    limitPrice: number;
    expectedPrice: number;
    maxAcceptablePrice: number;
    slippagePoints: number;
  } | null {
    const basePrice = side === 'buy' 
      ? opportunity.buyPrice 
      : opportunity.sellPrice;
    
    if (!basePrice || basePrice <= 0) {
      return null;
    }
    
    // Calculate slippage
    const slippageMultiplier = side === 'buy' 
      ? (1 + this.config.maxSlippagePercent / 100)
      : (1 - this.config.maxSlippagePercent / 100);
    
    const maxAcceptablePrice = basePrice * slippageMultiplier;
    
    // For limit orders, place slightly better than market
    const limitOffset = side === 'buy' ? -0.01 : 0.01;
    const limitPrice = basePrice * (1 + limitOffset);
    
    return {
      limitPrice: this.roundPrice(limitPrice),
      expectedPrice: this.roundPrice(basePrice),
      maxAcceptablePrice: this.roundPrice(maxAcceptablePrice),
      slippagePoints: this.config.maxSlippagePercent * 100
    };
  }
  
  /**
   * Validate order size
   */
  private validateOrderSize(size: number): boolean {
    return size >= this.config.minOrderSize && 
           size <= this.config.maxOrderSize &&
           size > 0 &&
           !isNaN(size);
  }
  
  /**
   * Validate complete order
   */
  private validateOrder(order: BuiltOrder): boolean {
    // Size validation
    if (!this.validateOrderSize(order.sz)) {
      return false;
    }
    
    // Price validation for limit orders
    if (order.order_type === 'limit' && order.limit_px <= 0) {
      return false;
    }
    
    // Coin validation
    if (!order.coin || order.coin.length === 0) {
      return false;
    }
    
    // Client order ID validation
    if (!order.cloid || order.cloid.length === 0) {
      return false;
    }
    
    return true;
  }
  
  /**
   * Normalize coin symbol for Hyperliquid
   */
  private normalizeCoin(symbol: string): string {
    // Remove common suffixes and normalize
    return symbol
      .replace('-USD', '')
      .replace('/USD', '')
      .replace('USDT', '')
      .replace('USDC', '')
      .toUpperCase();
  }
  
  /**
   * Round price to appropriate precision
   */
  private roundPrice(price: number): number {
    // Round to 2 decimal places for most assets
    // TODO: Make this configurable per asset
    return Math.round(price * 100) / 100;
  }
  
  /**
   * Generate unique client order ID
   */
  private generateClientOrderId(): string {
    const timestamp = Date.now();
    const counter = this.orderCounter++;
    const random = Math.floor(Math.random() * 1000);
    return `HL_${timestamp}_${counter}_${random}`;
  }
  
  /**
   * Update configuration
   */
  updateConfig(config: Partial<OrderConfig>): void {
    Object.assign(this.config, config);
  }
  
  /**
   * Get current configuration
   */
  getConfig(): OrderConfig {
    return { ...this.config };
  }
}

export default OrderBuilder;
