/**
 * Entry point.
 *
 * `listen()` is called at the top level and as early as possible — no
 * `require.main === module` guard, which several Node hosts do not support.
 *
 * Everything that can fail at import time is loaded through dynamic import
 * inside a try/catch. config/index.js deliberately throws when a required
 * secret is missing, and a bare ESM import of it would kill the process before
 * a single line was logged. The host then reports only "app did not call
 * listen()", which says nothing about the actual cause. Catching it here means
 * the real reason is the first thing in the log.
 */

async function main() {
  let config;
  let createApp;
  let healthCheck;
  let pool;
  let purgeOldChallenges;

  try {
    ({ config } = await import('./config/index.js'));
    ({ createApp } = await import('./app.js'));
    ({ healthCheck, pool } = await import('./config/db.js'));
    ({ purgeOldChallenges } = await import('./services/otp.js'));
  } catch (err) {
    console.error('');
    console.error('  ================================================');
    console.error('  The API could not start.');
    console.error('  ================================================');
    console.error('');
    console.error(`  ${err.message}`);
    console.error('');
    console.error('  Most often this is a missing environment variable.');
    console.error('  Under NODE_ENV=production the API also requires:');
    console.error('    - JWT_SECRET and JWT_REFRESH_SECRET, different values');
    console.error('    - OTP_PROVIDER set to something other than "console"');
    console.error('');
    if (err.stack) console.error(err.stack.split('\n').slice(1, 4).join('\n'));
    console.error('');
    process.exit(1);
    return;
  }

  const app = createApp();

  /**
   * Hosts assign the port and watch for a listener on it, so `process.env.PORT`
   * must win. Setting PORT by hand in a host's own env panel is a common way to
   * break this: the app then binds a port nobody is watching, and the host
   * reports the app as never having started.
   */
  const port = config.port;

  const server = app.listen(port, '0.0.0.0', () => {
    console.log('');
    console.log('  Learning Platform API');
    console.log(`  > listening on 0.0.0.0:${port}`);
    console.log(`  > env        ${config.env}`);
    console.log(`  > otp        ${config.otp.provider}`);
    console.log(`  > storage    ${config.storage.driver} (${config.storage.uploadDir})`);
    console.log(`  > database   ${config.db.user}@${config.db.host}:${config.db.port}/${config.db.database}`);
    console.log(`  > cors       ${config.corsOrigins.join(', ') || '(any origin - set CORS_ORIGIN)'}`);
    console.log('');

    if (!process.env.PORT) {
      console.warn(`  ! PORT was not set, so ${port} was used as a fallback.`);
      console.warn('    On a managed host, remove any PORT you set by hand and');
      console.warn('    let the platform assign it.');
      console.warn('');
    }

    // Checked after listening, never before. A database that is slow or down
    // must not stop the process binding its port - the host would kill it for
    // failing to start, when the right outcome is a running API reporting
    // itself as degraded on /api/health.
    healthCheck()
      .then((db) => {
        if (db.up) console.log(`  > database reachable (${db.name})`);
        else {
          console.warn(`  ! database unreachable (${db.error})`);
          console.warn('    The API is up and /api/health will report degraded.');
        }
        console.log('');
      })
      .catch(() => {});
  });

  server.on('error', (err) => {
    if (err.code === 'EADDRINUSE') {
      console.error(`\n  x Port ${port} is already in use.\n`);
    } else {
      console.error('\n  x Server error:', err.message, '\n');
    }
    process.exit(1);
  });

  const HOUR = 60 * 60 * 1000;
  setInterval(() => {
    purgeOldChallenges(7)
      .then((n) => { if (n) console.log(`[cleanup] removed ${n} old OTP challenges`); })
      .catch((err) => console.warn('[cleanup] failed:', err.message));
  }, 6 * HOUR).unref();

  const shutdown = (signal) => {
    console.log(`${signal} received - shutting down`);
    server.close(async () => {
      await pool.end().catch(() => {});
      process.exit(0);
    });
    setTimeout(() => process.exit(1), 10000).unref();
  };

  process.on('SIGTERM', () => shutdown('SIGTERM'));
  process.on('SIGINT', () => shutdown('SIGINT'));

  // Without these a rejected promise anywhere prints a warning and leaves the
  // process in an unknown state; on a host that reads as a silent hang.
  process.on('unhandledRejection', (reason) => {
    console.error('[unhandledRejection]', reason);
  });
  process.on('uncaughtException', (err) => {
    console.error('[uncaughtException]', err);
    process.exit(1);
  });
}

main();
