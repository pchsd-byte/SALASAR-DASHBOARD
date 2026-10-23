import crypto from 'node:crypto';
import mongoose from 'mongoose';
import * as drive from './googleSheets.service.js';
import { parseManpowerSheet } from './parsers/manpowerParser.js';
import { parseProgressSheet } from './parsers/productionParser.js';
import { parseDispatchSheet } from './parsers/dispatchParser.js';
import { parseSynopsisSheet } from './parsers/synopsisParser.js';
import { ManpowerRecord } from '../models/ManpowerRecord.js';
import { ProductionRecord } from '../models/ProductionRecord.js';
import { DispatchRecord } from '../models/DispatchRecord.js';
import { SynopsisMonth } from '../models/SynopsisMonth.js';
import { SynopsisDispatchRecord } from '../models/SynopsisDispatchRecord.js';
import { SyncLog } from '../models/SyncLog.js';
import { SyncLock } from '../models/SyncLock.js';
import { SyncState } from '../models/SyncState.js';
import { invalidateCache } from './payloadCache.js';
import { env } from '../config/env.js';

const LIVE_WORKBOOK_KEY = 'live-workbook';
const synopsisKey = (fileId) => `synopsis:${fileId}`;

// What this build reads out of the live workbook. Stored alongside the file's modifiedTime, and
// compared on every run.
//
// This exists because of a real incident: Bhilai's three progress tabs were added to the code,
// deployed, and then nothing appeared — the workbook itself had not been edited, so the
// "unchanged in Drive, don't download" check skipped it, and the new tabs were never read. The
// file had not changed; the code had. A run now re-reads the sheet when either is different.
const sourceSignature = () =>
  crypto.createHash('sha1')
    .update(JSON.stringify([PROGRESS_TABS.map((t) => [t.title, t.client, t.businessUnit]), DISPATCH_TABS, MANPOWER_TAB]))
    .digest('hex')
    .slice(0, 12);

// Every progress tab in the live workbook, and which plant it belongs to.
//
// Bhilai's three tabs are read exactly like HSD's, with one difference: `trustTabClient`. Each
// of them carries blocks headed with an HSD client's name ("RIL", "AMNS", "MHI") because the
// sheet was copied from HSD's and the headings were never corrected. Reading the client from
// those headings — the right rule for HSD (§7.3) — would file Bhilai's tonnage under L&T MHI
// and RIL. For these tabs the tab names the client, and the heading is reported as a warning.
const PROGRESS_TABS = [
  { title: 'Adani Progress', client: 'Adani', businessUnit: 'HSD' },
  { title: 'L&T MHI Progress', client: 'L&T MHI', businessUnit: 'HSD' },
  { title: 'RIL Progress', client: 'RIL', businessUnit: 'HSD' },
  { title: 'Bhilai MHI Duct Progress', client: 'MHI Duct', businessUnit: 'BU', trustTabClient: true },
  { title: 'Utility Bridge - Bhilai', client: 'Utility Bridge', businessUnit: 'BU', trustTabClient: true },
  { title: 'AMNS - Bhilai', client: 'AMNS', businessUnit: 'BU', trustTabClient: true },
];

const DISPATCH_TABS = ['Daily Dispatch'];
const MANPOWER_TAB = 'Manpower';

// A cleanup step only runs when the new parse is at least this large a share of what it would
// replace. The live workbook is edited all day, and a sync that lands while someone has a
// header row half-deleted parses a fraction of the sheet; before this gate, the cleanup that
// followed deleted everything that fraction did not contain. Row moves and new days do not
// shrink a parse, so they are unaffected.
const MIN_KEPT_SHARE = 0.7;
// A synopsis month is only replaced by a workbook reporting at least half the tonnage already
// stored for it. Corrections are routine; a month losing half its dispatch is not.
const MIN_SYNOPSIS_SHARE = 0.5;

export class SyncInProgressError extends Error {
  constructor() {
    super('A sync is already running. Try again when it finishes.');
    this.name = 'SyncInProgressError';
  }
}

// ---------------------------------------------------------------------------------------------
// Lock
// ---------------------------------------------------------------------------------------------

const LOCK_ID = 'hsd-sync';
// Longer than any healthy sync (every Drive call now times out at 60 s), so a lease held by a
// process that died mid-run frees itself without anyone intervening.
const LOCK_TTL_MS = 30 * 60 * 1000;

