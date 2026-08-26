import { Router } from 'express';
import path from 'node:path';
import fs from 'node:fs';
import crypto from 'node:crypto';
import multer from 'multer';
import { z } from 'zod';
import { config } from '../config/index.js';
import { execute, one, query } from '../config/db.js';
import { ITEM_TYPES, NODE_TYPES, ROLES } from '../config/constants.js';
import { authenticate, requireAdmin, requireActive } from '../middleware/auth.js';
import { asyncHandler } from '../middleware/error.js';

const router = Router();

/**
 * Content — the tree (sections 2.5/2.6) and what a student is allowed to see.
 *
 * Admin routes mutate; student routes read and are filtered by class and
 * visibility. Both live here because they read the same two tables and keeping
 * the visibility rule in one file is what stops the two views drifting apart.
 */

fs.mkdirSync(config.storage.uploadDir, { recursive: true });

const upload = multer({
  storage: multer.diskStorage({
    destination: (req, file, cb) => cb(null, config.storage.uploadDir),
    filename: (req, file, cb) => {
      // Never trust the client's filename on disk. A student-supplied
      // "../../etc/cron.d/x" would otherwise be written wherever it points.
      const ext = path.extname(file.originalname).toLowerCase().replace(/[^.a-z0-9]/g, '').slice(0, 10);
      cb(null, `${Date.now()}-${crypto.randomBytes(8).toString('hex')}${ext}`);
    },
  }),
  limits: { fileSize: config.storage.maxUploadBytes },
});

// ─── Student-facing ──────────────────────────────────────────────────────────

/**
 * The student's home tree: their class, its subjects, and progress counts.
 *
 * Visibility is applied server-side. Sending everything and letting the app
 * hide things would mean the content is one proxy away from anyone.
 */
router.get('/my', authenticate, requireActive, asyncHandler(async (req, res) => {
  if (req.user.role !== ROLES.STUDENT) {
    throw Object.assign(new Error('Only a student account has a content tree'), { status: 403 });
  }

  const profile = await one('SELECT class_level FROM ls_student_profile WHERE user_id = ?', [req.user.id]);
  const classLevel = profile?.class_level;
  if (!classLevel) {
    throw Object.assign(new Error('No class set on your profile'), { status: 409, code: 'NO_CLASS' });
  }

  const subjects = await query(
    `SELECT n.id, n.title, n.description, n.sort_order,
            (SELECT COUNT(*) FROM ls_content_node c
              WHERE c.parent_id = n.id AND c.visibility = 'visible') AS chapter_count
       FROM ls_content_node n
      WHERE n.node_type = 'subject'
        AND n.class_level = ?
        AND n.visibility = 'visible'
      ORDER BY n.sort_order, n.title`,
    [classLevel],
  );

  const recent = await query(
    `SELECT i.id, i.title, i.item_type, p.status, p.last_seen_at, p.position_secs,
            n.title AS topic_title
       FROM ls_content_progress p
       JOIN ls_content_item i ON i.id = p.item_id
       JOIN ls_content_node n ON n.id = i.node_id
      WHERE p.user_id = ? AND i.visibility = 'visible'
      ORDER BY p.last_seen_at DESC
      LIMIT 5`,
    [req.user.id],
  );

  res.json({
    classLevel,
    subjects: subjects.map((s) => ({
      id: s.id, title: s.title, description: s.description, chapterCount: Number(s.chapter_count),
    })),
    recent: recent.map((r) => ({
      itemId: r.id, title: r.title, itemType: r.item_type, topicTitle: r.topic_title,
      status: r.status, positionSecs: r.position_secs, lastSeenAt: r.last_seen_at,
    })),
  });
}));

