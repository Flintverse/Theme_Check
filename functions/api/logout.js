// POST /api/logout -> ends the session.
import { json, clearCookie } from '../../cf/lib.js';

export async function onRequestPost() {
  return json({ ok: true }, 200, { 'set-cookie': clearCookie() });
}
