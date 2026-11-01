/* Iron Hub clock: starts the server runner on time (his ask, 2026-11-01).

   GitHub's own cron is a lottery (the WHOOP relay measured a 3.2 h median gap on a 15-minute schedule), so it
   cannot be what makes the 9 PM cycle run at 9 PM. A Cloudflare cron fires to the minute; on the slots below this
   Worker asks GitHub to run .github/workflows/agents.yml (a workflow_dispatch starts within seconds), and the job
   decides from the app's own gates whether there is anything to do. A slot with nothing to do costs a minute of a
   free Actions runner and no API call.

   It does one thing: one POST to one fixed workflow on one fixed repo. It reads nothing, takes no input from a
   request (fetch answers 404), and holds one secret, GH_TOKEN. Separate from discord/ on purpose: that Worker is a
   window and must stay read-only. */

export const REPO = 'markwx18/iron-hubv2';
export const WORKFLOW = 'agents.yml';
export const TZ = 'America/New_York';
/* Eastern wall-clock slots. The cron fires every 30 minutes in UTC; the zone is read here, so the slots stay put
   when the clocks change and no cron line has to be edited twice a year.
   - 9 PM, then 9:30 and 10 in case a run failed before the cycle stamped the night. The device steps in from 9:45
     (RUNNER_GRACE_MIN in the app), so the later slots usually find the gate closed.
   - 6:00 to 10:30 for the brief, each with a WHOOP re-read first. The brief's own gates wait for WHOOP until
     10 AM, write without it then, and rewrite once if WHOOP rescores the morning: the "automatic at 10" he asked for. */
export const NIGHT = ['21:00', '21:30', '22:00'];
export const MORNING = ['06:00', '06:30', '07:00', '07:30', '08:00', '08:30', '09:00', '09:30', '10:00', '10:30'];

/* The Eastern half-hour a scheduled instant falls in, "HH:MM". Floored, so a trigger a few seconds late still lands
   in its slot. */
export function easternSlot(ms) {
  const parts = new Intl.DateTimeFormat('en-US', { timeZone: TZ, hour: '2-digit', minute: '2-digit', hourCycle: 'h23' })
    .formatToParts(new Date(ms));
  const get = (t) => (parts.find((p) => p.type === t) || {}).value || '00';
  const h = get('hour') === '24' ? '00' : get('hour');
  const m = +get('minute') < 30 ? '00' : '30';
  return h + ':' + m;
}
/* What to ask for at this instant, or null for nothing. */
export function plan(ms) {
  const slot = easternSlot(ms);
  if (NIGHT.includes(slot)) return { slot, inputs: { mode: 'auto', whoop: '0', over: '0' } };
  if (MORNING.includes(slot)) return { slot, inputs: { mode: 'auto', whoop: '1', over: '0' } };
  return null;
}
/* GitHub refuses an API request without a User-Agent, and a Worker sends none by default. */
export async function tick(ms, env, fetchFn) {
  const p = plan(ms);
  if (!p) return { sent: false };
  if (!env || !env.GH_TOKEN) {
    console.log('clock: ' + p.slot + ' slot, but GH_TOKEN is not set (npx wrangler secret put GH_TOKEN)');
    return { sent: false, slot: p.slot, status: 0 };
  }
  const f = fetchFn || fetch;
  let status = 0, msg = '';
  try {
    const res = await f('https://api.github.com/repos/' + REPO + '/actions/workflows/' + WORKFLOW + '/dispatches', {
      method: 'POST',
      headers: { 'Authorization': 'Bearer ' + env.GH_TOKEN, 'Accept': 'application/vnd.github+json',
        'Content-Type': 'application/json', 'User-Agent': 'ironhub-clock' },
      body: JSON.stringify({ ref: 'main', inputs: p.inputs }),
    });
    status = res.status;
    // GitHub's own words, because a refused token is the likely failure and its message names the cause.
    if (status !== 204) { try { msg = String((await res.json()).message || ''); } catch (e) { msg = ''; } }
  } catch (e) { msg = String(e && e.message || e); }
  console.log('clock: ' + p.slot + ' -> ' + (status === 204 ? 'dispatched' : 'FAILED ' + status + (msg ? ': ' + msg : '')));
  return { sent: status === 204, slot: p.slot, status };
}

export default {
  async scheduled(event, env, ctx) {
    ctx.waitUntil(tick(event.scheduledTime, env));
  },
  async fetch() {
    return new Response('Not found', { status: 404 });
  },
};
