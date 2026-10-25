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

// Serial numbers are normalized to uppercase, trimmed, on every write and
// every lookup — for both stock-in serials and sold-unit serials — so
// "abc123" and "ABC123" are always treated as the same physical unit
// regardless of how staff type it in.
const normalizeSerial = (s) => String(s || '').trim().toUpperCase();

// Field parsers shared by the sale routes. Each returns { value } on
// success or { error } with a message ready to show in the admin panel.
const blank = (v) => v === undefined || v === null || v === '';

function parsePrice(v, label = 'Sale price') {
  const n = Number(v);
  if (blank(v) || !Number.isFinite(n) || n < 0) return { error: `${label} must be a non-negative number.` };
  return { value: Math.round(n * 100) / 100 };
}
function parseWarranty(v) {
  if (blank(v)) return { value: null };
  const n = Number(v);
  if (!Number.isInteger(n) || n < 0) return { error: 'Warranty must be a whole number of months.' };
  return { value: n };
}
function parseOptionalId(v, label) {
  if (blank(v)) return { value: null };
  const n = Number(v);
  if (!Number.isInteger(n) || n < 1) return { error: `${label} must be a whole number.` };
  return { value: n };
}
function parseSoldAt(v) {
  const d = new Date(v);
  if (blank(v) || Number.isNaN(d.getTime())) return { error: 'Sale date is not a valid date.' };
  if (d.getTime() > Date.now() + 24 * 60 * 60 * 1000) return { error: "Sale date can't be in the future." };
  return { value: d.toISOString() };
}
// First serial named in a unique-violation detail, e.g. Key (serial_number)=(ABC).
function duplicateSerialFrom(err) {
  const match = (err.detail || '').match(/=\(([^)]+)\)/);
  return match ? match[1] : null;
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
    if (result.rows.length === 0) {
      return res.status(404).json({ success: false, message: 'Category not found.' });
    }
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
    if (result.rows.length === 0) {
      return res.status(404).json({ success: false, message: 'Subcategory not found.' });
    }
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
    if (result.rows.length === 0) {
      return res.status(404).json({ success: false, message: 'Brand not found.' });
    }
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
    if (err.code === '23503') {
      return res.status(409).json({
        success: false,
        message: "This distributor has sales on record, so it can't be deleted (their warranty records need it).",
      });
    }
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
    if (result.rows.length === 0) {
      return res.status(404).json({ success: false, message: 'Product not found.' });
    }
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
    if (result.rows.length === 0) {
      return res.status(404).json({ success: false, message: 'Banner not found.' });
    }
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
    const { sku, search, source, q } = req.query;

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
    // One search box in the admin UI: matches source, SKU, or any serial
    // number logged on the receipt (serials are stored uppercase).
    if (q?.trim()) {
      params.push(`%${q.trim()}%`);
      const textIdx = params.length;
      params.push(`%${normalizeSerial(q)}%`);
      const serialIdx = params.length;
      conditions.push(`(
        sr.source ILIKE $${textIdx}
        OR sr.sku ILIKE $${textIdx}
        OR EXISTS (
          SELECT 1 FROM stock_receipt_serials rs
          WHERE rs.receipt_id = sr.id AND rs.serial_number LIKE $${serialIdx}
        )
      )`);
    }

    const whereClause = conditions.length ? `WHERE ${conditions.join(' AND ')}` : '';

    const sql = `
      SELECT sr.*, p.name AS product_name,
             COALESCE(
               (SELECT json_agg(rs.serial_number ORDER BY rs.id)
                FROM stock_receipt_serials rs WHERE rs.receipt_id = sr.id),
               '[]'::json
             ) AS serial_numbers
      FROM stock_receipts sr
      LEFT JOIN products p ON p.id = sr.product_id
      ${whereClause}
      ORDER BY sr.received_at DESC, sr.id DESC
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

// Log stock received. Two ways, same endpoint:
//   - by quantity:        { sku, quantity, cost_price, ... }
//   - by serial numbers:  { sku, serial_numbers: ['SN1', 'SN2', ...], cost_price, ... }
// With serial_numbers, quantity is ignored and set to how many serials were
// given, and each serial is stored against this receipt so a later warranty
// lookup can trace that exact unit back to its source.
router.post('/stock-receipts', requirePermission('serials.manage'), async (req, res) => {
  const { product_id, sku, quantity, cost_price, source, notes, serial_numbers } = req.body;

  const resolvedSku = sku?.trim();
  if (!resolvedSku) {
    return res.status(400).json({ success: false, message: 'SKU is required (pick a product or type one in).' });
  }

  let serials = [];
  if (serial_numbers !== undefined && serial_numbers !== null) {
    if (!Array.isArray(serial_numbers)) {
      return res.status(400).json({ success: false, message: 'serial_numbers must be a list.' });
    }
    serials = serial_numbers.map(normalizeSerial).filter(Boolean);
    const seen = new Set();
    for (const sn of serials) {
      if (seen.has(sn)) {
        return res.status(400).json({ success: false, message: `Serial number "${sn}" is listed twice.` });
      }
      seen.add(sn);
    }
  }

  const qty = serials.length > 0 ? serials.length : Number(quantity);
  if (!Number.isInteger(qty) || qty <= 0) {
    return res.status(400).json({ success: false, message: 'Quantity must be a whole number above zero.' });
  }
  const cost = Number(cost_price);
  if (cost_price === '' || cost_price === null || cost_price === undefined || !Number.isFinite(cost) || cost < 0) {
    return res.status(400).json({ success: false, message: 'Cost price must be a non-negative number.' });
  }

  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    const result = await client.query(
      `INSERT INTO stock_receipts (product_id, sku, quantity, cost_price, source, notes, received_at)
       VALUES ($1, $2, $3, $4, $5, $6, NOW())
       RETURNING *`,
      [product_id || null, resolvedSku, qty, cost, source?.trim() || null, notes?.trim() || null]
    );
    const receipt = result.rows[0];

    if (serials.length > 0) {
      await client.query(
        `INSERT INTO stock_receipt_serials (receipt_id, serial_number)
         SELECT $1, UNNEST($2::varchar[])`,
        [receipt.id, serials]
      );
    }

    await client.query('COMMIT');
    res.status(201).json({ success: true, data: { ...receipt, serial_numbers: serials } });
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    if (isUniqueViolation(err)) {
      const match = (err.detail || '').match(/=\(([^)]+)\)/);
      return res.status(409).json({
        success: false,
        message: match
          ? `Serial number "${match[1]}" was already logged as received in an earlier stock-in.`
          : 'One of those serial numbers was already logged as received.',
      });
    }
    res.status(500).json({ success: false, error: err.message });
  } finally {
    client.release();
  }
});

// Look up one stock-in serial: which receipt it arrived on (SKU, product,
// source, cost, date) and whether that unit has been sold since. Used by
// the "Record a Sale" form to pre-fill the product as soon as staff type a
// serial that was logged on the way in.
router.get('/stock-in-serials/:serialNumber', requirePermission('serials.view'), async (req, res) => {
  try {
    const serial = normalizeSerial(req.params.serialNumber);
    const result = await pool.query(
      `SELECT rs.serial_number, sr.id AS receipt_id, sr.sku, sr.product_id, p.name AS product_name,
              sr.source, sr.cost_price, sr.received_at,
              EXISTS (SELECT 1 FROM product_serials ps WHERE ps.serial_number = rs.serial_number) AS sold
       FROM stock_receipt_serials rs
       JOIN stock_receipts sr ON sr.id = rs.receipt_id
       LEFT JOIN products p ON p.id = sr.product_id
       WHERE rs.serial_number = $1`,
      [serial]
    );

    if (result.rows.length === 0) {
      return res.status(404).json({ success: false, message: 'That serial number was not logged on any stock-in.' });
    }
    res.json({ success: true, data: result.rows[0] });
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
// If a sold unit's serial was also logged when it came IN (stock-in by
// serial number), surface where it came from — this is what a warranty
// claim gets traced back to (which supplier, at what cost, when).
const STOCK_IN_COLUMNS = `
  sr_in.id AS stock_in_receipt_id,
  sr_in.source AS stock_in_source,
  sr_in.cost_price AS stock_in_cost_price,
  sr_in.received_at AS stock_in_received_at`;
const STOCK_IN_JOINS = `
  LEFT JOIN stock_receipt_serials rs_in ON rs_in.serial_number = ps.serial_number
  LEFT JOIN stock_receipts sr_in ON sr_in.id = rs_in.receipt_id`;

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
    // Matches the serial number, SKU, product name or notes.
    if (search?.trim()) {
      params.push(`%${search.trim()}%`);
      const i = params.length;
      conditions.push(`(ps.serial_number ILIKE $${i} OR ps.sku ILIKE $${i} OR p.name ILIKE $${i} OR ps.notes ILIKE $${i})`);
    }
    if (type === 'distributor') {
      conditions.push(`(ps.distributor_id IS NOT NULL OR ps.distributor_sale_id IS NOT NULL)`);
    } else if (type === 'client') {
      conditions.push(`ps.distributor_id IS NULL AND ps.distributor_sale_id IS NULL`);
    }

    const whereClause = conditions.length ? `WHERE ${conditions.join(' AND ')}` : '';

    const sql = `
      SELECT ps.*, p.name AS product_name, d.name AS distributor_name,
             o.sale_price AS offer_sale_price,
             o.warranty_months AS offer_warranty_months,
             CASE WHEN COALESCE(ps.warranty_months, o.warranty_months) IS NOT NULL
                  THEN ps.sold_at + (COALESCE(ps.warranty_months, o.warranty_months) || ' months')::interval
                  ELSE NULL END AS warranty_expires_at,
             ${STOCK_IN_COLUMNS}
      FROM product_serials ps
      LEFT JOIN products p ON p.id = ps.product_id
      LEFT JOIN pc_offers o ON o.id = ps.offer_id
      LEFT JOIN distributors d ON d.id = ps.distributor_id
      ${STOCK_IN_JOINS}
      ${whereClause}
      ORDER BY ps.sold_at DESC, ps.id DESC
      LIMIT $${params.length + 1} OFFSET $${params.length + 2}
    `;
    const countSql = `SELECT COUNT(*)::int AS count FROM product_serials ps
      LEFT JOIN products p ON p.id = ps.product_id ${whereClause}`;

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
              ds.notes AS distributor_sale_notes,
              cs.notes AS client_sale_notes, cs.customer_name, cs.customer_phone,
              CASE WHEN COALESCE(ps.warranty_months, o.warranty_months) IS NOT NULL
                   THEN ps.sold_at + (COALESCE(ps.warranty_months, o.warranty_months) || ' months')::interval
                   ELSE NULL END AS warranty_expires_at,
              ${STOCK_IN_COLUMNS}
       FROM product_serials ps
       LEFT JOIN products p ON p.id = ps.product_id
       LEFT JOIN pc_offers o ON o.id = ps.offer_id
       LEFT JOIN distributors d ON d.id = ps.distributor_id
       LEFT JOIN distributor_sales ds ON ds.id = ps.distributor_sale_id
       LEFT JOIN client_sales cs ON cs.id = ps.client_sale_id
       ${STOCK_IN_JOINS}
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

// Sales are recorded through /client-sales and /distributor-sales (one sale,
// any number of items and serials). This older single-unit route is kept
// only to tell any remaining caller where to go.
router.post('/serials', requirePermission('serials.manage'), (req, res) => {
  res.status(400).json({
    success: false,
    message: 'Record sales through Client Sales (POST /api/admin/client-sales) or Distributor Sales (POST /api/admin/distributor-sales).',
  });
});

// ==========================================
// MULTI-ITEM SALES — distributor sales and client sales
// ==========================================
// Both work the same way: a header row (who, when, order link, notes) in
// distributor_sales / client_sales, and one product_serials row per unit
// sold, each with its own serial number, price and warranty. The only
// difference is who the sale is to: a registered distributor (required),
// or a walk-in / online client (optional name + phone).
//
// Units copy some header columns (date, order, distributor) so every
// existing warranty lookup and inventory count keeps working without
// knowing about headers; those copies are made in SQL and re-synced
// whenever the header changes.

const SALE_KINDS = {
  distributor: {
    path: '/distributor-sales',
    table: 'distributor_sales',
    unitFk: 'distributor_sale_id',
    label: 'Distributor sale',
    unitSync: ['distributor_id', 'order_id', 'sold_at'],
    headSelect: 'h.*, d.name AS distributor_name',
    headJoin: 'JOIN distributors d ON d.id = h.distributor_id',
    groupBy: 'h.id, d.name',
    searchCols: ['d.name', 'h.notes'],
    fkMessage: 'That distributor, order or product no longer exists.',
    // Header fields specific to this kind -> [[column, value], ...]
    parseParty(body, creating) {
      if (!creating && !('distributor_id' in body)) return { fields: [] };
      const r = parseOptionalId(body.distributor_id, 'Distributor');
      if (r.error || r.value === null) return { error: 'Pick which distributor this sale is to.' };
      return { fields: [['distributor_id', r.value]] };
    },
  },
  client: {
    path: '/client-sales',
    table: 'client_sales',
    unitFk: 'client_sale_id',
    label: 'Client sale',
    unitSync: ['order_id', 'sold_at'],
    headSelect: 'h.*',
    headJoin: '',
    groupBy: 'h.id',
    searchCols: ['h.customer_name', 'h.customer_phone', 'h.notes'],
    fkMessage: 'That order or product no longer exists.',
    parseParty(body) {
      const fields = [];
      for (const [col, max, label] of [
        ['customer_name', 255, 'Customer name'],
        ['customer_phone', 50, 'Customer phone'],
      ]) {
        if (!(col in body)) continue;
        const v = body[col] == null ? '' : String(body[col]).trim();
        if (v.length > max) return { error: `${label} is too long (max ${max} characters).` };
        fields.push([col, v || null]);
      }
      return { fields };
    },
  },
};

const UNIT_SELECT = `
  SELECT ps.*, p.name AS product_name,
         CASE WHEN ps.warranty_months IS NOT NULL
              THEN ps.sold_at + (ps.warranty_months || ' months')::interval END AS warranty_expires_at,
         ${STOCK_IN_COLUMNS}
  FROM product_serials ps
  LEFT JOIN products p ON p.id = ps.product_id
  ${STOCK_IN_JOINS}`;

// Validates one item line: { product_id?, sku, sale_price, warranty_months?,
// serial_numbers: [...] }. Returns { line } or { error }.
function parseSaleLine(raw, label = 'Item') {
  if (!raw || typeof raw !== 'object') return { error: `${label} is missing.` };
  const sku = raw.sku?.trim();
  if (!sku) return { error: `${label} needs a SKU (pick a product or type one in).` };
  const productId = parseOptionalId(raw.product_id, 'Product');
  if (productId.error) return { error: `${label}: ${productId.error}` };
  const price = parsePrice(raw.sale_price, 'Unit price');
  if (price.error) return { error: `${label} (${sku}): ${price.error}` };
  const warranty = parseWarranty(raw.warranty_months);
  if (warranty.error) return { error: `${label} (${sku}): ${warranty.error}` };
  if (!Array.isArray(raw.serial_numbers)) return { error: `${label} (${sku}) needs at least one serial number.` };
  const serials = raw.serial_numbers.map(normalizeSerial).filter(Boolean);
  if (serials.length === 0) return { error: `${label} (${sku}) needs at least one serial number.` };
  return { line: { sku, product_id: productId.value, sale_price: price.value, warranty_months: warranty.value, serials } };
}

// Serials must be unique across the whole request, not just within a line.
function findRepeatedSerial(lines) {
  const seen = new Set();
  for (const line of lines) {
    for (const sn of line.serials) {
      if (seen.has(sn)) return sn;
      seen.add(sn);
    }
  }
  return null;
}

// Header fields shared by both kinds: order link, notes, sale date.
function parseCommonHeader(body, fields) {
  if ('order_id' in body) {
    const r = parseOptionalId(body.order_id, 'Order ID');
    if (r.error) return r.error;
    fields.push(['order_id', r.value]);
  }
  if ('notes' in body) fields.push(['notes', body.notes?.trim() || null]);
  if ('sold_at' in body && !blank(body.sold_at)) {
    const r = parseSoldAt(body.sold_at);
    if (r.error) return r.error;
    fields.push(['sold_at', r.value]);
  }
  return null;
}

function mountSaleRoutes(kind) {
  const K = SALE_KINDS[kind];
  const notFound = (res) => res.status(404).json({ success: false, message: `${K.label} not found.` });

  async function loadSale(db, saleId) {
    const head = await db.query(`SELECT ${K.headSelect} FROM ${K.table} h ${K.headJoin} WHERE h.id = $1`, [saleId]);
    if (head.rows.length === 0) return null;
    const units = await db.query(`${UNIT_SELECT} WHERE ps.${K.unitFk} = $1 ORDER BY ps.sku ASC, ps.id ASC`, [saleId]);
    const total = units.rows.reduce((sum, u) => sum + Number(u.sale_price || 0), 0);
    return { ...head.rows[0], unit_count: units.rows.length, total: total.toFixed(2), units: units.rows };
  }

  // Header columns are copied from the sale inside SQL so they match it
  // exactly (a round trip through JS would drop timestamp microseconds).
  async function insertUnits(db, saleId, line) {
    const sync = K.unitSync.map((c) => `h.${c}`).join(', ');
    await db.query(
      `INSERT INTO product_serials
         (${K.unitFk}, ${K.unitSync.join(', ')}, product_id, sku, sale_price, warranty_months, serial_number)
       SELECT h.id, ${sync}, $2, $3, $4, $5, sn
       FROM ${K.table} h, UNNEST($6::varchar[]) AS sn
       WHERE h.id = $1`,
      [saleId, line.product_id, line.sku, line.sale_price, line.warranty_months, line.serials]
    );
  }

  async function syncUnits(db, saleId) {
    const sets = K.unitSync.map((c) => `${c} = h.${c}`).join(', ');
    await db.query(
      `UPDATE product_serials ps SET ${sets} FROM ${K.table} h WHERE h.id = $1 AND ps.${K.unitFk} = h.id`,
      [saleId]
    );
  }

  function saleError(res, err, fallbackSerial) {
    if (isUniqueViolation(err)) {
      const sn = duplicateSerialFrom(err) || fallbackSerial;
      return res.status(409).json({
        success: false,
        message: sn ? `Serial number "${sn}" is already on record.` : 'One of those serial numbers is already on record.',
      });
    }
    if (err.code === '23503') return res.status(400).json({ success: false, message: K.fkMessage });
    return res.status(500).json({ success: false, error: err.message });
  }

  function saleId(req, res) {
    const id = Number(req.params.id);
    if (!Number.isInteger(id) || id < 1) {
      notFound(res);
      return null;
    }
    return id;
  }

  // ---- list
  router.get(K.path, requirePermission('serials.view'), async (req, res) => {
    try {
      const { page, limit, offset } = getPagination(req);
      const { q, distributor_id } = req.query;
      const conditions = [];
      const params = [];

      if (kind === 'distributor' && !blank(distributor_id)) {
        params.push(Number(distributor_id));
        conditions.push(`h.distributor_id = $${params.length}`);
      }
      // One search box: sale number, who it was to, notes, or any SKU /
      // serial number in the sale.
      if (q?.trim()) {
        params.push(`%${q.trim()}%`);
        const i = params.length;
        const idMatch = /^#?\d+$/.test(q.trim()) ? ` OR h.id = ${Number(q.trim().replace('#', ''))}` : '';
        conditions.push(`(
          ${K.searchCols.map((c) => `${c} ILIKE $${i}`).join(' OR ')}${idMatch}
          OR EXISTS (
            SELECT 1 FROM product_serials x
            WHERE x.${K.unitFk} = h.id AND (x.serial_number ILIKE $${i} OR x.sku ILIKE $${i})
          )
        )`);
      }
      const whereClause = conditions.length ? `WHERE ${conditions.join(' AND ')}` : '';

      const sql = `
        SELECT ${K.headSelect},
               COUNT(ps.id)::int AS unit_count,
               COUNT(DISTINCT ps.sku)::int AS sku_count,
               COALESCE(SUM(ps.sale_price), 0)::numeric(12,2) AS total
        FROM ${K.table} h
        ${K.headJoin}
        LEFT JOIN product_serials ps ON ps.${K.unitFk} = h.id
        ${whereClause}
        GROUP BY ${K.groupBy}
        ORDER BY h.sold_at DESC, h.id DESC
        LIMIT $${params.length + 1} OFFSET $${params.length + 2}
      `;
      const countSql = `SELECT COUNT(*)::int AS count FROM ${K.table} h ${K.headJoin} ${whereClause}`;

      const [rows, count] = await Promise.all([pool.query(sql, [...params, limit, offset]), pool.query(countSql, params)]);
      res.json({ success: true, data: rows.rows, pagination: paginationMeta(page, limit, count.rows[0].count) });
    } catch (err) {
      res.status(500).json({ success: false, error: err.message });
    }
  });

  // ---- one sale
  router.get(`${K.path}/:id`, requirePermission('serials.view'), async (req, res) => {
    const id = saleId(req, res);
    if (!id) return;
    try {
      const sale = await loadSale(pool, id);
      if (!sale) return notFound(res);
      res.json({ success: true, data: sale });
    } catch (err) {
      res.status(500).json({ success: false, error: err.message });
    }
  });

  // ---- create: header fields + lines: [{ product_id?, sku, sale_price, warranty_months?, serial_numbers }]
  router.post(K.path, requirePermission('serials.manage'), async (req, res) => {
    const body = req.body || {};
    const party = K.parseParty(body, true);
    if (party.error) return res.status(400).json({ success: false, message: party.error });
    const fields = [...party.fields];
    const headerError = parseCommonHeader(body, fields);
    if (headerError) return res.status(400).json({ success: false, message: headerError });

    if (!Array.isArray(body.lines) || body.lines.length === 0) {
      return res.status(400).json({ success: false, message: 'Add at least one item with its serial numbers.' });
    }
    const lines = [];
    for (const [i, raw] of body.lines.entries()) {
      const r = parseSaleLine(raw, `Item ${i + 1}`);
      if (r.error) return res.status(400).json({ success: false, message: r.error });
      lines.push(r.line);
    }
    const repeated = findRepeatedSerial(lines);
    if (repeated) {
      return res.status(400).json({ success: false, message: `Serial number "${repeated}" is listed more than once in this sale.` });
    }

    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      const cols = fields.map(([c]) => c);
      const vals = fields.map(([, v]) => v);
      const head = await client.query(
        cols.length
          ? `INSERT INTO ${K.table} (${cols.join(', ')}) VALUES (${cols.map((_, i) => `$${i + 1}`).join(', ')}) RETURNING id`
          : `INSERT INTO ${K.table} DEFAULT VALUES RETURNING id`,
        vals
      );
      const id = head.rows[0].id;
      for (const line of lines) await insertUnits(client, id, line);
      const sale = await loadSale(client, id);
      await client.query('COMMIT');
      res.status(201).json({ success: true, data: sale });
    } catch (err) {
      await client.query('ROLLBACK').catch(() => {});
      saleError(res, err);
    } finally {
      client.release();
    }
  });

  // ---- edit the header; units are re-synced in the same transaction
  router.patch(`${K.path}/:id`, requirePermission('serials.manage'), async (req, res) => {
    const id = saleId(req, res);
    if (!id) return;
    const body = req.body || {};
    const party = K.parseParty(body, false);
    if (party.error) return res.status(400).json({ success: false, message: party.error });
    const fields = [...party.fields];
    if ('sold_at' in body && blank(body.sold_at)) {
      return res.status(400).json({ success: false, message: 'Sale date is not a valid date.' });
    }
    const headerError = parseCommonHeader(body, fields);
    if (headerError) return res.status(400).json({ success: false, message: headerError });
    if (fields.length === 0) return res.status(400).json({ success: false, message: 'Nothing to update.' });

    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      const sets = fields.map(([c], i) => `${c} = $${i + 1}`).join(', ');
      const head = await client.query(`UPDATE ${K.table} SET ${sets} WHERE id = $${fields.length + 1} RETURNING id`, [
        ...fields.map(([, v]) => v),
        id,
      ]);
      if (head.rows.length === 0) {
        await client.query('ROLLBACK');
        return notFound(res);
      }
      await syncUnits(client, id);
      const sale = await loadSale(client, id);
      await client.query('COMMIT');
      res.json({ success: true, data: sale });
    } catch (err) {
      await client.query('ROLLBACK').catch(() => {});
      saleError(res, err);
    } finally {
      client.release();
    }
  });

  // ---- delete (units cascade with the header)
  router.delete(`${K.path}/:id`, requirePermission('serials.manage'), async (req, res) => {
    const id = saleId(req, res);
    if (!id) return;
    try {
      const result = await pool.query(`DELETE FROM ${K.table} WHERE id = $1 RETURNING id`, [id]);
      if (result.rows.length === 0) return notFound(res);
      res.json({ success: true, message: `${K.label} deleted.` });
    } catch (err) {
      res.status(500).json({ success: false, error: err.message });
    }
  });

  // ---- add units: more serials for an item already in the sale, or a new item
  router.post(`${K.path}/:id/units`, requirePermission('serials.manage'), async (req, res) => {
    const id = saleId(req, res);
    if (!id) return;
    const r = parseSaleLine(req.body, 'Item');
    if (r.error) return res.status(400).json({ success: false, message: r.error });
    const repeated = findRepeatedSerial([r.line]);
    if (repeated) return res.status(400).json({ success: false, message: `Serial number "${repeated}" is listed more than once.` });

    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      const head = await client.query(`SELECT id FROM ${K.table} WHERE id = $1 FOR UPDATE`, [id]);
      if (head.rows.length === 0) {
        await client.query('ROLLBACK');
        return notFound(res);
      }
      await insertUnits(client, id, r.line);
      const sale = await loadSale(client, id);
      await client.query('COMMIT');
      res.status(201).json({ success: true, data: sale });
    } catch (err) {
      await client.query('ROLLBACK').catch(() => {});
      saleError(res, err);
    } finally {
      client.release();
    }
  });

  // ---- change price / warranty / product (several units = a whole item
  // line), or one unit's serial number
  async function updateUnits(req, res, unitIds, allowSerial) {
    const id = saleId(req, res);
    if (!id) return;
    const body = req.body || {};
    const sets = [];
    const params = [];
    const set = (col, value) => {
      params.push(value);
      sets.push(`${col} = $${params.length}`);
    };

    if (!Array.isArray(unitIds) || unitIds.length === 0 || !unitIds.every((u) => Number.isInteger(u) && u > 0)) {
      return res.status(400).json({ success: false, message: 'Pick which units to change.' });
    }
    if ('sku' in body) {
      if (!body.sku?.trim()) return res.status(400).json({ success: false, message: 'SKU is required (pick a product or type one in).' });
      set('sku', body.sku.trim());
    }
    if ('product_id' in body) {
      const r = parseOptionalId(body.product_id, 'Product');
      if (r.error) return res.status(400).json({ success: false, message: r.error });
      set('product_id', r.value);
    }
    if ('sale_price' in body) {
      const r = parsePrice(body.sale_price, 'Unit price');
      if (r.error) return res.status(400).json({ success: false, message: r.error });
      set('sale_price', r.value);
    }
    if ('warranty_months' in body) {
      const r = parseWarranty(body.warranty_months);
      if (r.error) return res.status(400).json({ success: false, message: r.error });
      set('warranty_months', r.value);
    }
    if ('serial_number' in body) {
      if (!allowSerial) return res.status(400).json({ success: false, message: 'Serial numbers are edited one unit at a time.' });
      if (!body.serial_number?.trim()) return res.status(400).json({ success: false, message: 'Serial number is required.' });
      set('serial_number', normalizeSerial(body.serial_number));
    }
    if (sets.length === 0) return res.status(400).json({ success: false, message: 'Nothing to update.' });

    try {
      params.push(unitIds, id);
      // Only units that belong to this sale are ever touched.
      const result = await pool.query(
        `UPDATE product_serials SET ${sets.join(', ')}
         WHERE id = ANY($${params.length - 1}::int[]) AND ${K.unitFk} = $${params.length}
         RETURNING id`,
        params
      );
      if (result.rows.length === 0) {
        return res.status(404).json({ success: false, message: `Those units are not in this ${K.label.toLowerCase()}.` });
      }
      const sale = await loadSale(pool, id);
      if (!sale) return notFound(res);
      res.json({ success: true, data: sale });
    } catch (err) {
      saleError(res, err, body.serial_number && normalizeSerial(body.serial_number));
    }
  }

  router.patch(`${K.path}/:id/units`, requirePermission('serials.manage'), (req, res) =>
    updateUnits(req, res, (req.body?.unit_ids || []).map(Number), false)
  );
  router.patch(`${K.path}/:id/units/:unitId`, requirePermission('serials.manage'), (req, res) =>
    updateUnits(req, res, [Number(req.params.unitId)], true)
  );

  // ---- remove one unit or several (a whole item); can't empty the sale
  async function removeUnits(req, res, unitIds) {
    const id = saleId(req, res);
    if (!id) return;
    if (!Array.isArray(unitIds) || unitIds.length === 0 || !unitIds.every((u) => Number.isInteger(u) && u > 0)) {
      return res.status(400).json({ success: false, message: 'Pick which units to remove.' });
    }
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      const head = await client.query(`SELECT id FROM ${K.table} WHERE id = $1 FOR UPDATE`, [id]);
      if (head.rows.length === 0) {
        await client.query('ROLLBACK');
        return notFound(res);
      }
      const counts = await client.query(
        `SELECT COUNT(*)::int AS total, COUNT(*) FILTER (WHERE id = ANY($2::int[]))::int AS matched
         FROM product_serials WHERE ${K.unitFk} = $1`,
        [id, unitIds]
      );
      const { total, matched } = counts.rows[0];
      if (matched === 0) {
        await client.query('ROLLBACK');
        return res.status(404).json({ success: false, message: `Those units are not in this ${K.label.toLowerCase()}.` });
      }
      if (matched >= total) {
        await client.query('ROLLBACK');
        return res.status(400).json({ success: false, message: 'That would leave this sale with no units — delete the whole sale instead.' });
      }
      await client.query(`DELETE FROM product_serials WHERE ${K.unitFk} = $1 AND id = ANY($2::int[])`, [id, unitIds]);
      const sale = await loadSale(client, id);
      await client.query('COMMIT');
      res.json({ success: true, data: sale });
    } catch (err) {
      await client.query('ROLLBACK').catch(() => {});
      res.status(500).json({ success: false, error: err.message });
    } finally {
      client.release();
    }
  }

  router.delete(`${K.path}/:id/units`, requirePermission('serials.manage'), (req, res) =>
    removeUnits(req, res, (req.body?.unit_ids || []).map(Number))
  );
  router.delete(`${K.path}/:id/units/:unitId`, requirePermission('serials.manage'), (req, res) =>
    removeUnits(req, res, [Number(req.params.unitId)])
  );
}

mountSaleRoutes('distributor');
mountSaleRoutes('client');

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
    if (err.code === '23503') {
      return res.status(400).json({ success: false, message: 'No order exists with that Order ID.' });
    }
    res.status(500).json({ success: false, error: err.message });
  } finally {
    client.release();
  }
});

// Edit a PC Offer after it was recorded — warranty length, total price,
// linked order, notes. Only the fields present in the body are changed.
// The warranty lives on the offer header AND is copied onto every item row
// (warranty lookups read the item's own value first), so a warranty change
// is written to both inside one transaction to keep them in step.
router.patch('/pc-offers/:id', requirePermission('serials.manage'), async (req, res) => {
  const id = Number(req.params.id);
  if (!Number.isInteger(id) || id < 1) {
    return res.status(404).json({ success: false, message: 'PC Offer not found.' });
  }

  const body = req.body || {};
  const sets = [];
  const params = [];
  let warrantyChanged = false;
  let warranty = null;

  if ('warranty_months' in body) {
    const raw = body.warranty_months;
    if (raw !== null && raw !== '') {
      warranty = Number(raw);
      if (!Number.isInteger(warranty) || warranty < 0) {
        return res.status(400).json({ success: false, message: 'Warranty must be a whole number of months.' });
      }
    }
    params.push(warranty);
    sets.push(`warranty_months = $${params.length}`);
    warrantyChanged = true;
  }
  if ('sale_price' in body) {
    const price = Number(body.sale_price);
    if (body.sale_price === '' || body.sale_price === null || !Number.isFinite(price) || price < 0) {
      return res.status(400).json({ success: false, message: 'Sale price must be a non-negative number.' });
    }
    params.push(price);
    sets.push(`sale_price = $${params.length}`);
  }
  if ('order_id' in body) {
    let orderId = null;
    if (body.order_id !== null && body.order_id !== '') {
      orderId = Number(body.order_id);
      if (!Number.isInteger(orderId) || orderId < 1) {
        return res.status(400).json({ success: false, message: 'Order ID must be a whole number.' });
      }
    }
    params.push(orderId);
    sets.push(`order_id = $${params.length}`);
  }
  if ('notes' in body) {
    params.push(body.notes?.trim() || null);
    sets.push(`notes = $${params.length}`);
  }

  if (sets.length === 0) {
    return res.status(400).json({ success: false, message: 'Nothing to update.' });
  }

  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    params.push(id);
    const offerResult = await client.query(
      `UPDATE pc_offers SET ${sets.join(', ')} WHERE id = $${params.length} RETURNING *`,
      params
    );
    if (offerResult.rows.length === 0) {
      await client.query('ROLLBACK');
      return res.status(404).json({ success: false, message: 'PC Offer not found.' });
    }
    const offer = offerResult.rows[0];

    if (warrantyChanged) {
      await client.query('UPDATE product_serials SET warranty_months = $1 WHERE offer_id = $2', [warranty, id]);
    }
    if ('order_id' in body) {
      await client.query('UPDATE product_serials SET order_id = $1 WHERE offer_id = $2', [offer.order_id, id]);
    }

    const itemsResult = await client.query(
      `SELECT ps.*, p.name AS product_name
       FROM product_serials ps LEFT JOIN products p ON p.id = ps.product_id
       WHERE ps.offer_id = $1 ORDER BY ps.id ASC`,
      [id]
    );

    await client.query('COMMIT');
    res.json({ success: true, data: { ...offer, items: itemsResult.rows } });
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    if (err.code === '23503') {
      return res.status(400).json({ success: false, message: 'No order exists with that Order ID.' });
    }
    res.status(500).json({ success: false, error: err.message });
  } finally {
    client.release();
  }
});

// ------------------------------------------------------------------
// PC OFFER ITEMS — fix a wrong serial or product, add a forgotten item,
// or remove one, after the offer was recorded.
// ------------------------------------------------------------------
// Items always inherit the offer's warranty, order link and sale date, so a
// unit added later is under the same warranty clock as the rest of the
// build (counted from when the offer was sold, not from when it was added).
// Serial numbers stay optional per item and globally unique.

async function loadOfferWithItems(db, offerId) {
  const offer = await db.query('SELECT * FROM pc_offers WHERE id = $1', [offerId]);
  if (offer.rows.length === 0) return null;
  const items = await db.query(
    `SELECT ps.*, p.name AS product_name
     FROM product_serials ps LEFT JOIN products p ON p.id = ps.product_id
     WHERE ps.offer_id = $1 ORDER BY ps.id ASC`,
    [offerId]
  );
  return { ...offer.rows[0], items: items.rows };
}

function parseIds(req) {
  const offerId = Number(req.params.id);
  const itemId = req.params.itemId === undefined ? null : Number(req.params.itemId);
  const ok = Number.isInteger(offerId) && offerId > 0 && (itemId === null || (Number.isInteger(itemId) && itemId > 0));
  return ok ? { offerId, itemId } : null;
}

function offerItemError(res, err) {
  if (isUniqueViolation(err)) {
    const match = (err.detail || '').match(/=\(([^)]+)\)/);
    return res.status(409).json({
      success: false,
      message: match ? `Serial number "${match[1]}" is already on record.` : 'That serial number is already on record.',
    });
  }
  if (err.code === '23503') {
    return res.status(400).json({ success: false, message: 'That product no longer exists.' });
  }
  return res.status(500).json({ success: false, error: err.message });
}

router.post('/pc-offers/:id/items', requirePermission('serials.manage'), async (req, res) => {
  const ids = parseIds(req);
  if (!ids) return res.status(404).json({ success: false, message: 'PC Offer not found.' });

  const { product_id, sku, serial_number } = req.body || {};
  if (!sku?.trim()) {
    return res.status(400).json({ success: false, message: 'The item needs a SKU (pick a product or type one in).' });
  }

  try {
    // Copy warranty / order / sale date from the offer inside the INSERT
    // itself, so the values match the offer exactly (no round trip through
    // JS, which would drop the timestamp's microseconds).
    const inserted = await pool.query(
      `INSERT INTO product_serials (offer_id, product_id, sku, serial_number, warranty_months, order_id, sold_at)
       SELECT o.id, $2, $3, $4, o.warranty_months, o.order_id, o.sold_at
       FROM pc_offers o WHERE o.id = $1
       RETURNING offer_id`,
      [
        ids.offerId,
        product_id || null,
        sku.trim(),
        serial_number?.trim() ? normalizeSerial(serial_number) : null,
      ]
    );
    if (inserted.rows.length === 0) {
      return res.status(404).json({ success: false, message: 'PC Offer not found.' });
    }

    res.status(201).json({ success: true, data: await loadOfferWithItems(pool, ids.offerId) });
  } catch (err) {
    offerItemError(res, err);
  }
});

// Change an item's product/SKU and/or serial number. Only fields present in
// the body change; sending serial_number as "" or null clears it (allowed —
// not every peripheral has one).
router.patch('/pc-offers/:id/items/:itemId', requirePermission('serials.manage'), async (req, res) => {
  const ids = parseIds(req);
  if (!ids) return res.status(404).json({ success: false, message: 'Item not found in this PC Offer.' });

  const body = req.body || {};
  const sets = [];
  const params = [];

  if ('sku' in body) {
    if (!body.sku?.trim()) {
      return res.status(400).json({ success: false, message: 'The item needs a SKU (pick a product or type one in).' });
    }
    params.push(body.sku.trim());
    sets.push(`sku = $${params.length}`);
  }
  if ('product_id' in body) {
    params.push(body.product_id || null);
    sets.push(`product_id = $${params.length}`);
  }
  if ('serial_number' in body) {
    params.push(body.serial_number?.trim() ? normalizeSerial(body.serial_number) : null);
    sets.push(`serial_number = $${params.length}`);
  }
  if (sets.length === 0) {
    return res.status(400).json({ success: false, message: 'Nothing to update.' });
  }

  try {
    params.push(ids.itemId, ids.offerId);
    const result = await pool.query(
      `UPDATE product_serials SET ${sets.join(', ')}
       WHERE id = $${params.length - 1} AND offer_id = $${params.length}
       RETURNING id`,
      params
    );
    if (result.rows.length === 0) {
      return res.status(404).json({ success: false, message: 'Item not found in this PC Offer.' });
    }
    res.json({ success: true, data: await loadOfferWithItems(pool, ids.offerId) });
  } catch (err) {
    offerItemError(res, err);
  }
});

// Remove one item from an offer. The last item can't be removed — an offer
// with nothing in it isn't a sale; delete the whole offer instead. The row
// is locked so two people removing items at once can't empty the offer.
router.delete('/pc-offers/:id/items/:itemId', requirePermission('serials.manage'), async (req, res) => {
  const ids = parseIds(req);
  if (!ids) return res.status(404).json({ success: false, message: 'Item not found in this PC Offer.' });

  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const offer = await client.query('SELECT id FROM pc_offers WHERE id = $1 FOR UPDATE', [ids.offerId]);
    if (offer.rows.length === 0) {
      await client.query('ROLLBACK');
      return res.status(404).json({ success: false, message: 'PC Offer not found.' });
    }

    const count = await client.query('SELECT COUNT(*)::int AS count FROM product_serials WHERE offer_id = $1', [ids.offerId]);
    if (count.rows[0].count <= 1) {
      await client.query('ROLLBACK');
      return res.status(400).json({
        success: false,
        message: "That's the only item in this offer — delete the whole offer instead.",
      });
    }

    const result = await client.query(
      'DELETE FROM product_serials WHERE id = $1 AND offer_id = $2 RETURNING id',
      [ids.itemId, ids.offerId]
    );
    if (result.rows.length === 0) {
      await client.query('ROLLBACK');
      return res.status(404).json({ success: false, message: 'Item not found in this PC Offer.' });
    }

    const data = await loadOfferWithItems(client, ids.offerId);
    await client.query('COMMIT');
    res.json({ success: true, data });
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
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
