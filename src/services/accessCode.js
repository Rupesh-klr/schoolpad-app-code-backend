import crypto from 'node:crypto';
import { ACCESS_CODE, CODE_STATUS, USER_STATUS } from '../config/constants.js';
import { execute, one, query, transaction } from '../config/db.js';

/**
 * Access code generation and redemption.
 *
 * The code length, alphabet and bulk ceiling all come from constants.js — the
 * app never hardcodes 10, it asks the API. Changing the length is a server
 * config change, not an app-store release.
 */

/**
 * One cryptographically random code.
 *
 * `crypto.randomInt` rather than `Math.random`: these codes are the only thing
 * standing between a stranger and a paid account, and Math.random is seeded
 * predictably enough to enumerate a day's worth of codes from a handful of
 * samples.
 */
function generateCode() {
  const { LENGTH, ALPHABET } = ACCESS_CODE;
  let out = '';
  for (let i = 0; i < LENGTH; i += 1) {
    out += ALPHABET[crypto.randomInt(0, ALPHABET.length)];
  }
  return out;
}

/**
 * Generate `count` codes, optionally pre-allocated to a school and class.
 *
 * Uniqueness is enforced by the UNIQUE index, not by SELECT-then-INSERT: two
 * admins clicking "generate 500" at the same moment would both see a code as
 * free and both insert it. Here a collision surfaces as ER_DUP_ENTRY and the
 * row is retried with a fresh code.
 */
export async function generateBatch({ count, schoolId = null, classLevel = null, createdBy = null }) {
  const n = Number(count);
  if (!Number.isInteger(n) || n < 1) {
    throw Object.assign(new Error('count must be a positive integer'), { status: 400 });
  }
  if (n > ACCESS_CODE.BULK_MAX) {
    throw Object.assign(
      new Error(`count exceeds the maximum of ${ACCESS_CODE.BULK_MAX} per batch`),
      { status: 400 },
    );
  }

  const batchId = crypto.randomUUID();
  const created = [];

  for (let i = 0; i < n; i += 1) {
    let inserted = false;

    for (let attempt = 0; attempt < ACCESS_CODE.COLLISION_RETRIES && !inserted; attempt += 1) {
      const code = generateCode();
      try {
        const res = await execute(
          `INSERT INTO ls_access_code (code, school_id, class_level, batch_id, created_by)
           VALUES (?, ?, ?, ?, ?)`,
          [code, schoolId, classLevel, batchId, createdBy],
        );
        created.push({ id: res.insertId, code });
        inserted = true;
      } catch (err) {
        if (err.code !== 'ER_DUP_ENTRY') throw err;
        // Collision — loop and try another code.
      }
    }

    if (!inserted) {
      throw Object.assign(
        new Error(
          `Could not find a free code after ${ACCESS_CODE.COLLISION_RETRIES} attempts. ` +
          `The ${ACCESS_CODE.LENGTH}-digit keyspace may be saturated.`,
        ),
        { status: 507 },
      );
    }
  }

  return { batchId, count: created.length, codes: created };
}

/**
 * Redeem a code for a student, activating them.
 *
 * Everything happens in one transaction with the code row locked FOR UPDATE.
 * Without the lock, two students submitting the same code within a few
 * milliseconds both read it as unused and both get activated — one code, two
 * paid accounts.
 */
export async function redeemCode({ code, studentUserId }) {
  const normalised = String(code || '').trim();

  if (normalised.length !== ACCESS_CODE.LENGTH) {
    throw Object.assign(
      new Error(`Access code must be ${ACCESS_CODE.LENGTH} digits`),
      { status: 400, code: 'CODE_INVALID_FORMAT' },
    );
  }

  return transaction(async (conn) => {
    const [rows] = await conn.execute(
      'SELECT id, status, school_id, class_level FROM ls_access_code WHERE code = ? FOR UPDATE',
      [normalised],
    );
    const row = rows[0];

    // Same message for "no such code" and "wrong format" so the endpoint cannot
    // be used to test whether a given code exists.
    if (!row) {
      throw Object.assign(new Error('That code is not valid'), { status: 404, code: 'CODE_NOT_FOUND' });
    }
    if (row.status === CODE_STATUS.USED) {
      throw Object.assign(new Error('That code has already been used'), { status: 409, code: 'CODE_ALREADY_USED' });
    }
    if (row.status === CODE_STATUS.INACTIVE) {
      throw Object.assign(new Error('That code is no longer active'), { status: 409, code: 'CODE_INACTIVE' });
    }

    await conn.execute(
      `UPDATE ls_access_code SET status = ?, used_by = ?, used_at = NOW() WHERE id = ?`,
      [CODE_STATUS.USED, studentUserId, row.id],
    );

    await conn.execute(
      `UPDATE ls_user SET status = ?, activated_at = NOW() WHERE id = ?`,
      [USER_STATUS.ACTIVE, studentUserId],
    );

    // A code carrying a school and class overrides what the student typed at
    // registration. The school bought the code and knows which class it is for;
    // a child guessing "class 10" should not unlock class 10 content.
    const sets = ['access_code_id = ?'];
    const params = [row.id];
    if (row.school_id) { sets.push('school_id = ?'); params.push(row.school_id); }
    if (row.class_level) { sets.push('class_level = ?'); params.push(row.class_level); }
    params.push(studentUserId);

    await conn.execute(`UPDATE ls_student_profile SET ${sets.join(', ')} WHERE user_id = ?`, params);

    await conn.execute(
      `INSERT INTO ls_audit_log (actor_id, action, entity_type, entity_id, detail)
       VALUES (?, 'code.redeem', 'access_code', ?, ?)`,
      [studentUserId, String(row.id), JSON.stringify({ schoolId: row.school_id, classLevel: row.class_level })],
    );

    return { codeId: row.id, schoolId: row.school_id, classLevel: row.class_level };
  });
}

/** Dashboard tiles: total / used / unused / inactive. */
export async function codeStats() {
  const rows = await query(
    `SELECT status, COUNT(*) AS n FROM ls_access_code GROUP BY status`,
  );
  const by = Object.fromEntries(rows.map((r) => [r.status, Number(r.n)]));
  const used = by.used || 0;
  const unused = by.unused || 0;
  const inactive = by.inactive || 0;
  return { total: used + unused + inactive, used, unused, inactive };
}

/**
 * Reassign an unused code to a different school or class.
 * A used code is immutable — it is now a receipt of who activated with it.
 */
export async function reassignCode({ codeId, schoolId = null, classLevel = null, actorId = null }) {
  const row = await one('SELECT id, status FROM ls_access_code WHERE id = ?', [codeId]);
  if (!row) throw Object.assign(new Error('Code not found'), { status: 404 });
  if (row.status === CODE_STATUS.USED) {
    throw Object.assign(
      new Error('A used code cannot be reassigned — it records which student activated with it'),
      { status: 409 },
    );
  }

  await execute('UPDATE ls_access_code SET school_id = ?, class_level = ? WHERE id = ?', [schoolId, classLevel, codeId]);
  await execute(
    `INSERT INTO ls_audit_log (actor_id, action, entity_type, entity_id, detail)
     VALUES (?, 'code.reassign', 'access_code', ?, ?)`,
    [actorId, String(codeId), JSON.stringify({ schoolId, classLevel })],
  );
  return { id: codeId, schoolId, classLevel };
}
