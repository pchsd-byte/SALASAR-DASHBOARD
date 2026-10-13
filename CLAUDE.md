# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

---

## 1. What this project is

A plant-management dashboard for **Salasar Techno Engineering Ltd. — Heavy Structure Division (HSD)**.

The plant already tracked everything — production, dispatch, manpower — in a large, live, hand-maintained Excel workbook on Google Drive. That workbook stayed; this app reads it and turns it into a dashboard, so nobody had to change how they enter data.

**The consequence that shapes the whole codebase:** the source of truth is a spreadsheet that people edit by hand, all day, with no schema. Column layouts move between months, dates get mistyped, summary tables appear below data tables, and the same figure gets written three different ways. **Most of the difficulty in this repo is parsing, not application logic.** Treat the parsers and their checking scripts as the core of the system.

### 1.1 Business units and vocabulary

| Term | Meaning |
|---|---|
| **HSD** | Heavy Structure Division — the main plant. Towers, poles, bridge components. |
| **BU / Bhilai** | The second business unit. Manpower only — no production or dispatch source connected. |
| **MT** | Metric tons. Every quantity except manpower headcount. |
| **Client** | Adani, L&T MHI, RIL, AFCONS, AMNS — who the steel is for. |
| **Process stage** | cutting → fitUp → welding → visual → blasting → finalCoat. `finalCoat` = production completed. |
| **12.30** | A half shift. Counts as **half a head** in every total (see §7.2). |
| **Mode** | How work was produced: Inhouse / Job Work / Buyout. |

---

## 2. Commands

### 2.1 Everyday

```bash
# install (two separate package roots — there is no workspace/monorepo tooling)
cd server && npm install
cd client && npm install

# run (two terminals)
cd server && npm run dev     # node --watch, http://localhost:5001
cd client && npm run dev     # vite,        http://localhost:5173

# build / lint
cd client && npm run build   # vite build -> client/dist
cd client && npm run lint    # oxlint
cd client && npm run preview # serve the production build
```

In dev the client calls `/api` on its own origin and **Vite proxies** `/api` to `localhost:5001` (`client/vite.config.js`). In production they are different origins and `VITE_API_URL` must point at the deployed server.

### 2.2 Tests and data-correctness checks — run these after touching any parser, the sync, or a controller

```bash
cd server
npm test    # node:test (built in — no framework). Parsers, API security, and the whole sync
            # against an in-memory MongoDB replica set (mongodb-memory-server, dev-only).
            # Never touches the database in .env: test/helpers/env.js forces a dead address.
```

The offline reconciliation scripts re-add the source spreadsheets cell by cell and compare against the parser and against the figures the sheets compute for themselves. Each exits non-zero on any disagreement.

```bash
cd server
npm run check:synopsis   -- /path/to/folder-of-monthly-xlsx   # dept columns vs the sheet's cumulative/balance/achieved-%
npm run check:manpower   -- /path/to/workbook.xlsx            # every cell re-added, raw + weighted, parsed AND as-stored
npm run check:production -- /path/to/workbook.xlsx            # month totals vs "From 1st to till now"; cross-client double counts
npm run check:dispatch   -- /path/to/workbook.xlsx            # rows vs "Total Dispatch"; Bhilai rows tagged BU
node scripts/audit/simulateSynopsisSync.js /path/to/folder    # replays the sync's unique-index writes; KPI vs month totals
```

They need a local copy of the workbooks. No real workbook is committed (business-confidential) — download from the Drive folder/file the env vars name. Test fixtures are small synthetic grids built in `test/helpers/sheets.js`.

