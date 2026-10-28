const { Router } = require('express');
const { v4: uuidv4 } = require('uuid');
const { authenticateToken, verifyEligibility } = require('../middleware/auth');
const { distributedCheckoutRateLimiter } = require('../middleware/rateLimiter');
const { turnstileGuard } = require('../middleware/turnstile');
const { saleTimeGuard } = require('../middleware/saleTimeGuard');
const { attemptReservation, isSaleClosed, reclaimStock } = require('../services/inventoryService');
const { publishOrderReservation } = require('../services/queueService');
const { env } = require('../config/env');

const router = Router();

router.post(
  '/',
  authenticateToken,
  distributedCheckoutRateLimiter,
  turnstileGuard,
  saleTimeGuard,
  verifyEligibility,
  async (req, res) => {
    const startTime = Date.now();
    const userId = req.user.id;
    const productId = env.SALE_PRODUCT_ID;

    if (isSaleClosed()) {
      res.status(410).json({
        error: 'SOLD_OUT',
        message: 'This item is sold out.',
        responseTimeMs: Date.now() - startTime,
      });
      return;
    }

    try {
      const idempotencyKey = req.body.idempotencyKey || req.headers['x-idempotency-key'] || uuidv4();

      const reservation = await attemptReservation(userId, productId);

      if (reservation.status === 'SOLD_OUT') {
        res.status(410).json({
          error: 'SOLD_OUT',
          message: 'This item is sold out.',
          responseTimeMs: Date.now() - startTime,
        });
        return;
      }

      if (reservation.status === 'LIMIT_EXCEEDED') {
        res.status(409).json({
          error: 'LIMIT_EXCEEDED',
          message: reservation.message,
          responseTimeMs: Date.now() - startTime,
        });
        return;
      }

      if (reservation.status === 'ERROR') {
        res.status(500).json({
          error: 'INTERNAL_ERROR',
          message: 'Failed to process reservation. Please try again.',
        });
        return;
      }

      const orderMessage = {
        reservationToken: reservation.token,
        userId,
        productId,
        idempotencyKey,
        amount: 29999.00,
        attemptNumber: 1,
        createdAt: new Date().toISOString(),
      };

      const published = await publishOrderReservation(orderMessage);

      if (!published) {
        console.error(`[Checkout] Failed to publish order ${idempotencyKey} to queue - rolling back Redis claim`);
        await reclaimStock(productId, userId);
        res.status(503).json({
          error: 'QUEUE_UNAVAILABLE',
          message: 'Order processing queue is temporarily unavailable. Please retry.',
          responseTimeMs: Date.now() - startTime,
        });
        return;
      }

      const statusUrl = `/api/v1/orders/status/${reservation.token}`;

      res.status(202).json({
        status: 'QUEUED',
        message: 'Your order is being processed. Please check back shortly.',
        token: reservation.token,
        statusUrl,
        remainingStock: reservation.remainingStock,
        expiresInSeconds: env.SALE_RESERVATION_TTL_SECONDS,
        responseTimeMs: Date.now() - startTime,
      });
    } catch (error) {
      console.error('[Checkout] Critical error:', error);
      res.status(500).json({
        error: 'INTERNAL_ERROR',
        message: 'An unexpected error occurred. Please try again.',
      });
    }
  }
);

router.get('/status', (_req, res) => {
  res.json({
    saleActive: !isSaleClosed(),
    productId: env.SALE_PRODUCT_ID,
    serverTime: new Date().toISOString(),
    saleStartTime: env.SALE_START_TIME,
    turnstileEnabled: env.TURNSTILE_ENABLED,
    turnstileSiteKey: env.TURNSTILE_SITE_KEY,
  });
});

module.exports = router;
