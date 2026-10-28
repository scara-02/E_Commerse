const dotenv = require('dotenv');
const path = require('path');

dotenv.config({ path: path.resolve(__dirname, '../../.env') });

function requireEnv(key, fallback) {
  const value = process.env[key] || fallback;
  if (!value) {
    throw new Error(`Missing required environment variable: ${key}`);
  }
  return value;
}

const env = {
  PORT: parseInt(requireEnv('PORT', '3000'), 10),
  NODE_ENV: requireEnv('NODE_ENV', 'development'),

  DB_HOST: requireEnv('DB_HOST', 'localhost'),
  DB_PORT: parseInt(requireEnv('DB_PORT', '5432'), 10),
  DB_NAME: requireEnv('DB_NAME', 'flash_sale'),
  DB_USER: requireEnv('DB_USER', 'postgres'),
  DB_PASSWORD: requireEnv('DB_PASSWORD', 'postgres'),
  DB_POOL_MIN: parseInt(requireEnv('DB_POOL_MIN', '5'), 10),
  DB_POOL_MAX: parseInt(requireEnv('DB_POOL_MAX', '50'), 10),

  REDIS_HOST: requireEnv('REDIS_HOST', 'localhost'),
  REDIS_PORT: parseInt(requireEnv('REDIS_PORT', '6379'), 10),
  REDIS_PASSWORD: process.env.REDIS_PASSWORD || undefined,
  REDIS_DB: parseInt(requireEnv('REDIS_DB', '0'), 10),

  RABBITMQ_URL: requireEnv('RABBITMQ_URL', 'amqp://guest:guest@localhost:5672'),

  JWT_SECRET: requireEnv('JWT_SECRET', 'flash_sale_dev_secret_key_2025'),
  JWT_EXPIRES_IN: requireEnv('JWT_EXPIRES_IN', '24h'),

  SALE_PRODUCT_ID: requireEnv('SALE_PRODUCT_ID', 'phone_500'),
  SALE_TOTAL_STOCK: parseInt(requireEnv('SALE_TOTAL_STOCK', '500'), 10),
  SALE_START_TIME: requireEnv('SALE_START_TIME', '2025-01-15T20:00:00.000Z'),
  SALE_RESERVATION_TTL_SECONDS: parseInt(requireEnv('SALE_RESERVATION_TTL_SECONDS', '300'), 10),
  SALE_MAX_PER_USER: parseInt(requireEnv('SALE_MAX_PER_USER', '1'), 10),

  WORKER_CONCURRENCY: parseInt(requireEnv('WORKER_CONCURRENCY', '10'), 10),
  WORKER_PREFETCH: parseInt(requireEnv('WORKER_PREFETCH', '5'), 10),
  RECONCILER_INTERVAL_MS: parseInt(requireEnv('RECONCILER_INTERVAL_MS', '20000'), 10),

  // ─── Cloudflare Turnstile Bot Protection ───
  // Default testing keys: always pass verification (official Cloudflare test credentials)
  TURNSTILE_SECRET_KEY: process.env.TURNSTILE_SECRET_KEY || '1x00000000000000000000000000000000AA',
  TURNSTILE_SITE_KEY: process.env.TURNSTILE_SITE_KEY || '1x00000000000000000000AA',
  TURNSTILE_ENABLED: process.env.TURNSTILE_ENABLED !== undefined
    ? process.env.TURNSTILE_ENABLED === 'true'
    : process.env.NODE_ENV === 'production',

  // ─── Instance Identification for Load Balancer ───
  INSTANCE_ID: process.env.INSTANCE_ID || process.env.HOSTNAME || `api-pod-${process.pid}`,
};

module.exports = { env };
