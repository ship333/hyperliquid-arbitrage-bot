/**
 * Environment configuration with validation
 */

import { z } from 'zod';
import * as dotenv from 'dotenv';

// Load environment variables
dotenv.config();

// Environment schema
const envSchema = z.object({
  // GoldRush API
  GOLDRUSH_HTTP_URL: z.string().url(),
  GOLDRUSH_WS_URL: z.string().url(),
  GOLDRUSH_API_KEY: z.string().min(1),
  
  // Blockchain
  RPC_URL: z.string().url(),
  CHAIN_ID: z.coerce.number(),
  
  // ML Models
  MODEL_FINBLOOM_ENDPOINT: z.string().url(),
  MODEL_FINBLOOM_KEY: z.string().min(1),
  MODEL_DEEPSEEK_ENDPOINT: z.string().url(),
  MODEL_DEEPSEEK_KEY: z.string().min(1),
  
  // Trading Parameters
  EDGE_DECAY_BPS_PER_SEC: z.coerce.number().default(3),
  BASE_FILL_PROB: z.coerce.number().min(0).max(1).default(0.9),
  FILL_THETA: z.coerce.number().default(0.15),
  SLIP_ALPHA: z.coerce.number().default(1.25),
  SLIP_K: z.coerce.number().default(0.9),
  
  // Fees
  FLASH_FEE_BPS: z.coerce.number().default(4),
  REFERRAL_BPS: z.coerce.number().default(0),
  FLASH_FIXED_USD: z.coerce.number().default(0),
  EXECUTOR_FEE_USD: z.coerce.number().default(0),
  
  // Risk Parameters
  RISK_AVERSION_LAMBDA: z.coerce.number().default(0.0),
  GAS_USD_MEAN: z.coerce.number().default(1.5),
  GAS_USD_STD: z.coerce.number().default(0.3),
  ADVERSE_USD_MEAN: z.coerce.number().default(0.0),
  ADVERSE_USD_STD: z.coerce.number().default(0.3),
  MEV_PENALTY_USD: z.coerce.number().default(0),
  MAX_NOTIONAL_USD: z.coerce.number().default(10000),
  
  // Operational
  LOG_LEVEL: z.enum(['debug', 'info', 'warn', 'error']).default('info'),
  NODE_ENV: z.enum(['development', 'production', 'test']).default('development'),
  
  // API Configuration
  TOTAL_FEES_BPS: z.coerce.number().default(30),
  ALLOWED_ORIGINS: z.string().optional(),
  
  // Storage
  DATA_DIR: z.string().optional(),

  // Strategy Approval Policy
  MIN_BACKTEST_HOURS: z.coerce.number().default(24),
  MIN_P_SUCCESS: z.coerce.number().min(0).max(1).default(0.75),
  MIN_EV_ADJ_USD: z.coerce.number().default(0),
  MAX_DRAWDOWN: z.coerce.number().default(Number.POSITIVE_INFINITY),
});

// Parse and validate environment
const parseEnv = () => {
  try {
    return envSchema.parse(process.env);
  } catch (error) {
    if (error instanceof z.ZodError) {
      console.error('❌ Invalid environment variables:');
      error.errors.forEach(err => {
        console.error(`  ${err.path.join('.')}: ${err.message}`);
      });
      process.exit(1);
    }
    throw error;
  }
};

// Export validated config
export const env = parseEnv();
// Backwards compatibility: some modules import { ENV }
export const ENV = env;

// Export type for use in other modules
export type Env = z.infer<typeof envSchema>;
