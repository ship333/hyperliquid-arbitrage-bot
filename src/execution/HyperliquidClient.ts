/**
 * Hyperliquid Exchange Client
 * Handles all interactions with Hyperliquid L1 chain
 */

import WebSocket from 'ws';
import fetch from 'node-fetch';
import { EventEmitter } from 'events';
import { ethers } from 'ethers';
import { recordHttpRequest, incWsReconnect, observeOrderLatency, incOrder } from '../metrics/execution';

export interface HyperliquidConfig {
  apiUrl: string;
  wsUrl: string;
  privateKey: string;
  accountAddress: string;
  testnet?: boolean;
}

export interface OrderRequest {
  coin: string;
  is_buy: boolean;
  sz: number;
  limit_px: number;
  order_type: 'limit' | 'market';
  reduce_only?: boolean;
  post_only?: boolean;
  ioc?: boolean;
  cloid?: string;
}

export interface OrderResponse {
  status: 'ok' | 'error';
  response?: {
    type: 'order';
    data: {
      statuses: Array<{
        resting?: { oid: number };
        filled?: { totalSz: string; avgPx: string };
        error?: string;
      }>;
    };
  };
  error?: string;
}

export interface Position {
  coin: string;
  szi: number;  // signed size
  entryPx: number;
  positionValue: number;
  unrealizedPnl: number;
  returnOnEquity: number;
  funding: number;
}

export interface AccountState {
  marginSummary: {
    accountValue: number;
    totalMarginUsed: number;
    totalNtlPos: number;
    totalRawUsd: number;
    withdrawable: number;
  };
  crossMarginSummary: {
    accountValue: number;
    totalMarginUsed: number;
  };
  assetPositions: Position[];
}

export class HyperliquidClient extends EventEmitter {
  private ws: WebSocket | null = null;
  private wallet: ethers.Wallet;
  private reconnectAttempts = 0;
  private maxReconnectAttempts = 10;
  private reconnectDelay = 1000;
  private maxReconnectDelay = 30000; // 30s cap
  private orderNonce = 0;
  private activeOrders = new Map<string, OrderRequest>();
  private recentCloids = new Map<string, number>(); // cloid -> firstSeenTs
  private heartbeatInterval: NodeJS.Timeout | null = null;
  private lastPongAt = 0;
  private heartbeatMs = 15000; // send ping every 15s
  private staleThresholdMs = 45000; // consider connection stale after 45s without pong
  private latestPrices = new Map<string, number>(); // baseCoin or pair -> last price
  private subscribedTradeCoins = new Set<string>();
  
  constructor(private config: HyperliquidConfig) {
    super();
    this.wallet = new ethers.Wallet(config.privateKey);
    if (this.wallet.address.toLowerCase() !== config.accountAddress.toLowerCase()) {
      throw new Error('Private key does not match account address');
    }
  }

  /**
   * Connect to Hyperliquid WebSocket
   */
  async connect(): Promise<void> {
    return new Promise((resolve, reject) => {
      const wsUrl = this.config.wsUrl || (this.config.testnet 
        ? 'wss://api.hyperliquid-testnet.xyz/ws'
        : 'wss://api.hyperliquid.xyz/ws');

      this.ws = new WebSocket(wsUrl);

      this.ws.on('open', () => {
        console.log('[HyperliquidClient] WebSocket connected');
        this.reconnectAttempts = 0;
        this.subscribeToFeeds();
        this.startHeartbeat();
        this.emit('connected');
        resolve();
      });

      this.ws.on('message', (data: Buffer) => {
        this.handleMessage(data.toString());
      });

      this.ws.on('error', (error) => {
        console.error('[HyperliquidClient] WebSocket error:', error);
        this.emit('error', error);
      });

      this.ws.on('close', () => {
        console.log('[HyperliquidClient] WebSocket disconnected');
        this.emit('disconnected');
        this.stopHeartbeat();
        this.attemptReconnect();
      });

      // Track pong responses for heartbeat
      this.ws.on('pong', () => {
        this.lastPongAt = Date.now();
      });

      setTimeout(() => {
        if (this.ws?.readyState !== WebSocket.OPEN) {
          reject(new Error('Connection timeout'));
        }
      }, 10000);
    });
  }