**Expected failures today are all source-data errors (§9), not code:** `check:manpower` (§9.1), `check:synopsis` (§9.6 — January's `22.06.26` column is left out until corrected), `check:production` (§9.7/§9.8). Every regression test in `test/` fails against the pre-audit code (verified Sep 2026).

---

## 3. Architecture

### 3.1 Topology

```
Google Drive (.xlsx, hand-edited)          Google Gemini
        │                                        │
        │ Drive API v3 (read-only)               │ @google/genai
        ▼                                        ▼
┌──────────────────────────────────────────────────────────┐
│  SERVER — Node + Express          (Render)               │
│  daily cron ─► sync.service ─► parsers ─► MongoDB         │
│  REST /api/* (gzip, ETag, memory cache) · Gmail API send  │
└──────────────────────────────────────────────────────────┘
        │ JSON over HTTPS (httpOnly cookie) — on page load only
        ▼
┌──────────────────────────────────────────────────────────┐
│  CLIENT — React + Vite            (Vercel)               │
└──────────────────────────────────────────────────────────┘
```

The client **never** reads Drive. Everything arrives via MongoDB. A chart that looks empty almost always means the sync did not run or could not read the source — check the sync badge before suspecting the UI.

### 3.2 The one data flow that matters

```
Drive file ──► getSheetValues / getWorkbookRows   (xlsx -> array-of-arrays)
           ──► parse*Sheet()                      (pure, no I/O, no DB)
           ──► records[]                          (plain objects)
           ──► bulkWrite upsert + stale cleanup   (sync.service.js)
           ──► MongoDB
           ──► controller aggregation             (weighting, averaging, reshaping)
           ──► REST JSON ──► TanStack Query ──► Recharts
```

**Parsers are pure functions.** They take rows and return `{ records, warnings }`. No database, no network, no dates from `Date.now()`. This is what makes the offline checkers possible — preserve it.

### 3.3 Two independent data sources

| | Live workbook | Monthly synopsis folder |
|---|---|---|
| Env var | `HSD_SPREADSHEET_ID` | `SYNOPSIS_FOLDER_ID` |
| Shape | One `.xlsx`, many tabs | One `.xlsx` per month, in a folder |
| Tabs / files | `Manpower`, `Adani Progress`, `L&T MHI Progress`, `RIL Progress`, `Daily Dispatch` | `april.xlsx`, `may.xlsx`, … |
| Feeds | Manpower, Production, Dispatch | Dispatch Synopsis |
| UI | Dashboard → **Overview** toggle | Dashboard → **Dispatch Synopsis** toggle |
| Write strategy | Upsert + gated stale cleanup (all three sources) | Whole-month replace, in a transaction |

Both are downloaded as **raw bytes and parsed locally with `xlsx`** — they are uploaded `.xlsx` files, not native Google Sheets, so the Sheets API cannot read them.

---

## 4. Technology stack — what, and why

### 4.1 Server (`server/package.json`, `"type": "module"`, ESM throughout)

| Package | Version | Why it is here |
|---|---|---|
| `express` | ^4.21.2 | HTTP layer. v4, not v5. |
| `mongoose` | ^8.9.5 | Schemas carry the enum/min constraints. **`bulkWrite` `updateOne` never validates** — so `sync.service.js` validates every record (`validateRecords`) before writing. `dailyIncrementQty` deliberately has no `min`: negative increments are real corrections. |
| `googleapis` | ^144.0.0 | Drive v3 download/list/export, and Gmail send. |
| `google-auth-library` | ^9.15.0 | OAuth2 clients + `verifyIdToken`. Three separate grants (§6.1). |
| `xlsx` | ^0.18.5 | Parses the downloaded workbooks. Always read with `{ header: 1, raw: true }`. Has open advisories (prototype pollution, ReDoS) fixed only in SheetJS's CDN build 0.20.3; npm 12 blocks remote tarballs (`allow-remote=none`), so upgrading is a deliberate decision — re-run every checker after. |
| `@google/genai` | ^2.17.1 | Gemini client for AI insights. |
| `jsonwebtoken` | ^9.0.2 | Session JWT, carried in an httpOnly cookie. |
| `compression` | ^1.8.2 | gzip on every API response. JSON compresses ~10x, and Render's free tier meters bandwidth (§8.6). |
| `node-cron` | ^3.0.3 | Three schedules: the daily sync (`SYNC_CRON`), email scheduler, keep-alive. |
| `nodemailer` | ^9.0.5 | **Only `MailComposer`** — used to build a MIME message for the Gmail API. SMTP is not used (§6.3). |
| `helmet` · `cors` · `express-rate-limit` · `express-mongo-sanitize` · `cookie-parser` | ^8.3.0 · ^2.8.5 · ^8.6.2 · ^2.2.0 · ^1.4.7 | Standard hardening; see §8. |
| `dotenv` | ^16.4.7 | Loaded once in `config/env.js`. |
| `axios` | ^1.7.9 | Server-side HTTP. |
| `nodemon` | ^3.1.9 (dev) | Unused — `npm run dev` uses node's own `--watch`. |

### 4.2 Client (`client/package.json`, ESM, JSX, no TypeScript)

| Package | Version | Why it is here |
|---|---|---|
| `react` / `react-dom` | ^19.2.8 | |
| `vite` | ^8.2.0 | Dev server + build. `@vitejs/plugin-react` ^6.0.4. |
| `tailwindcss` + `@tailwindcss/vite` | ^4.3.3 | v4, configured through the Vite plugin — **no `tailwind.config.js`**. |
| `recharts` | ^3.10.1 | Every chart. |
| `@tanstack/react-query` | ^5.101.4 | Server state, caching, `keepPreviousData`. |
| `react-router-dom` | ^7.18.2 | Four routes (§5.2). |
| `framer-motion` | ^13.1.0 | Card entrance stagger, modal transitions. |
| `date-fns` | ^4.4.0 | All client-side date formatting. |
| `react-day-picker` | ^10.0.1 | The custom-range calendar. |
| `axios` | ^1.19.0 | `withCredentials: true` — required for the cookie. |
| `clsx` | ^2.1.1 | Conditional classes. |
| `oxlint` | ^1.75.0 (dev) | Linter. Config: `client/.oxlintrc.json`. |

### 4.3 Deliberate absences

No TypeScript, no test framework (tests use Node's built-in `node:test`; the only test dependency is `mongodb-memory-server`), no state library beyond React Query, no CSS framework beyond Tailwind, no monorepo tooling. `client/` and `server/` are installed and deployed separately. `server/package.json` pins `qs` via `overrides` (Express 4 ships a vulnerable one).

---

## 5. Repository layout

```
├── CLAUDE.md · README.md · .gitignore
├── docs/screenshots/
├── client/
│   ├── vite.config.js          # dev proxy to :5001
│   ├── vercel.json             # SPA rewrite — without it, deep links 404
│   ├── .oxlintrc.json
│   └── src/
│       ├── main.jsx · App.jsx  # providers + routes
│       ├── index.css           # design tokens (§5.3)
│       ├── context/AuthContext.jsx
│       ├── lib/{api.js,sections.js}
│       ├── pages/{Dashboard,Login,Settings,Email}.jsx
│       └── components/
│           ├── layout/{Navbar,ProtectedRoute}.jsx
│           ├── settings/TeamAccessPanel.jsx   # admin: add people, tick sections
│           ├── email/{EmailComposer.jsx,emailTemplates.js,
│           │          ImageReportBuilder.jsx}   # "Create Image Reports": pasted screenshots
│           │                                    # → one stacked PNG, in-browser only
│           └── dashboard/…     # charts, StatCard, FilterBar, DateRangePicker,
│                               # ChartModal, SyncStatusBadge, InsightsPanel,
│                               # TargetPanel, Synopsis*, synopsisPalette.js
└── server/
    ├── .env.example
    ├── scripts/{checkSynopsis.js,checkManpower.js}
    ├── scripts/audit/          # check:production, check:dispatch, synopsis sync replay
    ├── test/                   # node:test suites + helpers/{env,sheets}.js
    └── src/
        ├── server.js           # boot: db → crons → listen
        ├── app.js              # middleware + route mounting
        ├── config/{env,db,google}.js
        ├── middleware/auth.js
        ├── models/             # 13 Mongoose models (incl. TeamMember — people and access)
        ├── routes/ · controllers/
        ├── services/
        │   ├── sync.service.js · googleSheets.service.js · payloadCache.js
        │   ├── aiInsights.service.js · mailer.service.js
        │   └── parsers/        # ← the hard part
        ├── jobs/{cron,emailScheduler,keepAlive}.js
        └── utils/{crypto,roundNumbers,sheetDate}.js
```

### 5.1 API surface

All under `/api`. Every route except `/health`, `/health/deep`, `/auth/google*`, and `/auth/logout` requires a valid session cookie **for an allowed account** (§6.1) — access and role are re-derived from the current env on every request, never trusted from the token. Every handler is wrapped in `utils/asyncHandler.js`: in Express 4 an async throw otherwise kills the whole process.

| Method | Path | Guard | Purpose |
|---|---|---|---|
| GET | `/health` | — | Liveness. Also the keep-alive target. Deliberately trivial. |
| GET | `/health/deep` | — | 503 when MongoDB is disconnected. |
| GET | `/auth/google` → `/auth/google/callback` | — | Login (online grant). |
| GET | `/auth/me` | auth | Current user. |
| POST | `/auth/logout` | — | Clears the cookie. |
| GET | `/auth/google/connect-drive[/callback]` | admin | Drive grant (offline). |
| POST | `/auth/google/disconnect-drive` | admin | Deletes the stored token. |
| GET | `/auth/google/connect-gmail[/callback]` | `EMAIL_USER` only | Gmail send grant (offline). |
| GET | `/auth/google/gmail-send-status` | `EMAIL_USER` only | Is Gmail connected. |
| GET | `/dashboard/hsd/summary` | auth | Overview. `?from&to&businessUnit&client` |
| GET | `/dashboard/hsd/insights` | auth | Gemini insights (cached). |
| GET | `/dashboard/manpower` | auth | Raw records. |
| GET | `/dashboard/synopsis` | auth | Dispatch Synopsis. `?month` **or** `?from&to` |
| GET/POST | `/users` · PATCH/DELETE `/users/:email` | admin | People and access: who may sign in and which sections they get (§6.5). |
| GET | `/sync/status` | auth | Badge summary (counts, ~340 bytes) + Drive state. `?detail=1` adds the run's issues/sources. |
| POST | `/sync/run` | admin | Manual sync. 409 while another sync holds the lock. |
| GET/POST/DELETE | `/targets[/:client]` | auth / admin / admin | Per-client targets. |
| POST | `/email/send` · `/email/schedule` | `EMAIL_USER` + 10/15min | Send or schedule. |
| GET/DELETE | `/email/scheduled[/:id]` | `EMAIL_USER` | Manage the queue. |

### 5.2 Client routes

| Path | Guard | |
|---|---|---|
| `/login` | public | Google button only. |
| `/` | authenticated | Dashboard — **Overview** / **Dispatch Synopsis** toggle. |
| `/settings` | `section="settings"` | Two tabs for an admin — **People and access** (opens first; it is what they come here for) and **Google Drive sync**. A manager with only the section sees the Drive card alone. Returning from a Drive connection (`?driveConnect=`) opens the Drive tab. (There is no targets UI — `TargetPanel.jsx` is not rendered anywhere.) |
| `/email` | `section="email"` | Report composer + scheduler. |
| `/access-denied` | **public** | Where a refused sign-in lands — `?email=&reason=not_allowed\|revoked`. No session exists, so the address comes in the URL. |
| `/no-access` | authenticated | On the list, signed in, but no section ticked yet — same page, `variant="no_sections"`. |

Routes and nav links are driven by the sections on `/auth/me` (`client/src/lib/sections.js`). **That gating is cosmetic: the server re-checks every request** with `requireSection(...)` — a manager without the `dashboard` section is refused the figures themselves, not merely the link. The old `PC_HSD_EMAIL` constant is gone; the Email page's "From" line now comes from `/auth/me`'s `emailSender`.

### 5.3 Design tokens — `client/src/index.css`

Charts and surfaces read CSS variables, never literal hex:

- Surfaces: `--surface-page`, `--surface-1`, `--surface-2`
- Ink: `--text-primary`, `--text-secondary`, `--text-muted`
- Chart furniture: `--gridline`, `--baseline`
- Series: `--series-1` … `--series-8`
- Status: `--status-good`, `--status-warning`, `--status-critical`

Light and dark variants are defined for all of them. **The 8 series colours have been validated for adjacent-pair contrast and colour-vision separation in both themes, in that exact order.** Reordering them or introducing new chart colours invalidates that — `client/src/components/dashboard/synopsisPalette.js` documents the constraint and maps categories onto the sequence by a fixed list, never by sort position.

---

## 6. External integrations

### 6.1 Google OAuth — three separate grants

Not one grant with merged scopes. Three, with different lifetimes and different consumers.

| Grant | Access | Scopes | Stored | Who |
|---|---|---|---|---|
| **Login** | `online` | `openid`, `userinfo.email`, `userinfo.profile` | Nothing — the ID token becomes a JWT | Anyone |
| **Drive sync** | `offline` | + `drive.readonly` | `GoogleToken{purpose:'drive-sync'}`, refresh token AES-256-GCM encrypted | Admin |
| **Gmail send** | `offline` | + `gmail.send` | `GoogleToken{purpose:'gmail-send'}`, same encryption | `EMAIL_USER` only |

Each has its own redirect URI env var. Refresh tokens are encrypted at rest by `utils/crypto.js` (AES-256-GCM, key derived by SHA-256 of `TOKEN_ENCRYPTION_KEY`, stored as `iv:authTag:ciphertext` hex).

All three flows carry an OAuth `state` (random value in a 10-minute `oauth_state` cookie, checked on the callback). Login also requires `email_verified` and an **allowed account** — and since Oct 2026 that means **named**: `ADMIN_EMAILS`, `EMAIL_USER`, `ALLOWED_LOGIN_EMAILS`, or a row an admin added (§6.5). `ALLOWED_LOGIN_DOMAINS` is gone: admitting a whole domain was a permission nobody granted. A refused sign-in records an `AccessRequest` and redirects to `/access-denied?email=…&reason=not_allowed|revoked` — not back to `/login` with an error code, which read as "sign-in failed" and sent people round the loop again.

### 6.5 People and access — `services/access.service.js`

Who may sign in, and what they may open. One function, `resolveAccess(email)`, used at sign-in and again on every request (`middleware/auth.js`), answering `{ allowed, role, title, sections }`.

Sections are `dashboard`, `email`, `settings`. An **admin** gets `ADMIN_SECTIONS` — everything **except `email`** — plus the people list itself; a **manager** gets exactly what was ticked. Email is left out of an admin's implied set deliberately: the composer, drafts and send queue belong to the coordinators who write the reports, not to whoever administers Drive and access. An admin who does write reports is ticked for it like anyone else, and `EMAIL_USER` always keeps it. There is no "admin sees everything" shortcut in `canUseSection` or the client's `canOpen` — sections are the whole answer, and `requireAdmin` (role) is what still guards Drive, manual syncs and the people list. `title` is their job on the plant ("Process Coordinator — Unit 2") and shows in the navbar — it replaced a hard-coded name for one address.

Two sources, in this order:

0. **Nobody unnamed.** There is no domain rule. Any Google account — personal or a colleague's work address — is refused until it appears somewhere below, and the attempt is recorded in `AccessRequest` for the admin's queue (90-day TTL, one row per address, repeat attempts increment `attempts`). Granting or dismissing clears it; so does a successful sign-in.
1. **The environment.** `ADMIN_EMAILS` is checked **first and without a database query**: those addresses are always admins, which is both the lock-out guard (the people list cannot leave the app with no admin) and the reason an admin can still sign in when MongoDB is the thing that is down. They cannot be edited through the API — it answers 400 naming `ADMIN_EMAILS`.
2. **`TeamMember`** — what an admin maintains at Settings → People and access. Keyed by **email, not User**: access is granted before that person has ever signed in, so there is no user document yet. `active: false` revokes someone the login domain would otherwise admit.

An address in `ALLOWED_LOGIN_EMAILS` but not on the list gets `DEFAULT_SECTIONS` (`dashboard`).

Resolution is cached in memory for 30 s per address, and every write through `/api/users` clears that address, so a change an admin makes applies on the person's next request without them signing out.

**Email is a section now, not an address.** Several process coordinators can compose and send; what stays with `EMAIL_USER` is the Gmail *grant* — every report leaves from that one mailbox whoever wrote it (§6.3), so only that account can authorise it. Everyone with the section can read `gmail-send-status`, which names the mailbox and says whether it is connected.

### 6.2 Google Drive API v3

- `files.get({ fileId, alt: 'media' })` — downloads the live workbook as bytes.
- `files.list({ q: "'<folder>' in parents and trashed = false" })` — enumerates the synopsis folder, with `supportsAllDrives` / `includeItemsFromAllDrives` so shared drives work.
- `files.export(...)` — fallback for a native Google Sheet.

The live workbook is cached in memory for **5 seconds** (`WORKBOOK_CACHE_MS`) so one sync pass does not download it five times. Synopsis files are not cached.

### 6.3 Gmail API — and why not SMTP

**SMTP does not work from Render.** Every Gmail SMTP address on both 465 and 587 times out; outbound SMTP is blocked on this plan. Sending goes over the Gmail API on plain HTTPS instead. `nodemailer` is retained purely for `MailComposer` to build the MIME body. `EMAIL_APP_PASSWORD` is no longer read (it only ever applied to SMTP).

**Scheduled sends are at-most-once** (`jobs/emailScheduler.js`): each email is claimed with an atomic `pending → sending` update before it goes to Gmail, so overlapping ticks or a second server cannot send it twice. A claim older than 15 min becomes `unknown` (never resent automatically). Only Gmail refusals (429/5xx) are retried, up to 3 attempts. Failed and unknown sends stay visible on the Email page for 30 days.

### 6.4 Gemini — `services/aiInsights.service.js`

Model `gemini-flash-latest` via `@google/genai`, called with a **JSON response schema** (headline, narrative, insights[severity ∈ good|info|warning|critical], recommendations). Results are cached in `InsightCache` for 24 h, **keyed by a hash of the summary figures themselves**, so a sync that changes the numbers can never leave a narrative quoting old ones. The reply is validated against the panel's shape before it is cached (`assertInsightsShape`); the call times out at 45 s. The prompt is given only the numeric snapshot and instructed to ground every statement in it; nothing it returns is written to production data. Optional — without `GEMINI_API_KEY` the panel degrades. The panel sits in an `ErrorBoundary`.

---

## 7. The parsers — read this before touching anything under `services/parsers/`

Shared helpers:
- `utils/sheetDate.js` — Excel serials. Valid range is **40000–60000**; `serialToDate` uses the 1899-12-30 epoch and builds **UTC** dates. Every date in this system is UTC-midnight.
- `parsers/gridUtils.js` — `findHeaderRowIndexes(rows, minDateCells = 3)`: a row with ≥3 date serials is a block header.
- `parsers/categoryAliases.js` — manpower label → `{businessUnit, category}`; shift detection.
- `parsers/stageAliases.js` — process-stage label → canonical stage.

### 7.1 Layout is discovered, never assumed

Blocks are located **by the text of their own header rows**, never by fixed row/column numbers. The synopsis workbooks prove why: April puts the department table at top-left, May shifts it to column 7, June adds a `Mode` column and sub-total rows. Any change that reintroduces a hard-coded index will break on the next month's file.

### 7.2 `manpowerParser.js`

Grid: one block per month; each date spans **3 columns — Day / Night / 12.30**. The 12.30 sub-header is stored as an Excel *time* serial (`0.5208333…` = 12:30), not text.

Three hard-won rules, each guarding a bug that shipped:

1. **Column stride.** A date's columns are bounded by the *next* date column. The last date of a block has none, and falling back to the header row's length measures nothing — the date row ends at that cell while the shift labels live in the row below. That silently dropped Night and 12.30 from the last day of **13 months**. The block's own column stride (`detectColumnStride`, the modal gap) is the correct bound.
2. **Sr. No separates data from summary.** Most months carry a second table *below* the daily one holding that month's **averages** — the same labels, but figures like `132.6`. Fractional ones were discarded, but an average landing on a whole number (a flat `11`, a `0`) slipped through and overwrote a real day. Daily rows are numbered in the Sr. No column; summary rows are not. Parsing stops at the first unnumbered row after a numbered one.
3. **Weekday rows are not shift rows.** The header may be followed by a weekday row (`Sat`, `Sun`, …) before the real shift sub-header. Shift detection deliberately starts at the first date column, because the label stack in column 1 contains the literal word `Day`. Beware: `/day/i` also matches `Monday`/`Sunday` — abbreviations are what save this today.

**Weighting — `Day + Night + ½ × 12.30`.** 12.30 is a half shift and counts as half a head. Records store the figure **exactly as the sheet writes it**; the halving is applied at aggregation time in `dashboard.controller.js` via `weightedHeadcount()`. Every manpower total must use it — summing `$count` directly overstates any day that ran a half shift.

### 7.3 `productionParser.js`

Each date occupies **two** columns: a running cumulative and that day's increment. Only the cumulative column carries the date in the header.

- Totals are summed from `dailyIncrementQty`, **never** derived from cumulative differences. RIL's running total genuinely falls twice (June 2025, recorded as negative increments −87 / −95 — keep them). The L&T MHI "reset" on 1 Dec 2025 is **not** a reset — see next point.
- **The client comes from the block's own header cell** (`ADANI` / `MHI` / `RIL` beside `SL.No`), not the tab name. For May–Nov 2025 the `L&T MHI Progress` tab holds blocks headed `RIL`, identical to the RIL tab; reading the client from the tab counted that steel twice (2,427 MT of final coat). A mismatch is warned on every sync. The sync then merges tabs by key, preferring the client's own tab on disagreement.
- Each block also carries columns for the first days of the next month. **A block's own month wins** for a given date; a trailing column is used only if no block covers that date as its own month; disagreeing duplicates are warned (RIL's January block labels its trailing columns 02-02 / 02-03 with figures that differ from February's).
- An increment ≥90% of the cumulative (and ≥50) is rejected as a mid-edit artefact — but only once the stage already has a running total it continues from, so day one of tracking (and the day after a genuine reset) is kept.
- Records carry `sourceRowIndex` / `sourceCol` of their cumulative cell (manpower records do too).

### 7.4 `dispatchParser.js`

Skips "Vehicle Plan / Actual" blocks entirely — those are vehicle counts, not MT, and planned vehicles for a future date are not dispatch that happened (reported as an `info` note, not a warning).

- **Business unit comes from each block's title** in the row above its header ("HSD - … Dispatch Summary" / "Bhilai - … (AMNS & Utility Bridge)"). Bhilai blocks are interleaved in the same tab; before Sep 2026 their 197 MT was summed into HSD. Records are tagged `businessUnit`; HSD queries use `businessUnit: { $ne: 'BU' }` so untagged legacy rows still count as HSD. The Bhilai view shows its own dispatch.
- Aggregate rows: `Total`, `Grand Total`, `Sub-Total`, `G. Total`. Numbers typed as text and negative quantities are warned, not silently dropped.

### 7.5 `synopsisParser.js`

Three independent blocks per workbook, each found by its own header text:

1. **Department table** — header carries both `Department` and `Planned`. The authoritative one.
2. **Category recap** — header carries `Department` but no planned column. **Deliberately not parsed**: it restates the same tonnage, and April/May's grouping ("Disp. Excl. Telecom") disagrees with June's ("Disp. Solar", "Disp. Nepal"). Categories are re-derived from department names instead, giving one consistent grouping across all months.
3. **Tower synopsis** — header carries `Tower Model`. Physical counts, not tonnage.

Also:
- Aggregate rows (`Total`, `Sub-Total :-`, `Grand-Total`) are written in the **Sr. No or Mode column**, not the Department column, so they are detected across the two columns left of Department — and no further, because in May the tower block occupies columns 0–5 of those same rows.
- `coveredDates` = days carrying a real figure. July's columns run to the 30th but its rows stop at the 16th; treating the empty tail as zero-dispatch days would drag every average down.
- **Day columns outside the workbook's month are left out**, with their tonnage in a warning (§9.6). Read as written, January's `22.06.26` filed Jan figures under 22 June and pulled January's plan into June ranges.
- Department folds must never merge two real departments: "Ramboll Domestic" is its own department and category (it used to fold into Ramboll Export, and the unique index then rejected 272.7 MT of Jan–Mar rows). "ZETWERK (Job)" is `Job Work (Zetwerk)`, mode Job Work.
- **The parser never emits two records with one `date+department+mode` key** — they are summed and warned. The sync also refuses to write a month whose daily records do not add up to its total.
- The parse is cross-checked against the sheet's own totals both monthly and daily, and disagreements are reported as warnings rather than corrected.

---

## 8. Cross-cutting behaviours

### 8.1 Sync — `services/sync.service.js`

Runs on `SYNC_CRON` (default `30 21 * * *` in `SYNC_TIMEZONE`, default Asia/Kolkata) and on `POST /sync/run`. **Once a day, not every ten minutes** — see §8.6.

- **Nothing unchanged is downloaded.** Every run asks Drive for `modifiedTime` first (a few hundred bytes) and downloads a workbook only when it differs from the version the stored data was parsed from (`models/SyncState.js`). A version is recorded only after a clean parse, so a failed run is retried in full. A synopsis month whose workbook was skipped still counts as covered, or the cleanup below would delete it.

- **One sync at a time, across processes.** `runSync` takes a lease in the `SyncLock` collection (30-min TTL, so a dead holder frees itself). A second caller gets `SyncInProgressError` (cron skips the tick; manual gets 409). It must stay in the database: a deploy overlap or a laptop on the production DB is a second process, and two overlapping syncs could make one run's manpower cleanup delete everything the other had just written.
- **One workbook snapshot per run** (`openLiveWorkbook`), with 60 s timeouts and one retry on 429/5xx.
- **Every source is isolated** — live workbook download, Manpower, Production, Dispatch, and the synopsis folder each fail alone.
- **Every record is validated** against its schema before writing (bulkWrite does not).
- **`SyncLog`** records `skipped` sources (not downloaded) and `issues[]` with `severity` (`error` | `warning` | `info`) and `sources[]` (file, `modifiedTime`, parsed / inserted / updated / unchanged / deleted, duration). Status comes from errors only: none → `success`; some → `partial`; nothing synced → `failed`. Routine cleanup notes are `info` — before severities, every run was `partial`, so the status meant nothing. A run left `running` by a dead process is closed as abandoned by the next run. Logs expire after 180 days.

**Stale-record cleanup is mandatory, not optional — and gated.** Uniqueness keys include fields that change when the sheet's shape changes:

| Collection | Key | Cleanup |
|---|---|---|
| `ManpowerRecord` | `date + businessUnit + category + shift` | One run `syncedAt`, then delete anything on the parsed dates the run did not touch |
| `ProductionRecord` | `date + client + processStage` | Delete anything in the parsed date span the run did not touch — only when every progress tab was read |
| `DispatchRecord` | `sourceTab + sourceRowIndex + date` | Delete anything in the tab the run did not touch — row positions shift as the sheet is edited |
| `SynopsisMonth` / `SynopsisDispatchRecord` | `month` / `date+department+mode` | Whole month rewritten **in a transaction** (falls back to sequential writes on a standalone mongod). A month whose workbook left the folder is removed — only after a run where every workbook downloaded. Two workbooks for one month: the newest `modifiedTime` wins, clash warned. |

Without cleanup, a layout change writes new rows *beside* the old ones under a different key and every total silently doubles. **Without the gate, a sync that lands while someone is mid-edit deletes the last valid data**: cleanup is refused (and logged as an error) when the parse is under 70% of what it would replace; a synopsis month is not replaced by one reporting under half its stored tonnage.

**Never return silently from a sync step.** A step that skips without recording anything reports plain `success` while the page sits empty and nothing anywhere explains why.

### 8.2 Caching — surprising but deliberate

`Dashboard.jsx` and `SynopsisView.jsx` use `staleTime: Infinity`, `refetchOnWindowFocus: false`, `refetchOnMount: false`. **Figures stay exactly as first loaded for the page session, for every role.** A background sync or a manual "Sync now" updates the database but not the screen; a page reload or sign-in loads a new snapshot (`AuthContext` clears the cache on logout). This is intentional — numbers must not shift under someone reading them.

Summary and synopsis payloads carry `dataAsOf` (the newest `success`/`partial` sync), shown as "Figures as of the … sync", so the page says how old its figures are.

**The client asks the server for data at exactly two moments: when the page loads, and when an admin runs "Sync now"** (which invalidates the summary, synopsis, insights and status queries together). There is no polling and no websocket — an open dashboard makes no requests at all. *"The dashboard is showing an old number"* is answered by reloading the page.

"Today" and default ranges use the **IST** calendar day (`istToday()` in `dashboard.controller.js`); dates are validated as `YYYY-MM-DD` and answered with 400, never silently queried as 1970.

### 8.3 Rounding

`utils/roundNumbers.js` — `roundDeep` walks any structure to 3 decimals, skipping `Date`. Applied to whole payloads at the controller boundary.

### 8.4 Security

`helmet`, `cors` locked to `CLIENT_ORIGIN` (trailing slash stripped) with credentials, `express-mongo-sanitize`, rate limits (300/15min general — **keyed per signed-in user**, per IP otherwise, because the whole plant shares one office IP; 30/15min on `/auth/google`; 10/15min on email send). `express.json` is capped at the default everywhere; the email routes parse their own 20 MB body **after** `requireAuth` + `requireEmail`.

- **Cross-site requests:** the cookie must be `SameSite=None`, so any page can make the browser send it. Every non-GET under `/api` with an `Origin` other than `CLIENT_ORIGIN` is refused (`app.js`).
- **Socket.IO** verifies the session cookie in the handshake.
- **Secrets:** `config/env.js` refuses to start a deployed server (NODE_ENV=production, `RENDER` or `RENDER_EXTERNAL_URL`) on the development `JWT_SECRET` / `TOKEN_ENCRYPTION_KEY` fallbacks.
- **Errors:** client errors (bad JSON, oversized body, CastError, `BadRequestError`) are 4xx; internal error text is not returned to the browser. `process.on('unhandledRejection')` logs instead of exiting.
- **Client:** a 401 anywhere except `/auth/me` sends the user to `/login?error=session_expired`. `client/vercel.json` sets `frame-ancestors 'none'`, `X-Frame-Options`, `nosniff`, `Referrer-Policy`.

**The session cookie shape is derived from `req.secure`, not `NODE_ENV`** — `app.set('trust proxy', 1)` makes that reliable, and Render does not guarantee `NODE_ENV=production`. Guessing wrong means the cookie is silently never returned on cross-origin calls and every login bounces back to `/login` with no visible error.

### 8.6 Bandwidth — why the traffic shape is what it is

Render's Hobby workspace includes **5 GB of bandwidth a month**, and exceeding it suspends every service in the workspace ("This service has been suspended by its owner"). The app was hitting that every five or six days. Measured (Sep 2026), the two causes:

| | Before | After |
|---|---|---|
| `/sync/status` — whole `SyncLog`, 60 s poll, uncompressed | 13.5 KB × 20 tabs × 1440/day ≈ **11 GB/month** | 339 bytes on page load ≈ **0.6 MB/month** |
| Drive downloads — every workbook, every 10 min | ~1 MB × 144/day ≈ **4 GB/month** | changed files only, once a day ≈ **14 MB/month** |

What keeps it there, and must not be undone casually:

1. **`/sync/status` returns counts, not the log.** `errorCount`/`warningCount`/`issueCount` and `synopsisMonths`; the issue text and per-source rows come only from `?detail=1`, which the badge fetches when opened and the Settings page asks for directly.
2. **gzip on everything** (`compression` in `app.js`) — the 13.5 KB detailed log goes out as 0.8 KB.
3. **ETag + `Cache-Control: private, no-cache`** on dashboard and status payloads (`services/payloadCache.js` → `sendCached`). An unchanged answer costs a **304 with no body**. This is why the payloads carry no `generatedAt`: a timestamp that changed on every request made every response unique and every cache useless.
4. **In-memory payload cache**, keyed by route + query, cleared when a sync writes rows. Twenty dashboards on one range cost one aggregation between syncs. It is an optimisation, never data — a restart just rebuilds it.
5. **No polling, no socket** (§8.2).
6. **Conditional downloads** (§8.1) — `modifiedTime` first, bytes only if it changed.

Email sending is now the largest remaining egress: inline images in a report go out as base64 on each send.

### 8.5 Keep-alive

Render's free tier sleeps after ~15 min idle, then pays a 30–60 s cold start — which made email feel slow and could starve the scheduler entirely. `jobs/keepAlive.js` self-pings `/api/health` every 10 minutes using `RENDER_EXTERNAL_URL` (set by Render automatically); it no-ops elsewhere.

---

## 9. Known data-quality issues in the live sources

These are **spreadsheet** problems. The code reports them; it does not invent corrections.

### 9.1 Manpower — two mistyped date headers (open)

February's table carries an **11-Mar-2026** header where 11-Feb belongs, and March's carries **10-Feb-2026** where 10-Mar belongs (header rows 140 and 156). Each of those days receives two months' figures under one key — one overwrites the other — and **11 Feb and 10 Mar have no data at all.** Only the sheet can say which is right. The parser warns on every sync; `check:manpower` fails until it is fixed in Drive.

### 9.2 Manpower — April/May 2025 blocks skipped (accepted)

Those two blocks write dates as text (`"15th April"`, `"01th May"`) instead of serials, so `findHeaderRowIndexes` cannot see them. May 2025 also contains entries like `"78+23"` and `"76+"`. **Deliberately left alone** — the owner decided 2025 is not worth recovering.

### 9.3 Dispatch Synopsis — June grand-total error (handled)

On 12 Jun 2026 June's Buyout total row carries 147.039 MT while both its buyout department rows are zero, inflating that day's Grand-Total to 294.078. The departments are the source of truth — the sheet's own category recap agrees with them — so figures are left as parsed and the discrepancy is surfaced as a warning.

### 9.4 Dispatch Synopsis — tower counts are per-month, not cumulative (handled)

The block is headed *"Dispatched Till <date>"*, which reads as cumulative. It is not: its own totals run 1,507 → 4,613 → 2,915 → 5 → 3, and a running total cannot fall. Counts also go blank in exactly the months a model's tonnage is zero. Treated as per-month and summed across the scope.

### 9.5 Production — L&T MHI tab holds RIL's May–Nov 2025 blocks (handled; confirm)

Seven blocks in `L&T MHI Progress` are headed `RIL` and are identical to the RIL tab. They are now recorded under RIL (once). Confirm with the sheet owner that they are RIL-only, then move them out of the L&T tab; the sync warns until then.

### 9.6 Dispatch Synopsis — January header `22.06.26` (open)

Column 32 of `Dispach Jan 2026.xlsx` reads `22.06.26` where 22.01.26 belongs. Its 120.211 MT is left out of every total, with a warning, until the cell is corrected; `check:synopsis` fails on January's departments until then.

### 9.7 Production — overlapping month columns (handled; confirm)

Each block runs on into the next month. RIL's January block labels its trailing columns 02-02 / 02-03 (skipping 1 Feb) with figures that differ from February's, and the sheet's own January total counts them. The February block is used for February dates and the conflict is warned.

### 9.8 Production — stale "From 1st to till now" cells (reported)

For Nov 2025 (both L&T MHI and RIL) and several RIL months, the sheet's own month-total cell disagrees with its own daily increments, while its per-day-average cell agrees with them. The increments are used; `check:production` reports the stale cells.

---

## 10. Environment

`server/.env` (see `.env.example`). `config/env.js` throws on boot for anything missing without a fallback.

| Variable | Notes |
|---|---|
| `MONGODB_URI` | **Required.** |
| `GOOGLE_CLIENT_ID` / `GOOGLE_CLIENT_SECRET` | **Required.** One OAuth app, three redirect URIs. |
| `GOOGLE_LOGIN_REDIRECT_URI` · `GOOGLE_DRIVE_REDIRECT_URI` · `GMAIL_SEND_REDIRECT_URI` | Default to localhost. |
| `JWT_SECRET` · `TOKEN_ENCRYPTION_KEY` | Dev fallbacks exist for local use only — a deployed server refuses to start on them. |
| `ADMIN_EMAILS` | Comma-separated. Always admins, checked before any database query, and not editable from the UI — the lock-out guard (§6.5). |
| `ALLOWED_LOGIN_EMAILS` | Comma-separated addresses granted straight from the environment (e.g. staff on personal Gmail). Everyone else must be added in Settings. |
| `CLIENT_ORIGIN` | CORS origin, CSRF origin check **and** post-login redirect target. Trailing slash is stripped. |
| `HSD_SPREADSHEET_ID` | Live workbook. |
| `SYNOPSIS_FOLDER_ID` | Monthly synopsis folder. Defaults to the production folder. |
| `SYNC_CRON` · `SYNC_TIMEZONE` | When the daily sync runs. Default `30 21 * * *`, Asia/Kolkata. |
| `GEMINI_API_KEY` | Optional — insights degrade without it. |
| `EMAIL_USER` | The mailbox reports are sent from, and the only account that can grant the Gmail scope. Who may *use* the Email page is now a section (§6.5). |
| `EMAIL_APP_PASSWORD` | No longer read; safe to delete from Render. |
| `RENDER_EXTERNAL_URL` | Set by Render; drives keep-alive. |

Client: `VITE_API_URL` — empty in dev (Vite proxies), the deployed server URL in production.

### 10.1 Deployment

- **Client → Vercel.** Root directory `client`. `client/vercel.json` adds the SPA rewrite; without it every deep link 404s.
- **Server → Render.** Root directory `server`, `npm start`. Repo root has **no `package.json`** — a builder pointed at the root will fail with `EUSAGE ... can only install with an existing package-lock.json`.
- Both deploy from `main`.

---

## 11. How this was built — development stages

Reconstructed from the commit history; useful for understanding why things are shaped as they are.

**Stage 1 — Foundation (17 Aug 2026).** `v1.0`, `APIs integrated`, `bilai add`. Express + Mongo + Google OAuth, the sheet-sync skeleton, both business units.

**Stage 2 — Analytics (18–24 Aug).** `charts fixed`, `manpower avg`, `AI insights`, `production calculation`, `added expand feature to charts`. Recharts dashboard, Gemini insights, targets. Repeated commits touching production maths — this is where cumulative-vs-increment was settled.

**Stage 3 — Email automation (24 Aug – 1 Sep).** `email form created` through `COW email added`. Composer with inline images, per-client templates (CNC, Zetwerk, Machine, Quality, Ramboll, Production, COW), scheduling.

**Stage 4 — Production hardening (2–3 Sep).** `app deployed`, then a rapid run of deployment-reality fixes: `Fix Google login link to use deployed API URL`, `Add Vercel SPA rewrite`, `Fix session cookie never being sent back after cross-origin login`, `email make faster`. Everything in §8.4 and §8.5 comes from this stage — the cookie, CORS, and cold-start behaviours were all discovered in production, not locally.

**Stage 5 — Data-accuracy work (3–7 Sep).** `fixing stages of hsd`, `cutting fixing`, `sep fix`. Stale-record cleanup introduced for dispatch after row-position shifts caused double counting.

**Stage 6 — Dispatch Synopsis (7–9 Sep).** `Synopsis dispach added` → `custom range` → `renamed to dispatch synopsis`. New parser, two models, folder-based sync, a full chart suite, then per-month and custom-range filtering with pro-rated plan.

**Stage 7 — Manpower correctness (9 Sep).** `manpower fixed`, `fixing manpower on site`. The three rules in §7.2, the half-shift weighting, and `check:manpower`.

**The pattern worth noticing:** every stage after deployment has been about the *source data* and the *deployment environment*, not application features. Expect the next problem to be one of those two as well.

---

## 12. Conventions

- **ESM everywhere**, both packages. Relative imports carry the `.js` extension server-side.
- **Comments explain *why*, at length, where a line encodes a hard-won fact.** The codebase is deliberately heavy on this — several comments record production incidents (SMTP blocked, cookie `SameSite`, cumulative resets, the month-end column bug). Preserve them; they are the reason those bugs have not returned.
- **Charts:** each chart file defines its own local `ChartCard`. Colours come from CSS variables; never hard-code hex. Legends for ≥2 series, selective direct labels, and **never a dual-axis chart** — two measures of different units go in two charts.
- **Controllers** expose a pure builder alongside the request handler (`buildHsdSummaryData`, `buildSynopsisPayload`) so payload shaping can be exercised without a database.
- **Money/tonnage rounding** happens once, at the controller boundary, via `roundDeep`.
