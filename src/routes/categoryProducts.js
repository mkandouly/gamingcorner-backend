import { Router } from "express";
import pool from "../../db.js";

const router = Router();

router.get("/", async (req, res) => {
  try {
    const query = `
      SELECT 
        c.id AS category_id,
        c.name AS category_name,
        c.slug AS category_slug,
        c.is_hot AS category_is_hot,
        s.id AS subcategory_id,
        s.name AS subcategory_name,
        s.slug AS subcategory_slug,
        s.is_featured AS subcategory_is_featured
      FROM categories c
      LEFT JOIN subcategories s ON c.id = s.parent_id
      ORDER BY c.id ASC, s.id ASC;
    `;

    const { rows } = await pool.query(query);

    const categoriesMap = {};

    rows.forEach((row) => {
      if (!categoriesMap[row.category_id]) {
        categoriesMap[row.category_id] = {
          id: row.category_id,
          name: row.category_name,
          slug: row.category_slug,
          is_hot: Boolean(row.category_is_hot),
          subcategories: [],
        };
      }

      if (row.subcategory_id) {
        categoriesMap[row.category_id].subcategories.push({
          id: row.subcategory_id,
          name: row.subcategory_name,
          slug: row.subcategory_slug,
          is_featured: row.subcategory_is_featured,
        });
      }
    });

    res.json(Object.values(categoriesMap));
  } catch (error) {
    console.error("Error fetching categories:", error);
    res.status(500).json({ error: "Failed to fetch categories" });
  }
});

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
      WHERE ${isNumeric ? "s.id = $1" : "LOWER(s.slug) = LOWER($1)"}
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
      message: "Subcategory not found.",
    });
  } catch (error) {
    console.error("Error fetching subcategory products:", error);
    return res.status(500).json({
      success: false,
      message: "Internal server error.",
    });
  }
});

export default router;
