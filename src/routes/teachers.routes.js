import { Router } from 'express';
import { z } from 'zod';
import { execute, one, query } from '../config/db.js';
import { authenticate, requireAdmin } from '../middleware/auth.js';
import { asyncHandler } from '../middleware/error.js';

const router = Router();
router.use(authenticate, requireAdmin);

/**
 * Teacher records.
 *
 * Staff details that appear on a timetable, not accounts — see the note on
 * ls_teacher in schema.sql. Everything here is admin-only; students read
 * teacher names through the timetable, which already carries them.
 */

const teacherBody = z.object({
  schoolId: z.coerce.number().int().positive(),
  fullName: z.string().min(2).max(150),
  email: z.string().email().max(191).optional().nullable().or(z.literal('')),
  phone: z.string().max(20).optional().nullable().or(z.literal('')),
  subjects: z.string().max(500).optional().nullable(),
  status: z.enum(['active', 'inactive']).default('active'),
});

router.get('/', asyncHandler(async (req, res) => {
  const { schoolId, status, search } = req.query;
  const where = [];
  const params = [];
  if (schoolId) { where.push('t.school_id = ?'); params.push(schoolId); }
  if (status)   { where.push('t.status = ?');    params.push(status); }
  if (search)   {
    where.push('(t.full_name LIKE ? OR t.subjects LIKE ?)');
    params.push(`%${search}%`, `%${search}%`);
  }

  const rows = await query(
    `SELECT t.*, s.name AS school_name,
            (SELECT COUNT(DISTINCT sl.class_id) FROM ls_timetable_slot sl WHERE sl.teacher_id = t.id) AS class_count,
            (SELECT COUNT(*) FROM ls_timetable_slot sl WHERE sl.teacher_id = t.id) AS period_count
       FROM ls_teacher t
       JOIN ls_school s ON s.id = t.school_id
      ${where.length ? `WHERE ${where.join(' AND ')}` : ''}
      ORDER BY s.name, t.full_name`,
    params,
  );

  res.json({ teachers: rows.map(shape) });
}));

router.post('/', asyncHandler(async (req, res) => {
  const body = teacherBody.parse(req.body);

  const school = await one('SELECT id FROM ls_school WHERE id = ?', [body.schoolId]);
  if (!school) throw Object.assign(new Error('School not found'), { status: 404 });

  const r = await execute(
    `INSERT INTO ls_teacher (school_id, full_name, email, phone, subjects, status)
     VALUES (?, ?, ?, ?, ?, ?)`,
    [body.schoolId, body.fullName.trim(), body.email || null, body.phone || null,
     body.subjects || null, body.status],
  );

  res.status(201).json({ teacher: shape(await fetchOne(r.insertId)) });
}));

router.put('/:id', asyncHandler(async (req, res) => {
  const body = teacherBody.partial().parse(req.body);
  const existing = await one('SELECT id FROM ls_teacher WHERE id = ?', [req.params.id]);
  if (!existing) throw Object.assign(new Error('Teacher not found'), { status: 404 });

  const map = {
    fullName: 'full_name', email: 'email', phone: 'phone',
    subjects: 'subjects', status: 'status',
  };
  const sets = [];
  const params = [];
  for (const [key, col] of Object.entries(map)) {
    if (body[key] !== undefined) { sets.push(`${col} = ?`); params.push(body[key] || null); }
  }
  if (!sets.length) throw Object.assign(new Error('Nothing to update'), { status: 400 });

  params.push(req.params.id);
  await execute(`UPDATE ls_teacher SET ${sets.join(', ')} WHERE id = ?`, params);
  res.json({ teacher: shape(await fetchOne(req.params.id)) });
}));

/**
 * Delete a teacher.
 *
 * Their timetable slots survive with teacher_id set to NULL (ON DELETE SET
 * NULL) — the period still happens, it just has nobody assigned. Cascading
 * would silently blank periods off a class's week.
 */
router.delete('/:id', asyncHandler(async (req, res) => {
  const [{ n }] = await query(
    'SELECT COUNT(*) AS n FROM ls_timetable_slot WHERE teacher_id = ?', [req.params.id],
  );
  const r = await execute('DELETE FROM ls_teacher WHERE id = ?', [req.params.id]);
  if (!r.affectedRows) throw Object.assign(new Error('Teacher not found'), { status: 404 });

  res.json({ deleted: true, periodsUnassigned: Number(n) });
}));

const fetchOne = (id) => one(
  `SELECT t.*, s.name AS school_name FROM ls_teacher t
     JOIN ls_school s ON s.id = t.school_id WHERE t.id = ?`,
  [id],
);

function shape(r) {
  if (!r) return null;
  return {
    id: r.id,
    schoolId: r.school_id,
    schoolName: r.school_name,
    fullName: r.full_name,
    email: r.email,
    phone: r.phone,
    subjects: r.subjects,
    status: r.status,
    classCount: r.class_count !== undefined ? Number(r.class_count) : undefined,
    periodCount: r.period_count !== undefined ? Number(r.period_count) : undefined,
  };
}

export default router;
