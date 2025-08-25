/**
 * GoldRush API Client for Historical Data & Event Logs
 * Optimized for:
 * - Batch fetching with pagination
 * - Response caching with TTL
 * - Rate limiting compliance
 * - Decoded event logs
 */

import { EventEmitter } from 'events';
import fetch from 'node-fetch';

export interface GoldRushConfig {
  apiKey: string;
  baseUrl?: string;
  maxRequestsPerSecond?: number;
  cacheEnabled?: boolean;
  cacheTTLSeconds?: number;
}

export interface LogEvent {
  blockSignedAt: string;
  blockHeight: number;
  blockHash: string;
  txOffset: number;
  logOffset: number;
  txHash: string;
  rawLogTopics: string[];
  senderAddress: string;
  senderName?: string;
  senderContractTickerSymbol?: string;
  rawLogData: string;
  decoded?: {
    name: string;
    signature: string;
    params: Array<{
      name: string;
      type: string;
      indexed: boolean;
      decoded: boolean;
      value: string;
    }>;
  };
}

export interface TokenBalance {
  contractAddress: string;
  contractName?: string;
  contractTickerSymbol?: string;
  contractDecimals: number;
  logoUrl?: string;
  balance: string;
  balanceUsd?: number;
  quoteRate?: number;
  quote24h?: number;
}

interface CacheEntry {
  data: any;
  timestamp: number;
  ttl: number;
}

export class GoldRushClient extends EventEmitter {
  private readonly baseUrl: string;
  private readonly apiKey: string;
  private readonly maxRPS: number;
  private requestCount = 0;
  private requestWindow = Date.now();
  private cache: Map<string, CacheEntry> = new Map();
  private readonly cacheEnabled: boolean;
  private readonly cacheTTL: number;

  constructor(config: GoldRushConfig) {
    super();
    this.apiKey = config.apiKey;
    this.baseUrl = config.baseUrl || 'https://api.covalenthq.com/v1';
    this.maxRPS = config.maxRequestsPerSecond || 10;
    this.cacheEnabled = config.cacheEnabled ?? true;
    this.cacheTTL = config.cacheTTLSeconds || 60;

    // Rate limit reset
    setInterval(() => {
      if (Date.now() - this.requestWindow >= 1000) {
        this.requestCount = 0;
        this.requestWindow = Date.now();
      }
    }, 100);

    // Cache cleanup
    if (this.cacheEnabled) {
      setInterval(() => {
        const now = Date.now();
        for (const [key, entry] of this.cache.entries()) {
          if (now - entry.timestamp > entry.ttl * 1000) {
            this.cache.delete(key);
          }
        }
      }, 10000);
    }
  }

  /**
   * Rate-limited fetch with caching
   */
  private async fetchWithRateLimit(url: string, options?: any): Promise<any> {
    // Check cache first
    if (this.cacheEnabled) {
      const cached = this.cache.get(url);
      if (cached && Date.now() - cached.timestamp < cached.ttl * 1000) {
        return cached.data;
      }
    }

    // Wait for rate limit if needed
    while (this.requestCount >= this.maxRPS) {
      await new Promise(resolve => setTimeout(resolve, 10));
    }

    this.requestCount++;

    try {
      const response = await fetch(url, {
        ...options,
        headers: {
          'Authorization': `Bearer ${this.apiKey}`,
          'Content-Type': 'application/json',
          ...options?.headers
        }
      });

      if (!response.ok) {
        throw new Error(`GoldRush API error: ${response.status} ${response.statusText}`);
      }

      const data = await response.json();

      // Cache successful response
      if (this.cacheEnabled && data) {
        this.cache.set(url, {
          data,
          timestamp: Date.now(),
          ttl: this.cacheTTL
        });
      }

      return data;
    } catch (error) {
      console.error('[GoldRush] Request failed:', error);
      throw error;
    }
  }

  /**
   * Get event logs for a contract or block range
   * Ultra-efficient for monitoring specific pools
   */
  async getLogs(params: {
    chainName: string;
    contractAddress?: string;
    startingBlock?: number;
    endingBlock?: number | 'latest';
    pageNumber?: number;
    pageSize?: number;
  }): Promise<{ items: LogEvent[], hasMore: boolean }> {
    const {
      chainName,
      contractAddress,
      startingBlock,
      endingBlock = 'latest',
      pageNumber = 0,
      pageSize = 100
    } = params;

    let url = `${this.baseUrl}/${chainName}/events/logs/`;
    
    const queryParams = new URLSearchParams();
    if (contractAddress) queryParams.append('address', contractAddress);
    if (startingBlock) queryParams.append('starting-block', startingBlock.toString());
    if (endingBlock) queryParams.append('ending-block', endingBlock.toString());
    queryParams.append('page-number', pageNumber.toString());
    queryParams.append('page-size', pageSize.toString());

    url += '?' + queryParams.toString();

    const response = await this.fetchWithRateLimit(url);
    
    return {
      items: response.data?.items || [],
      hasMore: response.data?.pagination?.has_more || false
    };
  }

