/* Iron Hub clock -- Worker test suite.   node clock/test_worker.js
   Drives the real handler with a recording fetch. IRONHUB_CLOCK_SRC points it at a mutant copy of src/, the way
   IRONHUB_HTML does for the app. Every instant is a fixed UTC time, so nothing depends on when it is run. */
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const SRC = process.env.IRONHUB_CLOCK_SRC || path.join(here, 'src');
const W = await import(new URL('file:///' + path.join(SRC, 'worker.js').replace(/\\/g, '/')).href);

let pass = 0, fail = 0;
function ok(name, cond, extra) {
  if (cond) pass++;
  else { fail++; console.log('  FAIL: ' + name + (extra !== undefined ? ' -> ' + extra : '')); }
}
function recorder(status, body) {
  const calls = [];
  const f = async (url, opts) => { calls.push({ url, opts }); return new Response(body === undefined ? null : JSON.stringify(body), { status }); };
  f.calls = calls;
  return f;
}
const ENV = { GH_TOKEN: 'ghp_test' };
const T = (iso) => Date.parse(iso);

console.log('=== CLOCK: SLOTS ===');
// Daylight time (EDT, UTC-4): 9 PM is 01:00 UTC the next day.
ok('EDT: 01:00 UTC is the 9 PM slot', W.easternSlot(T('2026-10-21T01:00:00Z')) === '21:00', W.easternSlot(T('2026-10-21T01:00:00Z')));
ok('EDT: 9 PM plans the night run, without a WHOOP re-read', JSON.stringify(W.plan(T('2026-10-21T01:00:00Z'))) ===
   JSON.stringify({ slot: '21:00', inputs: { mode: 'auto', whoop: '0', over: '0' } }));
ok('EDT: 02:00 UTC is 10 PM, the last night slot', W.plan(T('2026-10-21T02:00:00Z')).slot === '22:00');
ok('EDT: 02:30 UTC (10:30 PM) is nothing', W.plan(T('2026-10-21T02:30:00Z')) === null);
// Standard time (EST, UTC-5), after Nov 1 2026: the same UTC hour is now 8 PM and must be nothing.
ok('EST: 01:00 UTC is 8 PM, not a slot', W.plan(T('2026-11-04T01:00:00Z')) === null, W.easternSlot(T('2026-11-04T01:00:00Z')));
ok('EST: 02:00 UTC is the 9 PM slot', W.plan(T('2026-11-04T02:00:00Z')) && W.plan(T('2026-11-04T02:00:00Z')).slot === '21:00');
// The night the clocks change: 1:00-2:00 AM EDT happens twice, which touches no slot.
ok('fall back: 05:30 and 06:30 UTC on Nov 1 are 1:30 AM twice, never a slot', W.plan(T('2026-11-01T05:30:00Z')) === null && W.plan(T('2026-11-01T06:30:00Z')) === null);
ok('fall back: 9 PM on Nov 1 itself is 02:00 UTC', W.plan(T('2026-11-02T02:00:00Z')) && W.plan(T('2026-11-02T02:00:00Z')).slot === '21:00' &&
   W.plan(T('2026-11-02T01:00:00Z')) === null);
// Spring forward (Mar 14 2027): the day before, 9 PM is 02:00 UTC; the day after, 01:00 UTC again.
ok('spring forward: 9 PM is 02:00 UTC on Mar 13 2027 and 01:00 UTC on Mar 15', W.plan(T('2027-03-14T02:00:00Z')).slot === '21:00' && W.plan(T('2027-03-14T01:00:00Z')) === null &&
   W.plan(T('2027-03-16T01:00:00Z')) && W.plan(T('2027-03-16T01:00:00Z')).slot === '21:00');
