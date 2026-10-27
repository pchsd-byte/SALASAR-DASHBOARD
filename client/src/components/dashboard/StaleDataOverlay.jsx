import { useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { AnimatePresence, motion } from 'framer-motion';
import { format, formatDistanceToNowStrict } from 'date-fns';
import { triggerSync } from '../../lib/api';

// Shown over the dashboard when the figures on screen were read from the sheet a long time ago.
//
// The dashboard deliberately freezes what it loaded for the whole page session (§8.2) and the
// sheet is read once a day, so "how old is this?" is a real question that the small "Figures as
// of the … sync" line under the KPIs never made anyone stop and ask. This does — once.
//
// Deliberately not a nag: it appears at most once per browser tab for a given sync, it is
// dismissible, Escape closes it, and dismissing it leaves the page exactly as it was. The sync
// badge in the header still carries the same information for anyone who wants it later.

// How old the figures must be before anyone is interrupted. The sheet is filled in by hand in
// the evening and read at 21:30, so for most of the working day the newest figures available
// are already several hours old — this is about "nobody has read the sheet since yesterday",
// not about minutes.
export const STALE_AFTER_HOURS = 6;

const FOCUS_RING = 'focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[var(--series-1)]';

// One key per sync, so dismissing "9 hours old" does not also dismiss tomorrow's warning — and
// a reload after a fresh sync starts clean. sessionStorage, not localStorage: a new tab or a new
// day at the office is a new chance to be told.
const dismissKey = (syncedAt) => `salasar.staleSync.dismissed:${syncedAt ?? 'never'}`;

function readDismissed(key) {
  try {
    return window.sessionStorage.getItem(key) === '1';
  } catch {
    // Private windows and locked-down browsers throw on storage. The overlay then simply shows
    // once per page load, which is the safe way round.
    return false;
  }
}

function ClockMark({ hours }) {
  // Amber up to a day old, red beyond it — the same language the sync badge uses.
  const tone = hours >= 24 ? 'var(--status-critical)' : 'var(--status-warning)';
  return (
    <div
      className="relative mx-auto mb-5 flex h-16 w-16 items-center justify-center rounded-2xl"
      style={{ background: `color-mix(in srgb, ${tone} 12%, transparent)`, border: `1px solid color-mix(in srgb, ${tone} 35%, transparent)` }}
    >
      <motion.span
        aria-hidden="true"
        className="absolute inset-0 rounded-2xl"
        style={{ border: `1px solid ${tone}` }}
        animate={{ opacity: [0.4, 0.08, 0.4], scale: [1, 1.07, 1] }}
        transition={{ duration: 3, repeat: Infinity, ease: 'easeInOut' }}
      />
      <svg width="30" height="30" viewBox="0 0 24 24" fill="none" stroke={tone} strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
        <circle cx="12" cy="12" r="8.5" />
        <path d="M12 7.5V12l3 1.8" />
      </svg>
    </div>
  );
}

export function StaleDataOverlay({ lastSyncedAt, isAdmin, onSynced }) {
  const [dismissed, setDismissed] = useState(true);
  const [syncing, setSyncing] = useState(false);
  const [error, setError] = useState('');
  const [done, setDone] = useState(false);
  const primaryRef = useRef(null);

  const syncedAt = lastSyncedAt ? new Date(lastSyncedAt) : null;
  const ageHours = syncedAt ? (Date.now() - syncedAt.getTime()) / 36e5 : 0;
  // No timestamp means the status has not loaded yet, or the sheet has never been read at all.
  // Neither is "your figures are old": treating an absent value as infinitely stale flashed the
  // dialog up for a moment on every page load, before the answer had even arrived. A plant with
  // no sync yet has an empty dashboard and a badge that says so.
  const stale = Boolean(syncedAt) && ageHours >= STALE_AFTER_HOURS;

  useEffect(() => {
    // Re-evaluated whenever the sync being reported changes: a successful sync replaces the
    // timestamp, which both clears the staleness and gives a fresh dismissal key.
    setDismissed(!stale || readDismissed(dismissKey(lastSyncedAt)));
    setError('');
    setDone(false);
  }, [lastSyncedAt, stale]);

  const open = stale && !dismissed;

  useEffect(() => {
    if (!open) return undefined;
    primaryRef.current?.focus();
    const onKey = (e) => {
      if (e.key === 'Escape' && !syncing) close();
    };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, syncing]);

  function close() {
    try {
      window.sessionStorage.setItem(dismissKey(lastSyncedAt), '1');
    } catch {
      // Unable to remember the dismissal; closing it for this view is still correct.
    }
    setDismissed(true);
  }

  async function handleSync() {
    setSyncing(true);
    setError('');
    try {
      // A sync that ran but could not read anything answers 200 with a failed log — the request
      // succeeded, the work did not. Reporting "Done" there would tell somebody their figures
      // had been refreshed when nothing had been read at all.
      const log = await triggerSync();
      if (log?.status === 'failed') {
        setError(
          log.errorCount
            ? `The sync ran but could not read the workbook (${log.errorCount} error${log.errorCount === 1 ? '' : 's'}). Check Settings → Google Drive sync.`
            : 'The sync ran but could not read the workbook. Check Settings → Google Drive sync.',
        );
        setSyncing(false);
        return;
      }
      setDone(true);
      // Let the "read" state land for a beat before the figures redraw underneath.
      setTimeout(() => {
        onSynced?.();
        setDismissed(true);
      }, 900);
    } catch (err) {
      const status = err?.response?.status;
      setError(
        status === 409
          ? 'A sync is already running. Give it a minute, then reload the page.'
          : status === 403
            ? 'Your session is out of date. Sign out and back in, then try again.'
            : err?.response?.data?.error || 'The sync could not be started. Please try again.',
      );
      setSyncing(false);
    }
  }

  if (!open) return null;

  const ageLabel = syncedAt ? formatDistanceToNowStrict(syncedAt, { addSuffix: false }) : 'a long time';

  return createPortal(
    <AnimatePresence>
      <motion.div
        key="stale-overlay"
        initial={{ opacity: 0 }}
        animate={{ opacity: 1 }}
        exit={{ opacity: 0 }}
        transition={{ duration: 0.18 }}
        className="fixed inset-0 z-[60] flex items-center justify-center px-4 py-8"
        style={{ background: 'color-mix(in srgb, var(--surface-page) 72%, transparent)', backdropFilter: 'blur(6px)' }}
        onMouseDown={(e) => {
          // Clicking the backdrop dismisses, as in every other dialog — but never mid-sync.
          if (e.target === e.currentTarget && !syncing) close();
        }}
      >
        <motion.div
          role="dialog"
          aria-modal="true"
          aria-labelledby="stale-title"
          aria-describedby="stale-body"
          initial={{ opacity: 0, y: 18, scale: 0.97 }}
          animate={{ opacity: 1, y: 0, scale: 1 }}
          exit={{ opacity: 0, y: 12, scale: 0.98 }}
          transition={{ type: 'spring', stiffness: 260, damping: 24 }}
          className="w-full max-w-md rounded-3xl border p-7 text-center shadow-xl"
          style={{ background: 'var(--surface-1)', borderColor: 'var(--baseline)' }}
        >
          <ClockMark hours={ageHours} />

          <h2 id="stale-title" className="mb-2 text-lg font-semibold" style={{ color: 'var(--text-primary)' }}>
            {done ? 'The sheet has been read again' : `These figures are ${ageLabel} old`}
          </h2>

          <p id="stale-body" className="text-sm leading-relaxed" style={{ color: 'var(--text-secondary)' }}>
            {done
              ? 'The dashboard is refreshing with what the workbook holds now.'
              : 'Everything on this page comes from the last time the workbook was read. Anything entered in the sheet since then is not here yet.'}
          </p>

          {syncedAt && !done && (
            <div
              className="mx-auto mt-5 inline-flex items-center gap-2 rounded-full px-3 py-1.5 text-xs"
              style={{ background: 'var(--surface-2)', color: 'var(--text-secondary)' }}
            >
              <span className="h-1.5 w-1.5 shrink-0 rounded-full" style={{ background: ageHours >= 24 ? 'var(--status-critical)' : 'var(--status-warning)' }} />
              Last read {format(syncedAt, 'd MMM, HH:mm')}
            </div>
          )}

          {error && (
            <div role="alert" className="mt-4 text-xs" style={{ color: 'var(--status-critical)' }}>
              {error}
            </div>
          )}

          <div className="mt-7 flex flex-col gap-2">
            {isAdmin ? (
              <>
                <motion.button
                  ref={primaryRef}
                  type="button"
                  whileTap={syncing ? undefined : { scale: 0.98 }}
                  onClick={handleSync}
                  disabled={syncing || done}
                  aria-busy={syncing}
                  className={`flex items-center justify-center gap-2 rounded-full px-4 py-2.5 text-sm font-medium text-white transition-[filter] hover:brightness-110 disabled:cursor-not-allowed disabled:opacity-70 ${FOCUS_RING}`}
                  style={{ background: done ? 'var(--status-good)' : 'var(--series-1)' }}
                >
                  {syncing && (
                    <span className="h-3.5 w-3.5 animate-spin rounded-full border-2 border-white border-t-transparent" aria-hidden="true" />
                  )}
                  {done ? 'Done' : syncing ? 'Reading the workbook…' : 'Sync now'}
                </motion.button>
                {!done && (
                  <button type="button" onClick={close} disabled={syncing} className={`rounded-full px-4 py-2 text-xs font-medium disabled:opacity-50 ${FOCUS_RING}`} style={{ color: 'var(--text-muted)' }}>
                    Continue with these figures
                  </button>
                )}
              </>
            ) : (
              <>
                {/* Only an admin can run a sync, so a manager is told who to ask rather than
                    shown a button that would answer 403. */}
                <button
                  ref={primaryRef}
                  type="button"
                  onClick={close}
                  className={`rounded-full px-4 py-2.5 text-sm font-medium text-white transition-[filter] hover:brightness-110 ${FOCUS_RING}`}
                  style={{ background: 'var(--series-1)' }}
                >
                  Continue with these figures
                </button>
                <p className="px-2 text-xs leading-relaxed" style={{ color: 'var(--text-muted)' }}>
                  Ask an administrator to run a sync if you need today's numbers.
                </p>
              </>
            )}
          </div>

          {syncing && (
            <p className="mt-4 text-xs" style={{ color: 'var(--text-muted)' }}>
              This can take up to a minute — the workbook is downloaded and every tab re-read.
            </p>
          )}
        </motion.div>
      </motion.div>
    </AnimatePresence>,
    document.body,
  );
}
