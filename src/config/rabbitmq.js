const amqp = require('amqplib');
const { env } = require('./env');

const EXCHANGE_NAME = 'flash_sale_exchange';
const ORDER_QUEUE = 'order_reservations';
const DLX_EXCHANGE = 'flash_sale_dlx';
const DLQ_QUEUE = 'orders_dlq';

let connection = null;
let publishChannel = null;

async function connectRabbitMQ(maxRetries = 10, retryDelayMs = 2000) {
  if (connection) return connection;

  for (let attempt = 1; attempt <= maxRetries; attempt++) {
    try {
      connection = await amqp.connect(env.RABBITMQ_URL);

      connection.on('error', (err) => {
        console.error('[RabbitMQ] Connection error:', err.message);
        connection = null;
        publishChannel = null;
      });

      connection.on('close', () => {
        console.log('[RabbitMQ] Connection closed');
        connection = null;
        publishChannel = null;
      });

      console.log('[RabbitMQ] Connected');
      return connection;
    } catch (err) {
      console.warn(`[RabbitMQ] Connection attempt ${attempt}/${maxRetries} failed: ${err.message}`);
      if (attempt === maxRetries) throw err;
      await new Promise((res) => setTimeout(res, retryDelayMs));
    }
  }
}

async function setupQueues(channel) {
  await channel.assertExchange(DLX_EXCHANGE, 'direct', { durable: true });
  await channel.assertQueue(DLQ_QUEUE, { durable: true });
  await channel.bindQueue(DLQ_QUEUE, DLX_EXCHANGE, 'dead_letter');

  await channel.assertExchange(EXCHANGE_NAME, 'direct', { durable: true });
  await channel.assertQueue(ORDER_QUEUE, {
    durable: true,
    arguments: {
      'x-dead-letter-exchange': DLX_EXCHANGE,
      'x-dead-letter-routing-key': 'dead_letter',
      'x-message-ttl': 60000,
    },
  });
  await channel.bindQueue(ORDER_QUEUE, EXCHANGE_NAME, 'new_order');

  console.log('[RabbitMQ] Exchanges and queues configured');
}

async function getPublishChannel() {
  if (publishChannel) return publishChannel;

  const conn = await connectRabbitMQ();
  publishChannel = await conn.createConfirmChannel();
  await setupQueues(publishChannel);
  return publishChannel;
}

async function createConsumerChannel(prefetchCount) {
  const conn = await connectRabbitMQ();
  const channel = await conn.createChannel();
  await setupQueues(channel);
  await channel.prefetch(prefetchCount);
  return channel;
}

async function closeRabbitMQ() {
  try {
    if (publishChannel) {
      await publishChannel.close();
      publishChannel = null;
    }
    if (connection) {
      await connection.close();
      connection = null;
    }
    console.log('[RabbitMQ] Closed');
  } catch (err) {
    console.error('[RabbitMQ] Error during shutdown:', err);
  }
}

module.exports = {
  EXCHANGE_NAME,
  ORDER_QUEUE,
  DLX_EXCHANGE,
  DLQ_QUEUE,
  connectRabbitMQ,
  setupQueues,
  getPublishChannel,
  createConsumerChannel,
  closeRabbitMQ,
};
