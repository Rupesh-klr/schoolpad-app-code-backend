import { Router } from 'express';
import { z } from 'zod';
import { execute, one, query } from '../config/db.js';
import { PAGINATION, ROLES, STUDENT } from '../config/constants.js';
import { authenticate, requireAdmin, requireActive } from '../middleware/auth.js';
import { upload, mediaUrl, removeStoredFile } from '../services/upload.js';
import { asyncHandler } from '../middleware/error.js';

const router = Router();

/**
 * Documents and notices.
 *
 * An admin publishes either an uploaded file or a link, aimed at everyone, one
 * school, or one class within a school. Students and parents see what is aimed
 * at them and nothing else — the audience filter runs in SQL, so a client bug
 * cannot widen it.
 */

const CATEGORIES = ['gk', 'notice', 'important', 'homework', 'general'];

// ─── Audience ────────────────────────────────────────────────────────────────

/**
 * The SQL that decides what one user may see.
 *
 * A student matches on their own school and class. A parent matches on the
 * union of their children's — a parent with a child in class 6 at Greenwood and
 * one in class 9 at St. Xavier sees both class feeds, and nothing from class 7.
 *
 * Returns `null` when the user has no audience at all, which the caller turns
 * into an empty feed rather than an unfiltered one. Getting that backwards
 * would show every notice in the system to a student with no school set.
 */
async function audienceFor(user) {
  let pairs = [];

  if (user.role === ROLES.STUDENT) {
    const p = await one(
      'SELECT school_id, class_level FROM ls_student_profile WHERE user_id = ?',
      [user.id],
    );
    if (p) pairs = [{ schoolId: p.school_id, classLevel: p.class_level }];
  } else if (user.role === ROLES.PARENT) {
    const rows = await query(
      `SELECT DISTINCT sp.school_id, sp.class_level
         FROM ls_parent_link pl
         JOIN ls_student_profile sp ON sp.user_id = pl.student_user_id
        WHERE pl.parent_user_id = ?`,
      [user.id],
    );
    pairs = rows.map((r) => ({ schoolId: r.school_id, classLevel: r.class_level }));
  }

  // Global notices reach everyone, including a student whose school is not set
  // yet — that is the whole point of a global notice.
  const clauses = ["d.scope = 'global'"];
  const params = [];

  for (const { schoolId, classLevel } of pairs) {
    if (!schoolId) continue;
    clauses.push("(d.scope = 'school' AND d.school_id = ?)");
    params.push(schoolId);
    if (classLevel) {
      clauses.push("(d.scope = 'class' AND d.school_id = ? AND d.class_level = ?)");
      params.push(schoolId, classLevel);
    }
  }

  return { sql: `(${clauses.join(' OR ')})`, params };
}

// ─── Member feed ─────────────────────────────────────────────────────────────

/**
 * What this user should see, newest first, with read state.
 *
 * Admins get everything published, so they can check what a notice looks like
 * without impersonating a student.
 */
router.get('/feed', authenticate, requireActive, asyncHandler(async (req, res) => {
  const { category, unreadOnly, limit, offset } = req.query;
  const lim = Math.min(Number(limit) || PAGINATION.DEFAULT_LIMIT, PAGINATION.MAX_LIMIT);
  const off = Number(offset) || 0;

  const where = ["d.status = 'published'"];
  const params = [req.user.id];   // the LEFT JOIN's read-state parameter comes first

  if (req.user.role !== ROLES.ADMIN) {
    const audience = await audienceFor(req.user);
    where.push(audience.sql);
    params.push(...audience.params);
  }

  if (category) {
    if (!CATEGORIES.includes(category)) {
      throw Object.assign(new Error('Unknown category'), { status: 400 });
    }
    where.push('d.category = ?');
    params.push(category);
  }
  if (unreadOnly === 'true') where.push('r.id IS NULL');

  const from = `
       FROM ls_document d
       LEFT JOIN ls_document_read r ON r.document_id = d.id AND r.user_id = ?
       LEFT JOIN ls_school s        ON s.id = d.school_id
      WHERE ${where.join(' AND ')}`;

  const rows = await query(
    `SELECT d.*, s.name AS school_name, r.read_at
       ${from}
      ORDER BY d.published_at DESC, d.id DESC
      LIMIT ${lim} OFFSET ${off}`,
    params,
  );

  const [{ total }] = await query(`SELECT COUNT(*) AS total ${from}`, params);

  res.json({ documents: rows.map(shape), total: Number(total), limit: lim, offset: off });
}));

