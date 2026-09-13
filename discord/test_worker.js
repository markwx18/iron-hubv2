/* Iron Hub × Discord — Worker test suite.   node test_worker.js
   Drives the real handlers (app.js) with a fake fetch, fake KV and a real Ed25519 key pair.
   Same bar as test_agents.js: assert what was produced, and every fixture messy enough that a
   wrong branch cannot pass by accident. Nothing here depends on today's date. */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { webcrypto } from 'node:crypto';

const here = path.dirname(fileURLToPath(import.meta.url));
// IRONHUB_DISCORD_SRC lets a mutant copy of src/ be tested, exactly like IRONHUB_HTML.
const SRC = process.env.IRONHUB_DISCORD_SRC || path.join(here, 'src');
const imp = (f) => import(new URL('file:///' + path.join(SRC, f).replace(/\\/g, '/')).href);
const app = await imp('app.js');
const core = await imp('core.js');
const { chartSVG } = await imp('chart.js');
if (!globalThis.crypto) globalThis.crypto = webcrypto;

let pass = 0, fail = 0;
function ok(name, cond, extra) {
  if (cond) pass++;
  else { fail++; console.log('  FAIL: ' + name + (extra !== undefined ? ' -> ' + extra : '')); }
}

/* ---------- fixtures ---------- */
const OWNER = '111111111111111111';
const keys = await crypto.subtle.generateKey({ name: 'Ed25519' }, true, ['sign', 'verify']);
const pubHex = Buffer.from(await crypto.subtle.exportKey('raw', keys.publicKey)).toString('hex');

const DATA = {
  logs: [
    { id: 'a', date: '2026-06-02', day: 'D2', entries: [
      { exercise: 'Barbell Bench Press', sets: [{ w: 155, r: 8 }, { w: 155, r: 7 }, { w: 145, r: 12 }] },
      { exercise: 'Cable Fly', sets: [{ w: 30, r: 12 }] }] },
    { id: 'b', date: '2026-07-10', day: 'D2', entries: [
      { exercise: 'Barbell Bench Press', sets: [{ w: 165, r: 6 }, { w: 160, r: 8 }] }] },
    // Newest D2 -- but logged BEFORE 'b' in the array, so array order != date order.
    { id: 'c', date: '2026-09-01', day: 'D2', entries: [
      { exercise: 'Barbell Bench Press', sets: [{ w: 180, r: 1 }, { w: 175, r: 5 }, { w: 170, r: 6 }] },
      { exercise: 'Dips', sets: [{ w: 0, r: 12 }] }] },
    { id: 'd', date: '2026-09-05', day: 'D4', entries: [
      { exercise: 'Barbell Bench Press', sets: [{ w: 135, r: 10 }] }] },
  ],
  prHistory: [
    { exercise: 'Barbell Bench Press', weight: 165, reps: 6, e1rm: 198, prev: 190.4, gain: 7.6, date: '2026-07-10', t: 1 },
    { exercise: 'Barbell Bench Press', weight: 175, reps: 5, e1rm: 204.2, prev: 198, gain: 6.2, date: '2026-09-01', t: 2 },
  ],
  invest: { flags: [{ id: 'f1', status: 'active', severity: 'orange', title: 'Bench stalling', findings: ['flat 3 weeks'] },
                    { id: 'f0', status: 'dismissed', severity: 'red', title: 'old', findings: [] }] },
  agents: {
    proposals: [{ id: 'p1', agent: 'delta', title: 'Progress bench to 180', reasoning: 'hit top of range @everyone', status: 'pending', created: '2026-09-10', expires: '2026-09-17' },
                { id: 'p0', agent: 'echo', title: 'old', status: 'approved' }],
    log: [
      { id: 'l1', agent: 'delta', text: 'Short DELTA note.', at: '2026-09-10T02:00:00Z' },
      { id: 'l2', agent: 'echo', text: 'ECHO note.', at: '2026-09-10T02:00:00Z' },
      { id: 'l3', agent: 'delta', text: ('Paragraph of DELTA reasoning. ').repeat(300), at: '2026-09-09T02:00:00Z' },
    ],
    brief: { text: 'Push day. Recovery high.', date: '2026-09-10', at: '2026-09-10T11:00:00Z' },
  },
};
array_swap(DATA.logs, 1, 2);
function array_swap(a, i, j) { const t = a[i]; a[i] = a[j]; a[j] = t; }
const VIEW = {
  app: 'ironhub-discord', v: 1, generatedAt: Date.parse('2026-09-10T12:00:00Z'), date: '2026-09-10', build: '2026-09-13-v1',
  status: { readiness: { pct: 72, label: 'high', tone: 'good', source: 'WHOOP' }, streak: 4,
    today: { dayKey: 'D2', rest: false, name: 'Push', logged: false },
    upcoming: [{ date: '2026-09-11', day: 'D3', name: 'Legs' }, { date: '2026-09-12', day: 'REST', name: 'Rest' }], pending: 1 },
  week: { start: '2026-09-08', lastStart: '2026-09-01', lastEnd: '2026-09-07',
    groups: [{ group: 'Chest', sets: 12, status: 'green', lastSets: 14 }, { group: 'Hamstrings', sets: 3.5, status: 'red', lastSets: 6 }] },
  charts: { 'Barbell Bench Press': [['2026-06-01', 188.3], ['2026-07-06', 198], ['2026-08-31', 204.2]] },
  days: { D2: 'Push', D3: 'Legs', D4: 'Upper' },
};
const NOW = Date.parse('2026-09-10T14:00:00Z');

