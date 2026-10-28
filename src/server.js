const express = require('express');
const cors = require('cors');
const helmet = require('helmet');
const compression = require('compression');
const morgan = require('morgan');
const path = require('path');

const { env } = require('./config/env');
const { testDatabaseConnection, closeDatabasePool } = require('./config/database');
const { testRedisConnection, closeRedisConnections } = require('./config/redis');
const { connectRabbitMQ, closeRabbitMQ } = require('./config/rabbitmq');
const { initSoldOutListener } = require('./services/inventoryService');
const { globalRateLimiter } = require('./middleware/rateLimiter');

const authRoutes = require('./routes/authRoutes');
const checkoutRoutes = require('./routes/checkoutRoutes');
const orderRoutes = require('./routes/orderRoutes');
const adminRoutes = require('./routes/adminRoutes');
const productRoutes = require('./routes/productRoutes');

const app = express();

app.use(helmet({
  contentSecurityPolicy: false,
  crossOriginEmbedderPolicy: false,
}));
app.use(cors({
  origin: env.NODE_ENV === 'production'
    ? ['https://yourdomain.com', 'http://localhost', 'http://localhost:3000', 'http://localhost:80', 'http://127.0.0.1']
    : '*',
  methods: ['GET', 'POST', 'PUT', 'DELETE'],
  allowedHeaders: ['Content-Type', 'Authorization', 'X-Idempotency-Key'],
}));
app.use(compression());
app.use(express.json({ limit: '10kb' }));
app.use(express.urlencoded({ extended: true, limit: '10kb' }));

app.use(morgan(env.NODE_ENV === 'production' ? 'combined' : 'dev'));

app.use('/api/', globalRateLimiter);

app.use((_req, res, next) => {
  res.setHeader('X-Server-Time', new Date().toISOString());
  res.setHeader('X-Served-By', env.INSTANCE_ID);
  next();
});

// ─── Edge CDN Cache-Control Headers & Optimized Static Asset Delivery ───
app.use(
  express.static(path.join(__dirname, '../public'), {
    maxAge: '1d',
    etag: true,
    lastModified: true,
    setHeaders: (res, filePath) => {
      // HTML shell should revalidate so sale status & code deployments update immediately
      if (filePath.endsWith('.html')) {
        res.setHeader('Cache-Control', 'public, max-age=0, must-revalidate');
      } else if (filePath.match(/\.(css|js|png|jpg|jpeg|gif|ico|svg|woff2?)$/)) {
        // Static assets (CSS, JS, images, icons) cached on Edge CDN for 24 hours with stale-while-revalidate
        res.setHeader('Cache-Control', 'public, max-age=86400, s-maxage=86400, stale-while-revalidate=3600');
        res.setHeader('Surrogate-Control', 'max-age=86400');
      }
      res.setHeader('X-Content-Type-Options', 'nosniff');
    },
  })
);

// ─── Load Balancer Health Probe Endpoint ───
app.get('/health', (_req, res) => {
  res.status(200).json({
    status: 'healthy',
    instanceId: env.INSTANCE_ID,
    timestamp: new Date().toISOString(),
    uptime: process.uptime(),
  });
});

app.use('/api/v1/auth', authRoutes);
app.use('/api/v1/products', productRoutes);
app.use('/api/v1/checkout', checkoutRoutes);
app.use('/api/v1/orders', orderRoutes);
app.use('/api/v1/admin', adminRoutes);

app.get('/api', (_req, res) => {
  res.json({
    name: 'Flash Sale Platform API',
    version: '1.0.0',
    status: 'running',
    serverTime: new Date().toISOString(),
    endpoints: {
      auth: '/api/v1/auth',
      checkout: '/api/v1/checkout',
      orders: '/api/v1/orders',
      admin: '/api/v1/admin',
      health: '/api/v1/admin/health',
    },
  });
});

app.use((_req, res) => {
  res.status(404).json({ error: 'NOT_FOUND', message: 'Endpoint not found' });
});

app.use((err, _req, res, _next) => {
  console.error('[Server] Unhandled error:', err);
  const status = err.status || err.statusCode || 500;
  res.status(status).json({
    error: err.type || (status === 500 ? 'INTERNAL_ERROR' : 'BAD_REQUEST'),
    message: err.message || 'An unexpected error occurred',
  });
});

async function startServer() {
  try {
    console.log('╔═══════════════════════════════════════════════╗');
    console.log('║       Flash Sale Platform - Starting Up       ║');
    console.log('╚═══════════════════════════════════════════════╝');
    console.log('');

    console.log('[Startup] Connecting to PostgreSQL...');
    await testDatabaseConnection();

    console.log('[Startup] Connecting to Redis...');
    await testRedisConnection();

    console.log('[Startup] Connecting to RabbitMQ...');
    await connectRabbitMQ();

    console.log('[Startup] Initializing sold-out listener...');
    await initSoldOutListener();

    const server = app.listen(env.PORT, () => {
      console.log('');
      console.log('╔═══════════════════════════════════════════════╗');
      console.log(`║   Server running on http://localhost:${env.PORT}     ║`);
      console.log(`║   Environment: ${env.NODE_ENV.padEnd(30)}║`);
      console.log(`║   Sale Product: ${env.SALE_PRODUCT_ID.padEnd(28)}║`);
      console.log(`║   Total Stock: ${String(env.SALE_TOTAL_STOCK).padEnd(29)}║`);
      console.log('╚═══════════════════════════════════════════════╝');
      console.log('');
    });

    const shutdown = async (signal) => {
      console.log(`\n[Shutdown] Received ${signal}. Cleaning up...`);

      server.close(async () => {
        console.log('[Shutdown] HTTP server closed');
        await closeRabbitMQ();
        await closeRedisConnections();
        await closeDatabasePool();
        console.log('[Shutdown] All connections closed. Goodbye.');
        process.exit(0);
      });

      setTimeout(() => {
        console.error('[Shutdown] Forced shutdown after 10s timeout');
        process.exit(1);
      }, 10000);
    };

    process.on('SIGINT', () => shutdown('SIGINT'));
    process.on('SIGTERM', () => shutdown('SIGTERM'));
  } catch (error) {
    console.error('[Startup] Failed to start server:', error);
    process.exit(1);
  }
}

startServer();

module.exports = app;
