import express from 'express';
import multer from 'multer';
import path from 'path';
import fs from 'fs';
import pool from '../../db.js';

const router = express.Router();

// Ensure 'uploads' directory exists
const uploadDir = path.join(process.cwd(), 'uploads');
if (!fs.existsSync(uploadDir)) {
  fs.mkdirSync(uploadDir, { recursive: true });
}

// Multer Storage Configuration
const storage = multer.diskStorage({
  destination: (req, file, cb) => cb(null, 'uploads/'),
  filename: (req, file, cb) => {
    const uniqueSuffix = Date.now() + '-' + Math.round(Math.random() * 1e9);
    cb(null, `${file.fieldname}-${uniqueSuffix}${path.extname(file.originalname)}`);
  },
});

const upload = multer({
  storage,
  limits: { fileSize: 5 * 1024 * 1024 },
  fileFilter: (req, file, cb) => {
    if (file.mimetype.startsWith('image/')) cb(null, true);
    else cb(new Error('Only image files are allowed!'), false);
  },
});

// ==========================================
// FILE UPLOADS
// ==========================================
router.post('/upload/single', upload.single('image'), (req, res) => {
  if (!req.file) return res.status(400).json({ success: false, message: 'No file uploaded' });
  res.json({ success: true, imageUrl: `/uploads/${req.file.filename}` });
});

router.post('/upload/multiple', upload.array('images', 10), (req, res) => {
  if (!req.files || req.files.length === 0) return res.status(400).json({ success: false, message: 'No files uploaded' });
  const imageUrls = req.files.map(file => `/uploads/${file.filename}`);
  res.json({ success: true, imageUrls });
});

