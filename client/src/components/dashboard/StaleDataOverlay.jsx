import { useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { AnimatePresence, motion } from 'framer-motion';
import { format, formatDistanceToNowStrict } from 'date-fns';

// Shown over the dashboard when the figures on screen were read from the sheet a long time ago.
//
// The dashboard deliberately freezes what it loaded for the whole page session (§8.2) and the
// sheet is read once a day, so "how old is this?" is a real question that the small "Figures as
// of the … sync" line under the KPIs never made anyone stop and ask. This does — once.
//
// Deliberately not a nag: it appears at most once per browser tab for a given sync, it is
// dismissible, Escape closes it, and dismissing it leaves the page exactly as it was. The sync
// badge in the header still carries the same information for anyone who wants it later.
//
// **Both buttons close it immediately.** "Sync now" hands the run to the Dashboard, which owns
// it and reports progress in a pill at the foot of the page (SyncProgressToast). Holding the
// dialog open for the minute a sync takes kept people from the figures they already had — the
// ones this dialog had just interrupted them about.

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

export function StaleDataOverlay({ lastSyncedAt, isAdmin, onSyncNow }) {
  const [dismissed, setDismissed] = useState(true);
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
  }, [lastSyncedAt, stale]);

  const open = stale && !dismissed;

  useEffect(() => {
    if (!open) return undefined;
    primaryRef.current?.focus();
    const onKey = (e) => {
      if (e.key === 'Escape') close();
    };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open]);

  function close() {
    try {
      window.sessionStorage.setItem(dismissKey(lastSyncedAt), '1');
    } catch {
      // Unable to remember the dismissal; closing it for this view is still correct.
    }
    setDismissed(true);
  }

  function handleSync() {
    // Start it, then get out of the way. The run is the Dashboard's from here.
    onSyncNow?.();
    close();
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
          // Clicking the backdrop dismisses, as in every other dialog.
          if (e.target === e.currentTarget) close();
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
            These figures are {ageLabel} old
          </h2>

          <p id="stale-body" className="text-sm leading-relaxed" style={{ color: 'var(--text-secondary)' }}>
            Everything on this page comes from the last time the workbook was read. Anything entered
            in the sheet since then is not here yet.
          </p>

          {syncedAt && (
            <div
              className="mx-auto mt-5 inline-flex items-center gap-2 rounded-full px-3 py-1.5 text-xs"
              style={{ background: 'var(--surface-2)', color: 'var(--text-secondary)' }}
            >
              <span className="h-1.5 w-1.5 shrink-0 rounded-full" style={{ background: ageHours >= 24 ? 'var(--status-critical)' : 'var(--status-warning)' }} />
              Last read {format(syncedAt, 'd MMM, HH:mm')}
            </div>
          )}

          <div className="mt-7 flex flex-col gap-2">
            {isAdmin ? (
              <>
                <motion.button
                  ref={primaryRef}
                  type="button"
                  whileTap={{ scale: 0.98 }}
                  onClick={handleSync}
                  className={`rounded-full px-4 py-2.5 text-sm font-medium text-white transition-[filter] hover:brightness-110 ${FOCUS_RING}`}
                  style={{ background: 'var(--series-1)' }}
                >
                  Sync now
                </motion.button>
                <button type="button" onClick={close} className={`rounded-full px-4 py-2 text-xs font-medium ${FOCUS_RING}`} style={{ color: 'var(--text-muted)' }}>
                  Continue with these figures
                </button>
                <p className="px-2 text-xs leading-relaxed" style={{ color: 'var(--text-muted)' }}>
                  The sheet is read in the background — you can carry on using the dashboard while it runs.
                </p>
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

        </motion.div>
      </motion.div>
    </AnimatePresence>,
    document.body,
  );
}
