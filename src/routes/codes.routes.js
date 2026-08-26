import { Router } from 'express';
import { z } from 'zod';
import { execute, one, query } from '../config/db.js';
import { ACCESS_CODE, PAGINATION, STUDENT } from '../config/constants.js';
import { authenticate, requireAdmin } from '../middleware/auth.js';
import { generateBatch, codeStats, reassignCode } from '../services/accessCode.js';
import { asyncHandler } from '../middleware/error.js';

const router = Router();
router.use(authenticate, requireAdmin);

/**
 * Access code administration — section 2.4.
 *
 * Generation lives in services/accessCode.js; this file is transport only.
 */

router.get('/stats', asyncHandler(async (req, res) => {
  res.json({ ...await codeStats(), codeLength: ACCESS_CODE.LENGTH, bulkMax: ACCESS_CODE.BULK_MAX });
}));

router.get('/', asyncHandler(async (req, res) => {
  const { search = '', status, schoolId, batchId, limit, offset } = req.query;
  const lim = Math.min(Number(limit) || PAGINATION.DEFAULT_LIMIT, PAGINATION.MAX_LIMIT);
  const off = Number(offset) || 0;

  const where = [];
  const params = [];
  if (search)   { where.push('(ac.code LIKE ? OR u.full_name LIKE ?)'); params.push(`%${search}%`, `%${search}%`); }
  if (status)   { where.push('ac.status = ?');    params.push(status); }
  if (schoolId) { where.push('ac.school_id = ?'); params.push(schoolId); }
  if (batchId)  { where.push('ac.batch_id = ?');  params.push(batchId); }

  const from = `
       FROM access_code ac
       LEFT JOIN school s   ON s.id = ac.school_id
       LEFT JOIN app_user u ON u.id = ac.used_by
      ${where.length ? `WHERE ${where.join(' AND ')}` : ''}`;

  const rows = await query(
    `SELECT ac.id, ac.code, ac.status, ac.class_level, ac.batch_id, ac.created_at, ac.used_at,
            ac.school_id, s.name AS school_name, u.id AS student_id, u.full_name AS student_name
       ${from}
      ORDER BY ac.created_at DESC, ac.id DESC
      LIMIT ${lim} OFFSET ${off}`,
    params,
  );

  const [{ total }] = await query(`SELECT COUNT(*) AS total ${from}`, params);
  res.json({ codes: rows.map(shape), total: Number(total), limit: lim, offset: off });
}));

router.post('/generate', asyncHandler(async (req, res) => {
  const body = z.object({
    count: z.coerce.number().int().min(1).max(ACCESS_CODE.BULK_MAX),
    schoolId: z.coerce.number().int().positive().optional().nullable(),
    classLevel: z.coerce.number().int().min(STUDENT.MIN_CLASS).max(STUDENT.MAX_CLASS).optional().nullable(),
  }).parse(req.body);

  const result = await generateBatch({
    count: body.count,
    schoolId: body.schoolId ?? null,
    classLevel: body.classLevel ?? null,
    createdBy: req.user.id,
  });

  await execute(
    `INSERT INTO audit_log (actor_id, action, entity_type, entity_id, detail)
     VALUES (?, 'code.generate', 'batch', ?, ?)`,
    [req.user.id, result.batchId, JSON.stringify({ count: result.count, schoolId: body.schoolId, classLevel: body.classLevel })],
  );

  res.status(201).json(result);
}));

router.patch('/:id/status', asyncHandler(async (req, res) => {
  const { status } = z.object({ status: z.enum(['unused', 'inactive']) }).parse(req.body);

  const code = await one('SELECT id, status FROM access_code WHERE id = ?', [req.params.id]);
  if (!code) throw Object.assign(new Error('Code not found'), { status: 404 });
  if (code.status === 'used') {
    throw Object.assign(
      new Error('A used code cannot change status — it records which student activated with it'),
      { status: 409, code: 'CODE_ALREADY_USED' },
    );
  }

  await execute('UPDATE access_code SET status = ? WHERE id = ?', [status, req.params.id]);
  res.json({ id: Number(req.params.id), status });
}));

