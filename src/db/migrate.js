#!/usr/bin/env node
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import mysql from 'mysql2/promise';
import { config } from '../config/index.js';

/**
 * Creates the database if absent, then applies schema.sql.
 *
 *   npm run migrate
 *   npm run migrate -- --drop     # drop this app's ls_ tables and rebuild
 *
 * Every statement in schema.sql is IF NOT EXISTS, so this is safe to re-run.
 *
 * This schema shares `acastahealthapp` with the Spring backend, which owns
 * `user`, `otp`, `question` and a dozen more. Every table here is prefixed
 * `ls_` so the two cannot collide — and `--drop` drops only those, never the
 * database. Dropping the database would take the Spring app's data with it.
 */

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DROP = process.argv.includes('--drop');

if (DROP && config.isProd) {
  console.error('✖ --drop refused: NODE_ENV=production');
  process.exit(1);
}

/**
 * Columns added after a table first shipped.
 *
 * schema.sql is CREATE TABLE IF NOT EXISTS, which does nothing to a table that
 * already exists — so a new column never reaches an existing database. MySQL
 * has no ADD COLUMN IF NOT EXISTS, so each one is checked against
 * information_schema first, which keeps `npm run migrate` re-runnable.
 */
const COLUMN_ADDITIONS = [
  {
    table: 'ls_content_node',
    column: 'school_id',
    ddl: 'ADD COLUMN school_id BIGINT UNSIGNED NULL AFTER parent_id, '
       + 'ADD KEY idx_ls_node_school (school_id, class_level)',
    why: 'content can belong to one school; NULL means shared by all',
  },
];

async function applyColumnAdditions(conn, database) {
  let added = 0;
  for (const c of COLUMN_ADDITIONS) {
    const [[exists]] = await conn.query(
      `SELECT COUNT(*) AS n FROM information_schema.COLUMNS
        WHERE TABLE_SCHEMA = ? AND TABLE_NAME = ? AND COLUMN_NAME = ?`,
      [database, c.table, c.column],
    );
    if (Number(exists.n) > 0) continue;

    // The table may not exist yet on a fresh database — schema.sql runs first,
    // so by this point it does, but a mistyped name should not be fatal.
    const [[table]] = await conn.query(
      `SELECT COUNT(*) AS n FROM information_schema.TABLES
        WHERE TABLE_SCHEMA = ? AND TABLE_NAME = ?`,
      [database, c.table],
    );
    if (Number(table.n) === 0) continue;

    await conn.query(`ALTER TABLE \`${c.table}\` ${c.ddl}`);
    console.log(`  ▸ ${c.table}.${c.column} added — ${c.why}`);
    added += 1;
  }
  return added;
}

/** Every ls_ table, children before parents so foreign keys do not block. */
async function dropOwnTables(conn, database) {
  const [rows] = await conn.query(
    `SELECT TABLE_NAME FROM information_schema.TABLES
      WHERE TABLE_SCHEMA = ? AND TABLE_NAME LIKE 'ls\\_%'`,
    [database],
  );
  const names = rows.map((r) => r.TABLE_NAME || r.table_name);

  if (!names.length) {
    console.log('  ▸ no ls_ tables to drop');
    return 0;
  }

  // Toggling the FK check is what lets one unordered DROP handle a graph with
  // cycles; working out a safe order per run would be busywork for the same
  // result. Restored immediately after, whatever happens.
  await conn.query('SET FOREIGN_KEY_CHECKS = 0');
  try {
    for (const name of names) await conn.query(`DROP TABLE IF EXISTS \`${name}\``);
  } finally {
    await conn.query('SET FOREIGN_KEY_CHECKS = 1');
  }

  console.log(`  ▸ dropped ${names.length} ls_ tables: ${names.join(', ')}`);
  return names.length;
}

/**
 * Split a SQL file into statements.
 *
 * Line comments are stripped first — a `--` containing a semicolon would
 * otherwise split a statement in half and produce a syntax error that points
 * at the wrong line.
 */
function statements(sql) {
  return sql
    .split(/\r?\n/)
    .filter((line) => !line.trim().startsWith('--'))
    .join('\n')
    .split(';')
    .map((s) => s.trim())
    .filter(Boolean);
}

async function main() {
  const { host, port, user, password, database } = config.db;

  // Connect without a database selected — it may not exist yet.
  const root = await mysql.createConnection({ host, port, user, password, multipleStatements: false });
  await root.query(
    `CREATE DATABASE IF NOT EXISTS \`${database}\` CHARACTER SET utf8mb4 COLLATE utf8mb4_general_ci`,
  );
  await root.end();

  const conn = await mysql.createConnection({ host, port, user, password, database });

  // Report the neighbours before touching anything, so a shared database is
  // visible in the output rather than a surprise later.
  const [existing] = await conn.query('SHOW TABLES');
  const all = existing.map((r) => Object.values(r)[0]);
  const foreign = all.filter((t) => !t.startsWith('ls_'));
  if (foreign.length) {
    console.log(`\n  ⓘ ${database} is shared — ${foreign.length} table(s) belong to another app:`);
    console.log(`    ${foreign.join(', ')}`);
    console.log('    Those are never touched. This app owns ls_* only.');
  }

  if (DROP) await dropOwnTables(conn, database);

  const sql = fs.readFileSync(path.join(__dirname, 'schema.sql'), 'utf8');
  const stmts = statements(sql);

  let created = 0;
  for (const stmt of stmts) {
    try {
      await conn.query(stmt);
      created += 1;
    } catch (err) {
      console.error(`\n✖ Failed on statement ${created + 1}:\n${stmt.slice(0, 200)}...\n`);
      throw err;
    }
  }

  await applyColumnAdditions(conn, database);

  const [after] = await conn.query('SHOW TABLES');
  await conn.end();

  const ours = after.map((t) => Object.values(t)[0]).filter((t) => t.startsWith('ls_'));

  console.log(`\n  ✔ ${database} — ${stmts.length} statements applied`);
  console.log(`    ${ours.length} ls_ tables owned by this app:`);
  for (const t of ours) console.log(`      ${t}`);
  console.log('\n  Next: npm run seed\n');
}

main().catch((err) => {
  console.error('✖ Migration failed:', err.message);
  process.exit(1);
});
