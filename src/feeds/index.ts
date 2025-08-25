/**
 * Main Orchestrator for Real-time Arbitrage System
 * Production-ready entry point for WebSocket feeds and signal generation
 */

import { SignalGenerator, Signal } from './SignalGenerator';
import { OpportunityDetector } from './OpportunityDetector';
import { ArbitrageOpportunity } from './types';
import { config } from 'dotenv';
import { EventEmitter } from 'events';

// Load environment variables
config();

export interface OrchestratorConfig {
  // WebSocket URLs
  hyperEVMWsUrl?: string;
  hyperEVMHttpUrl?: string;
  
  // GoldRush API
  goldRushApiKey?: string;
  goldRushChainName?: string;
  
  // Tracking configuration
  trackPools?: string[];
  trackTokens?: string[];
  
  // Execution parameters
  minProfitUsd?: number;
  maxRiskScore?: number;
  maxOpenSignals?: number;
  
  // RPC for on-chain data
  rpcUrl?: string;
  
  // Backend URL for forwarding
  backendUrl?: string;
}

export class ArbitrageOrchestrator extends EventEmitter {
  private signalGenerator: SignalGenerator;
  private opportunityDetector: OpportunityDetector;
  private isRunning = false;
  private executionQueue: Signal[] = [];
  private readonly backendUrl: string | undefined;
  
  constructor(config?: OrchestratorConfig) {
    super();
    
    // Build configuration from env and params
    const hyperEVMWsUrl = config?.hyperEVMWsUrl || process.env.ALCHEMY_WSS_URL_HYPER;
    const hyperEVMHttpUrl = config?.hyperEVMHttpUrl || process.env.ALCHEMY_HTTP_URL_HYPER;
    const goldRushApiKey = config?.goldRushApiKey || process.env.GOLDRUSH_API_KEY;
    const goldRushChainName = config?.goldRushChainName || 'eth-mainnet';
    const rpcUrl = config?.rpcUrl || process.env.RPC_URL || hyperEVMHttpUrl;
    this.backendUrl = config?.backendUrl || process.env.BACKEND_URL;
    
    // Parse tracking configuration from env
    const trackPools = process.env.TRACK_POOLS?.split(',').map(p => p.trim()) || [];
    const trackTokens = process.env.TRACK_TOKENS?.split(',').map(t => t.trim()) || [];
    
    if (!hyperEVMWsUrl) {
      throw new Error('HyperEVM WebSocket URL is required (ALCHEMY_WSS_URL_HYPER)');
    }
    
    // Initialize opportunity detector with signal generator
    this.opportunityDetector = new OpportunityDetector({
      hyperEVMConfig: {
        wsUrl: hyperEVMWsUrl,
        httpUrl: hyperEVMHttpUrl,
        trackPools: trackPools.length > 0 ? trackPools : undefined,
        trackTokens: trackTokens.length > 0 ? trackTokens : undefined
      },
      goldRushConfig: goldRushApiKey ? {
        apiKey: goldRushApiKey,
        chainName: 'ethereum'
      } : undefined,
      minSpreadBps: 10,
      minLiquidityUsd: 10000,
      maxPathLength: 3,
      priceUpdateThresholdMs: 5000
    });
    
    // Initialize signal generator
    this.signalGenerator = new SignalGenerator({
      detectorConfig: {
        hyperEVMConfig: {
          wsUrl: hyperEVMWsUrl,
          httpUrl: hyperEVMHttpUrl,
          trackPools: trackPools.length > 0 ? trackPools : undefined,
          trackTokens: trackTokens.length > 0 ? trackTokens : undefined
        },
        goldRushConfig: goldRushApiKey ? {
          apiKey: goldRushApiKey,
          chainName: 'ethereum'
        } : undefined
      },
      evaluationConfig: {
        flashLoanEnabled: true,
        flashLoanProvider: 'aave_v3',
        maxPositionSizeUsd: 100000,
        targetSharpeRatio: 2.0,
        maxVaR95: 0.05
      },
      filters: {
        minNetProfitUsd: config?.minProfitUsd || 10,
        minConfidence: 0.7,
        maxRiskScore: config?.maxRiskScore || 0.3,
        maxOpenSignals: config?.maxOpenSignals || 10
      },
      rpcUrl
    });
    
    this.setupEventHandlers();
  }

  /**
   * Setup event handlers
   */
  private setupEventHandlers(): void {
    // Handle opportunities from detector
    this.opportunityDetector.on('opportunity', (opp: ArbitrageOpportunity) => {
      this.signalGenerator.processOpportunity(opp);
    });
    
    // Handle signals from generator
    this.signalGenerator.on('signal', (signal: Signal) => {
      console.log(`[Orchestrator] New signal: ${signal.id}`);
      
      if (signal.shouldExecute) {
        this.queueForExecution(signal);
      }
      
      // Forward to backend if configured
      if (this.backendUrl) {
        this.forwardToBackend('signal', signal);
      }
      
      this.emit('signal', signal);
    });
    
    // Handle signal updates
    this.signalGenerator.on('signalUpdate', (signal: Signal) => {
      console.log(`[Orchestrator] Signal update: ${signal.id}`);
      
      if (signal.shouldExecute && !this.isInQueue(signal.id)) {
        this.queueForExecution(signal);
      }
      
      this.emit('signalUpdate', signal);
    });
    
    // Handle executed signals
    this.signalGenerator.on('signalExecuted', (result: any) => {
      console.log(`[Orchestrator] Signal executed: ${result.signal.id} | Profit: $${result.actualProfit.toFixed(2)}`);
      
      // Forward to backend
      if (this.backendUrl) {
        this.forwardToBackend('execution', result);
      }
      
      this.emit('execution', result);
    });
    
    // Handle errors
    this.signalGenerator.on('error', (error: Error) => {
      console.error('[Orchestrator] Error:', error);
      this.emit('error', error);
    });
  }