/** Badge count. Only `notify` documents count — a reference PDF should not buzz. */
router.get('/unread-count', authenticate, requireActive, asyncHandler(async (req, res) => {
  if (req.user.role === ROLES.ADMIN) return res.json({ unread: 0 });

  const audience = await audienceFor(req.user);
  const [{ n }] = await query(
    `SELECT COUNT(*) AS n
       FROM ls_document d
       LEFT JOIN ls_document_read r ON r.document_id = d.id AND r.user_id = ?
      WHERE d.status = 'published' AND d.notify = 1 AND r.id IS NULL AND ${audience.sql}`,
    [req.user.id, ...audience.params],
  );
  res.json({ unread: Number(n) });
}));

router.post('/:id/read', authenticate, requireActive, asyncHandler(async (req, res) => {
  // Re-check the audience: without it, any member could mark — and therefore
  // confirm the existence of — a document aimed at another school.
  const audience = await audienceFor(req.user);
  const doc = await one(
    `SELECT d.id FROM ls_document d
      WHERE d.id = ? AND d.status = 'published' AND ${audience.sql}`,
    [req.params.id, ...audience.params],
  );
  if (!doc) throw Object.assign(new Error('Not found'), { status: 404 });

  await execute(
    `INSERT INTO ls_document_read (document_id, user_id) VALUES (?, ?)
     ON DUPLICATE KEY UPDATE read_at = read_at`,
    [req.params.id, req.user.id],
  );
  res.json({ read: true });
}));

// ─── Admin ───────────────────────────────────────────────────────────────────

const adminOnly = [authenticate, requireAdmin];

router.get('/', adminOnly, asyncHandler(async (req, res) => {
  const { scope, category, status, schoolId, limit, offset } = req.query;
  const lim = Math.min(Number(limit) || PAGINATION.DEFAULT_LIMIT, PAGINATION.MAX_LIMIT);
  const off = Number(offset) || 0;

  const where = [];
  const params = [];
  if (scope)    { where.push('d.scope = ?');     params.push(scope); }
  if (category) { where.push('d.category = ?');  params.push(category); }
  if (status)   { where.push('d.status = ?');    params.push(status); }
  if (schoolId) { where.push('d.school_id = ?'); params.push(schoolId); }

  const from = `
       FROM ls_document d
       LEFT JOIN ls_school s ON s.id = d.school_id
      ${where.length ? `WHERE ${where.join(' AND ')}` : ''}`;

  const rows = await query(
    `SELECT d.*, s.name AS school_name,
            (SELECT COUNT(*) FROM ls_document_read r WHERE r.document_id = d.id) AS read_count
       ${from}
      ORDER BY d.created_at DESC
      LIMIT ${lim} OFFSET ${off}`,
    params,
  );
  const [{ total }] = await query(`SELECT COUNT(*) AS total ${from}`, params);

  res.json({ documents: rows.map(shape), total: Number(total), limit: lim, offset: off });
}));

const bodySchema = z.object({
  title: z.string().min(2).max(191),
  description: z.string().max(4000).optional().nullable(),
  category: z.enum(CATEGORIES).default('general'),
  url: z.string().url().optional().nullable().or(z.literal('')),
  scope: z.enum(['global', 'school', 'class']).default('global'),
  schoolId: z.coerce.number().int().positive().optional().nullable(),
  classLevel: z.coerce.number().int().min(STUDENT.MIN_CLASS).max(STUDENT.MAX_CLASS).optional().nullable(),
  status: z.enum(['draft', 'published', 'archived']).default('published'),
  // Multipart sends every field as a string, so "false" would be truthy.
  notify: z.preprocess((v) => v === 'false' || v === false ? false : true, z.boolean()).default(true),
});

