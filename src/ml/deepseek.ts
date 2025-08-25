/**
 * DeepSeek ML adapter for mathematical optimization
 */

import axios, { AxiosInstance } from 'axios';
import { MarketSnapshot } from '../types/market.js';
import { ArbInputs, OptimizationResult } from '../types/arbitrage.js';
import { FinBloomContext } from '../types/ml.js';
import { env } from '../config/env.js';

export class DeepSeekOptimizer {
  private client: AxiosInstance;
  private readonly MAX_RETRIES = 3;
  private readonly TIMEOUT_MS = 10000;

  constructor() {
    this.client = axios.create({
      baseURL: env.MODEL_DEEPSEEK_ENDPOINT,
      headers: {
        'Authorization': `Bearer ${env.MODEL_DEEPSEEK_KEY}`,
        'Content-Type': 'application/json',
      },
      timeout: this.TIMEOUT_MS,
    });
  }

  /**
   * Optimize arbitrage parameters using DeepSeek
   */
  async optimizeArb(
    snapshot: MarketSnapshot,
    inputs: ArbInputs,
    context: FinBloomContext
  ): Promise<OptimizationResult> {
    // First try DeepSeek optimization
    try {
      const prompt = this.buildOptimizationPrompt(snapshot, inputs, context);
      const response = await this.callModel(prompt);
      return this.parseOptimizationResponse(response, snapshot, inputs);
    } catch (error) {
      console.warn('DeepSeek optimization failed, using local computation:', error);
      // Fallback to local optimization
      return this.computeLocalOptimization(snapshot, inputs, context);
    }
  }

  /**
   * Local optimization implementation (fallback)
   */
  private computeLocalOptimization(
    snapshot: MarketSnapshot,
    inputs: ArbInputs,
    context: FinBloomContext
  ): OptimizationResult {
    // Calculate effective edge after latency decay
    const latencySec = (snapshot.wsLatencyMs || 0) / 1000;
    const edgeDecay = env.EDGE_DECAY_BPS_PER_SEC * latencySec;
    const effectiveEdgeBps = Math.max(0, inputs.edgeBpsAtSignal - edgeDecay);

    // Apply regime adjustments
    let adjustedEdge = effectiveEdgeBps;
    if (context.regime === 'volatile' || context.regime === 'event') {
      adjustedEdge -= context.sensitivityBps || 0;
    }

    // Calculate fill probability
    const pSuccess = env.BASE_FILL_PROB * Math.exp(-env.FILL_THETA * latencySec);

    // Find optimal size through line search
    const sizes = this.generateSizeGrid(100, env.MAX_NOTIONAL_USD, 20);
    let bestResult: OptimizationResult | null = null;
    let bestEvAdj = -Infinity;

    for (const sizeUsd of sizes) {
      // Calculate slippage
      const liquidityRef = this.estimateLiquidity(snapshot);
      const slippageBps = env.SLIP_K * Math.pow(sizeUsd / liquidityRef, env.SLIP_ALPHA);
      
      // Calculate costs
      const totalFeesBps = inputs.config.totalFeesBps + 
                           inputs.config.flashFeeBps + 
                           inputs.config.referralBps;
      const fixedCosts = inputs.config.flashFixedUsd + 
                         inputs.config.executorFeeUsd;
      const gasUsd = this.sampleGasCost();
      
      // Calculate profit
      const grossProfitBps = adjustedEdge - slippageBps - totalFeesBps;
      const grossProfitUsd = (grossProfitBps / 10000) * sizeUsd;
      const netProfitUsd = grossProfitUsd - fixedCosts - gasUsd;
      
      // Calculate EV with failure probability
      const evUsd = netProfitUsd * pSuccess - (1 - pSuccess) * gasUsd;
      
      // Mean-variance adjustment
      const variance = this.calculateVariance(netProfitUsd, gasUsd);
      const evAdjUsd = evUsd - env.RISK_AVERSION_LAMBDA * variance;
      
      // Track best result
      if (evAdjUsd > bestEvAdj && netProfitUsd > 0) {
        bestEvAdj = evAdjUsd;
        bestResult = {
          sizeUsd,
          pSuccess,
          evUsd,
          evAdjUsd,
          slipBpsEff: slippageBps,
          breakevenBps: totalFeesBps + (fixedCosts + gasUsd) * 10000 / sizeUsd,
          gasUsd,
          constraintsHit: this.checkConstraints(sizeUsd, slippageBps, pSuccess),
          optimalPath: {
            buyVenue: this.selectBuyVenue(snapshot),
            sellVenue: this.selectSellVenue(snapshot),
            estimatedFillPrice: this.estimateFillPrice(snapshot, sizeUsd),
          },
        };
      }
    }

    // Return best result or zero trade
    return bestResult || {
      sizeUsd: 0,
      pSuccess: 0,
      evUsd: 0,
      evAdjUsd: 0,
      slipBpsEff: 0,
      breakevenBps: Infinity,
      gasUsd: 0,
      constraintsHit: ['no_profitable_size'],
    };
  }

