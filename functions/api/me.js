// GET /api/me -> who is signed in, and whether they may edit (or 401).
import { json, sessionUser, editorEmails } from '../../cf/lib.js';

export async function onRequestGet({ request, env }) {
  const u = await sessionUser(request, env);
  return u ? json({ email: u.email, name: u.name, canEdit: editorEmails(env).includes(u.email) }) : json({ error: 'not signed in' }, 401);
}
