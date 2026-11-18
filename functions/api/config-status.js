// GET /api/config-status -> what the test machine did with the latest saved configuration (for the page to show).
import { json, canRead } from '../../cf/lib.js';

export async function onRequestGet({ request, env }) {
  if (!(await canRead(request, env))) return json({ error: 'sign in' }, 401);
  const cfg = await env.STORE.get('data/config.json');
  const st = await env.STORE.get('data/config-status.json');
  let c = null, s = null;
  try { c = cfg ? JSON.parse(await cfg.text()) : null; } catch (e) { c = null; }
  try { s = st ? JSON.parse(await st.text()) : null; } catch (e) { s = null; }
  return json({ rev: c ? c.rev : null, updatedAt: c ? c.updatedAt : null, updatedBy: c ? c.updatedBy : null, status: s && c && s.rev === c.rev ? s : null });
}
