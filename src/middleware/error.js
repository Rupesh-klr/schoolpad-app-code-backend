import { ZodError } from 'zod';
import { config } from '../config/index.js';

/** 404 for anything that fell through the router. */
export function notFound(req, res) {
  res.status(404).json({ error: `No route for ${req.method} ${req.originalUrl}`, code: 'NOT_FOUND' });
}

/**
 * One error shape for the whole API, so the client has a single thing to parse.
 *
 * Services throw plain Errors with a `status` and optional `code` attached.
 * Anything without a status is a bug rather than a rule, and becomes a 500 with
 * its message hidden in production — a stack trace or a raw MySQL error in a
 * response body tells an attacker the schema.
 */
export function errorHandler(err, req, res, _next) {
  if (err instanceof ZodError) {
    return res.status(400).json({
      error: 'Some fields are not valid',
      code: 'VALIDATION_FAILED',
      fields: err.errors.map((e) => ({ field: e.path.join('.') || '(body)', message: e.message })),
    });
  }

  // Surfaces as a duplicate email or phone at registration, which is a rule the
  // user can act on, not a server fault.
  if (err.code === 'ER_DUP_ENTRY') {
    return res.status(409).json({
      error: 'That value is already registered',
      code: 'DUPLICATE',
    });
  }

  if (err.code === 'ECONNREFUSED' || err.code === 'PROTOCOL_CONNECTION_LOST') {
    console.error('[db]', err.message);
    return res.status(503).json({ error: 'The service is temporarily unavailable', code: 'DB_DOWN' });
  }

  const status = err.status || 500;

  if (status >= 500) {
    console.error(`[error] ${req.method} ${req.originalUrl}`, err);
  }

  res.status(status).json({
    error: status >= 500 && config.isProd ? 'Something went wrong' : err.message,
    code: err.code || (status >= 500 ? 'INTERNAL' : 'ERROR'),
    ...(config.isProd ? {} : { stack: status >= 500 ? err.stack : undefined }),
  });
}

/**
 * Wrap an async handler so a rejected promise reaches errorHandler.
 *
 * Express 4 does not catch async throws — without this an awaited failure
 * becomes an unhandled rejection and the request hangs until it times out.
 */
export const asyncHandler = (fn) => (req, res, next) =>
  Promise.resolve(fn(req, res, next)).catch(next);
