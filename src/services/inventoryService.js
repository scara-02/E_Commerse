const { redis, redisSub } = require('../config/redis');
const { env } = require('../config/env');
const crypto = require('crypto');

let SALE_CLOSED = false;

const SOLD_OUT_CHANNEL = 'flash_sale:sold_out';
const REOPEN_CHANNEL = 'flash_sale:reopened';

// Atomic Redis Lua script: executes check-claim, check-stock, decrement, and claim-lock
// in a SINGLE sequential Redis tick (O(1), <0.2ms, zero round-trip overhead).
const ATOMIC_RESERVATION_LUA = `
local claim_key = KEYS[1]
local inventory_key = KEYS[2]
local sold_out_key = KEYS[3]
local claim_ttl = tonumber(ARGV[1])

-- 1. Check if user already claimed
if redis.call('EXISTS', claim_key) == 1 then
    return -2
end

-- 2. Check if sold out flag is active
if redis.call('GET', sold_out_key) == '1' then
    return -1
end

-- 3. Check stock level
local stock = redis.call('GET', inventory_key)
if not stock or tonumber(stock) <= 0 then
    redis.call('SET', sold_out_key, '1')
    return -1
end

-- 4. Atomically decrement stock
local remaining = redis.call('DECR', inventory_key)
if remaining < 0 then
    redis.call('SET', inventory_key, '0')
    redis.call('SET', sold_out_key, '1')
    return -1
end

-- 5. Lock user claim with TTL
redis.call('SET', claim_key, '1', 'EX', claim_ttl)

-- 6. If this was the last unit, trigger sold out flag
if remaining == 0 then
    redis.call('SET', sold_out_key, '1')
end

return remaining
`;

// Register custom command on ioredis client
try {
  redis.defineCommand('claimReservationToken', {
    numberOfKeys: 3,
    lua: ATOMIC_RESERVATION_LUA,
  });
} catch (err) {
  console.warn('[Inventory] Failed to define custom Lua command, fallback enabled:', err.message);
}

async function initSoldOutListener() {
  await redisSub.subscribe(SOLD_OUT_CHANNEL, REOPEN_CHANNEL);

  redisSub.on('message', (channel, message) => {
    if (channel === SOLD_OUT_CHANNEL) {
      try {
        const data = JSON.parse(message);
        if (data.productId === env.SALE_PRODUCT_ID) {
          SALE_CLOSED = true;
          console.log(`[Inventory] SOLD OUT flag set for ${data.productId}. All future requests will be rejected in <1ms.`);
        }
      } catch (err) {
        console.error('[Inventory] Error parsing sold-out message:', err);
      }
    } else if (channel === REOPEN_CHANNEL) {
      try {
        const data = JSON.parse(message);
        if (data.productId === env.SALE_PRODUCT_ID) {
          SALE_CLOSED = false;
          console.log(`[Inventory] SALE REOPENED broadcast received for ${data.productId} (${data.stock} units available).`);
        }
      } catch (err) {
        console.error('[Inventory] Error parsing reopen message:', err);
      }
    }
  });

  const soldOut = await redis.get(`sold_out:${env.SALE_PRODUCT_ID}`);
  if (soldOut === '1') {
    SALE_CLOSED = true;
    console.log('[Inventory] Sale was already closed from previous state');
  }

  console.log('[Inventory] Sold-out listener initialized');
}

function isSaleClosed() {
  return SALE_CLOSED;
}

function resetSaleState() {
  SALE_CLOSED = false;
}

