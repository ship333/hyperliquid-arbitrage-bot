/**
 * HyperEVM WebSocket Feed Handler
 * Optimized for Hyperliquid's dual-block architecture:
 * - Fast blocks: ~0.2s for responsiveness
 * - Large blocks: ~2s for throughput
 */

import { EventEmitter } from 'events';
import { WebSocketManager, WSConfig } from './WebSocketManager';
import { createPublicClient, webSocket, parseAbiItem, Log } from 'viem';

export interface PoolState {
  address: string;
  token0: string;
  token1: string;
  sqrtPriceX96: bigint;
  liquidity: bigint;
  tick: number;
  fee: number;
  lastUpdateBlock: bigint;
  lastUpdateTimestamp: number;
}

export interface SwapEvent {
  pool: string;
  sender: string;
  recipient: string;
  amount0: bigint;
  amount1: bigint;
  sqrtPriceX96: bigint;
  liquidity: bigint;
  tick: number;
  blockNumber: bigint;
  transactionHash: string;
  logIndex: number;
  timestamp: number;
}

export interface HyperEVMConfig {
  wsUrl: string;
  httpUrl?: string;
  name?: string;
  trackPools?: string[];  // Specific pool addresses to track
  trackTokens?: string[];  // Token addresses to auto-discover pools for
  factoryAddresses?: string[];  // UniV3-style factory addresses
  feeTiers?: number[];  // Fee tiers to scan (default: [500, 3000, 10000])
  maxPoolsToTrack?: number;  // Limit number of pools (default: 100)
}

const SWAP_EVENT_ABI = parseAbiItem(
  'event Swap(address indexed sender, address indexed recipient, int256 amount0, int256 amount1, uint160 sqrtPriceX96, uint128 liquidity, int24 tick)'
);

const POOL_CREATED_ABI = parseAbiItem(
  'event PoolCreated(address indexed token0, address indexed token1, uint24 indexed fee, int24 tickSpacing, address pool)'
);

export class HyperEVMFeed extends EventEmitter {
  private wsManager: WebSocketManager;
  private pools: Map<string, PoolState> = new Map();
  private blockTimes: number[] = [];  // Ring buffer for block time analysis
  private readonly maxBlockTimes = 100;
  private currentBlock = 0n;
  private isRunning = false;
  private client: any;
  private unwatchHandlers: Array<() => void> = [];

  constructor(private config: HyperEVMConfig) {
    super();
    this.wsManager = new WebSocketManager();
    
    // Initialize viem client for structured event handling
    this.client = createPublicClient({
      transport: webSocket(config.wsUrl),
    });
  }

  /**
   * Start the feed
   */
  async start(): Promise<void> {
    if (this.isRunning) {
      console.warn('[HyperEVMFeed] Already running');
      return;
    }

    console.log('[HyperEVMFeed] Starting feed...');
    this.isRunning = true;

    // Add WebSocket connection for raw message handling
    this.wsManager.addConnection({
      url: this.config.wsUrl,
      name: this.config.name || 'hyperevm',
      priority: 1,
      heartbeatIntervalMs: 10000,  // Fast heartbeat for HFT
      reconnectIntervalMs: 50,     // Aggressive reconnection
      maxReconnectIntervalMs: 5000
    });

    // Set up event handlers
    this.wsManager.on('message', this.handleRawMessage.bind(this));
    this.wsManager.on('error', (error) => {
      console.error('[HyperEVMFeed] WebSocket error:', error);
      this.emit('error', error);
    });

    // Watch blocks for timing analysis
    await this.watchBlocks();

    // Watch for pool creation events if factories provided
    if (this.config.factoryAddresses?.length) {
      await this.watchPoolCreation();
    }

    // Start watching specific pools
    if (this.config.trackPools?.length) {
      for (const poolAddress of this.config.trackPools) {
        await this.watchPool(poolAddress);
      }
    }

    // Auto-discover pools for tracked tokens
    if (this.config.trackTokens?.length && this.config.factoryAddresses?.length) {
      await this.discoverPoolsForTokens();
    }

    console.log('[HyperEVMFeed] Feed started');
  }

