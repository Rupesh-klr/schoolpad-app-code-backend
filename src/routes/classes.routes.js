import { Router } from 'express';
import { z } from 'zod';
import { execute, one, query, transaction } from '../config/db.js';
import { ROLES, STUDENT } from '../config/constants.js';
import { authenticate, requireAdmin, requireActive } from '../middleware/auth.js';
import { asyncHandler } from '../middleware/error.js';

const router = Router();

/**
 * Classes and their timetables.
 *
 * A class here is the thing a school runs — it has a title, a description, a
 * dress code, a plan of action and a weekly schedule. Which class a *student*
 * is in remains ls_student_profile's job; these two are matched on
 * (school_id, class_level), so a class record can exist before anyone enrols
 * and a student is never blocked by a missing one.
 */

const WEEKDAYS = ['', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday', 'Sunday'];

// ─── Member views ────────────────────────────────────────────────────────────

/**
 * The signed-in member's own class (or, for a parent, each child's).
 *
 * Everything a student or parent is allowed to see about a class is here in one
 * response: the details, the class teacher, and the full week's timetable.
 * Splitting it would mean three round trips to render one screen.
 */
router.get('/mine', authenticate, requireActive, asyncHandler(async (req, res) => {
  let targets = [];

  if (req.user.role === ROLES.STUDENT) {
    const p = await one(
      'SELECT school_id, class_level, section FROM ls_student_profile WHERE user_id = ?',
      [req.user.id],
    );
    if (p?.school_id && p.class_level) {
      targets = [{ schoolId: p.school_id, classLevel: p.class_level, section: p.section, who: null }];
    }
  } else if (req.user.role === ROLES.PARENT) {
    const rows = await query(
      `SELECT u.id, u.full_name, sp.school_id, sp.class_level, sp.section
         FROM ls_parent_link pl
         JOIN ls_user u              ON u.id = pl.student_user_id
         JOIN ls_student_profile sp  ON sp.user_id = u.id
        WHERE pl.parent_user_id = ?`,
      [req.user.id],
    );
    targets = rows
      .filter((r) => r.school_id && r.class_level)
      .map((r) => ({
        schoolId: r.school_id, classLevel: r.class_level, section: r.section,
        who: { id: r.id, fullName: r.full_name },
      }));
  }

  const classes = [];
  for (const t of targets) {
    // Prefer the exact section, fall back to the school's class with no section
    // set — a school that has not bothered with sections still has one class 6,
    // and a student marked "6-A" should not see an empty screen because of it.
    const row = await one(
      `SELECT c.*, s.name AS school_name, te.full_name AS teacher_name, te.email AS teacher_email
         FROM ls_class c
         JOIN ls_school s        ON s.id = c.school_id
         LEFT JOIN ls_teacher te ON te.id = c.class_teacher_id
        WHERE c.school_id = ? AND c.class_level = ? AND c.status = 'active'
        ORDER BY (c.section = ?) DESC, c.section
        LIMIT 1`,
      [t.schoolId, t.classLevel, t.section || ''],
    );
    if (!row) continue;

    classes.push({
      ...shapeClass(row),
      child: t.who,
      timetable: groupTimetable(await timetableRows(row.id)),
    });
  }

  res.json({ classes });
}));

// ─── Admin ───────────────────────────────────────────────────────────────────

const adminOnly = [authenticate, requireAdmin];

router.get('/', adminOnly, asyncHandler(async (req, res) => {
  const { schoolId, classLevel } = req.query;
  const where = [];
  const params = [];
  if (schoolId)   { where.push('c.school_id = ?');   params.push(schoolId); }
  if (classLevel) { where.push('c.class_level = ?'); params.push(classLevel); }

  const rows = await query(
    `SELECT c.*, s.name AS school_name, te.full_name AS teacher_name,
            (SELECT COUNT(*) FROM ls_student_profile sp
              WHERE sp.school_id = c.school_id AND sp.class_level = c.class_level) AS student_count,
            (SELECT COUNT(*) FROM ls_timetable_slot t WHERE t.class_id = c.id) AS slot_count
       FROM ls_class c
       JOIN ls_school s        ON s.id = c.school_id
       LEFT JOIN ls_teacher te ON te.id = c.class_teacher_id
      ${where.length ? `WHERE ${where.join(' AND ')}` : ''}
      ORDER BY s.name, c.class_level, c.section`,
    params,
  );

  res.json({ classes: rows.map(shapeClass) });
}));

router.get('/:id', adminOnly, asyncHandler(async (req, res) => {
  const row = await one(
    `SELECT c.*, s.name AS school_name, te.full_name AS teacher_name, te.email AS teacher_email
       FROM ls_class c
       JOIN ls_school s        ON s.id = c.school_id
       LEFT JOIN ls_teacher te ON te.id = c.class_teacher_id
      WHERE c.id = ?`,
    [req.params.id],
  );
  if (!row) throw Object.assign(new Error('Class not found'), { status: 404 });

  const students = await query(
    `SELECT u.id, u.full_name, u.status
       FROM ls_student_profile sp
       JOIN ls_user u ON u.id = sp.user_id
      WHERE sp.school_id = ? AND sp.class_level = ?
      ORDER BY u.full_name`,
    [row.school_id, row.class_level],
  );

  res.json({
    class: shapeClass(row),
    timetable: groupTimetable(await timetableRows(row.id)),
    students: students.map((s) => ({ id: s.id, fullName: s.full_name, status: s.status })),
  });
}));

const classBody = z.object({
  schoolId: z.coerce.number().int().positive(),
  classLevel: z.coerce.number().int().min(STUDENT.MIN_CLASS).max(STUDENT.MAX_CLASS),
  section: z.string().max(16).optional().nullable(),
  title: z.string().max(191).optional().nullable(),
  description: z.string().max(4000).optional().nullable(),
  dressCode: z.string().max(2000).optional().nullable(),
  planOfAction: z.string().max(8000).optional().nullable(),
  notes: z.string().max(8000).optional().nullable(),
  classTeacherId: z.coerce.number().int().positive().optional().nullable(),
  room: z.string().max(64).optional().nullable(),
  status: z.enum(['active', 'inactive']).default('active'),
});

router.post('/', adminOnly, asyncHandler(async (req, res) => {
  const body = classBody.parse(req.body);
  await assertTeacherBelongs(body.classTeacherId, body.schoolId);

  try {
    const r = await execute(
      `INSERT INTO ls_class
         (school_id, class_level, section, title, description, dress_code,
          plan_of_action, notes, class_teacher_id, room, status, created_by)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [body.schoolId, body.classLevel, body.section || '', body.title || null,
       body.description || null, body.dressCode || null, body.planOfAction || null,
       body.notes || null, body.classTeacherId || null, body.room || null,
       body.status, req.user.id],
    );
    res.status(201).json({ class: shapeClass(await fetchClass(r.insertId)) });
  } catch (err) {
    if (err.code === 'ER_DUP_ENTRY') {
      throw Object.assign(
        new Error(`Class ${body.classLevel}${body.section ? `-${body.section}` : ''} already exists at this school`),
        { status: 409, code: 'CLASS_EXISTS' },
      );
    }
    throw err;
  }
}));

router.put('/:id', adminOnly, asyncHandler(async (req, res) => {
  const body = classBody.partial().parse(req.body);
  const existing = await one('SELECT * FROM ls_class WHERE id = ?', [req.params.id]);
  if (!existing) throw Object.assign(new Error('Class not found'), { status: 404 });

  if (body.classTeacherId !== undefined) {
    await assertTeacherBelongs(body.classTeacherId, existing.school_id);
  }

  const map = {
    title: 'title', description: 'description', dressCode: 'dress_code',
    planOfAction: 'plan_of_action', notes: 'notes', classTeacherId: 'class_teacher_id',
    room: 'room', status: 'status', section: 'section',
  };
  const sets = [];
  const params = [];
  for (const [key, col] of Object.entries(map)) {
    if (body[key] !== undefined) {
      sets.push(`${col} = ?`);
      // section is NOT NULL with a '' default — the UNIQUE index depends on it.
      params.push(key === 'section' ? (body[key] || '') : body[key]);
    }
  }
  if (!sets.length) throw Object.assign(new Error('Nothing to update'), { status: 400 });

  params.push(req.params.id);
  await execute(`UPDATE ls_class SET ${sets.join(', ')} WHERE id = ?`, params);

  res.json({ class: shapeClass(await fetchClass(req.params.id)) });
}));

router.delete('/:id', adminOnly, asyncHandler(async (req, res) => {
  const r = await execute('DELETE FROM ls_class WHERE id = ?', [req.params.id]);
  if (!r.affectedRows) throw Object.assign(new Error('Class not found'), { status: 404 });
  // Students are untouched — their class lives on ls_student_profile, and
  // deleting a class record must not silently unenrol a room full of children.
  res.json({ deleted: true });
}));

// ─── Timetable ───────────────────────────────────────────────────────────────

router.get('/:id/timetable', authenticate, requireActive, asyncHandler(async (req, res) => {
  const cls = await one('SELECT id, school_id, class_level FROM ls_class WHERE id = ?', [req.params.id]);
  if (!cls) throw Object.assign(new Error('Class not found'), { status: 404 });

  // A student may only read their own class's timetable.
  if (req.user.role === ROLES.STUDENT) {
    const p = await one('SELECT school_id, class_level FROM ls_student_profile WHERE user_id = ?', [req.user.id]);
    if (p?.school_id !== cls.school_id || p?.class_level !== cls.class_level) {
      throw Object.assign(new Error('Not your class'), { status: 403, code: 'WRONG_CLASS' });
    }
  }

  res.json({ timetable: groupTimetable(await timetableRows(cls.id)) });
}));

/**
 * Replace the whole week in one call.
 *
 * The editor is a grid, and saving it slot by slot would leave the timetable
 * half-applied if the network dropped mid-save. One transaction, one atomic
 * result: the week is either the old one or the new one.
 */
router.put('/:id/timetable', adminOnly, asyncHandler(async (req, res) => {
  const body = z.object({
    slots: z.array(z.object({
      weekday: z.coerce.number().int().min(1).max(7),
      periodNo: z.coerce.number().int().min(1).max(20),
      subject: z.string().max(120).default(''),
      startTime: z.string().regex(/^\d{2}:\d{2}(:\d{2})?$/).optional().nullable().or(z.literal('')),
      endTime: z.string().regex(/^\d{2}:\d{2}(:\d{2})?$/).optional().nullable().or(z.literal('')),
      teacherId: z.coerce.number().int().positive().optional().nullable(),
      room: z.string().max(64).optional().nullable(),
      isBreak: z.boolean().default(false),
    })).max(200),
  }).parse(req.body);

  const cls = await one('SELECT id, school_id FROM ls_class WHERE id = ?', [req.params.id]);
  if (!cls) throw Object.assign(new Error('Class not found'), { status: 404 });

  // An empty subject means "this period is free" — drop it rather than storing
  // a blank row the grid then has to filter out on every read.
  const keep = body.slots.filter((s) => s.isBreak || s.subject.trim());

  for (const s of keep) {
    if (s.teacherId) await assertTeacherBelongs(s.teacherId, cls.school_id);
  }

  await transaction(async (conn) => {
    await conn.execute('DELETE FROM ls_timetable_slot WHERE class_id = ?', [req.params.id]);
    for (const s of keep) {
      await conn.execute(
        `INSERT INTO ls_timetable_slot
           (class_id, weekday, period_no, start_time, end_time, subject, teacher_id, room, is_break)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        [req.params.id, s.weekday, s.periodNo, s.startTime || null, s.endTime || null,
         s.isBreak ? (s.subject.trim() || 'Break') : s.subject.trim(),
         s.teacherId || null, s.room || null, s.isBreak ? 1 : 0],
      );
    }
  });

  await execute(
    `INSERT INTO ls_audit_log (actor_id, action, entity_type, entity_id, detail)
     VALUES (?, 'class.timetable_save', 'ls_class', ?, ?)`,
    [req.user.id, String(req.params.id), JSON.stringify({ slots: keep.length })],
  );

  res.json({ saved: keep.length, timetable: groupTimetable(await timetableRows(req.params.id)) });
}));

