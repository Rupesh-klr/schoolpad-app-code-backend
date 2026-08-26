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
 *   npm run migrate -- --drop     # destroy and rebuild (development only)
 *
 * Every statement in schema.sql is IF NOT EXISTS, so this is safe to re-run.
 */

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DROP = process.argv.includes('--drop');

if (DROP && config.isProd) {
  console.error('✖ --drop refused: NODE_ENV=production');
  process.exit(1);
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

  if (DROP) {
    console.log(`  ▸ dropping database ${database}`);
    await root.query(`DROP DATABASE IF EXISTS \`${database}\``);
  }

  await root.query(
    `CREATE DATABASE IF NOT EXISTS \`${database}\` CHARACTER SET utf8mb4 COLLATE utf8mb4_general_ci`,
  );
  await root.end();

  const conn = await mysql.createConnection({ host, port, user, password, database });
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

  const [tables] = await conn.query('SHOW TABLES');
  await conn.end();

  console.log(`\n  ✔ ${database} — ${stmts.length} statements applied, ${tables.length} tables present`);
  for (const t of tables) console.log(`      ${Object.values(t)[0]}`);
  console.log('\n  Next: npm run seed\n');
}

main().catch((err) => {
  console.error('✖ Migration failed:', err.message);
  process.exit(1);
});