  /**
   * Build optimization prompt for DeepSeek
   */
  private buildOptimizationPrompt(
    snapshot: MarketSnapshot,
    inputs: ArbInputs,
    context: FinBloomContext
  ): string {
    return `You are DeepSeek, a mathematical optimizer for arbitrage trading.

MARKET DATA:
- Pair: ${inputs.base}/${inputs.quote}
- Initial Edge: ${inputs.edgeBpsAtSignal} bps
- WS Latency: ${snapshot.wsLatencyMs || 0}ms
- Volatility: ${snapshot.volatility || 'N/A'}%
- Market Regime: ${context.regime}
- Risk Flags: ${context.riskFlags.join(', ')}

PARAMETERS:
- Edge Decay: ${env.EDGE_DECAY_BPS_PER_SEC} bps/sec
- Base Fill Prob: ${env.BASE_FILL_PROB}
- Fill Theta: ${env.FILL_THETA}
- Slip Alpha: ${env.SLIP_ALPHA}
- Slip K: ${env.SLIP_K}
- Risk Aversion: ${env.RISK_AVERSION_LAMBDA}

FEES:
- Total Trading: ${inputs.config.totalFeesBps} bps
- Flash Loan: ${inputs.config.flashFeeBps} bps + $${inputs.config.flashFixedUsd}
- Executor: $${inputs.config.executorFeeUsd}

CONSTRAINTS:
- Max Size: $${env.MAX_NOTIONAL_USD}
- Min P(Success): 0.75
- Max Slippage: 100 bps

TASK:
Optimize size to maximize risk-adjusted EV. Use exponential fill probability decay and power-law slippage.

Return ONLY valid JSON:
{
  "sizeUsd": 0,
  "pSuccess": 0,
  "evUsd": 0,
  "evAdjUsd": 0,
  "slipBpsEff": 0,
  "breakevenBps": 0,
  "gasUsd": 0,
  "constraintsHit": [],
  "reasoning": "Brief explanation"
}`;
  }

  /**
   * Call DeepSeek model API
   */
  private async callModel(prompt: string): Promise<any> {
    let lastError: any;
    
    for (let attempt = 1; attempt <= this.MAX_RETRIES; attempt++) {
      try {
        const response = await this.client.post('/chat/completions', {
          model: 'deepseek-math',
          messages: [
            {
              role: 'system',
              content: 'You are DeepSeek, a mathematical optimizer. Provide precise numerical calculations.',
            },
            {
              role: 'user',
              content: prompt,
            },
          ],
          temperature: 0.1,
          max_tokens: 1000,
        });

        if (response.data?.choices?.[0]?.message?.content) {
          const content = response.data.choices[0].message.content;
          // Extract JSON from response
          const jsonMatch = content.match(/\{[\s\S]*\}/);
          if (jsonMatch) {
            return JSON.parse(jsonMatch[0]);
          }
        }
      } catch (error) {
        lastError = error;
        console.warn(`DeepSeek attempt ${attempt} failed:`, error);
        
        if (attempt < this.MAX_RETRIES) {
          await new Promise(resolve => setTimeout(resolve, 2000 * attempt));
        }
      }
    }
    
    throw lastError;
  }

