#!/usr/bin/env node
import readline from 'node:readline/promises';
import { stdin, stdout } from 'node:process';
import { config } from '../src/config/index.js';
import { execute, one, pool } from '../src/config/db.js';
import { hashPassword } from '../src/services/password.js';
import { ROLES, USER_STATUS, PASSWORD } from '../src/config/constants.js';

/**
 * Create or reset an admin account, safely, on any database including
 * production.
 *
 *   npm run create-admin
 *   npm run create-admin -- --email you@example.com --password 'secret'
 *   npm run create-admin -- --email you@example.com --reset
 *
 * `npm run seed` deliberately refuses to run under NODE_ENV=production - it
 * inserts demo schools and content that are indistinguishable from real rows
 * three months later. But a production database still needs a first admin, and
 * that is all this does.
 *
 * Prompts when arguments are omitted, so a password need not appear in shell
 * history or in a hosting panel's command field.
 */

const args = process.argv.slice(2);

/**
 * Strip a matching pair of surrounding quotes.
 *
 * Windows cmd.exe does not treat single quotes as quoting, so
 * `--password 'secret'` arrives as the seven characters `'secret'`. The account
 * is then created with a password nobody can type, and the only symptom is
 * "Email or password is incorrect" on a fresh account — which reads as a bug in
 * the login, not in how the command was quoted.
 *
 * Only a matched pair is removed, so a password that legitimately starts or
 * ends with a quote is left alone.
 */
function unquote(value) {
  if (typeof value !== 'string' || value.length < 2) return value;
  const first = value[0];
  const last = value[value.length - 1];
  if ((first === "'" && last === "'") || (first === '"' && last === '"')) {
    return value.slice(1, -1);
  }
  return value;
}

const flag = (name) => {
  const i = args.indexOf(`--${name}`);
  if (i === -1) return null;
  const raw = args[i + 1];
  const clean = unquote(raw);
  if (raw !== clean) {
    console.log(`  note: stripped surrounding quotes from --${name} (Windows cmd passes them through)`);
  }
  return clean;
};

const has = (name) => args.includes(`--${name}`);

/**
 * True when there is a human at the other end.
 *
 * A CI job, a hosting panel's command box or a piped command has no TTY, and
 * prompting there fails with "readline was closed" — which says nothing about
 * the missing argument that actually caused it.
 */
const interactive = Boolean(stdin.isTTY);

async function ask(rl, question, { secret = false } = {}) {
  if (!interactive) {
    const name = question.trim().replace(/\s*:$/, '').toLowerCase();
    throw new Error(
      `No terminal to prompt on, and --${name} was not given.\n` +
      '    Pass every value as a flag when running non-interactively:\n' +
      "      npm run create-admin -- --email you@example.com --password 'secret' --name 'Your Name'",
    );
  }

  if (!secret) return (await rl.question(question)).trim();

  /*
   * Hide the password as it is typed.
   *
   * readline has no built-in masking, so the output stream is temporarily
   * muted. Without this the password stays visible in the terminal scrollback
   * of whoever ran it, which on a shared machine is the whole problem.
   */
  const onData = (char) => {
    if (['\n', '\r', ''].includes(char.toString())) stdout.write('\n');
    else stdout.write('*');
  };

  stdout.write(question);
  const wasRaw = stdin.isRaw;
  stdin.on('data', onData);
  rl.output.muted = true;

  const originalWrite = rl._writeToOutput?.bind(rl);
  rl._writeToOutput = () => {};

  const answer = await rl.question('');

  rl._writeToOutput = originalWrite;
  stdin.off('data', onData);
  if (wasRaw !== undefined) stdin.isRaw = wasRaw;

  return answer.trim();
}

async function main() {
  console.log('');
  console.log('  Create an admin account');
  console.log(`  database: ${config.db.user}@${config.db.host}:${config.db.port}/${config.db.database}`);
  console.log(`  env:      ${config.env}`);
  console.log('');

  const rl = readline.createInterface({ input: stdin, output: stdout });

  try {
    let email = flag('email');
    let password = flag('password');
    let name = flag('name');

    if (!email) email = await ask(rl, '  Email    : ');
    email = email.toLowerCase();

    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
      throw new Error(`"${email}" does not look like an email address`);
    }

    /*
     * One email, one role - enforced by a UNIQUE index on app_user.email.
     * Checking first turns the driver's generic duplicate-key error into the
     * one sentence that explains it.
     */
    const existing = await one('SELECT id, role, full_name FROM ls_user WHERE email = ?', [email]);

    if (existing && existing.role !== ROLES.ADMIN) {
      throw new Error(
        `That email already exists as a ${existing.role} account. One email, one role - use a different address.`,
      );
    }

    if (existing && !has('reset')) {
      console.log(`  ${email} is already an admin (${existing.full_name}).`);
      console.log('  Re-run with --reset to set a new password.');
      console.log('');
      return;
    }

    if (!password) password = await ask(rl, '  Password : ', { secret: true });
    if (password.length < PASSWORD.MIN_LENGTH) {
      throw new Error(`Password must be at least ${PASSWORD.MIN_LENGTH} characters`);
    }

    if (existing) {
      await execute('UPDATE ls_user SET password_hash = ? WHERE id = ?', [
        await hashPassword(password), existing.id,
      ]);

      // Their old sessions would otherwise keep working, which defeats the
      // point of resetting a password you believe is compromised.
      const revoked = await execute(
        'UPDATE ls_refresh_token SET revoked_at = NOW() WHERE user_id = ? AND revoked_at IS NULL',
        [existing.id],
      );

      console.log('');
      console.log(`  Password reset for ${email}`);
      console.log(`  ${revoked.affectedRows} existing session(s) ended`);
      console.log('');
      return;
    }

    // Only the email and password are worth refusing over. A name is
    // cosmetic, so it defaults rather than blocking a non-interactive run.
    if (!name) name = interactive ? (await ask(rl, '  Full name: ')) || 'Administrator' : 'Administrator';

    const result = await execute(
      `INSERT INTO ls_user (role, email, full_name, password_hash, status, activated_at)
       VALUES (?, ?, ?, ?, ?, NOW())`,
      [ROLES.ADMIN, email, name, await hashPassword(password), USER_STATUS.ACTIVE],
    );

    await execute(
      `INSERT INTO ls_audit_log (actor_id, action, entity_type, entity_id, detail)
       VALUES (?, 'admin.create', 'ls_user', ?, ?)`,
      [result.insertId, String(result.insertId), JSON.stringify({ email, via: 'create-admin script' })],
    );

    console.log('');
    console.log(`  Admin created: ${email}`);
    console.log('  Sign in at the dashboard with this address.');
    console.log('');
  } finally {
    rl.close();
    await pool.end().catch(() => {});
  }
}

main().catch(async (err) => {
  console.error('');
  console.error(`  x ${err.message}`);
  console.error('');
  await pool.end().catch(() => {});
  process.exit(1);
});
