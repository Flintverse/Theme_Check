// Shared helpers for the Cloudflare Pages Functions (read-only monitor + ingest from the runner).
// Storage: ONE Workers KV namespace bound as STORE, two keys only:  state  and  progress.
// (Pictures, videos and reports are NOT stored here: they stay on the runner / Google Drive.)

export const json = (obj, status = 200) =>
  new Response(JSON.stringify(obj), { status, headers: { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store', 'x-content-type-options': 'nosniff' } });

export function safeEqual(a, b) {
  const x = String(a), y = String(b);
  if (x.length !== y.length) return false;
  let d = 0;
  for (let i = 0; i < x.length; i++) d |= x.charCodeAt(i) ^ y.charCodeAt(i);
  return d === 0;
}

const bearer = (request) => {
  const h = request.headers.get('authorization') || '';
  return h.startsWith('Bearer ') ? h.slice(7).trim() : '';
};

// The runner sends  Authorization: Bearer <INGEST_TOKEN>.  The token is a Pages secret, never in the repo.
export function isAuthorized(request, env) {
  const t = bearer(request);
  return !!env.INGEST_TOKEN && t.length >= 16 && safeEqual(t, env.INGEST_TOKEN);
}

// Reading the dashboard data needs the team access code (READ_KEY, a Pages secret), sent as the header X-Access-Key.
// If no READ_KEY is configured the data is open, so Cloudflare Access or a READ_KEY should always be set up.
export function canRead(request, env) {
  if (!env.READ_KEY) return true;
  const k = request.headers.get('x-access-key') || '';
  return k.length >= 8 && safeEqual(k, env.READ_KEY);
}

export const EMPTY_STATE = { readOnly: true, mediaLocal: false, envs: [], themes: [], schedule: {}, task: null, runs: [], issues: { items: {} }, themeStatus: [], checklist: [], library: {} };