// ==========================================
// CATEGORIES
// ==========================================
router.get('/categories', async (req, res) => {
  try {
    const result = await pool.query('SELECT * FROM categories ORDER BY id DESC');
    res.json({ success: true, data: result.rows });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

router.post('/categories', async (req, res) => {
  try {
    const { name, slug } = req.body;
    const result = await pool.query(
      'INSERT INTO categories (name, slug) VALUES ($1, $2) RETURNING *',
      [name, slug]
    );
    res.status(201).json({ success: true, data: result.rows[0] });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

router.put('/categories/:id', async (req, res) => {
  try {
    const { id } = req.params;
    const { name, slug } = req.body;
    const result = await pool.query(
      'UPDATE categories SET name = $1, slug = $2 WHERE id = $3 RETURNING *',
      [name, slug, id]
    );
    res.json({ success: true, data: result.rows[0] });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

router.delete('/categories/:id', async (req, res) => {
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
router.get('/subcategories', async (req, res) => {
  try {
    const result = await pool.query('SELECT * FROM subcategories ORDER BY id DESC');
    res.json({ success: true, data: result.rows });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

router.post('/subcategories', async (req, res) => {
  try {
    const { name, slug, parent_id, is_featured } = req.body;
    const result = await pool.query(
      'INSERT INTO subcategories (name, slug, parent_id, is_featured) VALUES ($1, $2, $3, $4) RETURNING *',
      [name, slug, parent_id, is_featured || false]
    );
    res.status(201).json({ success: true, data: result.rows[0] });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

router.put('/subcategories/:id', async (req, res) => {
  try {
    const { id } = req.params;
    const { name, slug, parent_id, is_featured } = req.body;
    const result = await pool.query(
      'UPDATE subcategories SET name = $1, slug = $2, parent_id = $3, is_featured = $4 WHERE id = $5 RETURNING *',
      [name, slug, parent_id, is_featured || false, id]
    );
    res.json({ success: true, data: result.rows[0] });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

router.delete('/subcategories/:id', async (req, res) => {
  try {
    await pool.query('DELETE FROM subcategories WHERE id = $1', [req.params.id]);
    res.json({ success: true, message: `Subcategory ${req.params.id} deleted` });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

router.get('/subscribers', async (req, res) => {
  try {
    // If using PostgreSQL (pg pool):
    const { rows } = await pool.query('SELECT * FROM subscribers ORDER BY id DESC');
    
    // OR if using Prisma:
    // const rows = await prisma.subscriber.findMany({ orderBy: { id: 'desc' } });

    res.json({ success: true, data: rows });
  } catch (error) {
    console.error('Subscribers fetch error:', error);
    res.status(500).json({ success: false, message: error.message });
  }
});

// ==========================================
// BRANDS
// ==========================================
router.get('/brands', async (req, res) => {
  try {
    const result = await pool.query('SELECT * FROM brands ORDER BY id DESC');
    res.json({ success: true, data: result.rows });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

router.post('/brands', async (req, res) => {
  try {
    const { name, logo_url, is_featured } = req.body;
    const result = await pool.query(
      'INSERT INTO brands (name, logo_url, is_featured) VALUES ($1, $2, $3) RETURNING *',
      [name, logo_url, is_featured || false]
    );
    res.status(201).json({ success: true, data: result.rows[0] });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

router.put('/brands/:id', async (req, res) => {
  try {
    const { id } = req.params;
    const { name, logo_url, is_featured } = req.body;
    const result = await pool.query(
      'UPDATE brands SET name = $1, logo_url = $2, is_featured = $3 WHERE id = $4 RETURNING *',
      [name, logo_url, is_featured || false, id]
    );
    res.json({ success: true, data: result.rows[0] });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

router.delete('/brands/:id', async (req, res) => {
  try {
    await pool.query('DELETE FROM brands WHERE id = $1', [req.params.id]);
    res.json({ success: true, message: `Brand ${req.params.id} deleted` });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// ==========================================
// PRODUCTS
// ==========================================
router.get('/products', async (req, res) => {
  try {
    const result = await pool.query('SELECT * FROM products ORDER BY id DESC');
    res.json({ success: true, data: result.rows });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

router.post('/products', async (req, res) => {
  try {
    const { sku, name, price, sale_price, brand_id, category_slug, is_featured, images } = req.body;
    const result = await pool.query(
      `INSERT INTO products (sku, name, price, sale_price, brand_id, category_slug, is_featured, images)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8) RETURNING *`,
      [sku, name, price, sale_price || null, brand_id, category_slug, is_featured || false, JSON.stringify(images || [])]
    );
    res.status(201).json({ success: true, data: result.rows[0] });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

router.put('/products/:id', async (req, res) => {
  try {
    const { id } = req.params;
    const { sku, name, price, sale_price, brand_id, category_slug, is_featured, images } = req.body;
    const result = await pool.query(
      `UPDATE products 
       SET sku = $1, name = $2, price = $3, sale_price = $4, brand_id = $5, category_slug = $6, is_featured = $7, images = $8
       WHERE id = $9 RETURNING *`,
      [sku, name, price, sale_price || null, brand_id, category_slug, is_featured || false, JSON.stringify(images || []), id]
    );
    res.json({ success: true, data: result.rows[0] });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

router.delete('/products/:id', async (req, res) => {
  try {
    await pool.query('DELETE FROM products WHERE id = $1', [req.params.id]);
    res.json({ success: true, message: `Product ${req.params.id} deleted` });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// ==========================================
// BANNERS
// ==========================================
router.get('/banners', async (req, res) => {
  try {
    const result = await pool.query('SELECT * FROM banners ORDER BY id DESC');
    res.json({ success: true, data: result.rows });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

router.post('/banners', async (req, res) => {
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

router.put('/banners/:id', async (req, res) => {
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

router.delete('/banners/:id', async (req, res) => {
  try {
    await pool.query('DELETE FROM banners WHERE id = $1', [req.params.id]);
    res.json({ success: true, message: `Banner ${req.params.id} deleted` });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// ==========================================
// ADMIN ACCOUNTS
// ==========================================
router.get('/admins', async (req, res) => {
  try {
    const result = await pool.query('SELECT id, name, email, role, is_active FROM admins ORDER BY id DESC');
    res.json({ success: true, data: result.rows });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

router.post('/admins', async (req, res) => {
  try {
    const { name, email, password, role } = req.body;
    const result = await pool.query(
      'INSERT INTO admins (name, email, password, role) VALUES ($1, $2, $3, $4) RETURNING id, name, email, role, is_active',
      [name, email, password, role || 'admin']
    );
    res.status(201).json({ success: true, data: result.rows[0] });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

router.put('/admins/:id', async (req, res) => {
  try {
    const { id } = req.params;
    const { name, email, role, is_active } = req.body;
    const result = await pool.query(
      'UPDATE admins SET name = $1, email = $2, role = $3, is_active = $4 WHERE id = $5 RETURNING id, name, email, role, is_active',
      [name, email, role, is_active ?? true, id]
    );
    res.json({ success: true, data: result.rows[0] });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

router.delete('/admins/:id', async (req, res) => {
  try {
    await pool.query('DELETE FROM admins WHERE id = $1', [req.params.id]);
    res.json({ success: true, message: `Admin ${req.params.id} deleted` });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

export default router;