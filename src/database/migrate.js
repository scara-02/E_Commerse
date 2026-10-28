const { db, testDatabaseConnection, closeDatabasePool } = require('../config/database');

const MIGRATION_SQL = `
-- ─── Users Table ───
CREATE TABLE IF NOT EXISTS users (
    id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    username        VARCHAR(100) UNIQUE NOT NULL,
    email           VARCHAR(255) UNIQUE NOT NULL,
    password_hash   VARCHAR(255) NOT NULL,
    phone_verified  BOOLEAN DEFAULT false,
    account_created TIMESTAMPTZ DEFAULT NOW(),
    is_active       BOOLEAN DEFAULT true,
    created_at      TIMESTAMPTZ DEFAULT NOW(),
    updated_at      TIMESTAMPTZ DEFAULT NOW()
);

-- ─── Products Table ───
CREATE TABLE IF NOT EXISTS products (
    id             VARCHAR(100) PRIMARY KEY,
    name           VARCHAR(255) NOT NULL,
    description    TEXT,
    price          DECIMAL(12, 2) NOT NULL,
    original_price DECIMAL(12, 2),
    category       VARCHAR(100) DEFAULT 'General',
    badge          VARCHAR(50),
    rating         DECIMAL(3, 2) DEFAULT 4.8,
    reviews_count  INTEGER DEFAULT 100,
    is_flash_sale  BOOLEAN DEFAULT false,
    image_url      VARCHAR(500),
    created_at     TIMESTAMPTZ DEFAULT NOW()
);

ALTER TABLE products ADD COLUMN IF NOT EXISTS original_price DECIMAL(12, 2);
ALTER TABLE products ADD COLUMN IF NOT EXISTS category VARCHAR(100) DEFAULT 'General';
ALTER TABLE products ADD COLUMN IF NOT EXISTS badge VARCHAR(50);
ALTER TABLE products ADD COLUMN IF NOT EXISTS rating DECIMAL(3, 2) DEFAULT 4.8;
ALTER TABLE products ADD COLUMN IF NOT EXISTS reviews_count INTEGER DEFAULT 100;
ALTER TABLE products ADD COLUMN IF NOT EXISTS is_flash_sale BOOLEAN DEFAULT false;

-- ─── Inventory Table (the critical table) ───
CREATE TABLE IF NOT EXISTS inventory (
    id          SERIAL PRIMARY KEY,
    product_id  VARCHAR(100) UNIQUE NOT NULL REFERENCES products(id),
    total_stock INTEGER NOT NULL CHECK (total_stock >= 0),
    stock       INTEGER NOT NULL CHECK (stock >= 0),
    reserved    INTEGER NOT NULL DEFAULT 0 CHECK (reserved >= 0),
    updated_at  TIMESTAMPTZ DEFAULT NOW()
);

-- ─── Orders Table ───
CREATE TABLE IF NOT EXISTS orders (
    id                UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id           UUID NOT NULL REFERENCES users(id),
    product_id        VARCHAR(100) NOT NULL REFERENCES products(id),
    status            VARCHAR(50) NOT NULL DEFAULT 'RESERVED',
    reservation_token VARCHAR(255),
    idempotency_key   VARCHAR(255) UNIQUE NOT NULL,
    amount            DECIMAL(12, 2),
    payment_intent_id VARCHAR(255),
    retry_count       INTEGER DEFAULT 0,
    expires_at        TIMESTAMPTZ,
    confirmed_at      TIMESTAMPTZ,
    cancelled_at      TIMESTAMPTZ,
    created_at        TIMESTAMPTZ DEFAULT NOW(),
    updated_at        TIMESTAMPTZ DEFAULT NOW(),

    CONSTRAINT valid_status CHECK (
        status IN ('RESERVED', 'CONFIRMED', 'EXPIRED', 'CANCELLED', 'FAILED', 'PAYMENT_PENDING')
    )
);

-- ─── Sale Events Table (tracks flash sale configurations) ───
CREATE TABLE IF NOT EXISTS sale_events (
    id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    product_id      VARCHAR(100) NOT NULL REFERENCES products(id),
    sale_name       VARCHAR(255) NOT NULL,
    start_time      TIMESTAMPTZ NOT NULL,
    end_time        TIMESTAMPTZ,
    total_units     INTEGER NOT NULL,
    max_per_user    INTEGER NOT NULL DEFAULT 1,
    reservation_ttl INTEGER NOT NULL DEFAULT 300,
    is_active       BOOLEAN DEFAULT false,
    created_at      TIMESTAMPTZ DEFAULT NOW()
);

-- ─── Audit Log ───
CREATE TABLE IF NOT EXISTS audit_log (
    id          BIGSERIAL PRIMARY KEY,
    event_type  VARCHAR(100) NOT NULL,
    entity_type VARCHAR(100),
    entity_id   VARCHAR(255),
    user_id     UUID,
    details     JSONB,
    created_at  TIMESTAMPTZ DEFAULT NOW()
);

-- ─── Indices for performance ───
CREATE INDEX IF NOT EXISTS idx_orders_user_product 
    ON orders(user_id, product_id);

CREATE INDEX IF NOT EXISTS idx_orders_status 
    ON orders(status);

CREATE INDEX IF NOT EXISTS idx_orders_expires_at 
    ON orders(expires_at) WHERE status = 'RESERVED';

CREATE INDEX IF NOT EXISTS idx_orders_idempotency 
    ON orders(idempotency_key);

CREATE INDEX IF NOT EXISTS idx_inventory_product 
    ON inventory(product_id);

CREATE INDEX IF NOT EXISTS idx_audit_event_type 
    ON audit_log(event_type, created_at);

-- ─── Updated_at trigger function ───
CREATE OR REPLACE FUNCTION update_modified_column()
RETURNS TRIGGER AS $$
BEGIN
    NEW.updated_at = NOW();
    RETURN NEW;
END;
$$ language 'plpgsql';

-- Apply trigger to relevant tables
DO $$
BEGIN
    IF NOT EXISTS (SELECT 1 FROM pg_trigger WHERE tgname = 'update_users_modtime') THEN
        CREATE TRIGGER update_users_modtime
            BEFORE UPDATE ON users
            FOR EACH ROW EXECUTE FUNCTION update_modified_column();
    END IF;

    IF NOT EXISTS (SELECT 1 FROM pg_trigger WHERE tgname = 'update_inventory_modtime') THEN
        CREATE TRIGGER update_inventory_modtime
            BEFORE UPDATE ON inventory
            FOR EACH ROW EXECUTE FUNCTION update_modified_column();
    END IF;

    IF NOT EXISTS (SELECT 1 FROM pg_trigger WHERE tgname = 'update_orders_modtime') THEN
        CREATE TRIGGER update_orders_modtime
            BEFORE UPDATE ON orders
            FOR EACH ROW EXECUTE FUNCTION update_modified_column();
    END IF;
END
$$;
`;

async function migrate() {
  console.log('[Migration] Starting database migration...');

  try {
    await testDatabaseConnection();
    await db.query(MIGRATION_SQL);
    console.log('[Migration] All tables, indices, and triggers created successfully');
  } catch (error) {
    console.error('[Migration] Failed:', error);
    process.exit(1);
  } finally {
    await closeDatabasePool();
  }
}

migrate();