/**
 * Publish a document — either an uploaded file or a link, never both.
 *
 * Accepting both would leave two sources of truth for one row and no rule about
 * which one the app should open.
 */
router.post('/', adminOnly, upload.single('file'), asyncHandler(async (req, res) => {
  const body = bodySchema.parse(req.body);
  const hasUrl = !!body.url;

  if (!req.file && !hasUrl) {
    throw Object.assign(
      new Error('Attach a file or provide a link'),
      { status: 400, code: 'NO_SOURCE' },
    );
  }
  if (req.file && hasUrl) {
    await removeStoredFile(req.file.filename);
    throw Object.assign(
      new Error('Provide a file or a link, not both'),
      { status: 400, code: 'AMBIGUOUS_SOURCE' },
    );
  }

  const { schoolId, classLevel } = validateScope(body);

  const result = await execute(
    `INSERT INTO ls_document
       (title, description, category, source_type, url, storage_path, mime_type, size_bytes,
        scope, school_id, class_level, status, notify, published_at, created_by)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [
      body.title, body.description || null, body.category,
      req.file ? 'file' : 'link',
      hasUrl ? body.url : null,
      req.file ? req.file.filename : null,
      req.file?.mimetype || null, req.file?.size || null,
      body.scope, schoolId, classLevel,
      body.status, body.notify ? 1 : 0,
      body.status === 'published' ? new Date() : null,
      req.user.id,
    ],
  );

  await audit(req.user.id, 'document.create', result.insertId, {
    title: body.title, scope: body.scope, schoolId, classLevel, notify: body.notify,
  });

  const created = await one(
    `SELECT d.*, s.name AS school_name FROM ls_document d
     LEFT JOIN ls_school s ON s.id = d.school_id WHERE d.id = ?`,
    [result.insertId],
  );

  res.status(201).json({
    document: shape(created),
    // So the dashboard can say "sent to 42 students" instead of just "saved".
    audienceSize: await audienceSize(body.scope, schoolId, classLevel),
  });
}));

router.put('/:id', adminOnly, asyncHandler(async (req, res) => {
  const body = bodySchema.partial().parse(req.body);
  const existing = await one('SELECT * FROM ls_document WHERE id = ?', [req.params.id]);
  if (!existing) throw Object.assign(new Error('Not found'), { status: 404 });

  const merged = { ...existing, scope: body.scope ?? existing.scope,
    schoolId: body.schoolId ?? existing.school_id, classLevel: body.classLevel ?? existing.class_level };
  const { schoolId, classLevel } = validateScope(merged);

  const map = {
    title: 'title', description: 'description', category: 'category',
    scope: 'scope', status: 'status',
  };
  const sets = [];
  const params = [];
  for (const [key, col] of Object.entries(map)) {
    if (body[key] !== undefined) { sets.push(`${col} = ?`); params.push(body[key]); }
  }
  if (body.notify !== undefined) { sets.push('notify = ?'); params.push(body.notify ? 1 : 0); }
  if (body.scope !== undefined || body.schoolId !== undefined || body.classLevel !== undefined) {
    sets.push('school_id = ?', 'class_level = ?');
    params.push(schoolId, classLevel);
  }
  // Stamp the publish time the first time it goes live, and never move it —
  // the feed sorts on it, and a re-edit should not jump an old notice to the top.
  if (body.status === 'published' && !existing.published_at) {
    sets.push('published_at = NOW()');
  }

  if (!sets.length) throw Object.assign(new Error('Nothing to update'), { status: 400 });

  params.push(req.params.id);
  await execute(`UPDATE ls_document SET ${sets.join(', ')} WHERE id = ?`, params);
  await audit(req.user.id, 'document.update', req.params.id, body);

  const updated = await one(
    `SELECT d.*, s.name AS school_name FROM ls_document d
     LEFT JOIN ls_school s ON s.id = d.school_id WHERE d.id = ?`,
    [req.params.id],
  );
  res.json({ document: shape(updated) });
}));

router.delete('/:id', adminOnly, asyncHandler(async (req, res) => {
  const doc = await one('SELECT storage_path FROM ls_document WHERE id = ?', [req.params.id]);
  if (!doc) throw Object.assign(new Error('Not found'), { status: 404 });

  await execute('DELETE FROM ls_document WHERE id = ?', [req.params.id]);
  // After the row is gone, so a failed delete never orphans the record.
  await removeStoredFile(doc.storage_path);
  await audit(req.user.id, 'document.delete', req.params.id, null);

  res.json({ deleted: true });
}));

/** Who would receive this, before publishing it. */
router.get('/audience-preview', adminOnly, asyncHandler(async (req, res) => {
  const { scope = 'global', schoolId, classLevel } = req.query;
  res.json({
    scope,
    audienceSize: await audienceSize(scope, schoolId || null, classLevel || null),
  });
}));

// ─── Helpers ─────────────────────────────────────────────────────────────────

/** A school-scoped notice with no school would silently reach nobody. */
function validateScope(body) {
  const scope = body.scope;
  if (scope === 'global') return { schoolId: null, classLevel: null };

  const schoolId = body.schoolId ?? null;
  if (!schoolId) {
    throw Object.assign(
      new Error('Choose a school for a school or class notice'),
      { status: 400, code: 'SCHOOL_REQUIRED' },
    );
  }
  if (scope === 'school') return { schoolId, classLevel: null };

  const classLevel = body.classLevel ?? null;
  if (!classLevel) {
    throw Object.assign(
      new Error('Choose a class for a class notice'),
      { status: 400, code: 'CLASS_REQUIRED' },
    );
  }
  return { schoolId, classLevel };
}

/** Active students matching an audience. Parents are reached through them. */
async function audienceSize(scope, schoolId, classLevel) {
  const where = ["u.role = 'student'", "u.status = 'active'"];
  const params = [];
  if (scope === 'school') { where.push('sp.school_id = ?'); params.push(schoolId); }
  if (scope === 'class') {
    where.push('sp.school_id = ?', 'sp.class_level = ?');
    params.push(schoolId, classLevel);
  }
  const [{ n }] = await query(
    `SELECT COUNT(*) AS n FROM ls_user u
       LEFT JOIN ls_student_profile sp ON sp.user_id = u.id
      WHERE ${where.join(' AND ')}`,
    params,
  );
  return Number(n);
}

function shape(r) {
  if (!r) return null;
  return {
    id: r.id,
    title: r.title,
    description: r.description,
    category: r.category,
    sourceType: r.source_type,
    // Uploaded files go out as a /media URL, never a filesystem path.
    url: r.source_type === 'file' ? mediaUrl(r.storage_path) : r.url,
    mimeType: r.mime_type,
    sizeBytes: r.size_bytes ? Number(r.size_bytes) : null,
    scope: r.scope,
    schoolId: r.school_id,
    schoolName: r.school_name,
    classLevel: r.class_level,
    status: r.status,
    notify: !!r.notify,
    publishedAt: r.published_at,
    createdAt: r.created_at,
    isRead: r.read_at !== undefined ? !!r.read_at : undefined,
    readCount: r.read_count !== undefined ? Number(r.read_count) : undefined,
  };
}

async function audit(actorId, action, entityId, detail) {
  await execute(
    `INSERT INTO ls_audit_log (actor_id, action, entity_type, entity_id, detail)
     VALUES (?, ?, 'ls_document', ?, ?)`,
    [actorId, action, String(entityId), detail ? JSON.stringify(detail) : null],
  );
}

export default router;
