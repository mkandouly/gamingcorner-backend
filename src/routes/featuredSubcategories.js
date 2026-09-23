import express, { Router } from 'express';
import pool from '../../db.js';

const router = Router();

// GET /api/admin/subcategories/featured
router.get("/featured", async (req, res) => {
  try {
    const query = `
      SELECT slug 
      FROM subcategories 
      WHERE is_featured = true 
      ORDER BY id ASC
    `;

    const { rows } = await pool.query(query);

    // Map rows to a flat array of string slugs: ["keyboards", "monitors", ...]
    const featuredSlugs = rows.map((row) => row.slug);

    return res.json({
      success: true,
      data: featuredSlugs,
    });
  } catch (error) {
    console.error("Error fetching featured subcategories:", error);
    return res.status(500).json({
      success: false,
      message: "Internal server error",
    });
  }
});

export default router;