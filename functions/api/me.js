// GET /api/me -> who is signed in (or 401).
import { json, sessionUser } from '../../cf/lib.js';

export async function onRequestGet({ request, env }) {
  const u = await sessionUser(request, env);
  return u ? json({ email: u.email, name: u.name }) : json({ error: 'not signed in' }, 401);
}