async function acquireLock(holder) {
  const now = new Date();
  try {
    const lock = await SyncLock.findOneAndUpdate(
      { _id: LOCK_ID, lockedUntil: { $lt: now } },
      { $set: { holder, lockedUntil: new Date(now.getTime() + LOCK_TTL_MS) } },
      { upsert: true, returnDocument: 'after' },
    );
    return lock?.holder === holder;
  } catch (err) {
    // The lease exists and has not expired: the upsert tried to insert a second document with
    // the same _id.
    if (err?.code === 11000) return false;
    throw err;
  }
}

async function releaseLock(holder) {
  await SyncLock.updateOne({ _id: LOCK_ID, holder }, { $set: { lockedUntil: new Date(0) } });
}

// ---------------------------------------------------------------------------------------------
// Log helpers
// ---------------------------------------------------------------------------------------------

function note(log, tab, message, severity) {
  log.issues.push({ tab, message, severity });
}

function writeStats(result) {
  const inserted = result?.upsertedCount || 0;
  const updated = result?.modifiedCount || 0;
  const unchanged = Math.max((result?.matchedCount || 0) - updated, 0);
  return { inserted, updated, unchanged };
}

// Mongoose's bulkWrite casts updateOne operations but never validates them, so the schemas'
// enum and min constraints were not being applied to Manpower, Production or Dispatch at all.
// Each record is validated here instead. A record that fails is not stored, and the run says
// so as an error rather than letting a negative count or an unknown stage into the totals.
function validateRecords(Model, records, log, tab) {
  const valid = [];
  const problems = [];
  for (const record of records) {
    const error = new Model(record).validateSync();
    if (error) problems.push(error.message);
    else valid.push(record);
  }
  if (problems.length > 0) {
    note(log, tab, `${problems.length} record(s) failed validation and were not stored — first: ${problems[0]}`, 'error');
  }
  return valid;
}

// ---------------------------------------------------------------------------------------------
// Live workbook sources
// ---------------------------------------------------------------------------------------------

async function syncManpowerTab(workbook, log) {
  const started = Date.now();
  const tab = MANPOWER_TAB;
  const { records, warnings } = parseManpowerSheet(workbook.getSheetValues(tab));
  warnings.forEach((w) => note(log, tab, w, 'warning'));
  const valid = validateRecords(ManpowerRecord, records, log, tab);

  // Never return silently: an empty parse keeps the existing data, and says so.
  if (valid.length === 0) {
    note(log, tab, 'No manpower figures could be read from the sheet this run — the figures already stored were kept.', 'error');
    log.sources.push({ name: tab, fileId: workbook.fileId, modifiedTime: workbook.modifiedTime, durationMs: Date.now() - started, ok: false });
    return;
  }

  const parsedDates = [...new Set(valid.map((rec) => rec.date.getTime()))].map((t) => new Date(t));
  const storedBefore = await ManpowerRecord.countDocuments({ date: { $in: parsedDates } });

  // One timestamp for the whole run, so "not touched by this parse" is a simple comparison
  // below rather than a per-record bookkeeping exercise. (Safe because the sync lock guarantees
  // no other run is writing at the same time.)
  const syncedAt = new Date();
  const ops = valid.map((rec) => ({
    updateOne: {
      filter: { date: rec.date, businessUnit: rec.businessUnit, category: rec.category, shift: rec.shift },
      update: { $set: { ...rec, syncedAt } },
      upsert: true,
    },
  }));
  const stats = writeStats(await ManpowerRecord.bulkWrite(ops, { ordered: false }));
  log.rowsUpserted += stats.inserted + stats.updated;

  // The uniqueness key includes `shift`, so a day re-read under a different shift layout does
  // not overwrite what was stored before — it lands beside it. The last day of every month
  // used to be recorded once with no shift at all; it is now correctly split into day/night/
  // 12.30, and without this the old shift-less record would survive and be summed on top of
  // the new ones, counting that day roughly twice. The same applies whenever a category is
  // renamed or dropped from the sheet.
  //
  // Only the days this parse actually covered are touched, so history the sheet no longer
  // reaches back to is left alone.
  let deleted = 0;
  if (valid.length < storedBefore * MIN_KEPT_SHARE) {
    note(
      log,
      tab,
      `This run read ${valid.length} manpower figures for days that already held ${storedBefore}. That is too large a drop to trust, so nothing was removed — if the sheet was mid-edit, the next sync will tidy up.`,
      'error',
    );
  } else {
    const stale = await ManpowerRecord.deleteMany({ date: { $in: parsedDates }, syncedAt: { $lt: syncedAt } });
    deleted = stale.deletedCount;
    if (deleted > 0) {
      note(log, tab, `Removed ${deleted} stale record(s) that the current sheet no longer accounts for — most likely a day whose shift columns changed shape since a previous sync.`, 'info');
    }
  }

  log.sources.push({ name: tab, fileId: workbook.fileId, modifiedTime: workbook.modifiedTime, parsed: valid.length, ...stats, deleted, durationMs: Date.now() - started });
  log.tabsProcessed.push(tab);
}

