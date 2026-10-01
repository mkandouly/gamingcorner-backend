import express from 'express';
import multer from 'multer';
import path from 'path';
import fs from 'fs';
import sharp from 'sharp';
import pool from '../../db.js';
import { requireAuth, requirePermission } from '../middleware/auth.js';
import { sendOrderStatusEmail } from '../lib/mailer.js';

const router = express.Router();

// Every route below requires a valid, active admin session. Per-route
// requirePermission(...) calls further restrict by what that account is
// allowed to do — root accounts skip permission checks entirely.
router.use(requireAuth);

// ------------------------------------------------------------------
// Shared helpers
// ------------------------------------------------------------------

// Reads ?page=&limit= from the request, clamped to sane bounds. Every list
// endpoint below uses this the same way, so pagination behaves identically
// across Products/Categories/Subcategories/Brands/Banners/Orders/Subscribers.
const DEFAULT_LIMIT = 20;
const MAX_LIMIT = 100;

function getPagination(req) {
  let page = parseInt(req.query.page, 10);
  let limit = parseInt(req.query.limit, 10);

  if (!Number.isFinite(page) || page < 1) page = 1;
  if (!Number.isFinite(limit) || limit < 1) limit = DEFAULT_LIMIT;
  if (limit > MAX_LIMIT) limit = MAX_LIMIT;

  return { page, limit, offset: (page - 1) * limit };
}

function paginationMeta(page, limit, total) {
  return { page, limit, total, totalPages: Math.max(1, Math.ceil(total / limit)) };
}

// Postgres unique_violation. Every resource with a UNIQUE column (products.sku,
// categories.slug, subcategories.slug) uses this so the admin panel shows
// "That slug is already in use" instead of a raw 500 error.
function isUniqueViolation(err) {
  return err && err.code === '23505';
}

function uniqueViolationMessage(err, fallback) {
  // Postgres includes the offending column in the constraint/detail text
  // where possible; fall back to a generic message if we can't tell.
  const detail = err.detail || '';
  const match = detail.match(/Key \((\w+)\)=\(([^)]+)\)/);
  if (match) {
    const [, column, value] = match;
    return `That ${column.replace(/_/g, ' ')} ("${value}") is already in use.`;
  }
  return fallback;
}

// Ensure 'uploads' directory exists
const uploadDir = path.join(process.cwd(), 'uploads');
if (!fs.existsSync(uploadDir)) {
  fs.mkdirSync(uploadDir, { recursive: true });
}

// Multer buffers the upload in memory instead of writing the original
// straight to disk — sharp then resizes/re-encodes it before anything ever
// touches the filesystem, so the original, uncompressed file is never saved.
const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 10 * 1024 * 1024 }, // generous on the way in; output is much smaller
  fileFilter: (req, file, cb) => {
    if (file.mimetype.startsWith('image/')) cb(null, true);
    else cb(new Error('Only image files are allowed!'), false);
  },
});

// Resizes to a sane max dimension for web display (nothing on this storefront
// is ever shown larger than this) and re-encodes as WebP at a quality level
// that's visually indistinguishable from the source but a fraction of the
// size — typically 60-90% smaller than an equivalent-quality JPEG/PNG,
// especially for phone-camera photos that arrive far larger than needed.
// withoutEnlargement means a small image is never scaled up and degraded.
const MAX_DIMENSION = 1920;
const WEBP_QUALITY = 88;

async function compressAndSaveImage(buffer) {
  const uniqueSuffix = Date.now() + '-' + Math.round(Math.random() * 1e9);
  const filename = `image-${uniqueSuffix}.webp`;
  const outputPath = path.join(uploadDir, filename);

  await sharp(buffer)
    .rotate() // apply EXIF orientation before stripping metadata, so photos don't end up sideways
    .resize({
      width: MAX_DIMENSION,
      height: MAX_DIMENSION,
      fit: 'inside',
      withoutEnlargement: true,
    })
    .webp({ quality: WEBP_QUALITY })
    .toFile(outputPath);

  return `/uploads/${filename}`;
}

// ==========================================
// FILE UPLOADS
// ==========================================
router.post('/upload/single', requirePermission('media.upload'), upload.single('image'), async (req, res) => {
  if (!req.file) return res.status(400).json({ success: false, message: 'No file uploaded' });

  try {
    const imageUrl = await compressAndSaveImage(req.file.buffer);
    res.json({ success: true, imageUrl });
  } catch (err) {
    console.error('Image compression failed:', err);
    res.status(500).json({ success: false, message: 'Failed to process image.' });
  }
});

router.post('/upload/multiple', requirePermission('media.upload'), upload.array('images', 10), async (req, res) => {
  if (!req.files || req.files.length === 0) return res.status(400).json({ success: false, message: 'No files uploaded' });

  try {
    const imageUrls = await Promise.all(req.files.map((file) => compressAndSaveImage(file.buffer)));
    res.json({ success: true, imageUrls });
  } catch (err) {
    console.error('Image compression failed:', err);
    res.status(500).json({ success: false, message: 'Failed to process images.' });
  }
});

