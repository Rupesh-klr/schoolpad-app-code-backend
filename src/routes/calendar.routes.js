import { Router } from 'express';
import { z } from 'zod';
import { execute, one, query } from '../config/db.js';
import { ROLES } from '../config/constants.js';
import { authenticate, requireAdmin, requireActive } from '../middleware/auth.js';
import { asyncHandler } from '../middleware/error.js';

const router = Router();

/**
 * The school calendar — holidays, exams, events.
 *
 * Same three-level audience as documents (everyone / one school / one class),
 * and the same rule: the filter runs in SQL, never in the client.
 */

const EVENT_TYPES = ['holiday', 'exam', 'event', 'activity', 'deadline'];

/**
 * Which events this user may see.
 *
 * Class-scoped events match on ls_class.id, so the audience is resolved through
 * the class record rather than a loose (school, level) pair — a parent with
 * children in two schools gets both, and nothing else.
 */
async function audienceFor(user) {
  const clauses = ["e.scope = 'global'"];
  const params = [];

  let pairs = [];
  if (user.role === ROLES.STUDENT) {
    const p = await one('SELECT school_id, class_level FROM ls_student_profile WHERE user_id = ?', [user.id]);
    if (p) pairs = [p];
  } else if (user.role === ROLES.PARENT) {
    pairs = await query(
      `SELECT DISTINCT sp.school_id, sp.class_level
         FROM ls_parent_link pl
         JOIN ls_student_profile sp ON sp.user_id = pl.student_user_id
        WHERE pl.parent_user_id = ?`,
      [user.id],
    );
  }

  for (const p of pairs) {
    if (!p.school_id) continue;
    clauses.push("(e.scope = 'school' AND e.school_id = ?)");
    params.push(p.school_id);
    if (p.class_level) {
      clauses.push(
        `(e.scope = 'class' AND e.class_id IN (
            SELECT c.id FROM ls_class c WHERE c.school_id = ? AND c.class_level = ?))`,
      );
      params.push(p.school_id, p.class_level);
    }
  }

  return { sql: `(${clauses.join(' OR ')})`, params };
}

/**
 * Events overlapping a date window.
 *
 * `from`/`to` default to the current month. The overlap test uses
 * COALESCE(ends_on, starts_on) so a single-day event — where ends_on is NULL —
 * is matched by the same expression as a multi-day one.
 */
router.get('/', authenticate, requireActive, asyncHandler(async (req, res) => {
  const { from, to, type } = req.query;

  const now = new Date();
  const defFrom = new Date(now.getFullYear(), now.getMonth(), 1).toISOString().slice(0, 10);
  const defTo = new Date(now.getFullYear(), now.getMonth() + 1, 0).toISOString().slice(0, 10);

  const where = ['COALESCE(e.ends_on, e.starts_on) >= ?', 'e.starts_on <= ?'];
  const params = [from || defFrom, to || defTo];

  if (req.user.role !== ROLES.ADMIN) {
    const a = await audienceFor(req.user);
    where.push(a.sql);
    params.push(...a.params);
  } else if (req.query.schoolId) {
    where.push('(e.scope = ? OR e.school_id = ?)');
    params.push('global', req.query.schoolId);
  }

  if (type) {
    if (!EVENT_TYPES.includes(type)) throw Object.assign(new Error('Unknown event type'), { status: 400 });
    where.push('e.event_type = ?');
    params.push(type);
  }

  const rows = await query(
    `SELECT e.*, s.name AS school_name, c.class_level, c.section
       FROM ls_calendar_event e
       LEFT JOIN ls_school s ON s.id = e.school_id
       LEFT JOIN ls_class c  ON c.id = e.class_id
      WHERE ${where.join(' AND ')}
      ORDER BY e.starts_on, e.id`,
    params,
  );

  res.json({ events: rows.map(shape), from: params[0], to: params[1] });
}));

/** The next few things coming up — for a dashboard or home screen. */
router.get('/upcoming', authenticate, requireActive, asyncHandler(async (req, res) => {
  const limit = Math.min(Number(req.query.limit) || 5, 20);
  const where = ['COALESCE(e.ends_on, e.starts_on) >= CURDATE()'];
  const params = [];

  if (req.user.role !== ROLES.ADMIN) {
    const a = await audienceFor(req.user);
    where.push(a.sql);
    params.push(...a.params);
  }

  const rows = await query(
    `SELECT e.*, s.name AS school_name, c.class_level, c.section
       FROM ls_calendar_event e
       LEFT JOIN ls_school s ON s.id = e.school_id
       LEFT JOIN ls_class c  ON c.id = e.class_id
      WHERE ${where.join(' AND ')}
      ORDER BY e.starts_on
      LIMIT ${limit}`,
    params,
  );

  res.json({ events: rows.map(shape) });
}));

// ─── Admin ───────────────────────────────────────────────────────────────────

const adminOnly = [authenticate, requireAdmin];

