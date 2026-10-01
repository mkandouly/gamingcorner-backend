// src/middleware/auth.js
import jwt from 'jsonwebtoken';
import pool from '../../db.js';

const JWT_SECRET = process.env.JWT_SECRET;

if (!JWT_SECRET) {
  // Not throwing here so the app can still boot in a fresh dev environment,
  // but this must be set to a real secret before this is ever exposed
  // publicly — anyone with this value can forge admin tokens.
  console.warn(
    '\n[WARNING] JWT_SECRET is not set in the environment. Using an insecure ' +
      'development fallback. Set JWT_SECRET in your .env before deploying.\n'
  );
}
const SECRET = JWT_SECRET || 'dev-only-insecure-secret-change-me';

export function signToken(admin) {
  return jwt.sign({ id: admin.id }, SECRET, { expiresIn: '12h' });
}

// Verifies the JWT, then re-reads the account from the database on every
// request (rather than trusting the token's payload) so that a deactivated
// account, a changed role, or updated permissions take effect immediately
// instead of waiting for the token to expire.
export async function requireAuth(req, res, next) {
  try {
    const header = req.headers.authorization || '';
    const [scheme, token] = header.split(' ');

    if (scheme !== 'Bearer' || !token) {
      return res.status(401).json({ success: false, message: 'Not authenticated.' });
    }

    let payload;
    try {
      payload = jwt.verify(token, SECRET);
    } catch {
      return res.status(401).json({ success: false, message: 'Invalid or expired session.' });
    }

    const { rows } = await pool.query(
      `SELECT id, name, email, role, permissions, is_active, is_seed
       FROM admins WHERE id = $1`,
      [payload.id]
    );

    const admin = rows[0];
    if (!admin || !admin.is_active) {
      return res.status(401).json({ success: false, message: 'Account not found or deactivated.' });
    }

    req.admin = admin;
    next();
  } catch (err) {
    console.error('Auth check failed:', err);
    res.status(500).json({ success: false, message: 'Internal server error.' });
  }
}

// Root accounts bypass permission checks entirely — they can do anything.
// Non-root accounts need the exact permission key set to true.
export function requirePermission(key) {
  return (req, res, next) => {
    const admin = req.admin;
    if (!admin) {
      return res.status(401).json({ success: false, message: 'Not authenticated.' });
    }
    if (admin.role === 'root') return next();

    if (admin.permissions?.[key] === true) return next();

    return res.status(403).json({
      success: false,
      message: `You don't have permission to do that ("${key}").`,
    });
  };
}

// Managing admin accounts (creating accounts, granting permissions,
// deactivating/deleting accounts) is intentionally NOT a grantable
// permission — it's hardcoded to root only, so a non-root account can never
// be given (or grant itself, via a bug or a misconfigured permission) the
// ability to create another admin with more access than itself.
export function requireRoot(req, res, next) {
  if (!req.admin) {
    return res.status(401).json({ success: false, message: 'Not authenticated.' });
  }
  if (req.admin.role !== 'root') {
    return res.status(403).json({ success: false, message: 'Only root accounts can do that.' });
  }
  next();
}
