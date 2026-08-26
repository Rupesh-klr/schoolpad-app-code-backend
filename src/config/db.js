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

export async function healthCheck() {
  try {
    await pool.query('SELECT 1');
    return { up: true, host: config.db.host, name: config.db.database };
  } catch (err) {
    return { up: false, host: config.db.host, name: config.db.database, error: err.code || err.message };
  }
}