  /**
   * Watch blocks for timing and liveness
   */
  private async watchBlocks(): Promise<void> {
    const unwatch = this.client.watchBlocks({
      onBlock: (block: any) => {
        const now = Date.now();
        const blockNumber = BigInt(block.number);
        
        // Track block times for latency analysis
        if (this.currentBlock > 0n) {
          const blockTime = now - (this.blockTimes[this.blockTimes.length - 1] || now);
          this.blockTimes.push(now);
          if (this.blockTimes.length > this.maxBlockTimes) {
            this.blockTimes.shift();
          }
          
          // Detect if we're on fast or slow blocks
          const isFastBlock = blockTime < 500;  // <0.5s = fast block
          
          this.emit('block', {
            number: blockNumber,
            timestamp: block.timestamp,
            blockTimeMs: blockTime,
            isFastBlock,
            avgBlockTimeMs: this.getAverageBlockTime()
          });
        }
        
        this.currentBlock = blockNumber;
      },
      onError: (error: Error) => {
        console.error('[HyperEVMFeed] Block watch error:', error);
        this.emit('error', error);
      }
    });

    this.unwatchHandlers.push(unwatch);
  }

  /**
   * Watch for pool creation events
   */
  private async watchPoolCreation(): Promise<void> {
    if (!this.config.factoryAddresses?.length) return;

    const unwatch = this.client.watchEvent({
      address: this.config.factoryAddresses as `0x${string}`[],
      event: POOL_CREATED_ABI,
      onLogs: (logs: Log[]) => {
        for (const log of logs) {
          const { token0, token1, fee, pool } = (log as any).args;
          
          // Check if we should track this pool
          const shouldTrack = 
            this.config.trackTokens?.includes(token0.toLowerCase()) ||
            this.config.trackTokens?.includes(token1.toLowerCase());
          
          if (shouldTrack && this.pools.size < (this.config.maxPoolsToTrack || 100)) {
            console.log(`[HyperEVMFeed] New pool discovered: ${pool}`);
            this.watchPool(pool).catch(console.error);
            
            this.emit('poolDiscovered', {
              address: pool,
              token0,
              token1,
              fee: Number(fee),
              blockNumber: log.blockNumber
            });
          }
        }
      },
      onError: (error: Error) => {
        console.error('[HyperEVMFeed] Pool creation watch error:', error);
      }
    });

    this.unwatchHandlers.push(unwatch);
  }

  /**
   * Watch a specific pool for swap events
   */
  private async watchPool(poolAddress: string): Promise<void> {
    const address = poolAddress.toLowerCase() as `0x${string}`;
    
    if (this.pools.has(address)) {
      return;  // Already watching
    }

    console.log(`[HyperEVMFeed] Watching pool ${address}`);
    
    // Initialize pool state
    const poolState: PoolState = {
      address,
      token0: '',  // Will be populated from contract calls
      token1: '',
      sqrtPriceX96: 0n,
      liquidity: 0n,
      tick: 0,
      fee: 0,
      lastUpdateBlock: this.currentBlock,
      lastUpdateTimestamp: Date.now()
    };
    
    this.pools.set(address, poolState);

    // Watch swap events
    const unwatch = this.client.watchEvent({
      address,
      event: SWAP_EVENT_ABI,
      onLogs: (logs: Log[]) => {
        const receiveTime = Date.now();
        
        for (const log of logs) {
          const args = (log as any).args;
          
          // Update pool state
          poolState.sqrtPriceX96 = BigInt(args.sqrtPriceX96);
          poolState.liquidity = BigInt(args.liquidity);
          poolState.tick = Number(args.tick);
          poolState.lastUpdateBlock = log.blockNumber || 0n;
          poolState.lastUpdateTimestamp = receiveTime;
          
          // Create swap event
          const swap: SwapEvent = {
            pool: address,
            sender: args.sender,
            recipient: args.recipient,
            amount0: BigInt(args.amount0),
            amount1: BigInt(args.amount1),
            sqrtPriceX96: BigInt(args.sqrtPriceX96),
            liquidity: BigInt(args.liquidity),
            tick: Number(args.tick),
            blockNumber: log.blockNumber || 0n,
            transactionHash: log.transactionHash || '',
            logIndex: log.logIndex || 0,
            timestamp: receiveTime
          };
          
          // Calculate implied price impact
          const priceImpact = this.calculatePriceImpact(swap);
          
          // Emit for immediate processing
          this.emit('swap', {
            ...swap,
            priceImpactBps: priceImpact,
            latencyMs: receiveTime - poolState.lastUpdateTimestamp
          });
        }
      },
      onError: (error: Error) => {
        console.error(`[HyperEVMFeed] Swap watch error for ${address}:`, error);
      }
    });

    this.unwatchHandlers.push(unwatch);
  }

