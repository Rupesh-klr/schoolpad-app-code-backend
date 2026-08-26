import { Router } from 'express';
import { z } from 'zod';
import { execute, one, query } from '../config/db.js';
import { PAGINATION, ROLES, USER_STATUS } from '../config/constants.js';
import { authenticate, requireAdmin } from '../middleware/auth.js';
import { revokeAllForUser } from '../services/tokens.js';
import { asyncHandler } from '../middleware/error.js';

const router = Router();
router.use(authenticate, requireAdmin);

/**
 * Student administration.
 *
 * Section 2.3 of the spec, in one place: list, search, filter by school and
 * class, open one, activate or deactivate, and see the code they used.
 */

const JOINS = `
       FROM ls_user u
       LEFT JOIN ls_student_profile sp ON sp.user_id = u.id
       LEFT JOIN ls_school s           ON s.id = sp.school_id
       LEFT JOIN ls_access_code ac     ON ac.id = sp.access_code_id`;

/**
 * List students, with the facets the admin screen needs to build its filters.
 *
 * `search` covers the student and the school by name, so typing "Greenwood"
 * finds that school's students without first selecting it from the dropdown —
 * an admin who knows the school name should not have to know it is a filter.
 *
 * The response also carries `classes`: which class levels exist under the
 * current school/search/status filters, with a count each. That is what lets
 * the UI show real class options for the selected school instead of a
 * hardcoded 2–10, and it supplies the counts on each collapsible header.
 */
router.get('/', asyncHandler(async (req, res) => {
  const { search = '', schoolId, classLevel, status, limit, offset } = req.query;
  const lim = Math.min(Number(limit) || PAGINATION.DEFAULT_LIMIT, PAGINATION.MAX_LIMIT);
  const off = Number(offset) || 0;

  // Built in two halves. The class facet reuses `base` but deliberately omits
  // the class filter — including it would leave the picker showing only the
  // class already chosen, with no way back to the others.
  const base = ['u.role = ?'];
  const baseParams = [ROLES.STUDENT];

  if (search) {
    base.push('(u.full_name LIKE ? OR u.email LIKE ? OR u.phone LIKE ? OR ac.code LIKE ? OR s.name LIKE ?)');
    const like = `%${search}%`;
    baseParams.push(like, like, like, like, like);
  }
  if (schoolId) { base.push('sp.school_id = ?'); baseParams.push(schoolId); }
  if (status)   { base.push('u.status = ?');     baseParams.push(status); }

  const where = [...base];
  const params = [...baseParams];
  if (classLevel) { where.push('sp.class_level = ?'); params.push(classLevel); }

  const filtered = `${JOINS} WHERE ${where.join(' AND ')}`;

  const rows = await query(
    `SELECT u.id, u.full_name, u.email, u.phone, u.status, u.created_at, u.last_login_at,
            sp.class_level, sp.section, sp.school_id, s.name AS school_name, ac.code AS access_code
       ${filtered}
      -- Class first so the grouped view arrives already ordered, and students
      -- with no class yet sort to the end rather than leading the list.
      ORDER BY sp.class_level IS NULL, sp.class_level, u.full_name
      LIMIT ${lim} OFFSET ${off}`,
    params,
  );

  const [{ total }] = await query(`SELECT COUNT(*) AS total ${filtered}`, params);

  const classRows = await query(
    `SELECT sp.class_level, COUNT(*) AS n
       ${JOINS} WHERE ${base.join(' AND ')}
      GROUP BY sp.class_level
      ORDER BY sp.class_level IS NULL, sp.class_level`,
    baseParams,
  );

  res.json({
    students: rows.map(shape),
    total: Number(total),
    limit: lim,
    offset: off,
    classes: classRows.map((r) => ({
      classLevel: r.class_level,
      count: Number(r.n),
    })),
  });
}));

