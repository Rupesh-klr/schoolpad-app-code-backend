import http from 'node:http';

/**
 * Entry point.
 *
 * The port is bound in the first few milliseconds, before anything heavy is
 * loaded. Managed Node hosts watch for a listener within a short window —
 * Hostinger allows 3 seconds — and importing the whole app first takes about a
 * second on a fast SSD, which is not a margin on shared hosting.
 *
 * So: listen immediately with a placeholder handler, load the real app in the
 * background, then swap it in. Requests that arrive during the gap get a 503
 * saying the app is starting rather than a refused connection, and a failure to
 * load becomes a readable message on every request instead of a process that
 * vanished before it could log anything.
 */

const PORT = Number(process.env.PORT || 8100);
const HOST = '0.0.0.0';

/** Swapped for the Express app once it has loaded. */
let handler = (req, res) => {
  res.writeHead(503, { 'Content-Type': 'application/json', 'Retry-After': '2' });
  res.end(JSON.stringify({ error: 'The API is still starting', code: 'STARTING' }));
};

const server = http.createServer((req, res) => handler(req, res));

server.on('error', (err) => {
  if (err.code === 'EADDRINUSE') {
    console.error(`\n  x Port ${PORT} is already in use.\n`);
  } else {
    console.error('\n  x Server error:', err.message, '\n');
  }
  process.exit(1);
});

server.listen(PORT, HOST, () => {
  console.log('');
  console.log('  Learning Platform API');
  console.log(`  > listening on ${HOST}:${PORT}`);
  if (!process.env.PORT) {
    console.log(`  > PORT was not set; using ${PORT}. On a managed host, leave`);
    console.log('    PORT unset and let the platform assign it.');
  }
  console.log('  > loading application...');
  boot();
});

/**
 * Load the application and take over request handling.
 *
 * Every import is inside the try: config/index.js throws by design when a
 * required secret is missing, and letting that propagate would kill a process
 * that has already bound its port — turning a fixable configuration mistake
 * back into the silent startup failure this file exists to avoid.
 */
async function boot() {
  const started = Date.now();

  try {
    const { config } = await import('./config/index.js');
    const { createApp } = await import('./app.js');
    const { healthCheck, pool } = await import('./config/db.js');
    const { purgeOldChallenges } = await import('./services/otp.js');

    handler = createApp();

    console.log(`  > ready in ${Date.now() - started} ms`);
    console.log(`  > env        ${config.env}`);
    console.log(`  > otp        ${config.otp.provider}`);
    console.log(`  > storage    ${config.storage.driver} (${config.storage.uploadDir})`);
    console.log(`  > database   ${config.db.user}@${config.db.host}:${config.db.port}/${config.db.database}`);
    console.log(`  > cors       ${config.corsOrigins.join(', ') || '(any origin - set CORS_ORIGIN)'}`);
    console.log('');

    // After the handler is live, never before. A slow or unreachable database
    // must not delay the app becoming able to answer.
    healthCheck()
      .then((db) => {
        if (db.up) {
          console.log(`  > database reachable (${db.name})`);
        } else {
          console.warn(`  ! database unreachable (${db.error})`);
          console.warn('    The API is up; /api/health reports degraded.');
        }
        console.log('');
      })
      .catch(() => {});

    const HOUR = 60 * 60 * 1000;
    setInterval(() => {
      purgeOldChallenges(7)
        .then((n) => { if (n) console.log(`[cleanup] removed ${n} old OTP challenges`); })
        .catch((err) => console.warn('[cleanup] failed:', err.message));
    }, 6 * HOUR).unref();

    installShutdown(pool);
  } catch (err) {
    const message = err?.message || String(err);

    console.error('');
    console.error('  ================================================');
    console.error('  The API could not finish starting.');
    console.error('  ================================================');
    console.error('');
    console.error(`  ${message}`);
    console.error('');
    console.error('  Under NODE_ENV=production the API requires:');
    console.error('    - JWT_SECRET and JWT_REFRESH_SECRET, set and different');
    console.error('    - OTP_PROVIDER set to something other than "console"');
    console.error('');
    if (err?.stack) console.error(err.stack.split('\n').slice(1, 4).join('\n'));
    console.error('');

    // Stay listening and report the reason on every request. The process
    // exiting here is what produced "app did not call listen()" with no
    // explanation; this way the cause is visible from a browser.
    handler = (req, res) => {
      res.writeHead(500, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({
        error: 'The API failed to start',
        code: 'STARTUP_FAILED',
        reason: message,
      }));
    };

    installShutdown(null);
  }
}

function installShutdown(pool) {
  const shutdown = (signal) => {
    console.log(`${signal} received - shutting down`);
    server.close(async () => {
      if (pool) await pool.end().catch(() => {});
      process.exit(0);
    });
    setTimeout(() => process.exit(1), 10000).unref();
  };

  process.on('SIGTERM', () => shutdown('SIGTERM'));
  process.on('SIGINT', () => shutdown('SIGINT'));
}

// Without these a rejected promise prints a warning and leaves the process in
// an unknown state, which on a managed host reads as a silent hang.
process.on('unhandledRejection', (reason) => console.error('[unhandledRejection]', reason));
process.on('uncaughtException', (err) => console.error('[uncaughtException]', err));
