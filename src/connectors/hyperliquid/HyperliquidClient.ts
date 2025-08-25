/**
 * Hyperliquid Exchange Client
 * Handles all interactions with Hyperliquid API
 * Priority: IMMEDIATE - 0% complete, blocking all trades
 */

import axios, { AxiosInstance } from 'axios';
import { ethers } from 'ethers';
import WebSocket from 'ws';
import { EventEmitter } from 'events';

// Types
export interface HyperliquidConfig {
  apiUrl: string;
  wsUrl: string;
  privateKey: string;
  testnet: boolean;
  maxRetries?: number;
  requestTimeout?: number;
}

export interface Order {
  symbol: string;
  side: 'buy' | 'sell';
  orderType: 'market' | 'limit' | 'stop';
  size: number;
  price?: number;
  reduceOnly?: boolean;
  postOnly?: boolean;
  clientOrderId?: string;
}

export interface OrderResponse {
  orderId: string;
  clientOrderId: string;
  status: 'new' | 'filled' | 'partial' | 'cancelled' | 'rejected';
  filledSize: number;
  avgFillPrice: number;
  timestamp: number;
}

export interface Position {
  symbol: string;
  size: number;
  side: 'long' | 'short';
  entryPrice: number;
  markPrice: number;
  unrealizedPnl: number;
  marginUsed: number;
}

export interface Balance {
  asset: string;
  free: number;
  locked: number;
  total: number;
}

export class HyperliquidClient extends EventEmitter {
  private config: HyperliquidConfig;
  private httpClient: AxiosInstance;
  private ws: WebSocket | null = null;
  private wallet: ethers.Wallet;
  private isConnected: boolean = false;
  private reconnectTimer: NodeJS.Timeout | null = null;

  constructor(config: HyperliquidConfig) {
    super();
    this.config = config;
    
    // Initialize wallet for signing
    this.wallet = new ethers.Wallet(config.privateKey);
    
    // Setup HTTP client
    this.httpClient = axios.create({
      baseURL: config.apiUrl,
      timeout: config.requestTimeout || 10000,
      headers: {
        'Content-Type': 'application/json'
      }
    });
  }

  /**
   * Connect to Hyperliquid WebSocket for real-time data
   */
  async connect(): Promise<void> {
    return new Promise((resolve, reject) => {
      try {
        this.ws = new WebSocket(this.config.wsUrl);
        
        this.ws.on('open', () => {
          console.log('[Hyperliquid] WebSocket connected');
          this.isConnected = true;
          this.emit('connected');
          
          // Subscribe to required channels
          this.subscribeToChannels();
          resolve();
        });

        this.ws.on('message', (data: Buffer) => {
          this.handleWebSocketMessage(data);
        });

        this.ws.on('error', (error) => {
          console.error('[Hyperliquid] WebSocket error:', error);
          this.emit('error', error);
        });

        this.ws.on('close', () => {
          console.log('[Hyperliquid] WebSocket disconnected');
          this.isConnected = false;
          this.emit('disconnected');
          this.scheduleReconnect();
        });
      } catch (error) {
        reject(error);
      }
    });
  }

  /**
   * Place an order on Hyperliquid
   * CRITICAL: This is the most important method - enables trading
   */
  async placeOrder(order: Order): Promise<OrderResponse> {
    try {
      // Build order request
      const orderRequest = await this.buildOrderRequest(order);
      
      // Sign the order
      const signature = await this.signOrder(orderRequest);
      
      // Submit order to exchange
      const response = await this.httpClient.post('/order', {
        ...orderRequest,
        signature
      });
      
      const result: OrderResponse = {
        orderId: response.data.orderId,
        clientOrderId: order.clientOrderId || response.data.clientOrderId,
        status: response.data.status,
        filledSize: response.data.filledSize || 0,
        avgFillPrice: response.data.avgFillPrice || 0,
        timestamp: Date.now()
      };
      
      this.emit('orderPlaced', result);
      console.log(`[Hyperliquid] Order placed: ${result.orderId}`);
      
      return result;
    } catch (error) {
      console.error('[Hyperliquid] Order placement failed:', error);
      throw error;
    }
  }

  /**
   * Cancel an order
   */
  async cancelOrder(orderId: string): Promise<boolean> {
    try {
      const response = await this.httpClient.delete(`/order/${orderId}`, {
        headers: await this.getAuthHeaders()
      });
      
      this.emit('orderCancelled', orderId);
      return response.data.success;
    } catch (error) {
      console.error(`[Hyperliquid] Failed to cancel order ${orderId}:`, error);
      throw error;
    }
  }

