import jwt from 'jsonwebtoken';
import crypto from 'node:crypto';
import { config } from '../config/index.js';
import { execute, one } from '../config/db.js';
import { sha256 } from './password.js';

/**
 * Token issue / verify / rotate.
 *
 * Two tokens, on purpose:
 *
 *   access  — 15 minutes, stateless, sent on every request.
 *   refresh — 30 days, stored as a SHA-256 digest, exchanged for a new pair.
 *
 * A single long-lived token would mean revoking a stolen one requires either a
 * blocklist checked on every request or waiting 30 days. Splitting them keeps
 * the hot path stateless while leaving one row to delete when a parent reports
 * a lost phone.
 */

export function signAccessToken(user) {
  return jwt.sign(
    { sub: String(user.id), role: user.role, status: user.status },
    config.jwt.secret,
    { expiresIn: config.jwt.expiresIn, issuer: 'app-code-backend' },
  );
}

export function verifyAccessToken(token) {
  return jwt.verify(token, config.jwt.secret, { issuer: 'app-code-backend' });
}

/**
 * Issue a refresh token and record its digest.
 *
 * The raw value is returned to the caller and then forgotten by the server —
 * only the digest is stored, so a database dump yields nothing usable.
 */
export async function issueRefreshToken(userId, userAgent = null) {
  const raw = crypto.randomBytes(48).toString('base64url');
  const expiresAt = new Date(Date.now() + parseDuration(config.jwt.refreshExpiresIn));

  await execute(
    `INSERT INTO ls_refresh_token (user_id, token_hash, expires_at, user_agent)
     VALUES (?, ?, ?, ?)`,
    [userId, sha256(raw), expiresAt, userAgent ? String(userAgent).slice(0, 255) : null],
  );

  return raw;
}

/**
 * Exchange a refresh token for the user it belongs to, rotating it.
 *
 * The old token is revoked in the same step. Reusing a refresh token is the
 * signature of a stolen one, and rotation makes the theft visible: the real
 * device's next refresh fails and forces a fresh sign-in.
 */
export async function rotateRefreshToken(raw, userAgent = null) {
  const row = await one(
    `SELECT rt.id, rt.user_id, rt.revoked_at, rt.expires_at,
            u.role, u.status
       FROM ls_refresh_token rt
       JOIN ls_user u ON u.id = rt.user_id
      WHERE rt.token_hash = ?`,
    [sha256(raw)],
  );

  if (!row) throw unauthorized('Invalid refresh token');
  if (row.revoked_at) throw unauthorized('Refresh token already used');
  if (new Date(row.expires_at) < new Date()) throw unauthorized('Refresh token expired');
  if (row.status === 'inactive') throw unauthorized('Account is deactivated');

  await execute('UPDATE ls_refresh_token SET revoked_at = NOW() WHERE id = ?', [row.id]);

  const user = { id: row.user_id, role: row.role, status: row.status };
  return {
    user,
    accessToken: signAccessToken(user),
    refreshToken: await issueRefreshToken(row.user_id, userAgent),
  };
}

/** Sign out one device. */
export async function revokeRefreshToken(raw) {
  await execute(
    'UPDATE ls_refresh_token SET revoked_at = NOW() WHERE token_hash = ? AND revoked_at IS NULL',
    [sha256(raw)],
  );
}

/** Sign out everywhere — used when an admin deactivates an account. */
export async function revokeAllForUser(userId) {
  const res = await execute(
    'UPDATE ls_refresh_token SET revoked_at = NOW() WHERE user_id = ? AND revoked_at IS NULL',
    [userId],
  );
  return res.affectedRows;
}

function unauthorized(message) {
  return Object.assign(new Error(message), { status: 401 });
}

/** "30d" / "15m" / "1h" → milliseconds. */
function parseDuration(str) {
  const m = /^(\d+)([smhd])$/.exec(String(str).trim());
  if (!m) return 30 * 24 * 60 * 60 * 1000;
  const n = Number(m[1]);
  const unit = { s: 1000, m: 60000, h: 3600000, d: 86400000 }[m[2]];
  return n * unit;
}
