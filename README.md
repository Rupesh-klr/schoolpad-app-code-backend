# Learning Platform — API

Node.js + Express + MySQL. Serves the student app, the parent view and the admin
dashboard in [`app-code`](../app-code).

Plain JavaScript (ESM), no build step.

---

## Quick start

```bash
npm install
cp .env.example .env        # fill in DB_PASSWORD, JWT_SECRET, SEED_ADMIN_PASSWORD
npm run migrate             # creates the database and every table
npm run seed                # one admin, 3 schools, a content tree, 20 codes
npm run dev                 # :8100
```

Generate the two secrets:

```bash
node -e "console.log(require('crypto').randomBytes(48).toString('base64url'))"
```

`npm run dev` frees the port first and watches for changes. `npm start` does
neither — killing whatever holds a port is fine on a laptop and unacceptable on
a server.

### Requirements

MySQL 8 or MariaDB 10.5+. A **dedicated database** (`app_learning` by default) —
this schema owns unprefixed table names and must not share a database with
another application.

---

## The three roles

| Role | Signs in with | Created by |
|---|---|---|
| `student` | OTP to phone or email | Self-registration |
| `parent` | OTP to phone or email | Self-registration |
| `admin` | Email + password | Another admin, or `npm run seed` |

**One email, one role.** A `UNIQUE` index on `app_user.email` (and on `phone`)
enforces it in the database, not in application code that can forget. An admin
email cannot also be a student, and requesting an OTP for an admin address is
refused with `USE_PASSWORD_LOGIN` rather than quietly turning a password-protected
account into one reachable by anyone holding the inbox.

---

## How a student gets access

```
POST /api/auth/otp/request     phone or email
POST /api/auth/otp/verify      → registered:false + a 10-minute registrationToken
POST /api/auth/register        name, class, school  → account created, status=pending
                                                       ↓
                    ┌──────────────────────────────────┴──────────────────────┐
                    ↓                                                         ↓
POST /api/auth/redeem-code                            admin: PATCH /api/students/:id/status
  code valid → status=active, immediately               status=active
```

Nothing is written to the database until `/register`. A verified phone number
with no name or class is a half-account the dashboard would have to display and
explain.

Redemption runs in one transaction with the code row locked `FOR UPDATE` —
without the lock, two students submitting the same code milliseconds apart both
read it as unused and both get activated.

---

## Access codes

Length, alphabet and batch ceiling all live in
[`src/config/constants.js`](src/config/constants.js) and are served to the app at
`GET /api/meta/constants`. The app never hardcodes `10` — it asks. Changing the
length is a server config change, not an app-store release.

> The written spec says "8-digit" in the overview and "10-digit" in both the
> student and admin sections. **10** is implemented, because that is the number
> in the actual feature requirements — and it is a constant precisely because
> that disagreement should be resolvable without a code change.

Codes are generated with `crypto.randomInt`, not `Math.random`. These are the
only thing between a stranger and a paid account, and `Math.random` is seeded
predictably enough to enumerate a day's worth from a handful of samples.

Uniqueness is enforced by the `UNIQUE` index and retried on `ER_DUP_ENTRY`,
rather than by SELECT-then-INSERT, which races.

### Sharing

`POST /api/codes/share` renders a batch as text in four formats — `whatsapp`,
`email`, `plain`, `csv` — and the app only decides which share sheet to open.
Formatting on the server means Android, iOS and web cannot drift apart.