  /**
   * Get order status
   */
  async getOrderStatus(orderId: string): Promise<OrderResponse> {
    try {
      const response = await this.httpClient.get(`/order/${orderId}`, {
        headers: await this.getAuthHeaders()
      });
      
      return response.data;
    } catch (error) {
      console.error(`[Hyperliquid] Failed to get order status ${orderId}:`, error);
      throw error;
    }
  }

  /**
   * Get account positions
   */
  async getPositions(): Promise<Position[]> {
    try {
      const response = await this.httpClient.get('/positions', {
        headers: await this.getAuthHeaders()
      });
      
      return response.data.positions;
    } catch (error) {
      console.error('[Hyperliquid] Failed to get positions:', error);
      throw error;
    }
  }

  /**
   * Get account balances
   */
  async getBalances(): Promise<Balance[]> {
    try {
      const response = await this.httpClient.get('/balances', {
        headers: await this.getAuthHeaders()
      });
      
      return response.data.balances;
    } catch (error) {
      console.error('[Hyperliquid] Failed to get balances:', error);
      throw error;
    }
  }

  /**
   * Get market data for a symbol
   */
  async getMarketData(symbol: string): Promise<any> {
    try {
      const response = await this.httpClient.get(`/market/${symbol}`);
      return response.data;
    } catch (error) {
      console.error(`[Hyperliquid] Failed to get market data for ${symbol}:`, error);
      throw error;
    }
  }

  /**
   * Build order request with proper formatting
   */
  private async buildOrderRequest(order: Order): Promise<any> {
    // TODO: Implement Hyperliquid-specific order format
    // This will need to match their exact API specification
    return {
      symbol: order.symbol,
      side: order.side,
      type: order.orderType,
      size: order.size.toString(),
      price: order.price?.toString(),
      reduceOnly: order.reduceOnly || false,
      postOnly: order.postOnly || false,
      clientOrderId: order.clientOrderId || this.generateClientOrderId(),
      timestamp: Date.now()
    };
  }

  /**
   * Sign order for authentication
   */
  private async signOrder(orderRequest: any): Promise<string> {
    // TODO: Implement EIP-712 signing for Hyperliquid
    // This needs to match their signing specification exactly
    const message = JSON.stringify(orderRequest);
    const signature = await this.wallet.signMessage(message);
    return signature;
  }

  /**
   * Get authentication headers
   */
  private async getAuthHeaders(): Promise<any> {
    const timestamp = Date.now();
    const message = `${timestamp}`;
    const signature = await this.wallet.signMessage(message);
    
    return {
      'X-Wallet': this.wallet.address,
      'X-Timestamp': timestamp,
      'X-Signature': signature
    };
  }

  /**
   * Subscribe to WebSocket channels
   */
  private subscribeToChannels(): void {
    if (!this.ws || !this.isConnected) return;
    
    // Subscribe to order updates
    this.ws.send(JSON.stringify({
      type: 'subscribe',
      channel: 'orders',
      wallet: this.wallet.address
    }));
    
    // Subscribe to position updates
    this.ws.send(JSON.stringify({
      type: 'subscribe',
      channel: 'positions',
      wallet: this.wallet.address
    }));
    
    // Subscribe to balance updates
    this.ws.send(JSON.stringify({
      type: 'subscribe',
      channel: 'balances',
      wallet: this.wallet.address
    }));
  }

  /**
   * Handle incoming WebSocket messages
   */
  private handleWebSocketMessage(data: Buffer): void {
    try {
      const message = JSON.parse(data.toString());
      
      switch (message.type) {
        case 'order':
          this.emit('orderUpdate', message.data);
          break;
        case 'position':
          this.emit('positionUpdate', message.data);
          break;
        case 'balance':
          this.emit('balanceUpdate', message.data);
          break;
        case 'trade':
          this.emit('trade', message.data);
          break;
        case 'error':
          this.emit('error', new Error(message.message));
          break;
        default:
          // Handle other message types
          break;
      }
    } catch (error) {
      console.error('[Hyperliquid] Failed to parse WebSocket message:', error);
    }
  }

  /**
   * Schedule reconnection after disconnect
   */
  private scheduleReconnect(): void {
    if (this.reconnectTimer) return;
    
    this.reconnectTimer = setTimeout(() => {
      console.log('[Hyperliquid] Attempting to reconnect...');
      this.connect().catch(console.error);
      this.reconnectTimer = null;
    }, 5000);
  }

  /**
   * Generate unique client order ID
   */
  private generateClientOrderId(): string {
    return `HL_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`;
  }

  /**
   * Disconnect and cleanup
   */
  async disconnect(): Promise<void> {
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
    
    if (this.ws) {
      this.ws.close();
      this.ws = null;
    }
    
    this.isConnected = false;
  }
}

// Export for use in execution engine
export default HyperliquidClient;
