// GET /api/state: the dashboard data (runs, issue tracker, themes) pushed by the runner. Read-only.
import { json, EMPTY_STATE } from '../../cf/lib.js';

export async function onRequestGet({ env }) {
  const obj = await env.STORE.get('data/state.json');
  if (!obj) return json(Object.assign({}, EMPTY_STATE, { note: 'No data pushed yet. Run a check with the monitor configured, or: node src/cli.js sync' }));
  return new Response(obj.body, { headers: { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' } });
}
