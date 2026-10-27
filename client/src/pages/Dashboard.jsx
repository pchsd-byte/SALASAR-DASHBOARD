import { useState, useCallback } from 'react';
import { useQuery, useQueryClient, keepPreviousData } from '@tanstack/react-query';
import { motion } from 'framer-motion';
import { format } from 'date-fns';
import { fetchHsdSummary, fetchSyncStatus } from '../lib/api';
import { FilterBar, PRESETS, formatRangeLabel } from '../components/dashboard/FilterBar';
import { StatCard } from '../components/dashboard/StatCard';
import { ManpowerTrendChart, ManpowerCategoryChart } from '../components/dashboard/ManpowerChart';
import { ProductionTrendChart, ProductionStageChart } from '../components/dashboard/ProductionChart';
import { DispatchTrendChart, DispatchClientChart } from '../components/dashboard/DispatchChart';
import { InsightsPanel } from '../components/dashboard/InsightsPanel';
import { SyncStatusBadge } from '../components/dashboard/SyncStatusBadge';
import { SynopsisView } from '../components/dashboard/SynopsisView';
import { StaleDataOverlay } from '../components/dashboard/StaleDataOverlay';
import { ErrorBoundary } from '../components/layout/ErrorBoundary';
import { useAuth } from '../context/AuthContext';

const UNIT_LABEL = { HSD: 'HSD', BU: 'Bhilai' };

const VIEWS = [
  { value: 'overview', label: 'Production Synopsis' },
  { value: 'synopsis', label: 'Dispatch Synopsis' },
];

function ViewToggle({ view, onChange }) {
  return (
    <div className="flex items-center gap-1 rounded-lg p-0.5" style={{ background: 'var(--surface-2)' }}>
      {VIEWS.map((option) => (
        <button
          key={option.value}
          onClick={() => onChange(option.value)}
          aria-pressed={view === option.value}
          className="rounded-md px-3 py-1.5 text-sm font-medium transition-colors"
          style={{
            background: view === option.value ? 'var(--series-1)' : 'transparent',
            color: view === option.value ? '#ffffff' : 'var(--text-secondary)',
          }}
        >
          {option.label}
        </button>
      ))}
    </div>
  );
}