async function attemptReservation(userId, productId) {
  if (SALE_CLOSED) {
    return { status: 'SOLD_OUT', message: 'Flash sale item is sold out' };
  }

  const claimKey = `claim:${productId}:${userId}`;
  const inventoryKey = `inventory:${productId}`;
  const soldOutKey = `sold_out:${productId}`;

  try {
    // 1. ATOMIC FAST-PATH: Execute single-tick Lua script via Redis EVALSHA
    // Cuts network round-trips from 3 down to 1 (0.2ms total execution time)
    if (typeof redis.claimReservationToken === 'function') {
      const luaResult = await redis.claimReservationToken(
        claimKey,
        inventoryKey,
        soldOutKey,
        86400
      );

      const code = parseInt(luaResult, 10);

      if (code === -2) {
        return { status: 'LIMIT_EXCEEDED', message: 'Maximum 1 unit per customer' };
      }

      if (code === -1) {
        await broadcastSoldOut(productId);
        return { status: 'SOLD_OUT', message: 'Flash sale item is sold out' };
      }

      // If code >= 0, token granted and code is the remaining stock!
      const remainingStock = code;
      const reservationToken = `tok_${crypto.randomUUID()}`;

      if (remainingStock === 0) {
        // Last item was claimed, notify cluster immediately
        await broadcastSoldOut(productId);
      }

      await redis.setex(
        `order_status:${reservationToken}`,
        env.SALE_RESERVATION_TTL_SECONDS + 60,
        JSON.stringify({
          status: 'QUEUED',
          userId,
          productId,
          token: reservationToken,
          remainingStock,
          createdAt: new Date().toISOString(),
        })
      );

      return {
        status: 'TOKEN_GRANTED',
        token: reservationToken,
        remainingStock,
      };
    }

    // 2. FALLBACK PATH: Standard multi-step atomic operations
    const claimLock = await redis.set(claimKey, '1', 'EX', 86400, 'NX');

    if (!claimLock) {
      return { status: 'LIMIT_EXCEEDED', message: 'Maximum 1 unit per customer' };
    }

    const remainingStock = await redis.decr(inventoryKey);

    if (remainingStock < 0) {
      await redis.del(claimKey);
      await redis.incr(inventoryKey);
      await broadcastSoldOut(productId);
      return { status: 'SOLD_OUT', message: 'Flash sale item is sold out' };
    }

    const reservationToken = `tok_${crypto.randomUUID()}`;

    await redis.setex(
      `order_status:${reservationToken}`,
      env.SALE_RESERVATION_TTL_SECONDS + 60,
      JSON.stringify({
        status: 'QUEUED',
        userId,
        productId,
        token: reservationToken,
        remainingStock,
        createdAt: new Date().toISOString(),
      })
    );

    return {
      status: 'TOKEN_GRANTED',
      token: reservationToken,
      remainingStock,
    };
  } catch (error) {
    console.error('[Inventory] Reservation attempt failed:', error);
    return { status: 'ERROR', message: 'Internal error during reservation' };
  }
}

async function broadcastSoldOut(productId) {
  try {
    await redis.set(`sold_out:${productId}`, '1');

    await redis.publish(
      SOLD_OUT_CHANNEL,
      JSON.stringify({ productId, timestamp: Date.now() })
    );

    SALE_CLOSED = true;
    console.log(`[Inventory] Sold-out broadcast sent for ${productId}`);
  } catch (error) {
    console.error('[Inventory] Failed to broadcast sold-out:', error);
  }
}

async function reclaimStock(productId, userId, count = 1) {
  try {
    await redis.incrby(`inventory:${productId}`, count);

    await redis.del(`claim:${productId}:${userId}`);

    const currentStock = await redis.get(`inventory:${productId}`);
    if (currentStock && parseInt(currentStock, 10) > 0) {
      SALE_CLOSED = false;
      await redis.set(`sold_out:${productId}`, '0');
      await redis.publish(
        REOPEN_CHANNEL,
        JSON.stringify({ productId, stock: parseInt(currentStock, 10), timestamp: Date.now() })
      );
      console.log(`[Inventory] Stock reclaimed. ${currentStock} units available again.`);
    }
  } catch (error) {
    console.error('[Inventory] Stock reclamation failed:', error);
    throw error;
  }
}

async function getCurrentStock(productId) {
  const stock = await redis.get(`inventory:${productId}`);
  return stock ? parseInt(stock, 10) : 0;
}

async function updateOrderStatus(token, status, details = {}) {
  const existing = await redis.get(`order_status:${token}`);
  const data = existing ? JSON.parse(existing) : {};

  await redis.setex(
    `order_status:${token}`,
    env.SALE_RESERVATION_TTL_SECONDS + 60,
    JSON.stringify({
      ...data,
      status,
      ...details,
      updatedAt: new Date().toISOString(),
    })
  );
}

async function getOrderStatus(token) {
  const data = await redis.get(`order_status:${token}`);
  return data ? JSON.parse(data) : null;
}

module.exports = {
  initSoldOutListener,
  isSaleClosed,
  resetSaleState,
  attemptReservation,
  reclaimStock,
  getCurrentStock,
  updateOrderStatus,
  getOrderStatus,
};
