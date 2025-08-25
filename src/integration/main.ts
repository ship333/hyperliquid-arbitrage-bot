/**
 * Main Integration Entry Point
 * Orchestrates the complete arbitrage bot with all components
 * 
 * Architecture:
 * SignalGenerator → SignalBridge → SignalExecutor → ExecutionManager
 *        ↓              ↓              ↓                ↓
 *   OpportunityDetector  RiskManager  PositionMonitor  HyperliquidClient
 */

import dotenv from 'dotenv';
import winston from 'winston';
import { SignalGenerator } from '../feeds/SignalGenerator';
import { ExecutionManager } from '../execution/ExecutionManager';
import { SignalExecutor } from '../execution/SignalExecutor';
import { HyperliquidClient } from '../execution/HyperliquidClient';
import { RiskManager, RiskLimits } from '../risk/RiskManager';
import { PositionMonitor } from '../risk/PositionMonitor';
import { SignalBridge } from './SignalBridge';

// Load environment configurations
dotenv.config({ path: '.env' });
dotenv.config({ path: '.env.execution' });

// Setup logger
const logger = winston.createLogger({
  level: 'info',
  format: winston.format.combine(
    winston.format.timestamp(),
    winston.format.colorize(),
    winston.format.simple()
  ),
  transports: [
    new winston.transports.Console(),
    new winston.transports.File({ filename: 'logs/integration.log' })
  ]
});

interface BotConfig {
  mode: 'production' | 'testnet' | 'dry-run';
  autoStart: boolean;
  gracefulShutdown: boolean;
}

class HyperliquidArbitrageBot {
  private components: {
    signalGenerator?: SignalGenerator;
    executionManager?: ExecutionManager;
    signalExecutor?: SignalExecutor;
    hyperliquidClient?: HyperliquidClient;
    riskManager?: RiskManager;
    positionMonitor?: PositionMonitor;
    signalBridge?: SignalBridge;
  } = {};
  
  private running = false;
  private shutdownHandlers: (() => Promise<void>)[] = [];

  constructor(private config: BotConfig) {
    logger.info('Initializing Hyperliquid Arbitrage Bot', { config });
    this.setupShutdownHandlers();
  }

  /**
   * Initialize all bot components
   */
  async initialize(): Promise<void> {
    logger.info('🚀 Initializing bot components...');

    try {
      // 1. Initialize Hyperliquid Client
      logger.info('  • Setting up Hyperliquid client...');
      this.components.hyperliquidClient = new HyperliquidClient({
        apiUrl: this.getApiUrl(),
        wsUrl: this.getWsUrl(),
        privateKey: process.env.HYPERLIQUID_PRIVATE_KEY || '',
        accountAddress: process.env.HYPERLIQUID_ACCOUNT_ADDRESS || ''
      });

      // 2. Initialize Risk Manager
      logger.info('  • Configuring risk management...');
      this.components.riskManager = new RiskManager(this.getRiskLimits());

      // 3. Initialize Execution Manager
      logger.info('  • Setting up execution engine...');
      this.components.executionManager = new ExecutionManager(
        this.components.hyperliquidClient,
        {
          dryRun: this.config.mode === 'dry-run',
          maxRetries: parseInt(process.env.MAX_ORDER_RETRIES || '3'),
          retryDelayMs: parseInt(process.env.RETRY_DELAY_MS || '1000'),
          maxSlippagePercent: parseFloat(process.env.MAX_SLIPPAGE_PERCENT || '1'),
          maxOrderSize: parseFloat(process.env.MAX_ORDER_SIZE || '1000'),
          minOrderSize: parseFloat(process.env.MIN_ORDER_SIZE || '10')
        }
      );

      // 4. Initialize Position Monitor
      logger.info('  • Starting position monitoring...');
      this.components.positionMonitor = new PositionMonitor(
        this.components.hyperliquidClient,
        this.components.riskManager
      );

      // 5. Initialize Signal Executor
      logger.info('  • Configuring signal executor...');
      this.components.signalExecutor = new SignalExecutor({
        executionManager: this.components.executionManager,
        riskManager: this.components.riskManager,
        autoExecute: process.env.AUTO_EXECUTE === 'true',
        maxConcurrentExecutions: parseInt(process.env.MAX_CONCURRENT_EXECUTIONS || '3'),
        minConfidence: parseFloat(process.env.MIN_CONFIDENCE_THRESHOLD || '0.7'),
        minProfitUsd: parseFloat(process.env.MIN_PROFIT_TARGET_USD || '10'),
        maxRiskScore: parseFloat(process.env.MAX_RISK_SCORE || '0.3'),
        executionDelayMs: parseInt(process.env.EXECUTION_DELAY_MS || '0')
      });

      // 6. Initialize Signal Generator
      logger.info('  • Setting up signal generation...');
      this.components.signalGenerator = new SignalGenerator({
        filters: {
          minNetProfitUsd: parseFloat(process.env.MIN_PROFIT_USD || '10'),
          minConfidence: parseFloat(process.env.MIN_CONFIDENCE || '0.7'),
          maxRiskScore: parseFloat(process.env.MAX_RISK_SCORE || '0.3'),
          maxOpenSignals: parseInt(process.env.MAX_OPEN_SIGNALS || '10')
        },
        detectorConfig: {
          exchanges: ['hyperliquid'],
          updateInterval: parseInt(process.env.UPDATE_INTERVAL_MS || '1000'),
          minVolume: parseFloat(process.env.MIN_VOLUME || '1000'),
          maxLatency: parseInt(process.env.MAX_LATENCY_MS || '100')
        }
      });

      // 7. Initialize Signal Bridge
      logger.info('  • Connecting signal pipeline...');
      this.components.signalBridge = new SignalBridge(
        this.components.signalGenerator,
        this.components.executionManager,
        this.components.signalExecutor,
        this.components.riskManager,
        this.components.positionMonitor
      );

      // 8. Setup event listeners
      this.setupEventListeners();

      logger.info('✅ All components initialized successfully');

    } catch (error) {
      logger.error('Failed to initialize components:', error);
      throw error;
    }
  }

