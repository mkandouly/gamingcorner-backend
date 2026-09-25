import { Router } from 'express';
import pool from '../../db.js';

const router = Router();

router.get('/', async (req, res) => {
  try {
    const { search, category } = req.query;

    let queryText = `
      SELECT 
        p.*, 
        s.name AS subcategory_name,
        c.name AS category_name, 
        b.name AS brand_name 
      FROM products p 
      LEFT JOIN subcategories s ON p.category_slug = s.slug
      LEFT JOIN categories c ON s.parent_id = c.id
      LEFT JOIN brands b ON p.brand_id = b.id 
      WHERE 1=1
    `;
    const queryParams = [];

    // Apply search filter across product name, description, and SKU
    if (search) {
      queryParams.push(`%${search}%`);
      queryText += ` AND (p.name ILIKE $${queryParams.length} OR p.description ILIKE $${queryParams.length} OR p.sku ILIKE $${queryParams.length})`;
    }

    // Apply category filter if passed
    if (category) {
      queryParams.push(category);
      queryText += ` AND p.category_slug = $${queryParams.length}`;
    }

    queryText += ` ORDER BY p.created_at DESC;`;

    const result = await pool.query(queryText, queryParams);

    res.json({
      success: true,
      data: result.rows,
      count: result.rows.length
    });

  } catch (error) {
    console.error('Error fetching/searching products:', error);
    res.status(500).json({ success: false, message: 'Internal server error' });
  }
});

// GET /api/products/:id
router.get('/:id', async (req, res) => {
  try {
    const { id } = req.params;

    // Join products -> subcategories (via category_slug = subcategories.slug) -> categories (via parent_id)
    const productQuery = `
      SELECT 
        p.*, 
        s.name AS subcategory_name,
        c.name AS category_name, 
        b.name AS brand_name 
      FROM products p 
      LEFT JOIN subcategories s ON p.category_slug = s.slug
      LEFT JOIN categories c ON s.parent_id = c.id
      LEFT JOIN brands b ON p.brand_id = b.id 
      WHERE p.id = $1;
    `;
    const productResult = await pool.query(productQuery, [id]);

    if (productResult.rows.length === 0) {
      return res.status(404).json({ success: false, message: 'Product not found' });
    }

    const product = productResult.rows[0];

    // Fetch specifications matching product_specifications (product_id -> products.id)
    const specsQuery = `
      SELECT 
        specification AS key, 
        details AS value 
      FROM product_specifications 
      WHERE product_id = $1;
    `;
    const specsResult = await pool.query(specsQuery, [id]);

    res.json({
      success: true,
      data: {
        ...product,
        specifications: specsResult.rows
      }
    });

  } catch (error) {
    console.error('Error fetching product details and specs:', error);
    res.status(500).json({ success: false, message: 'Internal server error' });
  }
});



export default router;