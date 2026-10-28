const { getPublishChannel, EXCHANGE_NAME } = require('../config/rabbitmq');

async function publishOrderReservation(order) {
  try {
    const channel = await getPublishChannel();
    const messageBuffer = Buffer.from(JSON.stringify(order));

    const published = channel.publish(
      EXCHANGE_NAME,
      'new_order',
      messageBuffer,
      {
        persistent: true,
        contentType: 'application/json',
        messageId: order.idempotencyKey,
        timestamp: Date.now(),
        headers: {
          'x-retry-count': order.attemptNumber || 1,
          'x-user-id': order.userId,
          'x-product-id': order.productId,
        },
      }
    );

    if (!published) {
      console.warn('[Queue] Channel buffer full, waiting for drain...');
      await new Promise((resolve) => channel.once('drain', resolve));
    }

    console.log(`[Queue] Order ${order.idempotencyKey} published to ${EXCHANGE_NAME}`);
    return true;
  } catch (error) {
    console.error('[Queue] Failed to publish order:', error);
    return false;
  }
}

module.exports = {
  publishOrderReservation,
};
