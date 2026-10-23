import mongoose from 'mongoose';

// What version of each source file the last successful parse was made from.
//
// A sync compares these against Drive's own `modifiedTime` — a metadata call of a few hundred
// bytes — and downloads the workbook only when it has actually changed. The workbook is filled
// in by hand once a day, so most runs (and every manual "Sync now" during the day) now cost
// that metadata call instead of ~400 KB, which is what was exhausting the free tier's
// bandwidth allowance.
//
// A version is recorded only after the file's own data has been parsed and written without
// error, so a run that failed half way is retried in full next time rather than skipped as
// "already up to date".
const syncStateSchema = new mongoose.Schema(
  {
    // 'live-workbook', or 'synopsis:<driveFileId>'.
    key: { type: String, required: true, unique: true },
    fileId: { type: String, default: null },
    modifiedTime: { type: Date, default: null },
    // Which tabs the build that stored this version was reading. A deploy that teaches the sync
    // about new tabs — Bhilai's three progress tabs, say — changes this even though the file in
    // Drive has not been touched, so the next run downloads and re-parses instead of skipping a
    // sheet it can now read more of.
    sourceSignature: { type: String, default: null },
    // For synopsis workbooks: which month the file was found to report on, so a skipped file
    // still counts as covering its month and is not treated as one that left the folder.
    month: { type: String, default: null },
    syncedAt: { type: Date, default: Date.now },
  },
  { timestamps: true },
);

export const SyncState = mongoose.model('SyncState', syncStateSchema);