// ─── Helpers ─────────────────────────────────────────────────────────────────

/** A teacher from another school on this timetable is always a mistake. */
async function assertTeacherBelongs(teacherId, schoolId) {
  if (!teacherId) return;
  const t = await one('SELECT school_id FROM ls_teacher WHERE id = ?', [teacherId]);
  if (!t) throw Object.assign(new Error('Teacher not found'), { status: 404 });
  if (Number(t.school_id) !== Number(schoolId)) {
    throw Object.assign(
      new Error('That teacher belongs to a different school'),
      { status: 400, code: 'TEACHER_WRONG_SCHOOL' },
    );
  }
}

const fetchClass = (id) => one(
  `SELECT c.*, s.name AS school_name, te.full_name AS teacher_name, te.email AS teacher_email
     FROM ls_class c
     JOIN ls_school s        ON s.id = c.school_id
     LEFT JOIN ls_teacher te ON te.id = c.class_teacher_id
    WHERE c.id = ?`,
  [id],
);

const timetableRows = (classId) => query(
  `SELECT t.*, te.full_name AS teacher_name
     FROM ls_timetable_slot t
     LEFT JOIN ls_teacher te ON te.id = t.teacher_id
    WHERE t.class_id = ?
    ORDER BY t.weekday, t.period_no`,
  [classId],
);

