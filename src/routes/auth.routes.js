import { Router } from 'express';
import jwt from 'jsonwebtoken';
import { z } from 'zod';
import { config } from '../config/index.js';
import { execute, one, transaction } from '../config/db.js';
import { ROLES, STUDENT, USER_STATUS, PUBLIC_CONSTANTS } from '../config/constants.js';
import { requestOtp, verifyOtp, classifyIdentifier } from '../services/otp.js';
import { verifyPassword, hashPassword } from '../services/password.js';
import {
  signAccessToken, issueRefreshToken, rotateRefreshToken, revokeRefreshToken,
} from '../services/tokens.js';
import { redeemCode } from '../services/accessCode.js';
import { authenticate } from '../middleware/auth.js';
import { asyncHandler } from '../middleware/error.js';

const router = Router();

/**
 * Registration and sign-in.
 *
 * Students and parents authenticate by OTP on a phone or email; admins use a
 * password. Admins are never self-registerable — an admin account can only be
 * created by another admin, or by the one-time seed.
 */

// ─── Step 1: request a code ──────────────────────────────────────────────────

router.post('/otp/request', asyncHandler(async (req, res) => {
  const { identifier } = z.object({ identifier: z.string().min(3) }).parse(req.body);

  // An admin email must not be usable as an OTP login — that would turn a
  // password-protected account into one reachable by anyone holding the inbox.
  const id = classifyIdentifier(identifier);
  const existing = await one(
    `SELECT role FROM ls_user WHERE ${id.type === 'email' ? 'email' : 'phone'} = ?`,
    [id.value],
  );
  if (existing?.role === ROLES.ADMIN) {
    throw Object.assign(
      new Error('This account signs in with a password'),
      { status: 409, code: 'USE_PASSWORD_LOGIN' },
    );
  }

  res.json(await requestOtp(identifier));
}));

// ─── Step 2: verify it ───────────────────────────────────────────────────────

/**
 * Verifying an OTP does one of two things:
 *
 *   known identifier   → a full session, they are signed in
 *   unknown identifier → a 10-minute registration token, nothing created yet
 *
 * The account is not created here. A verified phone number with no name, school
 * or class is a half-row that the admin dashboard would have to display and
 * explain; deferring creation to /register keeps every app_user row complete.
 */
router.post('/otp/verify', asyncHandler(async (req, res) => {
  const { identifier, code } = z.object({
    identifier: z.string().min(3),
    code: z.string().min(4).max(10),
  }).parse(req.body);

  const id = await verifyOtp(identifier, code);
  const column = id.type === 'email' ? 'email' : 'phone';

  const user = await one(
    `SELECT id, role, status, full_name, email, phone FROM ls_user WHERE ${column} = ?`,
    [id.value],
  );

  if (!user) {
    const registrationToken = jwt.sign(
      { purpose: 'register', identifier: id.value, identifierType: id.type },
      config.jwt.secret,
      { expiresIn: '10m', issuer: 'app-code-backend' },
    );
    return res.json({ registered: false, registrationToken, identifier: id.value, identifierType: id.type });
  }

  if (user.status === USER_STATUS.INACTIVE) {
    throw Object.assign(new Error('This account has been deactivated'), { status: 403, code: 'ACCOUNT_INACTIVE' });
  }

  await execute('UPDATE ls_user SET last_login_at = NOW() WHERE id = ?', [user.id]);

  return res.json({
    registered: true,
    ...(await sessionFor(user, req)),
  });
}));

// ─── Step 3: complete registration ───────────────────────────────────────────

