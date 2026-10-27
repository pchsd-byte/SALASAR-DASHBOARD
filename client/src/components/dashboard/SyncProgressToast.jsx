import { useEffect } from 'react';
import { createPortal } from 'react-dom';
import { AnimatePresence, motion } from 'framer-motion';

// Progress for a sync that is running while somebody carries on using the dashboard.
//
// A sync downloads the workbook and re-reads every tab, which can take the better part of a
// minute. Holding a dialog open for it stopped anybody reading the figures they already had —
// the very figures the dialog was interrupting them about. So the dialog closes the moment the
// button is pressed and the work reports itself here instead.
//
// It lives on the Dashboard, not inside the dialog: a component that unmounts cannot report what
// happens after it is gone.

const FOCUS_RING = 'focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[var(--series-1)]';

// A result worth reading stays long enough to read; a failure waits to be dismissed.
const AUTO_DISMISS_MS = { done: 4500, partial: 8000 };

const TONE = {
  running: 'var(--series-1)',
  done: 'var(--status-good)',
  partial: 'var(--status-warning)',
  error: 'var(--status-critical)',
};

export function SyncProgressToast({ state, message, onDismiss }) {
  useEffect(() => {
    const after = AUTO_DISMISS_MS[state];
    if (!after) return undefined;
    const timer = setTimeout(onDismiss, after);
    return () => clearTimeout(timer);
  }, [state, onDismiss]);

  const tone = TONE[state];

  return createPortal(
    <div role="status" aria-live="polite" className="pointer-events-none fixed inset-x-0 bottom-6 z-50 flex justify-center px-4">
      <AnimatePresence>
        {state !== 'idle' && (
          <motion.div
            key={state}
            initial={{ opacity: 0, y: 16, scale: 0.97 }}
            animate={{ opacity: 1, y: 0, scale: 1 }}
            exit={{ opacity: 0, y: 16, scale: 0.97 }}
            transition={{ duration: 0.18 }}
            className="pointer-events-auto flex w-full max-w-md items-start gap-3 rounded-xl border px-4 py-3 shadow-lg"
            style={{ background: 'var(--surface-1)', borderColor: tone }}
          >
            {state === 'running' ? (
              <span
                aria-hidden="true"
                className="mt-0.5 h-4 w-4 shrink-0 animate-spin rounded-full border-2 border-t-transparent"
                style={{ borderColor: tone, borderTopColor: 'transparent' }}
              />
            ) : (
              <span
                aria-hidden="true"
                className="mt-0.5 flex h-5 w-5 shrink-0 items-center justify-center rounded-full text-xs font-bold text-white"
                style={{ background: tone }}
              >
                {state === 'done' ? '✓' : '!'}
              </span>
            )}

            <div className="min-w-0 flex-1">
              <div className="text-sm font-medium" style={{ color: 'var(--text-primary)' }}>
                {state === 'running' && 'Reading the workbook…'}
                {state === 'done' && 'Figures updated'}
                {state === 'partial' && 'Synced, with issues'}
                {state === 'error' && 'The sync did not finish'}
              </div>
              <div className="mt-0.5 text-xs leading-relaxed" style={{ color: 'var(--text-muted)' }}>
                {message}
              </div>
            </div>

            {/* A run in progress cannot be called off, so there is nothing to offer but patience. */}
            {state !== 'running' && (
              <button type="button" onClick={onDismiss} aria-label="Dismiss" className={`shrink-0 rounded-sm text-xs leading-none ${FOCUS_RING}`} style={{ color: 'var(--text-muted)' }}>
                ✕
              </button>
            )}
          </motion.div>
        )}
      </AnimatePresence>
    </div>,
    document.body,
  );
}
