// GET /api/schedule-info: what the Schedule page shows about the test machine - the saved schedule, the Windows task (next and last
// run), whether the two agree, what is running now and what waits. The agent on the test machine pushes it about every 20 seconds
// while it changes. When it has not been seen for 3 minutes the page is told the machine may be off.
import { json, canRead } from '../../cf/lib.js';

export async function onRequestGet({ request, env }) {
  if (!(await canRead(request, env))) return json({ error: 'access code needed' }, 401);
  const obj = await env.STORE.get('data/schedule-info.json');
  if (!obj) return json({ none: true });
  let p = null;
  try { p = JSON.parse(await obj.text()); } catch (e) { return json({ none: true }); }
  p.ageSeconds = p.at ? Math.max(0, Math.round((Date.now() - new Date(p.at).getTime()) / 1000)) : null;
  p.machineSeen = p.ageSeconds !== null && p.ageSeconds < 180;
  return json(p);
}
