// Shared helpers for the Cloudflare Pages Functions (read-only monitor + ingest from the runner).
// Storage: one R2 bucket bound as STORE.   data/state.json, data/progress.json, runs/<run>/<files> (reports and pictures).

export const json = (obj, status = 200, extra) =>
  new Response(JSON.stringify(obj), { status, headers: Object.assign({ 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store', 'x-content-type-options': 'nosniff' }, extra || {}) });

export function safeEqual(a, b) {
  const x = String(a), y = String(b);
  if (x.length !== y.length) return false;
  let d = 0;
  for (let i = 0; i < x.length; i++) d |= x.charCodeAt(i) ^ y.charCodeAt(i);
  return d === 0;
}

export async function sha256hex(text) {
  const buf = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(String(text)));
  return Array.from(new Uint8Array(buf)).map((b) => b.toString(16).padStart(2, '0')).join('');
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

const cookieOf = (request, name) => {
  const m = (request.headers.get('cookie') || '').split(/;\s*/).map((c) => c.split('=')).find((p) => p[0] === name);
  return m ? m.slice(1).join('=') : '';
};

// Reading needs the team access code (READ_KEY, a Pages secret). The person types it once on the page; /api/login then
// sets an HttpOnly cookie, so pictures (<img> cannot send headers) and pages load too. A header works for scripts.
// Without a READ_KEY the data is open, so one should always be set (or Cloudflare Access put in front).
export async function canRead(request, env) {
  if (!env.READ_KEY) return true;
  const hdr = request.headers.get('x-access-key') || '';
  if (hdr.length >= 8 && safeEqual(hdr, env.READ_KEY)) return true;
  const c = cookieOf(request, 'tc_auth');
  return c.length === 64 && safeEqual(c, await sha256hex(env.READ_KEY));
}

const TYPES = { html: 'text/html; charset=utf-8', json: 'application/json; charset=utf-8', png: 'image/png', txt: 'text/plain; charset=utf-8' };
export const typeFor = (key) => TYPES[(key.split('.').pop() || '').toLowerCase()] || 'application/octet-stream';

// Object keys come from the URL: allow only plain path pieces, never "..".
export function cleanKey(parts) {
  const arr = Array.isArray(parts) ? parts : [parts];
  const key = arr.filter((p) => p !== undefined && p !== '').join('/');
  if (!key || key.length > 300) return null;
  if (!/^[A-Za-z0-9._\-\/]+$/.test(key)) return null;
  if (key.split('/').some((p) => p === '..' || p === '.' || p === '')) return null;
  return key;
}

export const EMPTY_STATE = { readOnly: true, mediaLocal: true, envs: [], themes: [], schedule: {}, task: null, runs: [], issues: { items: {} }, themeStatus: [], checklist: [], library: {} };

// A report is plain HTML with no scripts: lock it down so it can never run code.
export const REPORT_CSP = "default-src 'none'; img-src 'self' data:; style-src 'unsafe-inline'; base-uri 'none'; form-action 'none'";