  /**
   * Start the bot
   */
  async start(): Promise<void> {
    if (this.running) {
      logger.warn('Bot is already running');
      return;
    }

    logger.info('🎯 Starting Hyperliquid Arbitrage Bot...');

    try {
      // Connect to Hyperliquid
      await this.components.hyperliquidClient!.connect();
      logger.info('  ✅ Connected to Hyperliquid');

      // Start position monitoring
      await this.components.positionMonitor!.start();
      logger.info('  ✅ Position monitoring active');

      // Start execution manager
      await this.components.executionManager!.start();
      logger.info('  ✅ Execution engine running');

      // Start signal executor
      await this.components.signalExecutor!.start();
      logger.info('  ✅ Signal executor ready');

      // Start signal generator
      await this.components.signalGenerator!.start();
      logger.info('  ✅ Signal generation active');

      // Connect signal bridge
      await this.components.signalBridge!.start();
      logger.info('  ✅ Signal pipeline connected');

      this.running = true;
      logger.info('🟢 Bot is now running in ' + this.config.mode + ' mode');

      // Log initial status
      this.logStatus();

    } catch (error) {
      logger.error('Failed to start bot:', error);
      await this.stop();
      throw error;
    }
  }

  /**
   * Stop the bot
   */
  async stop(): Promise<void> {
    if (!this.running) {
      logger.warn('Bot is not running');
      return;
    }

    logger.info('🛑 Stopping bot...');

    try {
      // Stop components in reverse order
      this.components.signalGenerator?.stop();
      this.components.signalExecutor?.stop();
      this.components.executionManager?.stop();
      this.components.positionMonitor?.stop();
      this.components.hyperliquidClient?.disconnect();

      this.running = false;
      logger.info('✅ Bot stopped successfully');

    } catch (error) {
      logger.error('Error during shutdown:', error);
      throw error;
    }
  }

