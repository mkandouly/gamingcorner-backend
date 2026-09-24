import { Router } from 'express';
import pool from '../../db.js';

const router = Router();

// GET /api/category/:identifier (matches slug or id)
router.get("/:identifier", async (req, res) => {
  const { identifier } = req.params;
  const isNumeric = !isNaN(identifier);

  try {
    const sql = `
      SELECT 
        s.id, 
        s.name, 
        s.slug, 
        s.parent_id,
        COALESCE(
          json_agg(
            json_build_object(
              'id', p.id,
              'sku', p.sku,
              'name', p.name,
              'description', p.description,
              'price', p.price,
              'sale_price', p.sale_price,
              'brand_id', p.brand_id,
              'image_url', p.image_url,
              'category_slug', p.category_slug
            )
          ) FILTER (WHERE p.id IS NOT NULL), '[]'
        ) AS products
      FROM subcategories s
      LEFT JOIN products p ON LOWER(p.category_slug) = LOWER(s.slug)
      WHERE ${isNumeric ? 's.id = $1' : 'LOWER(s.slug) = LOWER($1)'}
      GROUP BY s.id;
    `;

    const { rows } = await pool.query(sql, [identifier]);

    if (rows.length > 0) {
      return res.json({
        success: true,
        data: rows[0],
      });
    }

    return res.status(404).json({
      success: false,
      message: 'Subcategory not found.',
    });

  } catch (error) {
    console.error('Error fetching subcategory products:', error);
    return res.status(500).json({
      success: false,
      message: 'Internal server error.',
    });
  }
});

export default router;