import { Router } from 'express';
import pool from '../../db.js';

const router = Router();

// GET /api/settings/:key — public read of a single site setting.
// Returns { key, value: null } (not a 404) when the key doesn't exist yet,
// since the frontend should just fall back to a sensible default rather
// than treating "unset" as an error.
router.get('/:key', async (req, res) => {
  try {
    const { key } = req.params;
    const result = await pool.query('SELECT key, value FROM site_settings WHERE key = $1', [key]);

    if (result.rows.length === 0) {
      return res.json({ success: true, data: { key, value: null } });
    }

    res.json({ success: true, data: result.rows[0] });
  } catch (err) {
    console.error('Error fetching setting:', err);
    res.status(500).json({ success: false, message: 'Internal server error.' });
  }
});

export default router;
