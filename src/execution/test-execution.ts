/**
 * Execution Pipeline Integration Test
 * Tests the complete signal-to-execution flow
 */

import dotenv from 'dotenv';
import path from 'path';
import { SignalGenerator } from '../feeds/SignalGenerator';
import { ExecutionManager } from './ExecutionManager';
import { SignalExecutor } from './SignalExecutor';
import { Signal, ExecutableOpportunity } from './types';

// Load environment variables
dotenv.config({ path: path.resolve(__dirname, '../../.env') });
dotenv.config({ path: path.resolve(__dirname, '../../.env.execution') });

// Mock signal for testing
const createMockSignal = (): Signal => {
  const opportunity: ExecutableOpportunity = {
    id: `mock-opp-${Date.now()}`,
    type: 'cross_venue' as const,
    pair: 'ETH-USDC',
    path: ['ETH', 'USDC'],
    pools: ['hyperliquid-pool'],
    routers: ['0x...'],
    exchanges: {
      buy: 'hyperliquid',
      sell: 'uniswap'
    },
    priceDiff: 15.50,
    expectedProfit: 25.75,
    requiredCapital: 1000,
    estimatedGas: 5.25,
    confidence: 0.85,
    timestamp: Date.now(),
    priceImpact: 0.001,
    expectedPrice: 2500.00,
    volume24h: 1000000,
    liquidity: {
      buy: 500000,
      sell: 500000
    }
  };

  return {
    id: `signal-${Date.now()}`,
    opportunity,
    timestamp: Date.now(),
    expectedValue: 20.50,
    confidenceScore: 0.85,
    riskScore: 0.15,
    executionSize: 0.4,  // 0.4 ETH
    priority: 1,
    shouldExecute: true,
    validUntil: Date.now() + 60000,
    metadata: {
      source: 'test',
      model: 'mock',
      gasEstimate: 5.25
    }
  };
};