/** Children of one node, plus its items. Used for every level below subject. */
router.get('/nodes/:id/children', authenticate, requireActive, asyncHandler(async (req, res) => {
  const isAdmin = req.user.role === ROLES.ADMIN;
  const visible = isAdmin ? '' : "AND visibility = 'visible'";

  const node = await one(`SELECT * FROM ls_content_node WHERE id = ? ${visible}`, [req.params.id]);
  if (!node) throw Object.assign(new Error('Not found'), { status: 404 });

  // A student may only read inside their own class.
  if (!isAdmin) {
    const profile = await one('SELECT class_level FROM ls_student_profile WHERE user_id = ?', [req.user.id]);
    if (node.class_level && profile?.class_level !== node.class_level) {
      throw Object.assign(new Error('This is not part of your class'), { status: 403, code: 'WRONG_CLASS' });
    }
  }

  const children = await query(
    `SELECT id, node_type, title, description, sort_order, visibility
       FROM ls_content_node WHERE parent_id = ? ${visible}
      ORDER BY sort_order, title`,
    [req.params.id],
  );

  const items = await query(
    `SELECT i.id, i.item_type, i.title, i.description, i.url, i.storage_path,
            i.mime_type, i.duration_secs, i.sort_order, i.visibility,
            p.status AS progress_status, p.position_secs
       FROM ls_content_item i
       LEFT JOIN ls_content_progress p ON p.item_id = i.id AND p.user_id = ?
      WHERE i.node_id = ? ${isAdmin ? '' : "AND i.visibility = 'visible'"}
      ORDER BY i.sort_order, i.id`,
    [req.user.id, req.params.id],
  );

  res.json({
    node: { id: node.id, nodeType: node.node_type, title: node.title, description: node.description, classLevel: node.class_level },
    children: children.map((c) => ({
      id: c.id, nodeType: c.node_type, title: c.title, description: c.description, visibility: c.visibility,
    })),
    items: items.map(shapeItem),
  });
}));

/** Mark viewed / completed. Upsert, so a re-watch never double-counts. */
router.post('/items/:id/progress', authenticate, requireActive, asyncHandler(async (req, res) => {
  const body = z.object({
    status: z.enum(['viewed', 'completed']).default('viewed'),
    positionSecs: z.coerce.number().int().min(0).default(0),
  }).parse(req.body);

  const item = await one("SELECT id FROM ls_content_item WHERE id = ? AND visibility = 'visible'", [req.params.id]);
  if (!item) throw Object.assign(new Error('Content not found'), { status: 404 });

  await execute(
    `INSERT INTO ls_content_progress (user_id, item_id, status, position_secs, completed_at)
     VALUES (?, ?, ?, ?, ${body.status === 'completed' ? 'NOW()' : 'NULL'})
     ON DUPLICATE KEY UPDATE
       -- Never downgrade: re-opening a finished video must not un-complete it.
       status       = IF(ls_content_progress.status = 'completed', 'completed', VALUES(status)),
       position_secs = VALUES(position_secs),
       completed_at  = COALESCE(ls_content_progress.completed_at, VALUES(completed_at))`,
    [req.user.id, req.params.id, body.status, body.positionSecs],
  );

  res.json({ saved: true });
}));

// ─── Admin-facing ────────────────────────────────────────────────────────────

const adminOnly = [authenticate, requireAdmin];

/** Whole tree, including hidden nodes. */
router.get('/tree', adminOnly, asyncHandler(async (req, res) => {
  const nodes = await query(
    `SELECT id, parent_id, node_type, title, class_level, sort_order, visibility
       FROM ls_content_node ORDER BY sort_order, title`,
  );
  const counts = await query(
    `SELECT node_id, COUNT(*) AS n FROM ls_content_item GROUP BY node_id`,
  );
  const countBy = Object.fromEntries(counts.map((c) => [c.node_id, Number(c.n)]));

  // Assembled in memory rather than with a recursive CTE: MariaDB 10.5 supports
  // them but the whole tree is a few hundred rows, and one flat query plus a
  // map is easier to reason about than a CTE nobody will want to modify.
  const byId = new Map(nodes.map((n) => [n.id, {
    id: n.id, nodeType: n.node_type, title: n.title, classLevel: n.class_level,
    visibility: n.visibility, itemCount: countBy[n.id] || 0, children: [],
  }]));

  const roots = [];
  for (const n of nodes) {
    const shaped = byId.get(n.id);
    if (n.parent_id && byId.has(n.parent_id)) byId.get(n.parent_id).children.push(shaped);
    else roots.push(shaped);
  }

  res.json({ tree: roots });
}));

