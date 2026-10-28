const { db } = require('../config/database');

function mapOrderRow(row) {
  if (!row) return null;
  return {
    id: row.id,
    userId: row.user_id,
    productId: row.product_id,
    status: row.status,
    reservationToken: row.reservation_token,
    idempotencyKey: row.idempotency_key,
    amount: parseFloat(row.amount),
    expiresAt: row.expires_at,
    createdAt: row.created_at,
  };
}

async function createReservation(order, ttlSeconds) {
  const client = await db.connect();

  try {
    await client.query('BEGIN');

    const insertResult = await client.query(
      `INSERT INTO orders (user_id, product_id, status, reservation_token, idempotency_key, amount, expires_at)
       VALUES ($1, $2, 'RESERVED', $3, $4, $5, NOW() + INTERVAL '${ttlSeconds} seconds')
       ON CONFLICT (idempotency_key) DO NOTHING
       RETURNING id, user_id, product_id, status, reservation_token, idempotency_key, amount, expires_at, created_at`,
      [order.userId, order.productId, order.reservationToken, order.idempotencyKey, order.amount]
    );

    if (insertResult.rows.length === 0) {
      await client.query('ROLLBACK');
      console.log(`[Order] Duplicate idempotency key ${order.idempotencyKey} - skipped`);

      const existing = await db.query(
        'SELECT * FROM orders WHERE idempotency_key = $1',
        [order.idempotencyKey]
      );
      return existing.rows.length > 0 ? mapOrderRow(existing.rows[0]) : null;
    }

    const stockResult = await client.query(
      `UPDATE inventory 
       SET stock = stock - 1, reserved = reserved + 1
       WHERE product_id = $1 AND stock > 0
       RETURNING stock, reserved`,
      [order.productId]
    );

    if (stockResult.rows.length === 0) {
      await client.query(
        `UPDATE orders SET status = 'FAILED' WHERE idempotency_key = $1`,
        [order.idempotencyKey]
      );
      await client.query('COMMIT');
      console.warn(`[Order] DB-level stock exhausted for ${order.productId}`);
      return null;
    }

    await client.query(
      `INSERT INTO audit_log (event_type, entity_type, entity_id, user_id, details)
       VALUES ('ORDER_RESERVED', 'order', $1, $2, $3)`,
      [
        insertResult.rows[0].id,
        order.userId,
        JSON.stringify({
          productId: order.productId,
          token: order.reservationToken,
          remainingDbStock: stockResult.rows[0].stock,
        }),
      ]
    );

    await client.query('COMMIT');
    console.log(`[Order] Reservation created: ${insertResult.rows[0].id} (DB stock: ${stockResult.rows[0].stock})`);

    return mapOrderRow(insertResult.rows[0]);
  } catch (error) {
    await client.query('ROLLBACK');
    console.error('[Order] Reservation failed:', error);
    throw error;
  } finally {
    client.release();
  }
}

async function confirmOrder(orderId, userId = null) {
  const query = userId
    ? `UPDATE orders 
       SET status = 'CONFIRMED', confirmed_at = NOW()
       WHERE id = $1 AND user_id = $2 AND status = 'RESERVED'
       RETURNING *`
    : `UPDATE orders 
       SET status = 'CONFIRMED', confirmed_at = NOW()
       WHERE id = $1 AND status = 'RESERVED'
       RETURNING *`;

  const params = userId ? [orderId, userId] : [orderId];
  const result = await db.query(query, params);

  if (result.rows.length === 0) return null;

  await db.query(
    `UPDATE inventory 
     SET reserved = reserved - 1 
     WHERE product_id = $1 AND reserved > 0`,
    [result.rows[0].product_id]
  );

  await db.query(
    `INSERT INTO audit_log (event_type, entity_type, entity_id, user_id, details)
     VALUES ('ORDER_CONFIRMED', 'order', $1, $2, $3)`,
    [orderId, result.rows[0].user_id, JSON.stringify({ confirmedAt: new Date().toISOString() })]
  );

  return mapOrderRow(result.rows[0]);
}

async function expireOrder(orderId) {
  const result = await db.query(
    `UPDATE orders 
     SET status = 'EXPIRED', cancelled_at = NOW()
     WHERE id = $1 AND status = 'RESERVED'
     RETURNING user_id, product_id`,
    [orderId]
  );

  if (result.rows.length === 0) return null;

  const { user_id, product_id } = result.rows[0];

  await db.query(
    `UPDATE inventory 
     SET stock = stock + 1, reserved = GREATEST(0, reserved - 1)
     WHERE product_id = $1`,
    [product_id]
  );

  await db.query(
    `INSERT INTO audit_log (event_type, entity_type, entity_id, user_id, details)
     VALUES ('ORDER_EXPIRED', 'order', $1, $2, $3)`,
    [orderId, user_id, JSON.stringify({ expiredAt: new Date().toISOString() })]
  );

  return { userId: user_id, productId: product_id };
}

async function getExpiredReservations() {
  const result = await db.query(
    `SELECT id, user_id, product_id, reservation_token 
     FROM orders 
     WHERE status = 'RESERVED' AND expires_at < NOW()
     ORDER BY expires_at ASC
     LIMIT 50`
  );

  return result.rows.map(row => ({
    id: row.id,
    userId: row.user_id,
    productId: row.product_id,
    reservationToken: row.reservation_token,
  }));
}

async function getOrderByToken(token) {
  const result = await db.query(
    'SELECT * FROM orders WHERE reservation_token = $1',
    [token]
  );
  return result.rows.length > 0 ? mapOrderRow(result.rows[0]) : null;
}

async function getOrderByIdempotencyKey(key) {
  const result = await db.query(
    'SELECT * FROM orders WHERE idempotency_key = $1',
    [key]
  );
  return result.rows.length > 0 ? mapOrderRow(result.rows[0]) : null;
}

async function getUserOrders(userId) {
  const result = await db.query(
    `SELECT o.*, p.name as product_name, p.image_url as product_image, p.price as product_price
     FROM orders o
     LEFT JOIN products p ON o.product_id = p.id
     WHERE o.user_id = $1 
     ORDER BY o.created_at DESC`,
    [userId]
  );
  return result.rows.map((row) => ({
    ...mapOrderRow(row),
    productName: row.product_name || row.product_id,
    productImage: row.product_image || '/images/phone_festival.png',
    productPrice: row.product_price ? parseFloat(row.product_price) : row.amount,
  }));
}

async function getInventoryStats(productId) {
  const result = await db.query(
    'SELECT * FROM inventory WHERE product_id = $1',
    [productId]
  );
  if (result.rows.length === 0) return null;

  const row = result.rows[0];
  return {
    productId: row.product_id,
    totalStock: row.total_stock,
    availableStock: row.stock,
    reserved: row.reserved,
    sold: row.total_stock - row.stock - row.reserved,
    updatedAt: row.updated_at,
  };
}

module.exports = {
  createReservation,
  confirmOrder,
  expireOrder,
  getExpiredReservations,
  getOrderByToken,
  getOrderByIdempotencyKey,
  getUserOrders,
  getInventoryStats,
  mapOrderRow,
};
