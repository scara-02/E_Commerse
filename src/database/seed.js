const bcrypt = require('bcrypt');
const { db, testDatabaseConnection, closeDatabasePool } = require('../config/database');
const { env } = require('../config/env');

async function seed() {
  console.log('[Seed] Starting database seeding...');

  try {
    await testDatabaseConnection();

    const catalogProducts = [
      {
        id: env.SALE_PRODUCT_ID,
        name: 'Festival Edition Smartphone',
        description: 'Limited edition flagship smartphone with festival aesthetic. 256GB storage, 8GB RAM, 120Hz AMOLED display.',
        price: 29999.00,
        original_price: 49999.00,
        category: 'Smartphones',
        badge: '⚡ FLASH SALE',
        rating: 4.90,
        reviews_count: 1248,
        is_flash_sale: true,
        image_url: 'https://images.unsplash.com/photo-1592899677977-9c10ca588bbd?w=800&auto=format&fit=crop&q=80',
        stock: env.SALE_TOTAL_STOCK,
      },
      {
        id: 'laptop_aurabook',
        name: 'AuraBook Pro 16"',
        description: 'Computational flagship powered by 14-core architecture, 36GB unified memory, and Liquid Retina XDR display.',
        price: 149999.00,
        original_price: 169999.00,
        category: 'Computing',
        badge: 'NEW ARRIVAL',
        rating: 4.95,
        reviews_count: 412,
        is_flash_sale: false,
        image_url: 'https://images.unsplash.com/photo-1517336714731-489689fd1ca8?w=800&auto=format&fit=crop&q=80',
        stock: 50,
      },
      {
        id: 'audio_sonicpulse',
        name: 'SonicPulse ANC Studio Headphones',
        description: 'Studio-grade over-ear acoustic precision with 45dB hybrid active noise cancellation and 40-hour ultra battery life.',
        price: 14999.00,
        original_price: 19999.00,
        category: 'Audio',
        badge: 'BEST SELLER',
        rating: 4.82,
        reviews_count: 850,
        is_flash_sale: false,
        image_url: 'https://images.unsplash.com/photo-1505740420928-5e560c06d30e?w=800&auto=format&fit=crop&q=80',
        stock: 120,
      },
      {
        id: 'wearable_horizon',
        name: 'Horizon Watch Ultra Titanium',
        description: 'Aerospace-grade titanium chassis with sapphire glass, dual-frequency precision GPS, and comprehensive ECG vitals.',
        price: 24999.00,
        original_price: 32999.00,
        category: 'Wearables',
        badge: 'POPULAR',
        rating: 4.88,
        reviews_count: 620,
        is_flash_sale: false,
        image_url: 'https://images.unsplash.com/photo-1523275335684-37898b6baf30?w=800&auto=format&fit=crop&q=80',
        stock: 80,
      },
      {
        id: 'audio_airbuds',
        name: 'AirBuds Studio 2 Pro',
        description: 'True wireless earbuds with adaptive transparency, personalized spatial soundstage, and MagSafe quick-charge case.',
        price: 8999.00,
        original_price: 12999.00,
        category: 'Audio',
        badge: 'TRENDING',
        rating: 4.75,
        reviews_count: 940,
        is_flash_sale: false,
        image_url: 'https://images.unsplash.com/photo-1572536147248-ac59a8abfa4b?w=800&auto=format&fit=crop&q=80',
        stock: 200,
      },
      {
        id: 'acc_omnicharge',
        name: 'OmniCharge 100W GaN Station',
        description: 'Ultra-dense Gallium Nitride 4-port power delivery system. Fast charge two laptops and two phones at full speed.',
        price: 3499.00,
        original_price: 4999.00,
        category: 'Accessories',
        badge: 'MUST HAVE',
        rating: 4.70,
        reviews_count: 310,
        is_flash_sale: false,
        image_url: 'https://images.unsplash.com/photo-1583863788434-e58a36330cf0?w=800&auto=format&fit=crop&q=80',
        stock: 350,
      },
      {
        id: 'acc_mechkeys',
        name: 'MechKeys Pro 75% Wireless',
        description: 'Compact hot-swappable mechanical keyboard with custom lubricated switches, CNC aluminum body, and gasket mount.',
        price: 6499.00,
        original_price: 8999.00,
        category: 'Accessories',
        badge: 'FEATURED',
        rating: 4.91,
        reviews_count: 530,
        is_flash_sale: false,
        image_url: 'https://images.unsplash.com/photo-1587829741301-dc798b83add3?w=800&auto=format&fit=crop&q=80',
        stock: 95,
      },
      {
        id: 'comp_cybercam',
        name: 'CyberCam 4K Streamer Pro',
        description: 'Studio broadcast 4K 60FPS webcam with AI auto-framing, dual noise-filtering stereo mics, and magnetic privacy cover.',
        price: 9999.00,
        original_price: 13999.00,
        category: 'Computing',
        badge: "EDITOR'S PICK",
        rating: 4.65,
        reviews_count: 180,
        is_flash_sale: false,
        image_url: 'https://images.unsplash.com/photo-1588508065123-287b28e013da?w=800&auto=format&fit=crop&q=80',
        stock: 65,
      },
    ];

    for (const p of catalogProducts) {
      await db.query(`
        INSERT INTO products (id, name, description, price, original_price, category, badge, rating, reviews_count, is_flash_sale, image_url)
        VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)
        ON CONFLICT (id) DO UPDATE SET 
          name = EXCLUDED.name,
          description = EXCLUDED.description,
          price = EXCLUDED.price,
          original_price = EXCLUDED.original_price,
          category = EXCLUDED.category,
          badge = EXCLUDED.badge,
          rating = EXCLUDED.rating,
          reviews_count = EXCLUDED.reviews_count,
          is_flash_sale = EXCLUDED.is_flash_sale,
          image_url = EXCLUDED.image_url
      `, [
        p.id, p.name, p.description, p.price, p.original_price,
        p.category, p.badge, p.rating, p.reviews_count, p.is_flash_sale, p.image_url
      ]);

      await db.query(`
        INSERT INTO inventory (product_id, total_stock, stock, reserved)
        VALUES ($1, $2, $3, 0)
        ON CONFLICT (product_id) DO UPDATE SET
          total_stock = EXCLUDED.total_stock,
          stock = EXCLUDED.stock
      `, [p.id, p.stock, p.stock]);
    }
    console.log(`[Seed] ${catalogProducts.length} products & inventory seeded successfully`);

    const passwordHash = await bcrypt.hash('DemoPass123!', 12);
    const demoUsers = [
      { username: 'alice_demo', email: 'alice@demo.com' },
      { username: 'bob_demo', email: 'bob@demo.com' },
      { username: 'charlie_demo', email: 'charlie@demo.com' },
      { username: 'diana_demo', email: 'diana@demo.com' },
      { username: 'eve_demo', email: 'eve@demo.com' },
    ];

    for (const user of demoUsers) {
      await db.query(`
        INSERT INTO users (username, email, password_hash, phone_verified, account_created)
        VALUES ($1, $2, $3, true, NOW() - INTERVAL '30 days')
        ON CONFLICT (username) DO NOTHING
      `, [user.username, user.email, passwordHash]);
    }
    console.log(`[Seed] ${demoUsers.length} demo users inserted`);

    await db.query(`
      INSERT INTO sale_events (product_id, sale_name, start_time, total_units, max_per_user, reservation_ttl, is_active)
      VALUES ($1, $2, $3, $4, $5, $6, true)
      ON CONFLICT DO NOTHING
    `, [
      env.SALE_PRODUCT_ID,
      '8PM Festival Flash Sale',
      env.SALE_START_TIME,
      env.SALE_TOTAL_STOCK,
      env.SALE_MAX_PER_USER,
      env.SALE_RESERVATION_TTL_SECONDS,
    ]);
    console.log('[Seed] Sale event created');

    console.log('[Seed] Database seeding complete!');
  } catch (error) {
    console.error('[Seed] Failed:', error);
    process.exit(1);
  } finally {
    await closeDatabasePool();
  }
}

seed();
