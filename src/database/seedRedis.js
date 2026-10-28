const { redis, testRedisConnection, closeRedisConnections } = require('../config/redis');
const { env } = require('../config/env');

async function seedRedis() {
  console.log('[Redis Seed] Starting Redis seeding...');

  try {
    await testRedisConnection();

    const productId = env.SALE_PRODUCT_ID;
    const totalStock = env.SALE_TOTAL_STOCK;

    await redis.set(`inventory:${productId}`, totalStock.toString());
    console.log(`[Redis Seed] inventory:${productId} = ${totalStock}`);

    await redis.set(`sold_out:${productId}`, '0');
    console.log(`[Redis Seed] sold_out:${productId} = 0 (active)`);

    const claimKeys = await redis.keys(`claim:${productId}:*`);
    if (claimKeys.length > 0) {
      await redis.del(...claimKeys);
      console.log(`[Redis Seed] Cleared ${claimKeys.length} existing claim locks`);
    }

    const statusKeys = await redis.keys(`order_status:*`);
    if (statusKeys.length > 0) {
      await redis.del(...statusKeys);
      console.log(`[Redis Seed] Cleared ${statusKeys.length} existing order status keys`);
    }

    await redis.set(`sale_start:${productId}`, env.SALE_START_TIME);
    console.log(`[Redis Seed] Sale start time: ${env.SALE_START_TIME}`);

    await redis.set(`reservation_ttl:${productId}`, env.SALE_RESERVATION_TTL_SECONDS.toString());
    console.log(`[Redis Seed] Reservation TTL: ${env.SALE_RESERVATION_TTL_SECONDS}s`);

    console.log('[Redis Seed] Redis seeding complete!');
  } catch (error) {
    console.error('[Redis Seed] Failed:', error);
    process.exit(1);
  } finally {
    await closeRedisConnections();
  }
}

seedRedis();
