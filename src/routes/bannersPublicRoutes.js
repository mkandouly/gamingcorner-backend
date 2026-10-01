import { Router } from 'express';
import pool from '../../db.js';

const router = Router();

// GET /api/banners — public, active banners only, for the homepage hero
// slider. (Admin management, including inactive/draft banners, lives at
// /api/admin/banners behind auth.)
router.get('/', async (req, res) => {
  try {
    const result = await pool.query(
      `SELECT id, title, image_url, link FROM banners WHERE is_active = TRUE ORDER BY created_at ASC`
    );
    res.json({ success: true, data: result.rows });
  } catch (err) {
    console.error('Error fetching banners:', err);
    res.status(500).json({ success: false, message: 'Internal server error.' });
  }
});

export default router;