  /**
   * Setup event listeners for monitoring
   */
  private setupEventListeners(): void {
    // Risk events
    this.components.riskManager?.on('circuitBreakerTriggered', (data) => {
      logger.error('🚨 CIRCUIT BREAKER TRIGGERED:', data);
      this.handleCircuitBreaker();
    });

    this.components.riskManager?.on('emergencyStop', (data) => {
      logger.error('🚨 EMERGENCY STOP:', data);
      this.emergencyShutdown();
    });

    // Position events
    this.components.positionMonitor?.on('hedgeSignal', (signal) => {
      logger.warn('⚠️ Hedge signal:', signal);
    });

    this.components.positionMonitor?.on('positionWarning', (warning) => {
      logger.warn('⚠️ Position warning:', warning);
    });

    // Execution events
    this.components.signalExecutor?.on('executionComplete', (result) => {
      if (result.success) {
        logger.info('✅ Execution complete:', {
          signalId: result.signalId,
          profit: result.estimatedProfit
        });
      } else {
        logger.error('❌ Execution failed:', result.error);
      }
    });

    // Signal events
    this.components.signalBridge?.on('signalTransformed', (data) => {
      logger.debug('Signal transformed:', {
        id: data.feedSignal.id,
        latency: data.latencyMs
      });
    });

    // Error events
    const errorHandler = (error: any) => {
      logger.error('Component error:', error);
    };

    this.components.signalGenerator?.on('error', errorHandler);
    this.components.executionManager?.on('error', errorHandler);
    this.components.positionMonitor?.on('error', errorHandler);
  }

  /**
   * Handle circuit breaker activation
   */
  private async handleCircuitBreaker(): Promise<void> {
    logger.warn('Handling circuit breaker activation...');
    
    // Pause signal generation
    this.components.signalGenerator?.pause();
    
    // Cancel pending executions
    // Note: This would need implementation in SignalExecutor
    
    // Wait for cooldown
    setTimeout(() => {
      logger.info('Attempting to resume after circuit breaker...');
      this.components.signalGenerator?.resume();
      this.components.signalBridge?.resume();
    }, 300000); // 5 minutes
  }

  /**
   * Emergency shutdown
   */
  private async emergencyShutdown(): Promise<void> {
    logger.error('🚨 EMERGENCY SHUTDOWN INITIATED');
    
    try {
      // Close all positions if configured
      if (process.env.EMERGENCY_CLOSE_POSITIONS === 'true') {
        logger.warn('Closing all positions...');
        // Implementation would go here
      }
      
      // Stop the bot
      await this.stop();
      
      // Exit process
      process.exit(1);
      
    } catch (error) {
      logger.error('Emergency shutdown error:', error);
      process.exit(1);
    }
  }

  /**
   * Setup graceful shutdown handlers
   */
  private setupShutdownHandlers(): void {
    if (!this.config.gracefulShutdown) return;

    const shutdownHandler = async (signal: string) => {
      logger.info(`Received ${signal}, initiating graceful shutdown...`);
      
      try {
        // Run custom shutdown handlers
        for (const handler of this.shutdownHandlers) {
          await handler();
        }
        
        // Stop the bot
        await this.stop();
        
        logger.info('Graceful shutdown complete');
        process.exit(0);
        
      } catch (error) {
        logger.error('Error during graceful shutdown:', error);
        process.exit(1);
      }
    };

    process.on('SIGINT', () => shutdownHandler('SIGINT'));
    process.on('SIGTERM', () => shutdownHandler('SIGTERM'));
  }

  /**
   * Register custom shutdown handler
   */
  onShutdown(handler: () => Promise<void>): void {
    this.shutdownHandlers.push(handler);
  }

  /**
   * Get API URL based on mode
   */
  private getApiUrl(): string {
    switch (this.config.mode) {
      case 'production':
        return process.env.HYPERLIQUID_API_URL || 'https://api.hyperliquid.xyz';
      case 'testnet':
        return process.env.HYPERLIQUID_TESTNET_API_URL || 'https://api.hyperliquid-testnet.xyz';
      default:
        return 'https://api.hyperliquid-testnet.xyz';
    }
  }

  /**
   * Get WebSocket URL based on mode
   */
  private getWsUrl(): string {
    switch (this.config.mode) {
      case 'production':
        return process.env.HYPERLIQUID_WS_URL || 'wss://api.hyperliquid.xyz/ws';
      case 'testnet':
        return process.env.HYPERLIQUID_TESTNET_WS_URL || 'wss://api.hyperliquid-testnet.xyz/ws';
      default:
        return 'wss://api.hyperliquid-testnet.xyz/ws';
    }
  }