The WhatsApp format wraps codes in ``` so they arrive monospaced; a 10-digit
number in a proportional font is genuinely hard to read back over a phone call.
The CSV quotes the code column, because Excel reads a bare 10-digit number as a
float and renders `1234567890` as `1.23457E+09`, destroying it.

---

## Content

`Class → Subject → Chapter → Topic` is one self-referencing table
(`content_node`), not four. Four tables would mean four joins for a breadcrumb
and a migration to add a level.

`class_level` is denormalised down the tree so "what can class 6 see" is one
indexed lookup rather than walking up the tree per student per request.

Visibility is applied **server-side**. Sending everything and letting the app
hide things puts the content one proxy away from anyone.

---

## Auth model

Two tokens:

| | Lifetime | Stored | Why |
|---|---|---|---|
| access | 15 min | nowhere | Stateless, checked on every request |
| refresh | 30 days | SHA-256 digest in `refresh_token` | One row to revoke when a phone is lost |

Refresh tokens **rotate** — the old one is revoked as the new one is issued.
Reuse is the signature of a stolen token, and rotation makes the theft visible:
the real device's next refresh fails and forces a sign-in.

`authenticate` re-reads the user from the database on every request rather than
trusting the status baked into the token. That is one indexed lookup in exchange
for "deactivate" taking effect immediately instead of up to 15 minutes later.

### Passwords

bcrypt at cost 12, with a per-password salt. **Not** AES with an encryption key —
encryption is reversible by design, and anyone holding the key could read every
password back out, which is exactly what must be impossible.

`verifyPassword` runs a bcrypt comparison against a dummy hash even when the
user has no password (every student). Returning early would make a wrong-password
attempt measurably faster than an unknown-account one, which is enough to
enumerate who has an account.

---

## OTP

Codes are stored as SHA-256 digests. This table is the highest-value thing in the
database for an attacker with read access — every live row is a key to somebody's
account for the next five minutes.

Five wrong guesses burn the challenge. Six digits falls to a script in under a
minute otherwise.

`OTP_PROVIDER=console` prints the code to the server log. It is the development
default, and [`src/config/index.js`](src/config/index.js) **refuses to boot** with
it under `NODE_ENV=production` — a config mistake that would otherwise write live
OTPs into your logs.

---

## Layout

```
src/
├── config/
│   ├── constants.js     # every business rule number, in one file
│   ├── index.js         # env, validated at boot
│   └── db.js            # pool, query helpers, transaction()
├── db/
│   ├── schema.sql       # every table, IF NOT EXISTS
│   ├── migrate.js       # creates the DB, applies schema.sql
│   └── seed.js          # idempotent; refuses NODE_ENV=production
├── middleware/
│   ├── auth.js          # authenticate, requireRole, requireActive
│   └── error.js         # one error shape for the whole API
├── services/
│   ├── password.js      # bcrypt, sha256, timing-safe compare
│   ├── tokens.js        # sign / verify / rotate
│   ├── otp.js           # issue, verify, deliver
│   └── accessCode.js    # generate, redeem, stats
└── routes/
    ├── auth.routes.js       students, parents and admins
    ├── admin.routes.js      dashboard, admin users, settings, audit
    ├── schools.routes.js    section 2.2
    ├── students.routes.js   section 2.3
    ├── codes.routes.js      section 2.4 + sharing
    ├── content.routes.js    sections 2.5 / 2.6 + the student view
    ├── parent.routes.js     linking, children, activity
    └── misc.routes.js       health, constants, public school list, legal
```

---

## Endpoints

| Method | Path | Who |
|---|---|---|
| POST | `/api/auth/otp/request` | anyone |
| POST | `/api/auth/otp/verify` | anyone |
| POST | `/api/auth/register` | registration token |
| POST | `/api/auth/redeem-code` | student |
| POST | `/api/auth/admin/login` | anyone |
| POST | `/api/auth/refresh` · `/logout` · GET `/me` | session |
| GET | `/api/admin/dashboard` | admin |
| GET/POST/PATCH | `/api/admin/users*` | admin |
| GET/PUT | `/api/admin/settings*` | admin |
| GET | `/api/admin/audit` | admin |
| GET/POST/PUT/PATCH | `/api/schools*` | admin |
| GET/PATCH/PUT | `/api/students*` | admin |
| GET/POST/PATCH | `/api/codes*` | admin |
| POST | `/api/codes/share` | admin |
| GET | `/api/content/my` | active student |
| GET | `/api/content/nodes/:id/children` | active user |
| POST | `/api/content/items/:id/progress` | active student |
| GET/POST/PUT/DELETE | `/api/content/{tree,nodes,items}*` | admin |
| GET/POST/DELETE | `/api/parent/children*` | parent |
| GET | `/api/health` · `/api/meta/constants` · `/api/meta/schools` · `/api/meta/legal/:key` | anyone |

---

## Deliberate choices

- **`transaction()` only where it matters** — code redemption and parent linking.
  Wrapping every write would serialise reads for no benefit.
- **Health returns 200 when the database is down**, with `status: degraded`. A
  load balancer's question is "is this process answering"; a stricter code turns
  a database blip into no API at all.
- **`dateStrings: ['DATE']`** on the pool. Otherwise the driver reinterprets DATE
  columns in the server's local timezone and a student registered on the 1st in
  IST reads back as the 31st in UTC.
- **No `SELECT *` in any response path.** One join added later would start
  shipping `password_hash` to every client.

## Not built yet

- Email OTP delivery throws `501` rather than silently not sending. Wire
  nodemailer in `services/otp.js` → `deliverEmail`.
- `STORAGE_DRIVER=s3` is read from config but only `local` is implemented.
- No rate limiting beyond the OTP cooldown. Put `express-rate-limit` on
  `/api/auth/*` before this is internet-facing.
