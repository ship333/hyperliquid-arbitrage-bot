/**
 * Regime-based risk management and parameter adjustments
 */

import { ArbInputs } from '../types/arbitrage.js';
import { FinBloomContext } from '../types/ml.js';
import { env } from '../config/env.js';

export class RegimePolicy {
  /**
   * Apply regime-based adjustments to arbitrage inputs
   */
  applyRegime(context: FinBloomContext, inputs: ArbInputs): ArbInputs {
    // Clone inputs to avoid mutation
    const adjusted = JSON.parse(JSON.stringify(inputs)) as ArbInputs;
    
    switch (context.regime) {
      case 'volatile':
        this.applyVolatileAdjustments(adjusted, context);
        break;
      case 'event':
        this.applyEventAdjustments(adjusted, context);
        break;
      case 'illiquid':
        this.applyIlliquidAdjustments(adjusted, context);
        break;
      case 'calm':
      default:
        this.applyCalmAdjustments(adjusted, context);
        break;
    }
    
    // Apply risk flags
    this.applyRiskFlags(adjusted, context.riskFlags);
    
    // Apply sensitivity haircut
    if (context.sensitivityBps) {
      adjusted.edgeBpsAtSignal = Math.max(0, adjusted.edgeBpsAtSignal - context.sensitivityBps);
    }
    
    return adjusted;
  }
  
  /**
   * Adjustments for volatile market regime
   */
  private applyVolatileAdjustments(inputs: ArbInputs, context: FinBloomContext): void {
    // Increase edge decay rate by 50%
    const currentDecay = env.EDGE_DECAY_BPS_PER_SEC;
    Object.assign(inputs, {
      edgeDecayBpsPerSec: currentDecay * 1.5
    });
    
    // Reduce maximum notional by 30%
    inputs.notionalUsdHint = Math.min(
      inputs.notionalUsdHint,
      env.MAX_NOTIONAL_USD * 0.7
    );
    
    // Add extra fee buffer
    inputs.config.totalFeesBps += 10;
    
    console.log('Applied volatile regime adjustments:', {
      reducedSize: inputs.notionalUsdHint,
      extraFees: 10,
      confidence: context.confidence
    });
  }
  
  /**
   * Adjustments for event-driven market regime
   */
  private applyEventAdjustments(inputs: ArbInputs, context: FinBloomContext): void {
    // Significantly increase edge decay
    const currentDecay = env.EDGE_DECAY_BPS_PER_SEC;
    Object.assign(inputs, {
      edgeDecayBpsPerSec: currentDecay * 2
    });
    
    // Reduce maximum notional by 50%
    inputs.notionalUsdHint = Math.min(
      inputs.notionalUsdHint,
      env.MAX_NOTIONAL_USD * 0.5
    );
    
    // Add significant fee buffer
    inputs.config.totalFeesBps += 20;
    
    // Increase minimum edge requirement
    const minEdge = 50; // 50 bps minimum
    if (inputs.edgeBpsAtSignal < minEdge) {
      inputs.edgeBpsAtSignal = 0; // Kill trade if edge too small
    }
    
    console.log('Applied event regime adjustments:', {
      reducedSize: inputs.notionalUsdHint,
      extraFees: 20,
      minEdgeRequired: minEdge
    });
  }
  
  /**
   * Adjustments for illiquid market regime
   */
  private applyIlliquidAdjustments(inputs: ArbInputs, context: FinBloomContext): void {
    // Increase slippage parameters (handled in optimizer)
    // Reduce fill probability (handled in optimizer)
    
    // Reduce maximum notional by 60%
    inputs.notionalUsdHint = Math.min(
      inputs.notionalUsdHint,
      env.MAX_NOTIONAL_USD * 0.4
    );
    
    // Add liquidity premium to fees
    inputs.config.totalFeesBps += 15;
    
    // Require higher edge for illiquid markets
    const minEdge = 30;
    if (inputs.edgeBpsAtSignal < minEdge) {
      inputs.edgeBpsAtSignal = Math.max(0, inputs.edgeBpsAtSignal - 10);
    }
    
    console.log('Applied illiquid regime adjustments:', {
      reducedSize: inputs.notionalUsdHint,
      liquidityPremium: 15
    });
  }
  
