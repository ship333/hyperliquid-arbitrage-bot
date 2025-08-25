/**
 * GoldRush API client for market data
 */

import axios, { AxiosInstance } from 'axios';
import WebSocket from 'ws';
import { EventEmitter } from 'events';
import { DexQuote, OrderBook } from '../types/market.js';
import { env } from '../config/env.js';

interface GoldRushQuoteResponse {
  pair: string;
  dex: string;
  price: number;
  depth_usd: number;
  fee_bps: number;
  timestamp: number;
}

interface GoldRushReferenceData {
  ref_price_usd?: number;
  volatility_24h?: number;
  volatility_7d?: number;
  funding_rate?: number;
  volume_24h?: number;
}

export class GoldRushClient extends EventEmitter {
  private httpClient: AxiosInstance;
  private ws: WebSocket | null = null;
  private wsLatencyMs: number = 0;
  private cache = new Map<string, { data: any; timestamp: number }>();
  private readonly CACHE_TTL_MS = 300; // 300ms cache for quotes
  private reconnectAttempts = 0;
  private maxReconnectAttempts = 5;
  private reconnectDelay = 1000;

  constructor() {
    super();
    
    this.httpClient = axios.create({
      baseURL: env.GOLDRUSH_HTTP_URL,
      headers: {
        'X-API-Key': env.GOLDRUSH_API_KEY,
        'Content-Type': 'application/json',
      },
      timeout: 5000,
    });

    // Add retry interceptor
    this.httpClient.interceptors.response.use(
      response => response,
      async error => {
        const { config, response } = error;
        
        if (!config || !config.retry) {
          config.retry = 0;
        }
        
        if (config.retry < 3 && (!response || response.status >= 500)) {
          config.retry += 1;
          const delay = Math.pow(2, config.retry) * 1000;
          await new Promise(resolve => setTimeout(resolve, delay));
          return this.httpClient(config);
        }
        
        return Promise.reject(error);
      }
    );
  }

  /**
   * Get quotes for a trading pair
   */
  async getQuotes(pair: string): Promise<DexQuote[]> {
    const cacheKey = `quotes:${pair}`;
    const cached = this.getFromCache(cacheKey);
    
    if (cached) {
      return cached;
    }

    try {
      const response = await this.httpClient.get<GoldRushQuoteResponse[]>(`/quotes/${pair}`);
      
      const quotes: DexQuote[] = response.data.map(q => ({
        pair: q.pair,
        dex: this.normalizeDexName(q.dex),
        price: q.price,
        depthUsd: q.depth_usd,
        feeBps: q.fee_bps,
        ts: q.timestamp,
      }));

      this.setCache(cacheKey, quotes);
      return quotes;
    } catch (error) {
      console.error(`Failed to fetch quotes for ${pair}:`, error);
      throw error;
    }
  }

  /**
   * Get reference data (oracle price, volatility, funding)
   */
  async getReferenceData(pair: string): Promise<GoldRushReferenceData> {
    const cacheKey = `ref:${pair}`;
    const cached = this.getFromCache(cacheKey);
    
    if (cached) {
      return cached;
    }

    try {
      const response = await this.httpClient.get<GoldRushReferenceData>(`/reference/${pair}`);
      const data = response.data;
      
      this.setCache(cacheKey, data);
      return data;
    } catch (error) {
      console.error(`Failed to fetch reference data for ${pair}:`, error);
      // Return empty object on failure (non-critical data)
      return {};
    }
  }

  /**
   * Get order book for a pair
   */
  async getOrderBook(pair: string, depth: number = 20): Promise<OrderBook> {
    try {
      const response = await this.httpClient.get(`/orderbook/${pair}`, {
        params: { depth }
      });
      
      return {
        bids: response.data.bids,
        asks: response.data.asks,
        timestamp: Date.now(),
        source: 'GoldRush',
      };
    } catch (error) {
      console.error(`Failed to fetch order book for ${pair}:`, error);
      throw error;
    }
  }

