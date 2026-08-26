import crypto from 'node:crypto';
import { OTP } from '../config/constants.js';
import { config } from '../config/index.js';
import { execute, one } from '../config/db.js';
import { sha256 } from './password.js';

/**
 * OTP issue and verify.
 *
 * Codes are stored as SHA-256 digests, never in plaintext. This table is the
 * highest-value thing in the database for an attacker with read access — every
 * row is a live key to somebody's account for the next five minutes.
 *
 * SHA-256 rather than bcrypt here: the code is 6 digits from a 10-second window
 * and is rate-limited to 5 attempts, so the work factor buys nothing, and OTP
 * verification sits on the login hot path where 250ms per attempt would hurt.
 */

/** Phone or email? Decides the delivery channel and normalisation. */
export function classifyIdentifier(identifier) {
  const raw = String(identifier || '').trim();
  if (!raw) throw Object.assign(new Error('Identifier is required'), { status: 400 });

  if (raw.includes('@')) {
    const email = raw.toLowerCase();
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
      throw Object.assign(new Error('That email address does not look valid'), { status: 400 });
    }
    return { type: 'email', value: email, channel: 'email' };
  }

  // Keep a leading +, drop spaces, dashes and brackets.
  const phone = raw.replace(/[^\d+]/g, '');
  if (!/^\+?\d{8,15}$/.test(phone)) {
    throw Object.assign(new Error('That phone number does not look valid'), { status: 400 });
  }
  return {
    type: 'phone',
    value: phone,
    channel: config.otp.provider === 'whatsapp' ? 'whatsapp' : 'sms',
  };
}

function generateOtp() {
  // randomInt over the full range, so every code including 000000 is possible
  // and equally likely. Padding a smaller random number would skew the
  // distribution toward codes with leading digits.
  return String(crypto.randomInt(0, 10 ** OTP.LENGTH)).padStart(OTP.LENGTH, '0');
}

/**
 * Create and send an OTP.
 *
 * Returns metadata only. The code itself is never in the response body — that
 * would make the whole exchange pointless, since anyone able to call the
 * endpoint could read the code they were meant to receive out-of-band.
 */
export async function requestOtp(identifier) {
  const id = classifyIdentifier(identifier);

  // Cooldown, so the endpoint cannot be used to bombard someone's phone.
  const recent = await one(
    `SELECT created_at FROM ls_otp_challenge
      WHERE identifier = ?
        AND created_at > (NOW() - INTERVAL ? SECOND)
      ORDER BY id DESC LIMIT 1`,
    [id.value, OTP.RESEND_COOLDOWN_SECONDS],
  );
  if (recent) {
    throw Object.assign(
      new Error(`Please wait ${OTP.RESEND_COOLDOWN_SECONDS} seconds before requesting another code`),
      { status: 429, code: 'OTP_COOLDOWN' },
    );
  }

  // Any earlier live challenge is burned. Two valid codes at once doubles the
  // guessing surface for no benefit.
  await execute(
    'UPDATE ls_otp_challenge SET consumed_at = NOW() WHERE identifier = ? AND consumed_at IS NULL',
    [id.value],
  );

  const code = generateOtp();
  await execute(
    `INSERT INTO ls_otp_challenge (identifier, channel, code_hash, expires_at)
     VALUES (?, ?, ?, (NOW() + INTERVAL ? SECOND))`,
    [id.value, id.channel, sha256(code), OTP.TTL_SECONDS],
  );

  await deliver(id, code);

  return {
    identifier: id.value,
    identifierType: id.type,
    channel: id.channel,
    expiresInSeconds: OTP.TTL_SECONDS,
    length: OTP.LENGTH,

    /**
     * The code itself, but only when it is already being printed to the console.
     *
     * `OTP_PROVIDER=console` means the code is going to the server log in
     * plaintext anyway, so returning it here reveals nothing new — and it saves
     * hunting through a terminal on every sign-in during development, and lets
     * automated tests run without scraping logs.
     *
     * config/index.js refuses to boot with provider=console under
     * NODE_ENV=production, so this field can never appear on a real server.
     * The double guard is deliberate: one of them failing should not be enough.
     */
    ...(config.otp.provider === 'console' && !config.isProd ? { devCode: code } : {}),
  };
}

/**
 * Check a submitted code.
 *
 * Attempts are counted on the challenge row, so five wrong guesses burn it and
 * the caller has to request a new one. Without that, six digits falls to a
 * script in under a minute.
 */