/**
 * Flat slots → one entry per weekday.
 *
 * Every weekday is present even when empty, so the grid renders a consistent
 * seven columns instead of collapsing the days nobody has filled in yet.
 */
function groupTimetable(rows) {
  const byDay = new Map(
    Array.from({ length: 7 }, (_, i) => [i + 1, { weekday: i + 1, dayName: WEEKDAYS[i + 1], periods: [] }]),
  );

  for (const r of rows) {
    byDay.get(r.weekday)?.periods.push({
      id: r.id,
      periodNo: r.period_no,
      subject: r.subject,
      // TIME comes back as "09:00:00"; the UI wants "09:00".
      startTime: r.start_time ? String(r.start_time).slice(0, 5) : null,
      endTime: r.end_time ? String(r.end_time).slice(0, 5) : null,
      teacherId: r.teacher_id,
      teacherName: r.teacher_name,
      room: r.room,
      isBreak: !!r.is_break,
    });
  }

  return [...byDay.values()];
}

function shapeClass(r) {
  if (!r) return null;
  return {
    id: r.id,
    schoolId: r.school_id,
    schoolName: r.school_name,
    classLevel: r.class_level,
    section: r.section || null,
    label: `Class ${r.class_level}${r.section ? `-${r.section}` : ''}`,
    title: r.title,
    description: r.description,
    dressCode: r.dress_code,
    planOfAction: r.plan_of_action,
    notes: r.notes,
    classTeacherId: r.class_teacher_id,
    teacherName: r.teacher_name,
    teacherEmail: r.teacher_email,
    room: r.room,
    status: r.status,
    studentCount: r.student_count !== undefined ? Number(r.student_count) : undefined,
    slotCount: r.slot_count !== undefined ? Number(r.slot_count) : undefined,
    createdAt: r.created_at,
  };
}

export default router;
