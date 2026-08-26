import { Router } from 'express';
import { z } from 'zod';
import { execute, one, query } from '../config/db.js';
import { PASSWORD, ROLES, USER_STATUS } from '../config/constants.js';
import { hashPassword } from '../services/password.js';
import { revokeAllForUser } from '../services/tokens.js';
import { authenticate, requireAdmin } from '../middleware/auth.js';
import { asyncHandler } from '../middleware/error.js';

const router = Router();
router.use(authenticate, requireAdmin);

/** Dashboard tiles — section 2.1. */
router.get('/dashboard', asyncHandler(async (req, res) => {
  // One round trip per metric would be five; this is one query per table with
  // conditional aggregates, which the indexes already cover.
  const [schools] = await query(
    `SELECT COUNT(*) AS total, SUM(status = 'active') AS active FROM ls_school`,
  );
  const [students] = await query(
    `SELECT COUNT(*) AS total,
            SUM(status = 'active')   AS active,
            SUM(status = 'pending')  AS pending,
            SUM(status = 'inactive') AS inactive
       FROM ls_user WHERE role = ?`, [ROLES.STUDENT],
  );
  const [codes] = await query(
    `SELECT COUNT(*) AS total,
            SUM(status = 'used')     AS used,
            SUM(status = 'unused')   AS unused,
            SUM(status = 'inactive') AS inactive
       FROM ls_access_code`,
  );
  const [parents] = await query(
    `SELECT COUNT(*) AS total FROM ls_user WHERE role = ?`, [ROLES.PARENT],
  );
  const [content] = await query(
    `SELECT (SELECT COUNT(*) FROM ls_content_node) AS nodes,
            (SELECT COUNT(*) FROM ls_content_item) AS items`,
  );

  const recentStudents = await query(
    `SELECT u.id, u.full_name, u.status, u.created_at, s.name AS school_name, sp.class_level
       FROM ls_user u
       LEFT JOIN ls_student_profile sp ON sp.user_id = u.id
       LEFT JOIN ls_school s           ON s.id = sp.school_id
      WHERE u.role = ?
      ORDER BY u.created_at DESC LIMIT 8`, [ROLES.STUDENT],
  );

  const n = (v) => Number(v || 0);
  res.json({
    schools:  { total: n(schools.total), active: n(schools.active) },
    students: { total: n(students.total), active: n(students.active), pending: n(students.pending), inactive: n(students.inactive) },
    parents:  { total: n(parents.total) },
    codes:    { total: n(codes.total), used: n(codes.used), unused: n(codes.unused), inactive: n(codes.inactive) },
    content:  { folders: n(content.nodes), items: n(content.items) },
    recentStudents: recentStudents.map((r) => ({
      id: r.id, fullName: r.full_name, status: r.status,
      schoolName: r.school_name, classLevel: r.class_level, registeredAt: r.created_at,
    })),
  });
}));

// ─── Admin user management — section 2.7 ─────────────────────────────────────

router.get('/users', asyncHandler(async (req, res) => {
  const rows = await query(
    `SELECT id, full_name, email, status, created_at, last_login_at
       FROM ls_user WHERE role = ? ORDER BY created_at`, [ROLES.ADMIN],
  );
  res.json({
    admins: rows.map((r) => ({
      id: r.id, fullName: r.full_name, email: r.email, status: r.status,
      createdAt: r.created_at, lastLoginAt: r.last_login_at,
    })),
  });
}));

router.post('/users', asyncHandler(async (req, res) => {
  const body = z.object({
    fullName: z.string().min(2).max(150),
    email: z.string().email().max(191),
    password: z.string().min(PASSWORD.MIN_LENGTH),
  }).parse(req.body);

  const email = body.email.toLowerCase();

  // The UNIQUE index would catch this anyway, but the generic duplicate error
  // does not say *why* — and "this email is already a student" is the one
  // explanation an admin needs to understand the role-exclusivity rule.
  const clash = await one('SELECT role FROM ls_user WHERE email = ?', [email]);
  if (clash) {
    throw Object.assign(
      new Error(`That email is already registered as a ${clash.role} account. One email, one role.`),
      { status: 409, code: 'EMAIL_ROLE_CONFLICT' },
    );
  }

  const result = await execute(
    `INSERT INTO ls_user (role, email, full_name, password_hash, status, activated_at, activated_by)
     VALUES (?, ?, ?, ?, ?, NOW(), ?)`,
    [ROLES.ADMIN, email, body.fullName, await hashPassword(body.password), USER_STATUS.ACTIVE, req.user.id],
  );

  await execute(
    `INSERT INTO ls_audit_log (actor_id, action, entity_type, entity_id, detail)
     VALUES (?, 'admin.create', 'app_user', ?, ?)`,
    [req.user.id, String(result.insertId), JSON.stringify({ email })],
  );

  res.status(201).json({ admin: { id: result.insertId, fullName: body.fullName, email, status: USER_STATUS.ACTIVE } });
}));

