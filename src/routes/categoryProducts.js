import express, { Router } from 'express';
import pool from '../../db.js';

const router = Router();

router.get("/:slug", async (req, res) => {
  const { slug } = req.params;

  try {
    // 1. Check if the slug belongs to a Main Category (pulls products from all its subcategories)
    const categoryQuery = `
      SELECT 
        c.id, 
        c.name, 
        c.slug, 
        c.created_at,
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
      FROM categories c
      LEFT JOIN subcategories s ON s.parent_id = c.id
      LEFT JOIN products p ON p.category_slug = s.slug
      WHERE c.slug = $1
      GROUP BY c.id;
    `;

    const categoryResult = await pool.query(categoryQuery, [slug]);

    if (categoryResult.rows.length > 0) {
      return res.json({
        success: true,
        type: 'category',
        data: categoryResult.rows[0],
      });
    }

    // 2. Check if the slug belongs to a Subcategory
    const subcategoryQuery = `
      SELECT 
        s.id, 
        s.name, 
        s.slug, 
        s.parent_id, 
        s.is_featured, 
        s.created_at,
        c.name AS parent_name,
        c.slug AS parent_slug,
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
      JOIN categories c ON s.parent_id = c.id
      LEFT JOIN products p ON p.category_slug = s.slug
      WHERE s.slug = $1
      GROUP BY s.id, c.name, c.slug;
    `;

    const subcategoryResult = await pool.query(subcategoryQuery, [slug]);

    if (subcategoryResult.rows.length > 0) {
      return res.json({
        success: true,
        type: 'subcategory',
        data: subcategoryResult.rows[0],
      });
    }

    // 3. Not found in either table
    return res.status(404).json({
      success: false,
      message: 'Category or subcategory not found.',
    });

  } catch (error) {
    console.error('Error finding category/subcategory by slug:', error);
    return res.status(500).json({
      success: false,
      message: 'Internal server error.',
    });
  }
});

export default router;