async function syncProductionTabs(workbook, log) {
  const started = Date.now();
  const byKey = new Map();
  // Tracked per plant. With six tabs across two units, one renamed Bhilai tab used to be enough
  // to switch off stale-record cleanup for HSD as well — silently, and for good.
  const unitFullyRead = { HSD: true, BU: true };

  for (const tab of PROGRESS_TABS) {
    try {
      // A tab that is not in the workbook at all has been renamed or removed. That is a sheet
      // problem worth saying out loud, and it must stop this unit's cleanup: everything the
      // missing tab used to write would otherwise look like a record the sheet no longer
      // contains, and be deleted. A tab that exists but is empty is simply not filled in yet.
      if (workbook.hasSheet && !workbook.hasSheet(tab.title)) {
        unitFullyRead[tab.businessUnit] = false;
        note(log, tab.title, `This progress tab is not in the workbook — it has been renamed or removed. ${tab.businessUnit === 'BU' ? 'Bhilai' : 'HSD'} production figures already stored were kept.`, 'error');
        continue;
      }
      const { records, warnings } = parseProgressSheet(workbook.getSheetValues(tab.title), tab.client, tab.title, {
        trustTabClient: Boolean(tab.trustTabClient),
      });
      records.forEach((record) => { record.businessUnit = tab.businessUnit; });
      warnings.forEach((w) => note(log, tab.title, w, 'warning'));
      if (records.length === 0) unitFullyRead[tab.businessUnit] = false;

      // A block can now be recorded under a client other than its tab's (L&T MHI's tab holds
      // blocks headed "RIL" for May–Nov 2025), so two tabs can produce the same
      // date + client + stage key. Where they agree — the case today, since those blocks are
      // copies of the RIL tab — one record is stored. Where they disagree, the figure from the
      // client's own tab is kept and the disagreement reported.
      for (const record of records) {
        // businessUnit is part of the key for the same reason it is part of the unique index:
        // a Bhilai block and an HSD block can name the same client on the same day.
        const key = `${record.date.toISOString()}|${record.businessUnit}|${record.client}|${record.processStage}`;
        const existing = byKey.get(key);
        if (!existing) {
          byKey.set(key, record);
          continue;
        }
        const differs = existing.cumulativeQty !== record.cumulativeQty || existing.dailyIncrementQty !== record.dailyIncrementQty;
        const home = PROGRESS_TABS.find((t) => t.title === record.sourceTab);
        const recordIsHome = home?.client === record.client && home?.businessUnit === record.businessUnit;
        const kept = recordIsHome ? record : existing;
        if (differs) {
          const other = kept === record ? existing : record;
          note(
            log,
            'Production',
            `${record.date.toISOString().slice(0, 10)} ${record.businessUnit} ${record.client} ${record.processStage}: "${kept.sourceTab}" says ${kept.cumulativeQty}/${kept.dailyIncrementQty} but "${other.sourceTab}" says ${other.cumulativeQty}/${other.dailyIncrementQty} — using "${kept.sourceTab}".`,
            'warning',
          );
        }
        byKey.set(key, kept);
      }
      log.tabsProcessed.push(tab.title);
    } catch (err) {
      unitFullyRead[tab.businessUnit] = false;
      note(log, tab.title, err.message, 'error');
    }
  }

  const valid = validateRecords(ProductionRecord, [...byKey.values()], log, 'Production');
  if (valid.length === 0) {
    note(log, 'Production', 'No production figures could be read this run — the figures already stored were kept.', 'error');
    log.sources.push({ name: 'Production', fileId: workbook.fileId, modifiedTime: workbook.modifiedTime, durationMs: Date.now() - started, ok: false });
    return;
  }

  const syncedAt = new Date();
  const ops = valid.map((rec) => ({
    updateOne: {
      // HSD matches rows that predate businessUnit as well as tagged ones: in MongoDB a filter
      // of null matches a missing field, and $in keeps both in play. Without this the first run
      // after the field was added inserted a second copy of every untagged row instead of
      // updating it — 4,791 duplicates, and every HSD total doubled — because the filter no
      // longer matched what was stored. Each row heals itself on the run that touches it.
      filter: {
        date: rec.date,
        businessUnit: rec.businessUnit === 'BU' ? 'BU' : { $in: ['HSD', null] },
        client: rec.client,
        processStage: rec.processStage,
      },
      update: { $set: { ...rec, syncedAt } },
      upsert: true,
    },
  }));
  const stats = writeStats(await ProductionRecord.bulkWrite(ops, { ordered: false }));
  log.rowsUpserted += stats.inserted + stats.updated;

  // Production had no cleanup at all. Its key is layout-independent, but a date header typed
  // wrong and then corrected, a stage renamed, or a block re-attributed to its real client
  // (the RIL-headed blocks above) all leave the old document behind — summed into every total
  // forever. Anything in the span this parse covers that the parse did not write is removed,
  // but only when that plant's tabs were all read and the parse is not suspiciously smaller
  // than what it replaces.
  //
  // Each plant is judged on its own: HSD's three tabs and Bhilai's three are separate sources
  // that happen to live in one workbook, and a problem in one is no reason to stop tidying the
  // other — or, worse, to delete its rows because this run never read them.
  let deleted = 0;
  for (const unit of ['HSD', 'BU']) {
    const unitRecords = valid.filter((r) => r.businessUnit === unit);
    if (unitRecords.length === 0) continue;

    const times = unitRecords.map((r) => r.date.getTime());
    const span = { $gte: new Date(Math.min(...times)), $lte: new Date(Math.max(...times)) };
    const unitQuery = unit === 'BU' ? { businessUnit: 'BU' } : { businessUnit: { $ne: 'BU' } };
    const storedBefore = await ProductionRecord.countDocuments({ date: span, ...unitQuery });
    const label = unit === 'BU' ? 'Bhilai' : 'HSD';

    if (!unitFullyRead[unit]) {
      note(log, 'Production', `Not every ${label} progress tab could be read this run, so no old ${label} production records were removed.`, 'warning');
      continue;
    }
    if (unitRecords.length < storedBefore * MIN_KEPT_SHARE) {
      note(
        log,
        'Production',
        `This run read ${unitRecords.length} ${label} production records for a span that already held ${storedBefore}. That is too large a drop to trust, so nothing was removed.`,
        'error',
      );
      continue;
    }

    const stale = await ProductionRecord.deleteMany({ date: span, ...unitQuery, syncedAt: { $lt: syncedAt } });
    deleted += stale.deletedCount;
    if (stale.deletedCount > 0) {
      note(log, 'Production', `Removed ${stale.deletedCount} ${label} production record(s) the current sheet no longer contains (a corrected date, a renamed stage, or a block now recorded under its own client).`, 'info');
    }
  }

  log.sources.push({ name: 'Production', fileId: workbook.fileId, modifiedTime: workbook.modifiedTime, parsed: valid.length, ...stats, deleted, durationMs: Date.now() - started });
}

