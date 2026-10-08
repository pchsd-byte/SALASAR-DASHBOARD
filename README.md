<div align="center">

<img src="client/public/salasar-bg.png" alt="Salasar Techno Engineering Ltd." height="70" />

# Salasar HSD Plant Management Dashboard

**A production, dispatch and manpower dashboard for the Heavy Structure Division — built on top of the spreadsheet the plant already keeps, so nobody had to change how they record data.**

[![Live](https://img.shields.io/badge/demo-live-brightgreen)](https://salasar-dashboard.vercel.app/)
![MERN](https://img.shields.io/badge/stack-MERN-6e56cf)
![React](https://img.shields.io/badge/frontend-React%20%2B%20Vite-61dafb)
![Node](https://img.shields.io/badge/backend-Node%20%2B%20Express-339933)

</div>

---

## Contents

1. [The problem](#the-problem)
2. [What it does](#what-it-does)
3. [How it works](#how-it-works)
4. [Who can see what](#who-can-see-what)
5. [Tech stack](#tech-stack)
6. [Repository layout](#repository-layout)
7. [Getting started](#getting-started)
8. [Environment variables](#environment-variables)
9. [Tests and data-correctness checks](#tests-and-data-correctness-checks)
10. [Deployment](#deployment)
11. [Operating notes](#operating-notes)
12. [Known data-quality issues](#known-data-quality-issues)
13. [Project history](#project-history)

---

## The problem

Plant heads and coordinators tracked production, dispatch and manpower in one large, hand-maintained Excel workbook on Google Drive — scrolling dozens of columns to find today's numbers, writing weekly performance emails by hand, and with no single trustworthy view of where things actually stood. Stale copies and misread cells routinely sent wrong figures to leadership.

This app reads that same workbook and turns it into a dashboard. **The workbook stayed exactly as it was** — the team's data entry never changed.

The consequence shapes the whole codebase: the source of truth is a spreadsheet people edit by hand, all day, with no schema. Column layouts move between months, dates get mistyped, summary tables appear below data tables. **Most of the difficulty here is parsing, not application logic** — so the parsers and their offline checking scripts are the core of the system, not an afterthought.

## What it does

### Production Synopsis
Production by process stage (cutting → fit-up → welding → visual → blasting → final coat), dispatch by client, and manpower by category and shift — for both business units, HSD and Bhilai. Everything filters by date range (presets or a custom calendar range), by business unit and by client. Charts expand into a modal for a closer look.

Two details that matter for correctness:
- **Manpower is weighted**: `Day + Night + ½ × 12.30`, because `12.30` is a half shift and counts as half a head.
- **Production totals are summed from daily increments**, never derived from differences in the running cumulative — the cumulative genuinely falls sometimes, and those are real corrections.

### Dispatch Synopsis
A second view, fed by a folder of one-workbook-per-month synopsis reports. It charts department-wise dispatch against plan: monthly plan vs actual, achievement against target, day-by-day tonnage by group, cumulative pace, share by group and by Inhouse/Job Work/Buyout, per-department performance, a department-by-month grid, and tower/pole counts. Filterable by month or a custom range, with the plan pro-rated across a partial range.

### AI insights
An optional panel (Google Gemini) that reads only the numeric snapshot on screen and writes a short narrative with severity-tagged insights and recommendations. Cached for 24 hours, keyed by a hash of the figures themselves, so the narrative can never quote numbers that have since changed. Without an API key the panel simply degrades.

### Email reports
A composer inside the dashboard: editable report text, inline images by paste or drag-and-drop, and per-client templates — Zetwerk, CNC, COW, Ramboll, HSD Production, Machine, Painting, Quality, plus a blank draft. Reports can be sent immediately or scheduled, with the queue visible and cancellable.

Sending goes over the **Gmail API**, not SMTP (Render blocks outbound SMTP). Scheduled sends are **at-most-once**: each is claimed atomically before it goes out, so overlapping ticks or a second server instance cannot send it twice.

### Create Image Reports
The daily report that gets shared on WhatsApp and email is a stack of spreadsheet screenshots. This tool builds it in the browser: paste screenshots with `Ctrl+V` (or drop files), and they are arranged into one PNG.

- **Fit** packs them into rows that fill the width, with even gutters and margins.
- **Stack** puts one per row.
- **Free** lets you drag, resize and snap each one by hand — the canvas is the finished image.

Then **Copy image** (straight into an email or WhatsApp) or **Download PNG**. Nothing is uploaded; it all happens in the browser.

### People and access
Admins add colleagues by work email from **Settings → People and access**, give them a job title ("Process Coordinator — Unit 2"), an access level (admin or manager) and tick the sections they may open. Access applies on their next page load — no sign-out needed — and can be revoked without deleting the record.

### Sync status
A badge on every page shows when the data last came from Drive, how many rows were written, and how many issues the run reported. Opening it lists what the sync found, including the spreadsheet's own data problems.

### Screenshots

![Dashboard overview](docs/screenshots/dashboard.png)
_Manpower, dispatch and completion figures, with date-range filters and expandable charts._

<!-- Add more to docs/screenshots/ and reference them the same way, e.g.
![Email composer](docs/screenshots/email.png) -->

## How it works

```
Google Drive (.xlsx, hand-edited)              Google Gemini
        │                                            │
        │ Drive API v3 (read-only)                   │ @google/genai
        ▼                                            ▼
┌────────────────────────────────────────────────────────────┐
│  SERVER — Node + Express                      (Render)     │
│  daily cron ─► sync.service ─► parsers ─► MongoDB          │
│  REST /api/*  ·  gzip + ETag + in-memory cache             │
│  Gmail API send  ·  email scheduler  ·  keep-alive         │
└────────────────────────────────────────────────────────────┘
        │ JSON over HTTPS (httpOnly cookie) — on page load only
        ▼
┌────────────────────────────────────────────────────────────┐
│  CLIENT — React + Vite                        (Vercel)     │
└────────────────────────────────────────────────────────────┘
```

The client **never** reads Drive; everything arrives through MongoDB. A chart that looks empty almost always means the sync could not read its source — check the badge before suspecting the UI.

### The data flow

```
Drive file ──► getSheetValues / getWorkbookRows   (xlsx → array of arrays)
           ──► parse*Sheet()                      (pure: no I/O, no database, no clock)
           ──► records[]                          (plain objects)
           ──► bulkWrite upsert + gated cleanup   (sync.service.js)
           ──► MongoDB
           ──► controller aggregation             (weighting, averaging, reshaping)
           ──► REST JSON ──► TanStack Query ──► Recharts
```

**Parsers are pure functions.** That is what makes the offline checkers below possible, and it is worth preserving.

### Two independent sources

| | Live workbook | Monthly synopsis folder |
|---|---|---|
| Env var | `HSD_SPREADSHEET_ID` | `SYNOPSIS_FOLDER_ID` |
| Shape | One `.xlsx`, many tabs | One `.xlsx` per month, in a folder |
| Feeds | Manpower, Production, Dispatch | Dispatch Synopsis |
| Write strategy | Upsert + gated stale cleanup | Whole month replaced, in a transaction |

Both are uploaded `.xlsx` files rather than native Google Sheets, so they are downloaded as raw bytes and parsed locally with `xlsx`.

### Layout is discovered, never assumed

Blocks are located by the text of their own header rows, never by fixed row or column numbers. April puts a table at top-left; May shifts it to column 7; June adds a column and sub-total rows. **Any change that reintroduces a hard-coded index will break on the next month's file.**

### Safeguards worth knowing about

- **One sync at a time, across processes** — a lease in the database, so a deploy overlap or a laptop pointed at production cannot run two syncs at once.
- **Stale-record cleanup is gated.** A sync landing while somebody is mid-edit parses a fraction of the sheet; cleanup is refused when a parse is under 70% of what it would replace, and a synopsis month is never replaced by one reporting under half its stored tonnage.
- **Every record is validated** against its schema before writing (`bulkWrite` does not validate).
- **Nothing fails silently.** Each source is isolated, and every skip is recorded with a severity in the sync log.

## Who can see what

Access is resolved in one place and enforced on **every request** — the UI only decides what to draw.

| Section | Gives access to |
|---|---|
| `dashboard` | Production Synopsis, Dispatch Synopsis, AI insights, targets |
| `email` | The report composer, scheduling and the queue |
| `settings` | Drive connection and the sync log |

| Access level | What it means |
|---|---|
| **Manager** | Exactly the sections ticked for them |
| **Admin** | Every section, plus People and access, Drive connect/disconnect and manual sync |

Two rules protect the setup:

- **`ADMIN_EMAILS` always wins**, is checked before any database query, and cannot be edited from the UI. It is the way back in if the people list is ever emptied — and it means an admin can still sign in when MongoDB is the thing that is broken.
- **The last admin cannot be demoted, switched off or removed.**

Anyone at a domain in `ALLOWED_LOGIN_DOMAINS` who is not on the list can sign in and read the dashboard, as before. To make the list the only rule, clear that variable.

**Email is a section, not a person.** Several process coordinators can compose and send; what stays with `EMAIL_USER` is the Gmail authorisation — every report leaves from that one mailbox whoever wrote it.

## Tech stack

**Frontend** — React 19, Vite, Tailwind CSS v4 (via the Vite plugin, no config file), Recharts, TanStack Query, React Router, Framer Motion, date-fns, axios. Linted with oxlint. No TypeScript.

**Backend** — Node.js (ESM), Express 4, Mongoose/MongoDB Atlas, googleapis (Drive + Gmail), google-auth-library, jsonwebtoken, node-cron, compression, helmet, express-rate-limit, express-mongo-sanitize, `xlsx` for parsing, `@google/genai` for insights, nodemailer (only `MailComposer`, to build the MIME body for Gmail).

**Deliberate absences** — no TypeScript, no test framework (Node's built-in `node:test`), no state library beyond React Query, no monorepo tooling. `client/` and `server/` are installed and deployed separately.

## Repository layout

```
├── CLAUDE.md               # the deep internal guide: parsers, incidents, invariants
├── README.md
├── docs/screenshots/
├── client/
│   ├── vite.config.js      # dev proxy to :5001
│   ├── vercel.json         # SPA rewrite — without it every deep link 404s
│   └── src/
│       ├── App.jsx         # providers + routes
│       ├── index.css       # design tokens
│       ├── context/AuthContext.jsx
│       ├── lib/{api.js,sections.js}
│       ├── pages/{Dashboard,Login,Settings,Email,NoAccess}.jsx
│       └── components/
│           ├── layout/{Navbar,ProtectedRoute}.jsx
│           ├── settings/TeamAccessPanel.jsx      # add people, tick sections
│           ├── email/{EmailComposer,emailTemplates,ImageReportBuilder}
│           └── dashboard/…                       # charts, filters, badge, synopsis
└── server/
    ├── .env.example
    ├── scripts/            # offline reconciliation checkers
    ├── test/               # node:test suites + fixtures
    └── src/
        ├── server.js       # boot: database → crons → listen
        ├── app.js          # middleware + route mounting
        ├── config/{env,db,google}.js
        ├── middleware/auth.js
        ├── models/         # 14 Mongoose models
        ├── routes/ · controllers/
        ├── services/
        │   ├── sync.service.js · googleSheets.service.js
        │   ├── access.service.js · payloadCache.js
        │   ├── aiInsights.service.js · mailer.service.js
        │   └── parsers/    # ← the hard part
        ├── jobs/{cron,emailScheduler,keepAlive}.js
        └── utils/{crypto,roundNumbers,sheetDate,asyncHandler}.js
```

### API surface

All under `/api`. Everything except the health and auth entry points needs a valid session cookie for an allowed account; role and sections are re-derived on every request and never trusted from the token.

| Method | Path | Guard | Purpose |
|---|---|---|---|
| `GET` | `/health`, `/health/deep` | — | Liveness; the deep one 503s when MongoDB is disconnected |
| `GET` | `/auth/google`, `/auth/google/callback` | — | Sign in |
| `GET` | `/auth/me` | auth | Current user: role, title, sections |
| `POST` | `/auth/logout` | — | Clears the cookie |
| `GET`/`POST` | `/auth/google/connect-drive…` | admin | Drive grant (offline) |
| `GET` | `/auth/google/connect-gmail…` | `EMAIL_USER` | Gmail send grant |
| `GET` | `/auth/google/gmail-send-status` | `email` section | Is sending connected, and from which mailbox |
| `GET` | `/dashboard/hsd/summary` | `dashboard` | `?from&to&businessUnit&client` |
| `GET` | `/dashboard/hsd/insights` | `dashboard` | Gemini insights (cached 24 h) |
| `GET` | `/dashboard/manpower` | `dashboard` | Raw records |
| `GET` | `/dashboard/synopsis` | `dashboard` | `?month` **or** `?from&to` |
| `GET`/`POST`/`PATCH`/`DELETE` | `/users[/:email]` | admin | People and access |
| `GET` | `/sync/status` | auth | Badge summary; `?detail=1` for the full log |
| `POST` | `/sync/run` | admin | Manual sync (409 while one is running) |
| `GET`/`POST`/`DELETE` | `/targets[/:client]` | `dashboard` / admin | Per-client targets |
| `POST` | `/email/send`, `/email/schedule` | `email` section | Send or schedule |
| `GET`/`DELETE` | `/email/scheduled[/:id]` | `email` section | Manage the queue |

## Getting started

```bash
# install — two separate package roots, no workspace tooling
cd server && npm install
cd ../client && npm install

# configure
cp server/.env.example server/.env    # then fill in your own credentials

# run (two terminals)
cd server && npm run dev              # node --watch → http://localhost:5001
cd client && npm run dev              # vite          → http://localhost:5173
```

In development the client calls `/api` on its own origin and Vite proxies it to `localhost:5001`. In production they are different origins, so `VITE_API_URL` must point at the deployed server.

Sign in with Google, then as an admin open **Settings** and connect Google Drive. Run **Sync now** to pull the first set of figures, and add your colleagues under **People and access**.

```bash
cd client && npm run build     # production build → client/dist
cd client && npm run lint      # oxlint
cd client && npm run preview   # serve the production build
```

## Environment variables

Set in `server/.env` (see `server/.env.example`). The server refuses to boot if a required one is missing.

| Variable | Notes |
|---|---|
| `MONGODB_URI` | **Required.** |
| `GOOGLE_CLIENT_ID` / `GOOGLE_CLIENT_SECRET` | **Required.** One OAuth app, three redirect URIs. |
| `GOOGLE_LOGIN_REDIRECT_URI`<br>`GOOGLE_DRIVE_REDIRECT_URI`<br>`GMAIL_SEND_REDIRECT_URI` | Default to localhost. On Render, an unset or localhost value is derived from the service's own URL. Each must also be listed on the Google OAuth client. |
| `JWT_SECRET` · `TOKEN_ENCRYPTION_KEY` | Development fallbacks exist for local use only — a deployed server refuses to start on them. |
| `ADMIN_EMAILS` | Comma-separated. Always admins; the lock-out guard. |
| `ALLOWED_LOGIN_DOMAINS` | Default `salasartechno.com`. `*` allows any Google account; empty makes the people list the only rule. |
| `ALLOWED_LOGIN_EMAILS` | Comma-separated exceptions (staff on personal addresses). |
| `CLIENT_ORIGIN` | CORS origin, CSRF origin check **and** post-login redirect target. No trailing slash. |
| `HSD_SPREADSHEET_ID` | The live workbook. |
| `SYNOPSIS_FOLDER_ID` | Folder of monthly synopsis workbooks. |
| `SYNC_CRON` · `SYNC_TIMEZONE` | When the daily sync runs. Default `30 21 * * *`, Asia/Kolkata. |
| `GEMINI_API_KEY` | Optional — the insights panel degrades without it. |
| `EMAIL_USER` | The mailbox reports are sent from, and the only account that can grant the Gmail scope. |
| `RENDER_EXTERNAL_URL` | Set by Render; drives the keep-alive ping. |

Client: `VITE_API_URL` — empty in development, the deployed server URL in production.

## Tests and data-correctness checks

```bash
cd server && npm test
```

Node's built-in `node:test` — no framework. Covers the parsers, API security and permissions, payload sizes and caching, and the whole sync against an in-memory MongoDB replica set. It never touches the database in `.env`: the test environment forces a dead address.

The **offline reconciliation scripts** re-add the source spreadsheets cell by cell and compare the result against both the parser and the figures the sheets compute for themselves. Each exits non-zero on any disagreement.

```bash
cd server
npm run check:synopsis   -- /path/to/folder-of-monthly-xlsx
npm run check:manpower   -- /path/to/workbook.xlsx
npm run check:production -- /path/to/workbook.xlsx
npm run check:dispatch   -- /path/to/workbook.xlsx
node scripts/audit/simulateSynopsisSync.js /path/to/folder
```

They need a local copy of the workbooks — none is committed, as they are business-confidential. Download them from the Drive file and folder the environment variables name.

> Some of these **fail today, and should**: the failures are mistakes in the source spreadsheets (see below), not in the code.

## Deployment

- **Client → Vercel.** Root directory `client`. `client/vercel.json` adds the SPA rewrite and security headers; without the rewrite every deep link 404s.
- **Server → Render.** Root directory `server`, start command `npm start`. The repo root has no `package.json`, so a builder pointed at the root will fail.
- Both deploy from `main`.

Three deployment facts learned the hard way:

1. **The session cookie shape is derived from `req.secure`, not `NODE_ENV`** — Render does not guarantee `NODE_ENV=production`. Guess wrong and the cookie is silently never returned, so every login bounces back to `/login` with no visible error.
2. **SMTP does not work from Render** on this plan — hence the Gmail API.
3. **Render's free tier sleeps after ~15 minutes idle**, so the server pings its own `/api/health` every 10 minutes to keep the email scheduler alive.

## Operating notes

### Bandwidth — why the traffic looks the way it does

Render's Hobby workspace includes 5 GB of bandwidth a month, and exceeding it **suspends every service in the workspace**. The app was hitting that every five or six days. Measured, the two causes and their fixes:

| | Before | After |
|---|---|---|
| `/sync/status` — the whole sync log, polled every 60 s by every open tab, uncompressed | ≈ **11 GB/month** | 339 bytes on page load ≈ **0.6 MB/month** |
| Drive downloads — every workbook, every 10 minutes | ≈ **4 GB/month** | changed files only, once a day ≈ **14 MB/month** |

What keeps it there, and should not be undone casually:

1. **The sync runs once a day** (`SYNC_CRON`), because the workbook is filled in by hand once a day, in the evening. "Sync now" still works at any time.
2. **Nothing unchanged is downloaded.** Each run asks Drive for the file's `modifiedTime` first — a few hundred bytes — and fetches the bytes only if it differs from the version already parsed.
3. **`/sync/status` returns counts, not the log.** The warning text comes only from `?detail=1`, which is fetched when someone actually opens the details.
4. **gzip on every response**, plus **ETag** and `Cache-Control: private, no-cache`, so an unchanged answer costs a 304 with no body.
5. **An in-memory payload cache**, keyed by route and query, cleared whenever a sync writes rows.
6. **No polling and no websocket.** The client fetches when the page loads and when an admin runs "Sync now" — an open dashboard makes no requests at all.

### Why the figures on screen don't move

The dashboard deliberately freezes what it loaded for the page session, for every role: numbers must not shift under somebody who is reading them. Payloads carry `dataAsOf`, shown as "Figures as of the … sync". To see newer figures, reload the page.

## Known data-quality issues

These are **spreadsheet** problems. The app reports them; it never invents corrections. The sync log and the badge surface each one, and `CLAUDE.md` §9 records them in full. Currently open:

- **Manpower — two mistyped date headers.** February's table carries an `11-Mar-2026` header where 11-Feb belongs, and March's a `10-Feb-2026` where 10-Mar belongs. Those two days hold two months' figures under one key, and 11 Feb / 10 Mar have no data at all. Only the sheet's owner can say which is right.
- **Dispatch Synopsis — January's `22.06.26` column.** A January workbook column is labelled with a June date; its 120.211 MT is left out of every total, with a warning, until the cell is corrected.
- **Production — `L&T MHI Progress` holds RIL's May–Nov 2025 blocks.** They are recorded under RIL (once) and warned on every sync; confirm with the sheet owner, then move them out of that tab.
- **Production — stale "From 1st to till now" cells.** For several months the sheet's own total disagrees with its own daily increments. The increments are used.
- **Manpower — April/May 2025 blocks are skipped** (dates written as text, entries like `"78+23"`). Deliberately left alone.

## Project history

| Stage | What happened |
|---|---|
| **1 — Foundation** | Express + MongoDB + Google OAuth, the sheet-sync skeleton, both business units |
| **2 — Analytics** | Recharts dashboard, AI insights, targets; cumulative-vs-increment settled here |
| **3 — Email automation** | Composer with inline images, per-client templates, scheduling |
| **4 — Production hardening** | Deployment realities: the cookie, CORS, cold starts, SPA rewrites |
| **5 — Data accuracy** | Stale-record cleanup, after row shifts caused double counting |
| **6 — Dispatch Synopsis** | New parser, two models, folder-based sync, chart suite, custom ranges |
| **7 — Manpower correctness** | Column stride, summary-row detection, half-shift weighting |
| **8 — Image reports** | Paste-and-arrange screenshot composer with copy/download |
| **9 — Bandwidth** | Daily sync, conditional downloads, caching, compression, no polling |
| **10 — People and access** | Sections and roles, managed from Settings instead of environment variables |

**The pattern worth noticing:** every stage after deployment has been about the *source data* or the *deployment environment*, not application features. Expect the next problem to be one of those two as well.

---

<div align="center">
<sub>Built for Salasar Techno Engineering Ltd. — Heavy Structure Division</sub>
</div>