function makeEnv(extra) {
  const kv = new Map();
  return Object.assign({
    GIST_ID: 'g1', GIST_TOKEN: 'tok', DISCORD_APP_ID: 'app1', DISCORD_PUBLIC_KEY: pubHex, DISCORD_OWNER_ID: OWNER,
    DISCORD_WEBHOOK_URL: 'https://discord.com/api/webhooks/1/abc',
    ALERTS: { _m: kv, async get(k, t) { const v = kv.get(k); return v == null ? null : t === 'json' ? JSON.parse(v) : v; }, async put(k, v) { kv.set(k, v); } },
  }, extra || {});
}
function makeDeps(data, view, opts) {
  const calls = [];
  const gist = () => ({ files: {
    'ironhub_data.json': { content: JSON.stringify({ app: 'ironhub', v: 1, exportedAt: 5, data: data }) },
    ...(view ? { 'discord_view.json': { content: JSON.stringify(view) } } : {}) } });
  const deps = {
    calls,
    now: () => NOW,
    renderPng: async (svg) => { deps.svg = svg; return new Uint8Array([0x89, 0x50, 0x4e, 0x47]); },
    fetch: async (url, init) => {
      calls.push({ url, method: (init && init.method) || 'GET', init });
      if (url.startsWith('https://api.github.com/gists/')) return new Response(JSON.stringify(gist()), { status: 200 });
      if (opts && opts.discordFail && url.startsWith('https://discord.com')) return new Response('nope', { status: 500 });
      return new Response('{}', { status: 200 });
    },
  };
  return deps;
}
async function signed(body, opts) {
  const ts = String(Math.floor(NOW / 1000));
  const sig = Buffer.from(await crypto.subtle.sign('Ed25519', keys.privateKey, new TextEncoder().encode(ts + body))).toString('hex');
  const sentBody = opts && opts.tamper ? body.replace('status', 'statuz') : body;
  return new Request('https://w.example/interactions', { method: 'POST', body: sentBody,
    headers: { 'X-Signature-Ed25519': opts && opts.badSig ? '00'.repeat(64) : sig, 'X-Signature-Timestamp': ts } });
}
function cmd(name, options, user) {
  return JSON.stringify({ type: 2, token: 'itok', member: { user: { id: user || OWNER } },
    data: { name: 'ironhub', options: [{ type: 1, name, options: options || [] }] } });
}
async function run(bodyStr, deps, env, reqOpts) {
  app._resetCache();
  const waits = [];
  const res = await app.handleRequest(await signed(bodyStr, reqOpts), env || makeEnv(), { waitUntil: (p) => waits.push(p) }, deps);
  await Promise.all(waits);
  return res;
}
const discordCalls = (deps) => deps.calls.filter((c) => c.url.startsWith('https://discord.com'));
const payloadOf = (c) => {
  if (typeof c.init.body === 'string') return JSON.parse(c.init.body);
  return JSON.parse(c.init.body.get('payload_json'));
};