async function syncDispatchTab(workbook, tabTitle, log) {
  const started = Date.now();
  const { records, warnings, notes } = parseDispatchSheet(workbook.getSheetValues(tabTitle), tabTitle);
  warnings.forEach((w) => note(log, tabTitle, w, 'warning'));
  notes.forEach((n) => note(log, tabTitle, n, 'info'));
  const valid = validateRecords(DispatchRecord, records, log, tabTitle);

  if (valid.length === 0) {
    note(log, tabTitle, 'No dispatch figures could be read this run — the figures already stored were kept.', 'error');
    log.sources.push({ name: tabTitle, fileId: workbook.fileId, modifiedTime: workbook.modifiedTime, durationMs: Date.now() - started, ok: false });
    return;
  }

  const storedBefore = await DispatchRecord.countDocuments({ sourceTab: tabTitle });
  const syncedAt = new Date();
  const ops = valid.map((rec) => ({
    updateOne: {
      filter: { sourceTab: rec.sourceTab, sourceRowIndex: rec.sourceRowIndex, date: rec.date },
      update: { $set: { ...rec, syncedAt } },
      upsert: true,
    },
  }));
  const stats = writeStats(await DispatchRecord.bulkWrite(ops, { ordered: false }));
  log.rowsUpserted += stats.inserted + stats.updated;

  // Unlike Manpower/Production (keyed by date+category, which self-heals every sync no
  // matter where in the sheet that data now sits), this collection's uniqueness key
  // includes sourceRowIndex — and the sheet's row layout shifts as it's live-edited (a
  // project's row moves down when rows are inserted above it). A sync only ever upserts
  // the rows it currently sees, so it can't tell "this row moved" from "this is new" —
  // the record at the row's old position is left behind, silently double-counted in every
  // total forever. Deleting anything for this tab that the current parse didn't just
  // touch keeps the DB an exact mirror of the sheet, closing that gap for good.
  //
  // A moved row keeps the parse the same size, so the gate below does not get in its way; a
  // parse that has lost a third of the tab has not moved rows, it has failed to read them.
  let deleted = 0;
  if (valid.length < storedBefore * MIN_KEPT_SHARE) {
    note(
      log,
      tabTitle,
      `This run read ${valid.length} dispatch records where ${storedBefore} were stored. That is too large a drop to trust, so nothing was removed — if the sheet was mid-edit, the next sync will tidy up.`,
      'error',
    );
  } else {
    const deleteResult = await DispatchRecord.deleteMany({ sourceTab: tabTitle, syncedAt: { $lt: syncedAt } });
    deleted = deleteResult.deletedCount;
    if (deleted > 0) {
      note(log, tabTitle, `Removed ${deleted} stale record(s) left behind by a row position that shifted since a previous sync.`, 'info');
    }
  }

  log.sources.push({ name: tabTitle, fileId: workbook.fileId, modifiedTime: workbook.modifiedTime, parsed: valid.length, ...stats, deleted, durationMs: Date.now() - started });
  log.tabsProcessed.push(tabTitle);
}

