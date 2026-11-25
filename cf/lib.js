// Shared helpers for the Cloudflare Pages Functions (read-only monitor + ingest from the runner).
// Storage: one R2 bucket bound as STORE.   data/state.json, data/progress.json, runs/<run>/<files> (reports and pictures).
// People sign in with Google; only accounts of ALLOWED_DOMAIN (bsscommerce.com) are let in.

export const json = (obj, status = 200, extra) =>
  new Response(JSON.stringify(obj), { status, headers: Object.assign({ 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store', 'x-content-type-options': 'nosniff' }, extra || {}) });

export function safeEqual(a, b) {
  const x = String(a), y = String(b);
  if (x.length !== y.length) return false;
  let d = 0;
  for (let i = 0; i < x.length; i++) d |= x.charCodeAt(i) ^ y.charCodeAt(i);
  return d === 0;
}

const enc = new TextEncoder();
const b64uToBytes = (s) => { const t = String(s).replace(/-/g, '+').replace(/_/g, '/'); const bin = atob(t + '='.repeat((4 - (t.length % 4)) % 4)); return Uint8Array.from(bin, (c) => c.charCodeAt(0)); };
const bytesToB64u = (buf) => btoa(String.fromCharCode(...new Uint8Array(buf))).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
const textToB64u = (s) => bytesToB64u(enc.encode(s));
const b64uToText = (s) => new TextDecoder().decode(b64uToBytes(s));

const bearer = (request) => {
  const h = request.headers.get('authorization') || '';
  return h.startsWith('Bearer ') ? h.slice(7).trim() : '';
};

// The runner sends  Authorization: Bearer <INGEST_TOKEN>.  The token is a Pages secret, never in the repo.
export function isAuthorized(request, env) {
  const t = bearer(request);
  return !!env.INGEST_TOKEN && t.length >= 16 && safeEqual(t, env.INGEST_TOKEN);
}

export const allowedDomain = (env) => String(env.ALLOWED_DOMAIN || 'bsscommerce.com').toLowerCase();

// ---------- Google sign-in: verify the ID token that "Sign in with Google" hands to the page ----------
const JWKS_URL = 'https://www.googleapis.com/oauth2/v3/certs';

async function getJwks(env) {
  if (env.GOOGLE_JWKS_JSON) return JSON.parse(env.GOOGLE_JWKS_JSON); // tests only: never set in production
  const r = await fetch(JWKS_URL, { cf: { cacheTtl: 3600, cacheEverything: true } });
  if (!r.ok) throw new Error('could not fetch the Google signing keys');
  return r.json();
}

// Returns { email, name } or throws Error with a reason. Checks: RS256 signature against Google's keys, issuer, audience
// (our own client id), expiry, a verified email, and that the account belongs to the allowed domain (both the "hd"
// claim and the end of the address).
export async function verifyGoogleIdToken(token, env, nowMs) {
  const parts = String(token || '').split('.');
  if (parts.length !== 3) throw new Error('not a token');
  const header = JSON.parse(b64uToText(parts[0]));
  const payload = JSON.parse(b64uToText(parts[1]));
  if (header.alg !== 'RS256') throw new Error('unexpected algorithm');
  if (!env.GOOGLE_CLIENT_ID) throw new Error('sign-in is not configured');
  const jwk = ((await getJwks(env)).keys || []).find((k) => k.kid === header.kid);
  if (!jwk) throw new Error('unknown signing key');
  const key = await crypto.subtle.importKey('jwk', jwk, { name: 'RSASSA-PKCS1-v1_5', hash: 'SHA-256' }, false, ['verify']);
  const ok = await crypto.subtle.verify('RSASSA-PKCS1-v1_5', key, b64uToBytes(parts[2]), enc.encode(parts[0] + '.' + parts[1]));
  if (!ok) throw new Error('bad signature');
  const now = Math.floor((nowMs || Date.now()) / 1000);
  if (!['https://accounts.google.com', 'accounts.google.com'].includes(payload.iss)) throw new Error('wrong issuer');
  if (payload.aud !== env.GOOGLE_CLIENT_ID) throw new Error('token is for another app');
  if (!(payload.exp > now - 30)) throw new Error('token expired');
  if (payload.iat && payload.iat > now + 120) throw new Error('token from the future');
  const email = String(payload.email || '').toLowerCase();
  if (payload.email_verified !== true && payload.email_verified !== 'true') throw new Error('email not verified');
  const dom = allowedDomain(env);
  if (!email.endsWith('@' + dom) || email.split('@').length !== 2) throw new Error('not a ' + dom + ' account');
  if (String(payload.hd || '').toLowerCase() !== dom) throw new Error('not a ' + dom + ' Google Workspace account');
  return { email, name: String(payload.name || '').slice(0, 80) };
}

// ---------- the session cookie: signed with SESSION_SECRET, short, HttpOnly ----------
const SESSION_HOURS = 12;
async function hmac(secret, data) {
  const key = await crypto.subtle.importKey('raw', enc.encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  return bytesToB64u(await crypto.subtle.sign('HMAC', key, enc.encode(data)));
}

export async function makeSession(env, user, nowMs) {
  const body = textToB64u(JSON.stringify({ e: user.email, n: user.name || '', x: Math.floor((nowMs || Date.now()) / 1000) + SESSION_HOURS * 3600 }));
  return body + '.' + (await hmac(env.SESSION_SECRET, body));
}

export const sessionCookie = (value) => `tc_session=${value}; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=${SESSION_HOURS * 3600}`;
export const clearCookie = () => 'tc_session=; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=0';

const cookieOf = (request, name) => {
  const m = (request.headers.get('cookie') || '').split(/;\s*/).map((c) => c.split('=')).find((p) => p[0] === name);
  return m ? m.slice(1).join('=') : '';
};

// { email, name } of the signed-in person, or null.
export async function sessionUser(request, env, nowMs) {
  if (!env.SESSION_SECRET || env.SESSION_SECRET.length < 16) return null;
  const c = cookieOf(request, 'tc_session');
  const [body, sig] = c.split('.');
  if (!body || !sig || !safeEqual(sig, await hmac(env.SESSION_SECRET, body))) return null;
  let p;
  try { p = JSON.parse(b64uToText(body)); } catch (e) { return null; }
  if (!(p.x > Math.floor((nowMs || Date.now()) / 1000))) return null;
  if (!String(p.e || '').endsWith('@' + allowedDomain(env))) return null; // the allowed domain is checked again on every request
  return { email: p.e, name: p.n || '' };
}

// Reading needs a signed-in @bsscommerce.com person. A machine can use the X-Access-Key header (READ_KEY, a Pages secret);
// the page never offers it. Nothing configured means nobody gets in.
export async function canRead(request, env) {
  const hdr = request.headers.get('x-access-key') || '';
  if (env.READ_KEY && hdr.length >= 8 && safeEqual(hdr, env.READ_KEY)) return true;
  return !!(await sessionUser(request, env));
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

// A report may run ONE script: the verdict boxes (cf/report-script.js). Its SHA-256 is listed, so nothing else can run in the page,
// and it may only talk to this site (PUT /api/overrides).
import { REPORT_SCRIPT } from './report-script.js';
let cspCache = null;
export async function reportCsp() {
  if (cspCache) return cspCache;
  const d = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(REPORT_SCRIPT.replace(/\r\n/g, '\n')));
  const b64 = btoa(String.fromCharCode(...new Uint8Array(d)));
  cspCache = `default-src 'none'; img-src 'self' data:; style-src 'unsafe-inline'; script-src 'sha256-${b64}'; connect-src 'self'; base-uri 'none'; form-action 'none'`;
  return cspCache;
}

// ---------- who may CHANGE the schedule and the theme lists (everyone signed in may only look) ----------
export const editorEmails = (env) => String(env.EDITORS || '').toLowerCase().split(/[\s,;]+/).filter((e) => e.includes('@'));
export async function editorUser(request, env) {
  const u = await sessionUser(request, env);
  return u && editorEmails(env).includes(u.email) ? u : null;
}

// ---------- the configuration sent from the web page: checked here, and checked again by the test machine ----------
const NAME_OK = /^[A-Za-z0-9][A-Za-z0-9 &'.\-]{0,59}$/;
export function validateConfig(c) {
  const err = [];
  if (!c || typeof c !== 'object') return ['bad request'];
  const s = c.schedule;
  if (s !== undefined) {
    if (!s || typeof s !== 'object') err.push('schedule must be an object');
    else {
      if (!['daily', 'weekly', 'everyNDays'].includes(s.mode)) err.push('mode must be daily, weekly or everyNDays');
      if (!/^([01]\d|2[0-3]):[0-5]\d$/.test(String(s.time))) err.push('time must be HH:MM');
      if (s.mode === 'weekly' && !['MON', 'TUE', 'WED', 'THU', 'FRI', 'SAT', 'SUN'].includes(s.weekday)) err.push('weekday is not valid');
      if (s.mode === 'everyNDays' && !(Number.isInteger(Number(s.everyDays)) && Number(s.everyDays) >= 1 && Number(s.everyDays) <= 90)) err.push('everyDays must be 1 to 90');
      if (!/^[a-z0-9_-]{1,20}$/i.test(String(s.env))) err.push('env is not valid');
      if (!(s.batches === 'all' || /^\d+(,\d+)*$/.test(String(s.batches)))) err.push('batches must be "all" or like 1,2');
    }
  }
  const t = c.themes;
  if (t !== undefined) {
    if (!Array.isArray(t) || t.length > 300) err.push('themes must be a list of at most 300');
    else t.forEach((x, i) => {
      if (!x || !NAME_OK.test(String(x.name || '').trim())) err.push(`theme ${i + 1}: the name is not valid`);
      if (x && x.envs !== undefined && !(Array.isArray(x.envs) && x.envs.every((e) => /^[a-z0-9_-]{1,20}$/i.test(String(e))))) err.push(`theme ${i + 1}: envs are not valid`);
    });
  }
  if (s === undefined && t === undefined) err.push('nothing to save');
  return err.slice(0, 8);
}

// ---------- live progress of every store (progress-<store>.json, and the older progress.json) ----------
// A run that says "running" but has not reported for 10 minutes is called stalled (the runner cannot say "I crashed").
// One entry per store: the running one, else the newest. Running first, then newest.
export async function readAllProgress(env) {
  const byEnv = new Map();
  let cursor;
  do {
    const page = env.STORE.list ? await env.STORE.list({ prefix: 'data/progress', cursor }) : { objects: [{ key: 'data/progress.json' }] };
    for (const o of page.objects || []) {
      if (!/^data\/progress(-[\w-]+)?\.json$/.test(o.key)) continue;
      let p = null;
      try { p = JSON.parse(await (await env.STORE.get(o.key)).text()); } catch (e) { continue; }
      if (!p || typeof p !== 'object') continue;
      if (p.running && p.updatedAt && Date.now() - new Date(p.updatedAt).getTime() > 10 * 60 * 1000) { p.running = false; p.outcome = 'no-update-for-10-minutes'; p.phase = 'stalled'; }
      const k = p.env || o.key;
      const old = byEnv.get(k);
      if (!old || (p.running && !old.running) || (!!p.running === !!old.running && String(p.updatedAt) > String(old.updatedAt))) byEnv.set(k, p);
    }
    cursor = page.truncated ? page.cursor : undefined;
  } while (cursor);
  // running ones first, the one that started first on top (a stable order: the page must not flip between two runs), then the newest
  return Array.from(byEnv.values()).sort((a, b) => (b.running ? 1 : 0) - (a.running ? 1 : 0) || (a.running && b.running ? String(a.startedAt).localeCompare(String(b.startedAt)) : String(b.updatedAt).localeCompare(String(a.updatedAt))));
}

// ---------- a "Run test" request made on the web page: checked here, and checked again by the test machine ----------
export function validateRunRequest(b) {
  const err = [];
  if (!b || typeof b !== 'object') return ['bad request'];
  if (!/^[a-z0-9_-]{1,20}$/i.test(String(b.env || ''))) err.push('testing environment is not valid');
  if (b.browser !== undefined && !['chrome', 'msedge'].includes(b.browser)) err.push('browser must be chrome or msedge');
  if (!Array.isArray(b.themes) || !b.themes.length) err.push('choose at least one theme');
  else if (b.themes.length > 80) err.push('at most 80 themes in one run');
  else if (!b.themes.every((x) => NAME_OK.test(String(x).trim()))) err.push('a theme name is not valid');
  return err;
}
