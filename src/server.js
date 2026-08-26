import { createApp } from './app.js';
import { config } from './config/index.js';
import { healthCheck, pool } from './config/db.js';
import { purgeOldChallenges } from './services/otp.js';

const app = createApp();

const server = app.listen(config.port, '0.0.0.0', async () => {
  const db = await healthCheck();

  console.log('');
  console.log('  Learning Platform API');
  console.log(`  ▸ http://localhost:${config.port}`);
  console.log(`  ▸ env        ${config.env}`);
  console.log(`  ▸ otp        ${config.otp.provider}`);
  console.log(`  ▸ storage    ${config.storage.driver} (${config.storage.uploadDir})`);
  console.log(`  ▸ database   ${config.db.user}@${config.db.host}:${config.db.port}/${config.db.database}`);
  console.log(`  ▸ cors       ${config.corsOrigins.join(', ') || '(any)'}`);
  console.log('');

  if (!db.up) {
    console.log(`  ✖ database unreachable (${db.error})`);
    console.log('    Start MySQL, then run: npm run migrate && npm run seed');
    console.log('');
  }
});

/**
 * Housekeeping.
 *
 * Consumed and expired OTP challenges are dead weight, and the table is the
 * one an attacker most wants. `unref` so a pending timer never holds the
 * process open during a shutdown.
 */
const HOUR = 60 * 60 * 1000;
setInterval(() => {
  purgeOldChallenges(7)
    .then((n) => { if (n) console.log(`[cleanup] removed ${n} old OTP challenges`); })
    .catch((err) => console.warn('[cleanup] failed:', err.message));
}, 6 * HOUR).unref();

/**
 * Graceful shutdown.
 *
 * systemd sends SIGTERM on restart. Closing the listener first lets in-flight
 * requests finish; draining the pool after avoids a burst of connection errors
 * in the log on every deploy.
 */
const shutdown = (signal) => {
  console.log(`${signal} received — shutting down`);
  server.close(async () => {
    await pool.end().catch(() => {});
    process.exit(0);
  });
  // If something is wedged, do not hang the deploy forever.
  setTimeout(() => process.exit(1), 10000).unref();
};

process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT', () => shutdown('SIGINT'));