  /**
   * Start the orchestrator
   */
  async start(): Promise<void> {
    if (this.isRunning) {
      console.log('[Orchestrator] Already running');
      return;
    }
    
    console.log('[Orchestrator] Starting...');
    console.log('[Orchestrator] Configuration:');
    console.log('  - Min Profit: $' + (this.signalGenerator as any).minNetProfitUsd);
    console.log('  - Max Risk Score: ' + (this.signalGenerator as any).maxRiskScore);
    console.log('  - Backend URL: ' + (this.backendUrl || 'Not configured'));
    
    this.isRunning = true;
    
    // Connect to WebSocket feeds
    await this.opportunityDetector.start();
    await this.signalGenerator.start();
    
    // Start execution processor
    this.startExecutionProcessor();
    
    console.log('[Orchestrator] Started successfully');
    this.emit('started');
  }

  /**
   * Queue signal for execution
   */
  private queueForExecution(signal: Signal): void {
    // Add to priority queue
    this.executionQueue.push(signal);
    
    // Sort by priority
    this.executionQueue.sort((a, b) => b.priorityScore - a.priorityScore);
    
    // Limit queue size
    if (this.executionQueue.length > 20) {
      this.executionQueue = this.executionQueue.slice(0, 20);
    }
    
    console.log(`[Orchestrator] Queued signal ${signal.id} for execution (queue size: ${this.executionQueue.length})`);
  }

  /**
   * Check if signal is in queue
   */
  private isInQueue(signalId: string): boolean {
    return this.executionQueue.some(s => s.id === signalId);
  }

  /**
   * Start execution processor
   */
  private startExecutionProcessor(): void {
    // Process execution queue
    setInterval(() => {
      if (this.executionQueue.length === 0) return;
      
      // Get next signal
      const signal = this.executionQueue.shift();
      if (!signal) return;
      
      // Check if still valid
      if (Date.now() > signal.validUntil) {
        console.log(`[Orchestrator] Signal ${signal.id} expired, skipping execution`);
        return;
      }
      
      // Execute signal (would integrate with transaction manager)
      this.executeSignal(signal);
      
    }, 100);  // Process every 100ms for low latency
  }

  /**
   * Execute a signal
   */
  private async executeSignal(signal: Signal): Promise<void> {
    console.log(`[Orchestrator] Executing signal ${signal.id}...`);
    
    try {
      // This would integrate with your transaction manager
      // For now, we'll simulate execution
      
      console.log(`[Main] Simulating execution for signal ${signal.id}`);
        
      // Simulate execution (would be replaced with actual transaction manager)
      const success = Math.random() > 0.3;  // 70% success rate simulation
      const actualProfit = success 
        ? signal.expectedValue * (0.8 + Math.random() * 0.4)  // 80-120% of expected
        : -signal.opportunity.estimatedGasUsd;
      
      // Mark as executed
      this.signalGenerator.markExecuted(signal.id, actualProfit);
      
      console.log(`[Orchestrator] Executed signal ${signal.id} | Profit: $${actualProfit.toFixed(2)}`);
      
    } catch (error) {
      console.error(`[Orchestrator] Failed to execute signal ${signal.id}:`, error);
      this.emit('executionError', { signal, error });
    }
  }

  /**
   * Forward data to backend
   */
  private async forwardToBackend(type: string, data: any): Promise<void> {
    if (!this.backendUrl) return;
    
    try {
      const response = await fetch(this.backendUrl, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json'
        },
        body: JSON.stringify({
          type,
          timestamp: Date.now(),
          data
        })
      });
      
      if (!response.ok) {
        console.error(`[Orchestrator] Backend forward failed: ${response.status}`);
      }
    } catch (error) {
      console.error('[Orchestrator] Backend forward error:', error);
    }
  }

  /**
   * Get statistics
   */
  getStats(): any {
    return {
      isRunning: this.isRunning,
      executionQueueSize: this.executionQueue.length,
      ...this.signalGenerator.getStats()
    };
  }

  /**
   * Get active signals
   */
  getActiveSignals(): Signal[] {
    return this.signalGenerator.getActiveSignals();
  }

  /**
   * Stop the orchestrator
   */
  async stop(): Promise<void> {
    if (!this.isRunning) {
      console.log('[Orchestrator] Not running');
      return;
    }
    
    console.log('[Orchestrator] Stopping...');
    
    this.isRunning = false;
    this.executionQueue = [];
    
    await this.signalGenerator.stop();
    
    this.removeAllListeners();
    
    console.log('[Orchestrator] Stopped');
    this.emit('stopped');
  }
}

// Export convenience function
export async function startArbitrageBot(config?: OrchestratorConfig): Promise<ArbitrageOrchestrator> {
  const orchestrator = new ArbitrageOrchestrator(config);
  await orchestrator.start();
  return orchestrator;
}

// CLI entry point
if (require.main === module) {
  const orchestrator = new ArbitrageOrchestrator();
  
  // Graceful shutdown
  process.on('SIGINT', async () => {
    console.log('\n[Orchestrator] Shutting down gracefully...');
    await orchestrator.stop();
    process.exit(0);
  });
  
  // Start
  orchestrator.start().catch(error => {
    console.error('[Orchestrator] Fatal error:', error);
    process.exit(1);
  });
  
  // Log stats periodically
  setInterval(() => {
    const stats = orchestrator.getStats();
    console.log('[Orchestrator] Stats:', JSON.stringify(stats, null, 2));
  }, 30000);  // Every 30 seconds
}