// Mornings, each with a WHOOP re-read.
const mornings = ['2026-11-03T11:00:00Z', '2026-11-03T13:30:00Z', '2026-11-03T15:00:00Z', '2026-11-03T15:30:00Z'];
ok('mornings: 6:00, 8:30, 10:00 and 10:30 EST all ask, with WHOOP first', mornings.every((t) => { const p = W.plan(T(t)); return p && p.inputs.whoop === '1' && p.inputs.mode === 'auto'; }),
   mornings.map((t) => W.easternSlot(T(t))).join());
ok('mornings: 5:30 and 11:00 EST are nothing', W.plan(T('2026-11-03T10:30:00Z')) === null && W.plan(T('2026-11-03T16:00:00Z')) === null);
ok('a trigger 40 s late still lands in its slot', W.plan(T('2026-11-04T02:00:40Z')).slot === '21:00');
let n = 0;
for (let t = T('2026-11-03T05:00:00Z'); t < T('2026-11-04T05:00:00Z'); t += 30 * 60000) if (W.plan(t)) n++;
ok('a whole Eastern day has 13 slots: 10 mornings and 3 nights', n === 13, n);

console.log('=== CLOCK: THE ONE REQUEST ===');
let f = recorder(204);
let r = await W.tick(T('2026-11-04T02:00:00Z'), ENV, f);
ok('a slot sends exactly one request', f.calls.length === 1 && r.sent === true && r.slot === '21:00');
const c = f.calls[0];
ok('to the agents workflow on his repo, as a POST', c.url === 'https://api.github.com/repos/markwx18/iron-hubv2/actions/workflows/agents.yml/dispatches' && c.opts.method === 'POST', c.url);
ok('with the token, a User-Agent (GitHub refuses a request without one) and the inputs on main',
   c.opts.headers.Authorization === 'Bearer ghp_test' && !!c.opts.headers['User-Agent'] &&
   JSON.stringify(JSON.parse(c.opts.body)) === JSON.stringify({ ref: 'main', inputs: { mode: 'auto', whoop: '0', over: '0' } }), c.opts.body);
f = recorder(204);
r = await W.tick(T('2026-11-03T20:00:00Z'), ENV, f);
ok('outside a slot it sends nothing at all', f.calls.length === 0 && r.sent === false);
f = recorder(204);
r = await W.tick(T('2026-11-04T02:00:00Z'), {}, f);
ok('with no token it sends nothing and says so', f.calls.length === 0 && r.sent === false && r.slot === '21:00');
f = recorder(403, { message: 'Resource not accessible by personal access token' });
const logs = []; const keep = console.log; console.log = (m) => logs.push(String(m));
r = await W.tick(T('2026-11-04T02:00:00Z'), ENV, f);
console.log = keep;
ok('a refusal is not a success, and GitHub’s reason is logged', r.sent === false && r.status === 403 && logs.some((l) => /FAILED 403: Resource not accessible/.test(l)), logs.join(' | '));
const thrower = async () => { throw new TypeError('network down'); };
r = await W.tick(T('2026-11-04T02:00:00Z'), ENV, thrower);
ok('a network failure is caught, never thrown into the runtime', r.sent === false && r.status === 0);

console.log('=== CLOCK: NO OTHER DOOR ===');
const res = await W.default.fetch(new Request('https://ironhub-clock.example/anything?mode=reload', { method: 'POST', body: '{}' }));
ok('an HTTP request does nothing: 404, and no dispatch is possible from outside', res.status === 404);
const waits = [];
f = recorder(204);
const realFetch = globalThis.fetch; globalThis.fetch = f;
await W.default.scheduled({ scheduledTime: T('2026-11-03T12:00:00Z') }, ENV, { waitUntil: (p) => waits.push(p) });
await Promise.all(waits);
globalThis.fetch = realFetch;
ok('scheduled() dispatches through waitUntil on a morning slot', waits.length === 1 && f.calls.length === 1 && JSON.parse(f.calls[0].opts.body).inputs.whoop === '1');

console.log('\nRESULT: ' + pass + ' passed, ' + fail + ' failed');
process.exit(fail ? 1 : 0);
