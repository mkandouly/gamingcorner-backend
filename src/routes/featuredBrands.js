import express, { Router } from 'express';
import pool from '../../db.js';

const router = Router();

// GET /api/brands
router.get("/featured", async (req, res) => {
  try {
    const query = `
      SELECT id, name, logo_url 
      FROM brands 
      WHERE is_popular = true 
      ORDER BY name ASC
    `;

    const { rows } = await pool.query(query);

    return res.json({
      success: true,
      data: rows,
    });
  } catch (error) {
    console.error("Error fetching popular brands:", error);
    return res.status(500).json({
      success: false,
      message: "Internal server error",
    });
  }
});

export default router;