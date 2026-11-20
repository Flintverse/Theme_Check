// POST/PUT/GET /api/ingest/...  (runner only, needs Authorization: Bearer <INGEST_TOKEN>)
//   POST /api/ingest/ping                 connectivity and token check
//   POST /api/ingest/progress             live progress JSON
//   POST /api/ingest/state                dashboard data JSON
//   GET  /api/ingest/overrides?run=<id>   the manual verdicts of one run (saved from the web page)
//   GET  /api/ingest/config               the latest saved schedule + theme lists
//   POST /api/ingest/config               the test machine saved a change itself (so the web page shows it)
//   POST /api/ingest/config-status        what the test machine did with a saved configuration
//   PUT  /api/ingest/media/<run>/<file>   a report, summary or picture of one run (no videos)
//   DELETE /api/ingest/run/<run>          remove one run: every file stored under runs/<run>/
//   DELETE /api/ingest/progress           forget the live progress (the Live page then shows "No run yet")
import { json, isAuthorized, cleanKey, typeFor, validateConfig } from '../../../cf/lib.js';

const LIMITS = { progress: 1e6, state: 20e6, media: 15e6, config: 2e6, 'config-status': 1e5 };

async function handle({ request, env, params }) {
  if (!isAuthorized(request, env)) return json({ error: 'unauthorized' }, 401);
  const parts = Array.isArray(params.path) ? params.path : [params.path];
  const kind = parts[0];
  if (kind === 'ping') return json({ ok: true, bucket: !!env.STORE });
  if (!env.STORE) return json({ error: 'R2 bucket binding STORE is missing' }, 500);

  if (kind === 'config' && request.method === 'GET') {
    const obj = await env.STORE.get('data/config.json');
    return obj ? new Response(obj.body, { headers: { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' } }) : json({ rev: 0 });
  }

  if (request.method === 'DELETE') {
    if (kind === 'progress') { await env.STORE.delete('data/progress.json'); return json({ ok: true }); }
    if (kind === 'run') {
      const id = String(parts[1] || '');
      if (!/^[\w.-]{1,80}$/.test(id)) return json({ error: 'bad run id' }, 400);
      let cursor, removed = 0;
      do { // R2 lists at most 1000 objects at a time
        const page = await env.STORE.list({ prefix: `runs/${id}/`, cursor });
        const keys = (page.objects || []).map((o) => o.key);
        if (keys.length) { await env.STORE.delete(keys); removed += keys.length; }
        cursor = page.truncated ? page.cursor : undefined;
      } while (cursor);
      return json({ ok: true, removed });
    }
    return json({ error: 'not found' }, 404);
  }

  if (kind === 'overrides' && request.method === 'GET') { // the manual verdicts of one run, saved from the web page
    const run = new URL(request.url).searchParams.get('run') || '';
    if (!/^[\w.-]{1,80}$/.test(run)) return json({ error: 'bad run id' }, 400);
    const obj = await env.STORE.get(`runs/${run}/overrides.json`);
    return obj ? new Response(obj.body, { headers: { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' } }) : json({ rev: 0, items: {} });
  }

  if (kind === 'progress' || kind === 'state' || kind === 'config' || kind === 'config-status') {
    const text = await request.text();
    if (text.length > LIMITS[kind]) return json({ error: 'too large' }, 413);
    let body;
    try { body = JSON.parse(text); } catch (e) { return json({ error: 'invalid JSON' }, 400); }
    if (kind === 'config') {
      const problems = validateConfig(body);
      if (problems.length) return json({ error: problems.join('; ') }, 400);
      body = { rev: Number(body.rev) || Date.now(), updatedAt: new Date().toISOString(), updatedBy: String(body.updatedBy || 'test machine').slice(0, 80), source: 'machine', schedule: body.schedule, themes: body.themes };
      await env.STORE.put('data/config.json', JSON.stringify(body), { httpMetadata: { contentType: 'application/json; charset=utf-8' } });
      return json({ ok: true, rev: body.rev });
    }
    await env.STORE.put(`data/${kind}.json`, text, { httpMetadata: { contentType: 'application/json; charset=utf-8' } });
    return json({ ok: true });
  }

  if (kind === 'media') {
    const key = cleanKey(['runs'].concat(parts.slice(1)));
    if (!key || parts.length < 3) return json({ error: 'bad path' }, 400);
    if (!/\.(png|html|json)$/i.test(key)) return json({ error: 'only png, html and json files are accepted' }, 415);
    if (Number(request.headers.get('content-length') || 0) > LIMITS.media) return json({ error: 'too large' }, 413);
    await env.STORE.put(key, request.body, { httpMetadata: { contentType: typeFor(key) } });
    return json({ ok: true, key });
  }
  return json({ error: 'not found' }, 404);
}

export const onRequestGet = handle;
export const onRequestPost = handle;
export const onRequestPut = handle;
export const onRequestDelete = handle;
