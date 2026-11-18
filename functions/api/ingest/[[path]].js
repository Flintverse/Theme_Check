// POST /api/ingest/...  (runner only, needs Authorization: Bearer <INGEST_TOKEN>)
//   POST /api/ingest/ping        connectivity and token check
//   POST /api/ingest/progress    live progress JSON
//   POST /api/ingest/state       dashboard data JSON
import { json, isAuthorized } from '../../../cf/lib.js';

const LIMITS = { progress: 1e6, state: 20e6 }; // KV values can be up to 25 MiB

async function handle({ request, env, params }) {
  if (!isAuthorized(request, env)) return json({ error: 'unauthorized' }, 401);
  const parts = Array.isArray(params.path) ? params.path : [params.path];
  const kind = parts[0];
  if (kind === 'ping') return json({ ok: true, kv: !!env.STORE });
  if (!env.STORE) return json({ error: 'KV namespace binding STORE is missing' }, 500);
  if (kind === 'progress' || kind === 'state') {
    const text = await request.text();
    if (text.length > LIMITS[kind]) return json({ error: 'too large' }, 413);
    try { JSON.parse(text); } catch (e) { return json({ error: 'invalid JSON' }, 400); }
    await env.STORE.put(kind, text);
    return json({ ok: true });
  }
  return json({ error: 'not found' }, 404);
}

export const onRequestPost = handle;
export const onRequestPut = handle;