router.post('/register', asyncHandler(async (req, res) => {
  const body = z.object({
    registrationToken: z.string().min(10),
    fullName: z.string().min(2).max(150),
    role: z.enum([ROLES.STUDENT, ROLES.PARENT]).default(ROLES.STUDENT),
    schoolId: z.coerce.number().int().positive().optional(),
    classLevel: z.coerce.number().int().min(STUDENT.MIN_CLASS).max(STUDENT.MAX_CLASS).optional(),
    section: z.string().max(16).optional(),
  }).parse(req.body);

  let claims;
  try {
    claims = jwt.verify(body.registrationToken, config.jwt.secret, { issuer: 'app-code-backend' });
  } catch {
    throw Object.assign(
      new Error('Your verification expired — please request a new code'),
      { status: 401, code: 'REGISTRATION_TOKEN_INVALID' },
    );
  }
  if (claims.purpose !== 'register') {
    throw Object.assign(new Error('Wrong token type'), { status: 401, code: 'REGISTRATION_TOKEN_INVALID' });
  }

  if (body.role === ROLES.STUDENT && !body.classLevel) {
    throw Object.assign(
      new Error('Class is required for a student account'),
      { status: 400, code: 'CLASS_REQUIRED' },
    );
  }

  const isEmail = claims.identifierType === 'email';

  const user = await transaction(async (conn) => {
    const [ins] = await conn.execute(
      `INSERT INTO ls_user (role, email, phone, full_name, status)
       VALUES (?, ?, ?, ?, ?)`,
      [
        body.role,
        isEmail ? claims.identifier : null,
        isEmail ? null : claims.identifier,
        body.fullName.trim(),
        // Both roles start pending. A parent is approved the same way a student
        // is — an unapproved adult must not be able to browse children.
        USER_STATUS.PENDING,
      ],
    );

    if (body.role === ROLES.STUDENT) {
      await conn.execute(
        `INSERT INTO ls_student_profile (user_id, school_id, class_level, section)
         VALUES (?, ?, ?, ?)`,
        [ins.insertId, body.schoolId ?? null, body.classLevel ?? null, body.section ?? null],
      );
    }

    return { id: ins.insertId, role: body.role, status: USER_STATUS.PENDING, full_name: body.fullName };
  });

  res.status(201).json({
    registered: true,
    ...(await sessionFor(user, req)),
  });
}));

// ─── Access code redemption ──────────────────────────────────────────────────

/**
 * The other half of "activate now or wait for approval".
 *
 * Authenticated, because the student already has a session from registering —
 * they are signed in and pending, not signed out.
 */
router.post('/redeem-code', authenticate, asyncHandler(async (req, res) => {
  const { code } = z.object({ code: z.string().min(1) }).parse(req.body);

  if (req.user.role !== ROLES.STUDENT) {
    throw Object.assign(new Error('Only a student account can redeem a code'), { status: 403 });
  }
  if (req.user.status === USER_STATUS.ACTIVE) {
    throw Object.assign(
      new Error('Your account is already active'),
      { status: 409, code: 'ALREADY_ACTIVE' },
    );
  }

  const result = await redeemCode({ code, studentUserId: req.user.id });

  // Re-issue the access token: the old one still says status=pending, and the
  // app would keep showing the waiting screen until it happened to expire.
  const fresh = { id: req.user.id, role: req.user.role, status: USER_STATUS.ACTIVE };

  res.json({
    activated: true,
    schoolId: result.schoolId,
    classLevel: result.classLevel,
    accessToken: signAccessToken(fresh),
    user: await publicUser(req.user.id),
  });
}));

// ─── Admin password login ────────────────────────────────────────────────────

router.post('/admin/login', asyncHandler(async (req, res) => {
  const { email, password } = z.object({
    email: z.string().email(),
    password: z.string().min(1),
  }).parse(req.body);

  const user = await one(
    `SELECT id, role, status, password_hash, full_name, email
       FROM ls_user WHERE email = ?`,
    [email.toLowerCase()],
  );

  // One message for every failure mode. "No such admin" versus "wrong
  // password" tells an attacker which emails are worth attacking.
  const ok = user?.role === ROLES.ADMIN && await verifyPassword(password, user?.password_hash);
  if (!ok) {
    throw Object.assign(new Error('Email or password is incorrect'), { status: 401, code: 'BAD_CREDENTIALS' });
  }
  if (user.status !== USER_STATUS.ACTIVE) {
    throw Object.assign(new Error('This admin account is not active'), { status: 403, code: 'ACCOUNT_INACTIVE' });
  }

  await execute('UPDATE ls_user SET last_login_at = NOW() WHERE id = ?', [user.id]);

  res.json(await sessionFor(user, req));
}));

