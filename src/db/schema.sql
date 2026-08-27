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
CREATE TABLE IF NOT EXISTS ls_user (
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
  UNIQUE KEY uq_ls_user_email (email),
  UNIQUE KEY uq_ls_user_phone (phone),
  KEY idx_ls_user_role_status (role, status),
  KEY idx_ls_user_created (created_at)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

CREATE TABLE IF NOT EXISTS ls_school (
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
  UNIQUE KEY uq_ls_school_code (code),
  KEY idx_ls_school_status (status)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

-- The student-specific half of an ls_user row.
CREATE TABLE IF NOT EXISTS ls_student_profile (
  user_id        BIGINT UNSIGNED NOT NULL,
  school_id      BIGINT UNSIGNED NULL,
  class_level    TINYINT UNSIGNED NULL,
  section        VARCHAR(16)     NULL,
  -- The code that activated this student, if one did. NULL means an admin
  -- approved them by hand.
  access_code_id BIGINT UNSIGNED NULL,
  PRIMARY KEY (user_id),
  KEY idx_ls_student_school (school_id),
  KEY idx_ls_student_class (class_level),
  CONSTRAINT fk_ls_student_user   FOREIGN KEY (user_id)   REFERENCES ls_user (id) ON DELETE CASCADE,
  CONSTRAINT fk_ls_student_school FOREIGN KEY (school_id) REFERENCES ls_school (id)   ON DELETE SET NULL
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

-- Parent/guardian → child. Many-to-many because a child may have both parents
-- linked, and a parent may have several children.
--
-- The per-side caps (5 children, 3 guardians) cannot be expressed as a
-- constraint here, so they are enforced in a transaction in parentService.
CREATE TABLE IF NOT EXISTS ls_parent_link (
  id              BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  parent_user_id  BIGINT UNSIGNED NOT NULL,
  student_user_id BIGINT UNSIGNED NOT NULL,
  relation        ENUM('parent','guardian') NOT NULL DEFAULT 'parent',
  created_at      DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (id),
  UNIQUE KEY uq_ls_parent_student (parent_user_id, student_user_id),
  KEY idx_ls_link_student (student_user_id),
  CONSTRAINT fk_ls_link_parent  FOREIGN KEY (parent_user_id)  REFERENCES ls_user (id) ON DELETE CASCADE,
  CONSTRAINT fk_ls_link_student FOREIGN KEY (student_user_id) REFERENCES ls_user (id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

-- ─────────────────────────────────────────────────────────────────────────────
-- Access codes
-- ─────────────────────────────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS ls_access_code (
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
  UNIQUE KEY uq_ls_code (code),
  KEY idx_ls_code_status (status),
  KEY idx_ls_code_school (school_id),
  KEY idx_ls_code_batch (batch_id),
  CONSTRAINT fk_ls_code_school FOREIGN KEY (school_id) REFERENCES ls_school (id)   ON DELETE SET NULL,
  CONSTRAINT fk_ls_code_user   FOREIGN KEY (used_by)   REFERENCES ls_user (id) ON DELETE SET NULL
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

-- ─────────────────────────────────────────────────────────────────────────────
-- Content
-- ─────────────────────────────────────────────────────────────────────────────

-- Class → Subject → Chapter → Topic as one adjacency list.
--
-- Four separate tables would mean four joins to render a breadcrumb and a
-- schema migration to add a level. One self-referencing table gives the whole
-- tree in a single recursive query, and node_type keeps the levels meaningful.
CREATE TABLE IF NOT EXISTS ls_content_node (
  id           BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  parent_id    BIGINT UNSIGNED NULL,
  -- NULL means shared by every school. Set, and only that school sees it.
  school_id    BIGINT UNSIGNED NULL,
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
  KEY idx_ls_node_parent (parent_id),
  KEY idx_ls_node_class (class_level, node_type),
  KEY idx_ls_node_school (school_id, class_level),
  KEY idx_ls_node_visibility (visibility),
  CONSTRAINT fk_ls_node_parent FOREIGN KEY (parent_id) REFERENCES ls_content_node (id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

CREATE TABLE IF NOT EXISTS ls_content_item (
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
  KEY idx_ls_item_node (node_id, sort_order),
  KEY idx_ls_item_visibility (visibility),
  CONSTRAINT fk_ls_item_node FOREIGN KEY (node_id) REFERENCES ls_content_node (id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

-- "Mark as completed" and "recently accessed" both read from here.
CREATE TABLE IF NOT EXISTS ls_content_progress (
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
  UNIQUE KEY uq_ls_progress (user_id, item_id),
  KEY idx_ls_progress_recent (user_id, last_seen_at),
  CONSTRAINT fk_ls_progress_user FOREIGN KEY (user_id) REFERENCES ls_user (id)     ON DELETE CASCADE,
  CONSTRAINT fk_ls_progress_item FOREIGN KEY (item_id) REFERENCES ls_content_item (id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

-- ─────────────────────────────────────────────────────────────────────────────
-- Auth plumbing
-- ─────────────────────────────────────────────────────────────────────────────

-- OTP challenges. The code is stored hashed: this table is the single most
-- useful thing for an attacker with read access to steal, and a hash makes it
-- worthless.
CREATE TABLE IF NOT EXISTS ls_otp_challenge (
  id          BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  identifier  VARCHAR(191) NOT NULL,
  channel     ENUM('sms','email','whatsapp') NOT NULL,
  code_hash   VARCHAR(255) NOT NULL,
  attempts    TINYINT UNSIGNED NOT NULL DEFAULT 0,
  expires_at  DATETIME NOT NULL,
  consumed_at DATETIME NULL,
  created_at  DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (id),
  KEY idx_ls_otp_lookup (identifier, consumed_at, expires_at),
  KEY idx_ls_otp_created (created_at)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

-- Refresh tokens, stored as SHA-256 digests. Storing them raw would mean a
-- database dump is a set of live 30-day sessions.
CREATE TABLE IF NOT EXISTS ls_refresh_token (
  id         BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  user_id    BIGINT UNSIGNED NOT NULL,
  token_hash CHAR(64) NOT NULL,
  expires_at DATETIME NOT NULL,
  revoked_at DATETIME NULL,
  user_agent VARCHAR(255) NULL,
  created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (id),
  UNIQUE KEY uq_ls_refresh_hash (token_hash),
  KEY idx_ls_refresh_user (user_id, revoked_at),
  CONSTRAINT fk_ls_refresh_user FOREIGN KEY (user_id) REFERENCES ls_user (id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

-- ─────────────────────────────────────────────────────────────────────────────
-- Settings & audit
-- ─────────────────────────────────────────────────────────────────────────────

-- Privacy policy, terms, and anything else an admin edits as free text.
CREATE TABLE IF NOT EXISTS ls_app_setting (
  setting_key VARCHAR(100) NOT NULL,
  value       LONGTEXT     NULL,
  updated_by  BIGINT UNSIGNED NULL,
  updated_at  DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  PRIMARY KEY (setting_key)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

-- Who activated which student, who generated which batch of codes. Codes are
-- worth money to a school; "nobody knows who issued these 500" is not an
-- acceptable answer.
CREATE TABLE IF NOT EXISTS ls_audit_log (
  id          BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  actor_id    BIGINT UNSIGNED NULL,
  action      VARCHAR(64)  NOT NULL,
  entity_type VARCHAR(64)  NULL,
  entity_id   VARCHAR(64)  NULL,
  detail      LONGTEXT     NULL,
  created_at  DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (id),
  KEY idx_ls_audit_actor (actor_id, created_at),
  KEY idx_ls_audit_entity (entity_type, entity_id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

-- ─────────────────────────────────────────────────────────────────────────────
-- Documents & notices
-- ─────────────────────────────────────────────────────────────────────────────

-- An uploaded file *or* a link, targeted at everyone / one school / one class.
--
-- Deliberately separate from content_item. Content is curriculum: it hangs off
-- the Class-Subject-Chapter-Topic tree and a student reaches it by browsing.
-- A notice is pushed at people and has an audience, a category and a read
-- state. Forcing both into one table would mean every content row carrying
-- three columns it never uses, and every notice pretending to have a parent
-- topic it does not belong to.
CREATE TABLE IF NOT EXISTS ls_document (
  id            BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  title         VARCHAR(191) NOT NULL,
  description   TEXT         NULL,

  -- What kind of notice. Drives the icon and lets students filter.
  category      ENUM('gk','notice','important','homework','general')
                NOT NULL DEFAULT 'general',

  -- Exactly one of url / storage_path is set; enforced in the service layer,
  -- because MySQL CHECK constraints are silently ignored before 8.0.16 and a
  -- rule that only sometimes applies is worse than one held in one place.
  source_type   ENUM('file','link') NOT NULL,
  url           TEXT         NULL,
  storage_path  VARCHAR(500) NULL,
  mime_type     VARCHAR(100) NULL,
  size_bytes    BIGINT UNSIGNED NULL,

  -- Audience. `global` ignores school_id and class_level; `school` uses
  -- school_id; `class` uses both. Kept as three explicit columns rather than a
  -- join table because a notice has exactly one audience and the feed query
  -- has to stay a single indexed read.
  scope         ENUM('global','school','class') NOT NULL DEFAULT 'global',
  school_id     BIGINT UNSIGNED NULL,
  class_level   TINYINT UNSIGNED NULL,

  status        ENUM('draft','published','archived') NOT NULL DEFAULT 'published',
  -- Whether this should surface as an unread notification, as opposed to
  -- quietly appearing in the list. A reference PDF does not need to buzz.
  notify        TINYINT(1) NOT NULL DEFAULT 1,
  published_at  DATETIME NULL,

  created_by    BIGINT UNSIGNED NULL,
  created_at    DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at    DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  PRIMARY KEY (id),
  -- The feed filters on all three together, so one composite index serves it.
  KEY idx_ls_doc_audience (status, scope, school_id, class_level),
  KEY idx_ls_doc_published (published_at),
  KEY idx_ls_doc_category (category),
  CONSTRAINT fk_ls_doc_school FOREIGN KEY (school_id) REFERENCES ls_school (id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

-- Read receipts.
--
-- Unread is the absence of a row, not a flag on a per-user copy. Fanning a
-- notice out to every student at insert time would write thousands of rows for
-- one announcement and have to be undone if the audience is edited.
CREATE TABLE IF NOT EXISTS ls_document_read (
  id          BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  document_id BIGINT UNSIGNED NOT NULL,
  user_id     BIGINT UNSIGNED NOT NULL,
  read_at     DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (id),
  UNIQUE KEY uq_ls_doc_read (document_id, user_id),
  KEY idx_ls_doc_read_user (user_id),
  CONSTRAINT fk_ls_docread_doc  FOREIGN KEY (document_id) REFERENCES ls_document (id) ON DELETE CASCADE,
  CONSTRAINT fk_ls_docread_user FOREIGN KEY (user_id)     REFERENCES ls_user (id)     ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

-- ─────────────────────────────────────────────────────────────────────────────
-- Classes, teachers, timetable, calendar
-- ─────────────────────────────────────────────────────────────────────────────

-- A real class within a school: "Class 6-A at Greenwood".
--
-- ls_student_profile already carries school_id and class_level, and that stays
-- the authority on which class a student is in. This table is the class as a
-- *thing* — it has a title, a description, a dress code and a timetable, none
-- of which belong on every student row.
CREATE TABLE IF NOT EXISTS ls_class (
  id             BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  school_id      BIGINT UNSIGNED NOT NULL,
  class_level    TINYINT UNSIGNED NOT NULL,
  -- '' rather than NULL: NULL is never equal to NULL in a UNIQUE index, so a
  -- nullable section would let "Class 6, no section" be created many times.
  section        VARCHAR(16)  NOT NULL DEFAULT '',
  title          VARCHAR(191) NULL,
  description    TEXT         NULL,
  dress_code     TEXT         NULL,
  -- The "plan of action" — what this class is working towards this term.
  plan_of_action TEXT         NULL,
  notes          TEXT         NULL,
  -- No foreign key: ls_teacher is declared after this table, and adding the
  -- constraint by ALTER would break the "safe to re-run" property of
  -- schema.sql, since MySQL has no ADD CONSTRAINT IF NOT EXISTS. Every read
  -- LEFT JOINs the teacher, so a deleted one shows as blank rather than an error.
  class_teacher_id BIGINT UNSIGNED NULL,
  room           VARCHAR(64)  NULL,
  status         ENUM('active','inactive') NOT NULL DEFAULT 'active',
  created_by     BIGINT UNSIGNED NULL,
  created_at     DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at     DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  PRIMARY KEY (id),
  UNIQUE KEY uq_ls_class (school_id, class_level, section),
  KEY idx_ls_class_school (school_id, class_level),
  CONSTRAINT fk_ls_class_school FOREIGN KEY (school_id) REFERENCES ls_school (id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

-- Teachers are staff records, not accounts.
--
-- Deliberately not rows in ls_user: a teacher here is a name on a timetable
-- that students read. Giving them a login is a separate feature with its own
-- permissions, and conflating the two now would mean either teachers with
-- dormant credentials or a fourth role nobody has specified.
CREATE TABLE IF NOT EXISTS ls_teacher (
  id         BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  school_id  BIGINT UNSIGNED NOT NULL,
  full_name  VARCHAR(150) NOT NULL,
  email      VARCHAR(191) NULL,
  phone      VARCHAR(20)  NULL,
  subjects   VARCHAR(500) NULL,
  status     ENUM('active','inactive') NOT NULL DEFAULT 'active',
  created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  PRIMARY KEY (id),
  KEY idx_ls_teacher_school (school_id, status),
  CONSTRAINT fk_ls_teacher_school FOREIGN KEY (school_id) REFERENCES ls_school (id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

-- One period on one weekday.
--
-- weekday is ISO-8601: 1 = Monday .. 7 = Sunday. Not JavaScript's 0 = Sunday,
-- which puts the weekend at both ends of the week and makes every ordering
-- query need a special case.
CREATE TABLE IF NOT EXISTS ls_timetable_slot (
  id         BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  class_id   BIGINT UNSIGNED NOT NULL,
  weekday    TINYINT UNSIGNED NOT NULL,
  period_no  TINYINT UNSIGNED NOT NULL,
  start_time TIME NULL,
  end_time   TIME NULL,
  subject    VARCHAR(120) NOT NULL,
  teacher_id BIGINT UNSIGNED NULL,
  room       VARCHAR(64) NULL,
  -- Break and lunch occupy a period slot but have no teacher or subject to
  -- speak of; flagging them lets the grid render them differently.
  is_break   TINYINT(1) NOT NULL DEFAULT 0,
  created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  PRIMARY KEY (id),
  -- One subject per period per day. Saving the grid is an upsert against this.
  UNIQUE KEY uq_ls_slot (class_id, weekday, period_no),
  KEY idx_ls_slot_teacher (teacher_id),
  CONSTRAINT fk_ls_slot_class   FOREIGN KEY (class_id)   REFERENCES ls_class (id)   ON DELETE CASCADE,
  CONSTRAINT fk_ls_slot_teacher FOREIGN KEY (teacher_id) REFERENCES ls_teacher (id) ON DELETE SET NULL
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

-- Holidays, exams, events. Same three-level audience as documents.
CREATE TABLE IF NOT EXISTS ls_calendar_event (
  id          BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  scope       ENUM('global','school','class') NOT NULL DEFAULT 'school',
  school_id   BIGINT UNSIGNED NULL,
  class_id    BIGINT UNSIGNED NULL,
  title       VARCHAR(191) NOT NULL,
  description TEXT NULL,
  event_type  ENUM('holiday','exam','event','activity','deadline') NOT NULL DEFAULT 'event',
  -- DATE, not DATETIME. A holiday is a calendar day, and DATETIME would make it
  -- shift by a day between an IST app and a UTC server.
  starts_on   DATE NOT NULL,
  ends_on     DATE NULL,
  created_by  BIGINT UNSIGNED NULL,
  created_at  DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at  DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  PRIMARY KEY (id),
  KEY idx_ls_event_range (starts_on, ends_on),
  KEY idx_ls_event_audience (scope, school_id, class_id),
  CONSTRAINT fk_ls_event_school FOREIGN KEY (school_id) REFERENCES ls_school (id) ON DELETE CASCADE,
  CONSTRAINT fk_ls_event_class  FOREIGN KEY (class_id)  REFERENCES ls_class (id)  ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;
