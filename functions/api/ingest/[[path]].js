// POST/PUT /api/ingest/...  (runner only, needs Authorization: Bearer <INGEST_TOKEN>)
//   POST /api/ingest/ping                 connectivity and token check
//   POST /api/ingest/progress             live progress JSON
//   POST /api/ingest/state                dashboard data JSON
//   PUT  /api/ingest/media/<run>/<file>   a report, summary, picture or video of one run
import { json, isAuthorized, cleanKey, typeFor } from '../../../cf/lib.js';

const LIMITS = { progress: 1e6, state: 20e6, media: 95e6 };

async function handle({ request, env, params }) {
  if (!isAuthorized(request, env)) return json({ error: 'unauthorized' }, 401);
  const parts = Array.isArray(params.path) ? params.path : [params.path];
  const kind = parts[0];
  if (kind === 'ping') return json({ ok: true, bucket: !!env.STORE });
  if (!env.STORE) return json({ error: 'R2 bucket binding STORE is missing' }, 500);

  if (kind === 'progress' || kind === 'state') {
    const text = await request.text();
    if (text.length > LIMITS[kind]) return json({ error: 'too large' }, 413);
    try { JSON.parse(text); } catch (e) { return json({ error: 'invalid JSON' }, 400); }
    await env.STORE.put(`data/${kind}.json`, text, { httpMetadata: { contentType: 'application/json; charset=utf-8' } });
    return json({ ok: true });
  }

  if (kind === 'media') {
    const key = cleanKey(['runs'].concat(parts.slice(1)));
    if (!key || parts.length < 3) return json({ error: 'bad path' }, 400);
    const len = Number(request.headers.get('content-length') || 0);
    if (len > LIMITS.media) return json({ error: 'too large' }, 413);
    await env.STORE.put(key, request.body, { httpMetadata: { contentType: typeFor(key) } });
    return json({ ok: true, key });
  }
  return json({ error: 'not found' }, 404);
}

export const onRequestPost = handle;
export const onRequestPut = handle;
