import express, { Router } from 'express';
import pool from '../../db.js';

const router = Router();

router.get('/', async (req, res) => {
    const LATEST_PRODUCTS = await pool.query(
        'SELECT * FROM products ORDER BY created_at DESC LIMIT 10'
    );
    res.status(200).json({
        success: true,
        data: LATEST_PRODUCTS.rows
    });
});

export default router;