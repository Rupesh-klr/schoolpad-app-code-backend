import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import multer from 'multer';
import { config } from '../config/index.js';

/**
 * File uploads.
 *
 * One multer instance shared by content and documents, so the filename policy
 * and size limit are defined once. Two copies would drift, and the copy that
 * drifts is the one without the traversal guard.
 */

fs.mkdirSync(config.storage.uploadDir, { recursive: true });

export const upload = multer({
  storage: multer.diskStorage({
    destination: (req, file, cb) => cb(null, config.storage.uploadDir),
    filename: (req, file, cb) => {
      // Never trust the client's filename on disk. A supplied
      // "../../etc/cron.d/x" would otherwise be written wherever it points.
      // Only the extension is kept, and only after stripping anything that is
      // not a letter, digit or dot.
      const ext = path.extname(file.originalname).toLowerCase().replace(/[^.a-z0-9]/g, '').slice(0, 10);
      cb(null, `${Date.now()}-${crypto.randomBytes(8).toString('hex')}${ext}`);
    },
  }),
  limits: { fileSize: config.storage.maxUploadBytes },
});

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
  try {
    await fs.promises.unlink(path.join(config.storage.uploadDir, storagePath));
    return true;
  } catch {
    return false;
  }
}

/** Multer's own errors are unreadable; turn the common one into English. */
export function uploadErrorHandler(err, req, res, next) {
  if (err instanceof multer.MulterError) {
    const mb = Math.round(config.storage.maxUploadBytes / 1024 / 1024);
    return res.status(413).json({
      error: err.code === 'LIMIT_FILE_SIZE'
        ? `That file is too large. The limit is ${mb} MB.`
        : `Upload failed (${err.code})`,
      code: err.code,
    });
  }
  return next(err);
}