// ---------------------------------------------------------------------------------------------
// Monthly synopsis folder
// ---------------------------------------------------------------------------------------------

function isTransactionUnsupported(err) {
  return err?.code === 20 || /replica set|Transaction numbers/i.test(err?.message || '');
}

// Runs the writes in a transaction where the server supports one (Atlas always does). A local
// standalone mongod does not, so there the same writes run in order without one — the parse
// has already been checked, so the only thing lost is protection against a crash mid-write.
async function runAtomically(work) {
  const session = await mongoose.startSession();
  try {
    await session.withTransaction(() => work(session));
  } catch (err) {
    if (!isTransactionUnsupported(err)) throw err;
    await work(undefined);
  } finally {
    await session.endSession();
  }
}

// Each monthly workbook is replaced wholesale rather than upserted row by row. A month's
// figures are only ever restated as a whole (a correction to the 3rd is typed into the same
// file days later), and rewriting the month is the only thing that also removes a day that
// was deleted from the sheet — an upsert-only pass would leave it behind for good.
//
// The three writes used to be independent: a failure after the delete (a duplicate-key
// rejection, a dropped connection, a crash) left the month with a total and no daily records.
// They now commit together or not at all.
async function writeSynopsisMonth(file, parsed, log) {
  const tab = `Synopsis/${file.name}`;
  const dispatchedTotal = parsed.departments.reduce((sum, d) => sum + d.dispatched, 0);
  const dailyTotal = parsed.daily.reduce((sum, d) => sum + d.qty, 0);
  if (Math.abs(dailyTotal - dispatchedTotal) > 0.01) {
    note(log, tab, `Parsed daily records (${dailyTotal.toFixed(3)} MT) do not add up to the month's total (${dispatchedTotal.toFixed(3)} MT) — the month was not updated.`, 'error');
    return false;
  }

  const existing = await SynopsisMonth.findOne({ month: parsed.month }).select('dispatchedTotal').lean();
  if (existing?.dispatchedTotal > 0 && dispatchedTotal < existing.dispatchedTotal * MIN_SYNOPSIS_SHARE) {
    note(
      log,
      tab,
      `${parsed.month} would drop from ${existing.dispatchedTotal.toFixed(3)} MT to ${dispatchedTotal.toFixed(3)} MT. That is too large a drop to trust, so the stored month was kept — if the workbook really was corrected this far, it will need a manual check.`,
      'error',
    );
    return false;
  }

  const syncedAt = new Date();
  await runAtomically(async (session) => {
    await SynopsisMonth.findOneAndUpdate(
      { month: parsed.month },
      {
        $set: {
          month: parsed.month,
          plannedTotal: parsed.plannedTotal,
          dispatchedTotal,
          coveredDates: parsed.coveredDates,
          departments: parsed.departments.map((d) => ({
            department: d.department,
            sourceLabel: d.sourceLabel,
            category: d.category,
            mode: d.mode,
            planned: d.planned,
            dispatched: d.dispatched,
            recordedDays: d.recordedDays,
          })),
          towers: parsed.towers.map((t) => ({
            model: t.model,
            heightM: t.heightM,
            towerNos: t.towerNos,
            cipNos: t.cipNos,
            weightMt: t.weightMt,
            remarks: t.remarks,
          })),
          sourceFile: file.name,
          sourceFileId: file.id,
          warnings: parsed.warnings,
          syncedAt,
        },
      },
      { upsert: true, session },
    );
    await SynopsisDispatchRecord.deleteMany({ month: parsed.month }, { session });
    if (parsed.daily.length > 0) {
      await SynopsisDispatchRecord.insertMany(
        parsed.daily.map((d) => ({
          date: d.date,
          month: d.month,
          department: d.department,
          sourceLabel: d.sourceLabel,
          category: d.category,
          mode: d.mode,
          qty: d.qty,
          sourceFile: d.sourceFile,
          syncedAt,
        })),
        { ordered: true, session },
      );
    }
  });

  log.rowsUpserted += parsed.daily.length;
  log.tabsProcessed.push(`Synopsis/${parsed.month}`);
  return true;
}

