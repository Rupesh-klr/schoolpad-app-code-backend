#!/usr/bin/env node
import { config } from '../config/index.js';
import { execute, one, pool, query } from '../config/db.js';
import { hashPassword } from '../services/password.js';
import { generateBatch } from '../services/accessCode.js';
import { ROLES, USER_STATUS } from '../config/constants.js';

/**
 * Development seed.
 *
 *   npm run seed
 *
 * Idempotent: every insert checks first, so running it twice does not create a
 * second copy of anything. It never deletes.
 *
 * Refuses to run against NODE_ENV=production. Seeded demo students carry
 * plausible-looking names and phone numbers, and a demo row in a live table is
 * indistinguishable from a real one three months later.
 */

if (config.isProd) {
  console.error('✖ Refusing to seed with NODE_ENV=production.');
  console.error('  Create the first admin with scripts/create-admin.js instead.');
  process.exit(1);
}

const SCHOOLS = [
  { name: 'Greenwood High School', code: 'GWH001', contact: 'Anita Rao', phone: '+919800000001', email: 'office@greenwood.example' },
  { name: 'St. Xavier Public School', code: 'SXP002', contact: 'Rajesh Kumar', phone: '+919800000002', email: 'admin@xavier.example' },
  { name: 'Sunrise Academy', code: 'SRA003', contact: 'Meera Nair', phone: '+919800000003', email: 'contact@sunrise.example' },
];

const SUBJECTS = ['Mathematics', 'Science', 'English', 'Social Studies'];

