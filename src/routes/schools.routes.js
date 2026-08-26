import { Router } from 'express';
import { z } from 'zod';
import { execute, one, query } from '../config/db.js';
import { PAGINATION } from '../config/constants.js';
import { authenticate, requireAdmin } from '../middleware/auth.js';
import { asyncHandler } from '../middleware/error.js';

const router = Router();

// Every route here is admin-only, so the gate is applied once for the router
// rather than repeated per route — one place to be wrong instead of six.
router.use(authenticate, requireAdmin);

const schoolBody = z.object({
  name: z.string().min(2).max(191),
  code: z.string().min(2).max(32).regex(/^[A-Za-z0-9_-]+$/, 'Use letters, numbers, dash or underscore'),
  address: z.string().max(1000).optional().nullable(),
  contactPerson: z.string().max(150).optional().nullable(),
  phone: z.string().max(20).optional().nullable(),
  email: z.string().email().max(191).optional().nullable().or(z.literal('')),
  status: z.enum(['active', 'inactive']).default('active'),
});

router.get('/', asyncHandler(async (req, res) => {
  const { search = '', status, limit, offset } = req.query;
  const lim = Math.min(Number(limit) || PAGINATION.DEFAULT_LIMIT, PAGINATION.MAX_LIMIT);
  const off = Number(offset) || 0;

  const where = [];
  const params = [];
  if (search) {
    where.push('(s.name LIKE ? OR s.code LIKE ? OR s.contact_person LIKE ?)');
    params.push(`%${search}%`, `%${search}%`, `%${search}%`);
  }
  if (status) { where.push('s.status = ?'); params.push(status); }
  const clause = where.length ? `WHERE ${where.join(' AND ')}` : '';

  // Counts come from correlated subqueries rather than GROUP BY joins: joining
  // students and codes in one query multiplies the rows together and every
  // count comes back inflated by the other table's cardinality.
  const rows = await query(
    `SELECT s.*,
            (SELECT COUNT(*) FROM student_profile sp WHERE sp.school_id = s.id) AS student_count,
            (SELECT COUNT(*) FROM access_code ac WHERE ac.school_id = s.id) AS code_count,
            (SELECT COUNT(*) FROM access_code ac WHERE ac.school_id = s.id AND ac.status = 'used') AS code_used
       FROM school s
       ${clause}
      ORDER BY s.name
      LIMIT ${lim} OFFSET ${off}`,
    params,
  );

  const [{ total }] = await query(`SELECT COUNT(*) AS total FROM school s ${clause}`, params);

  res.json({ schools: rows.map(shape), total: Number(total), limit: lim, offset: off });
}));

router.get('/:id', asyncHandler(async (req, res) => {
  const school = await one('SELECT * FROM school WHERE id = ?', [req.params.id]);
  if (!school) throw Object.assign(new Error('School not found'), { status: 404 });

  const students = await query(
    `SELECT u.id, u.full_name, u.status, u.created_at, u.last_login_at,
            sp.class_level, sp.section, ac.code AS access_code
       FROM student_profile sp
       JOIN app_user u        ON u.id = sp.user_id
       LEFT JOIN access_code ac ON ac.id = sp.access_code_id
      WHERE sp.school_id = ?
      ORDER BY sp.class_level, u.full_name
      LIMIT 500`,
    [req.params.id],
  );

  const [codes] = await query(
    `SELECT COUNT(*) AS total,
            SUM(status = 'used')   AS used,
            SUM(status = 'unused') AS unused
       FROM access_code WHERE school_id = ?`,
    [req.params.id],
  );

  res.json({
    school: shape(school),
    students: students.map((s) => ({
      id: s.id, fullName: s.full_name, status: s.status,
      classLevel: s.class_level, section: s.section, accessCode: s.access_code,
      registeredAt: s.created_at, lastLoginAt: s.last_login_at,
    })),
    codes: { total: Number(codes.total), used: Number(codes.used || 0), unused: Number(codes.unused || 0) },
  });
}));

router.post('/', asyncHandler(async (req, res) => {
  const body = schoolBody.parse(req.body);
  const result = await execute(
    `INSERT INTO school (name, code, address, contact_person, phone, email, status)
     VALUES (?, ?, ?, ?, ?, ?, ?)`,
    [body.name, body.code, body.address || null, body.contactPerson || null,
     body.phone || null, body.email || null, body.status],
  );
  await audit(req.user.id, 'school.create', result.insertId, body.name);
  res.status(201).json({ school: shape(await one('SELECT * FROM school WHERE id = ?', [result.insertId])) });
}));

router.put('/:id', asyncHandler(async (req, res) => {
  const body = schoolBody.partial().parse(req.body);
  const existing = await one('SELECT id FROM school WHERE id = ?', [req.params.id]);
  if (!existing) throw Object.assign(new Error('School not found'), { status: 404 });

  const map = {
    name: 'name', code: 'code', address: 'address',
    contactPerson: 'contact_person', phone: 'phone', email: 'email', status: 'status',
  };
  const sets = [];
  const params = [];
  for (const [key, column] of Object.entries(map)) {
    if (body[key] !== undefined) { sets.push(`${column} = ?`); params.push(body[key] || null); }
  }
  if (!sets.length) throw Object.assign(new Error('Nothing to update'), { status: 400 });

  params.push(req.params.id);
  await execute(`UPDATE school SET ${sets.join(', ')} WHERE id = ?`, params);
  await audit(req.user.id, 'school.update', req.params.id, JSON.stringify(body));

  res.json({ school: shape(await one('SELECT * FROM school WHERE id = ?', [req.params.id])) });
}));

/**
 * Deactivating a school does not touch its students.
 *
 * Cascading would silently lock out a whole school's children over what is
 * usually an administrative pause. Deactivate the students explicitly if that
 * is really what is meant.
 */
router.patch('/:id/status', asyncHandler(async (req, res) => {
  const { status } = z.object({ status: z.enum(['active', 'inactive']) }).parse(req.body);
  const result = await execute('UPDATE school SET status = ? WHERE id = ?', [status, req.params.id]);
  if (!result.affectedRows) throw Object.assign(new Error('School not found'), { status: 404 });
  await audit(req.user.id, `school.${status}`, req.params.id, null);
  res.json({ id: Number(req.params.id), status });
}));

function shape(r) {
  if (!r) return null;
  return {
    id: r.id, name: r.name, code: r.code, address: r.address,
    contactPerson: r.contact_person, phone: r.phone, email: r.email, status: r.status,
    studentCount: r.student_count !== undefined ? Number(r.student_count) : undefined,
    codeCount: r.code_count !== undefined ? Number(r.code_count) : undefined,
    codeUsed: r.code_used !== undefined ? Number(r.code_used) : undefined,
    createdAt: r.created_at, updatedAt: r.updated_at,
  };
}

async function audit(actorId, action, entityId, detail) {
  await execute(
    `INSERT INTO audit_log (actor_id, action, entity_type, entity_id, detail)
     VALUES (?, ?, 'school', ?, ?)`,
    [actorId, action, String(entityId), detail],
  );
}

export default router;