router.post('/admin/change-password', authenticate, asyncHandler(async (req, res) => {
  const { currentPassword, newPassword } = z.object({
    currentPassword: z.string().min(1),
    newPassword: z.string().min(PUBLIC_CONSTANTS.passwordMinLength),
  }).parse(req.body);

  if (req.user.role !== ROLES.ADMIN) {
    throw Object.assign(new Error('Only admin accounts have a password'), { status: 403 });
  }

  const row = await one('SELECT password_hash FROM ls_user WHERE id = ?', [req.user.id]);
  if (!await verifyPassword(currentPassword, row.password_hash)) {
    throw Object.assign(new Error('Current password is incorrect'), { status: 401, code: 'BAD_CREDENTIALS' });
  }

  await execute('UPDATE ls_user SET password_hash = ? WHERE id = ?', [await hashPassword(newPassword), req.user.id]);
  await execute(
    `INSERT INTO ls_audit_log (actor_id, action, entity_type, entity_id) VALUES (?, 'admin.password_change', 'app_user', ?)`,
    [req.user.id, String(req.user.id)],
  );

  res.json({ changed: true });
}));

// ─── Session plumbing ────────────────────────────────────────────────────────

router.post('/refresh', asyncHandler(async (req, res) => {
  const { refreshToken } = z.object({ refreshToken: z.string().min(10) }).parse(req.body);
  const rotated = await rotateRefreshToken(refreshToken, req.headers['user-agent']);
  res.json({
    accessToken: rotated.accessToken,
    refreshToken: rotated.refreshToken,
    user: await publicUser(rotated.user.id),
  });
}));

router.post('/logout', asyncHandler(async (req, res) => {
  const { refreshToken } = z.object({ refreshToken: z.string().optional() }).parse(req.body || {});
  if (refreshToken) await revokeRefreshToken(refreshToken);
  res.json({ loggedOut: true });
}));

router.get('/me', authenticate, asyncHandler(async (req, res) => {
  res.json({ user: await publicUser(req.user.id) });
}));

// ─── Helpers ─────────────────────────────────────────────────────────────────

async function sessionFor(user, req) {
  return {
    accessToken: signAccessToken(user),
    refreshToken: await issueRefreshToken(user.id, req.headers['user-agent']),
    user: await publicUser(user.id),
  };
}

/**
 * The user object the app is allowed to see.
 *
 * Explicit column list, never `SELECT *` — a `SELECT *` here would start
 * shipping password_hash to every client the day someone adds a join.
 */
async function publicUser(userId) {
  const row = await one(
    `SELECT u.id, u.role, u.status, u.full_name, u.email, u.phone,
            u.created_at, u.last_login_at,
            sp.school_id, sp.class_level, sp.section,
            s.name AS school_name,
            ac.code AS access_code
       FROM ls_user u
       LEFT JOIN ls_student_profile sp ON sp.user_id = u.id
       LEFT JOIN ls_school s           ON s.id = sp.school_id
       LEFT JOIN ls_access_code ac     ON ac.id = sp.access_code_id
      WHERE u.id = ?`,
    [userId],
  );
  if (!row) return null;

  return {
    id: row.id,
    role: row.role,
    status: row.status,
    fullName: row.full_name,
    email: row.email,
    phone: row.phone,
    createdAt: row.created_at,
    lastLoginAt: row.last_login_at,
    ...(row.role === ROLES.STUDENT ? {
      schoolId: row.school_id,
      schoolName: row.school_name,
      classLevel: row.class_level,
      section: row.section,
      accessCode: row.ls_access_code,
    } : {}),
  };
}

export default router;
