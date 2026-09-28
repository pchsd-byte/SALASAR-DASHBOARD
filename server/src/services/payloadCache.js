import crypto from 'node:crypto';

// Server-side response cache.
//
// The source data changes once a day, in the evening, when the plant fills the workbook in by
// hand — but every open dashboard used to re-run the whole aggregation on every request, and
// re-download the answer in full even when not a byte of it had changed. On Render's free tier
// that is what exhausted the workspace's 5 GB of bandwidth every five or six days.
//
// So: build a payload once, keep it in memory until the next sync writes something, and hand
// repeat requests an ETag they can revalidate against for free (304, no body).
//
// In memory deliberately, not in MongoDB: the cache is an optimisation, not data. A restart or
// a second instance simply rebuilds it, and there is nothing to invalidate across processes —
// each process clears its own cache when its own sync writes.

const store = new Map();

// Entries are dropped after this even if no sync has run, so a server left up for days cannot
// serve a payload built from data that a sync on another instance has since replaced.
const DEFAULT_TTL_MS = 60 * 60 * 1000;

export function cacheKey(parts) {
  return JSON.stringify(parts);
}

function etagFor(payload) {
  return `W/"${crypto.createHash('sha1').update(JSON.stringify(payload)).digest('base64url')}"`;
}

// Builds the payload on a miss, or returns the stored one. `build` is only called when needed,
// so a hit costs no database queries at all.
export async function getOrBuild(key, build, ttlMs = DEFAULT_TTL_MS) {
  const hit = store.get(key);
  if (hit && hit.expiresAt > Date.now()) return { payload: hit.payload, etag: hit.etag, hit: true };

  const payload = await build();
  const entry = { payload, etag: etagFor(payload), expiresAt: Date.now() + ttlMs };
  store.set(key, entry);
  return { payload: entry.payload, etag: entry.etag, hit: false };
}

// Called when a sync writes anything. Everything is dropped rather than picked over: the
// figures on every page derive from the same records, and a sync that changed one collection
// has almost certainly changed what the others' payloads should say.
export function invalidateCache() {
  store.clear();
}

export function cacheSize() {
  return store.size;
}

// Sends a cached payload with its ETag, answering 304 when the browser already has that exact
// version. `no-cache` means "revalidate every time", not "do not store": the browser still asks
// on every poll, but an unchanged answer costs a header exchange instead of the whole body.
export function sendCached(req, res, { payload, etag }) {
  res.set('ETag', etag);
  res.set('Cache-Control', 'private, no-cache');
  if (req.headers['if-none-match'] === etag) return res.status(304).end();
  return res.json(payload);
}
