// Shared helpers for the Cloudflare Pages Functions (read-only monitor + ingest from the runner).
// Storage: one R2 bucket bound as STORE.  data/state.json, data/progress.json, runs/<run>/<files>.

export const json = (obj, status = 200) =>
  new Response(JSON.stringify(obj), { status, headers: { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store', 'x-content-type-options': 'nosniff' } });

export function safeEqual(a, b) {
  const x = String(a), y = String(b);
  if (x.length !== y.length) return false;
  let d = 0;
  for (let i = 0; i < x.length; i++) d |= x.charCodeAt(i) ^ y.charCodeAt(i);
  return d === 0;
}

// The runner sends  Authorization: Bearer <INGEST_TOKEN>.  The token is a Pages secret, never in the repo.
export function isAuthorized(request, env) {
  const h = request.headers.get('authorization') || '';
  const t = h.startsWith('Bearer ') ? h.slice(7).trim() : '';
  return !!env.INGEST_TOKEN && t.length >= 16 && safeEqual(t, env.INGEST_TOKEN);
}

// Object keys come from the URL: allow only plain path pieces, never "..".
export function cleanKey(parts) {
  const arr = Array.isArray(parts) ? parts : [parts];
  const key = arr.filter((p) => p !== undefined && p !== '').join('/');
  if (!key || key.length > 300) return null;
  if (!/^[A-Za-z0-9._\-\/]+$/.test(key)) return null;
  if (key.split('/').some((p) => p === '..' || p === '.' || p === '')) return null;
  return key;
}

const TYPES = { html: 'text/html; charset=utf-8', json: 'application/json; charset=utf-8', png: 'image/png', webm: 'video/webm', txt: 'text/plain; charset=utf-8' };
export const typeFor = (key) => TYPES[(key.split('.').pop() || '').toLowerCase()] || 'application/octet-stream';

export const EMPTY_STATE = { readOnly: true, envs: [], themes: [], schedule: {}, task: null, runs: [], issues: { items: {} }, themeStatus: [], checklist: [] };

// A report is plain HTML with no scripts: lock it down so it can never run code.
export const REPORT_CSP = "default-src 'none'; img-src 'self' data:; media-src 'self'; style-src 'unsafe-inline'; base-uri 'none'; form-action 'none'";