  /**
   * Adjustments for calm market regime
   */
  private applyCalmAdjustments(inputs: ArbInputs, context: FinBloomContext): void {
    // Calm markets allow for more aggressive sizing
    // But still apply some safety margins
    
    // Allow up to 90% of max notional
    inputs.notionalUsdHint = Math.min(
      inputs.notionalUsdHint,
      env.MAX_NOTIONAL_USD * 0.9
    );
    
    // Minimal fee adjustment
    inputs.config.totalFeesBps += 5;
    
    console.log('Applied calm regime adjustments:', {
      size: inputs.notionalUsdHint,
      confidence: context.confidence
    });
  }
  
  /**
   * Apply specific risk flag adjustments
   */
  private applyRiskFlags(inputs: ArbInputs, flags: string[]): void {
    for (const flag of flags) {
      switch (flag) {
        case 'stale_data':
          // Kill trade on stale data
          inputs.edgeBpsAtSignal = 0;
          console.warn('Trade killed due to stale data');
          break;
          
        case 'high_latency':
          // Double edge decay rate
          const decay = env.EDGE_DECAY_BPS_PER_SEC;
          Object.assign(inputs, {
            edgeDecayBpsPerSec: decay * 2
          });
          break;
          
        case 'elevated_mvo':
          // Reduce size by 20%
          inputs.notionalUsdHint *= 0.8;
          break;
          
        case 'exchange_news':
          // Add extra fee buffer
          inputs.config.totalFeesBps += 10;
          break;
          
        case 'model_unavailable':
          // Conservative approach when ML models fail
          inputs.notionalUsdHint *= 0.5;
          inputs.config.totalFeesBps += 15;
          break;
      }
    }
  }
  
  /**
   * Get risk limits for current regime
   */
  getRiskLimits(regime: FinBloomContext['regime']): {
    maxSizeUsd: number;
    minEdgeBps: number;
    maxSlippageBps: number;
    minPSuccess: number;
  } {
    switch (regime) {
      case 'volatile':
        return {
          maxSizeUsd: env.MAX_NOTIONAL_USD * 0.7,
          minEdgeBps: 30,
          maxSlippageBps: 80,
          minPSuccess: 0.8
        };
        
      case 'event':
        return {
          maxSizeUsd: env.MAX_NOTIONAL_USD * 0.5,
          minEdgeBps: 50,
          maxSlippageBps: 60,
          minPSuccess: 0.85
        };
        
      case 'illiquid':
        return {
          maxSizeUsd: env.MAX_NOTIONAL_USD * 0.4,
          minEdgeBps: 30,
          maxSlippageBps: 100,
          minPSuccess: 0.75
        };
        
      case 'calm':
      default:
        return {
          maxSizeUsd: env.MAX_NOTIONAL_USD * 0.9,
          minEdgeBps: 15,
          maxSlippageBps: 100,
          minPSuccess: 0.75
        };
    }
  }
  
  /**
   * Check if trade should be allowed given regime
   */
  shouldAllowTrade(
    context: FinBloomContext,
    evAdjUsd: number,
    pSuccess: number
  ): boolean {
    // Never trade on stale data
    if (context.riskFlags.includes('stale_data')) {
      return false;
    }
    
    // Require higher thresholds for risky regimes
    const limits = this.getRiskLimits(context.regime);
    
    if (pSuccess < limits.minPSuccess) {
      console.log(`Trade blocked: pSuccess ${pSuccess} < ${limits.minPSuccess}`);
      return false;
    }
    
    // Require positive risk-adjusted EV
    if (evAdjUsd <= 0) {
      console.log(`Trade blocked: evAdjUsd ${evAdjUsd} <= 0`);
      return false;
    }
    
    // Additional checks for high-risk regimes
    if (context.regime === 'event' && evAdjUsd < 10) {
      console.log(`Trade blocked: event regime requires evAdjUsd > 10`);
      return false;
    }
    
    return true;
  }
}

// Export singleton instance
export const regimePolicy = new RegimePolicy();
