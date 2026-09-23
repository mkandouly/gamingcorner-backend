import express, { Router } from 'express';
import pool from '../../db.js';

const router = Router();

router.get('/', async (req, res) => {
  try {
    const popularBrandsQuery = `
      SELECT 
        id, 
        name, 
        logo_url, 
        is_featured, 
        is_popular,
        created_at
      FROM brands
      WHERE is_popular = true
      ORDER BY name ASC;
    `;

    const result = await pool.query(popularBrandsQuery);

    return res.json({
      success: true,
      data: result.rows,
    });
  } catch (error) {
    console.error('Error fetching popular brands:', error);
    return res.status(500).json({
      success: false,
      message: 'Failed to retrieve popular brands.',
    });
  }
});

export default router;