import { useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useSearchParams } from 'react-router-dom';
import { format } from 'date-fns';
import { fetchSyncStatus, disconnectDrive } from '../lib/api';
import { SyncStatusBadge } from '../components/dashboard/SyncStatusBadge';
import { TeamAccessPanel } from '../components/settings/TeamAccessPanel';
import { useAuth } from '../context/AuthContext';

const DRIVE_CONNECT_MESSAGES = {
  success: { text: 'Google Drive connected successfully.', good: true },
  no_refresh_token: {
    text: 'Google did not return a refresh token. Revoke access at myaccount.google.com/permissions and try again.',
    good: false,
  },
  failed: { text: 'Connecting Google Drive failed. Please try again.', good: false },
  missing_code: { text: 'Drive connection was cancelled.', good: false },
  invalid_state: { text: 'That connection link was not started from this page, or has expired. Please try again.', good: false },
};

const FOCUS_RING = 'focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[var(--series-1)]';

export function Settings() {
  const [params] = useSearchParams();
  const driveConnect = params.get('driveConnect');
  const queryClient = useQueryClient();
  const { user } = useAuth();
  const [disconnecting, setDisconnecting] = useState(false);
  const isAdmin = user?.role === 'admin';

  // Two panels on one page meant scrolling past the whole Drive card — status, warnings and all
  // — to reach the people list, which is what an admin comes here to use. They are tabs now,
  // and the people list opens first. Coming back from a Drive connection lands on Drive, since
  // that is the result the admin is here to see.
  const [tab, setTab] = useState(driveConnect ? 'drive' : 'people');
  const activeTab = isAdmin ? tab : 'drive';

  // The admin page is the one place that lists every warning the run reported, so it asks for
  // the detailed status. The badge on every other page gets the short one.
  const syncStatusQuery = useQuery({
    queryKey: ['sync-status', 'detail'],
    queryFn: () => fetchSyncStatus({ detail: true }),
    staleTime: Infinity,
    refetchOnWindowFocus: false,
  });

  const status = syncStatusQuery.data;
  const message = driveConnect ? DRIVE_CONNECT_MESSAGES[driveConnect] : null;

  async function handleDisconnect() {
    if (!window.confirm('Disconnect Google Drive sync? Scheduled and manual syncs will stop until it is reconnected.')) {
      return;
    }
    setDisconnecting(true);
    try {
      await disconnectDrive();
      queryClient.invalidateQueries({ queryKey: ['sync-status'] });
    } finally {
      setDisconnecting(false);
    }
  }

  return (
    <div className="mx-auto max-w-4xl px-6 py-6">
      <div className="mb-5 flex flex-wrap items-center justify-between gap-3">
        <h1 className="text-xl font-semibold" style={{ color: 'var(--text-primary)' }}>
          Settings
        </h1>

        {isAdmin && (
          <div className="flex gap-1 rounded-xl border p-1" style={{ background: 'var(--surface-1)' }} role="tablist" aria-label="Settings sections">
            {[
              { key: 'people', label: 'People and access' },
              { key: 'drive', label: 'Google Drive sync' },
            ].map(({ key, label }) => (
              <button
                key={key}
                type="button"
                role="tab"
                aria-selected={activeTab === key}
                onClick={() => setTab(key)}
                className={`rounded-lg px-4 py-1.5 text-sm font-medium transition-colors ${FOCUS_RING}`}
                style={{
                  background: activeTab === key ? 'var(--series-1)' : 'transparent',
                  color: activeTab === key ? '#ffffff' : 'var(--text-secondary)',
                }}
              >
                {label}
              </button>
            ))}
          </div>
        )}
      </div>

      {message && (
        <div
          className="mb-4 rounded-lg border px-4 py-3 text-sm"
          style={{ color: message.good ? 'var(--status-good)' : 'var(--status-critical)' }}
        >
          {message.text}
        </div>
      )}

      <div className="rounded-2xl border p-5" hidden={activeTab !== 'drive'} style={{ background: 'var(--surface-1)' }}>
        <div className="mb-4 flex items-center justify-between">
          <div>
            <div className="text-sm font-semibold" style={{ color: 'var(--text-primary)' }}>
              Google Drive sync
            </div>
            <div className="text-xs" style={{ color: 'var(--text-muted)' }}>
              Pulls the HSD Projects Progress sheet on a schedule and on demand
            </div>
          </div>
          <SyncStatusBadge status={status} onSynced={() => queryClient.invalidateQueries({ queryKey: ['sync-status'] })} />
        </div>

        {status?.driveConnected && (
          <>
            <dl className="grid grid-cols-2 gap-y-2 text-sm">
              <dt style={{ color: 'var(--text-muted)' }}>Connected by</dt>
              <dd style={{ color: 'var(--text-primary)' }}>{status.connectedByEmail}</dd>
              <dt style={{ color: 'var(--text-muted)' }}>Last sync status</dt>
              <dd style={{ color: 'var(--text-primary)' }} className="capitalize">
                {status.latestSync?.status ?? 'none yet'}
              </dd>
              <dt style={{ color: 'var(--text-muted)' }}>Last sync finished</dt>
              <dd style={{ color: 'var(--text-primary)' }}>
                {status.latestSync?.finishedAt ? format(new Date(status.latestSync.finishedAt), 'd MMM yyyy, HH:mm') : '—'}
              </dd>
              <dt style={{ color: 'var(--text-muted)' }}>Rows upserted</dt>
              <dd style={{ color: 'var(--text-primary)' }}>{status.latestSync?.rowsUpserted ?? '—'}</dd>
              <dt style={{ color: 'var(--text-muted)' }}>Tabs processed</dt>
              <dd style={{ color: 'var(--text-primary)' }}>{status.latestSync?.tabsProcessed?.join(', ') || '—'}</dd>
            </dl>

            {user?.role === 'admin' && (
              <button
                onClick={handleDisconnect}
                disabled={disconnecting}
                className="mt-4 rounded-full border px-3 py-1.5 text-xs font-medium disabled:opacity-50"
                style={{ color: 'var(--status-critical)' }}
              >
                {disconnecting ? 'Disconnecting…' : 'Disconnect'}
              </button>
            )}
          </>
        )}

        {status?.latestSync?.issues?.length > 0 && (
          <div className="mt-4 rounded-lg border p-3 text-xs" style={{ color: 'var(--status-serious)' }}>
            <div className="mb-1 font-semibold">Sync warnings</div>
            <ul className="list-inside list-disc space-y-1">
              {status.latestSync.issues.map((issue, i) => (
                <li key={i}>
                  <strong>{issue.tab}:</strong> {issue.message}
                </li>
              ))}
            </ul>
          </div>
        )}
      </div>

      {isAdmin && activeTab === 'people' && <TeamAccessPanel />}
    </div>
  );
}