async function syncSynopsisFolder(log, sources, { force = false } = {}) {
  const started = Date.now();
  // Never return silently. A sync that skips this step without saying so reports plain
  // "success" while the Dispatch Synopsis view stays empty, and there is then nothing
  // anywhere — badge, log or database — explaining why.
  if (!env.synopsisFolderId) {
    note(log, 'Synopsis', 'SYNOPSIS_FOLDER_ID is empty, so the monthly synopsis workbooks were skipped.', 'error');
    return;
  }

  let files;
  try {
    files = await sources.listFolderWorkbooks(env.synopsisFolderId);
  } catch (err) {
    note(log, 'Synopsis', `Could not list the synopsis folder ${env.synopsisFolderId}: ${err.message}. Check the account connected for Drive sync can open that folder.`, 'error');
    return;
  }

  if (files.length === 0) {
    note(log, 'Synopsis', `The synopsis Drive folder ${env.synopsisFolderId} returned no files — it is empty, or not shared with the account connected for Drive sync.`, 'error');
    return;
  }

  // Every workbook is read before anything is written, so the month each one reports on is
  // known up front. One bad workbook must not cost the others their sync, so each is caught on
  // its own.
  // A month whose workbook has not changed in Drive since it was last read is left alone: its
  // figures are already stored, and re-downloading a dozen ~100 KB workbooks every run is what
  // the daily schedule and this check exist to stop. The stored month must still be present —
  // otherwise "unchanged" would keep a month out of the database forever.
  const known = new Map(
    (await SyncState.find({ key: { $in: files.map((f) => synopsisKey(f.id)) } }).lean()).map((s) => [s.key, s]),
  );
  const storedMonths = new Set((await SynopsisMonth.find().select('month').lean()).map((m) => m.month));
  const unchangedMonths = new Set();

  const parsedFiles = [];
  let everyFileRead = true;
  for (const file of files) {
    const tab = `Synopsis/${file.name}`;
    const seen = force ? null : known.get(synopsisKey(file.id));
    if (seen?.month && storedMonths.has(seen.month) && seen.modifiedTime && file.modifiedTime
        && new Date(seen.modifiedTime).getTime() === new Date(file.modifiedTime).getTime()) {
      unchangedMonths.add(seen.month);
      continue;
    }
    try {
      const parsed = parseSynopsisSheet(await sources.getWorkbookRows(file.id, file.mimeType), file.name);
      parsed.warnings.forEach((w) => note(log, tab, w, 'warning'));
      if (!parsed.month) {
        everyFileRead = false;
        note(log, tab, 'Could not determine which month this workbook reports on — skipped.', 'error');
        continue;
      }
      parsedFiles.push({ file, parsed });
    } catch (err) {
      everyFileRead = false;
      note(log, tab, err.message, 'error');
    }
  }

  // Two workbooks resolving to the same month (a re-uploaded copy, "april (1).xlsx") used to
  // overwrite each other in whatever order Drive listed them, so the month could flip between
  // syncs. The most recently modified one is used, and the other is named.
  const byMonth = new Map();
  for (const entry of parsedFiles) {
    const current = byMonth.get(entry.parsed.month);
    if (!current) {
      byMonth.set(entry.parsed.month, entry);
      continue;
    }
    const newer = new Date(entry.file.modifiedTime) > new Date(current.file.modifiedTime) ? entry : current;
    const older = newer === entry ? current : entry;
    note(log, 'Synopsis', `"${newer.file.name}" and "${older.file.name}" both report on ${entry.parsed.month}; using "${newer.file.name}", the more recently modified. Remove the other from the folder.`, 'warning');
    byMonth.set(entry.parsed.month, newer);
  }

  let written = 0;
  for (const { file, parsed } of byMonth.values()) {
    try {
      if (await writeSynopsisMonth(file, parsed, log)) {
        written += 1;
        // Remember which version of this workbook produced the stored month, so the next run
        // can skip downloading it until somebody edits it again.
        await SyncState.updateOne(
          { key: synopsisKey(file.id) },
          { $set: { fileId: file.id, modifiedTime: file.modifiedTime ?? null, month: parsed.month, syncedAt: new Date() } },
          { upsert: true },
        );
      }
    } catch (err) {
      note(log, `Synopsis/${file.name}`, err.message, 'error');
    }
  }

  if (unchangedMonths.size > 0) {
    note(log, 'Synopsis', `${unchangedMonths.size} monthly workbook(s) unchanged in Drive since the last sync (${[...unchangedMonths].sort().join(', ')}) — not downloaded.`, 'info');
  }

  // A month whose workbook has left the folder used to stay on the dashboard forever. It is
  // removed once every workbook in the folder has been read successfully — never after a run
  // in which any file failed, because a month missing from a failed run is not gone.
  let removedMonths = 0;
  if (everyFileRead) {
    // A month whose workbook was skipped as unchanged is still covered by the folder — leaving
    // it out here would delete the very data the skip was meant to preserve.
    const covered = [...byMonth.keys(), ...unchangedMonths];
    const orphans = await SynopsisMonth.find({ month: { $nin: covered } }).select('month sourceFile').lean();
    if (orphans.length > 0) {
      const months = orphans.map((o) => o.month);
      await SynopsisDispatchRecord.deleteMany({ month: { $in: months } });
      await SynopsisMonth.deleteMany({ month: { $in: months } });
      removedMonths = orphans.length;
      note(log, 'Synopsis', `Removed ${orphans.map((o) => `${o.month} (${o.sourceFile})`).join(', ')} — no workbook in the folder reports on ${orphans.length === 1 ? 'that month' : 'those months'} any more.`, 'info');
    }
  }

  log.sources.push({
    name: 'Synopsis',
    parsed: parsedFiles.length,
    inserted: written,
    unchanged: unchangedMonths.size,
    deleted: removedMonths,
    durationMs: Date.now() - started,
    // A run in which every workbook was unchanged did its job: nothing to download, nothing to
    // write. Before this it would have reported the whole step as failed.
    ok: written > 0 || unchangedMonths.size > 0,
  });
}

