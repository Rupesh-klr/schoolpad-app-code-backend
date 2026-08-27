/**
 * Every tunable number the business rules depend on, in one file.
 *
 * These live on the server and are never sent to the client as editable values.
 * The app asks the API "how long is a code?" rather than hardcoding 10, so
 * changing ACCESS_CODE.LENGTH here changes generation, validation and the
 * input box on every platform at once — no app-store release required.
 */

export const ACCESS_CODE = {
  /**
   * The written spec says "8-digit" in the overview and "10-digit" in both the
   * student and admin sections. 10 is the one that appears in the actual
   * feature requirements, so it wins — but it is a constant precisely because
   * that disagreement has to be resolvable without a code change.
   */
  LENGTH: 10,

  /**
   * Digits only. Letters would double the keyspace, but these codes get read
   * aloud over the phone to parents and typed by 7-year-olds; O/0 and I/1
   * confusion costs more in support calls than it buys in entropy.
   */
  ALPHABET: '0123456789',

  /** Ceiling for one bulk generation request. Guards against a typo'd zero. */
  BULK_MAX: 5000,

  /** Retries when a generated code collides with an existing one. */
  COLLISION_RETRIES: 5,
};

export const STUDENT = {
  /** The app targets classes 2 through 10. */
  MIN_CLASS: 2,
  MAX_CLASS: 10,

  /** A student may be linked to at most this many parent/guardian accounts. */
  MAX_GUARDIANS: 3,
};

export const PARENT = {
  /** A parent account may supervise at most this many children. */
  MAX_CHILDREN: 5,
};

export const OTP = {
  LENGTH: 6,

  /** Five minutes. Long enough for a slow SMS, short enough to limit reuse. */
  TTL_SECONDS: 300,

  /** Wrong guesses before the challenge is burned and must be re-requested. */
  MAX_ATTEMPTS: 5,

  /** A new OTP for the same identifier is refused inside this window. */
  RESEND_COOLDOWN_SECONDS: 60,
};

export const PASSWORD = {
  MIN_LENGTH: 8,

  /**
   * bcrypt work factor. 12 is roughly 250ms on current hardware — slow enough
   * to make offline cracking expensive, fast enough that an admin sign-in does
   * not feel broken.
   */
  BCRYPT_ROUNDS: 12,
};

export const ROLES = Object.freeze({
  ADMIN: 'admin',
  STUDENT: 'student',
  PARENT: 'parent',
});

export const USER_STATUS = Object.freeze({
  PENDING: 'pending',
  ACTIVE: 'active',
  INACTIVE: 'inactive',
});

export const CODE_STATUS = Object.freeze({
  UNUSED: 'unused',
  USED: 'used',
  INACTIVE: 'inactive',
});

export const NODE_TYPES = Object.freeze(['class', 'subject', 'chapter', 'topic']);
export const ITEM_TYPES = Object.freeze(['video', 'pdf', 'image', 'link']);

export const UPLOAD = {
  /** Files accepted in one request. */
  MAX_FILES: 10,

  /**
   * Per-kind size ceilings, in MB.
   *
   * One flat limit would have to be the largest of these, which means a 120MB
   * "profile photo" sails through. Each kind is capped at what it plausibly
   * needs, and the check runs after the upload because multer cannot know the
   * kind until it has the mimetype.
   */
  MAX_MB: { video: 120, pdf: 25, image: 10, other: 25 },

  /**
   * Extensions accepted per kind. An allowlist, not a blocklist: a blocklist is
   * one unfamiliar extension away from serving something executable.
   */
  ALLOWED: {
    video: ['.mp4', '.mov', '.m4v', '.webm'],
    pdf: ['.pdf'],
    image: ['.jpg', '.jpeg', '.png', '.gif', '.webp', '.heic'],
    other: ['.doc', '.docx', '.ppt', '.pptx', '.xls', '.xlsx', '.txt', '.csv'],
  },
};

/** Bytes ceiling for multer — the largest kind, refined per file afterwards. */
export const MAX_UPLOAD_BYTES = Math.max(...Object.values(UPLOAD.MAX_MB)) * 1024 * 1024;

export const PAGINATION = {
  DEFAULT_LIMIT: 25,
  MAX_LIMIT: 200,
};

/**
 * Shipped to the client at /api/meta/constants so the UI can validate input
 * locally without ever becoming the authority on it. Deliberately a subset:
 * BCRYPT_ROUNDS and COLLISION_RETRIES are nobody's business but the server's.
 */
export const PUBLIC_CONSTANTS = {
  accessCodeLength: ACCESS_CODE.LENGTH,
  otpLength: OTP.LENGTH,
  otpTtlSeconds: OTP.TTL_SECONDS,
  otpResendCooldownSeconds: OTP.RESEND_COOLDOWN_SECONDS,
  passwordMinLength: PASSWORD.MIN_LENGTH,
  minClass: STUDENT.MIN_CLASS,
  maxClass: STUDENT.MAX_CLASS,
  maxChildrenPerParent: PARENT.MAX_CHILDREN,
  maxGuardiansPerStudent: STUDENT.MAX_GUARDIANS,
};
