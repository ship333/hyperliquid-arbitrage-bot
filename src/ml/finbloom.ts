/**
 * FinBloom ML adapter for market context and risk analysis
 */

import axios, { AxiosInstance } from 'axios';
import { MarketSnapshot } from '../types/market.js';
import { FinBloomContext } from '../types/ml.js';
import { env } from '../config/env.js';

export class FinBloomAdapter {
  private client: AxiosInstance;
  private readonly MAX_RETRIES = 3;
  private readonly TIMEOUT_MS = 5000;

  constructor() {
    this.client = axios.create({
      baseURL: env.MODEL_FINBLOOM_ENDPOINT,
      headers: {
        'Authorization': `Bearer ${env.MODEL_FINBLOOM_KEY}`,
        'Content-Type': 'application/json',
      },
      timeout: this.TIMEOUT_MS,
    });
  }

  /**
   * Analyze market context and generate risk assessment
   */
  async summarizeContext(snapshot: MarketSnapshot): Promise<FinBloomContext> {
    const prompt = this.buildPrompt(snapshot);
    
    try {
      const response = await this.callModel(prompt);
      return this.parseResponse(response, snapshot);
    } catch (error) {
      console.error('FinBloom analysis failed:', error);
      // Return conservative defaults on failure
      return this.getDefaultContext(snapshot);
    }
  }

  /**
   * Build structured prompt for FinBloom
   */
  private buildPrompt(snapshot: MarketSnapshot): string {
    const dataAge = Date.now() - snapshot.timestamp;
    const isStale = dataAge > 3000;
    
    const quotes = snapshot.quotes.map(q => ({
      dex: q.dex,
      price: q.price.toFixed(4),
      depth: q.depthUsd.toFixed(0),
      feeBps: q.feeBps,
      age: Date.now() - q.ts,
    }));

    const prompt = `You are FinBloom, a financial market analyzer. Analyze the following market data and classify the regime, identify risk flags, and provide a brief narrative.

MARKET DATA:
- Quotes: ${JSON.stringify(quotes, null, 2)}
- Reference Price: ${snapshot.refPriceUsd?.toFixed(2) || 'N/A'}
- Volatility (24h): ${snapshot.volatility?.toFixed(2) || 'N/A'}%
- Funding Rate: ${snapshot.funding?.toFixed(4) || 'N/A'}
- WS Latency: ${snapshot.wsLatencyMs || 'N/A'}ms
- Data Age: ${dataAge}ms${isStale ? ' (STALE)' : ''}

TASK:
1. Classify regime as one of: calm, volatile, event, illiquid
2. Identify risk flags that should affect arbitrage aggressiveness
3. Provide a 2-3 sentence narrative summary
4. Suggest sensitivity adjustment in basis points (0-100)

Return ONLY valid JSON matching this structure:
{
  "regime": "calm|volatile|event|illiquid",
  "riskFlags": ["flag1", "flag2"],
  "narrative": "Brief market assessment...",
  "sensitivityBps": 0,
  "confidence": 0.0
}`;

    return prompt;
  }

  /**
   * Call FinBloom model API
   */
  private async callModel(prompt: string): Promise<any> {
    let lastError: any;
    
    for (let attempt = 1; attempt <= this.MAX_RETRIES; attempt++) {
      try {
        const response = await this.client.post('/chat/completions', {
          model: 'finbloom-latest',
          messages: [
            {
              role: 'system',
              content: 'You are FinBloom, a precise financial market analyzer. Always respond with valid JSON only.',
            },
            {
              role: 'user',
              content: prompt,
            },
          ],
          temperature: 0.3,
          max_tokens: 500,
          response_format: { type: 'json_object' },
        });

        if (response.data?.choices?.[0]?.message?.content) {
          return JSON.parse(response.data.choices[0].message.content);
        }
      } catch (error) {
        lastError = error;
        console.warn(`FinBloom attempt ${attempt} failed:`, error);
        
        if (attempt < this.MAX_RETRIES) {
          await new Promise(resolve => setTimeout(resolve, 1000 * attempt));
        }
      }
    }
    
    throw lastError;
  }

  /**
   * Parse and validate model response
   */
  private parseResponse(response: any, snapshot: MarketSnapshot): FinBloomContext {
    // Validate regime
    const validRegimes = ['calm', 'volatile', 'event', 'illiquid'];
    const regime = validRegimes.includes(response.regime) 
      ? response.regime 
      : this.inferRegime(snapshot);

    // Validate risk flags
    const riskFlags = Array.isArray(response.riskFlags) 
      ? response.riskFlags.filter((f: any) => typeof f === 'string')
      : [];

    // Add data staleness flag if needed
    const dataAge = Date.now() - snapshot.timestamp;
    if (dataAge > 3000 && !riskFlags.includes('stale_data')) {
      riskFlags.push('stale_data');
    }

    // Add high latency flag
    if (snapshot.wsLatencyMs && snapshot.wsLatencyMs > 100) {
      riskFlags.push('high_latency');
    }

    return {
      regime: regime as FinBloomContext['regime'],
      riskFlags,
      narrative: response.narrative || 'Market analysis unavailable',
      sensitivityBps: Math.min(100, Math.max(0, response.sensitivityBps || 0)),
      confidence: Math.min(1, Math.max(0, response.confidence || 0.5)),
      timestamp: Date.now(),
    };
  }

  /**
   * Infer regime from market data
   */
  private inferRegime(snapshot: MarketSnapshot): FinBloomContext['regime'] {
    // High volatility check
    if (snapshot.volatility && snapshot.volatility > 5) {
      return 'volatile';
    }

    // Liquidity check
    const totalDepth = snapshot.quotes.reduce((sum, q) => sum + q.depthUsd, 0);
    if (totalDepth < 10000) {
      return 'illiquid';
    }

    // Wide spreads indicate event or illiquid
    const prices = snapshot.quotes.map(q => q.price);
    const spread = (Math.max(...prices) - Math.min(...prices)) / Math.min(...prices);
    if (spread > 0.01) {
      return 'event';
    }

    return 'calm';
  }

  /**
   * Get conservative default context
   */
  private getDefaultContext(snapshot: MarketSnapshot): FinBloomContext {
    const regime = this.inferRegime(snapshot);
    const riskFlags: string[] = ['model_unavailable'];
    
    // Add data quality flags
    const dataAge = Date.now() - snapshot.timestamp;
    if (dataAge > 3000) {
      riskFlags.push('stale_data');
    }
    
    if (!snapshot.wsLatencyMs || snapshot.wsLatencyMs > 100) {
      riskFlags.push('high_latency');
    }

    return {
      regime,
      riskFlags,
      narrative: 'FinBloom unavailable, using conservative defaults based on market metrics',
      sensitivityBps: regime === 'calm' ? 10 : 50,
      confidence: 0.3,
      timestamp: Date.now(),
    };
  }
}

// Export singleton instance
export const finBloomAdapter = new FinBloomAdapter();
