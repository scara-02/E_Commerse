const rateLimit = require('express-rate-limit');
const { redis } = require('../config/redis');

const globalRateLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: 100,
  standardHeaders: true,
  legacyHeaders: false,
  message: {
    error: 'RATE_LIMITED',
    message: 'Too many requests. Please slow down.',
  },
  keyGenerator: (req) => {
    return req.ip || req.socket.remoteAddress || 'unknown';
  },
});

const checkoutRateLimiter = rateLimit({
  windowMs: 1000,
  max: 1,
  standardHeaders: true,
  legacyHeaders: false,
  message: {
    error: 'CHECKOUT_THROTTLED',
    message: 'Only 1 checkout attempt per second is allowed.',
  },
  keyGenerator: (req) => {
    return req.user?.id || req.ip || 'unknown';
  },
  handler: (_req, res) => {
    res.status(429).json({
      error: 'CHECKOUT_THROTTLED',
      message: 'Only 1 checkout attempt per second is allowed. Please wait.',
      retryAfter: 1,
    });
  },
});

/**
 * Distributed Redis Rate Limiter for Multi-Pod Deployment
 * Ensures that across 40 API instances, a user or bot cannot bypass rate limits
 * by distributing requests round-robin across different pods.
 */
async function distributedCheckoutRateLimiter(req, res, next) {
  const userId = req.user?.id || req.ip || 'unknown';
  const key = `ratelimit:checkout:${userId}`;

  try {
    const hits = await redis.incr(key);
    if (hits === 1) {
      await redis.expire(key, 1);
    }

    if (hits > 1) {
      const ttl = await redis.ttl(key);
      res.setHeader('Retry-After', ttl > 0 ? ttl : 1);
      return res.status(429).json({
        error: 'CHECKOUT_THROTTLED',
        message: 'Only 1 checkout attempt per second is allowed. Please wait.',
        retryAfter: ttl > 0 ? ttl : 1,
      });
    }

    next();
  } catch (error) {
    // If Redis encounters a momentary hiccup, fail-open to in-memory limiter
    checkoutRateLimiter(req, res, next);
  }
}

module.exports = {
  globalRateLimiter,
  checkoutRateLimiter,
  distributedCheckoutRateLimiter,
};
