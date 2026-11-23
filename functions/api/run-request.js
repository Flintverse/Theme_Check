// "Run test" from the web page.
//   GET    /api/run-request          (signed in)             the latest requests with their state, and which stores are busy
//   POST   /api/run-request          (signed in AND editor)  { env, themes: [names], browser?: "chrome"|"msedge", tracker?: bool }
//   DELETE /api/run-request?id=<id>  (signed in AND editor)  cancel a request that has not started yet
// The request is kept in R2 (data/run-requests/<id>.json). The test machine (agent) takes it within about 15 seconds, checks it
// again, starts it in its own browser when the store is free, or keeps it queued when a run is going on in that store. A run in
// progress is never stopped by a request.
import { json, canRead, editorUser, editorEmails, validateRunRequest, readAllProgress } from '../../cf/lib.js';

const PREFIX = 'data/run-requests/';

async function listRequests(env, limit) {
  const page = await env.STORE.list({ prefix: PREFIX, limit: 300 });
  const keys = (page.objects || []).map((o) => o.key);
  const cancelled = new Set(keys.filter((k) => k.endsWith('.cancel')).map((k) => k.slice(PREFIX.length, -7)));
  const items = [];
  for (const k of keys.filter((x) => x.endsWith('.json'))) {
    try { const x = await env.STORE.get(k); const j = JSON.parse(await x.text()); if (cancelled.has(j.id)) j.cancelRequested = true; items.push(j); } catch (e) { /* skip */ }
  }
  items.sort((a, b) => String(b.requestedAt).localeCompare(String(a.requestedAt)));
  return items.slice(0, limit || 30);
}

export async function onRequestGet({ request, env }) {
  if (!(await canRead(request, env))) return json({ error: 'access code needed' }, 401);
  const requests = (await listRequests(env, 30)).map((r) => ({ id: r.id, env: r.env, browser: r.browser, themes: r.themes, status: r.status, note: r.note || '', runId: r.runId || '', requestedBy: r.requestedBy, requestedAt: r.requestedAt, startedAt: r.startedAt || null, finishedAt: r.finishedAt || null, tracker: !!r.tracker, cancelRequested: !!r.cancelRequested }));
  const busy = (await readAllProgress(env)).filter((p) => p.running).map((p) => p.env);
  return json({ requests, busy, browsers: { chrome: 'Google Chrome', msedge: 'Microsoft Edge' } });
}

export async function onRequestPost({ request, env }) {
  const who = await editorUser(request, env);
  if (!who) return json({ error: editorEmails(env).length ? 'Only the people listed as editors can start a test.' : 'Editing from the web is not enabled.' }, 403);
  let b;
  try { b = await request.json(); } catch (e) { return json({ error: 'bad request' }, 400); }
  const problems = validateRunRequest(b);
  if (problems.length) return json({ error: problems.join('; ') }, 400);
  // not too many open requests at once
  const open = (await listRequests(env, 60)).filter((r) => r.status === 'requested' || r.status === 'queued' || r.status === 'running');
  if (open.length >= 10) return json({ error: 'There are already 10 requests waiting or running. Wait for some to finish.' }, 429);
  const id = 'w' + Date.now().toString(36) + Math.random().toString(36).slice(2, 5);
  const doc = {
    id, env: String(b.env), browser: b.browser || 'chrome', themes: Array.from(new Set(b.themes.map((x) => String(x).replace(/\s+/g, ' ').trim()))),
    tracker: !!b.tracker, requestedBy: who.email, requestedAt: new Date().toISOString(), status: 'requested', note: 'Waiting for the test machine to pick it up (it checks every few seconds).', runId: '', startedAt: null, finishedAt: null,
  };
  await env.STORE.put(`${PREFIX}${id}.json`, JSON.stringify(doc), { httpMetadata: { contentType: 'application/json; charset=utf-8' } });
  return json({ ok: true, id });
}

export async function onRequestDelete({ request, env }) {
  const who = await editorUser(request, env);
  if (!who) return json({ error: 'Only the people listed as editors can cancel a test.' }, 403);
  const id = new URL(request.url).searchParams.get('id') || '';
  if (!/^[\w-]{1,40}$/.test(id)) return json({ error: 'bad request id' }, 400);
  const obj = await env.STORE.get(`${PREFIX}${id}.json`);
  if (!obj) return json({ error: 'No such request.' }, 404);
  let doc; try { doc = JSON.parse(await obj.text()); } catch (e) { return json({ error: 'No such request.' }, 404); }
  if (!['requested', 'queued'].includes(doc.status)) return json({ error: doc.status === 'running' ? 'It is already running. A run in progress is never stopped from here.' : 'It is already ' + doc.status + '.' }, 409);
  // a separate marker, so the test machine writing the state of the request cannot erase it
  await env.STORE.put(`${PREFIX}${id}.cancel`, JSON.stringify({ by: who.email, at: new Date().toISOString() }), { httpMetadata: { contentType: 'application/json; charset=utf-8' } });
  return json({ ok: true });
}