  /**
   * Get token balances for a wallet
   * Useful for inventory management
   */
  async getTokenBalances(params: {
    chainName: string;
    walletAddress: string;
    quoteCurrency?: string;
    nft?: boolean;
    noSpam?: boolean;
  }): Promise<TokenBalance[]> {
    const {
      chainName,
      walletAddress,
      quoteCurrency = 'USD',
      nft = false,
      noSpam = true
    } = params;

    const url = `${this.baseUrl}/${chainName}/address/${walletAddress}/balances_v2/` +
      `?quote-currency=${quoteCurrency}&nft=${nft}&no-spam=${noSpam}`;

    const response = await this.fetchWithRateLimit(url);
    return response.data?.items || [];
  }

  /**
   * Get historical token prices
   * Critical for backtesting and price feeds
   */
  async getHistoricalPrices(params: {
    chainName: string;
    contractAddress: string;
    quoteCurrency?: string;
    from?: string;  // ISO date
    to?: string;    // ISO date
  }): Promise<Array<{ date: string, price: number }>> {
    const {
      chainName,
      contractAddress,
      quoteCurrency = 'USD',
      from,
      to
    } = params;

    let url = `${this.baseUrl}/pricing/historical_by_addresses_v2/${chainName}/${quoteCurrency}/${contractAddress}/`;
    
    const queryParams = new URLSearchParams();
    if (from) queryParams.append('from', from);
    if (to) queryParams.append('to', to);
    
    if (queryParams.toString()) {
      url += '?' + queryParams.toString();
    }

    const response = await this.fetchWithRateLimit(url);
    
    return (response.data?.[0]?.prices || []).map((p: any) => ({
      date: p.date,
      price: p.price
    }));
  }

  /**
   * Get pool/DEX exchange rates
   * Essential for arbitrage calculations
   */
  async getPoolExchangeRate(params: {
    chainName: string;
    dexName: string;
    poolAddress: string;
  }): Promise<{
    token0: string;
    token1: string;
    exchangeRate: number;
    totalLiquidityUsd: number;
    volume24h: number;
  }> {
    const { chainName, dexName, poolAddress } = params;
    
    const url = `${this.baseUrl}/${chainName}/xy=k/${dexName}/pools/address/${poolAddress}/`;
    
    const response = await this.fetchWithRateLimit(url);
    const pool = response.data?.items?.[0];
    
    if (!pool) {
      throw new Error('Pool not found');
    }

    return {
      token0: pool.token_0?.contract_address,
      token1: pool.token_1?.contract_address,
      exchangeRate: pool.exchange_rate,
      totalLiquidityUsd: pool.total_liquidity_quote,
      volume24h: pool.volume_24h_quote
    };
  }

  /**
   * Stream logs with polling (WebSocket alternative)
   * GoldRush doesn't have native WebSocket, so we poll efficiently
   */
  async *streamLogs(params: {
    chainName: string;
    contractAddress?: string;
    pollIntervalMs?: number;
  }): AsyncGenerator<LogEvent[]> {
    const { chainName, contractAddress, pollIntervalMs = 1000 } = params;
    
    let lastBlock = 0;
    
    while (true) {
      try {
        const logs = await this.getLogs({
          chainName,
          contractAddress,
          startingBlock: lastBlock + 1,
          endingBlock: 'latest',
          pageSize: 1000
        });

        if (logs.items.length > 0) {
          // Update last block
          const maxBlock = Math.max(...logs.items.map(l => l.blockHeight));
          if (maxBlock > lastBlock) {
            lastBlock = maxBlock;
            yield logs.items;
          }
        }

        await new Promise(resolve => setTimeout(resolve, pollIntervalMs));
      } catch (error) {
        console.error('[GoldRush] Stream error:', error);
        await new Promise(resolve => setTimeout(resolve, pollIntervalMs * 2));
      }
    }
  }

  /**
   * Get transaction details with decoded logs
   * Useful for analyzing successful arbitrage txs
   */
  async getTransaction(params: {
    chainName: string;
    txHash: string;
  }): Promise<{
    successful: boolean;
    gasUsed: number;
    gasPrice: number;
    value: string;
    logs: LogEvent[];
  }> {
    const { chainName, txHash } = params;
    
    const url = `${this.baseUrl}/${chainName}/transaction_v2/${txHash}/`;
    
    const response = await this.fetchWithRateLimit(url);
    const tx = response.data?.items?.[0];
    
    if (!tx) {
      throw new Error('Transaction not found');
    }

    return {
      successful: tx.successful,
      gasUsed: tx.gas_spent,
      gasPrice: tx.gas_price,
      value: tx.value,
      logs: tx.log_events || []
    };
  }

  /**
   * Batch fetch multiple endpoints efficiently
   */
  async batchFetch<T>(requests: Array<() => Promise<T>>): Promise<T[]> {
    const results: T[] = [];
    
    // Process in chunks to respect rate limits
    const chunkSize = Math.floor(this.maxRPS / 2);  // Conservative
    
    for (let i = 0; i < requests.length; i += chunkSize) {
      const chunk = requests.slice(i, i + chunkSize);
      const chunkResults = await Promise.all(chunk.map(fn => fn()));
      results.push(...chunkResults);
      
      // Small delay between chunks
      if (i + chunkSize < requests.length) {
        await new Promise(resolve => setTimeout(resolve, 100));
      }
    }
    
    return results;
  }

  /**
   * Clear cache
   */
  clearCache(): void {
    this.cache.clear();
  }

  /**
   * Get client statistics
   */
  getStats(): any {
    return {
      requestCount: this.requestCount,
      cacheSize: this.cache.size,
      cacheEnabled: this.cacheEnabled,
      maxRPS: this.maxRPS
    };
  }
}
