// GET /api/progress: live progress of the run in progress, pushed by the runner about once a minute.
import { json, canRead } from '../../cf/lib.js';

export async function onRequestGet({ request, env }) {
  if (!canRead(request, env)) return json({ error: 'access code needed' }, 401);
  const text = await env.STORE.get('progress');
  if (!text) return json({ running: false, none: true });
  let p = null;
  try { p = JSON.parse(text); } catch (e) { return json({ running: false, none: true }); }
  // The runner cannot say "I crashed". If a "running" run has not reported for 10 minutes, call it stalled.
  if (p.running && p.updatedAt && Date.now() - new Date(p.updatedAt).getTime() > 10 * 60 * 1000) {
    p.running = false;
    p.outcome = 'no-update-for-10-minutes';
    p.phase = 'stalled';
  }
  return json(p);
}
