import 'dotenv/config';

/**
 * Environment, read once and validated at boot.
 *
 * A missing JWT_SECRET should stop the process on line one, not surface three
 * days later as tokens that anyone can forge. Everything required in production
 * is checked here before a socket is opened.
 */

const required = (key) => {
  const v = process.env[key];
  if (!v || v.startsWith('PASTE_')) {
    throw new Error(`Missing required env var ${key}. Copy .env.example to .env and fill it in.`);
  }
  return v;
};

const isProd = process.env.NODE_ENV === 'production';

export const config = {
  env: process.env.NODE_ENV || 'development',
  isProd,
  port: Number(process.env.PORT || 8100),

  corsOrigins: (process.env.CORS_ORIGIN || '')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean),

  db: {
    host: process.env.DB_HOST || 'localhost',
    port: Number(process.env.DB_PORT || 3306),
    database: process.env.DB_NAME || 'app_learning',
    user: process.env.DB_USER || 'root',
    password: process.env.DB_PASSWORD || '',
  },

  jwt: {
    secret: required('JWT_SECRET'),
    expiresIn: process.env.JWT_EXPIRES_IN || '15m',
    // Falls back to a derived value in development so `npm run dev` works from
    // a half-filled .env, but production must set it explicitly.
    refreshSecret: isProd
      ? required('JWT_REFRESH_SECRET')
      : process.env.JWT_REFRESH_SECRET || `${required('JWT_SECRET')}:refresh`,
    refreshExpiresIn: process.env.JWT_REFRESH_EXPIRES_IN || '30d',
  },

  otp: {
    provider: process.env.OTP_PROVIDER || 'console',

    /**
     * Codes that are accepted for any identifier, in addition to the real one.
     *
     * A stand-in for SMS delivery that does not exist yet: without it nobody
     * can complete a sign-in on the deployed app at all. The freshly generated
     * code keeps working — this is an addition, not a replacement.
     *
     * Understand what it is, though. Any of these codes signs in as *any*
     * phone number or email, so while the list is non-empty the OTP step is
     * decoration rather than a check. Empty it the day real delivery works.
     *
     * Whitespace is tolerated because these get pasted into hosting panels,
     * where a stray space is easy and the resulting "wrong code" would be very
     * hard to explain.
     */
    bypassCodes: (process.env.OTP_BYPASS_CODES || '')
      .split(',')
      .map((c) => c.trim())
      .filter(Boolean),
    whatsapp: {
      phoneNumberId: process.env.WHATSAPP_PHONE_NUMBER_ID || '',
      accessToken: process.env.WHATSAPP_ACCESS_TOKEN || '',
      templateName: process.env.WHATSAPP_TEMPLATE_NAME || '',
    },
    smtp: {
      host: process.env.SMTP_HOST || '',
      port: Number(process.env.SMTP_PORT || 587),
      user: process.env.SMTP_USER || '',
      password: process.env.SMTP_PASSWORD || '',
      from: process.env.SMTP_FROM || 'no-reply@example.com',
    },
  },

  storage: {
    driver: process.env.STORAGE_DRIVER || 'local',
    uploadDir: process.env.UPLOAD_DIR || './uploads',
    maxUploadBytes: Number(process.env.MAX_UPLOAD_MB || 512) * 1024 * 1024,
  },

  seedAdmin: {
    email: process.env.SEED_ADMIN_EMAIL || 'admin@example.com',
    password: process.env.SEED_ADMIN_PASSWORD || '',
    name: process.env.SEED_ADMIN_NAME || 'Platform Admin',
  },
};

// `console` prints OTPs to the log. Harmless locally, a credential leak in
// production — refuse to start rather than silently doing it.
if (isProd && config.otp.provider === 'console') {
  throw new Error('OTP_PROVIDER=console is not allowed in production — OTPs would be written to the server log.');
}
