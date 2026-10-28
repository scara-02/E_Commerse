const { Router } = require('express');
const { v4: uuidv4 } = require('uuid');
const { authenticateToken } = require('../middleware/auth');
const { getOrderStatus } = require('../services/inventoryService');
const { getOrderByToken, getUserOrders, confirmOrder } = require('../services/orderService');
const { db } = require('../config/database');
const { logAuditEvent } = require('../services/auditService');

const router = Router();

router.get('/status/:token', async (req, res) => {
  const { token } = req.params;

  if (!token || !token.startsWith('tok_')) {
    res.status(400).json({ error: 'INVALID_TOKEN', message: 'Invalid reservation token format' });
    return;
  }

  try {
    const redisStatus = await getOrderStatus(token);

    if (redisStatus) {
      res.json({
        source: 'cache',
        order: redisStatus,
        serverTime: new Date().toISOString(),
      });
      return;
    }

    const dbOrder = await getOrderByToken(token);

    if (!dbOrder) {
      res.status(404).json({
        error: 'NOT_FOUND',
        message: 'Order not found. It may have expired.',
      });
      return;
    }

    res.json({
      source: 'database',
      order: {
        id: dbOrder.id,
        status: dbOrder.status,
        productId: dbOrder.productId,
        amount: dbOrder.amount,
        expiresAt: dbOrder.expiresAt,
        createdAt: dbOrder.createdAt,
      },
      serverTime: new Date().toISOString(),
    });
  } catch (error) {
    console.error('[Orders] Status check failed:', error);
    res.status(500).json({ error: 'INTERNAL_ERROR' });
  }
});

router.get('/my', authenticateToken, async (req, res) => {
  try {
    const orders = await getUserOrders(req.user.id);

    res.json({
      orders: orders.map(o => ({
        id: o.id,
        productId: o.productId,
        productName: o.productName,
        productImage: o.productImage,
        status: o.status,
        amount: o.amount,
        token: o.reservationToken,
        expiresAt: o.expiresAt,
        createdAt: o.createdAt,
      })),
    });
  } catch (error) {
    console.error('[Orders] Failed to fetch user orders:', error);
    res.status(500).json({ error: 'INTERNAL_ERROR' });
  }
});

// Cart Multi-Item Checkout
router.post('/cart-checkout', authenticateToken, async (req, res) => {
  const { items, couponCode, shippingInfo } = req.body;
  const userId = req.user.id;

  if (!items || !Array.isArray(items) || items.length === 0) {
    res.status(400).json({ error: 'VALIDATION_ERROR', message: 'Cart is empty' });
    return;
  }

  const client = await db.connect();
  try {
    await client.query('BEGIN');

    const confirmedOrders = [];
    let subtotal = 0;

    for (const item of items) {
      const { productId, quantity = 1 } = item;

      // Fetch product & lock inventory row
      const prodRes = await client.query(
        `SELECT p.id, p.name, p.price, p.is_flash_sale, i.stock 
         FROM products p
         JOIN inventory i ON p.id = i.product_id
         WHERE p.id = $1 FOR UPDATE OF i`,
        [productId]
      );

      if (prodRes.rows.length === 0) {
        throw new Error(`Product ${productId} not found`);
      }

      const prod = prodRes.rows[0];

      if (prod.stock < quantity) {
        throw new Error(`Insufficient stock for "${prod.name}" (only ${prod.stock} left)`);
      }

      const itemTotal = parseFloat(prod.price) * quantity;
      subtotal += itemTotal;

      // Decrement inventory stock
      await client.query(
        `UPDATE inventory SET stock = stock - $1 WHERE product_id = $2`,
        [quantity, productId]
      );

      // Create confirmed order
      const idempotencyKey = `cart_${uuidv4()}`;
      const orderRes = await client.query(
        `INSERT INTO orders (user_id, product_id, status, idempotency_key, amount, confirmed_at)
         VALUES ($1, $2, 'CONFIRMED', $3, $4, NOW())
         RETURNING id, user_id, product_id, status, idempotency_key, amount, confirmed_at, created_at`,
        [userId, productId, idempotencyKey, itemTotal]
      );

      confirmedOrders.push({
        orderId: orderRes.rows[0].id,
        productId,
        productName: prod.name,
        quantity,
        amount: itemTotal,
      });

      await logAuditEvent('ORDER_CONFIRMED', 'order', orderRes.rows[0].id, userId, {
        source: 'cart_checkout',
        productId,
        quantity,
        amount: itemTotal,
      });
    }

    let discount = 0;
    if (couponCode && couponCode.toUpperCase() === 'FESTIVAL10') {
      discount = Math.round(subtotal * 0.10);
    }

    await client.query('COMMIT');

    res.status(201).json({
      success: true,
      message: 'Orders placed successfully!',
      orders: confirmedOrders,
      summary: {
        itemCount: items.length,
        subtotal,
        discount,
        total: Math.max(0, subtotal - discount),
        couponApplied: discount > 0 ? couponCode.toUpperCase() : null,
      },
    });
  } catch (err) {
    await client.query('ROLLBACK');
    console.error('[Orders] Cart checkout failed:', err.message);
    res.status(400).json({ error: 'CHECKOUT_FAILED', message: err.message });
  } finally {
    client.release();
  }
});

router.post('/:id/confirm', authenticateToken, async (req, res) => {
  const { id } = req.params;

  try {
    const order = await confirmOrder(id, req.user.id);

    if (!order) {
      res.status(404).json({
        error: 'NOT_FOUND',
        message: 'Order not found or already processed',
      });
      return;
    }

    res.json({
      message: 'Order confirmed successfully',
      order: {
        id: order.id,
        status: order.status,
        productId: order.productId,
        amount: order.amount,
      },
    });
  } catch (error) {
    console.error('[Orders] Confirmation failed:', error);
    res.status(500).json({ error: 'INTERNAL_ERROR' });
  }
});

module.exports = router;