export function Dashboard() {
  const [view, setView] = useState('overview');
  const [preset, setPreset] = useState('Month to date');
  const [range, setRange] = useState(PRESETS[3].getRange());
  const [businessUnit, setBusinessUnit] = useState('HSD');
  const queryClient = useQueryClient();
  // Only an admin can run a sync, so only an admin is offered the button in the overlay.
  const { user } = useAuth();

  const params = {
    from: format(range.from, 'yyyy-MM-dd'),
    to: format(range.to, 'yyyy-MM-dd'),
    businessUnit,
  };

  const summaryQuery = useQuery({
    queryKey: ['hsd-summary', params],
    queryFn: () => fetchHsdSummary(params),
    placeholderData: keepPreviousData,
    // The numbers stay exactly as first loaded for the whole session, for every role —
    // admin included. Neither background cron syncs nor a manually triggered "Sync now"
    // change what's on screen; only a fresh sign-in loads a new snapshot (AuthContext
    // clears this cache on logout). "Sync now" still updates the database underneath, an
    // admin just won't see the result until they sign back in.
    staleTime: Infinity,
    refetchOnWindowFocus: false,
    refetchOnMount: false,
  });

  // Loaded once, with the page. It used to poll every 60 seconds from every open tab, and the
  // answer carried the whole sync log — which on Render's free tier was most of the 5 GB of
  // bandwidth that kept suspending the service. The sheets are filled in by hand once a day, so
  // an open dashboard now makes no requests at all: the figures and the badge both refresh on a
  // page reload, or when an admin runs "Sync now" below.
  const syncStatusQuery = useQuery({
    queryKey: ['sync-status'],
    queryFn: () => fetchSyncStatus(),
    staleTime: Infinity,
    refetchOnWindowFocus: false,
    refetchOnMount: false,
  });

  const summary = summaryQuery.data;

  // The only two things that fetch data: opening (or reloading) the page, and an admin running
  // "Sync now". The server is no longer asked anything in between — no polling, no socket — so
  // the figures on screen are simply those of the last page load, which is what "Figures as of
  // the … sync" underneath them has always said.
  const handleSynced = useCallback(() => {
    queryClient.invalidateQueries({ queryKey: ['sync-status'] });
    queryClient.invalidateQueries({ queryKey: ['hsd-summary'] });
    queryClient.invalidateQueries({ queryKey: ['synopsis'] });
    queryClient.invalidateQueries({ queryKey: ['hsd-insights'] });
  }, [queryClient]);

  // Both plants have production now — Bhilai reads its own three progress tabs. The flag stays
  // because the payload still carries it, and a unit without a source would say so here rather
  // than drawing empty charts.
  const productionAvailable = summary?.production?.available ?? false;
  // Both charts come out when the selected range holds no dispatch at all — two cards saying
  // "no dispatches recorded yet in this range" told nobody anything. Bhilai is the case that
  // prompted it: the sheet has written no Bhilai dispatch block since April 2026, so its cards
  // were permanently empty. Nothing is hidden by unit or hard-coded: the moment a range does
  // contain dispatch — a Bhilai block added to the Daily Dispatch tab, say — both charts come
  // back on their own.
  const dispatchAvailable = (summary?.dispatch?.available ?? false)
    && ((summary?.dispatch?.byClient?.length ?? 0) > 0 || (summary?.dispatch?.trendByClient?.length ?? 0) > 0);
  const isSynopsis = view === 'synopsis';

  return (
    <div className="mx-auto max-w-7xl px-6 py-6">
      {/* The figures are frozen for the page session by design (§8.2), so how old they are is
          worth saying out loud once — not in a line under the KPIs that nobody reads. Only when
          the last successful sync is genuinely old; dismissible, and never while syncing. */}
      <StaleDataOverlay
        lastSyncedAt={syncStatusQuery.data?.lastSuccessfulSyncAt}
        isAdmin={user?.role === 'admin'}
        onSynced={handleSynced}
      />
      <div className="mb-6 flex flex-wrap items-center justify-between gap-3">
        <div>
          <h1 className="text-xl font-semibold" style={{ color: 'var(--text-primary)' }}>
            {isSynopsis ? 'Dispatch Synopsis' : `${UNIT_LABEL[businessUnit]} Production Synopsis`}
          </h1>
          <p className="text-sm" style={{ color: 'var(--text-secondary)' }}>
            {isSynopsis ? 'Department-wise dispatch against plan, from the monthly synopsis reports' : formatRangeLabel(range)}
          </p>
        </div>
        <div className="flex flex-wrap items-center gap-3">
          <ViewToggle view={view} onChange={setView} />
          <SyncStatusBadge status={syncStatusQuery.data} onSynced={handleSynced} />
        </div>
      </div>

      {isSynopsis && <SynopsisView />}

      {!isSynopsis && summaryQuery.isError && !summary && (
        <div className="rounded-xl border px-4 py-3 text-sm" style={{ color: 'var(--status-critical)', background: 'var(--surface-1)' }}>
          The dashboard figures could not be loaded. {summaryQuery.error?.response?.data?.error || 'Check your connection and reload the page.'}
        </div>
      )}

      {!isSynopsis && (
        <>
          <div className="mb-6">
            <FilterBar
              activePreset={preset}
              range={range}
              onPresetChange={(label, r) => {
                setPreset(label);
                setRange(r);
              }}
              businessUnit={businessUnit}
              onBusinessUnitChange={setBusinessUnit}
            />
          </div>

          <div className="mb-2 flex flex-wrap items-baseline justify-between gap-2">
            <span className="text-xs font-semibold uppercase tracking-wide" style={{ color: 'var(--text-muted)' }}>
              Snapshot &amp; {formatRangeLabel(range)}
            </span>
            {summary && (
              <span className="text-xs" style={{ color: 'var(--text-muted)' }} title="The figures on this page stay as loaded until you refresh them.">
                {summary.dataAsOf
                  ? `Figures as of the ${format(new Date(summary.dataAsOf), 'd MMM, HH:mm')} sync`
                  : 'No completed sync yet'}
              </span>
            )}
          </div>
          <motion.div
            initial="hidden"
            animate="visible"
            variants={{ visible: { transition: { staggerChildren: 0.06 } } }}
            className="mb-6 flex items-stretch gap-3 overflow-x-auto"
          >
            <StatCard
              compact
              label="Manpower today"
              value={summary?.manpower.today ?? '—'}
              unit="on site"
              accent="var(--series-1)"
            />
            {/* Gated the same way as the charts: this tile shows the most recent day on record,
                which read as "Dispatched (21 Mar) 19 MT" next to an October range — a figure
                from seven months earlier, in a range that holds no dispatch at all. */}
            {dispatchAvailable && (
              <StatCard
                compact
                label={
                  summary.dispatch.lastRecordedDay?.date
                    ? `Dispatched (${format(new Date(summary.dispatch.lastRecordedDay.date), 'd MMM')})`
                    : 'Dispatched'
                }
                value={summary?.dispatch.lastRecordedDay?.total ?? '—'}
                unit="MT"
                accent="var(--series-2)"
              />
            )}
            {productionAvailable && (
              <StatCard
                compact
                wrapLabel
                label="Completed production till final coat"
                value={summary?.production.completedInRange ?? '—'}
                unit="MT"
                accent="var(--series-3)"
              />
            )}
            {dispatchAvailable && (
              <StatCard
                compact
                label={`Dispatched (${preset === 'Custom' ? formatRangeLabel(range) : preset})`}
                value={summary?.dispatch.inRange ?? '—'}
                unit="MT"
                accent="var(--series-2)"
              />
            )}
          </motion.div>

          <div className="grid grid-cols-1 gap-4 lg:grid-cols-2">
            {summary && (
              <>
                <ManpowerCategoryChart byCategory={summary.manpower.byCategory} />
                <ManpowerTrendChart trendByCategory={summary.manpower.trendByCategory} />
                {productionAvailable && (
                  <>
                    <ProductionStageChart byStageByClient={summary.production.byStageByClient} />
                    <ProductionTrendChart trendByClient={summary.production.trendByClient} byClient={summary.production.byClient} />
                  </>
                )}
                {dispatchAvailable && (
                  <>
                    <DispatchClientChart byClient={summary.dispatch.byClient} />
                    <DispatchTrendChart trendByClient={summary.dispatch.trendByClient} byClient={summary.dispatch.byClient} />
                  </>
                )}
              </>
            )}
          </div>

          {summary && (
            <div className="mt-4">
              {/* A broken panel must never take the whole dashboard down with it. */}
              <ErrorBoundary fallback={null}>
                <InsightsPanel params={params} />
              </ErrorBoundary>
            </div>
          )}

          {summaryQuery.isLoading && (
            <div className="mt-10 text-center text-sm" style={{ color: 'var(--text-muted)' }}>
              Loading dashboard…
            </div>
          )}
        </>
      )}
    </div>
  );
}