router.get('/:id', asyncHandler(async (req, res) => {
  const row = await one(
    `SELECT u.id, u.full_name, u.email, u.phone, u.status, u.created_at, u.last_login_at,
            u.activated_at, sp.class_level, sp.section, sp.school_id,
            s.name AS school_name, ac.code AS access_code, ac.used_at AS code_used_at
       FROM ls_user u
       LEFT JOIN ls_student_profile sp ON sp.user_id = u.id
       LEFT JOIN ls_school s           ON s.id = sp.school_id
       LEFT JOIN ls_access_code ac     ON ac.id = sp.access_code_id
      WHERE u.id = ? AND u.role = ?`,
    [req.params.id, ROLES.STUDENT],
  );
  if (!row) throw Object.assign(new Error('Student not found'), { status: 404 });

  const guardians = await query(
    `SELECT u.id, u.full_name, u.email, u.phone, pl.relation
       FROM ls_parent_link pl JOIN ls_user u ON u.id = pl.parent_user_id
      WHERE pl.student_user_id = ?`,
    [req.params.id],
  );

  const [progress] = await query(
    `SELECT COUNT(*) AS items_started, SUM(status = 'completed') AS items_completed
       FROM ls_content_progress WHERE user_id = ?`,
    [req.params.id],
  );

  res.json({
    student: { ...shape(row), activatedAt: row.activated_at, codeUsedAt: row.code_used_at },
    guardians: guardians.map((g) => ({
      id: g.id, fullName: g.full_name, email: g.email, phone: g.phone, relation: g.relation,
    })),
    progress: {
      itemsStarted: Number(progress.items_started || 0),
      itemsCompleted: Number(progress.items_completed || 0),
    },
  });
}));

/**
 * Approve a pending student, or deactivate an active one.
 *
 * This is the "wait for admin approval" branch of the spec. Deactivating also
 * revokes refresh tokens — otherwise the account keeps working on the device
 * that is already signed in until the token expires, which is not what anybody
 * means by "deactivate".
 */
router.patch('/:id/status', asyncHandler(async (req, res) => {
  const { status } = z.object({
    status: z.enum([USER_STATUS.ACTIVE, USER_STATUS.INACTIVE, USER_STATUS.PENDING]),
  }).parse(req.body);

  const student = await one('SELECT id, status FROM ls_user WHERE id = ? AND role = ?', [req.params.id, ROLES.STUDENT]);
  if (!student) throw Object.assign(new Error('Student not found'), { status: 404 });

  await execute(
    `UPDATE ls_user
        SET status = ?,
            activated_at = ${status === USER_STATUS.ACTIVE ? 'COALESCE(activated_at, NOW())' : 'activated_at'},
            activated_by = ?
      WHERE id = ?`,
    [status, req.user.id, req.params.id],
  );

  let revoked = 0;
  if (status === USER_STATUS.INACTIVE) revoked = await revokeAllForUser(req.params.id);

  await execute(
    `INSERT INTO ls_audit_log (actor_id, action, entity_type, entity_id, detail)
     VALUES (?, ?, 'app_user', ?, ?)`,
    [req.user.id, `student.${status}`, String(req.params.id), JSON.stringify({ from: student.status })],
  );

  res.json({ id: Number(req.params.id), status, sessionsRevoked: revoked });
}));

/** Correct a student's ls_school, class or section after registration. */
router.put('/:id/profile', asyncHandler(async (req, res) => {
  const body = z.object({
    schoolId: z.coerce.number().int().positive().nullable().optional(),
    classLevel: z.coerce.number().int().min(1).max(12).nullable().optional(),
    section: z.string().max(16).nullable().optional(),
    fullName: z.string().min(2).max(150).optional(),
  }).parse(req.body);

  if (body.fullName) {
    await execute('UPDATE ls_user SET full_name = ? WHERE id = ? AND role = ?', [body.fullName, req.params.id, ROLES.STUDENT]);
  }

  const map = { schoolId: 'school_id', classLevel: 'class_level', section: 'section' };
  const sets = [];
  const params = [];
  for (const [key, column] of Object.entries(map)) {
    if (body[key] !== undefined) { sets.push(`${column} = ?`); params.push(body[key]); }
  }
  if (sets.length) {
    params.push(req.params.id);
    await execute(`UPDATE ls_student_profile SET ${sets.join(', ')} WHERE user_id = ?`, params);
  }

  await execute(
    `INSERT INTO ls_audit_log (actor_id, action, entity_type, entity_id, detail)
     VALUES (?, 'student.profile_update', 'app_user', ?, ?)`,
    [req.user.id, String(req.params.id), JSON.stringify(body)],
  );

  res.json({ updated: true });
}));

function shape(r) {
  return {
    id: r.id,
    fullName: r.full_name,
    email: r.email,
    phone: r.phone,
    status: r.status,
    classLevel: r.class_level,
    section: r.section,
    schoolId: r.school_id,
    schoolName: r.school_name,
    accessCode: r.ls_access_code,
    registeredAt: r.created_at,
    lastLoginAt: r.last_login_at,
  };
}

export default router;