const eventBody = z.object({
  title: z.string().min(2).max(191),
  description: z.string().max(4000).optional().nullable(),
  eventType: z.enum(EVENT_TYPES).default('event'),
  scope: z.enum(['global', 'school', 'class']).default('school'),
  schoolId: z.coerce.number().int().positive().optional().nullable(),
  classId: z.coerce.number().int().positive().optional().nullable(),
  startsOn: z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'Use YYYY-MM-DD'),
  endsOn: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional().nullable().or(z.literal('')),
});

router.post('/', adminOnly, asyncHandler(async (req, res) => {
  const body = eventBody.parse(req.body);
  const { schoolId, classId } = await resolveScope(body);

  if (body.endsOn && body.endsOn < body.startsOn) {
    throw Object.assign(new Error('The end date is before the start date'), { status: 400, code: 'BAD_RANGE' });
  }

  const r = await execute(
    `INSERT INTO ls_calendar_event
       (scope, school_id, class_id, title, description, event_type, starts_on, ends_on, created_by)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [body.scope, schoolId, classId, body.title, body.description || null,
     body.eventType, body.startsOn, body.endsOn || null, req.user.id],
  );

  res.status(201).json({ event: shape(await fetchOne(r.insertId)) });
}));

router.put('/:id', adminOnly, asyncHandler(async (req, res) => {
  const body = eventBody.partial().parse(req.body);
  const existing = await one('SELECT * FROM ls_calendar_event WHERE id = ?', [req.params.id]);
  if (!existing) throw Object.assign(new Error('Event not found'), { status: 404 });

  const map = {
    title: 'title', description: 'description', eventType: 'event_type',
    startsOn: 'starts_on', endsOn: 'ends_on',
  };
  const sets = [];
  const params = [];
  for (const [key, col] of Object.entries(map)) {
    if (body[key] !== undefined) { sets.push(`${col} = ?`); params.push(body[key] || null); }
  }

  if (body.scope !== undefined || body.schoolId !== undefined || body.classId !== undefined) {
    const merged = {
      scope: body.scope ?? existing.scope,
      schoolId: body.schoolId ?? existing.school_id,
      classId: body.classId ?? existing.class_id,
    };
    const resolved = await resolveScope(merged);
    sets.push('scope = ?', 'school_id = ?', 'class_id = ?');
    params.push(merged.scope, resolved.schoolId, resolved.classId);
  }

  if (!sets.length) throw Object.assign(new Error('Nothing to update'), { status: 400 });

  params.push(req.params.id);
  await execute(`UPDATE ls_calendar_event SET ${sets.join(', ')} WHERE id = ?`, params);
  res.json({ event: shape(await fetchOne(req.params.id)) });
}));

router.delete('/:id', adminOnly, asyncHandler(async (req, res) => {
  const r = await execute('DELETE FROM ls_calendar_event WHERE id = ?', [req.params.id]);
  if (!r.affectedRows) throw Object.assign(new Error('Event not found'), { status: 404 });
  res.json({ deleted: true });
}));

// ─── Helpers ─────────────────────────────────────────────────────────────────

/**
 * A class-scoped event stores class_id; school_id is filled in from the class
 * so the two can never disagree about which school the event belongs to.
 */
async function resolveScope(body) {
  if (body.scope === 'global') return { schoolId: null, classId: null };

  if (body.scope === 'school') {
    if (!body.schoolId) {
      throw Object.assign(new Error('Choose a school'), { status: 400, code: 'SCHOOL_REQUIRED' });
    }
    return { schoolId: body.schoolId, classId: null };
  }

  if (!body.classId) {
    throw Object.assign(new Error('Choose a class'), { status: 400, code: 'CLASS_REQUIRED' });
  }
  const cls = await one('SELECT id, school_id FROM ls_class WHERE id = ?', [body.classId]);
  if (!cls) throw Object.assign(new Error('Class not found'), { status: 404 });

  return { schoolId: cls.school_id, classId: cls.id };
}

const fetchOne = (id) => one(
  `SELECT e.*, s.name AS school_name, c.class_level, c.section
     FROM ls_calendar_event e
     LEFT JOIN ls_school s ON s.id = e.school_id
     LEFT JOIN ls_class c  ON c.id = e.class_id
    WHERE e.id = ?`,
  [id],
);

function shape(r) {
  if (!r) return null;
  return {
    id: r.id,
    title: r.title,
    description: r.description,
    eventType: r.event_type,
    scope: r.scope,
    schoolId: r.school_id,
    schoolName: r.school_name,
    classId: r.class_id,
    classLabel: r.class_level ? `Class ${r.class_level}${r.section ? `-${r.section}` : ''}` : null,
    // DATE columns come back as strings (dateStrings in the pool config), so no
    // timezone shift can move a holiday to the day before.
    startsOn: r.starts_on,
    endsOn: r.ends_on,
    createdAt: r.created_at,
  };
}

export default router;
