import { describe, it, expect } from 'vitest';
import { simulateUniV3SlipBps } from '../src/eval/univ3_math';

const Q96 = BigInt(2) ** BigInt(96);

describe('UniV3 Math Validation', () => {
  const TEST_VECTORS = [
    // Base case: minimal input
    {
      liquidity: 10n ** 14n,
      amountIn: 10n ** 15n,
      feeBps: 5,
      zeroForOne: true,
      description: "Minimal input - low liquidity"
    },
    {
      liquidity: 10n ** 18n,
      amountIn: 10n ** 15n,
      feeBps: 5,
      zeroForOne: true,
      description: "Minimal input - high liquidity"
    },
    // Typical cases
    {
      liquidity: 10n ** 16n,
      amountIn: 10n ** 18n,
      feeBps: 30,
      zeroForOne: true,
      description: "Typical input - medium liquidity"
    },
    {
      liquidity: 10n ** 17n,
      amountIn: 10n ** 19n,
      feeBps: 100,
      zeroForOne: false,
      description: "Large input - high fee"
    },
    // Edge cases
    {
      liquidity: 10n ** 12n,
      amountIn: 10n ** 20n,
      feeBps: 1,
      zeroForOne: true,
      description: "High input/low liquidity"
    },
    {
      liquidity: 10n ** 20n,
      amountIn: 10n ** 10n,
      feeBps: 0,
      zeroForOne: false,
      description: "Near-zero input",
      acceptZero: true
    }
  ];

  TEST_VECTORS.forEach(vector => {
    it(vector.description, () => {
      const { slipBps } = simulateUniV3SlipBps({
        sqrtPriceX96: Q96.toString(),
        liquidity: vector.liquidity.toString(),
        feeTierBps: vector.feeBps,
        amountIn: vector.amountIn.toString(),
        zeroForOne: vector.zeroForOne
      });

      // Validate slippage properties
      expect(slipBps).toBeGreaterThanOrEqual(0);
      expect(slipBps).toBeLessThanOrEqual(10000);

      // For non-zero fee, slippage should be at least the fee
      if (vector.feeBps > 0) {
        expect(slipBps).toBeGreaterThan(vector.feeBps);
      } else if (vector.description !== "Near-zero input") {
        // With zero fee, slippage should be positive due to impact
        // except for near-zero inputs where truncation may cause zero slippage
        expect(slipBps).toBeGreaterThan(0);
      }

      // Additional checks for directional consistency
      // (We expect slippage to be positive for any non-zero input, but allow zero for near-zero due to truncation)
      if (vector.amountIn > 0 && vector.description !== "Near-zero input") {
        expect(slipBps).toBeGreaterThan(0);
      }
    });
  });
});