router.post('/nodes', adminOnly, asyncHandler(async (req, res) => {
  const body = z.object({
    parentId: z.coerce.number().int().positive().nullable().optional(),
    nodeType: z.enum(NODE_TYPES),
    title: z.string().min(1).max(191),
    description: z.string().max(2000).optional().nullable(),
    classLevel: z.coerce.number().int().min(1).max(12).nullable().optional(),
    sortOrder: z.coerce.number().int().default(0),
    visibility: z.enum(['visible', 'hidden']).default('visible'),
  }).parse(req.body);

  // class_level is denormalised down the tree so a student query is one indexed
  // lookup. Inheriting it here is what keeps that denormalisation honest.
  let classLevel = body.classLevel ?? null;
  if (body.parentId) {
    const parent = await one('SELECT class_level FROM ls_content_node WHERE id = ?', [body.parentId]);
    if (!parent) throw Object.assign(new Error('Parent node not found'), { status: 404 });
    classLevel = classLevel ?? parent.class_level;
  }

  const result = await execute(
    `INSERT INTO ls_content_node (parent_id, node_type, title, description, class_level, sort_order, visibility, created_by)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    [body.parentId ?? null, body.nodeType, body.title, body.description ?? null,
     classLevel, body.sortOrder, body.visibility, req.user.id],
  );

  res.status(201).json({ node: await one('SELECT * FROM ls_content_node WHERE id = ?', [result.insertId]) });
}));

router.put('/nodes/:id', adminOnly, asyncHandler(async (req, res) => {
  const body = z.object({
    title: z.string().min(1).max(191).optional(),
    description: z.string().max(2000).nullable().optional(),
    parentId: z.coerce.number().int().positive().nullable().optional(),
    sortOrder: z.coerce.number().int().optional(),
    visibility: z.enum(['visible', 'hidden']).optional(),
  }).parse(req.body);

  // Reparenting to a descendant would detach the whole subtree from the root
  // and make it unreachable in the admin tree, with no error to explain it.
  if (body.parentId) {
    if (Number(body.parentId) === Number(req.params.id)) {
      throw Object.assign(new Error('A folder cannot be its own parent'), { status: 400 });
    }
    if (await isDescendant(body.parentId, req.params.id)) {
      throw Object.assign(new Error('Cannot move a folder inside itself'), { status: 400, code: 'CYCLIC_MOVE' });
    }
  }

  const map = { title: 'title', description: 'description', parentId: 'parent_id', sortOrder: 'sort_order', visibility: 'visibility' };
  const sets = [];
  const params = [];
  for (const [key, column] of Object.entries(map)) {
    if (body[key] !== undefined) { sets.push(`${column} = ?`); params.push(body[key]); }
  }
  if (!sets.length) throw Object.assign(new Error('Nothing to update'), { status: 400 });

  params.push(req.params.id);
  await execute(`UPDATE ls_content_node SET ${sets.join(', ')} WHERE id = ?`, params);
  res.json({ node: await one('SELECT * FROM ls_content_node WHERE id = ?', [req.params.id]) });
}));

router.delete('/nodes/:id', adminOnly, asyncHandler(async (req, res) => {
  // ON DELETE CASCADE takes the whole subtree and its items. Report the count
  // so the dashboard can say what actually went, rather than "deleted".
  const [{ n }] = await query(
    `SELECT COUNT(*) AS n FROM ls_content_item WHERE node_id = ?`, [req.params.id],
  );
  const result = await execute('DELETE FROM ls_content_node WHERE id = ?', [req.params.id]);
  if (!result.affectedRows) throw Object.assign(new Error('Not found'), { status: 404 });

  await execute(
    `INSERT INTO ls_audit_log (actor_id, action, entity_type, entity_id, detail)
     VALUES (?, 'content.delete_node', 'content_node', ?, ?)`,
    [req.user.id, String(req.params.id), JSON.stringify({ directItems: Number(n) })],
  );
  res.json({ deleted: true, directItems: Number(n) });
}));

/** Create an item. A file upload and a link both land here. */
router.post('/items', adminOnly, upload.single('file'), asyncHandler(async (req, res) => {
  const body = z.object({
    nodeId: z.coerce.number().int().positive(),
    itemType: z.enum(ITEM_TYPES),
    title: z.string().min(1).max(191),
    description: z.string().max(2000).optional().nullable(),
    url: z.string().url().optional().nullable(),
    sortOrder: z.coerce.number().int().default(0),
    visibility: z.enum(['visible', 'hidden']).default('visible'),
    durationSecs: z.coerce.number().int().min(0).optional().nullable(),
  }).parse(req.body);

  if (!req.file && !body.url) {
    throw Object.assign(new Error('Provide a file or a url'), { status: 400, code: 'NO_CONTENT_SOURCE' });
  }

  const node = await one('SELECT id FROM ls_content_node WHERE id = ?', [body.nodeId]);
  if (!node) throw Object.assign(new Error('Folder not found'), { status: 404 });

  const result = await execute(
    `INSERT INTO ls_content_item
       (node_id, item_type, title, description, url, storage_path, mime_type, size_bytes, duration_secs, sort_order, visibility, created_by)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [body.nodeId, body.itemType, body.title, body.description ?? null,
     body.url ?? null, req.file ? path.basename(req.file.path) : null,
     req.file?.mimetype ?? null, req.file?.size ?? null, body.durationSecs ?? null,
     body.sortOrder, body.visibility, req.user.id],
  );

  res.status(201).json({ item: shapeItem(await one('SELECT * FROM ls_content_item WHERE id = ?', [result.insertId])) });
}));

