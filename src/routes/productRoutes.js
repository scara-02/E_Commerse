const { Router } = require('express');
const { db } = require('../config/database');

const router = Router();

// GET /api/v1/products - List products with inventory, categories, search and filters
router.get('/', async (req, res) => {
  const { category, q, sort } = req.query;

  try {
    let query = `
      SELECT p.*, i.stock as available_stock, i.total_stock, i.reserved
      FROM products p
      LEFT JOIN inventory i ON p.id = i.product_id
      WHERE 1=1
    `;
    const params = [];

    if (category && category !== 'All' && category !== '⚡ Flash Deals') {
      params.push(category);
      query += ` AND p.category = $${params.length}`;
    } else if (category === '⚡ Flash Deals') {
      query += ` AND p.is_flash_sale = true`;
    }

    if (q) {
      params.push(`%${q.toLowerCase()}%`);
      query += ` AND (LOWER(p.name) LIKE $${params.length} OR LOWER(p.description) LIKE $${params.length})`;
    }

    if (sort === 'price_asc') {
      query += ` ORDER BY p.price ASC`;
    } else if (sort === 'price_desc') {
      query += ` ORDER BY p.price DESC`;
    } else if (sort === 'rating_desc') {
      query += ` ORDER BY p.rating DESC`;
    } else {
      query += ` ORDER BY p.is_flash_sale DESC, p.created_at ASC`;
    }

    const result = await db.query(query, params);

    const products = result.rows.map((row) => ({
      id: row.id,
      name: row.name,
      description: row.description,
      price: parseFloat(row.price),
      originalPrice: row.original_price ? parseFloat(row.original_price) : null,
      discountPercent: row.original_price ? Math.round(((row.original_price - row.price) / row.original_price) * 100) : null,
      category: row.category,
      badge: row.badge,
      rating: parseFloat(row.rating),
      reviewsCount: row.reviews_count,
      isFlashSale: row.is_flash_sale,
      imageUrl: row.image_url,
      stock: row.available_stock != null ? row.available_stock : 0,
      totalStock: row.total_stock != null ? row.total_stock : 0,
      inStock: (row.available_stock != null ? row.available_stock : 0) > 0,
    }));

    res.json({
      success: true,
      count: products.length,
      products,
    });
  } catch (error) {
    console.error('[Products] Failed to fetch products:', error);
    res.status(500).json({ error: 'INTERNAL_ERROR', message: 'Failed to retrieve catalog' });
  }
});

// GET /api/v1/products/:id - Single product details
router.get('/:id', async (req, res) => {
  const { id } = req.params;

  try {
    const result = await db.query(
      `SELECT p.*, i.stock as available_stock, i.total_stock, i.reserved
       FROM products p
       LEFT JOIN inventory i ON p.id = i.product_id
       WHERE p.id = $1`,
      [id]
    );

    if (result.rows.length === 0) {
      res.status(404).json({ error: 'NOT_FOUND', message: 'Product not found' });
      return;
    }

    const row = result.rows[0];
    res.json({
      success: true,
      product: {
        id: row.id,
        name: row.name,
        description: row.description,
        price: parseFloat(row.price),
        originalPrice: row.original_price ? parseFloat(row.original_price) : null,
        discountPercent: row.original_price ? Math.round(((row.original_price - row.price) / row.original_price) * 100) : null,
        category: row.category,
        badge: row.badge,
        rating: parseFloat(row.rating),
        reviewsCount: row.reviews_count,
        isFlashSale: row.is_flash_sale,
        imageUrl: row.image_url,
        stock: row.available_stock != null ? row.available_stock : 0,
        totalStock: row.total_stock != null ? row.total_stock : 0,
        inStock: (row.available_stock != null ? row.available_stock : 0) > 0,
      },
    });
  } catch (error) {
    console.error(`[Products] Failed to fetch product ${id}:`, error);
    res.status(500).json({ error: 'INTERNAL_ERROR' });
  }
});

module.exports = router;

