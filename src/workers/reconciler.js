const { getExpiredReservations, expireOrder } = require('../services/orderService');
const { reclaimStock, updateOrderStatus } = require('../services/inventoryService');
const { logAuditEvent } = require('../services/auditService');
const { env } = require('../config/env');

let reconcilerInterval = null;

async function checkPaymentGateway(_orderId) {
  return 'none';
}

async function runReconciliation() {
  const startTime = Date.now();

  try {
    const expiredOrders = await getExpiredReservations();

    if (expiredOrders.length === 0) {
      return;
    }

    console.log(`[Reconciler] Found ${expiredOrders.length} expired reservations to process`);

    let reclaimed = 0;
    let extended = 0;

    for (const order of expiredOrders) {
      try {
        const paymentStatus = await checkPaymentGateway(order.id);

        if (paymentStatus === 'processing' || paymentStatus === 'succeeded') {
          console.log(`[Reconciler] Order ${order.id} has payment status "${paymentStatus}" — extending reservation`);
          extended++;
          continue;
        }

        const expired = await expireOrder(order.id);

        if (expired) {
          await reclaimStock(expired.productId, expired.userId);

          await updateOrderStatus(order.reservationToken, 'EXPIRED', {
            reason: 'Reservation timed out',
            expiredAt: new Date().toISOString(),
          });

          reclaimed++;

          await logAuditEvent(
            'STOCK_RECLAIMED',
            'order',
            order.id,
            expired.userId,
            { productId: expired.productId, reclaimedAt: new Date().toISOString() }
          );
        }
      } catch (error) {
        console.error(`[Reconciler] Failed to process order ${order.id}:`, error);
      }
    }

    const elapsed = Date.now() - startTime;
    console.log(`[Reconciler] Completed: ${reclaimed} reclaimed, ${extended} extended (${elapsed}ms)`);

    await logAuditEvent(
      'RECONCILER_RUN',
      'system',
      'reconciler',
      null,
      { processed: expiredOrders.length, reclaimed, extended, elapsedMs: elapsed }
    );
  } catch (error) {
    console.error('[Reconciler] Run failed:', error);
  }
}

async function startReconciler() {
  const intervalMs = env.RECONCILER_INTERVAL_MS;
  console.log(`[Reconciler] Starting TTL reconciler (interval: ${intervalMs}ms)`);

  await runReconciliation();

  reconcilerInterval = setInterval(runReconciliation, intervalMs);

  const shutdown = () => {
    console.log('[Reconciler] Shutting down...');
    if (reconcilerInterval) {
      clearInterval(reconcilerInterval);
    }
    process.exit(0);
  };

  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);

  console.log('[Reconciler] Running and watching for expired reservations');
}

startReconciler();
