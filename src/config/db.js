import mysql from 'mysql2/promise';
import { config } from './index.js';

/**
 * One shared pool for the process.
 *
 * `dateStrings` is on deliberately: MySQL DATE columns become JS Date objects
 * otherwise, and the driver reinterprets them in the server's local timezone.
 * A student registered on the 1st in IST then reads back as the 31st in UTC.
 * Keeping them as strings means a date is whatever the database says it is.
 */
export const pool = mysql.createPool({
  host: config.db.host,
  port: config.db.port,
  user: config.db.user,
  password: config.db.password,
  database: config.db.database,
  waitForConnections: true,
  connectionLimit: 10,
  queueLimit: 0,
  dateStrings: ['DATE'],
  timezone: 'Z',
  charset: 'utf8mb4_general_ci',

  /*
   * Bound how long a connection attempt can hang.
   *
   * The driver's default is long enough that an unreachable host - a wrong
   * DB_HOST, a firewall dropping packets rather than refusing them - makes
   * every request wait instead of failing. A refused connection errors in
   * milliseconds; a silently dropped one waits for a TCP timeout, which is the
   * case this covers.
   */
  connectTimeout: 8000,
});

/** Run a query, return rows. */
export async function query(sql, params = []) {
  const [rows] = await pool.query(sql, params);
  return rows;
}

/** Run a prepared statement, return rows (or the OkPacket for writes). */
export async function execute(sql, params = []) {
  const [result] = await pool.execute(sql, params);
  return result;
}

/** First row or null. */
export async function one(sql, params = []) {
  const rows = await query(sql, params);
  return rows[0] ?? null;
}

/**
 * Run `fn` inside a transaction, rolling back on any throw.
 *
 * Redeeming an access code touches three tables and must not half-apply: a
 * student marked active against a code that was never marked used hands out a
 * second free activation.
 */
export async function transaction(fn) {
  const conn = await pool.getConnection();
  try {
    await conn.beginTransaction();
    const result = await fn(conn);
    await conn.commit();
    return result;
  } catch (err) {
    await conn.rollback();
    throw err;
  } finally {
    conn.release();
  }
}

/**
 * Is the database reachable?
 *
 * Races the query against a short deadline. /api/health is what a load balancer
 * or a managed host polls to decide whether the process is alive, so it has to
 * answer quickly even when the database does not — an endpoint that hangs for
 * the length of a TCP timeout is indistinguishable from a dead app, and gets
 * the container killed for a fault that is not its own.
 */
export async function healthCheck(timeoutMs = 2000) {
  const base = { host: config.db.host, name: config.db.database };

  let timer;
  const deadline = new Promise((resolve) => {
    timer = setTimeout(() => resolve({ ...base, up: false, error: 'TIMEOUT' }), timeoutMs);
  });

  const probe = pool.query('SELECT 1')
    .then(() => ({ ...base, up: true }))
    .catch((err) => ({ ...base, up: false, error: err.code || err.message }));

  try {
    return await Promise.race([probe, deadline]);
  } finally {
    clearTimeout(timer);
  }
}
