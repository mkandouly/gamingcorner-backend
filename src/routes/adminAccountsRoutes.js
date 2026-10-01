// src/routes/adminAccountsRoutes.js
//
// Everything here is root-only (enforced by requireRoot below) — managing
// who has admin access, and what they can do, is not itself a grantable
// permission. See middleware/auth.js for why.
import { Router } from 'express';
import bcrypt from 'bcryptjs';
import pool from '../../db.js';
import { requireAuth, requireRoot } from '../middleware/auth.js';
import { PERMISSION_GROUPS, sanitizePermissions } from '../permissions.js';

const router = Router();

router.use(requireAuth, requireRoot);

// GET /api/admin/accounts/permissions — the full permission schema, so the
// frontend renders checkboxes from this instead of hardcoding the list.
router.get('/permissions', (req, res) => {
  res.json({ success: true, data: PERMISSION_GROUPS });
});

// GET /api/admin/accounts — list every admin account.
router.get('/', async (req, res) => {
  try {
    const { rows } = await pool.query(
      `SELECT id, name, email, role, permissions, is_active, is_seed, last_login, created_at
       FROM admins ORDER BY (role = 'root') DESC, created_at ASC`
    );
    res.json({ success: true, data: rows });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// POST /api/admin/accounts — create a new admin account.
router.post('/', async (req, res) => {
  try {
    const { name, email, password, role, permissions } = req.body || {};

    if (!name || !email || !password) {
      return res.status(400).json({ success: false, message: 'Name, email, and password are required.' });
    }
    if (password.length < 8) {
      return res.status(400).json({ success: false, message: 'Password must be at least 8 characters.' });
    }
    if (!['root', 'admin'].includes(role)) {
      return res.status(400).json({ success: false, message: 'Role must be "root" or "admin".' });
    }

    // Root accounts have every permission implicitly — no point storing
    // flags for them. Non-root accounts only get keys the schema knows
    // about; anything else is silently dropped.
    const cleanPermissions = role === 'root' ? {} : sanitizePermissions(permissions);
    const passwordHash = await bcrypt.hash(password, 12);

    const { rows } = await pool.query(
      `INSERT INTO admins (name, email, password_hash, role, permissions, is_active)
       VALUES ($1, $2, $3, $4, $5, TRUE)
       RETURNING id, name, email, role, permissions, is_active, is_seed, created_at`,
      [name, email, passwordHash, role, JSON.stringify(cleanPermissions)]
    );
    const created = rows[0];

    // The moment a real root account is created, the one-time seeded root
    // has served its purpose — remove it automatically so it can't linger
    // as a known-credential backdoor. Only ever touches the seed row, never
    // any other root account.
    let seedDeleted = false;
    if (created.role === 'root') {
      const seedResult = await pool.query(
        `DELETE FROM admins WHERE is_seed = TRUE AND id != $1 RETURNING id`,
        [created.id]
      );
      seedDeleted = seedResult.rows.length > 0;
    }

    res.status(201).json({ success: true, data: created, seed_account_deleted: seedDeleted });
  } catch (err) {
    if (err.code === '23505') {
      return res.status(409).json({ success: false, message: 'An account with that email already exists.' });
    }
    console.error('Error creating admin account:', err);
    res.status(500).json({ success: false, error: err.message });
  }
});

// PUT /api/admin/accounts/:id — update name/email/role/permissions/active.
router.put('/:id', async (req, res) => {
  try {
    const { id } = req.params;
    const targetId = Number(id);
    const { name, email, role, permissions, is_active } = req.body || {};

    const current = await pool.query('SELECT * FROM admins WHERE id = $1', [id]);
    if (current.rows.length === 0) {
      return res.status(404).json({ success: false, message: 'Account not found.' });
    }
    const existing = current.rows[0];

    if (role && !['root', 'admin'].includes(role)) {
      return res.status(400).json({ success: false, message: 'Role must be "root" or "admin".' });
    }

    const nextRole = role || existing.role;
    const nextIsActive = is_active === undefined ? existing.is_active : Boolean(is_active);

    // Guard against locking the system out of having any usable root
    // account: block demoting/deactivating this account if it's the last
    // active root left.
    const wouldLoseRootAccess =
      existing.role === 'root' && (nextRole !== 'root' || !nextIsActive) && existing.is_active;

    if (wouldLoseRootAccess) {
      const { rows: activeRoots } = await pool.query(
        `SELECT COUNT(*)::int AS count FROM admins WHERE role = 'root' AND is_active = TRUE AND id != $1`,
        [targetId]
      );
      if (activeRoots[0].count === 0) {
        return res.status(400).json({
          success: false,
          message: 'You can\'t remove root access from the last active root account.',
        });
      }
    }

    const nextPermissions =
      nextRole === 'root' ? {} : sanitizePermissions(permissions ?? existing.permissions);

    const { rows } = await pool.query(
      `UPDATE admins
       SET name = $1, email = $2, role = $3, permissions = $4, is_active = $5, updated_at = NOW()
       WHERE id = $6
       RETURNING id, name, email, role, permissions, is_active, is_seed, last_login, created_at`,
      [
        name || existing.name,
        email || existing.email,
        nextRole,
        JSON.stringify(nextPermissions),
        nextIsActive,
        targetId,
      ]
    );

    res.json({ success: true, data: rows[0] });
  } catch (err) {
    if (err.code === '23505') {
      return res.status(409).json({ success: false, message: 'An account with that email already exists.' });
    }
    console.error('Error updating admin account:', err);
    res.status(500).json({ success: false, error: err.message });
  }
});

// PUT /api/admin/accounts/:id/password — root resets another account's
// password (e.g. if they're locked out).
router.put('/:id/password', async (req, res) => {
  try {
    const { id } = req.params;
    const { password } = req.body || {};

    if (!password || password.length < 8) {
      return res.status(400).json({ success: false, message: 'Password must be at least 8 characters.' });
    }

    const passwordHash = await bcrypt.hash(password, 12);
    const result = await pool.query(
      `UPDATE admins SET password_hash = $1, updated_at = NOW() WHERE id = $2 RETURNING id`,
      [passwordHash, id]
    );

    if (result.rows.length === 0) {
      return res.status(404).json({ success: false, message: 'Account not found.' });
    }

    res.json({ success: true, message: 'Password reset.' });
  } catch (err) {
    console.error('Error resetting password:', err);
    res.status(500).json({ success: false, error: err.message });
  }
});

// DELETE /api/admin/accounts/:id
router.delete('/:id', async (req, res) => {
  try {
    const { id } = req.params;
    const targetId = Number(id);

    if (targetId === req.admin.id) {
      return res.status(400).json({ success: false, message: "You can't delete your own account." });
    }

    const current = await pool.query('SELECT role, is_active FROM admins WHERE id = $1', [id]);
    if (current.rows.length === 0) {
      return res.status(404).json({ success: false, message: 'Account not found.' });
    }

    if (current.rows[0].role === 'root' && current.rows[0].is_active) {
      const { rows: activeRoots } = await pool.query(
        `SELECT COUNT(*)::int AS count FROM admins WHERE role = 'root' AND is_active = TRUE AND id != $1`,
        [targetId]
      );
      if (activeRoots[0].count === 0) {
        return res.status(400).json({
          success: false,
          message: "You can't delete the last active root account.",
        });
      }
    }

    await pool.query('DELETE FROM admins WHERE id = $1', [id]);
    res.json({ success: true, message: 'Account deleted.' });
  } catch (err) {
    console.error('Error deleting admin account:', err);
    res.status(500).json({ success: false, error: err.message });
  }
});

export default router;
