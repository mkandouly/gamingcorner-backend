import express, { Router } from 'express';
import pool from '../../db.js';

const router = Router();

// GET /api/products/brand/:identifier (supports brand ID, slug, or name)
router.get("/:identifier", async (req, res) => {
  const { identifier } = req.params;
  const isNumeric = !isNaN(identifier);

  try {
    const brandQuery = `
      SELECT 
        b.id, 
        b.name, 
        b.logo_url, 
        b.is_popular, 
        b.created_at,
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
      FROM brands b
      LEFT JOIN products p ON p.brand_id = b.id
      WHERE ${isNumeric ? 'b.id = $1' : 'LOWER(b.name) = LOWER($1)'}
      GROUP BY b.id;
    `;

    const { rows } = await pool.query(brandQuery, [identifier]);

    if (rows.length > 0) {
      return res.json({
        success: true,
        type: 'brand',
        data: rows[0],
      });
    }

    return res.status(404).json({
      success: false,
      message: 'Brand not found.',
    });

  } catch (error) {
    console.error('Error fetching brand products by identifier:', error);
    return res.status(500).json({
      success: false,
      message: 'Internal server error.',
    });
  }
});

export default router;