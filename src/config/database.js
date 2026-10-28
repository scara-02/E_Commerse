const { Pool } = require('pg');
const { env } = require('./env');

const poolConfig = {
  host: env.DB_HOST,
  port: env.DB_PORT,
  database: env.DB_NAME,
  user: env.DB_USER,
  password: env.DB_PASSWORD,
  min: env.DB_POOL_MIN,
  max: env.DB_POOL_MAX,
  idleTimeoutMillis: 30000,
  connectionTimeoutMillis: 5000,
};

const db = new Pool(poolConfig);

async function testDatabaseConnection() {
  const client = await db.connect();
  try {
    const result = await client.query('SELECT NOW() as current_time');
    console.log(`[DB] PostgreSQL connected at ${result.rows[0].current_time}`);
  } finally {
    client.release();
  }
}

async function closeDatabasePool() {
  await db.end();
  console.log('[DB] Connection pool closed');
}

module.exports = {
  db,
  testDatabaseConnection,
  closeDatabasePool,
};
