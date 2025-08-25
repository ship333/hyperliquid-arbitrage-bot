/**
 * Market data aggregator and snapshot builder
 */

import { DexQuote, MarketSnapshot } from '../types/market.js';
import { goldRushClient } from './goldrush.js';

export class MarketAggregator {
  private readonly STALE_DATA_THRESHOLD_MS = 2000; // 2 seconds

  /**
   * Build a complete market snapshot for a trading pair
   */
  async buildSnapshot(pair: string): Promise<MarketSnapshot> {
    const startTime = Date.now();
    
    // Fetch data in parallel
    const [quotes, refData] = await Promise.all([
      goldRushClient.getQuotes(pair),
      goldRushClient.getReferenceData(pair),
    ]);

    // Check for stale quotes
    const now = Date.now();
    const freshQuotes = quotes.filter(q => {
      const age = now - q.ts;
      if (age > this.STALE_DATA_THRESHOLD_MS) {
        console.warn(`Stale quote detected for ${q.dex}: age=${age}ms`);
        return false;
      }
      return true;
    });

    if (freshQuotes.length === 0) {
      throw new Error(`No fresh quotes available for ${pair}`);
    }

    // Calculate cross-venue edge
    const { bestBuy, bestSell, edgeBps } = this.calculateCrossVenueEdge(freshQuotes);

    const snapshot: MarketSnapshot = {
      quotes: freshQuotes,
      refPriceUsd: refData.ref_price_usd,
      volatility: refData.volatility_24h,
      funding: refData.funding_rate,
      wsLatencyMs: goldRushClient.getWsLatency(),
      timestamp: now,
    };

    // Add metadata
    Object.assign(snapshot, {
      bestBuyVenue: bestBuy?.dex,
      bestSellVenue: bestSell?.dex,
      crossVenueEdgeBps: edgeBps,
      computeTimeMs: Date.now() - startTime,
    });

    return snapshot;
  }

  /**
   * Calculate the best cross-venue arbitrage opportunity
   */
  calculateCrossVenueEdge(quotes: DexQuote[]): {
    bestBuy: DexQuote | null;
    bestSell: DexQuote | null;
    edgeBps: number;
  } {
    if (quotes.length < 2) {
      return { bestBuy: null, bestSell: null, edgeBps: 0 };
    }

    // Find best buy (lowest ask) and best sell (highest bid)
    let bestBuy: DexQuote | null = null;
    let bestSell: DexQuote | null = null;

    for (const quote of quotes) {
      // Adjust price for fees
      const buyPrice = quote.price * (1 + quote.feeBps / 10000);
      const sellPrice = quote.price * (1 - quote.feeBps / 10000);

      if (!bestBuy || buyPrice < bestBuy.price * (1 + bestBuy.feeBps / 10000)) {
        bestBuy = quote;
      }

      if (!bestSell || sellPrice > bestSell.price * (1 - bestSell.feeBps / 10000)) {
        bestSell = quote;
      }
    }

    if (!bestBuy || !bestSell || bestBuy.dex === bestSell.dex) {
      return { bestBuy, bestSell, edgeBps: 0 };
    }

    // Calculate edge in basis points
    const buyPriceAdjusted = bestBuy.price * (1 + bestBuy.feeBps / 10000);
    const sellPriceAdjusted = bestSell.price * (1 - bestSell.feeBps / 10000);
    const edgeBps = ((sellPriceAdjusted - buyPriceAdjusted) / buyPriceAdjusted) * 10000;

    return { bestBuy, bestSell, edgeBps: Math.max(0, edgeBps) };
  }

  /**
   * Get aggregated depth at a price level
   */
  getAggregatedDepth(quotes: DexQuote[], priceLevel: number, tolerance: number = 0.001): number {
    return quotes.reduce((total, quote) => {
      const priceDiff = Math.abs(quote.price - priceLevel) / priceLevel;
      if (priceDiff <= tolerance) {
        return total + quote.depthUsd;
      }
      return total;
    }, 0);
  }

  /**
   * Check if market data is fresh enough for trading
   */
  isDataFresh(snapshot: MarketSnapshot): boolean {
    const age = Date.now() - snapshot.timestamp;
    return age < this.STALE_DATA_THRESHOLD_MS;
  }

  /**
   * Calculate effective liquidity for a given size
   */
  calculateEffectiveLiquidity(quotes: DexQuote[], sizeUsd: number): {
    effectivePrice: number;
    slippageBps: number;
    availableLiquidity: number;
  } {
    // Sort quotes by price (best first)
    const sortedQuotes = [...quotes].sort((a, b) => a.price - b.price);
    
    let remainingSize = sizeUsd;
    let totalCost = 0;
    let filledSize = 0;

    for (const quote of sortedQuotes) {
      const fillSize = Math.min(remainingSize, quote.depthUsd);
      totalCost += fillSize * quote.price * (1 + quote.feeBps / 10000);
      filledSize += fillSize;
      remainingSize -= fillSize;

      if (remainingSize <= 0) break;
    }

    if (filledSize === 0) {
      return {
        effectivePrice: 0,
        slippageBps: 0,
        availableLiquidity: 0,
      };
    }

    const effectivePrice = totalCost / filledSize;
    const bestPrice = sortedQuotes[0].price;
    const slippageBps = ((effectivePrice - bestPrice) / bestPrice) * 10000;

    return {
      effectivePrice,
      slippageBps: Math.max(0, slippageBps),
      availableLiquidity: quotes.reduce((sum, q) => sum + q.depthUsd, 0),
    };
  }
}

// Export singleton instance
export const marketAggregator = new MarketAggregator();
