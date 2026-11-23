// GET /api/progress-list: which stores have a run (going or the latest one). The Live page offers a switch between them.
import { json, canRead, readAllProgress } from '../../cf/lib.js';

export async function onRequestGet({ request, env }) {
  if (!(await canRead(request, env))) return json({ error: 'access code needed' }, 401);
  const all = await readAllProgress(env);
  return json({ runs: all.map((x) => ({ env: x.env, runId: x.runId, running: !!x.running, phase: x.phase, updatedAt: x.updatedAt })) });
}
