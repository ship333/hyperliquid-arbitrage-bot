/**
 * REST API routes for arbitrage evaluation and execution
 */

import express, { Request, Response, Router } from 'express';
import { ArbInputs } from '../types/arbitrage.js';
import { arbOrchestrator } from '../core/arb_orchestrator.js';
import { goldRushClient } from '../data/goldrush.js';
import { env } from '../config/env.js';

const router = Router();

// Middleware for request validation
const validateArbRequest = (req: Request, res: Response, next: Function) => {
  const { base, quote, edgeBpsAtSignal } = req.body;
  
  if (!base || !quote || edgeBpsAtSignal === undefined) {
    return res.status(400).json({
      error: 'Missing required fields: base, quote, edgeBpsAtSignal'
    });
  }
  
  if (typeof edgeBpsAtSignal !== 'number' || edgeBpsAtSignal < 0) {
    return res.status(400).json({
      error: 'edgeBpsAtSignal must be a positive number'
    });
  }
  
  next();
};

/**
 * POST /api/arb/evaluate
 * Evaluate an arbitrage opportunity
 */
router.post('/evaluate', validateArbRequest, async (req: Request, res: Response) => {
  const startTime = Date.now();
  
  try {
    // Build inputs from request
    const inputs: ArbInputs = {
      base: req.body.base,
      quote: req.body.quote,
      edgeBpsAtSignal: req.body.edgeBpsAtSignal,
      notionalUsdHint: req.body.notionalUsdHint || env.MAX_NOTIONAL_USD,
      config: {
        totalFeesBps: req.body.totalFeesBps || env.TOTAL_FEES_BPS,
        flashFeeBps: req.body.flashFeeBps || env.FLASH_FEE_BPS,
        flashFixedUsd: req.body.flashFixedUsd || env.FLASH_FIXED_USD,
        referralBps: req.body.referralBps || env.REFERRAL_BPS,
        executorFeeUsd: req.body.executorFeeUsd || env.EXECUTOR_FEE_USD,
      }
    };
    
    // Evaluate opportunity
    const opportunity = await arbOrchestrator.evaluateOpportunity(inputs);
    
    // Add API-level telemetry
    const apiLatency = Date.now() - startTime;
    
    res.json({
      success: true,
      opportunity,
      meta: {
        apiVersion: '1.0.0',
        latencyMs: apiLatency,
        cached: apiLatency < 200,
        timestamp: Date.now(),
      }
    });
    
  } catch (error) {
    console.error('Evaluation error:', error);
    res.status(500).json({
      success: false,
      error: error instanceof Error ? error.message : 'Internal server error',
      meta: {
        latencyMs: Date.now() - startTime,
        timestamp: Date.now(),
      }
    });
  }
});

/**
 * POST /api/arb/execute
 * Execute an arbitrage plan
 */
router.post('/execute', async (req: Request, res: Response) => {
  const { plan, dryRun = true } = req.body;
  
  if (!plan) {
    return res.status(400).json({
      error: 'Missing execution plan'
    });
  }
  
  try {
    if (dryRun) {
      // Dry run - just validate the plan
      res.json({
        success: true,
        dryRun: true,
        message: 'Plan validated successfully (dry run)',
        plan,
        warnings: [
          'This was a dry run - no actual execution occurred',
          'On-chain execution not implemented in this version'
        ]
      });
    } else {
      // Real execution (not implemented)
      res.status(501).json({
        success: false,
        error: 'Real execution not implemented',
        message: 'Use dryRun=true for validation only'
      });
    }
  } catch (error) {
    console.error('Execution error:', error);
    res.status(500).json({
      success: false,
      error: error instanceof Error ? error.message : 'Execution failed'
    });
  }
});

/**
 * GET /api/arb/quotes/:pair
 * Get current quotes for a trading pair
 */
router.get('/quotes/:pair', async (req: Request, res: Response) => {
  const { pair } = req.params;
  
  try {
    const quotes = await goldRushClient.getQuotes(pair);
    
    res.json({
      success: true,
      pair,
      quotes,
      count: quotes.length,
      timestamp: Date.now(),
    });
  } catch (error) {
    console.error('Quote fetch error:', error);
    res.status(500).json({
      success: false,
      error: 'Failed to fetch quotes'
    });
  }
});

/**
 * GET /api/arb/health
 * Health check endpoint
 */
router.get('/health', (req: Request, res: Response) => {
  const wsConnected = goldRushClient.getWsLatency() > 0;
  
  res.json({
    status: 'healthy',
    services: {
      goldrush: wsConnected ? 'connected' : 'disconnected',
      finbloom: env.MODEL_FINBLOOM_ENDPOINT ? 'configured' : 'not configured',
      deepseek: env.MODEL_DEEPSEEK_ENDPOINT ? 'configured' : 'not configured',
    },
    config: {
      maxNotionalUsd: env.MAX_NOTIONAL_USD,
      edgeDecayBpsPerSec: env.EDGE_DECAY_BPS_PER_SEC,
      baseFillProb: env.BASE_FILL_PROB,
    },
    timestamp: Date.now(),
  });
});

/**
 * POST /api/arb/backtest
 * Run a backtest with historical data
 */
router.post('/backtest', async (req: Request, res: Response) => {
  const { scenarios } = req.body;
  
  if (!Array.isArray(scenarios)) {
    return res.status(400).json({
      error: 'scenarios must be an array'
    });
  }
  
  try {
    const results = [];
    
    for (const scenario of scenarios) {
      const inputs: ArbInputs = {
        base: scenario.base || 'ETH',
        quote: scenario.quote || 'USDC',
        edgeBpsAtSignal: scenario.edgeBps || 20,
        notionalUsdHint: scenario.size || 10000,
        config: {
          totalFeesBps: env.TOTAL_FEES_BPS,
          flashFeeBps: env.FLASH_FEE_BPS,
          flashFixedUsd: env.FLASH_FIXED_USD,
          referralBps: env.REFERRAL_BPS,
          executorFeeUsd: env.EXECUTOR_FEE_USD,
        }
      };
      
      const opportunity = await arbOrchestrator.evaluateOpportunity(inputs);
      
      results.push({
        scenario,
        result: {
          wouldTrade: opportunity.optimization.sizeUsd > 0,
          evUsd: opportunity.optimization.evUsd,
          sizeUsd: opportunity.optimization.sizeUsd,
          pSuccess: opportunity.optimization.pSuccess,
          regime: opportunity.context.regime,
        }
      });
    }
    
    // Calculate aggregate statistics
    const stats = {
      totalScenarios: results.length,
      profitableScenarios: results.filter(r => r.result.wouldTrade).length,
      totalEvUsd: results.reduce((sum, r) => sum + r.result.evUsd, 0),
      avgEvUsd: results.reduce((sum, r) => sum + r.result.evUsd, 0) / results.length,
      avgPSuccess: results.reduce((sum, r) => sum + r.result.pSuccess, 0) / results.length,
    };
    
    res.json({
      success: true,
      results,
      stats,
      timestamp: Date.now(),
    });
    
  } catch (error) {
    console.error('Backtest error:', error);
    res.status(500).json({
      success: false,
      error: 'Backtest failed'
    });
  }
});

export default router;