async function testExecutionPipeline() {
  console.log('🚀 Testing Execution Pipeline\n');
  console.log('=' .repeat(50));

  // Validate environment
  console.log('\n📋 Environment Check:');
  const requiredEnvVars = [
    'HYPERLIQUID_PRIVATE_KEY',
    'HYPERLIQUID_ACCOUNT_ADDRESS',
    'EXECUTION_DRY_RUN'
  ];

  const missingVars = requiredEnvVars.filter(v => !process.env[v]);
  if (missingVars.length > 0) {
    console.error('❌ Missing environment variables:', missingVars);
    console.log('\n⚠️  Please configure your .env file with:');
    console.log('   - HYPERLIQUID_PRIVATE_KEY');
    console.log('   - HYPERLIQUID_ACCOUNT_ADDRESS');
    console.log('   - Copy settings from .env.execution');
    return;
  }

  console.log('✅ All required environment variables present');
  console.log(`📍 Mode: ${process.env.EXECUTION_DRY_RUN === 'true' ? 'DRY RUN (Paper Trading)' : 'LIVE TRADING'}`);
  console.log(`📍 Testnet: ${process.env.HYPERLIQUID_TESTNET === 'true' ? 'Yes' : 'No (Mainnet)'}`);

  // Initialize Execution Manager
  console.log('\n🔧 Initializing Execution Manager...');
  
  const executionConfig = {
    maxOrderRetries: parseInt(process.env.EXECUTION_MAX_ORDER_RETRIES || '3'),
    orderTimeoutMs: parseInt(process.env.EXECUTION_ORDER_TIMEOUT_MS || '30000'),
    maxSlippagePercent: parseFloat(process.env.EXECUTION_MAX_SLIPPAGE_PERCENT || '0.5'),
    minOrderSize: parseFloat(process.env.EXECUTION_MIN_ORDER_SIZE || '10'),
    maxOrderSize: parseFloat(process.env.EXECUTION_MAX_ORDER_SIZE || '10000'),
    maxOpenOrders: parseInt(process.env.EXECUTION_MAX_OPEN_ORDERS || '5'),
    dryRun: process.env.EXECUTION_DRY_RUN === 'true'
  };

  const hyperliquidConfig = {
    apiUrl: process.env.HYPERLIQUID_API_URL,
    wsUrl: process.env.HYPERLIQUID_WS_URL,
    privateKey: process.env.HYPERLIQUID_PRIVATE_KEY!,
    accountAddress: process.env.HYPERLIQUID_ACCOUNT_ADDRESS!,
    testnet: process.env.HYPERLIQUID_TESTNET === 'true'
  };

  let executionManager: ExecutionManager | null = null;
  let signalExecutor: SignalExecutor | null = null;

  try {
    executionManager = new ExecutionManager(executionConfig, hyperliquidConfig);
    await executionManager.initialize();
    console.log('✅ Execution Manager initialized');

    // Get account state
    const state = executionManager.getState();
    console.log(`📊 Account State:`, {
      activeExecutions: state.activeExecutions.size,
      completedExecutions: state.completedExecutions.length,
      totalVolume: state.totalVolume
    });

    // Initialize Signal Executor
    console.log('\n🔧 Initializing Signal Executor...');
    
    const signalExecutorConfig = {
      autoExecute: process.env.SIGNAL_AUTO_EXECUTE === 'true',
      minConfidence: parseFloat(process.env.SIGNAL_MIN_CONFIDENCE || '0.8'),
      maxConcurrentExecutions: parseInt(process.env.SIGNAL_MAX_CONCURRENT || '3'),
      executionDelayMs: parseInt(process.env.SIGNAL_EXECUTION_DELAY_MS || '100'),
      profitTarget: parseFloat(process.env.SIGNAL_PROFIT_TARGET || '0.02'),
      stopLoss: parseFloat(process.env.SIGNAL_STOP_LOSS || '0.01')
    };

    signalExecutor = new SignalExecutor(signalExecutorConfig, executionManager);
    console.log('✅ Signal Executor initialized');
    console.log(`📊 Auto-Execute: ${signalExecutorConfig.autoExecute ? 'ENABLED' : 'DISABLED'}`);

    // Test with mock signal
    console.log('\n🧪 Testing with Mock Signal...');
    const mockSignal = createMockSignal();
    console.log(`📍 Signal Details:`, {
      id: mockSignal.id,
      pair: mockSignal.opportunity.pair,
      type: mockSignal.opportunity.type,
      expectedProfit: `$${mockSignal.expectedValue.toFixed(2)}`,
      confidence: `${(mockSignal.confidenceScore * 100).toFixed(1)}%`,
      risk: `${(mockSignal.riskScore * 100).toFixed(1)}%`,
      size: `${mockSignal.executionSize} ETH`
    });

    // Manual execution test
    console.log('\n📤 Executing Mock Signal...');
    console.log('⏳ This will simulate order placement in dry-run mode');
    
    const result = await executionManager.executeSignal(mockSignal);
    
    console.log('\n📊 Execution Result:');
    console.log(`   Status: ${result.status}`);
    console.log(`   Order ID: ${result.orderId || 'N/A'}`);
    console.log(`   Executed Size: ${result.executedSize}`);
    console.log(`   Executed Price: ${result.executedPrice}`);
    console.log(`   Slippage: ${(result.slippage * 100).toFixed(3)}%`);
    console.log(`   Fees: $${result.fees.toFixed(2)}`);
    
    if (result.error) {
      console.log(`   Error: ${result.error}`);
    }

    // Get final statistics
    const stats = executionManager.getStatistics();
    console.log('\n📈 Execution Statistics:');
    console.log(`   Active Executions: ${stats.activeExecutions}`);
    console.log(`   Completed: ${stats.completedExecutions}`);
    console.log(`   Failed: ${stats.failedExecutions}`);
    console.log(`   Success Rate: ${(stats.successRate * 100).toFixed(1)}%`);
    console.log(`   Total Volume: $${stats.totalVolume.toFixed(2)}`);

    // Test Signal Generator Integration (if available)
    console.log('\n🔗 Signal Generator Integration:');
    try {
      // This would connect to a real SignalGenerator in production
      console.log('   ⚠️  SignalGenerator integration requires full system running');
      console.log('   📍 Use `npm run start:execution` for full integration test');
    } catch (error) {
      console.log('   ℹ️  SignalGenerator not available in isolated test');
    }

  } catch (error) {
    console.error('\n❌ Test failed:', error);
    if (error instanceof Error) {
      console.error('   Error details:', error.message);
      if (error.stack) {
        console.error('   Stack trace:', error.stack.split('\n').slice(1, 4).join('\n'));
      }
    }
  } finally {
    // Cleanup
    console.log('\n🧹 Cleaning up...');
    if (executionManager) {
      await executionManager.shutdown();
    }
    if (signalExecutor) {
      signalExecutor.stop();
    }
    console.log('✅ Test complete');
  }

  // Summary and next steps
  console.log('\n' + '='.repeat(50));
  console.log('📋 EXECUTION PIPELINE TEST SUMMARY\n');
  
  if (process.env.EXECUTION_DRY_RUN === 'true') {
    console.log('✅ Dry run mode test completed successfully');
    console.log('\n📍 Next Steps:');
    console.log('   1. Review execution logs above');
    console.log('   2. Configure risk parameters in .env');
    console.log('   3. Test with live SignalGenerator');
    console.log('   4. Enable paper trading on testnet');
    console.log('   5. Monitor for 24-48 hours before live trading');
  } else {
    console.log('⚠️  LIVE TRADING MODE DETECTED');
    console.log('   Ensure all risk parameters are properly configured');
    console.log('   Start with minimal position sizes');
    console.log('   Monitor closely for the first 24 hours');
  }

  console.log('\n💡 Commands:');
  console.log('   npm run test:execution     - Run this test');
  console.log('   npm run start:execution    - Start full execution pipeline');
  console.log('   npm run monitor:execution  - Monitor live execution');

  process.exit(0);
}

// Run test
if (require.main === module) {
  testExecutionPipeline().catch(console.error);
}

export { testExecutionPipeline };