router.patch('/:id/reassign', asyncHandler(async (req, res) => {
  const body = z.object({
    schoolId: z.coerce.number().int().positive().nullable().optional(),
    classLevel: z.coerce.number().int().min(STUDENT.MIN_CLASS).max(STUDENT.MAX_CLASS).nullable().optional(),
  }).parse(req.body);

  res.json(await reassignCode({
    codeId: req.params.id,
    schoolId: body.schoolId ?? null,
    classLevel: body.classLevel ?? null,
    actorId: req.user.id,
  }));
}));

// ─── Sharing ─────────────────────────────────────────────────────────────────

/**
 * Render a set of codes as text ready to hand to a school.
 *
 * The formatting lives here rather than in the app because all three clients
 * (Android, iOS, web) would otherwise each grow their own copy, and they would
 * drift. The app receives finished strings and only has to decide which share
 * sheet to open.
 *
 *   POST /api/codes/share
 *   { "batchId": "...", "format": "whatsapp" | "plain" | "email" | "csv" }
 */
router.post('/share', asyncHandler(async (req, res) => {
  const body = z.object({
    batchId: z.string().uuid().optional(),
    ids: z.array(z.coerce.number().int().positive()).max(ACCESS_CODE.BULK_MAX).optional(),
    format: z.enum(['plain', 'whatsapp', 'email', 'csv']).default('plain'),
    schoolName: z.string().max(191).optional(),
  }).parse(req.body);

  if (!body.batchId && !body.ids?.length) {
    throw Object.assign(new Error('Provide either batchId or ids'), { status: 400 });
  }

  const rows = body.batchId
    ? await query(
        `SELECT ac.code, ac.class_level, s.name AS school_name
           FROM access_code ac LEFT JOIN school s ON s.id = ac.school_id
          WHERE ac.batch_id = ? ORDER BY ac.id`, [body.batchId])
    : await query(
        `SELECT ac.code, ac.class_level, s.name AS school_name
           FROM access_code ac LEFT JOIN school s ON s.id = ac.school_id
          WHERE ac.id IN (${body.ids.map(() => '?').join(',')}) ORDER BY ac.id`, body.ids);

  if (!rows.length) throw Object.assign(new Error('No codes matched'), { status: 404 });

  const school = body.schoolName || rows[0].school_name || null;
  const codes = rows.map((r) => r.code);
  const classLevel = rows[0].class_level;

  res.json({
    count: codes.length,
    format: body.format,
    ...render(body.format, { codes, school, classLevel }),
  });
}));

function render(format, { codes, school, classLevel }) {
  const heading = [
    school ? `School: ${school}` : null,
    classLevel ? `Class: ${classLevel}` : null,
    `Codes: ${codes.length}`,
  ].filter(Boolean);

  switch (format) {
    case 'whatsapp':
      // WhatsApp reads *text* as bold and ```text``` as monospace. Monospace
      // matters here: a 10-digit code in a proportional font is genuinely hard
      // to read back over a phone call.
      return {
        text: [
          '*Learning App — Access Codes*',
          '',
          ...heading.map((h) => `_${h}_`),
          '',
          '```',
          ...codes,
          '```',
          '',
          'Each code activates one student account and can be used once.',
        ].join('\n'),
      };

    case 'email':
      return {
        subject: `Access codes${school ? ` for ${school}` : ''} (${codes.length})`,
        text: [
          'Hello,',
          '',
          `Please find ${codes.length} access code${codes.length === 1 ? '' : 's'} below.`,
          '',
          ...heading,
          '',
          ...codes,
          '',
          'Each code activates one student account and can be used once.',
          'Students enter it on the "Enter access code" screen after registering.',
        ].join('\n'),
      };

    case 'csv':
      // CRLF and a quoted code column: Excel reads a bare 10-digit number as a
      // float and renders 1234567890 as 1.23457E+09, destroying the code.
      return {
        filename: `access-codes-${new Date().toISOString().slice(0, 10)}.csv`,
        text: ['code,school,class', ...codes.map((c) => `"${c}","${school || ''}","${classLevel || ''}"`)].join('\r\n'),
      };

    case 'plain':
    default:
      return { text: [...heading, '', ...codes].join('\n') };
  }
}

function shape(r) {
  return {
    id: r.id,
    code: r.code,
    status: r.status,
    schoolId: r.school_id,
    schoolName: r.school_name,
    classLevel: r.class_level,
    batchId: r.batch_id,
    student: r.student_id ? { id: r.student_id, fullName: r.student_name } : null,
    createdAt: r.created_at,
    usedAt: r.used_at,
  };
}

export default router;