export async function verifyOtp(identifier, code) {
  const id = classifyIdentifier(identifier);

  const challenge = await one(
    `SELECT id, code_hash, attempts, expires_at
       FROM ls_otp_challenge
      WHERE identifier = ? AND consumed_at IS NULL
      ORDER BY id DESC LIMIT 1`,
    [id.value],
  );

  if (!challenge) {
    throw Object.assign(new Error('Request a new code'), { status: 400, code: 'OTP_NOT_FOUND' });
  }
  if (new Date(challenge.expires_at) < new Date()) {
    await execute('UPDATE ls_otp_challenge SET consumed_at = NOW() WHERE id = ?', [challenge.id]);
    throw Object.assign(new Error('That code has expired'), { status: 400, code: 'OTP_EXPIRED' });
  }
  if (challenge.attempts >= OTP.MAX_ATTEMPTS) {
    await execute('UPDATE ls_otp_challenge SET consumed_at = NOW() WHERE id = ?', [challenge.id]);
    throw Object.assign(new Error('Too many attempts — request a new code'), { status: 429, code: 'OTP_LOCKED' });
  }

  if (sha256(String(code || '').trim()) !== challenge.code_hash) {
    await execute('UPDATE ls_otp_challenge SET attempts = attempts + 1 WHERE id = ?', [challenge.id]);
    const left = OTP.MAX_ATTEMPTS - (challenge.attempts + 1);
    throw Object.assign(
      new Error(left > 0 ? `Incorrect code — ${left} attempt${left === 1 ? '' : 's'} left` : 'Incorrect code'),
      { status: 400, code: 'OTP_INCORRECT' },
    );
  }

  // Single-use: consumed the moment it succeeds.
  await execute('UPDATE ls_otp_challenge SET consumed_at = NOW() WHERE id = ?', [challenge.id]);

  return id;
}

/**
 * Send the code.
 *
 * `console` is the development default and prints to the server log — which is
 * why config/index.js refuses to boot with it in production.
 */
async function deliver(id, code) {
  switch (config.otp.provider) {
    case 'whatsapp':
      return deliverWhatsApp(id.value, code);
    case 'smtp':
      return deliverEmail(id.value, code);
    case 'console':
    default:
      console.log(`\n  ┌─ OTP ─────────────────────────────`);
      console.log(`  │  to    ${id.value}`);
      console.log(`  │  code  ${code}`);
      console.log(`  │  valid ${OTP.TTL_SECONDS}s`);
      console.log(`  └───────────────────────────────────\n`);
      return { delivered: true, via: 'console' };
  }
}

async function deliverWhatsApp(to, code) {
  const { phoneNumberId, accessToken, templateName } = config.otp.whatsapp;
  if (!phoneNumberId || !accessToken || !templateName) {
    throw Object.assign(new Error('WhatsApp OTP is not configured'), { status: 500 });
  }

  const res = await fetch(`https://graph.facebook.com/v21.0/${phoneNumberId}/messages`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${accessToken}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      messaging_product: 'whatsapp',
      to: to.replace(/^\+/, ''),
      type: 'template',
      template: {
        name: templateName,
        language: { code: 'en' },
        components: [
          { type: 'body', parameters: [{ type: 'text', text: code }] },
          // AUTHENTICATION templates carry a copy-code button, and Meta rejects
          // the send with error 132000 if this component is missing.
          { type: 'button', sub_type: 'url', index: '0', parameters: [{ type: 'text', text: code }] },
        ],
      },
    }),
  });

  const body = await res.json().catch(() => ({}));
  if (!res.ok) {
    // Never log `code` alongside the failure — the log would then hold the OTP.
    console.error('[otp] whatsapp send failed:', body?.error?.message || res.status);
    throw Object.assign(new Error('Could not send the code. Please try again.'), { status: 502 });
  }
  return { delivered: true, via: 'whatsapp' };
}

async function deliverEmail(to, code) {
  // Intentionally not wired to a mail library. nodemailer is one npm install
  // away, but leaving this explicit means nobody ships thinking email works.
  console.warn(`[otp] SMTP delivery not implemented — code for ${to} was not sent`);
  throw Object.assign(
    new Error('Email OTP delivery is not configured on this server'),
    { status: 501 },
  );
}

/** Housekeeping. Consumed and expired challenges have no value after the day. */
export async function purgeOldChallenges(days = 7) {
  const res = await execute(
    'DELETE FROM ls_otp_challenge WHERE created_at < (NOW() - INTERVAL ? DAY)',
    [days],
  );
  return res.affectedRows;
}
