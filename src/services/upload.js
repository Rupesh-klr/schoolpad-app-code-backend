import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import multer from 'multer';
import { config } from '../config/index.js';
import { UPLOAD, MAX_UPLOAD_BYTES } from '../config/constants.js';

/**
 * File uploads.
 *
 * One multer instance shared by content, documents and anything else, so the
 * filename policy and size limits are defined once. Two copies would drift, and
 * the copy that drifts is the one without the traversal guard.
 *
 * Files land under `uploads/school-<id>/`, keyed off the schoolId in the
 * request. One flat directory works until a school leaves and you have to find
 * their 4,000 files among everyone else's.
 */

/*
 * Create the upload directory, but never let it stop the process.
 *
 * This runs at import time, so an unwritable path here would throw before the
 * server binds its port - and a managed host reports that only as "the app did
 * not start", with nothing about why. An API that runs and fails uploads is far
 * easier to diagnose than one that never starts.
 */
try {
  fs.mkdirSync(config.storage.uploadDir, { recursive: true });
} catch (err) {
  console.warn(`[upload] cannot create ${config.storage.uploadDir}: ${err.message}`);
  console.warn('[upload] file uploads will fail until this path is writable.');
}

/**
 * Which bucket a file belongs to, from its extension.
 *
 * Extension, not the client's mimetype: the browser supplies that and it can
 * say anything. The extension is what the file will actually be served as.
 */
export function kindOf(filename) {
  const ext = path.extname(String(filename || '')).toLowerCase();
  for (const [kind, list] of Object.entries(UPLOAD.ALLOWED)) {
    if (list.includes(ext)) return kind;
  }
  return null;
}

/**
 * Sub-directory for a request.
 *
 * `school-<id>` when a schoolId is present, `shared` otherwise — content that
 * belongs to every school has to live somewhere, and burying it in one
 * school's folder makes it look like that school owns it.
 */
function subdirFor(req) {
  const raw = req.body?.schoolId ?? req.query?.schoolId;
  const id = Number(raw);
  return Number.isInteger(id) && id > 0 ? `school-${id}` : 'shared';
}

export const upload = multer({
  storage: multer.diskStorage({
    destination: (req, file, cb) => {
      const dir = path.join(config.storage.uploadDir, subdirFor(req));
      fs.mkdirSync(dir, { recursive: true });
      cb(null, dir);
    },
    filename: (req, file, cb) => {
      // Never trust the client's filename on disk. A supplied
      // "../../etc/cron.d/x" would otherwise be written wherever it points.
      // Only the extension survives, and only after stripping anything that is
      // not a letter, digit or dot.
      const ext = path.extname(file.originalname).toLowerCase().replace(/[^.a-z0-9]/g, '').slice(0, 10);
      cb(null, `${Date.now()}-${crypto.randomBytes(8).toString('hex')}${ext}`);
    },
  }),

  fileFilter: (req, file, cb) => {
    if (!kindOf(file.originalname)) {
      const err = new Error(`${path.extname(file.originalname) || 'That file type'} is not accepted`);
      err.code = 'UNSUPPORTED_TYPE';
      return cb(err);
    }
    return cb(null, true);
  },

  // The largest of the per-kind ceilings. Multer cannot apply a different limit
  // per file, so the precise check happens in enforceLimits below — this one
  // just stops something enormous being written to disk first.
  limits: { fileSize: MAX_UPLOAD_BYTES, files: UPLOAD.MAX_FILES },
});

/**
 * Apply the per-kind size ceiling, deleting anything that breaches it.
 *
 * Runs after multer has written the files, because the kind is only known from
 * the finished file. Returns a list of rejections rather than throwing, so one
 * oversized video in a batch of ten does not discard the other nine.
 */
export async function enforceLimits(files = []) {
  const accepted = [];
  const rejected = [];

  for (const file of files) {
    const kind = kindOf(file.originalname);
    const maxMb = UPLOAD.MAX_MB[kind] ?? UPLOAD.MAX_MB.other;

    if (file.size > maxMb * 1024 * 1024) {
      await removeStoredFile(relativePath(file));
      rejected.push({
        name: file.originalname,
        reason: `${kind} files are limited to ${maxMb} MB (this one is ${Math.round(file.size / 1024 / 1024)} MB)`,
      });
      continue;
    }
    accepted.push({ ...file, kind, storagePath: relativePath(file) });
  }

  return { accepted, rejected };
}

/**
 * Path relative to the upload root, e.g. "school-3/1787-abc.pdf".
 *
 * Stored in the database rather than an absolute path, so moving the upload
 * directory — or restoring it on a different machine — does not invalidate
 * every row.
 */
export function relativePath(file) {
  return path.relative(path.resolve(config.storage.uploadDir), path.resolve(file.path))
    .split(path.sep).join('/');
}

/** Public URL for a stored file. Never expose the filesystem path. */
export const mediaUrl = (storagePath) => (storagePath ? `/media/${storagePath}` : null);

/**
 * Delete a stored file, ignoring "already gone".
 *
 * Always call this *after* the database row is updated or removed. Deleting
 * first and then failing the write leaves a row pointing at nothing, which is
 * the harder of the two failures to notice.
 */
export async function removeStoredFile(storagePath) {
  if (!storagePath) return false;

  // Belt and braces: a stored path is generated by this module, but if one is
  // ever tampered with, resolving it must not escape the upload root.
  const root = path.resolve(config.storage.uploadDir);
  const full = path.resolve(root, storagePath);
  if (full !== root && !full.startsWith(root + path.sep)) return false;

  try {
    await fs.promises.unlink(full);
    return true;
  } catch {
    return false;
  }
}

/** Multer's own errors are unreadable; turn the common ones into English. */
export function uploadErrorHandler(err, req, res, next) {
  if (err instanceof multer.MulterError) {
    const map = {
      LIMIT_FILE_SIZE: `That file is too large. Videos may be up to ${UPLOAD.MAX_MB.video} MB, PDFs ${UPLOAD.MAX_MB.pdf} MB, images ${UPLOAD.MAX_MB.image} MB.`,
      LIMIT_FILE_COUNT: `You can upload at most ${UPLOAD.MAX_FILES} files at once.`,
      LIMIT_UNEXPECTED_FILE: 'Unexpected file field.',
    };
    return res.status(413).json({ error: map[err.code] || `Upload failed (${err.code})`, code: err.code });
  }
  if (err?.code === 'UNSUPPORTED_TYPE') {
    return res.status(415).json({ error: err.message, code: 'UNSUPPORTED_TYPE' });
  }
  return next(err);
}
