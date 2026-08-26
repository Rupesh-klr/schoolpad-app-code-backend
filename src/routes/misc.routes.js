import { Router } from 'express';
import { healthCheck, query } from '../config/db.js';
import { config } from '../config/index.js';
import { PUBLIC_CONSTANTS } from '../config/constants.js';
import { asyncHandler } from '../middleware/error.js';

const router = Router();

/**
 * Unauthenticated endpoints.
 *
 * Everything here is either operational or needed *before* a user has an
 * account — the school list on the registration form, the code length the
 * input box validates against.
 */

router.get('/health', asyncHandler(async (req, res) => {
  const db = await healthCheck();
  // 200 even when the database is down, because the load balancer's question is
  // "is this process answering" — a stricter code would pull the instance out of
  // service over a database blip and turn a degraded API into no API at all.
  res.json({
    status: db.up ? 'ok' : 'degraded',
    env: config.env,
    database: db,
    uptimeSeconds: Math.round(process.uptime()),
  });
}));

/**
 * The constants the app is allowed to know.
 *
 * The app calls this at launch and uses it to size the access-code input and
 * the OTP boxes. The server stays the authority — this is a hint for the UI,
 * and every value is re-checked on submit.
 */
router.get('/meta/constants', (req, res) => {
  res.json(PUBLIC_CONSTANTS);
});

/** Schools, for the registration dropdown. Active ones only, no counts. */
router.get('/meta/schools', asyncHandler(async (req, res) => {
  const rows = await query(
    `SELECT id, name, code FROM ls_school WHERE status = 'active' ORDER BY name`,
  );
  res.json({ schools: rows });
}));

/**
 * Privacy policy and terms.
 *
 * Public because both stores require a reachable policy URL, and the app links
 * here from its sign-up screen before anyone has a token.
 */
router.get('/meta/legal/:key', asyncHandler(async (req, res) => {
  const allowed = ['privacy_policy', 'terms_conditions'];
  if (!allowed.includes(req.params.key)) {
    return res.status(404).json({ error: 'Unknown document', code: 'NOT_FOUND' });
  }
  const rows = await query('SELECT value, updated_at FROM ls_app_setting WHERE setting_key = ?', [req.params.key]);
  res.json({
    key: req.params.key,
    content: rows[0]?.value || '',
    updatedAt: rows[0]?.updated_at || null,
  });
}));

export default router;
