import { Router } from 'express';
import { z } from 'zod';
import { execute, one, query, transaction } from '../config/db.js';
import { PARENT, ROLES, STUDENT, USER_STATUS } from '../config/constants.js';
import { authenticate, requireRole } from '../middleware/auth.js';
import { asyncHandler } from '../middleware/error.js';

const router = Router();

/**
 * Parent / guardian accounts.
 *
 * A parent supervises up to PARENT.MAX_CHILDREN children; a student may be
 * watched by up to STUDENT.MAX_GUARDIANS adults. Both caps are checked inside
 * one transaction with the existing rows locked — checking then inserting lets
 * two simultaneous requests both see "4 children" and both succeed, landing on
 * six.
 */

/**
 * Link a child by their access code.
 *
 * The code is the proof of relationship. Linking by phone number would let
 * anyone who knows a child's number attach themselves to that child's account,
 * which is the worst failure this system could have.
 */
router.post('/children/link', authenticate, requireRole(ROLES.PARENT), asyncHandler(async (req, res) => {
  const { accessCode, relation } = z.object({
    accessCode: z.string().min(4),
    relation: z.enum(['parent', 'guardian']).default('parent'),
  }).parse(req.body);

  const result = await transaction(async (conn) => {
    const [codeRows] = await conn.execute(
      `SELECT ac.id, ac.used_by FROM ls_access_code ac WHERE ac.code = ?`,
      [String(accessCode).trim()],
    );
    const code = codeRows[0];
    if (!code?.used_by) {
      throw Object.assign(
        new Error('That code has not been used to activate a student yet'),
        { status: 404, code: 'CODE_NOT_LINKED' },
      );
    }

    const [childRows] = await conn.execute(
      `SELECT u.id, u.full_name, u.status FROM ls_user u WHERE u.id = ? AND u.role = ?`,
      [code.used_by, ROLES.STUDENT],
    );
    const child = childRows[0];
    if (!child) throw Object.assign(new Error('Student not found'), { status: 404 });

    // FOR UPDATE on both sides: the caps are only meaningful if concurrent
    // requests serialise here.
    const [mine] = await conn.execute(
      'SELECT id FROM ls_parent_link WHERE parent_user_id = ? FOR UPDATE',
      [req.user.id],
    );
    if (mine.length >= PARENT.MAX_CHILDREN) {
      throw Object.assign(
        new Error(`A parent account can be linked to at most ${PARENT.MAX_CHILDREN} children`),
        { status: 409, code: 'MAX_CHILDREN' },
      );
    }

    const [theirs] = await conn.execute(
      'SELECT id FROM ls_parent_link WHERE student_user_id = ? FOR UPDATE',
      [child.id],
    );
    if (theirs.length >= STUDENT.MAX_GUARDIANS) {
      throw Object.assign(
        new Error(`This student already has ${STUDENT.MAX_GUARDIANS} linked accounts`),
        { status: 409, code: 'MAX_GUARDIANS' },
      );
    }

    try {
      await conn.execute(
        `INSERT INTO ls_parent_link (parent_user_id, student_user_id, relation) VALUES (?, ?, ?)`,
        [req.user.id, child.id, relation],
      );
    } catch (err) {
      if (err.code === 'ER_DUP_ENTRY') {
        throw Object.assign(new Error('You are already linked to this student'), { status: 409, code: 'ALREADY_LINKED' });
      }
      throw err;
    }

    // A parent who can prove a code is a real relationship, so the account
    // activates here rather than waiting in the admin queue.
    if (req.user.status === USER_STATUS.PENDING) {
      await conn.execute(
        `UPDATE ls_user SET status = ?, activated_at = NOW() WHERE id = ?`,
        [USER_STATUS.ACTIVE, req.user.id],
      );
    }

    return { childId: child.id, childName: child.full_name };
  });

  res.status(201).json({ linked: true, ...result });
}));

/** The children this parent supervises, with progress. */
router.get('/children', authenticate, requireRole(ROLES.PARENT), asyncHandler(async (req, res) => {
  const rows = await query(
    `SELECT u.id, u.full_name, u.status, u.last_login_at, u.created_at,
            pl.relation, sp.class_level, sp.section,
            s.name AS school_name, ac.code AS access_code,
            (SELECT COUNT(*) FROM ls_content_progress p WHERE p.user_id = u.id) AS started,
            (SELECT COUNT(*) FROM ls_content_progress p WHERE p.user_id = u.id AND p.status = 'completed') AS completed
       FROM ls_parent_link pl
       JOIN ls_user u              ON u.id = pl.student_user_id
       LEFT JOIN ls_student_profile sp ON sp.user_id = u.id
       LEFT JOIN ls_school s           ON s.id = sp.school_id
       LEFT JOIN ls_access_code ac     ON ac.id = sp.access_code_id
      WHERE pl.parent_user_id = ?
      ORDER BY u.full_name`,
    [req.user.id],
  );

  res.json({
    children: rows.map((r) => ({
      id: r.id, fullName: r.full_name, status: r.status, relation: r.relation,
      classLevel: r.class_level, section: r.section, schoolName: r.school_name,
      accessCode: r.ls_access_code, registeredAt: r.created_at, lastLoginAt: r.last_login_at,
      progress: { started: Number(r.started), completed: Number(r.completed) },
    })),
    limit: PARENT.MAX_CHILDREN,
    remaining: Math.max(0, PARENT.MAX_CHILDREN - rows.length),
  });
}));

/** One child's recent activity. */
router.get('/children/:id/activity', authenticate, requireRole(ROLES.PARENT), asyncHandler(async (req, res) => {
  // Authorisation before data: without this check any parent could read any
  // child's activity by guessing an id.
  const link = await one(
    'SELECT id FROM ls_parent_link WHERE parent_user_id = ? AND student_user_id = ?',
    [req.user.id, req.params.id],
  );
  if (!link) throw Object.assign(new Error('Not one of your children'), { status: 403, code: 'NOT_LINKED' });

  const activity = await query(
    `SELECT i.title, i.item_type, p.status, p.last_seen_at, n.title AS topic_title
       FROM ls_content_progress p
       JOIN ls_content_item i ON i.id = p.item_id
       JOIN ls_content_node n ON n.id = i.node_id
      WHERE p.user_id = ?
      ORDER BY p.last_seen_at DESC
      LIMIT 50`,
    [req.params.id],
  );

  res.json({
    activity: activity.map((a) => ({
      title: a.title, itemType: a.item_type, topicTitle: a.topic_title,
      status: a.status, lastSeenAt: a.last_seen_at,
    })),
  });
}));

router.delete('/children/:id', authenticate, requireRole(ROLES.PARENT), asyncHandler(async (req, res) => {
  const result = await execute(
    'DELETE FROM ls_parent_link WHERE parent_user_id = ? AND student_user_id = ?',
    [req.user.id, req.params.id],
  );
  if (!result.affectedRows) throw Object.assign(new Error('Not linked'), { status: 404 });
  res.json({ unlinked: true });
}));

export default router;
