// GET  /api/config  -> public settings for the sign-in page (client id, domain)
// PUT  /api/config  -> (signed in AND in EDITORS) saves the schedule and/or the theme lists. The test machine picks them up
//                      within about a minute and applies them (Task Scheduler, repo, dashboard data).
import { json, allowedDomain, editorUser, editorEmails, validateConfig } from '../../cf/lib.js';

export async function onRequestGet({ env }) {
  return json({ googleClientId: env.GOOGLE_CLIENT_ID || '', domain: allowedDomain(env) });
}

export async function onRequestPut({ request, env }) {
  const who = await editorUser(request, env);
  if (!who) return json({ error: editorEmails(env).length ? 'Only the people listed as editors can change the schedule or the themes.' : 'Editing from the web is not enabled.' }, 403);
  let body;
  try { body = await request.json(); } catch (e) { return json({ error: 'bad request' }, 400); }
  const problems = validateConfig(body);
  if (problems.length) return json({ error: problems.join('; ') }, 400);
  const prev = await env.STORE.get('data/config.json');
  let old = {};
  try { old = prev ? JSON.parse(await prev.text()) : {}; } catch (e) { old = {}; }
  const next = {
    rev: Date.now(),
    updatedAt: new Date().toISOString(),
    updatedBy: who.email,
    source: 'web',
    schedule: body.schedule !== undefined ? body.schedule : old.schedule,
    themes: body.themes !== undefined ? body.themes : old.themes,
  };
  await env.STORE.put('data/config.json', JSON.stringify(next), { httpMetadata: { contentType: 'application/json; charset=utf-8' } });
  if (env.STORE.delete) await env.STORE.delete('data/config-status.json');
  return json({ ok: true, rev: next.rev });
}
