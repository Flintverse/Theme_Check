// POST /api/login  { "credential": "<Google ID token>" }  -> checks it, and sets the session cookie for @bsscommerce.com accounts.
import { json, verifyGoogleIdToken, makeSession, sessionCookie, allowedDomain } from '../../cf/lib.js';

export async function onRequestPost({ request, env }) {
  if (!env.SESSION_SECRET || !env.GOOGLE_CLIENT_ID) return json({ error: 'sign-in is not configured' }, 503);
  let credential = '';
  try { credential = String((await request.json()).credential || ''); } catch (e) { return json({ error: 'bad request' }, 400); }
  let user;
  try { user = await verifyGoogleIdToken(credential, env); } catch (e) {
    const msg = String(e.message || '');
    const wrongAccount = /account$/.test(msg) || /not a .* account/.test(msg);
    return json({ error: wrongAccount ? `Only @${allowedDomain(env)} accounts can sign in.` : 'Google sign-in could not be verified.', reason: wrongAccount ? 'domain' : 'invalid' }, wrongAccount ? 403 : 401);
  }
  const cookie = sessionCookie(await makeSession(env, user));
  return json({ ok: true, email: user.email, name: user.name }, 200, { 'set-cookie': cookie });
}
