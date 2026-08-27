import express from 'express';
import cors from 'cors';
import helmet from 'helmet';
import path from 'node:path';
import { config } from './config/index.js';
import { notFound, errorHandler } from './middleware/error.js';

import authRoutes from './routes/auth.routes.js';
import adminRoutes from './routes/admin.routes.js';
import schoolRoutes from './routes/schools.routes.js';
import studentRoutes from './routes/students.routes.js';
import codeRoutes from './routes/codes.routes.js';
import contentRoutes from './routes/content.routes.js';
import documentRoutes from './routes/documents.routes.js';
import classRoutes from './routes/classes.routes.js';
import teacherRoutes from './routes/teachers.routes.js';
import calendarRoutes from './routes/calendar.routes.js';
import parentRoutes from './routes/parent.routes.js';
import miscRoutes from './routes/misc.routes.js';
import { uploadErrorHandler } from './services/upload.js';

export function createApp() {
  const app = express();

  app.set('trust proxy', 1);

  app.use(helmet({
    // The API serves uploaded media to a separate origin (the app), and the
    // default same-origin policy blocks a React Native <Video> from loading it.
    crossOriginResourcePolicy: { policy: 'cross-origin' },
    // No HTML is served from this origin, so a CSP here protects nothing and
    // only complicates the media responses.
    contentSecurityPolicy: false,
  }));

  app.use(cors({
    origin(origin, cb) {
      // No Origin header: a native app, curl, or a server-to-server call.
      // Native clients are not subject to CORS at all, so refusing them here
      // would break Android and iOS while protecting nothing.
      if (!origin) return cb(null, true);
      if (!config.corsOrigins.length) return cb(null, true);
      if (config.corsOrigins.includes(origin)) return cb(null, true);
      return cb(new Error(`Origin ${origin} is not allowed`));
    },
    credentials: true,
  }));

  app.use(express.json({ limit: '2mb' }));
  app.use(express.urlencoded({ extended: true }));

  // Uploaded content. `immutable` is safe because storage_path is randomised
  // per upload — replacing a file writes a new name, so a cached URL can never
  // point at changed bytes.
  app.use('/media', express.static(path.resolve(config.storage.uploadDir), {
    maxAge: '30d',
    immutable: true,
    fallthrough: false,
  }));

  app.use('/api/auth', authRoutes);
  app.use('/api/admin', adminRoutes);
  app.use('/api/schools', schoolRoutes);
  app.use('/api/students', studentRoutes);
  app.use('/api/codes', codeRoutes);
  app.use('/api/content', contentRoutes);
  app.use('/api/documents', documentRoutes);
  app.use('/api/classes', classRoutes);
  app.use('/api/teachers', teacherRoutes);
  app.use('/api/calendar', calendarRoutes);
  app.use('/api/parent', parentRoutes);
  // Mounted last: it owns bare paths like /api/health, so a more specific
  // prefix above must get the chance to match first.
  app.use('/api', miscRoutes);

  app.use(notFound);
  // Before the general handler: multer's errors are unreadable raw, and the
  // size-limit one needs to reach the user as a sentence they can act on.
  app.use(uploadErrorHandler);
  app.use(errorHandler);

  return app;
}
