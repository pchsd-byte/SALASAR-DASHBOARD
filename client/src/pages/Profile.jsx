import { useRef, useState } from 'react';
import { Link } from 'react-router-dom';
import { motion } from 'framer-motion';
import { format } from 'date-fns';
import { useAuth } from '../context/AuthContext';
import { updateMyAvatar } from '../lib/api';
import { Avatar, AVATAR_COLORS } from '../components/layout/Avatar';
import { SECTION_LABELS, canOpen } from '../lib/sections';

// What this account is and what it may do — in one place, so nobody has to ask an administrator
// what they have been given, or guess why a page they were told about is not in their nav.
//
// Everything here is read from /auth/me, which is the same answer the server enforces on every
// request. The one thing the page changes is the person's own picture.

const FOCUS_RING = 'focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[var(--series-1)]';
const BUTTON = `rounded-full border px-3 py-1.5 text-xs font-medium transition-colors hover:bg-[var(--surface-2)] disabled:cursor-not-allowed disabled:opacity-50 ${FOCUS_RING}`;

// What each section actually lets somebody do, in the words they would use themselves.
const SECTION_DETAIL = {
  dashboard: 'Production, dispatch and manpower figures for both plants, with the date filters and charts.',
  email: 'Writing, scheduling and sending the plant reports, and the Create Image Reports tool.',
  settings: 'The Google Drive connection and the sync log.',
};

// The browser does the shrinking, so what reaches the server is ~10 KB rather than a photo
// straight off a phone. 128px is twice the largest size it is ever drawn at, for sharp screens.
const AVATAR_PX = 128;

function downscale(file) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onerror = () => reject(new Error('That file could not be read.'));
    reader.onload = () => {
      const img = new Image();
      img.onerror = () => reject(new Error('That file is not an image this browser can open.'));
      img.onload = () => {
        const canvas = document.createElement('canvas');
        canvas.width = AVATAR_PX;
        canvas.height = AVATAR_PX;
        const ctx = canvas.getContext('2d');
        // Square crop from the middle, so portraits are not squashed into the circle.
        const side = Math.min(img.naturalWidth, img.naturalHeight);
        ctx.drawImage(img, (img.naturalWidth - side) / 2, (img.naturalHeight - side) / 2, side, side, 0, 0, AVATAR_PX, AVATAR_PX);
        resolve(canvas.toDataURL('image/jpeg', 0.82));
      };
      img.src = reader.result;
    };
    reader.readAsDataURL(file);
  });
}

function Card({ title, subtitle, children }) {
  return (
    <section className="rounded-2xl border p-5" style={{ background: 'var(--surface-1)' }}>
      <h2 className="text-sm font-semibold" style={{ color: 'var(--text-primary)' }}>{title}</h2>
      {subtitle && <p className="mt-0.5 text-xs" style={{ color: 'var(--text-muted)' }}>{subtitle}</p>}
      <div className="mt-4">{children}</div>
    </section>
  );
}

