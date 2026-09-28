import cron from 'node-cron';
import { runSync, SyncInProgressError } from '../services/sync.service.js';
import { env } from '../config/env.js';

export function startSyncCron() {
  if (!cron.validate(env.syncCron)) {
    // Refusing to start a broken schedule silently would leave the dashboard on whatever data
    // it had, with nothing anywhere saying the sync had stopped running.
    console.error(`[sync] SYNC_CRON "${env.syncCron}" is not a valid cron expression — no sync is scheduled. Fix it and redeploy.`);
    return;
  }

  cron.schedule(
    env.syncCron,
    async () => {
      try {
        const log = await runSync('cron');
        console.log(`[sync] daily sync ${log.status}, ${log.rowsUpserted} rows upserted`);
      } catch (err) {
        // Another run holds the lock — a manual "Sync now", or a second process. Skipping is
        // the point of the lock.
        if (err instanceof SyncInProgressError) {
          console.log('[sync] scheduled tick skipped: a sync is already running');
        } else {
          console.error('[sync] scheduled sync failed:', err.message);
        }
      }
    },
    { timezone: env.syncTimezone },
  );

  console.log(`[sync] scheduled "${env.syncCron}" (${env.syncTimezone})`);
}
