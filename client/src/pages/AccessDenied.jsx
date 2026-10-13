import { useSearchParams, Link } from 'react-router-dom';
import { motion } from 'framer-motion';
import { API_BASE } from '../lib/api';
import { useAuth } from '../context/AuthContext';

// Where somebody lands when Google says who they are and this plant has never heard of them.
//
// It used to be /login?error=not_allowed — a red line above a sign-in button, which reads as
// "that didn't work, try again", so people retried the same account and then rang somebody. The
// page now says the three things they actually need: that the sign-in itself worked, that access
// here is granted by name, and that their request is already in front of an admin.
//
// Three situations share this page:
//   not_allowed — nobody has added them (their attempt is now in the admin's queue)
//   revoked     — they were on the list and an admin switched them off
//   no_sections — they are on the list, signed in, but have no section ticked yet

const COPY = {
  not_allowed: {
    title: 'You need access first',
    lead: 'Your Google sign-in worked. This dashboard is private to the plant team, and an administrator adds each person by name.',
    detail: 'We have let the administrators know you tried — they will see your address in their list. If it is urgent, send them a message as well.',
    tone: 'var(--status-warning)',
  },
  revoked: {
    title: 'Your access has been switched off',
    lead: 'This account was on the plant team list, and an administrator has since turned it off.',
    detail: 'If that was not meant to happen, ask an administrator to switch it back on.',
    tone: 'var(--status-critical)',
  },
  no_sections: {
    title: 'Nothing has been shared with you yet',
    lead: 'You are signed in, but no part of the dashboard has been assigned to this account.',
    detail: 'Ask an administrator to tick the sections you need under Settings → People and access.',
    tone: 'var(--status-warning)',
  },
};

function LockMark({ tone }) {
  return (
    <motion.div
      initial={{ scale: 0.86, opacity: 0 }}
      animate={{ scale: 1, opacity: 1 }}
      transition={{ type: 'spring', stiffness: 220, damping: 18 }}
      className="relative mx-auto mb-6 flex h-20 w-20 items-center justify-center rounded-2xl"
      style={{ background: `color-mix(in srgb, ${tone} 12%, transparent)`, border: `1px solid color-mix(in srgb, ${tone} 35%, transparent)` }}
    >
      {/* A ring that keeps breathing, so the page looks alive rather than broken. */}
      <motion.span
        aria-hidden="true"
        className="absolute inset-0 rounded-2xl"
        style={{ border: `1px solid ${tone}` }}
        animate={{ opacity: [0.45, 0.1, 0.45], scale: [1, 1.08, 1] }}
        transition={{ duration: 3.2, repeat: Infinity, ease: 'easeInOut' }}
      />
      <svg width="34" height="34" viewBox="0 0 24 24" fill="none" stroke={tone} strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
        <rect x="4" y="10.5" width="16" height="10.5" rx="2.5" />
        <path d="M8 10.5V7.5a4 4 0 0 1 8 0v3" />
        <circle cx="12" cy="15.6" r="1.25" fill={tone} stroke="none" />
      </svg>
    </motion.div>
  );
}

export function AccessDenied({ variant }) {
  const [params] = useSearchParams();
  const { user, logout } = useAuth();
  const reason = variant ?? (COPY[params.get('reason')] ? params.get('reason') : 'not_allowed');
  const copy = COPY[reason];
  // On /access-denied the server passes the address along, because no session exists to ask.
  const email = user?.email ?? params.get('email');

  return (
    <div className="flex min-h-screen items-center justify-center px-4 py-10" style={{ background: 'var(--surface-page)' }}>
      <motion.div
        initial={{ opacity: 0, y: 14 }}
        animate={{ opacity: 1, y: 0 }}
        transition={{ duration: 0.35 }}
        className="w-full max-w-md rounded-3xl border p-8 text-center shadow-sm"
        style={{ background: 'var(--surface-1)', borderColor: 'var(--baseline)' }}
      >
        <img src="/favicon.svg" alt="" className="mx-auto mb-6 h-9 w-9" />

        <LockMark tone={copy.tone} />

        <h1 className="mb-2 text-xl font-semibold" style={{ color: 'var(--text-primary)' }}>
          {copy.title}
        </h1>
        <p className="text-sm leading-relaxed" style={{ color: 'var(--text-secondary)' }}>
          {copy.lead}
        </p>

        {email && (
          <div
            className="mx-auto mt-5 flex max-w-full items-center justify-center gap-2 rounded-full px-3 py-1.5 text-xs"
            style={{ background: 'var(--surface-2)', color: 'var(--text-secondary)' }}
          >
            <span className="h-1.5 w-1.5 shrink-0 rounded-full" style={{ background: copy.tone }} />
            <span className="truncate">{email}</span>
          </div>
        )}

        <p className="mt-5 text-xs leading-relaxed" style={{ color: 'var(--text-muted)' }}>
          {copy.detail}
        </p>

        <div className="mt-7 flex flex-col gap-2">
          {/* Signed in but unassigned: the useful action is to leave, not to sign in again. */}
          {user ? (
            <button
              type="button"
              onClick={logout}
              className="rounded-full px-4 py-2.5 text-sm font-medium text-white transition-[filter] hover:brightness-110"
              style={{ background: 'var(--series-1)' }}
            >
              Sign out
            </button>
          ) : (
            <a
              href={`${API_BASE}/api/auth/google`}
              className="rounded-full px-4 py-2.5 text-sm font-medium text-white transition-[filter] hover:brightness-110"
              style={{ background: 'var(--series-1)' }}
            >
              Try a different Google account
            </a>
          )}
          <Link to="/login" className="rounded-full px-4 py-2 text-xs font-medium" style={{ color: 'var(--text-muted)' }}>
            Back to sign in
          </Link>
        </div>
      </motion.div>
    </div>
  );
}
