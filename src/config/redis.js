const Redis = require('ioredis');
const { env } = require('./env');

const redisConfig = {
  host: env.REDIS_HOST,
  port: env.REDIS_PORT,
  password: env.REDIS_PASSWORD,
  db: env.REDIS_DB,
  retryStrategy(times) {
    const delay = Math.min(times * 200, 3000);
    return delay;
  },
  maxRetriesPerRequest: 3,
  enableReadyCheck: true,
  lazyConnect: false,
};

const redis = new Redis(redisConfig);

const redisSub = new Redis(redisConfig);

redis.on('connect', () => {
  console.log('[Redis] Connected to Redis server');
});

redis.on('error', (err) => {
  console.error('[Redis] Connection error:', err.message);
});

async function testRedisConnection() {
  const pong = await redis.ping();
  console.log(`[Redis] PING -> ${pong}`);
}

async function closeRedisConnections() {
  await redis.quit();
  await redisSub.quit();
  console.log('[Redis] Connections closed');
}

module.exports = {
  redis,
  redisSub,
  testRedisConnection,
  closeRedisConnections,
};
