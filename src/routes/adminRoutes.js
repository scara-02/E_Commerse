const { Router } = require('express');
const { authenticateToken } = require('../middleware/auth');
const { getInventoryStats } = require('../services/orderService');
const { getRecentAuditEvents } = require('../services/auditService');
const { getCurrentStock } = require('../services/inventoryService');
const { redis } = require('../config/redis');
const { db } = require('../config/database');
const { env } = require('../config/env');

const router = Router();

router.get('/dashboard', authenticateToken, async (_req, res) => {
  try {
    const productId = env.SALE_PRODUCT_ID;

    const [redisStock, dbStats, orderCounts] = await Promise.all([
      getCurrentStock(productId),
      getInventoryStats(productId),
      db.query(`
        SELECT 
          status, 
          COUNT(*)::int as count
        FROM orders 
        WHERE product_id = $1
        GROUP BY status
      `, [productId]),
    ]);

    const soldOutFlag = await redis.get(`sold_out:${productId}`);

    const statusBreakdown = {};
    for (const row of orderCounts.rows) {
      statusBreakdown[row.status] = row.count;
    }

    res.json({
      productId,
      redis: {
        currentStock: redisStock,
        isSoldOut: soldOutFlag === '1',
      },
      database: dbStats,
      orders: {
        statusBreakdown,
        totalOrders: Object.values(statusBreakdown).reduce((a, b) => a + b, 0),
      },
      serverTime: new Date().toISOString(),
    });
  } catch (error) {
    console.error('[Admin] Dashboard error:', error);
    res.status(500).json({ error: 'INTERNAL_ERROR' });
  }
});

router.get('/audit', authenticateToken, async (req, res) => {
  const limit = Math.min(parseInt(req.query.limit, 10) || 50, 200);

  try {
    const events = await getRecentAuditEvents(limit);
    res.json({ events, count: events.length });
  } catch (error) {
    console.error('[Admin] Audit log error:', error);
    res.status(500).json({ error: 'INTERNAL_ERROR' });
  }
});

router.get('/health', async (_req, res) => {
  const checks = {};

  const dbStart = Date.now();
  try {
    await db.query('SELECT 1');
    checks.postgres = { status: 'healthy', latencyMs: Date.now() - dbStart };
  } catch {
    checks.postgres = { status: 'unhealthy', latencyMs: Date.now() - dbStart };
  }

  const redisStart = Date.now();
  try {
    await redis.ping();
    checks.redis = { status: 'healthy', latencyMs: Date.now() - redisStart };
  } catch {
    checks.redis = { status: 'unhealthy', latencyMs: Date.now() - redisStart };
  }

  const allHealthy = Object.values(checks).every(c => c.status === 'healthy');

  res.status(allHealthy ? 200 : 503).json({
    status: allHealthy ? 'healthy' : 'degraded',
    services: checks,
    uptime: process.uptime(),
    serverTime: new Date().toISOString(),
  });
});

module.exports = router;