// ---------------------------------------------------------------------------------------------
// Run
// ---------------------------------------------------------------------------------------------

async function step(log, name, work) {
  try {
    await work();
  } catch (err) {
    note(log, name, err.message, 'error');
    log.sources.push({ name, ok: false });
  }
}

// Where the sheets come from. Always Google Drive in the app; the tests pass in-memory
// workbooks so the whole sync — lock, writes, cleanup, gates — runs against a real MongoDB
// without touching Drive.
const driveSources = {
  openLiveWorkbook: drive.openLiveWorkbook,
  listFolderWorkbooks: drive.listFolderWorkbooks,
  getWorkbookRows: drive.getWorkbookRows,
};

export async function runSync(trigger = 'manual', sources = driveSources) {
  const holder = `${process.pid}-${crypto.randomUUID()}`;
  if (!(await acquireLock(holder))) throw new SyncInProgressError();

  const log = new SyncLog({ trigger, tabsProcessed: [], issues: [], sources: [], status: 'running' });
  try {
    await log.save();
    // A run whose process died stays 'running' forever and the badge reads "Awaiting first
    // sync". Nothing else can be running while this run holds the lock, so any such log is
    // abandoned.
    await SyncLog.updateMany(
      { status: 'running', _id: { $ne: log._id } },
      {
        $set: { status: 'failed', finishedAt: new Date() },
        $push: { issues: { tab: 'sync', message: 'Abandoned — the server stopped before this run finished.', severity: 'error' } },
      },
    );

    // Each source is isolated: one failing costs only itself. The Manpower step used to have
    // no guard, so its failure skipped production, dispatch and the separate synopsis folder.
    let workbook = null;
    const knownLive = await SyncState.findOne({ key: LIVE_WORKBOOK_KEY }).lean();
    const signature = sourceSignature();
    // Skipping the download is an optimisation for the daily schedule. It must never apply when
    // an admin has pressed "Sync now" — they are asking for the sheet to be read, usually
    // because something is missing — nor when this build reads different tabs than the one that
    // stored the figures.
    const mayskip = trigger !== 'manual' && knownLive?.sourceSignature === signature;
    try {
      workbook = await sources.openLiveWorkbook({ knownModifiedTime: mayskip ? knownLive?.modifiedTime ?? null : null });
    } catch (err) {
      note(log, 'Live workbook', `Could not download the live workbook: ${err.message}`, 'error');
    }
    if (workbook?.unchanged) {
      // Drive says the file has not been touched since the version already in the database, so
      // there is nothing to download and nothing to re-parse. Recorded so the run still says
      // what it did rather than looking like it skipped the sheet for an unknown reason.
      note(log, 'Live workbook', `Unchanged in Drive since the last sync (${workbook.modifiedTime?.toISOString() ?? 'unknown'}) — not downloaded.`, 'info');
      log.sources.push({ name: 'Live workbook', fileId: workbook.fileId, modifiedTime: workbook.modifiedTime, skipped: true, durationMs: 0, ok: true });
    } else if (workbook) {
      const errorsBefore = log.issues.filter((i) => i.severity === 'error').length;
      await step(log, 'Manpower', () => syncManpowerTab(workbook, log));
      await step(log, 'Production', () => syncProductionTabs(workbook, log));
      for (const tab of DISPATCH_TABS) {
        await step(log, tab, () => syncDispatchTab(workbook, tab, log));
      }
      // Only a clean pass records the version. After a failure the next run downloads the
      // workbook again instead of treating a half-written parse as up to date.
      const cleanPass = log.issues.filter((i) => i.severity === 'error').length === errorsBefore;
      if (cleanPass && workbook.modifiedTime) {
        await SyncState.updateOne(
          { key: LIVE_WORKBOOK_KEY },
          { $set: { fileId: workbook.fileId, modifiedTime: workbook.modifiedTime, sourceSignature: signature, syncedAt: new Date() } },
          { upsert: true },
        );
      }
    }
    await step(log, 'Synopsis', () => syncSynopsisFolder(log, sources, { force: trigger === 'manual' }));

    const hasErrors = log.issues.some((i) => i.severity === 'error');
    const anySourceOk = log.sources.some((s) => s.ok);
    log.status = !hasErrors ? 'success' : anySourceOk ? 'partial' : 'failed';
  } catch (err) {
    log.status = 'failed';
    note(log, 'sync', err.message, 'error');
  } finally {
    log.finishedAt = new Date();
    // Anything written makes every cached dashboard payload out of date. Cleared here rather
    // than per collection: the pages all derive from the same records.
    if (log.rowsUpserted > 0) invalidateCache();
    try {
      await log.save();
    } finally {
      await releaseLock(holder);
    }
  }
  return log;
}
