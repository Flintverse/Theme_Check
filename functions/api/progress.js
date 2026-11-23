// GET /api/progress[?env=<store>]: live progress of the run in progress (or the latest one), pushed by the runner every ~30 seconds.
// Runs in different stores go on at the same time, each with its own progress file; with no env the one that is running
// (or else the newest) is returned.
import { json, canRead, readAllProgress } from '../../cf/lib.js';

export async function onRequestGet({ request, env }) {
  if (!(await canRead(request, env))) return json({ error: 'access code needed' }, 401);
  const want = new URL(request.url).searchParams.get('env');
  const all = await readAllProgress(env);
  const p = want ? all.find((x) => x.env === want) : all[0];
  return json(p || { running: false, none: true });
}
