// GET /api/config -> what the page needs to show the Google button (public values only).
import { json, allowedDomain } from '../../cf/lib.js';

export async function onRequestGet({ env }) {
  return json({ googleClientId: env.GOOGLE_CLIENT_ID || '', domain: allowedDomain(env) });
}