  /**
   * Parse and validate optimization response
   */
  private parseOptimizationResponse(
    response: any,
    snapshot: MarketSnapshot,
    inputs: ArbInputs
  ): OptimizationResult {
    // Validate and sanitize response
    const result: OptimizationResult = {
      sizeUsd: Math.min(env.MAX_NOTIONAL_USD, Math.max(0, response.sizeUsd || 0)),
      pSuccess: Math.min(1, Math.max(0, response.pSuccess || 0)),
      evUsd: response.evUsd || 0,
      evAdjUsd: response.evAdjUsd || 0,
      slipBpsEff: Math.max(0, response.slipBpsEff || 0),
      breakevenBps: Math.max(0, response.breakevenBps || 0),
      gasUsd: Math.max(0, response.gasUsd || env.GAS_USD_MEAN),
      constraintsHit: Array.isArray(response.constraintsHit) ? response.constraintsHit : [],
    };

    // Add optimal path
    result.optimalPath = {
      buyVenue: this.selectBuyVenue(snapshot),
      sellVenue: this.selectSellVenue(snapshot),
      estimatedFillPrice: this.estimateFillPrice(snapshot, result.sizeUsd),
    };

    return result;
  }

  // Helper methods

  private generateSizeGrid(minSize: number, maxSize: number, steps: number): number[] {
    const sizes: number[] = [];
    const logMin = Math.log(minSize);
    const logMax = Math.log(maxSize);
    const logStep = (logMax - logMin) / (steps - 1);
    
    for (let i = 0; i < steps; i++) {
      sizes.push(Math.exp(logMin + i * logStep));
    }
    
    return sizes;
  }

  private estimateLiquidity(snapshot: MarketSnapshot): number {
    const totalDepth = snapshot.quotes.reduce((sum, q) => sum + q.depthUsd, 0);
    return Math.max(1000, totalDepth * 0.1); // Conservative: 10% of visible depth
  }

  private sampleGasCost(): number {
    // Sample from normal distribution
    const u1 = Math.random();
    const u2 = Math.random();
    const z = Math.sqrt(-2 * Math.log(u1)) * Math.cos(2 * Math.PI * u2);
    return Math.max(0, env.GAS_USD_MEAN + env.GAS_USD_STD * z);
  }

  private calculateVariance(profit: number, gas: number): number {
    // Simplified variance calculation
    const profitVar = Math.pow(profit * 0.1, 2); // 10% profit uncertainty
    const gasVar = Math.pow(env.GAS_USD_STD, 2);
    const adverseVar = Math.pow(env.ADVERSE_USD_STD, 2);
    return profitVar + gasVar + adverseVar;
  }

  private checkConstraints(size: number, slippage: number, pSuccess: number): string[] {
    const constraints: string[] = [];
    
    if (size > env.MAX_NOTIONAL_USD) {
      constraints.push('max_size_exceeded');
    }
    if (slippage > 100) {
      constraints.push('excessive_slippage');
    }
    if (pSuccess < 0.75) {
      constraints.push('low_success_probability');
    }
    
    return constraints;
  }

  private selectBuyVenue(snapshot: MarketSnapshot): string {
    const sorted = [...snapshot.quotes].sort((a, b) => 
      a.price * (1 + a.feeBps / 10000) - b.price * (1 + b.feeBps / 10000)
    );
    return sorted[0]?.dex || 'PRJX';
  }

  private selectSellVenue(snapshot: MarketSnapshot): string {
    const sorted = [...snapshot.quotes].sort((a, b) => 
      b.price * (1 - b.feeBps / 10000) - a.price * (1 - a.feeBps / 10000)
    );
    return sorted[0]?.dex || 'HyperSwap';
  }

  private estimateFillPrice(snapshot: MarketSnapshot, sizeUsd: number): number {
    const avgPrice = snapshot.quotes.reduce((sum, q) => sum + q.price, 0) / snapshot.quotes.length;
    const slippageFactor = 1 + (sizeUsd / 10000) * 0.001; // Simple linear slippage estimate
    return avgPrice * slippageFactor;
  }
}

// Export singleton instance
export const deepSeekOptimizer = new DeepSeekOptimizer();
