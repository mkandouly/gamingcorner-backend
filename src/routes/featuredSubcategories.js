import { Router } from 'express';
import pool from '../../db.js';

const router = Router();

// GET /api/subcategory/featured
router.get("/featured", async (req, res) => {
  try {
    const sql = `
      SELECT id, name, slug, parent_id, is_featured, created_at
      FROM subcategories
      WHERE is_featured = true
      ORDER BY id ASC;
    `;

    const { rows } = await pool.query(sql);

    return res.json({
      success: true,
      data: rows,
    });
  } catch (error) {
    console.error('Error fetching featured subcategories:', error);
    return res.status(500).json({
      success: false,
      message: 'Internal server error.',
    });
  }
});

export default router;