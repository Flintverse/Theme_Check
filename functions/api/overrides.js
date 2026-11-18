// PUT /api/overrides  (signed in AND in EDITORS): put a manual verdict on one check of one theme of a run, or take it off.
//   body: { run, key: "<theme>|<layout>|<viewport>|<check id>", status: "skip|pass|review|fail" | null, orig: "<the script's result>" }
// Stored in R2 at runs/<run>/overrides.json. The test machine fetches it (agent) and recalculates its reports and numbers.
import { json, editorUser, editorEmails } from '../../cf/lib.js';

const VERDICTS = ['skip', 'pass', 'review', 'fail'];

export async function onRequestPut({ request, env }) {
  const who = await editorUser(request, env);
  if (!who) return json({ error: editorEmails(env).length ? 'Only the people listed as editors can change a result.' : 'Editing from the web is not enabled.' }, 403);
  let b;
  try { b = await request.json(); } catch (e) { return json({ error: 'bad request' }, 400); }
  const run = String((b && b.run) || '');
  const key = b && b.key;
  const status = b && b.status ? String(b.status) : null;
  if (!/^[\w.-]{1,80}$/.test(run)) return json({ error: 'bad run id' }, 400);
  if (typeof key !== 'string' || key.length < 1 || key.length > 240 || key.split('|').length !== 4 || /[\u0000-\u001f<>]/.test(key)) return json({ error: 'bad check key' }, 400);
  if (status && !VERDICTS.includes(status)) return json({ error: 'status must be skip, pass, review or fail' }, 400);
  if (!(await env.STORE.get(`runs/${run}/results.json`))) return json({ error: 'this run has no results yet' }, 404);

  const file = `runs/${run}/overrides.json`;
  let old = { rev: 0, items: {} };
  try { const o = await env.STORE.get(file); if (o) { const j = JSON.parse(await o.text()); if (j && j.items) old = { rev: Number(j.rev) || 0, items: j.items }; } } catch (e) { /* start empty */ }
  const next = { rev: Math.max(Date.now(), old.rev + 1), items: Object.assign({}, old.items) };
  if (!status) delete next.items[key];
  else next.items[key] = { status, orig: String((b && b.orig) || '').slice(0, 20), by: who.email, at: new Date().toISOString() };
  await env.STORE.put(file, JSON.stringify(next), { httpMetadata: { contentType: 'application/json; charset=utf-8' } });
  return json({ ok: true, rev: next.rev, items: next.items });
}
