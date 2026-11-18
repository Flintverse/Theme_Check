// GET /runs/<run>/<file>: reports and pictures stored in R2 (needs the team access code cookie).
import { cleanKey, typeFor, canRead, REPORT_CSP } from '../../cf/lib.js';

export async function onRequestGet({ request, env, params }) {
  if (!(await canRead(request, env))) return new Response('Access code needed', { status: 401 });
  const parts = Array.isArray(params.path) ? params.path : [params.path];
  const key = cleanKey(['runs'].concat(parts));
  if (!key) return new Response('Not found', { status: 404 });
  const obj = await env.STORE.get(key);
  if (!obj) return new Response('Not found', { status: 404 });
  const type = typeFor(key);
  const headers = { 'content-type': type, 'cache-control': 'private, max-age=300', 'x-content-type-options': 'nosniff' };
  if (type.startsWith('text/html')) headers['content-security-policy'] = REPORT_CSP;
  return new Response(obj.body, { headers });
}