  /**
   * Discover pools for tracked tokens
   */
  private async discoverPoolsForTokens(): Promise<void> {
    if (!this.config.trackTokens?.length || !this.config.factoryAddresses?.length) {
      return;
    }

    const feeTiers = this.config.feeTiers || [500, 3000, 10000];
    
    // Create token pairs
    const pairs: Array<[string, string]> = [];
    for (let i = 0; i < this.config.trackTokens.length; i++) {
      for (let j = i + 1; j < this.config.trackTokens.length; j++) {
        pairs.push([this.config.trackTokens[i], this.config.trackTokens[j]]);
      }
    }

    // Query factories for pools (would need contract calls in production)
    console.log(`[HyperEVMFeed] Discovering pools for ${pairs.length} token pairs across ${feeTiers.length} fee tiers`);
    
    // This would normally involve contract calls to factory.getPool()
    // For now, we rely on PoolCreated events
  }

  /**
   * Handle raw WebSocket messages for ultra-low latency
   */
  private handleRawMessage(message: any): void {
    try {
      // Fast path for known message types
      if (message.data?.method === 'eth_subscription' && message.data?.params?.result) {
        const result = message.data.params.result;
        
        // Ultra-fast swap detection via topics
        if (result.topics?.[0] === '0xc42079f94a6350d7e6235f29174924f928cc2ac818eb64fed8004e115fbcca67') {
          // This is a Swap event - process immediately without full parsing
          this.emit('fastSwap', {
            address: result.address,
            blockNumber: result.blockNumber,
            transactionHash: result.transactionHash,
            timestamp: Date.now()
          });
        }
      }
    } catch (error) {
      // Silently ignore parse errors in fast path
    }
  }

  /**
   * Calculate price impact from swap amounts
   */
  private calculatePriceImpact(swap: SwapEvent): number {
    // Simplified calculation - in production would use precise math
    const amount0Abs = swap.amount0 < 0n ? -swap.amount0 : swap.amount0;
    const amount1Abs = swap.amount1 < 0n ? -swap.amount1 : swap.amount1;
    
    if (amount0Abs === 0n || amount1Abs === 0n) {
      return 0;
    }
    
    // Calculate execution price vs current price
    // This is simplified - production would use sqrtPriceX96 properly
    const executionPrice = Number(amount1Abs) / Number(amount0Abs);
    const currentPrice = Number(swap.sqrtPriceX96) ** 2 / (2 ** 192);
    
    const impact = Math.abs(executionPrice / currentPrice - 1) * 10000;
    return Math.round(impact);  // Return in basis points
  }

  /**
   * Get average block time
   */
  private getAverageBlockTime(): number {
    if (this.blockTimes.length < 2) return 0;
    
    let sum = 0;
    for (let i = 1; i < this.blockTimes.length; i++) {
      sum += this.blockTimes[i] - this.blockTimes[i - 1];
    }
    
    return Math.round(sum / (this.blockTimes.length - 1));
  }

  /**
   * Get pool states
   */
  getPoolStates(): Map<string, PoolState> {
    return new Map(this.pools);
  }

  /**
   * Get feed statistics
   */
  getStats(): any {
    const wsStats = this.wsManager.getStats();
    
    return {
      isRunning: this.isRunning,
      currentBlock: this.currentBlock.toString(),
      poolsTracked: this.pools.size,
      avgBlockTimeMs: this.getAverageBlockTime(),
      websocket: wsStats.get(this.config.name || 'hyperevm')
    };
  }

  /**
   * Stop the feed
   */
  async stop(): Promise<void> {
    console.log('[HyperEVMFeed] Stopping feed...');
    this.isRunning = false;
    
    // Unwatch all handlers
    for (const unwatch of this.unwatchHandlers) {
      try {
        unwatch();
      } catch (error) {
        console.error('[HyperEVMFeed] Error unwatching:', error);
      }
    }
    
    this.unwatchHandlers = [];
    
    // Shutdown WebSocket manager
    await this.wsManager.shutdown();
    
    // Clear state
    this.pools.clear();
    this.blockTimes = [];
    this.removeAllListeners();
    
    console.log('[HyperEVMFeed] Feed stopped');
  }
}
