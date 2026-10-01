// src/routes/authRoutes.js
import { Router } from 'express';
import bcrypt from 'bcryptjs';
import pool from '../../db.js';
import { signToken, requireAuth } from '../middleware/auth.js';

const router = Router();

// POST /api/admin/auth/login
router.post('/login', async (req, res) => {
  try {
    const { email, password } = req.body || {};

    if (!email || !password) {
      return res.status(400).json({ success: false, message: 'Email and password are required.' });
    }

    const { rows } = await pool.query(
      `SELECT id, name, email, password_hash, role, permissions, is_active
       FROM admins WHERE LOWER(email) = LOWER($1)`,
      [email]
    );
    const admin = rows[0];

    // Same generic message whether the email doesn't exist or the password
    // is wrong — don't reveal which one it was.
    if (!admin) {
      return res.status(401).json({ success: false, message: 'Invalid email or password.' });
    }
    if (!admin.is_active) {
      return res.status(403).json({ success: false, message: 'This account has been deactivated.' });
    }

    const passwordMatches = await bcrypt.compare(password, admin.password_hash);
    if (!passwordMatches) {
      return res.status(401).json({ success: false, message: 'Invalid email or password.' });
    }

    await pool.query('UPDATE admins SET last_login = NOW() WHERE id = $1', [admin.id]);

    const token = signToken(admin);

    res.json({
      success: true,
      data: {
        token,
        admin: {
          id: admin.id,
          name: admin.name,
          email: admin.email,
          role: admin.role,
          permissions: admin.permissions,
        },
      },
    });
  } catch (err) {
    console.error('Login failed:', err);
    res.status(500).json({ success: false, message: 'Internal server error.' });
  }
});

// GET /api/admin/auth/me — used on app load to validate the stored token
// and fetch fresh role/permissions (in case they changed since login).
router.get('/me', requireAuth, async (req, res) => {
  const { id, name, email, role, permissions } = req.admin;
  res.json({ success: true, data: { id, name, email, role, permissions } });
});

// POST /api/admin/auth/change-password — any authenticated admin can
// change their own password (including the seeded root, though the
// intended flow is to create a fresh root account instead — see
// adminAccountsRoutes.js).
router.post('/change-password', requireAuth, async (req, res) => {
  try {
    const { current_password, new_password } = req.body || {};

    if (!current_password || !new_password) {
      return res.status(400).json({ success: false, message: 'Current and new password are required.' });
    }
    if (new_password.length < 8) {
      return res.status(400).json({ success: false, message: 'New password must be at least 8 characters.' });
    }

    const { rows } = await pool.query('SELECT password_hash FROM admins WHERE id = $1', [req.admin.id]);
    const matches = await bcrypt.compare(current_password, rows[0].password_hash);

    if (!matches) {
      return res.status(401).json({ success: false, message: 'Current password is incorrect.' });
    }

    const newHash = await bcrypt.hash(new_password, 12);
    await pool.query('UPDATE admins SET password_hash = $1, updated_at = NOW() WHERE id = $2', [
      newHash,
      req.admin.id,
    ]);

    res.json({ success: true, message: 'Password updated.' });
  } catch (err) {
    console.error('Change password failed:', err);
    res.status(500).json({ success: false, message: 'Internal server error.' });
  }
});

export default router;