router.put('/items/:id', adminOnly, upload.single('file'), asyncHandler(async (req, res) => {
  const body = z.object({
    title: z.string().min(1).max(191).optional(),
    description: z.string().max(2000).nullable().optional(),
    url: z.string().url().nullable().optional(),
    nodeId: z.coerce.number().int().positive().optional(),
    sortOrder: z.coerce.number().int().optional(),
    visibility: z.enum(['visible', 'hidden']).optional(),
  }).parse(req.body);

  const existing = await one('SELECT * FROM ls_content_item WHERE id = ?', [req.params.id]);
  if (!existing) throw Object.assign(new Error('Content not found'), { status: 404 });

  const map = { title: 'title', description: 'description', url: 'url', nodeId: 'node_id', sortOrder: 'sort_order', visibility: 'visibility' };
  const sets = [];
  const params = [];
  for (const [key, column] of Object.entries(map)) {
    if (body[key] !== undefined) { sets.push(`${column} = ?`); params.push(body[key]); }
  }

  // "Replace content" from the spec: a new file supersedes the old one.
  if (req.file) {
    sets.push('storage_path = ?', 'mime_type = ?', 'size_bytes = ?');
    params.push(path.basename(req.file.path), req.file.mimetype, req.file.size);

    // Delete the superseded file only after the row is updated, so a failed
    // update never leaves a database row pointing at a file that is gone.
    if (existing.storage_path) {
      const old = path.join(config.storage.uploadDir, existing.storage_path);
      params.push(req.params.id);
      await execute(`UPDATE ls_content_item SET ${sets.join(', ')} WHERE id = ?`, params);
      fs.promises.unlink(old).catch(() => { /* already gone — nothing to do */ });
      return res.json({ item: shapeItem(await one('SELECT * FROM ls_content_item WHERE id = ?', [req.params.id])) });
    }
  }

  if (!sets.length) throw Object.assign(new Error('Nothing to update'), { status: 400 });
  params.push(req.params.id);
  await execute(`UPDATE ls_content_item SET ${sets.join(', ')} WHERE id = ?`, params);
  res.json({ item: shapeItem(await one('SELECT * FROM ls_content_item WHERE id = ?', [req.params.id])) });
}));

router.delete('/items/:id', adminOnly, asyncHandler(async (req, res) => {
  const item = await one('SELECT storage_path FROM ls_content_item WHERE id = ?', [req.params.id]);
  if (!item) throw Object.assign(new Error('Content not found'), { status: 404 });

  await execute('DELETE FROM ls_content_item WHERE id = ?', [req.params.id]);
  if (item.storage_path) {
    fs.promises.unlink(path.join(config.storage.uploadDir, item.storage_path)).catch(() => {});
  }
  res.json({ deleted: true });
}));

// ─── Helpers ─────────────────────────────────────────────────────────────────

/** Would moving `nodeId` under `candidateParentId` create a cycle? */
async function isDescendant(candidateParentId, nodeId) {
  let cursor = candidateParentId;
  // Bounded: the tree is four levels by design, and the bound also stops an
  // already-corrupt parent chain from spinning forever.
  for (let depth = 0; depth < 20 && cursor; depth += 1) {
    if (Number(cursor) === Number(nodeId)) return true;
    const row = await one('SELECT parent_id FROM ls_content_node WHERE id = ?', [cursor]);
    cursor = row?.parent_id;
  }
  return false;
}

function shapeItem(r) {
  return {
    id: r.id,
    nodeId: r.node_id,
    itemType: r.item_type,
    title: r.title,
    description: r.description,
    // Uploaded files are exposed through /media, never as a filesystem path.
    url: r.storage_path ? `/media/${r.storage_path}` : r.url,
    mimeType: r.mime_type,
    durationSecs: r.duration_secs,
    visibility: r.visibility,
    progressStatus: r.progress_status ?? null,
    positionSecs: r.position_secs ?? 0,
  };
}

export default router;
