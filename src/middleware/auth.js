import { verifyAccessToken } from '../services/tokens.js';
import { one } from '../config/db.js';
import { ROLES, USER_STATUS } from '../config/constants.js';

/**
 * Authentication and role gates.
 *
 * The token is verified for authenticity, then the user is re-read from the
 * database. That extra query is deliberate: an admin who deactivates a student
 * expects it to take effect now, and a status baked into a 15-minute token
 * would leave the account working for up to 15 more minutes. Correctness of
 * "deactivate" beats saving one indexed primary-key lookup.
 */
export async function authenticate(req, res, next) {
  const header = req.headers.authorization || '';
  const token = header.startsWith('Bearer ') ? header.slice(7) : null;

  if (!token) {
    return res.status(401).json({ error: 'Authentication required', code: 'NO_TOKEN' });
  }

  let claims;
  try {
    claims = verifyAccessToken(token);
  } catch (err) {
    const expired = err.name === 'TokenExpiredError';
    return res.status(401).json({
      error: expired ? 'Session expired' : 'Invalid token',
      // The app watches for this to trigger a silent refresh instead of
      // bouncing the user to the login screen.
      code: expired ? 'TOKEN_EXPIRED' : 'TOKEN_INVALID',
    });
  }

  const user = await one(
    `SELECT id, role, status, email, phone, full_name FROM app_user WHERE id = ?`,
    [claims.sub],
  );

  if (!user) {
    return res.status(401).json({ error: 'Account no longer exists', code: 'USER_GONE' });
  }
  if (user.status === USER_STATUS.INACTIVE) {
    return res.status(403).json({ error: 'This account has been deactivated', code: 'ACCOUNT_INACTIVE' });
  }

  req.user = user;
  return next();
}

/**
 * Restrict to one or more roles.
 *
 *   router.get('/schools', authenticate, requireRole(ROLES.ADMIN), handler)
 */
export function requireRole(...roles) {
  return (req, res, next) => {
    if (!req.user) {
      return res.status(401).json({ error: 'Authentication required', code: 'NO_TOKEN' });
    }
    if (!roles.includes(req.user.role)) {
      // 403, not 404: the caller is authenticated and we are declining, which
      // is a different problem for them to fix than a wrong URL.
      return res.status(403).json({
        error: 'You do not have access to this',
        code: 'FORBIDDEN_ROLE',
      });
    }
    return next();
  };
}

export const requireAdmin = requireRole(ROLES.ADMIN);

/**
 * Gate content behind activation.
 *
 * A pending student is signed in and can see their own status — that is how the
 * "waiting for approval" screen works — but must not reach content. The
 * response carries the status so the app can route to the right gate screen
 * without a second call.
 */
export function requireActive(req, res, next) {
  if (req.user.status !== USER_STATUS.ACTIVE) {
    return res.status(403).json({
      error: 'Your account is not active yet',
      code: 'ACCOUNT_PENDING',
      status: req.user.status,
    });
  }
  return next();
}