async function main() {
  console.log('');

  // ── Admin ──────────────────────────────────────────────────────────────────
  if (!config.seedAdmin.password) {
    console.error('✖ SEED_ADMIN_PASSWORD is not set in .env — refusing to invent one.');
    console.error('  An admin account with a password nobody chose is an account nobody rotates.');
    process.exit(1);
  }

  const email = config.seedAdmin.email.toLowerCase();
  let admin = await one('SELECT id FROM ls_user WHERE email = ?', [email]);

  if (admin) {
    console.log(`  ▸ admin        ${email} (already exists, left untouched)`);
  } else {
    const res = await execute(
      `INSERT INTO ls_user (role, email, full_name, password_hash, status, activated_at)
       VALUES (?, ?, ?, ?, ?, NOW())`,
      [ROLES.ADMIN, email, config.seedAdmin.name, await hashPassword(config.seedAdmin.password), USER_STATUS.ACTIVE],
    );
    admin = { id: res.insertId };
    console.log(`  ▸ admin        ${email} (created)`);
  }

  // ── Schools ────────────────────────────────────────────────────────────────
  const schoolIds = [];
  for (const s of SCHOOLS) {
    const existing = await one('SELECT id FROM ls_school WHERE code = ?', [s.code]);
    if (existing) { schoolIds.push(existing.id); continue; }
    const res = await execute(
      `INSERT INTO ls_school (name, code, address, contact_person, phone, email, status)
       VALUES (?, ?, ?, ?, ?, ?, 'active')`,
      [s.name, s.code, `${s.name}, Demo Address`, s.contact, s.phone, s.email],
    );
    schoolIds.push(res.insertId);
  }
  console.log(`  ▸ schools      ${schoolIds.length}`);

  // ── Content tree: Class → Subject → Chapter → Topic ────────────────────────
  let nodeCount = 0;
  let itemCount = 0;

  for (const classLevel of [6, 7]) {
    let classNode = await one(
      "SELECT id FROM ls_content_node WHERE node_type = 'class' AND class_level = ?", [classLevel],
    );
    if (!classNode) {
      const res = await execute(
        `INSERT INTO ls_content_node (parent_id, node_type, title, class_level, sort_order, created_by)
         VALUES (NULL, 'class', ?, ?, ?, ?)`,
        [`Class ${classLevel}`, classLevel, classLevel, admin.id],
      );
      classNode = { id: res.insertId };
      nodeCount += 1;
    }

    for (const [i, subject] of SUBJECTS.entries()) {
      let subjectNode = await one(
        "SELECT id FROM ls_content_node WHERE parent_id = ? AND title = ?", [classNode.id, subject],
      );
      if (!subjectNode) {
        const res = await execute(
          `INSERT INTO ls_content_node (parent_id, node_type, title, class_level, sort_order, created_by)
           VALUES (?, 'subject', ?, ?, ?, ?)`,
          [classNode.id, subject, classLevel, i, admin.id],
        );
        subjectNode = { id: res.insertId };
        nodeCount += 1;
      }

      // One chapter with one topic, so every level of the tree has something
      // in it and the app's navigation can be exercised end to end.
      let chapter = await one("SELECT id FROM ls_content_node WHERE parent_id = ? LIMIT 1", [subjectNode.id]);
      if (!chapter) {
        const res = await execute(
          `INSERT INTO ls_content_node (parent_id, node_type, title, class_level, sort_order, created_by)
           VALUES (?, 'chapter', ?, ?, 0, ?)`,
          [subjectNode.id, `Chapter 1 — Introduction to ${subject}`, classLevel, admin.id],
        );
        chapter = { id: res.insertId };
        nodeCount += 1;
      }

      let topic = await one("SELECT id FROM ls_content_node WHERE parent_id = ? LIMIT 1", [chapter.id]);
      if (!topic) {
        const res = await execute(
          `INSERT INTO ls_content_node (parent_id, node_type, title, class_level, sort_order, created_by)
           VALUES (?, 'topic', ?, ?, 0, ?)`,
          [chapter.id, 'Topic 1.1 — Getting started', classLevel, admin.id],
        );
        topic = { id: res.insertId };
        nodeCount += 1;
      }

      const hasItems = await one('SELECT id FROM ls_content_item WHERE node_id = ? LIMIT 1', [topic.id]);
      if (!hasItems) {
        // Links, not uploaded files: a seed that writes 200MB of video into
        // ./uploads makes a fresh clone slow and the repo unclonable.
        await execute(
          `INSERT INTO ls_content_item (node_id, item_type, title, description, url, sort_order, created_by)
           VALUES (?, 'link', ?, ?, ?, 0, ?)`,
          [topic.id, `${subject} — overview`, 'Sample link content for development.',
           'https://example.com/lesson', admin.id],
        );
        itemCount += 1;
      }
    }
  }
  console.log(`  ▸ content      ${nodeCount} folders, ${itemCount} items`);

  // ── Access codes ───────────────────────────────────────────────────────────
  const [{ n }] = await query('SELECT COUNT(*) AS n FROM ls_access_code');
  if (Number(n) === 0) {
    const batch = await generateBatch({ count: 20, schoolId: schoolIds[0], classLevel: 6, createdBy: admin.id });
    console.log(`  ▸ codes        ${batch.count} generated for ${SCHOOLS[0].name}, class 6`);
    console.log(`      sample: ${batch.codes.slice(0, 3).map((c) => c.code).join('  ')}`);
  } else {
    console.log(`  ▸ codes        ${n} already present, none generated`);
  }

  // ── Legal placeholders ─────────────────────────────────────────────────────
  for (const key of ['privacy_policy', 'terms_conditions']) {
    await execute(
      `INSERT INTO ls_app_setting (setting_key, value, updated_by) VALUES (?, ?, ?)
       ON DUPLICATE KEY UPDATE setting_key = setting_key`,
      [key, `# ${key.replace('_', ' ')}\n\nReplace this from Settings in the admin dashboard.`, admin.id],
    );
  }

  console.log('');
  console.log(`  ✔ Seed complete. Sign in to the dashboard as ${email}`);
  console.log('    Change that password after the first sign-in.');
  console.log('');

  await pool.end();
}

main().catch(async (err) => {
  console.error('✖ Seed failed:', err.message);
  await pool.end().catch(() => {});
  process.exit(1);
});
