import { runSync, SyncInProgressError } from '../services/sync.service.js';
import { SyncLog } from '../models/SyncLog.js';
import { GoogleToken } from '../models/GoogleToken.js';
import { sendCached } from '../services/payloadCache.js';

export async function triggerManualSync(req, res) {
  try {
    const log = await runSync('manual');
    res.json(summariseLog(log));
  } catch (err) {
    if (err instanceof SyncInProgressError) {
      return res.status(409).json({ error: err.message });
    }
    console.error('[sync] manual sync failed:', err.message);
    res.status(500).json({ error: 'Sync failed' });
  }
}

// What the badge needs, and nothing else.
//
// This used to return the whole SyncLog — every parser warning, every source row — and every
// open dashboard asked for it once a minute. The live workbook reports dozens of warnings about
// the sheet's own data (§9), so the answer ran to tens of KB, and twenty open tabs turned that
// into hundreds of MB a day of Render bandwidth for a figure that changes once a day. The
// warnings are still there, in full; they are fetched when somebody actually opens the details.
function summariseLog(log) {
  if (!log) return null;
  const issues = log.issues ?? [];
  return {
    id: String(log._id),
    status: log.status,
    trigger: log.trigger,
    finishedAt: log.finishedAt ?? null,
    rowsUpserted: log.rowsUpserted,
    // The badge shows a count of the issues worth attention and a dot for their worst severity;
    // it never needed the text of every one to do that.
    errorCount: issues.filter((i) => i.severity === 'error').length,
    warningCount: issues.filter((i) => i.severity === 'warning').length,
    issueCount: issues.filter((i) => i.severity !== 'info').length,
    synopsisMonths: (log.tabsProcessed ?? []).filter((tab) => tab.startsWith('Synopsis/')).map((tab) => tab.replace('Synopsis/', '')),
  };
}

export async function getSyncStatus(req, res) {
  const wantsDetail = req.query.detail === '1';

  const [latestLog, lastGoodLog, tokenDoc] = await Promise.all([
    // Only the fields the answer can contain: issues and sources are the bulk of the document
    // and are read only for the detailed view.
    SyncLog.findOne()
      .sort({ startedAt: -1 })
      .select(wantsDetail ? '' : 'status trigger finishedAt rowsUpserted issues.severity tabsProcessed')
      .lean(),
    // The run whose data the dashboard is showing: the newest one that wrote anything.
    SyncLog.findOne({ status: { $in: ['success', 'partial'] } }).sort({ startedAt: -1 }).select('finishedAt').lean(),
    GoogleToken.findOne({ purpose: 'drive-sync' }).select('connectedByEmail').lean(),
  ]);

  const payload = {
    driveConnected: Boolean(tokenDoc),
    // Who connected Drive is an admin concern; every manager polls this endpoint.
    connectedByEmail: req.user.role === 'admin' ? tokenDoc?.connectedByEmail ?? null : null,
    latestSync: summariseLog(latestLog),
    lastSuccessfulSyncAt: lastGoodLog?.finishedAt ?? null,
  };

  if (wantsDetail && latestLog) {
    payload.latestSync = {
      ...payload.latestSync,
      tabsProcessed: latestLog.tabsProcessed ?? [],
      issues: latestLog.issues ?? [],
      sources: latestLog.sources ?? [],
    };
  }

  // Not cached in memory (it must reflect a sync that has just run), but still revalidated:
  // between syncs every poll is an unchanged answer, and an ETag turns that into a 304 with no
  // body at all — which is the whole point on a metered connection.
  return sendCached(req, res, { payload, etag: etagForStatus(payload, wantsDetail) });
}

function etagForStatus(payload, detailed) {
  const { latestSync } = payload;
  // The status only changes when a sync finishes (or Drive is connected/disconnected), so those
  // few values identify the answer exactly.
  return `W/"sync-${detailed ? 'd' : 's'}-${latestSync?.id ?? 'none'}-${latestSync?.status ?? 'none'}-${latestSync?.finishedAt ?? 'none'}-${payload.driveConnected}-${payload.connectedByEmail ?? ''}"`;
}
