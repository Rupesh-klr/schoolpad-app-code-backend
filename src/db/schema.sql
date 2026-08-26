-- Student learning platform — schema
--
-- MySQL 8 / MariaDB 10.5+. Every statement is IF NOT EXISTS so migrate.js is
-- safe to re-run against a live database.
--
-- Indexed VARCHARs are 191, not 255: utf8mb4 costs 4 bytes per character and
-- older InnoDB caps an index key at 767 bytes. 191 * 4 = 764.

-- ─────────────────────────────────────────────────────────────────────────────
-- People
-- ─────────────────────────────────────────────────────────────────────────────

-- One row per human, whatever their role.
--
-- A single table with a role column — rather than separate admin/student/parent
-- tables — is what makes "an email may not exist under two roles" enforceable
-- by the database instead of by remembering to check. The UNIQUE constraints
-- below are the whole mechanism; application code cannot forget them.
CREATE TABLE IF NOT EXISTS app_user (
  id              BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  role            ENUM('admin','student','parent') NOT NULL,
  email           VARCHAR(191)     NULL,
  phone           VARCHAR(20)      NULL,
  -- NULL for students, who authenticate by OTP and never set one.
  password_hash   VARCHAR(255)     NULL,
  full_name       VARCHAR(150)     NULL,
  status          ENUM('pending','active','inactive') NOT NULL DEFAULT 'pending',
  -- Set when an admin (or a redeemed code) moves the account out of pending.
  activated_at    DATETIME         NULL,
  activated_by    BIGINT UNSIGNED  NULL,
  last_login_at   DATETIME         NULL,
  created_at      DATETIME         NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at      DATETIME         NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  PRIMARY KEY (id),
  -- Role-exclusive identity. NULL is not equal to NULL in a UNIQUE index, so a
  -- phone-only student and an email-only admin coexist without collision.
  UNIQUE KEY uq_user_email (email),
  UNIQUE KEY uq_user_phone (phone),
  KEY idx_user_role_status (role, status),
  KEY idx_user_created (created_at)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

CREATE TABLE IF NOT EXISTS school (
  id              BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  name            VARCHAR(191)    NOT NULL,
  code            VARCHAR(32)     NOT NULL,
  address         TEXT            NULL,
  contact_person  VARCHAR(150)    NULL,
  phone           VARCHAR(20)     NULL,
  email           VARCHAR(191)    NULL,
  status          ENUM('active','inactive') NOT NULL DEFAULT 'active',
  created_at      DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at      DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  PRIMARY KEY (id),
  UNIQUE KEY uq_school_code (code),
  KEY idx_school_status (status)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

-- The student-specific half of an app_user row.
CREATE TABLE IF NOT EXISTS student_profile (
  user_id        BIGINT UNSIGNED NOT NULL,
  school_id      BIGINT UNSIGNED NULL,
  class_level    TINYINT UNSIGNED NULL,
  section        VARCHAR(16)     NULL,
  -- The code that activated this student, if one did. NULL means an admin
  -- approved them by hand.
  access_code_id BIGINT UNSIGNED NULL,
  PRIMARY KEY (user_id),
  KEY idx_student_school (school_id),
  KEY idx_student_class (class_level),
  CONSTRAINT fk_student_user   FOREIGN KEY (user_id)   REFERENCES app_user (id) ON DELETE CASCADE,
  CONSTRAINT fk_student_school FOREIGN KEY (school_id) REFERENCES school (id)   ON DELETE SET NULL
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

-- Parent/guardian → child. Many-to-many because a child may have both parents
-- linked, and a parent may have several children.
--
-- The per-side caps (5 children, 3 guardians) cannot be expressed as a
-- constraint here, so they are enforced in a transaction in parentService.
CREATE TABLE IF NOT EXISTS parent_link (
  id              BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  parent_user_id  BIGINT UNSIGNED NOT NULL,
  student_user_id BIGINT UNSIGNED NOT NULL,
  relation        ENUM('parent','guardian') NOT NULL DEFAULT 'parent',
  created_at      DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (id),
  UNIQUE KEY uq_parent_student (parent_user_id, student_user_id),
  KEY idx_link_student (student_user_id),
  CONSTRAINT fk_link_parent  FOREIGN KEY (parent_user_id)  REFERENCES app_user (id) ON DELETE CASCADE,
  CONSTRAINT fk_link_student FOREIGN KEY (student_user_id) REFERENCES app_user (id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

-- ─────────────────────────────────────────────────────────────────────────────
-- Access codes
-- ─────────────────────────────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS access_code (
  id            BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  code          VARCHAR(32)     NOT NULL,
  -- A code may be pre-allocated to a school and class, which is how a code
  -- hands the student the right content without them choosing it themselves.
  school_id     BIGINT UNSIGNED NULL,
  class_level   TINYINT UNSIGNED NULL,
  status        ENUM('unused','used','inactive') NOT NULL DEFAULT 'unused',
  used_by       BIGINT UNSIGNED NULL,
  used_at       DATETIME        NULL,
  -- Groups one bulk generation run so a batch can be exported or revoked whole.
  batch_id      CHAR(36)        NULL,
  created_by    BIGINT UNSIGNED NULL,
  created_at    DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at    DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  PRIMARY KEY (id),
  -- Uniqueness is the product guarantee, so the database owns it. Generation
  -- retries on the duplicate-key error rather than checking first and racing.
  UNIQUE KEY uq_code (code),
  KEY idx_code_status (status),
  KEY idx_code_school (school_id),
  KEY idx_code_batch (batch_id),
  CONSTRAINT fk_code_school FOREIGN KEY (school_id) REFERENCES school (id)   ON DELETE SET NULL,
  CONSTRAINT fk_code_user   FOREIGN KEY (used_by)   REFERENCES app_user (id) ON DELETE SET NULL
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

-- ─────────────────────────────────────────────────────────────────────────────
-- Content
-- ─────────────────────────────────────────────────────────────────────────────

-- Class → Subject → Chapter → Topic as one adjacency list.
--
-- Four separate tables would mean four joins to render a breadcrumb and a
-- schema migration to add a level. One self-referencing table gives the whole
-- tree in a single recursive query, and node_type keeps the levels meaningful.
CREATE TABLE IF NOT EXISTS content_node (
  id           BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  parent_id    BIGINT UNSIGNED NULL,
  node_type    ENUM('class','subject','chapter','topic') NOT NULL,
  title        VARCHAR(191)    NOT NULL,
  description  TEXT            NULL,
  -- Denormalised from the ancestor class node so "what can class 6 see" is one
  -- indexed lookup instead of walking up the tree per student per request.
  class_level  TINYINT UNSIGNED NULL,
  sort_order   INT NOT NULL DEFAULT 0,
  visibility   ENUM('visible','hidden') NOT NULL DEFAULT 'visible',
  created_by   BIGINT UNSIGNED NULL,
  created_at   DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at   DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  PRIMARY KEY (id),
  KEY idx_node_parent (parent_id),
  KEY idx_node_class (class_level, node_type),
  KEY idx_node_visibility (visibility),
  CONSTRAINT fk_node_parent FOREIGN KEY (parent_id) REFERENCES content_node (id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

CREATE TABLE IF NOT EXISTS content_item (
  id            BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  node_id       BIGINT UNSIGNED NOT NULL,
  item_type     ENUM('video','pdf','image','link') NOT NULL,
  title         VARCHAR(191)    NOT NULL,
  description   TEXT            NULL,
  -- Exactly one of these is set: url for links and remote media, storage_path
  -- for anything uploaded through the admin dashboard.
  url           TEXT            NULL,
  storage_path  VARCHAR(500)    NULL,
  mime_type     VARCHAR(100)    NULL,
  size_bytes    BIGINT UNSIGNED NULL,
  duration_secs INT UNSIGNED    NULL,
  sort_order    INT NOT NULL DEFAULT 0,
  visibility    ENUM('visible','hidden') NOT NULL DEFAULT 'visible',
  created_by    BIGINT UNSIGNED NULL,
  created_at    DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at    DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  PRIMARY KEY (id),
  KEY idx_item_node (node_id, sort_order),
  KEY idx_item_visibility (visibility),
  CONSTRAINT fk_item_node FOREIGN KEY (node_id) REFERENCES content_node (id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

-- "Mark as completed" and "recently accessed" both read from here.
CREATE TABLE IF NOT EXISTS content_progress (
  id           BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  user_id      BIGINT UNSIGNED NOT NULL,
  item_id      BIGINT UNSIGNED NOT NULL,
  status       ENUM('viewed','completed') NOT NULL DEFAULT 'viewed',
  position_secs INT UNSIGNED   NOT NULL DEFAULT 0,
  last_seen_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  completed_at DATETIME NULL,
  PRIMARY KEY (id),
  -- One row per student per item, so progress is an upsert and can never
  -- double-count a re-watch.
  UNIQUE KEY uq_progress (user_id, item_id),
  KEY idx_progress_recent (user_id, last_seen_at),
  CONSTRAINT fk_progress_user FOREIGN KEY (user_id) REFERENCES app_user (id)     ON DELETE CASCADE,
  CONSTRAINT fk_progress_item FOREIGN KEY (item_id) REFERENCES content_item (id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

-- ─────────────────────────────────────────────────────────────────────────────
-- Auth plumbing
-- ─────────────────────────────────────────────────────────────────────────────

-- OTP challenges. The code is stored hashed: this table is the single most
-- useful thing for an attacker with read access to steal, and a hash makes it
-- worthless.
CREATE TABLE IF NOT EXISTS otp_challenge (
  id          BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  identifier  VARCHAR(191) NOT NULL,
  channel     ENUM('sms','email','whatsapp') NOT NULL,
  code_hash   VARCHAR(255) NOT NULL,
  attempts    TINYINT UNSIGNED NOT NULL DEFAULT 0,
  expires_at  DATETIME NOT NULL,
  consumed_at DATETIME NULL,
  created_at  DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (id),
  KEY idx_otp_lookup (identifier, consumed_at, expires_at),
  KEY idx_otp_created (created_at)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

-- Refresh tokens, stored as SHA-256 digests. Storing them raw would mean a
-- database dump is a set of live 30-day sessions.
CREATE TABLE IF NOT EXISTS refresh_token (
  id         BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  user_id    BIGINT UNSIGNED NOT NULL,
  token_hash CHAR(64) NOT NULL,
  expires_at DATETIME NOT NULL,
  revoked_at DATETIME NULL,
  user_agent VARCHAR(255) NULL,
  created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (id),
  UNIQUE KEY uq_refresh_hash (token_hash),
  KEY idx_refresh_user (user_id, revoked_at),
  CONSTRAINT fk_refresh_user FOREIGN KEY (user_id) REFERENCES app_user (id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

-- ─────────────────────────────────────────────────────────────────────────────
-- Settings & audit
-- ─────────────────────────────────────────────────────────────────────────────

-- Privacy policy, terms, and anything else an admin edits as free text.
CREATE TABLE IF NOT EXISTS app_setting (
  setting_key VARCHAR(100) NOT NULL,
  value       LONGTEXT     NULL,
  updated_by  BIGINT UNSIGNED NULL,
  updated_at  DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  PRIMARY KEY (setting_key)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

-- Who activated which student, who generated which batch of codes. Codes are
-- worth money to a school; "nobody knows who issued these 500" is not an
-- acceptable answer.
CREATE TABLE IF NOT EXISTS audit_log (
  id          BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  actor_id    BIGINT UNSIGNED NULL,
  action      VARCHAR(64)  NOT NULL,
  entity_type VARCHAR(64)  NULL,
  entity_id   VARCHAR(64)  NULL,
  detail      LONGTEXT     NULL,
  created_at  DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (id),
  KEY idx_audit_actor (actor_id, created_at),
  KEY idx_audit_entity (entity_type, entity_id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;