export function Profile() {
  const { user, refresh } = useAuth();
  const [saving, setSaving] = useState(false);
  const [note, setNote] = useState(null); // { text, good }
  const fileRef = useRef(null);

  if (!user) return null;

  const isAdmin = user.role === 'admin';
  const sections = Object.keys(SECTION_LABELS);
  const kind = user.avatar?.kind ?? 'google';

  async function save(next) {
    setSaving(true);
    setNote(null);
    try {
      await updateMyAvatar(next);
      // The navbar reads the same context, so it changes with the page.
      await refresh();
      setNote({ text: 'Your picture has been updated.', good: true });
    } catch (err) {
      setNote({ text: err?.response?.data?.error || 'That could not be saved. Please try again.', good: false });
    } finally {
      setSaving(false);
    }
  }

  async function handleFile(e) {
    const file = e.target.files?.[0];
    e.target.value = '';
    if (!file) return;
    setNote(null);
    try {
      const dataUrl = await downscale(file);
      await save({ kind: 'photo', dataUrl });
    } catch (err) {
      setNote({ text: err.message, good: false });
    }
  }

  return (
    <div className="mx-auto max-w-3xl px-6 py-6">
      <h1 className="mb-5 text-xl font-semibold" style={{ color: 'var(--text-primary)' }}>
        Your profile
      </h1>

      <motion.div initial={{ opacity: 0, y: 10 }} animate={{ opacity: 1, y: 0 }} transition={{ duration: 0.25 }} className="space-y-4">
        {/* Who you are */}
        <section className="rounded-2xl border p-5" style={{ background: 'var(--surface-1)' }}>
          <div className="flex flex-wrap items-center gap-4">
            <Avatar user={user} size={64} />
            <div className="min-w-0 flex-1">
              <div className="truncate text-lg font-semibold" style={{ color: 'var(--text-primary)' }}>{user.name}</div>
              <div className="truncate text-sm" style={{ color: 'var(--text-secondary)' }}>{user.email}</div>
              <div className="mt-1 flex flex-wrap items-center gap-2">
                <span className="rounded-full px-2.5 py-0.5 text-xs font-medium" style={{ background: 'var(--surface-2)', color: 'var(--text-secondary)' }}>
                  {user.title || (isAdmin ? 'Administrator' : 'Team member')}
                </span>
                <span
                  className="rounded-full px-2.5 py-0.5 text-xs font-semibold uppercase tracking-wide text-white"
                  style={{ background: isAdmin ? 'var(--series-3)' : 'var(--series-1)' }}
                >
                  {isAdmin ? 'Admin' : 'Manager'}
                </span>
              </div>
            </div>
            {/* On a phone this drops to its own line: sharing the row truncated the person's own
                name and address to make space for it, which is the wrong thing to lose. */}
            {user.lastLoginAt && (
              <div className="w-full text-xs sm:w-auto sm:text-right" style={{ color: 'var(--text-muted)' }}>
                Last signed in{' '}
                <span className="sm:block">{format(new Date(user.lastLoginAt), 'd MMM yyyy, HH:mm')}</span>
              </div>
            )}
          </div>
        </section>

        {/* What you may open */}
        <Card
          title="What you can open"
          subtitle={
            isAdmin
              ? 'Administrators get every section except Email, which is ticked for the people who write the reports.'
              : 'Granted by an administrator under Settings → People and access.'
          }
        >
          <ul className="space-y-2">
            {sections.map((key) => {
              const allowed = canOpen(user, key);
              return (
                <li
                  key={key}
                  className="flex items-start gap-3 rounded-xl border px-3 py-2.5"
                  style={{ borderColor: 'var(--baseline)', opacity: allowed ? 1 : 0.55 }}
                >
                  <span
                    aria-hidden="true"
                    className="mt-0.5 flex h-5 w-5 shrink-0 items-center justify-center rounded-full text-[11px] font-bold text-white"
                    style={{ background: allowed ? 'var(--status-good)' : 'var(--text-muted)' }}
                  >
                    {allowed ? '✓' : '—'}
                  </span>
                  <div className="min-w-0">
                    <div className="text-sm font-medium" style={{ color: 'var(--text-primary)' }}>
                      {SECTION_LABELS[key]}
                      <span className="ml-2 text-xs font-normal" style={{ color: allowed ? 'var(--status-good)' : 'var(--text-muted)' }}>
                        {allowed ? 'allowed' : 'not granted'}
                      </span>
                    </div>
                    <div className="text-xs leading-relaxed" style={{ color: 'var(--text-muted)' }}>{SECTION_DETAIL[key]}</div>
                  </div>
                </li>
              );
            })}
          </ul>

          <p className="mt-3 text-xs leading-relaxed" style={{ color: 'var(--text-muted)' }}>
            {isAdmin ? (
              <>You can also run a sync, connect Google Drive, and manage who else gets in — <Link to="/settings" className="underline">Settings</Link>.</>
            ) : (
              <>Need something you do not have? Ask an administrator to tick it for you.</>
            )}
            {canOpen(user, 'email') && user.emailSender && (
              <> Reports you send go out from <strong>{user.emailSender}</strong>.</>
            )}
          </p>
        </Card>

        {/* Your picture */}
        <Card title="Your picture" subtitle="Shown beside your name in the top corner. Only you can change it.">
          <div className="flex flex-wrap items-center gap-5">
            <Avatar user={user} size={72} />

            <div className="flex min-w-0 flex-1 flex-col gap-3">
              <div className="flex flex-wrap gap-2">
                <button type="button" disabled={saving} onClick={() => fileRef.current?.click()} className={BUTTON} style={{ color: 'var(--text-secondary)' }}>
                  Upload a picture
                </button>
                <button
                  type="button"
                  disabled={saving || !user.picture || kind === 'google'}
                  onClick={() => save({ kind: 'google' })}
                  className={BUTTON}
                  style={{ color: 'var(--text-secondary)' }}
                  title={user.picture ? 'Go back to the photo on your Google account' : 'Your Google account has no photo'}
                >
                  Use my Google photo
                </button>
                <input ref={fileRef} type="file" accept="image/*" hidden aria-hidden="true" tabIndex={-1} onChange={handleFile} />
              </div>

              <div>
                <div className="mb-1.5 text-xs" style={{ color: 'var(--text-muted)' }}>Or use your initials:</div>
                <div className="flex flex-wrap gap-2">
                  {AVATAR_COLORS.map((color, index) => {
                    const chosen = kind === 'initials' && (user.avatar?.colorIndex ?? 0) === index;
                    return (
                      <button
                        key={color}
                        type="button"
                        disabled={saving}
                        aria-label={`Initials on colour ${index + 1}`}
                        aria-pressed={chosen}
                        onClick={() => save({ kind: 'initials', colorIndex: index })}
                        className={`h-8 w-8 rounded-full transition-transform hover:scale-110 disabled:opacity-50 ${FOCUS_RING}`}
                        style={{ background: color, outline: chosen ? '2px solid var(--text-primary)' : 'none', outlineOffset: '2px' }}
                      />
                    );
                  })}
                </div>
              </div>

              {note && (
                <div role="status" className="text-xs" style={{ color: note.good ? 'var(--status-good)' : 'var(--status-critical)' }}>
                  {note.text}
                </div>
              )}
              {saving && !note && (
                <div role="status" className="text-xs" style={{ color: 'var(--text-muted)' }}>Saving…</div>
              )}
            </div>
          </div>

          <p className="mt-4 text-xs leading-relaxed" style={{ color: 'var(--text-muted)' }}>
            Pictures are shrunk to {AVATAR_PX}×{AVATAR_PX} in your browser before they are sent, so a photo
            straight off a phone is fine. Your name and email come from your Google account and cannot be changed here.
          </p>
        </Card>
      </motion.div>
    </div>
  );
}
