import bcrypt from 'bcryptjs';
import crypto from 'node:crypto';
import { PASSWORD } from '../config/constants.js';

/**
 * Password hashing.
 *
 * bcrypt, not AES with a key. Encryption is reversible by design — anyone
 * holding the key can read every password back out, which is exactly what must
 * be impossible. bcrypt is a one-way hash with a per-password salt baked into
 * the output and a tunable work factor, so two students who both pick
 * "password1" get different stored values and a stolen table is expensive to
 * attack offline.
 *
 * The "encryption key" in the spec is really two separate things, and both are
 * handled elsewhere: JWT_SECRET signs tokens, and TLS encrypts the password in
 * transit. Neither belongs in this file.
 */

export async function hashPassword(plain) {
  if (typeof plain !== 'string' || plain.length < PASSWORD.MIN_LENGTH) {
    throw Object.assign(
      new Error(`Password must be at least ${PASSWORD.MIN_LENGTH} characters`),
      { status: 400 },
    );
  }
  return bcrypt.hash(plain, PASSWORD.BCRYPT_ROUNDS);
}

/**
 * Verify a password.
 *
 * When the user has no stored hash — every student, who signs in by OTP — this
 * still runs a bcrypt comparison against a dummy hash before returning false.
 * Returning early instead would make a wrong-password attempt measurably slower
 * than an unknown-account attempt, which is enough to enumerate who has an
 * account.
 */
const DUMMY_HASH = bcrypt.hashSync('timing-equalizer', PASSWORD.BCRYPT_ROUNDS);

export async function verifyPassword(plain, hash) {
  if (!hash) {
    await bcrypt.compare(plain || '', DUMMY_HASH);
    return false;
  }
  return bcrypt.compare(plain || '', hash);
}

/** SHA-256 hex. Used for refresh tokens and OTP codes, not for passwords. */
export function sha256(value) {
  return crypto.createHash('sha256').update(String(value)).digest('hex');
}

/**
 * Constant-time string comparison, for anything secret compared by equality.
 * `a === b` short-circuits at the first differing byte and leaks the length of
 * the matching prefix through timing.
 */
export function timingSafeEqual(a, b) {
  const bufA = Buffer.from(String(a));
  const bufB = Buffer.from(String(b));
  if (bufA.length !== bufB.length) return false;
  return crypto.timingSafeEqual(bufA, bufB);
}
