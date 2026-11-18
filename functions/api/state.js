// GET /api/state: the dashboard data (runs, issue tracker, themes) pushed by the runner. Read-only.
import { json, canRead, EMPTY_STATE } from '../../cf/lib.js';

export async function onRequestGet({ request, env }) {
  if (!canRead(request, env)) return json({ error: 'access code needed' }, 401);
  const text = await env.STORE.get('state');
  if (!text) return json(Object.assign({}, EMPTY_STATE, { note: 'No data pushed yet. Run: node src/cli.js sync' }));
  return new Response(text, { headers: { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' } });
}