router.patch('/users/:id/status', asyncHandler(async (req, res) => {
  const { status } = z.object({ status: z.enum([USER_STATUS.ACTIVE, USER_STATUS.INACTIVE]) }).parse(req.body);

  if (Number(req.params.id) === Number(req.user.id)) {
    throw Object.assign(
      new Error('You cannot deactivate your own account'),
      { status: 400, code: 'SELF_DEACTIVATE' },
    );
  }

  // Locking out the last admin would leave the dashboard unreachable with no
  // way back in short of editing the database by hand.
  if (status === USER_STATUS.INACTIVE) {
    const [{ n }] = await query(
      `SELECT COUNT(*) AS n FROM ls_user WHERE role = ? AND status = ? AND id <> ?`,
      [ROLES.ADMIN, USER_STATUS.ACTIVE, req.params.id],
    );
    if (Number(n) === 0) {
      throw Object.assign(
        new Error('This is the last active admin — deactivating it would lock everyone out'),
        { status: 409, code: 'LAST_ADMIN' },
      );
    }
  }

  const result = await execute(
    'UPDATE ls_user SET status = ? WHERE id = ? AND role = ?',
    [status, req.params.id, ROLES.ADMIN],
  );
  if (!result.affectedRows) throw Object.assign(new Error('Admin not found'), { status: 404 });

  const revoked = status === USER_STATUS.INACTIVE ? await revokeAllForUser(req.params.id) : 0;
  res.json({ id: Number(req.params.id), status, sessionsRevoked: revoked });
}));

/** Reset another admin's password. */
router.post('/users/:id/password', asyncHandler(async (req, res) => {
  const { newPassword } = z.object({ newPassword: z.string().min(PASSWORD.MIN_LENGTH) }).parse(req.body);

  const result = await execute(
    'UPDATE ls_user SET password_hash = ? WHERE id = ? AND role = ?',
    [await hashPassword(newPassword), req.params.id, ROLES.ADMIN],
  );
  if (!result.affectedRows) throw Object.assign(new Error('Admin not found'), { status: 404 });

  // Their existing sessions keep working otherwise, which defeats the point of
  // resetting a password you believe is compromised.
  const revoked = await revokeAllForUser(req.params.id);

  await execute(
    `INSERT INTO ls_audit_log (actor_id, action, entity_type, entity_id) VALUES (?, 'admin.password_reset', 'app_user', ?)`,
    [req.user.id, String(req.params.id)],
  );

  res.json({ reset: true, sessionsRevoked: revoked });
}));

// ─── Settings — privacy policy, terms, anything free-text ────────────────────

router.get('/settings', asyncHandler(async (req, res) => {
  const rows = await query('SELECT setting_key, value, updated_at FROM ls_app_setting');
  res.json({ settings: Object.fromEntries(rows.map((r) => [r.setting_key, { value: r.value, updatedAt: r.updated_at }])) });
}));

router.put('/settings/:key', asyncHandler(async (req, res) => {
  const { value } = z.object({ value: z.string().max(200000) }).parse(req.body);
  const key = z.string().max(100).regex(/^[a-z0-9_.]+$/).parse(req.params.key);

  await execute(
    `INSERT INTO ls_app_setting (setting_key, value, updated_by) VALUES (?, ?, ?)
     ON DUPLICATE KEY UPDATE value = VALUES(value), updated_by = VALUES(updated_by)`,
    [key, value, req.user.id],
  );
  res.json({ key, saved: true });
}));

/** Audit trail — who generated which codes, who approved which student. */
router.get('/audit', asyncHandler(async (req, res) => {
  const limit = Math.min(Number(req.query.limit) || 50, 200);
  const rows = await query(
    `SELECT a.id, a.action, a.entity_type, a.entity_id, a.detail, a.created_at,
            u.full_name AS actor_name, u.email AS actor_email
       FROM ls_audit_log a LEFT JOIN ls_user u ON u.id = a.actor_id
      ORDER BY a.id DESC LIMIT ${limit}`,
  );
  res.json({
    entries: rows.map((r) => ({
      id: r.id, action: r.action, entityType: r.entity_type, entityId: r.entity_id,
      // Stored as LONGTEXT because MariaDB's JSON is an alias for it and comes
      // back as a string either way. Parsed here so the client gets an object.
      detail: safeParse(r.detail),
      actor: r.actor_name ? { name: r.actor_name, email: r.actor_email } : null,
      createdAt: r.created_at,
    })),
  });
}));

function safeParse(v) {
  if (!v) return null;
  try { return JSON.parse(v); } catch { return v; }
}

export default router;
