import { Request, Response, NextFunction } from 'express';

interface RateLimitEntry {
  count: number;
  resetTime: number;
}

const rateLimitStore = new Map<string, RateLimitEntry>();

/**
 * Create a rate limiter middleware
 * @param maxRequests Maximum requests per window
 * @param windowMs Window in milliseconds
 */
export function rateLimit(maxRequests: number, windowMs: number) {
  return (req: Request, res: Response, next: NextFunction): void => {
    const ip = req.ip || req.socket.remoteAddress || 'unknown';
    const key = `${ip}:${req.path}`;
    const now = Date.now();

    const entry = rateLimitStore.get(key);

    if (!entry || now >= entry.resetTime) {
      rateLimitStore.set(key, { count: 1, resetTime: now + windowMs });
      next();
      return;
    }

    entry.count++;

    if (entry.count > maxRequests) {
      const retryAfter = Math.ceil((entry.resetTime - now) / 1000);
      res.setHeader('Retry-After', retryAfter.toString());
      res.status(429).json({
        error: 'Too many requests',
        retryAfter
      });
      return;
    }

    next();
  };
}

/**
 * Cleanup expired rate limit entries periodically
 */
setInterval(() => {
  const now = Date.now();
  for (const [key, entry] of rateLimitStore) {
    if (now >= entry.resetTime) {
      rateLimitStore.delete(key);
    }
  }
}, 60000); // Cleanup every minute
