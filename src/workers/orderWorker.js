const { createConsumerChannel, ORDER_QUEUE } = require('../config/rabbitmq');
const { createReservation } = require('../services/orderService');
const { updateOrderStatus, reclaimStock } = require('../services/inventoryService');
const { logAuditEvent } = require('../services/auditService');
const { env } = require('../config/env');

const MAX_RETRIES = 3;

async function processMessage(channel, msg) {
  const startTime = Date.now();
  let order;

  try {
    order = JSON.parse(msg.content.toString());
  } catch (parseError) {
    console.error('[Worker] Malformed message, routing to DLQ:', parseError.message);
    channel.nack(msg, false, false);
    return;
  }

  const retryCount = (msg.properties.headers && msg.properties.headers['x-retry-count']) || order.attemptNumber || 1;

  try {
    console.log(`[Worker] Processing order ${order.idempotencyKey} (attempt ${retryCount})`);

    await updateOrderStatus(order.reservationToken, 'PROCESSING', {
      attemptNumber: retryCount,
    });

    const result = await createReservation(order, env.SALE_RESERVATION_TTL_SECONDS);

    if (result) {
      await updateOrderStatus(order.reservationToken, 'RESERVED', {
        orderId: result.id,
        expiresAt: result.expiresAt,
        amount: result.amount,
      });

      console.log(`[Worker] Order ${result.id} reserved successfully (${Date.now() - startTime}ms)`);
    } else {
      await reclaimStock(order.productId, order.userId);
      await updateOrderStatus(order.reservationToken, 'FAILED', {
        reason: 'Stock exhausted at database level',
      });

      console.warn(`[Worker] Order ${order.idempotencyKey} failed: stock exhausted or duplicate, reclaimed Redis quota`);
    }

    channel.ack(msg);
  } catch (error) {
    console.error(`[Worker] Error processing order ${order.idempotencyKey}:`, error);

    if (retryCount >= MAX_RETRIES) {
      console.error(`[Worker] Order ${order.idempotencyKey} exceeded ${MAX_RETRIES} retries, routing to DLQ`);

      await updateOrderStatus(order.reservationToken, 'FAILED', {
        reason: `Failed after ${MAX_RETRIES} attempts`,
        error: error.message,
      });

      await logAuditEvent(
        'WORKER_ERROR',
        'order',
        order.idempotencyKey,
        order.userId,
        { error: error.message, retryCount }
      );

      channel.nack(msg, false, false);
    } else {
      console.log(`[Worker] Requeuing order ${order.idempotencyKey} (attempt ${retryCount}/${MAX_RETRIES})`);
      channel.nack(msg, false, true);
    }
  }
}

async function startWorker() {
  console.log('[Worker] Starting order consumer worker...');
  console.log(`[Worker] Concurrency: ${env.WORKER_PREFETCH} prefetch`);

  try {
    const channel = await createConsumerChannel(env.WORKER_PREFETCH);

    await channel.consume(
      ORDER_QUEUE,
      async (msg) => {
        if (msg) {
          await processMessage(channel, msg);
        }
      },
      { noAck: false }
    );

    console.log(`[Worker] Listening on queue: ${ORDER_QUEUE}`);
    console.log('[Worker] Ready to process orders');

    const shutdown = async () => {
      console.log('[Worker] Shutting down gracefully...');
      await channel.close();
      process.exit(0);
    };

    process.on('SIGINT', shutdown);
    process.on('SIGTERM', shutdown);
  } catch (error) {
    console.error('[Worker] Failed to start:', error);
    setTimeout(startWorker, 5000);
  }
}

startWorker();
