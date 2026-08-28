/**
 * Entry point for managed Node hosts. This is the file to point a host at.
 *
 * CommonJS on purpose, despite the package being `"type": "module"`:
 *
 *   - Hostinger's error text names `require.main === module`, so its loader
 *     uses `require()`. Node only supports `require()` of an ES module from
 *     22.x, and the host is set to Node 20 — an ESM entry would fail there
 *     while working fine on a 22.x laptop, which is the worst way to find out.
 *   - `import()` works from CommonJS on every supported version, so the ESM
 *     application still loads normally.
 *
 * Two properties matter here and nowhere else:
 *
 *   1. The port binds in the first few milliseconds. Hosts watch for a listener
 *      within a short window — Hostinger allows 3 seconds — and importing the
 *      app first costs about a second on a fast SSD, which is no margin at all
 *      on shared hosting.
 *
 *   2. A failure to load never kills the process. config/index.js throws by
 *      design when a required secret is missing; exiting there is what turns a
 *      fixable configuration mistake into "the app did not start" with no
 *      explanation anywhere.
 */

const http = require('http');
const path = require('path');
const { pathToFileURL } = require('url');

const PORT = Number(process.env.PORT || 8100);
const HOST = '0.0.0.0';

/** Replaced by the Express app once it has loaded. */
let handler = (req, res) => {
  res.writeHead(503, { 'Content-Type': 'application/json', 'Retry-After': '2' });
  res.end(JSON.stringify({ error: 'The API is still starting', code: 'STARTING' }));
};

const server = http.createServer((req, res) => handler(req, res));

server.on('error', (err) => {
  console.error(
    err.code === 'EADDRINUSE'
      ? `\n  x Port ${PORT} is already in use.\n`
      : `\n  x Server error: ${err.message}\n`,
  );
  process.exit(1);
});

server.listen(PORT, HOST, () => {
  console.log('');
  console.log('  Learning Platform API');
  console.log(`  > listening on ${HOST}:${PORT}`);
  console.log(`  > node ${process.version}`);
  if (!process.env.PORT) {
    console.log(`  > PORT was not set; using ${PORT}. On a managed host, leave`);
    console.log('    PORT unset and let the platform assign it.');
  }
  console.log('  > loading application...');
  boot();
});

/**
 * Load the ESM application and take over request handling.
 *
 * Specifiers are absolute file URLs: a bare relative path in a dynamic import
 * resolves against the current working directory on some loaders, and a host
 * does not always start the process in the project root.
 */
function boot() {
  const started = Date.now();
  const url = (rel) => pathToFileURL(path.join(__dirname, rel)).href;

  Promise.all([
    import(url('src/config/index.js')),
    import(url('src/app.js')),
    import(url('src/config/db.js')),
    import(url('src/services/otp.js')),
  ])
    .then(([configMod, appMod, dbMod, otpMod]) => {
      const { config } = configMod;
      handler = appMod.createApp();

      console.log(`  > ready in ${Date.now() - started} ms`);
      console.log(`  > env        ${config.env}`);
      console.log(`  > otp        ${config.otp.provider}`);
      console.log(`  > storage    ${config.storage.driver} (${config.storage.uploadDir})`);
      console.log(`  > database   ${config.db.user}@${config.db.host}:${config.db.port}/${config.db.database}`);
      console.log(`  > cors       ${config.corsOrigins.join(', ') || '(any origin - set CORS_ORIGIN)'}`);
      console.log('');

      // After the handler is live, never before: a slow or unreachable database
      // must not delay the app becoming able to answer.
      dbMod.healthCheck()
        .then((db) => {
          if (db.up) console.log(`  > database reachable (${db.name})\n`);
          else {
            console.warn(`  ! database unreachable (${db.error})`);
            console.warn('    The API is up; /api/health reports degraded.\n');
          }
        })
        .catch(() => {});

      const HOUR = 60 * 60 * 1000;
      setInterval(() => {
        otpMod.purgeOldChallenges(7)
          .then((n) => { if (n) console.log(`[cleanup] removed ${n} old OTP challenges`); })
          .catch((err) => console.warn('[cleanup] failed:', err.message));
      }, 6 * HOUR).unref();

      installShutdown(dbMod.pool);
    })
    .catch((err) => {
      const message = (err && err.message) || String(err);

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
      if (err && err.stack) console.error(err.stack.split('\n').slice(1, 4).join('\n'));
      console.error('');

      // Keep listening and report the reason on every request, so the cause is
      // readable from a browser rather than only in a log the panel truncates.
      handler = (req, res) => {
        res.writeHead(500, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({
          error: 'The API failed to start',
          code: 'STARTUP_FAILED',
          reason: message,
        }));
      };

      installShutdown(null);
    });
}

function installShutdown(pool) {
  const shutdown = (signal) => {
    console.log(`${signal} received - shutting down`);
    server.close(() => {
      Promise.resolve(pool ? pool.end() : null)
        .catch(() => {})
        .then(() => process.exit(0));
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

module.exports = server;