  /**
   * Get risk limits based on mode
   */
  private getRiskLimits(): RiskLimits {
    const baseConfig = {
      maxPositionSizeUsd: parseFloat(process.env.MAX_POSITION_SIZE_USD || '1000'),
      maxTotalExposureUsd: parseFloat(process.env.MAX_TOTAL_EXPOSURE_USD || '5000'),
      maxPositionCount: parseInt(process.env.MAX_POSITION_COUNT || '5'),
      maxConcentration: parseFloat(process.env.MAX_CONCENTRATION || '0.2'),
      maxDailyLossUsd: parseFloat(process.env.MAX_DAILY_LOSS_USD || '100'),
      maxDrawdownPercent: parseFloat(process.env.MAX_DRAWDOWN_PERCENT || '0.1'),
      stopLossPercent: parseFloat(process.env.STOP_LOSS_PERCENT || '0.05'),
      maxOrderSizeUsd: parseFloat(process.env.MAX_ORDER_SIZE_USD || '500'),
      maxSlippagePercent: parseFloat(process.env.MAX_SLIPPAGE_PERCENT || '0.01'),
      minOrderSizeUsd: parseFloat(process.env.MIN_ORDER_SIZE_USD || '10'),
      maxOrdersPerMinute: parseInt(process.env.MAX_ORDERS_PER_MINUTE || '10'),
      maxVolumePerHourUsd: parseFloat(process.env.MAX_VOLUME_PER_HOUR_USD || '10000'),
      consecutiveLossLimit: parseInt(process.env.CONSECUTIVE_LOSS_LIMIT || '3'),
      errorRateThreshold: parseFloat(process.env.ERROR_RATE_THRESHOLD || '0.2'),
      latencyThresholdMs: parseInt(process.env.LATENCY_THRESHOLD_MS || '1000')
    };

    // Apply stricter limits for production
    if (this.config.mode === 'production') {
      baseConfig.maxDailyLossUsd *= 0.5;  // Half the loss limit
      baseConfig.maxDrawdownPercent *= 0.5;
      baseConfig.consecutiveLossLimit = 2;  // Stricter consecutive loss
    }

    return baseConfig;
  }

  /**
   * Log current bot status
   */
  private logStatus(): void {
    const status = {
      mode: this.config.mode,
      running: this.running,
      riskMetrics: this.components.riskManager?.getMetrics(),
      portfolioMetrics: this.components.positionMonitor?.getPortfolioMetrics(),
      signalMetrics: this.components.signalBridge?.getMetrics()
    };

    logger.info('📊 Bot Status:', status);
  }

  /**
   * Get bot status
   */
  getStatus(): any {
    return {
      running: this.running,
      mode: this.config.mode,
      components: {
        hyperliquid: !!this.components.hyperliquidClient,
        riskManager: !!this.components.riskManager,
        executionManager: !!this.components.executionManager,
        positionMonitor: !!this.components.positionMonitor,
        signalExecutor: !!this.components.signalExecutor,
        signalGenerator: !!this.components.signalGenerator,
        signalBridge: !!this.components.signalBridge
      },
      metrics: {
        risk: this.components.riskManager?.getMetrics(),
        portfolio: this.components.positionMonitor?.getPortfolioMetrics(),
        signals: this.components.signalBridge?.getMetrics()
      }
    };
  }
}

/**
 * Main entry point
 */
async function main() {
  logger.info('========================================');
  logger.info('   HYPERLIQUID ARBITRAGE BOT v2.0');
  logger.info('========================================\n');

  // Determine mode from environment
  const mode = (process.env.BOT_MODE || 'dry-run') as 'production' | 'testnet' | 'dry-run';
  
  if (mode === 'production') {
    logger.warn('⚠️  RUNNING IN PRODUCTION MODE - REAL MONEY AT RISK');
    logger.warn('⚠️  Press Ctrl+C within 10 seconds to cancel...\n');
    await new Promise(resolve => setTimeout(resolve, 10000));
  }

  // Create bot instance
  const bot = new HyperliquidArbitrageBot({
    mode,
    autoStart: true,
    gracefulShutdown: true
  });

  try {
    // Initialize components
    await bot.initialize();
    
    // Start the bot
    await bot.start();
    
    // Setup status logging
    setInterval(() => {
      logger.info('Status update:', bot.getStatus());
    }, 60000); // Every minute
    
    logger.info('\n🤖 Bot is running. Press Ctrl+C to stop.\n');
    
  } catch (error) {
    logger.error('Failed to start bot:', error);
    process.exit(1);
  }
}

// Run if executed directly
if (require.main === module) {
  main().catch(error => {
    logger.error('Fatal error:', error);
    process.exit(1);
  });
}

export { HyperliquidArbitrageBot };
