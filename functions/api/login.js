// POST /api/login  { "code": "..." }  -> sets the HttpOnly cookie that unlocks the data and the pictures.
import { json, safeEqual, sha256hex } from '../../cf/lib.js';

export async function onRequestPost({ request, env }) {
  if (!env.READ_KEY) return json({ ok: true, open: true });
  let code = '';
  try { code = String((await request.json()).code || ''); } catch (e) { return json({ error: 'bad request' }, 400); }
  if (code.length < 8 || !safeEqual(code, env.READ_KEY)) {
    await new Promise((r) => setTimeout(r, 800)); // slows down guessing
    return json({ error: 'wrong code' }, 401);
  }
  const cookie = `tc_auth=${await sha256hex(env.READ_KEY)}; Path=/; HttpOnly; Secure; SameSite=Strict; Max-Age=2592000`;
  return json({ ok: true }, 200, { 'set-cookie': cookie });
}