// ==========================================
// CATEGORIES
// ==========================================
router.get('/categories', requirePermission('categories.view'), async (req, res) => {
  try {
    const { page, limit, offset } = getPagination(req);
    const [rows, count] = await Promise.all([
      pool.query('SELECT * FROM categories ORDER BY id DESC LIMIT $1 OFFSET $2', [limit, offset]),
      pool.query('SELECT COUNT(*)::int AS count FROM categories'),
    ]);
    res.json({ success: true, data: rows.rows, pagination: paginationMeta(page, limit, count.rows[0].count) });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

router.post('/categories', requirePermission('categories.create'), async (req, res) => {
  try {
    const { name, slug, is_hot } = req.body;
    const result = await pool.query(
      'INSERT INTO categories (name, slug, is_hot) VALUES ($1, $2, $3) RETURNING *',
      [name, slug, is_hot || false]
    );
    res.status(201).json({ success: true, data: result.rows[0] });
  } catch (err) {
    if (isUniqueViolation(err)) {
      return res.status(409).json({ success: false, message: uniqueViolationMessage(err, 'That slug is already in use.') });
    }
    res.status(500).json({ success: false, error: err.message });
  }
});

router.put('/categories/:id', requirePermission('categories.edit'), async (req, res) => {
  try {
    const { id } = req.params;
    const { name, slug, is_hot } = req.body;
    const result = await pool.query(
      'UPDATE categories SET name = $1, slug = $2, is_hot = $3 WHERE id = $4 RETURNING *',
      [name, slug, is_hot || false, id]
    );
    res.json({ success: true, data: result.rows[0] });
  } catch (err) {
    if (isUniqueViolation(err)) {
      return res.status(409).json({ success: false, message: uniqueViolationMessage(err, 'That slug is already in use.') });
    }
    res.status(500).json({ success: false, error: err.message });
  }
});

router.delete('/categories/:id', requirePermission('categories.delete'), async (req, res) => {
  try {
    await pool.query('DELETE FROM categories WHERE id = $1', [req.params.id]);
    res.json({ success: true, message: `Category ${req.params.id} deleted` });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// ==========================================
// SUBCATEGORIES
// ==========================================
router.get('/subcategories', requirePermission('subcategories.view'), async (req, res) => {
  try {
    const { page, limit, offset } = getPagination(req);
    const [rows, count] = await Promise.all([
      pool.query('SELECT * FROM subcategories ORDER BY id DESC LIMIT $1 OFFSET $2', [limit, offset]),
      pool.query('SELECT COUNT(*)::int AS count FROM subcategories'),
    ]);
    res.json({ success: true, data: rows.rows, pagination: paginationMeta(page, limit, count.rows[0].count) });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

router.post('/subcategories', requirePermission('subcategories.create'), async (req, res) => {
  try {
    const { name, slug, parent_id, is_featured } = req.body;
    const result = await pool.query(
      'INSERT INTO subcategories (name, slug, parent_id, is_featured) VALUES ($1, $2, $3, $4) RETURNING *',
      [name, slug, parent_id, is_featured || false]
    );
    res.status(201).json({ success: true, data: result.rows[0] });
  } catch (err) {
    if (isUniqueViolation(err)) {
      return res.status(409).json({ success: false, message: uniqueViolationMessage(err, 'That slug is already in use.') });
    }
    res.status(500).json({ success: false, error: err.message });
  }
});

router.put('/subcategories/:id', requirePermission('subcategories.edit'), async (req, res) => {
  try {
    const { id } = req.params;
    const { name, slug, parent_id, is_featured } = req.body;
    const result = await pool.query(
      'UPDATE subcategories SET name = $1, slug = $2, parent_id = $3, is_featured = $4 WHERE id = $5 RETURNING *',
      [name, slug, parent_id, is_featured || false, id]
    );
    res.json({ success: true, data: result.rows[0] });
  } catch (err) {
    if (isUniqueViolation(err)) {
      return res.status(409).json({ success: false, message: uniqueViolationMessage(err, 'That slug is already in use.') });
    }
    res.status(500).json({ success: false, error: err.message });
  }
});

router.delete('/subcategories/:id', requirePermission('subcategories.delete'), async (req, res) => {
  try {
    await pool.query('DELETE FROM subcategories WHERE id = $1', [req.params.id]);
    res.json({ success: true, message: `Subcategory ${req.params.id} deleted` });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// ==========================================
// NEWSLETTER SUBSCRIBERS
// ==========================================
router.get('/subscribers', requirePermission('subscribers.view'), async (req, res) => {
  try {
    const { page, limit, offset } = getPagination(req);
    const [rows, count] = await Promise.all([
      pool.query('SELECT * FROM newsletter_subscribers ORDER BY id DESC LIMIT $1 OFFSET $2', [limit, offset]),
      pool.query('SELECT COUNT(*)::int AS count FROM newsletter_subscribers'),
    ]);
    res.json({ success: true, data: rows.rows, pagination: paginationMeta(page, limit, count.rows[0].count) });
  } catch (error) {
    console.error('Subscribers fetch error:', error);
    res.status(500).json({ success: false, message: error.message });
  }
});

// ==========================================
// BRANDS
// ==========================================
router.get('/brands', requirePermission('brands.view'), async (req, res) => {
  try {
    const { page, limit, offset } = getPagination(req);
    const [rows, count] = await Promise.all([
      pool.query('SELECT * FROM brands ORDER BY id DESC LIMIT $1 OFFSET $2', [limit, offset]),
      pool.query('SELECT COUNT(*)::int AS count FROM brands'),
    ]);
    res.json({ success: true, data: rows.rows, pagination: paginationMeta(page, limit, count.rows[0].count) });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

router.post('/brands', requirePermission('brands.create'), async (req, res) => {
  try {
    const { name, logo_url, is_featured, is_popular } = req.body;
    const result = await pool.query(
      'INSERT INTO brands (name, logo_url, is_featured, is_popular) VALUES ($1, $2, $3, $4) RETURNING *',
      [name, logo_url || null, is_featured || false, is_popular || false]
    );
    res.status(201).json({ success: true, data: result.rows[0] });
  } catch (err) {
    if (isUniqueViolation(err)) {
      return res.status(409).json({ success: false, message: uniqueViolationMessage(err, 'A brand with that name already exists.') });
    }
    res.status(500).json({ success: false, error: err.message });
  }
});

router.put('/brands/:id', requirePermission('brands.edit'), async (req, res) => {
  try {
    const { id } = req.params;
    const { name, logo_url, is_featured, is_popular } = req.body;
    const result = await pool.query(
      'UPDATE brands SET name = $1, logo_url = $2, is_featured = $3, is_popular = $4 WHERE id = $5 RETURNING *',
      [name, logo_url || null, is_featured || false, is_popular || false, id]
    );
    res.json({ success: true, data: result.rows[0] });
  } catch (err) {
    if (isUniqueViolation(err)) {
      return res.status(409).json({ success: false, message: uniqueViolationMessage(err, 'A brand with that name already exists.') });
    }
    res.status(500).json({ success: false, error: err.message });
  }
});

router.delete('/brands/:id', requirePermission('brands.delete'), async (req, res) => {
  try {
    await pool.query('DELETE FROM brands WHERE id = $1', [req.params.id]);
    res.json({ success: true, message: `Brand ${req.params.id} deleted` });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// ==========================================
// DISTRIBUTORS
// ==========================================
router.get('/distributors', requirePermission('distributors.view'), async (req, res) => {
  try {
    const { page, limit, offset } = getPagination(req);
    const [rows, count] = await Promise.all([
      pool.query('SELECT * FROM distributors ORDER BY name ASC LIMIT $1 OFFSET $2', [limit, offset]),
      pool.query('SELECT COUNT(*)::int AS count FROM distributors'),
    ]);
    res.json({ success: true, data: rows.rows, pagination: paginationMeta(page, limit, count.rows[0].count) });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

router.post('/distributors', requirePermission('distributors.create'), async (req, res) => {
  try {
    const { name, contact_person, phone, email, address, notes } = req.body;

    if (!name?.trim()) {
      return res.status(400).json({ success: false, message: 'Distributor name is required.' });
    }

    const result = await pool.query(
      `INSERT INTO distributors (name, contact_person, phone, email, address, notes)
       VALUES ($1, $2, $3, $4, $5, $6) RETURNING *`,
      [name.trim(), contact_person?.trim() || null, phone?.trim() || null, email?.trim() || null, address?.trim() || null, notes?.trim() || null]
    );
    res.status(201).json({ success: true, data: result.rows[0] });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

router.put('/distributors/:id', requirePermission('distributors.edit'), async (req, res) => {
  try {
    const { id } = req.params;
    const { name, contact_person, phone, email, address, notes } = req.body;

    if (!name?.trim()) {
      return res.status(400).json({ success: false, message: 'Distributor name is required.' });
    }

    const result = await pool.query(
      `UPDATE distributors SET name = $1, contact_person = $2, phone = $3, email = $4, address = $5, notes = $6
       WHERE id = $7 RETURNING *`,
      [name.trim(), contact_person?.trim() || null, phone?.trim() || null, email?.trim() || null, address?.trim() || null, notes?.trim() || null, id]
    );

    if (result.rows.length === 0) {
      return res.status(404).json({ success: false, message: 'Distributor not found.' });
    }

    res.json({ success: true, data: result.rows[0] });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

router.delete('/distributors/:id', requirePermission('distributors.delete'), async (req, res) => {
  try {
    const result = await pool.query('DELETE FROM distributors WHERE id = $1 RETURNING id', [req.params.id]);
    if (result.rows.length === 0) {
      return res.status(404).json({ success: false, message: 'Distributor not found.' });
    }
    res.json({ success: true, message: `Distributor ${req.params.id} deleted` });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// ==========================================
// PRODUCTS
// ==========================================
router.get('/products', requirePermission('products.view'), async (req, res) => {
  try {
    const { page, limit, offset } = getPagination(req);
    const [rows, count] = await Promise.all([
      pool.query('SELECT * FROM products ORDER BY id DESC LIMIT $1 OFFSET $2', [limit, offset]),
      pool.query('SELECT COUNT(*)::int AS count FROM products'),
    ]);
    res.json({ success: true, data: rows.rows, pagination: paginationMeta(page, limit, count.rows[0].count) });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

router.post('/products', requirePermission('products.create'), async (req, res) => {
  try {
    const { sku, name, description, price, sale_price, brand_id, category_slug, image_url, images, out_of_stock } = req.body;
    const result = await pool.query(
      `INSERT INTO products (sku, name, description, price, sale_price, brand_id, category_slug, image_url, images, out_of_stock)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10) RETURNING *`,
      [
        sku,
        name,
        description || null,
        price,
        sale_price || null,
        brand_id,
        category_slug || null,
        image_url || null,
        JSON.stringify(images || []),
        out_of_stock || false,
      ]
    );
    res.status(201).json({ success: true, data: result.rows[0] });
  } catch (err) {
    if (isUniqueViolation(err)) {
      return res.status(409).json({ success: false, message: uniqueViolationMessage(err, 'That SKU is already in use.') });
    }
    res.status(500).json({ success: false, error: err.message });
  }
});

router.put('/products/:id', requirePermission('products.edit'), async (req, res) => {
  try {
    const { id } = req.params;
    const { sku, name, description, price, sale_price, brand_id, category_slug, image_url, images, out_of_stock } = req.body;
    const result = await pool.query(
      `UPDATE products
       SET sku = $1, name = $2, description = $3, price = $4, sale_price = $5,
           brand_id = $6, category_slug = $7, image_url = $8, images = $9, out_of_stock = $10
       WHERE id = $11 RETURNING *`,
      [
        sku,
        name,
        description || null,
        price,
        sale_price || null,
        brand_id,
        category_slug || null,
        image_url || null,
        JSON.stringify(images || []),
        out_of_stock || false,
        id,
      ]
    );
    res.json({ success: true, data: result.rows[0] });
  } catch (err) {
    if (isUniqueViolation(err)) {
      return res.status(409).json({ success: false, message: uniqueViolationMessage(err, 'That SKU is already in use.') });
    }
    res.status(500).json({ success: false, error: err.message });
  }
});

router.delete('/products/:id', requirePermission('products.delete'), async (req, res) => {
  try {
    await pool.query('DELETE FROM products WHERE id = $1', [req.params.id]);
    res.json({ success: true, message: `Product ${req.params.id} deleted` });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// ------------------------------------------------------------------
// PRODUCT SPECIFICATIONS (nested under a product)
// ------------------------------------------------------------------
// These reuse products.view/edit rather than having their own permission
// keys — managing a product's spec sheet is part of editing that product,
// not a separately grantable capability.
router.get('/products/:productId/specifications', requirePermission('products.view'), async (req, res) => {
  try {
    const { productId } = req.params;
    const result = await pool.query(
      'SELECT * FROM product_specifications WHERE product_id = $1 ORDER BY id ASC',
      [productId]
    );
    res.json({ success: true, data: result.rows });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

router.post('/products/:productId/specifications', requirePermission('products.edit'), async (req, res) => {
  try {
    const { productId } = req.params;
    const { specification, details } = req.body;

    if (!specification?.trim() || !details?.trim()) {
      return res.status(400).json({ success: false, message: 'Both a specification name and its value are required.' });
    }

    const result = await pool.query(
      'INSERT INTO product_specifications (product_id, specification, details) VALUES ($1, $2, $3) RETURNING *',
      [productId, specification.trim(), details.trim()]
    );
    res.status(201).json({ success: true, data: result.rows[0] });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

router.put('/specifications/:id', requirePermission('products.edit'), async (req, res) => {
  try {
    const { id } = req.params;
    const { specification, details } = req.body;

    if (!specification?.trim() || !details?.trim()) {
      return res.status(400).json({ success: false, message: 'Both a specification name and its value are required.' });
    }

    const result = await pool.query(
      'UPDATE product_specifications SET specification = $1, details = $2 WHERE id = $3 RETURNING *',
      [specification.trim(), details.trim(), id]
    );

    if (result.rows.length === 0) {
      return res.status(404).json({ success: false, message: 'Specification not found.' });
    }

    res.json({ success: true, data: result.rows[0] });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

router.delete('/specifications/:id', requirePermission('products.edit'), async (req, res) => {
  try {
    const result = await pool.query('DELETE FROM product_specifications WHERE id = $1 RETURNING id', [req.params.id]);
    if (result.rows.length === 0) {
      return res.status(404).json({ success: false, message: 'Specification not found.' });
    }
    res.json({ success: true, message: 'Specification deleted.' });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// ==========================================
// BANNERS
// ==========================================
router.get('/banners', requirePermission('banners.view'), async (req, res) => {
  try {
    const { page, limit, offset } = getPagination(req);
    const [rows, count] = await Promise.all([
      pool.query('SELECT * FROM banners ORDER BY id DESC LIMIT $1 OFFSET $2', [limit, offset]),
      pool.query('SELECT COUNT(*)::int AS count FROM banners'),
    ]);
    res.json({ success: true, data: rows.rows, pagination: paginationMeta(page, limit, count.rows[0].count) });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

router.post('/banners', requirePermission('banners.create'), async (req, res) => {
  try {
    const { title, image_url, link, is_active } = req.body;
    const result = await pool.query(
      'INSERT INTO banners (title, image_url, link, is_active) VALUES ($1, $2, $3, $4) RETURNING *',
      [title, image_url, link, is_active ?? true]
    );
    res.status(201).json({ success: true, data: result.rows[0] });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

router.put('/banners/:id', requirePermission('banners.edit'), async (req, res) => {
  try {
    const { id } = req.params;
    const { title, image_url, link, is_active } = req.body;
    const result = await pool.query(
      'UPDATE banners SET title = $1, image_url = $2, link = $3, is_active = $4 WHERE id = $5 RETURNING *',
      [title, image_url, link, is_active ?? true, id]
    );
    res.json({ success: true, data: result.rows[0] });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

router.delete('/banners/:id', requirePermission('banners.delete'), async (req, res) => {
  try {
    await pool.query('DELETE FROM banners WHERE id = $1', [req.params.id]);
    res.json({ success: true, message: `Banner ${req.params.id} deleted` });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// ==========================================
// ORDERS
// ==========================================
const ORDER_STATUSES = ['pending', 'in_preparation', 'out_for_delivery', 'delivered', 'cancelled'];

// Enforced server-side so a bad/duplicate request can't skip stages or
// revive a finished order: pending -> in_preparation -> out_for_delivery ->
// delivered, with "cancelled" reachable from any non-terminal state, and
// both "delivered" and "cancelled" being dead ends.
const ALLOWED_STATUS_TRANSITIONS = {
  pending: ['in_preparation', 'cancelled'],
  in_preparation: ['out_for_delivery', 'cancelled'],
  out_for_delivery: ['delivered', 'cancelled'],
  delivered: [],
  cancelled: [],
};

router.get('/orders', requirePermission('orders.view'), async (req, res) => {
  try {
    const { page, limit, offset } = getPagination(req);
    const { status } = req.query;
    const whereClause = status ? `WHERE o.status = $1` : '';
    const params = status ? [status, limit, offset] : [limit, offset];
    const limitIdx = status ? 2 : 1;
    const offsetIdx = status ? 3 : 2;

    const sql = `
      SELECT o.*, o.subtotal + COALESCE(o.delivery_price, 0) AS total,
             COUNT(oi.id) AS item_count
      FROM orders o
      LEFT JOIN order_items oi ON oi.order_id = o.id
      ${whereClause}
      GROUP BY o.id ORDER BY o.created_at DESC
      LIMIT $${limitIdx} OFFSET $${offsetIdx}
    `;

    const countSql = `SELECT COUNT(*)::int AS count FROM orders o ${whereClause}`;
    const countParams = status ? [status] : [];

    const [rows, count] = await Promise.all([
      pool.query(sql, params),
      pool.query(countSql, countParams),
    ]);

    res.json({ success: true, data: rows.rows, pagination: paginationMeta(page, limit, count.rows[0].count) });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

router.get('/orders/:id', requirePermission('orders.view'), async (req, res) => {
  try {
    const { id } = req.params;

    const orderResult = await pool.query(
      `SELECT *, subtotal + COALESCE(delivery_price, 0) AS total FROM orders WHERE id = $1`,
      [id]
    );

    if (orderResult.rows.length === 0) {
      return res.status(404).json({ success: false, message: 'Order not found.' });
    }

    const itemsResult = await pool.query(
      `SELECT * FROM order_items WHERE order_id = $1 ORDER BY id ASC`,
      [id]
    );

    res.json({ success: true, data: { ...orderResult.rows[0], items: itemsResult.rows } });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

router.patch('/orders/:id/status', requirePermission('orders.update_status'), async (req, res) => {
  try {
    const { id } = req.params;
    const { status } = req.body;

    if (!ORDER_STATUSES.includes(status)) {
      return res.status(400).json({ success: false, message: `Invalid status: ${status}` });
    }

    const current = await pool.query('SELECT status FROM orders WHERE id = $1', [id]);
    if (current.rows.length === 0) {
      return res.status(404).json({ success: false, message: 'Order not found.' });
    }

    const currentStatus = current.rows[0].status;
    const allowedNext = ALLOWED_STATUS_TRANSITIONS[currentStatus] || [];

    if (!allowedNext.includes(status)) {
      return res.status(400).json({
        success: false,
        message: `Cannot move order from "${currentStatus}" to "${status}".`,
      });
    }

    const result = await pool.query(
      `UPDATE orders SET status = $1, updated_at = NOW() WHERE id = $2 RETURNING *`,
      [status, id]
    );

    const order = result.rows[0];
    res.json({ success: true, data: order });

    // Fire-and-forget: never let an email failure affect the response
    // already sent to the admin panel.
    sendOrderStatusEmail(order).catch((err) =>
      console.error('Failed to send order status email:', err.message)
    );
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// Store sets (or updates) the delivery price for an order — separate from
// status, since it isn't known at checkout time and may need adjusting.
router.patch('/orders/:id/delivery-price', requirePermission('orders.set_delivery_price'), async (req, res) => {
  try {
    const { id } = req.params;
    const price = Number(req.body.delivery_price);

    if (Number.isNaN(price) || price < 0) {
      return res.status(400).json({ success: false, message: 'delivery_price must be a non-negative number.' });
    }

    const result = await pool.query(
      `UPDATE orders SET delivery_price = $1, updated_at = NOW()
       WHERE id = $2
       RETURNING *, subtotal + COALESCE(delivery_price, 0) AS total`,
      [price, id]
    );

    if (result.rows.length === 0) {
      return res.status(404).json({ success: false, message: 'Order not found.' });
    }

    res.json({ success: true, data: result.rows[0] });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// ==========================================
// STOCK RECEIPTS ("IN") — batch log, no serial number
// ==========================================
// Receiving stock is a quantity+cost log, not a per-unit record: the store
// may receive items that aren't even listed on the site yet, so sku is a
// free-typed field with no FK — product_id is only set when the item IS
// linked to a listed product (picked from the dropdown in the admin UI).
router.get('/stock-receipts', requirePermission('serials.view'), async (req, res) => {
  try {
    const { page, limit, offset } = getPagination(req);
    const { sku, search, source } = req.query;

    const conditions = [];
    const params = [];

    if (sku) {
      params.push(sku);
      conditions.push(`sr.sku = $${params.length}`);
    }
    if (search) {
      params.push(`%${search.trim()}%`);
      conditions.push(`sr.sku ILIKE $${params.length}`);
    }
    if (source) {
      params.push(`%${source.trim()}%`);
      conditions.push(`sr.source ILIKE $${params.length}`);
    }

    const whereClause = conditions.length ? `WHERE ${conditions.join(' AND ')}` : '';

    const sql = `
      SELECT sr.*, p.name AS product_name
      FROM stock_receipts sr
      LEFT JOIN products p ON p.id = sr.product_id
      ${whereClause}
      ORDER BY sr.received_at DESC
      LIMIT $${params.length + 1} OFFSET $${params.length + 2}
    `;
    const countSql = `SELECT COUNT(*)::int AS count FROM stock_receipts sr ${whereClause}`;

    const [rows, count] = await Promise.all([
      pool.query(sql, [...params, limit, offset]),
      pool.query(countSql, params),
    ]);

    res.json({ success: true, data: rows.rows, pagination: paginationMeta(page, limit, count.rows[0].count) });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

router.post('/stock-receipts', requirePermission('serials.manage'), async (req, res) => {
  try {
    const { product_id, sku, quantity, cost_price, source, notes } = req.body;

    const resolvedSku = sku?.trim();
    if (!resolvedSku) {
      return res.status(400).json({ success: false, message: 'SKU is required (pick a product or type one in).' });
    }
    const qty = Number(quantity);
    if (!Number.isFinite(qty) || qty <= 0) {
      return res.status(400).json({ success: false, message: 'Quantity must be a positive number.' });
    }
    const cost = Number(cost_price);
    if (!Number.isFinite(cost) || cost < 0) {
      return res.status(400).json({ success: false, message: 'Cost price must be a non-negative number.' });
    }

    const result = await pool.query(
      `INSERT INTO stock_receipts (product_id, sku, quantity, cost_price, source, notes, received_at)
       VALUES ($1, $2, $3, $4, $5, $6, NOW())
       RETURNING *`,
      [product_id || null, resolvedSku, qty, cost, source?.trim() || null, notes?.trim() || null]
    );

    res.status(201).json({ success: true, data: result.rows[0] });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

router.delete('/stock-receipts/:id', requirePermission('serials.manage'), async (req, res) => {
  try {
    const result = await pool.query('DELETE FROM stock_receipts WHERE id = $1 RETURNING id', [req.params.id]);
    if (result.rows.length === 0) {
      return res.status(404).json({ success: false, message: 'Stock receipt not found.' });
    }
    res.json({ success: true, message: 'Stock receipt deleted.' });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// ==========================================
// SOLD UNITS / WARRANTY ("OUT") — serial number captured here, at sale time
// ==========================================
// serial_number is normalized to uppercase, trimmed, on every write and
// every lookup, so "abc123" and "ABC123" are always treated as the same
// physical unit regardless of how staff type it in.
const normalizeSerial = (s) => String(s || '').trim().toUpperCase();

router.get('/serials', requirePermission('serials.view'), async (req, res) => {
  try {
    const { page, limit, offset } = getPagination(req);
    const { sku, search, type } = req.query;

    const conditions = [];
    const params = [];

    if (sku) {
      params.push(sku);
      conditions.push(`ps.sku = $${params.length}`);
    }
    if (search) {
      params.push(`%${normalizeSerial(search)}%`);
      conditions.push(`ps.serial_number ILIKE $${params.length}`);
    }
    if (type === 'distributor') {
      conditions.push(`ps.distributor_id IS NOT NULL`);
    } else if (type === 'client') {
      conditions.push(`ps.distributor_id IS NULL`);
    }

    const whereClause = conditions.length ? `WHERE ${conditions.join(' AND ')}` : '';

    const sql = `
      SELECT ps.*, p.name AS product_name, d.name AS distributor_name,
             o.sale_price AS offer_sale_price,
             o.warranty_months AS offer_warranty_months,
             CASE WHEN COALESCE(ps.warranty_months, o.warranty_months) IS NOT NULL
                  THEN ps.sold_at + (COALESCE(ps.warranty_months, o.warranty_months) || ' months')::interval
                  ELSE NULL END AS warranty_expires_at
      FROM product_serials ps
      LEFT JOIN products p ON p.id = ps.product_id
      LEFT JOIN pc_offers o ON o.id = ps.offer_id
      LEFT JOIN distributors d ON d.id = ps.distributor_id
      ${whereClause}
      ORDER BY ps.sold_at DESC
      LIMIT $${params.length + 1} OFFSET $${params.length + 2}
    `;
    const countSql = `SELECT COUNT(*)::int AS count FROM product_serials ps ${whereClause}`;

    const [rows, count] = await Promise.all([
      pool.query(sql, [...params, limit, offset]),
      pool.query(countSql, params),
    ]);

    res.json({ success: true, data: rows.rows, pagination: paginationMeta(page, limit, count.rows[0].count) });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// Exact lookup by serial number — the main warranty-check flow: staff types
// the serial off the physical unit (or a returning customer's receipt) and
// gets back when it was sold and whether it's still under warranty. If the
// unit was sold as part of a PC Offer bundle, this also surfaces the
// bundle's total price and the rest of what shipped with it.
router.get('/serials/:serialNumber', requirePermission('serials.view'), async (req, res) => {
  try {
    const serial = normalizeSerial(req.params.serialNumber);

    const result = await pool.query(
      `SELECT ps.*, p.name AS product_name, p.image_url AS product_image_url, d.name AS distributor_name,
              o.sale_price AS offer_sale_price, o.warranty_months AS offer_warranty_months,
              o.notes AS offer_notes, o.order_id AS offer_order_id,
              CASE WHEN COALESCE(ps.warranty_months, o.warranty_months) IS NOT NULL
                   THEN ps.sold_at + (COALESCE(ps.warranty_months, o.warranty_months) || ' months')::interval
                   ELSE NULL END AS warranty_expires_at
       FROM product_serials ps
       LEFT JOIN products p ON p.id = ps.product_id
       LEFT JOIN pc_offers o ON o.id = ps.offer_id
       LEFT JOIN distributors d ON d.id = ps.distributor_id
       WHERE ps.serial_number = $1`,
      [serial]
    );

    if (result.rows.length === 0) {
      return res.status(404).json({ success: false, message: 'No sale found with that serial number.' });
    }

    const row = result.rows[0];

    if (row.offer_id) {
      const siblings = await pool.query(
        `SELECT ps.serial_number, ps.sku, ps.product_id, p.name AS product_name
         FROM product_serials ps LEFT JOIN products p ON p.id = ps.product_id
         WHERE ps.offer_id = $1 AND ps.serial_number IS DISTINCT FROM $2
         ORDER BY ps.id ASC`,
        [row.offer_id, serial]
      );
      row.offer_other_items = siblings.rows;
    }

    res.json({ success: true, data: row });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// Record a sale ("OUT") — this is where the serial number is captured.
// distributor_id, when present, marks this as a distributor sale instead
// of a regular client sale — PC Offers never set this, since distributors
// don't buy built PCs.
router.post('/serials', requirePermission('serials.manage'), async (req, res) => {
  try {
    const { product_id, sku, serial_number, warranty_months, sale_price, order_id, distributor_id, notes } = req.body;

    const resolvedSku = sku?.trim();
    if (!resolvedSku) {
      return res.status(400).json({ success: false, message: 'SKU is required (pick a product or type one in).' });
    }
    if (!serial_number?.trim()) {
      return res.status(400).json({ success: false, message: 'Serial number is required.' });
    }
    const price = Number(sale_price);
    if (!Number.isFinite(price) || price < 0) {
      return res.status(400).json({ success: false, message: 'Sale price must be a non-negative number.' });
    }
    let warranty = null;
    if (warranty_months !== undefined && warranty_months !== null && warranty_months !== '') {
      warranty = Number(warranty_months);
      if (!Number.isInteger(warranty) || warranty < 0) {
        return res.status(400).json({ success: false, message: 'Warranty must be a whole number of months.' });
      }
    }

    const result = await pool.query(
      `INSERT INTO product_serials (product_id, sku, serial_number, warranty_months, sale_price, order_id, distributor_id, notes, sold_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, NOW())
       RETURNING *`,
      [
        product_id || null,
        resolvedSku,
        normalizeSerial(serial_number),
        warranty,
        price,
        order_id || null,
        distributor_id || null,
        notes?.trim() || null,
      ]
    );

    res.status(201).json({ success: true, data: result.rows[0] });
  } catch (err) {
    if (isUniqueViolation(err)) {
      return res.status(409).json({
        success: false,
        message: `Serial number "${normalizeSerial(req.body.serial_number)}" is already on record.`,
      });
    }
    res.status(500).json({ success: false, error: err.message });
  }
});

router.delete('/serials/:serialNumber', requirePermission('serials.manage'), async (req, res) => {
  try {
    const serial = normalizeSerial(req.params.serialNumber);
    const result = await pool.query('DELETE FROM product_serials WHERE serial_number = $1 RETURNING serial_number', [serial]);

    if (result.rows.length === 0) {
      return res.status(404).json({ success: false, message: 'No sale found with that serial number.' });
    }

    res.json({ success: true, message: `Serial "${serial}" deleted.` });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// Computed, not stored: remaining = total received (stock_receipts) minus
// total sold (product_serials rows for that SKU, including PC Offer items
// since those are rows in the same table). This stays a derived view on
// purpose — the two logs are still independent, nothing here is a live
// counter that could drift out of sync with them.
router.get('/inventory-summary', requirePermission('serials.view'), async (req, res) => {
  try {
    const { page, limit, offset } = getPagination(req);

    const sql = `
      SELECT
        COALESCE(r.sku, s.sku) AS sku,
        p.name AS product_name,
        COALESCE(r.total_received, 0)::int AS total_received,
        COALESCE(s.total_sold, 0)::int AS total_sold,
        (COALESCE(r.total_received, 0) - COALESCE(s.total_sold, 0))::int AS remaining
      FROM (
        SELECT sku, SUM(quantity) AS total_received FROM stock_receipts GROUP BY sku
      ) r
      FULL OUTER JOIN (
        SELECT sku, COUNT(*) AS total_sold FROM product_serials GROUP BY sku
      ) s ON r.sku = s.sku
      LEFT JOIN products p ON p.sku = COALESCE(r.sku, s.sku)
      ORDER BY COALESCE(r.sku, s.sku) ASC
      LIMIT $1 OFFSET $2
    `;
    const countSql = `
      SELECT COUNT(*)::int AS count FROM (
        SELECT sku FROM stock_receipts
        UNION
        SELECT sku FROM product_serials
      ) all_skus
    `;

    const [rows, count] = await Promise.all([
      pool.query(sql, [limit, offset]),
      pool.query(countSql),
    ]);

    res.json({ success: true, data: rows.rows, pagination: paginationMeta(page, limit, count.rows[0].count) });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// ==========================================
// PC OFFERS — bundle several items (a build + peripherals) into one sale
// at one combined price, instead of pricing each component separately.
// ==========================================
router.get('/pc-offers', requirePermission('serials.view'), async (req, res) => {
  try {
    const { page, limit, offset } = getPagination(req);

    const sql = `
      SELECT o.*, COUNT(ps.id)::int AS item_count
      FROM pc_offers o
      LEFT JOIN product_serials ps ON ps.offer_id = o.id
      GROUP BY o.id
      ORDER BY o.sold_at DESC
      LIMIT $1 OFFSET $2
    `;
    const [rows, count] = await Promise.all([
      pool.query(sql, [limit, offset]),
      pool.query('SELECT COUNT(*)::int AS count FROM pc_offers'),
    ]);

    res.json({ success: true, data: rows.rows, pagination: paginationMeta(page, limit, count.rows[0].count) });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

router.get('/pc-offers/:id', requirePermission('serials.view'), async (req, res) => {
  try {
    const { id } = req.params;

    const offerResult = await pool.query('SELECT * FROM pc_offers WHERE id = $1', [id]);
    if (offerResult.rows.length === 0) {
      return res.status(404).json({ success: false, message: 'PC Offer not found.' });
    }

    const itemsResult = await pool.query(
      `SELECT ps.*, p.name AS product_name
       FROM product_serials ps LEFT JOIN products p ON p.id = ps.product_id
       WHERE ps.offer_id = $1 ORDER BY ps.id ASC`,
      [id]
    );

    res.json({ success: true, data: { ...offerResult.rows[0], items: itemsResult.rows } });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

router.post('/pc-offers', requirePermission('serials.manage'), async (req, res) => {
  const { items, sale_price, warranty_months, order_id, notes } = req.body;

  if (!Array.isArray(items) || items.length === 0) {
    return res.status(400).json({ success: false, message: 'Add at least one item to the offer.' });
  }
  for (const item of items) {
    if (!item.sku?.trim()) {
      return res.status(400).json({ success: false, message: 'Every item needs a SKU (pick a product or type one in).' });
    }
  }
  const price = Number(sale_price);
  if (!Number.isFinite(price) || price < 0) {
    return res.status(400).json({ success: false, message: 'Sale price must be a non-negative number.' });
  }
  let warranty = null;
  if (warranty_months !== undefined && warranty_months !== null && warranty_months !== '') {
    warranty = Number(warranty_months);
    if (!Number.isInteger(warranty) || warranty < 0) {
      return res.status(400).json({ success: false, message: 'Warranty must be a whole number of months.' });
    }
  }

  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    const offerResult = await client.query(
      `INSERT INTO pc_offers (sale_price, warranty_months, order_id, notes, sold_at)
       VALUES ($1, $2, $3, $4, NOW())
       RETURNING *`,
      [price, warranty, order_id || null, notes?.trim() || null]
    );
    const offer = offerResult.rows[0];

    const insertedItems = [];
    for (const item of items) {
      const serial = item.serial_number?.trim() ? normalizeSerial(item.serial_number) : null;
      const itemResult = await client.query(
        `INSERT INTO product_serials (offer_id, product_id, sku, serial_number, warranty_months, order_id, sold_at)
         VALUES ($1, $2, $3, $4, $5, $6, NOW())
         RETURNING *`,
        [offer.id, item.product_id || null, item.sku.trim(), serial, warranty, order_id || null]
      );
      insertedItems.push(itemResult.rows[0]);
    }

    await client.query('COMMIT');
    res.status(201).json({ success: true, data: { ...offer, items: insertedItems } });
  } catch (err) {
    await client.query('ROLLBACK');
    if (isUniqueViolation(err)) {
      return res.status(409).json({
        success: false,
        message: 'One of those serial numbers is already on record — check each item and try again.',
      });
    }
    res.status(500).json({ success: false, error: err.message });
  } finally {
    client.release();
  }
});

router.delete('/pc-offers/:id', requirePermission('serials.manage'), async (req, res) => {
  try {
    // product_serials rows for this offer cascade-delete automatically
    // (offer_id REFERENCES pc_offers(id) ON DELETE CASCADE).
    const result = await pool.query('DELETE FROM pc_offers WHERE id = $1 RETURNING id', [req.params.id]);
    if (result.rows.length === 0) {
      return res.status(404).json({ success: false, message: 'PC Offer not found.' });
    }
    res.json({ success: true, message: 'PC Offer deleted.' });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// ==========================================
// SITE SETTINGS
// ==========================================
router.get('/settings', requirePermission('settings.view'), async (req, res) => {
  try {
    const result = await pool.query('SELECT key, value, updated_at FROM site_settings ORDER BY key ASC');
    res.json({ success: true, data: result.rows });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

router.put('/settings/:key', requirePermission('settings.edit'), async (req, res) => {
  try {
    const { key } = req.params;
    const { value } = req.body;

    const result = await pool.query(
      `INSERT INTO site_settings (key, value, updated_at)
       VALUES ($1, $2, NOW())
       ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, updated_at = NOW()
       RETURNING *`,
      [key, value ?? '']
    );

    res.json({ success: true, data: result.rows[0] });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

router.delete('/settings/:key', requirePermission('settings.edit'), async (req, res) => {
  try {
    const { key } = req.params;
    const result = await pool.query('DELETE FROM site_settings WHERE key = $1 RETURNING key', [key]);

    if (result.rows.length === 0) {
      return res.status(404).json({ success: false, message: 'Setting not found.' });
    }

    res.json({ success: true, message: `Setting "${key}" deleted.` });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

export default router;
