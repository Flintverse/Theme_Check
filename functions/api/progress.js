// GET /api/progress: live progress of the run in progress, pushed by the runner every few seconds.
import { json } from '../../cf/lib.js';

export async function onRequestGet({ env }) {
  const obj = await env.STORE.get('data/progress.json');
  if (!obj) return json({ running: false, none: true });
  const body = await obj.text();
  let p = null;
  try { p = JSON.parse(body); } catch (e) { return json({ running: false, none: true }); }
  // The runner cannot say "I crashed". If a "running" run has not reported for 10 minutes, call it stalled.
  if (p.running && p.updatedAt && Date.now() - new Date(p.updatedAt).getTime() > 10 * 60 * 1000) {
    p.running = false;
    p.outcome = 'no-update-for-10-minutes';
    p.phase = 'stalled';
  }
  return json(p);
}