  /**
   * Connect to WebSocket for real-time data
   */
  connectWebSocket(): void {
    if (this.ws?.readyState === WebSocket.OPEN) {
      return;
    }

    try {
      this.ws = new WebSocket(env.GOLDRUSH_WS_URL, {
        headers: {
          'X-API-Key': env.GOLDRUSH_API_KEY,
        },
      });

      this.ws.on('open', () => {
        console.log('GoldRush WebSocket connected');
        this.reconnectAttempts = 0;
        this.emit('connected');
        
        // Start latency monitoring
        this.startLatencyMonitoring();
      });

      this.ws.on('message', (data: Buffer) => {
        try {
          const message = JSON.parse(data.toString());
          this.handleWebSocketMessage(message);
        } catch (error) {
          console.error('Failed to parse WebSocket message:', error);
        }
      });

      this.ws.on('error', (error) => {
        console.error('GoldRush WebSocket error:', error);
        this.emit('error', error);
      });

      this.ws.on('close', () => {
        console.log('GoldRush WebSocket disconnected');
        this.emit('disconnected');
        this.attemptReconnect();
      });
    } catch (error) {
      console.error('Failed to connect WebSocket:', error);
      this.attemptReconnect();
    }
  }

  /**
   * Disconnect WebSocket
   */
  disconnectWebSocket(): void {
    if (this.ws) {
      this.ws.close();
      this.ws = null;
    }
  }

  /**
   * Subscribe to trading pair updates
   */
  subscribeToPair(pair: string): void {
    if (this.ws?.readyState === WebSocket.OPEN) {
      this.ws.send(JSON.stringify({
        type: 'subscribe',
        channel: 'quotes',
        pair,
      }));
    }
  }

  /**
   * Get current WebSocket latency
   */
  getWsLatency(): number {
    return this.wsLatencyMs;
  }

  // Private methods

  private handleWebSocketMessage(message: any): void {
    switch (message.type) {
      case 'quote':
        this.emit('quote', message.data);
        break;
      case 'trade':
        this.emit('trade', message.data);
        break;
      case 'block':
        this.emit('block', message.data);
        break;
      case 'pong':
        this.wsLatencyMs = Date.now() - message.timestamp;
        break;
    }
  }

  private startLatencyMonitoring(): void {
    setInterval(() => {
      if (this.ws?.readyState === WebSocket.OPEN) {
        this.ws.send(JSON.stringify({
          type: 'ping',
          timestamp: Date.now(),
        }));
      }
    }, 5000);
  }

  private attemptReconnect(): void {
    if (this.reconnectAttempts >= this.maxReconnectAttempts) {
      console.error('Max reconnection attempts reached');
      return;
    }

    this.reconnectAttempts++;
    const delay = this.reconnectDelay * Math.pow(2, this.reconnectAttempts - 1);
    
    console.log(`Attempting reconnect in ${delay}ms (attempt ${this.reconnectAttempts})`);
    setTimeout(() => this.connectWebSocket(), delay);
  }

  private normalizeDexName(dex: string): "PRJX" | "HyperSwap" | "Other" {
    const normalized = dex.toUpperCase();
    if (normalized === 'PRJX') return 'PRJX';
    if (normalized === 'HYPERSWAP') return 'HyperSwap';
    return 'Other';
  }

  private getFromCache(key: string): any | null {
    const cached = this.cache.get(key);
    if (!cached) return null;
    
    const age = Date.now() - cached.timestamp;
    if (age > this.CACHE_TTL_MS) {
      this.cache.delete(key);
      return null;
    }
    
    return cached.data;
  }

  private setCache(key: string, data: any): void {
    this.cache.set(key, {
      data,
      timestamp: Date.now(),
    });
  }
}

// Export singleton instance
export const goldRushClient = new GoldRushClient();