  /**
   * Subscribe to necessary data feeds
   */
  private subscribeToFeeds(): void {
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN) return;

    // Subscribe to account updates
    this.ws.send(JSON.stringify({
      method: 'subscribe',
      subscription: {
        type: 'userEvents',
        user: this.config.accountAddress
      }
    }));

    // Subscribe to order updates
    this.ws.send(JSON.stringify({
      method: 'subscribe',
      subscription: {
        type: 'userFills',
        user: this.config.accountAddress
      }
    }));

    // Subscribe to trades feed for market data
    this.ws.send(JSON.stringify({
      method: 'subscribe',
      subscription: {
        type: 'trades',
        coin: 'ETH'  // TODO: Make configurable
      }
    }));
  }

  /**
   * Handle incoming WebSocket messages
   */
  private handleMessage(data: string): void {
    try {
      const message = JSON.parse(data);
      
      if (message.channel === 'userEvents') {
        this.handleUserEvent(message.data);
      } else if (message.channel === 'userFills') {
        this.handleFillEvent(message.data);
      } else if (message.channel === 'trades') {
        this.handleTradeEvent(message.data);
      }
    } catch (error) {
      console.error('[HyperliquidClient] Error parsing message:', error);
    }
  }

  /**
   * Generic JSON POST with timeout and retries
   */
  private async requestWithTimeout<T>(
    url: string,
    body: any,
    options: { timeoutMs: number; retries?: number }
  ): Promise<T> {
    const { timeoutMs, retries = 0 } = options;
    let attempt = 0;
    const startTime = Date.now();
    
    while (attempt <= retries) {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), timeoutMs);
      
      try {
        const response = await fetch(url, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(body)
        });
        
        if (!response.ok) {
          throw new Error(`HTTP ${response.status}: ${response.statusText}`);
        }
        
        return await response.json();
      } catch (error) {
        attempt++;
        if (attempt > retries) {
          throw error;
        }
        // Exponential backoff with jitter
        const base = 300 * Math.pow(2, attempt);
        const jitter = base * (0.5 + Math.random());
        const delay = Math.min(2000, jitter);
        await new Promise(res => setTimeout(res, delay));
      } finally {
        clearTimeout(timer);
      }
    }
    
    throw new Error('Request failed after retries');
  }

  /**
   * Place an order on Hyperliquid
   */
  async placeOrder(order: OrderRequest): Promise<OrderResponse> {
    const timestamp = Date.now();
    const nonce = this.orderNonce++;
    
    // Build order action
    const orderAction = {
      type: 'order',
      orders: [{
        a: order.coin.includes('PERP') ? 1 : 0,  // 1 for perps, 0 for spot
        b: order.is_buy,
        p: order.limit_px.toString(),
        s: order.sz.toString(),
        r: order.reduce_only || false,
        t: order.order_type === 'market' ? 
          { market: {} } : 
          { limit: { tif: order.ioc ? 'Ioc' : order.post_only ? 'Alo' : 'Gtc' } },
        c: order.cloid
      }],
      grouping: 'na'
    };

    // Sign the order
    const signature = await this.signL1Action(orderAction, nonce, timestamp);

    // Submit order via REST API with timeout/retries
    const apiUrl = this.config.apiUrl || (this.config.testnet
      ? 'https://api.hyperliquid-testnet.xyz/exchange'
      : 'https://api.hyperliquid.xyz/exchange');

    // Ensure we're subscribed to trades for this coin for live pricing
    this.ensureSubscribedTrade(order.coin);

    // Idempotency: dedupe by cloid within a time window
    if (order.cloid) {
      const now = Date.now();
      this.purgeOldCloids(now);
      const seenAt = this.recentCloids.get(order.cloid);
      if (seenAt && now - seenAt < 5 * 60 * 1000) {
        console.warn('[HyperliquidClient] Duplicate cloid detected, skipping resend', { cloid: order.cloid });
        try { incOrder('rejected', 'n/a', 'duplicate_cloid'); } catch {}
        return {
          status: 'ok',
          response: {
            type: 'order',
            data: { statuses: [{ resting: { oid: 0 } }] }
          }
        };
      }
      this.recentCloids.set(order.cloid, now);
    }

    const orderStart = Date.now();
    const result = await this.requestWithTimeout<OrderResponse>(
      apiUrl,
      {
        action: orderAction,
        nonce,
        signature,
        vaultAddress: null,
      },
      { timeoutMs: 10000, retries: 2 }
    );
    try { observeOrderLatency(Date.now() - orderStart); } catch {}

    if (result.status === 'ok' && order.cloid) {
      this.activeOrders.set(order.cloid, order);
      this.emit('orderPlaced', { order, response: result });
    } else if (result.status === 'error') {
      this.emit('orderError', { order, error: result.error });
    }

    return result;
  }

  /**
   * Get account state including positions and balances
   */
  async getAccountState(): Promise<AccountState> {
    const response = await this.requestWithTimeout<AccountState>(
      this.config.testnet
        ? 'https://api.hyperliquid-testnet.xyz/info'
        : 'https://api.hyperliquid.xyz/info',
      {
        type: 'accountState',
        user: this.wallet.address.toLowerCase()
      },
      { timeoutMs: 8000, retries: 2 }
    );
    return response;
  }

  /**
   * Get open orders
   */
  async getOpenOrders(): Promise<any[]> {
    const apiUrl = this.config.apiUrl || (this.config.testnet
      ? 'https://api.hyperliquid-testnet.xyz/info'
      : 'https://api.hyperliquid.xyz/info');

    return this.requestWithTimeout<any[]>(
      apiUrl,
      {
        type: 'openOrders',
        user: this.config.accountAddress,
      },
      { timeoutMs: 8000, retries: 2 }
    );
  }

  /**
   * Sign L1 action for Hyperliquid
   */
  private async signL1Action(action: any, nonce: number, timestamp: number): Promise<string> {
    const payload = {
      action,
      nonce,
      vaultAddress: null,
      timestamp
    };

    const message = JSON.stringify(payload);
    const messageHash = ethers.utils.keccak256(ethers.utils.toUtf8Bytes(message));
    const signature = await this.wallet.signMessage(ethers.utils.arrayify(messageHash));
    
    return signature;
  }

  /**
   * Handle user events (position updates, etc)
   */
  private handleUserEvent(data: any): void {
    this.emit('userUpdate', data);
  }

  /**
   * Handle fill events
   */
  private handleFillEvent(data: any): void {
    this.emit('fill', data);
    
    // Update active orders
    if (data.cloid && this.activeOrders.has(data.cloid)) {
      const order = this.activeOrders.get(data.cloid);
      if (data.filled >= order!.sz) {
        this.activeOrders.delete(data.cloid);
      }
    }
  }

  /**
   * Handle trade events for market data
   */
  private handleTradeEvent(data: any): void {
    try {
      let coin: string | undefined;
      let price: number | undefined;
      if (Array.isArray(data) && data.length > 0) {
        const last = data[data.length - 1];
        coin = (last && (last.coin ?? last.c ?? last.symbol)) as string | undefined;
        const raw = last?.px ?? last?.price ?? last?.p ?? (Array.isArray(last) ? last[1] : undefined);
        price = raw !== undefined ? Number(raw) : undefined;
      } else if (data && typeof data === 'object') {
        coin = (data.coin ?? data.c ?? data.symbol) as string | undefined;
        const raw = data.px ?? data.price ?? data.p;
        price = raw !== undefined ? Number(raw) : undefined;
      }
      if (coin && typeof price === 'number' && !Number.isNaN(price)) {
        // Normalize coin key (e.g., strip -PERP to also key base)
        this.latestPrices.set(coin, price);
        const base = coin.replace('-PERP', '');
        this.latestPrices.set(base, price);
      }
    } catch (e) {
      console.warn('[HyperliquidClient] trade event parse error', e);
    }
    this.emit('trade', data);
  }

  /**
   * Attempt to reconnect on disconnect
   */
  private attemptReconnect(): void {
    if (this.reconnectAttempts >= this.maxReconnectAttempts) {
      console.error('[HyperliquidClient] Max reconnection attempts reached');
      this.emit('maxReconnectAttemptsReached');
      return;
    }

    this.reconnectAttempts++;
    try { incWsReconnect(); } catch {}
    const base = this.reconnectDelay * Math.pow(2, this.reconnectAttempts - 1);
    const jitter = base * (0.5 + Math.random()); // 0.5x - 1.5x
    const delay = Math.min(this.maxReconnectDelay, jitter);

    console.log(`[HyperliquidClient] Reconnecting in ${Math.round(delay)}ms (attempt ${this.reconnectAttempts})`);

    setTimeout(() => {
      this.connect().catch(error => {
        console.error('[HyperliquidClient] Reconnection failed:', error);
      });
    }, delay);
  }

  /**
   * Disconnect and cleanup
   */
  disconnect(): void {
    if (this.ws) {
      this.ws.close();
      this.ws = null;
    }
    this.stopHeartbeat();
    this.activeOrders.clear();
  }

  private startHeartbeat(): void {
    this.lastPongAt = Date.now();
    if (!this.ws) return;
    if (this.heartbeatInterval) clearInterval(this.heartbeatInterval);
    this.heartbeatInterval = setInterval(() => {
      try {
        if (!this.ws || this.ws.readyState !== WebSocket.OPEN) return;
        // If connection is stale, close to trigger reconnect
        if (Date.now() - this.lastPongAt > this.staleThresholdMs) {
          console.warn('[HyperliquidClient] WS heartbeat stale, reconnecting...');
          this.ws.close();
          return;
        }
        this.ws.ping();
      } catch (e) {
        console.warn('[HyperliquidClient] Heartbeat error', e);
      }
    }, this.heartbeatMs);
  }

  private stopHeartbeat(): void {
    if (this.heartbeatInterval) {
      clearInterval(this.heartbeatInterval);
      this.heartbeatInterval = null;
    }
  }

  getLastPrice(symbol: string): number | undefined {
    if (!symbol) return undefined;
    // Try exact match (e.g., 'ETH-PERP') then base coin fallback ('ETH')
    if (this.latestPrices.has(symbol)) return this.latestPrices.get(symbol);
    const base = symbol.replace('-PERP', '');
    return this.latestPrices.get(base);
  }

  private purgeOldCloids(now: number): void {
    const ttl = 10 * 60 * 1000; // 10 minutes
    for (const [cloid, seenAt] of this.recentCloids) {
      if (now - seenAt > ttl) this.recentCloids.delete(cloid);
    }
  }

  private ensureSubscribedTrade(symbol: string): void {
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN) return;
    const base = symbol.replace('-PERP', '');
    if (this.subscribedTradeCoins.has(base)) return;
    try {
      this.ws.send(JSON.stringify({
        method: 'subscribe',
        subscription: { type: 'trades', coin: base }
      }));
      this.subscribedTradeCoins.add(base);
    } catch (e) {
      console.warn('[HyperliquidClient] subscribe trades failed', e);
    }
  }

  /**
   * Cancel an order
   */
  async cancelOrder(coin: string, orderId: number): Promise<any> {
    const timestamp = Date.now();
    const nonce = this.orderNonce++;

    const cancelAction = {
      type: 'cancel',
      cancels: [{
        a: coin.includes('PERP') ? 1 : 0,
        o: orderId
      }]
    };

    const signature = await this.signL1Action(cancelAction, nonce, timestamp);

    const apiUrl = this.config.apiUrl || (this.config.testnet
      ? 'https://api.hyperliquid-testnet.xyz/exchange'
      : 'https://api.hyperliquid.xyz/exchange');

    return this.requestWithTimeout<any>(
      apiUrl,
      {
        action: cancelAction,
        nonce,
        signature,
        vaultAddress: null,
      },
      { timeoutMs: 8000, retries: 2 }
    );
  }
}

export default HyperliquidClient;