/* ---------- signature & access ---------- */
console.log('=== SIGNATURE AND OWNER GATE ===');
{
  const deps = makeDeps(DATA, VIEW);
  const r = await run(JSON.stringify({ type: 1 }), deps);
  ok('PING with a valid signature answers PONG', r.status === 200 && (await r.json()).type === 1);
  const bad = await run(JSON.stringify({ type: 1 }), deps, undefined, { badSig: true });
  ok('a bad signature is 401', bad.status === 401);
  const tam = await run(cmd('status'), makeDeps(DATA, VIEW), undefined, { tamper: true });
  ok('a tampered body is 401', tam.status === 401);
  const noKey = await run(JSON.stringify({ type: 1 }), deps, makeEnv({ DISCORD_PUBLIC_KEY: 'zz' }));
  ok('a malformed public key fails closed', noKey.status === 401);

  const d2 = makeDeps(DATA, VIEW);
  const stranger = await run(cmd('status', [], '999'), d2);
  const sj = await stranger.json();
  ok('a non-owner gets an ephemeral refusal', sj.type === 4 && sj.data.flags === 64, JSON.stringify(sj));
  ok('...and nothing is read from GitHub for them', !d2.calls.some((c) => c.url.includes('github')));
  const d3 = makeDeps(DATA, VIEW);
  const unsetOwner = await run(cmd('status'), d3, makeEnv({ DISCORD_OWNER_ID: '' }));
  ok('an unset DISCORD_OWNER_ID refuses everyone', (await unsetOwner.json()).type === 4 && !d3.calls.some((c) => c.url.includes('github')));
  const d4 = makeDeps(DATA, VIEW);
  const ac = await run(JSON.stringify({ type: 4, member: { user: { id: '999' } }, data: { name: 'ironhub', options: [{ type: 1, name: 'compare', options: [{ name: 'session', value: '', focused: true }] }] } }), d4);
  ok('a non-owner gets no autocomplete data', (await ac.json()).data.choices.length === 0);
}

