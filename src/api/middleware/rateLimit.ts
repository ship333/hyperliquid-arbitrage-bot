import { Request, Response, NextFunction } from 'express';

interface Bucket {
  tokens: number;
  lastRefill: number;
}

// Simple token bucket per IP
export function rateLimit({ capacity, refillPerMs }: { capacity: number; refillPerMs: number }) {
  const buckets = new Map<string, Bucket>();

  return (req: Request, res: Response, next: NextFunction) => {
    const key = req.ip || req.headers['x-forwarded-for']?.toString() || 'unknown';
    const now = Date.now();
    const bucket = buckets.get(key) || { tokens: capacity, lastRefill: now };

    // Refill tokens
    const elapsed = now - bucket.lastRefill;
    const refill = elapsed / refillPerMs; // tokens per ms * elapsed ms
    bucket.tokens = Math.min(capacity, bucket.tokens + refill);
    bucket.lastRefill = now;

    if (bucket.tokens < 1) {
      buckets.set(key, bucket);
      res.status(429).json({ error: 'rate_limited', retryInMs: Math.ceil((1 - bucket.tokens) * refillPerMs), timestamp: now });
      return;
    }

    bucket.tokens -= 1;
    buckets.set(key, bucket);
    next();
  };
}