/* ---------- read-only by construction ---------- */
console.log('=== READ ONLY ===');
{
  const srcText = ['app.js', 'core.js', 'chart.js', 'worker.js', 'verify.js'].map((f) => fs.readFileSync(path.join(SRC, f), 'utf8')).join('\n');
  // Every GitHub call must be an explicit GET.
  const ghCalls = srcText.match(/deps\.fetch\([^;]*github[^;]*;|deps\.fetch\(f\.raw_url[^;]*;/g) || [];
  ok('GitHub calls exist and are all explicit GETs', ghCalls.length >= 2 && ghCalls.every((c) => /method: 'GET'/.test(c)), ghCalls.join(' | '));
  ok('no write verb is ever aimed at GitHub', !/api\.github\.com[\s\S]{0,200}method:\s*'(PATCH|POST|PUT|DELETE)'/.test(srcText));
  // And behaviourally: run every command and every alert path, record every request.
  const deps = makeDeps(DATA, VIEW);
  for (const [n, o] of [['status'], ['week'], ['proposals'], ['pr'], ['log', [{ name: 'agent', value: 'delta' }]],
    ['compare', [{ name: 'session', value: 'a' }, { name: 'scope', value: 'session' }]], ['chart', [{ name: 'exercise', value: 'Barbell Bench Press' }]]]) {
    await run(cmd(n, o), deps);
  }
  const env = makeEnv();
  await app.runAlerts(env, deps);
  const nonDiscordWrites = deps.calls.filter((c) => c.method !== 'GET' && !c.url.startsWith('https://discord.com/'));
  ok('across every command and the alert run, the only non-GET requests go to Discord', nonDiscordWrites.length === 0, JSON.stringify(nonDiscordWrites.map((c) => c.method + ' ' + c.url)));
  ok('every GitHub request carried the token', deps.calls.filter((c) => c.url.includes('github')).every((c) => c.init.headers.Authorization === 'Bearer tok'));
}

/* ---------- deferral ---------- */
console.log('=== DEFERRED REPLIES ===');
{
  const deps = makeDeps(DATA, VIEW);
  app._resetCache();
  const waits = [];
  const res = await app.handleRequest(await signed(cmd('status')), makeEnv(), { waitUntil: (p) => waits.push(p) }, deps);
  ok('a command answers type 5 immediately', (await res.clone().json()).type === 5);
  ok('...before touching GitHub', deps.calls.length === 0 || !deps.calls.some((c) => c.url.includes('github')) || waits.length === 1);
  await Promise.all(waits);
  const edit = discordCalls(deps)[0];
  ok('the real answer edits @original', edit && edit.method === 'PATCH' && edit.url.endsWith('/webhooks/app1/itok/messages/@original'), edit && edit.url);
  ok('mentions are disabled on replies', payloadOf(edit).allowed_mentions && payloadOf(edit).allowed_mentions.parse.length === 0);

  const failing = { ...makeDeps(DATA, VIEW) };
  failing.fetch = async (url, init) => { failing.calls.push({ url, method: (init && init.method) || 'GET', init }); if (url.includes('github')) return new Response('bad', { status: 401 }); return new Response('{}', { status: 200 }); };
  await run(cmd('status'), failing);
  const errEdit = discordCalls(failing)[0];
  ok('a GitHub failure is reported in the reply, not swallowed', errEdit && /GIST_TOKEN/.test(payloadOf(errEdit).content), errEdit && payloadOf(errEdit).content);
}

/* ---------- commands ---------- */
console.log('=== COMMAND OUTPUT ===');
{
  const st = core.statusMessage(VIEW, DATA, NOW).embeds[0];
  const f = (n) => (st.fields.find((x) => x.name === n) || {}).value || '';
  ok('status: readiness from the snapshot', /HIGH · 72% \(WHOOP\)/.test(f('Recovery')), f('Recovery'));
  ok('status: streak', f('Streak') === '4 days');
  ok('status: today uses the day name', f('Today') === 'D2 Push', f('Today'));
  ok('status: upcoming lists rest days as Rest', /09-12` Rest/.test(f('Next up')), f('Next up'));
  ok('status: brief shown only when dated the snapshot day', /Recovery high/.test(f('Daily brief')));
  const stale = core.statusMessage({ ...VIEW, generatedAt: NOW - 20 * 3600000 }, DATA, NOW).embeds[0];
  ok('status: a >12h-old snapshot says stale', /stale/.test(stale.description) && !/stale/.test(st.description));
  const yesterdayBrief = core.statusMessage(VIEW, { ...DATA, agents: { ...DATA.agents, brief: { text: 'old', date: '2026-09-09' } } }, NOW).embeds[0];
  ok('status: yesterday\'s brief is not shown as today\'s', !yesterdayBrief.fields.some((x) => x.name === 'Daily brief'));
  ok('status: no snapshot yet says so', /open the app/.test(core.statusMessage(null, DATA, NOW).embeds[0].description));

  const wk = core.weekMessage(VIEW, NOW).embeds[0].description;
  ok('week: status squares follow the snapshot', /🟩 `Chest\s+12 sets/.test(wk) && /🟥 `Hamstrings\s+3.5 sets/.test(wk), wk);

  const pr = core.proposalsMessage(DATA);
  ok('proposals: only pending', pr.embeds.length === 1 && /Progress bench/.test(pr.embeds[0].title));
  ok('proposals: footer says approve in the app', /approve or reject in the app/.test(pr.embeds[0].footer.text));
  ok('proposals: @everyone in model text is defused', !/@everyone/.test(pr.embeds[0].description), pr.embeds[0].description);

  const prs = core.prMessage(DATA, 10).embeds[0].description.split('\n');
  ok('pr: newest first', /2026-09-01/.test(prs[0]) && /2026-07-10/.test(prs[1]), prs.join(' / '));

  const logs = core.logMessages(DATA, 'DELTA', 5);
  // Parts are split at whitespace, so rejoin with a space to read the entry back.
  const allText = logs.flatMap((m) => m.embeds).map((e) => e.description).join(' ');
  ok('log: filters to the agent', !/ECHO note/.test(allText) && /Short DELTA note/.test(allText));
  ok('log: a long entry is NOT trimmed -- every word survives', (allText.match(/Paragraph of DELTA reasoning\./g) || []).length === 300);
  ok('log: every embed within 4096', logs.flatMap((m) => m.embeds).every((e) => e.description.length <= 4096));
  ok('log: every message within the 6000 total and 10 embeds',
    logs.every((m) => m.embeds.length <= 10 && m.embeds.reduce((s, e) => s + (e.title || '').length + e.description.length + ((e.footer && e.footer.text) || '').length, 0) <= 6000));
  ok('log: long entry split into numbered parts', logs.flatMap((m) => m.embeds).some((e) => e.footer && /part 1\/\d/.test(e.footer.text)));

  // Via the handler: a multi-message log edits @original then POSTs follow-ups.
  const huge = { ...DATA, agents: { ...DATA.agents, log: Array.from({ length: 6 }, (_, i) => ({ agent: 'zulu', text: ('Z' + i + ' words ').repeat(700), at: '2026-09-10T02:00:00Z' })) } };
  const dl = makeDeps(huge, VIEW);
  await run(cmd('log', [{ name: 'agent', value: 'zulu' }, { name: 'count', value: 6 }]), dl);
  const dc = discordCalls(dl);
  ok('log: overflow goes out as follow-up messages', dc.length > 1 && dc[0].method === 'PATCH' && dc.slice(1).every((c) => c.method === 'POST' && c.url.endsWith('/webhooks/app1/itok')), dc.map((c) => c.method).join(','));
}

/* ---------- compare ---------- */
console.log('=== COMPARE ===');
{
  const then = core.findSession(DATA, 'a');
  const whole = core.compareSessions(DATA, then, 'session');
  ok('compare/session: against the most recent SAME-DAY session by date, not array order', whole.now.id === 'c', whole.now && whole.now.id);
  ok('compare/session: not against a newer session on a different day', whole.now.day === 'D2');
  const bench = whole.rows.find((r) => r.name === 'Barbell Bench Press');
  ok('compare/session: best set by e1RM, not heaviest weight or first set', bench.then.best.w === 145 && bench.then.best.r === 12 && bench.now.best.w === 175 && bench.now.best.r === 5,
    JSON.stringify(bench));
  ok('compare/session: volume is sum of w×r', bench.then.vol === 155 * 8 + 155 * 7 + 145 * 12 && bench.now.vol === 180 * 1 + 175 * 5 + 170 * 6);
  ok('compare/session: exercises on only one side are kept', whole.rows.some((r) => r.name === 'Cable Fly' && !r.now) && whole.rows.some((r) => r.name === 'Dips' && !r.then));

  const ex = core.compareSessions(DATA, then, 'exercise', 'Barbell Bench Press');
  ok('compare/exercise: against the most recent session with that lift on ANY day', ex.now.id === 'd', ex.now && ex.now.id);
  const latest = core.compareSessions(DATA, core.findSession(DATA, 'c'), 'session');
  ok('compare: picking the newest session compares against the one before it', latest.now.id === 'b', latest.now && latest.now.id);
  ok('compare/exercise: a lift missing from the picked session is an error', !!core.compareSessions(DATA, then, 'exercise', 'Dips').error);
  const msg = core.compareMessage(VIEW, whole).embeds[0];
  const bf = msg.fields.find((x) => x.name === 'Barbell Bench Press').value;
  const e1 = (w, r) => w * (1 + r / 30);
  ok('compare: message shows the e1RM delta', bf.includes('e1RM +' + Math.round((e1(175, 5) - e1(145, 12)) * 10) / 10), bf);
  ok('compare: message says how far apart', /91 days apart/.test(msg.description), msg.description);

  const ch = core.sessionChoices(DATA, VIEW, '');
  ok('autocomplete: sessions newest first', ch[0].value === 'd' && ch[ch.length - 1].value === 'a', ch.map((c) => c.value).join(','));
  ok('autocomplete: label has date and day name', ch[0].name.startsWith('2026-09-05 · D4 Upper'), ch[0].name);
  ok('autocomplete: filters by typed day key', core.sessionChoices(DATA, VIEW, 'd2').every((c) => /D2/.test(c.name)) && core.sessionChoices(DATA, VIEW, 'd2').length === 3);
  ok('autocomplete: filters by typed month', core.sessionChoices(DATA, VIEW, '2026-06').map((c) => c.value).join() === 'a');
  const many = { logs: Array.from({ length: 60 }, (_, i) => ({ date: '2026-01-' + String(1 + (i % 28)).padStart(2, '0'), day: 'D1', entries: [] })) };
  ok('autocomplete: capped at 25 choices', core.sessionChoices(many, VIEW, '').length === 25);
  const idless = core.sessionChoices(many, VIEW, '')[0].value;
  ok('autocomplete: id-less logs still resolve back to a session', !!core.findSession(many, idless));

  // Through the handler, including autocomplete narrowing exercise choices to the picked session.
  const deps = makeDeps(DATA, VIEW);
  const acRes = await run(JSON.stringify({ type: 4, member: { user: { id: OWNER } }, data: { name: 'ironhub', options: [{ type: 1, name: 'compare', options: [
    { name: 'session', value: 'a' }, { name: 'scope', value: 'exercise' }, { name: 'exercise', value: '', focused: true }] }] } }), deps);
  const acj = await acRes.json();
  ok('autocomplete (handler): exercise choices come from the picked session', acj.type === 8 && acj.data.choices.map((c) => c.value).join() === 'Barbell Bench Press,Cable Fly', JSON.stringify(acj));
  await run(cmd('compare', [{ name: 'session', value: 'a' }, { name: 'scope', value: 'exercise' }]), deps);
  ok('compare (handler): exercise scope without an exercise explains itself', /needs the `exercise`/.test(payloadOf(discordCalls(deps).pop()).content));
}

/* ---------- chart ---------- */
console.log('=== CHART ===');
{
  const deps = makeDeps(DATA, VIEW);
  await run(cmd('chart', [{ name: 'exercise', value: 'Barbell Bench Press' }]), deps);
  const c = discordCalls(deps)[0];
  ok('chart: sent as multipart with the PNG attached', c && typeof c.init.body !== 'string' && c.init.body.get('files[0]') && c.init.body.get('files[0]').size === 4);
  const p = payloadOf(c);
  ok('chart: embed points at the attachment', p.embeds[0].image.url === 'attachment://chart.png' && p.attachments[0].filename === 'chart.png');
  ok('chart: the SVG plots the snapshot series', /204\.2 lb/.test(deps.svg) && (deps.svg.match(/<circle/g) || []).length === 3, deps.svg.slice(0, 200));
  ok('chart: best point highlighted', (deps.svg.match(/r="6"/g) || []).length === 1);
  // VIEW has a 5-week gap between its 2nd and 3rd points: spaced by date, the middle point sits well left of centre.
  const cx = [...deps.svg.matchAll(/<circle cx="([\d.]+)"/g)].map((m) => +m[1]);
  ok('chart: points are spaced by date, so a gap in training shows as a gap', cx.length === 3 && (cx[1] - cx[0]) < (cx[2] - cx[1]) * 0.7, cx.join(','));
  ok('chart: subtitle says how many weeks were actually logged', /3 of 14 weeks logged/.test(deps.svg));
  const d2 = makeDeps(DATA, VIEW);
  await run(cmd('chart', [{ name: 'exercise', value: 'Trap Bar Deadlift' }]), d2);
  const miss = discordCalls(d2)[0];
  ok('chart: unknown lift gets a message, not a render', typeof miss.init.body === 'string' && /No chart data/.test(payloadOf(miss).content) && !d2.svg);
  const d3 = makeDeps(DATA, null);
  await run(cmd('chart', [{ name: 'exercise', value: 'Barbell Bench Press' }]), d3);
  ok('chart: a gist without a snapshot (older build) degrades to a message', /No chart data/.test(payloadOf(discordCalls(d3)[0]).content));
  const svg1 = chartSVG('X & <Y>', [['2026-01-05', 100]]);
  ok('chart: single point and XML-hostile names do not break the SVG', /X &amp; &lt;Y&gt;/.test(svg1) && !/NaN/.test(svg1));

  // The real renderer, when the WASM is installed.
  try {
    const { initWasm, Resvg } = await import('@resvg/resvg-wasm');
    await initWasm(fs.readFileSync(path.join(here, 'node_modules/@resvg/resvg-wasm/index_bg.wasm')));
    const png = new Resvg(chartSVG('Barbell Bench Press', VIEW.charts['Barbell Bench Press']), { fitTo: { mode: 'width', value: 900 } }).render().asPng();
    ok('chart: resvg turns the SVG into a real PNG', png[0] === 0x89 && png[1] === 0x50 && png[2] === 0x4e && png[3] === 0x47 && png.length > 2000, png.length);
  } catch (e) {
    ok('chart: resvg available (run npm install in discord/)', false, e.message);
  }
}

/* ---------- alerts ---------- */
console.log('=== ALERTS ===');
{
  const env = makeEnv();
  const deps = makeDeps(DATA, VIEW);
  const first = await app.runAlerts(env, deps);
  ok('alerts: first run posts nothing', first.posted === 0 && discordCalls(deps).length === 0);
  ok('alerts: ...but records the watermark', !!env.ALERTS._m.get('alerts:seen:v1'));

  let puts = 0; const realPut = env.ALERTS.put; env.ALERTS.put = async (k, v) => { puts++; return realPut.call(env.ALERTS, k, v); };
  const quiet = await app.runAlerts(env, makeDeps(DATA, VIEW));
  ok('alerts: nothing new -> no post and no KV write', quiet.posted === 0 && puts === 0);

  const next = JSON.parse(JSON.stringify(DATA));
  next.prHistory.push({ exercise: 'Barbell Back Squat', weight: 225, reps: 5, e1rm: 262.5, prev: 255, gain: 7.5, date: '2026-09-11', t: 3 });
  next.invest.flags.push({ id: 'f2', status: 'active', severity: 'red', title: 'Bodyweight dropping', findings: ['-1 lb/wk'] });
  next.agents.proposals.unshift({ id: 'p2', agent: 'echo', title: 'Set calories to 3200', status: 'pending' });
  next.agents.brief = { text: 'Legs today.', date: '2026-09-11' };
  const d2 = makeDeps(next, VIEW);
  const r2 = await app.runAlerts(env, d2);
  const posts = discordCalls(d2);
  const text = posts.map((c) => JSON.stringify(payloadOf(c))).join('');
  ok('alerts: new items post to the webhook with wait=true', posts.length === 1 && posts[0].method === 'POST' && posts[0].url === 'https://discord.com/api/webhooks/1/abc?wait=true', posts.map((c) => c.url).join());
  ok('alerts: the new PR is posted and the old one is not', /Barbell Back Squat/.test(text) && !/198/.test(text), text.slice(0, 300));
  ok('alerts: the new flag is posted', /WARNING · Bodyweight dropping/.test(text));
  ok('alerts: the pre-existing flag is not re-posted', !/Bench stalling/.test(text));
  ok('alerts: new proposal summarised, pre-existing one not', /Set calories to 3200/.test(text) && !/Progress bench/.test(text));
  ok('alerts: the new brief is posted', /Daily brief · 2026-09-11/.test(text) && /Legs today/.test(text));
  ok('alerts: mentions disabled on the webhook', payloadOf(posts[0]).allowed_mentions.parse.length === 0);

  const again = makeDeps(next, VIEW);
  await app.runAlerts(env, again);
  ok('alerts: the same items never post twice', discordCalls(again).length === 0);

  // A failed post must not mark items as delivered.
  const next2 = JSON.parse(JSON.stringify(next));
  next2.prHistory.push({ exercise: 'Barbell Bench Press', weight: 180, reps: 5, e1rm: 210, gain: 5.8, date: '2026-09-12', t: 4 });
  await app.runAlerts(env, makeDeps(next2, VIEW, { discordFail: true })).catch(() => {});
  const retry = makeDeps(next2, VIEW);
  await app.runAlerts(env, retry);
  ok('alerts: a PR whose post failed is retried next tick', discordCalls(retry).length === 1 && /210/.test(JSON.stringify(payloadOf(discordCalls(retry)[0]))));

  const noHook = await app.runAlerts(makeEnv({ DISCORD_WEBHOOK_URL: '' }), makeDeps(DATA, VIEW));
  ok('alerts: no webhook configured is a clean no-op', noHook.posted === 0 && noHook.skipped);

  // Alerts must read fresh, not from the 60s command cache.
  const env3 = makeEnv(); const d5 = makeDeps(DATA, VIEW);
  await app.runAlerts(env3, d5); await app.runAlerts(env3, d5);
  ok('alerts: every run re-reads the gist', d5.calls.filter((c) => c.url.includes('api.github.com/gists')).length === 2);
}

/* ---------- truncated gist files ---------- */
console.log('=== TRUNCATED GIST FILES ===');
{
  const deps = makeDeps(DATA, VIEW);
  deps.fetch = async (url, init) => {
    deps.calls.push({ url, method: (init && init.method) || 'GET', init });
    if (url === 'https://api.github.com/gists/g1') return new Response(JSON.stringify({ files: {
      'ironhub_data.json': { truncated: true, content: '{"app":"ironh', raw_url: 'https://gist.githubusercontent.com/raw/data' },
      'discord_view.json': { content: JSON.stringify(VIEW) } } }), { status: 200 });
    if (url === 'https://gist.githubusercontent.com/raw/data') return new Response(JSON.stringify({ app: 'ironhub', data: DATA }), { status: 200 });
    return new Response('{}', { status: 200 });
  };
  app._resetCache();
  const g = await app.loadGist(makeEnv(), deps);
  ok('a truncated data file is read in full from raw_url', g.data.logs.length === 4);
}

/* ---------- misc ---------- */
console.log('=== TEXT HELPERS ===');
{
  const parts = core.splitText('aaaa\n\nbbbb cccc dddd', 10);
  ok('splitText: prefers paragraph breaks', parts[0] === 'aaaa' && parts.join(' ').replace(/\s+/g, ' ') === 'aaaa bbbb cccc dddd', JSON.stringify(parts));
  ok('splitText: hard-cuts an unbroken run without losing characters', core.splitText('x'.repeat(25), 10).join('') === 'x'.repeat(25));
  ok('safe: defuses user mentions', core.safe('<@123>') !== '<@123>');
}

console.log('\nRESULT: ' + pass + ' passed, ' + fail + ' failed');
process.exit(fail ? 1 : 0);
