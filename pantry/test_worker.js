/* Iron Hub pantry drop box -- Worker test suite.   node pantry/test_worker.js
   Drives the real handler with a fake KV. IRONHUB_PANTRY_SRC points it at a mutant copy of src/,
   the way IRONHUB_HTML does for the app. Nothing here depends on today's date. */
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const SRC = process.env.IRONHUB_PANTRY_SRC || path.join(here, 'src');
const W = await import(new URL('file:///' + path.join(SRC, 'worker.js').replace(/\\/g, '/')).href);

let pass = 0, fail = 0;
function ok(name, cond, extra) {
  if (cond) pass++;
  else { fail++; console.log('  FAIL: ' + name + (extra !== undefined ? ' -> ' + extra : '')); }
}

function fakeKV() {
  const m = new Map(), puts = [];
  return {
    m, puts,
    async get(k) { return m.has(k) ? m.get(k) : null; },
    async put(k, v, o) { puts.push({ k, v, o }); m.set(k, v); },
    async delete(k) { m.delete(k); },
  };
}
const NOW = Date.parse('2026-10-09T18:00:00Z');
const BOX = 'Ab3_kQ9-xYz01234567890';           // 22 chars
const ORIGIN = 'https://markwx18.github.io';
function req(method, p, body, headers) {
  const h = Object.assign({ Origin: ORIGIN }, headers || {});
  if (body !== undefined) h['Content-Type'] = 'text/plain';
  return new Request('https://ironhub-pantry.example.workers.dev' + p, { method, headers: h, body });
}
const drop = (id, extra) => Object.assign({ v: 1, k: 'r', id, from: 'Mom', at: '2026-10-09T17:00:00Z', f: [['eggs', 1], ['tuna', 0]] }, extra || {});
const run = (env, r) => W.handle(r, env, () => NOW);

/* ---------- the box ---------- */
{
  const env = { DROPS: fakeKV() };
  let r = await run(env, req('GET', '/box/' + BOX));
  ok('empty box: 204, no body', r.status === 204 && (await r.text()) === '');
  ok('CORS: his Pages origin is allowed', r.headers.get('Access-Control-Allow-Origin') === ORIGIN);

  r = await run(env, req('POST', '/box/' + BOX, JSON.stringify(drop('dropA_0123456789abcdef'))));
  ok('drop: accepted', r.status === 200 && (await r.json()).ok === true);
  ok('drop: stored under the box with a 30-day TTL', env.DROPS.puts.length === 1 && env.DROPS.puts[0].k === 'box:' + BOX && env.DROPS.puts[0].o && env.DROPS.puts[0].o.expirationTtl === 30 * 86400);

  r = await run(env, req('GET', '/box/' + BOX));
  const got = await r.json();
  ok('read back: the drop and when it arrived', r.status === 200 && got.drop.id === 'dropA_0123456789abcdef' && got.drop.from === 'Mom' && got.receivedAt === '2026-10-09T18:00:00.000Z');

  // A newer submission while he is reviewing the first one.
  await run(env, req('POST', '/box/' + BOX, JSON.stringify(drop('dropB_0123456789abcdef'))));
  r = await run(env, req('POST', '/box/' + BOX + '/clear?id=dropA_0123456789abcdef', ''));
  ok('clear with the old id: reports nothing cleared', (await r.json()).cleared === false);
  r = await run(env, req('GET', '/box/' + BOX));
  ok('clear with the old id: the newer drop is still there', r.status === 200 && (await r.json()).drop.id === 'dropB_0123456789abcdef');
  r = await run(env, req('POST', '/box/' + BOX + '/clear?id=dropB_0123456789abcdef', ''));
  ok('clear with its own id: cleared', (await r.json()).cleared === true);
  r = await run(env, req('GET', '/box/' + BOX));
  ok('after clear: empty again', r.status === 204);
  r = await run(env, req('POST', '/box/' + BOX + '/clear?id=..', ''));
  ok('clear: a malformed id is refused', r.status === 400);
}

/* ---------- what it refuses ---------- */
{
  const env = { DROPS: fakeKV() };
  const bad = async (name, r, status) => { const x = await run(env, r); ok(name, x.status === status, x.status); };
  await bad('box id too short', req('GET', '/box/abc'), 400);
  await bad('box id with odd characters', req('GET', '/box/' + BOX.slice(0, 21) + '.'), 400);
  await bad('unknown path', req('GET', '/'), 404);
  await bad('PUT is not a route', req('PUT', '/box/' + BOX, '{}'), 405);
  await bad('not JSON', req('POST', '/box/' + BOX, 'hello'), 400);
  await bad('wrong kind (his outgoing list, not a reply)', req('POST', '/box/' + BOX, JSON.stringify(drop('dropC_0123456789abcdef', { k: 'p' }))), 400);
  await bad('no drop id', req('POST', '/box/' + BOX, JSON.stringify(drop(undefined))), 400);
  await bad('empty list', req('POST', '/box/' + BOX, JSON.stringify(drop('dropD_0123456789abcdef', { f: [] }))), 400);
  await bad('an array, not an object', req('POST', '/box/' + BOX, '[1,2]'), 400);
  const big = drop('dropE_0123456789abcdef', { pad: 'x'.repeat(W.MAX_BODY) });
  await bad('oversized body', req('POST', '/box/' + BOX, JSON.stringify(big)), 413);
  ok('nothing refused was stored', env.DROPS.puts.length === 0, env.DROPS.puts.length);

  const r = await run(env, req('GET', '/box/' + BOX, undefined, { Origin: 'https://evil.example' }));
  ok('CORS: another origin gets no allow header', r.headers.get('Access-Control-Allow-Origin') === null);
}

/* ---------- the Pages entry point hands every /box/* request to the same handler ---------- */
{
  const fn = await import(new URL('file:///' + path.join(here, 'functions', 'box', '[[path]].js').replace(/\\/g, '/')).href);
  const env = { DROPS: fakeKV() };
  let r = await fn.onRequest({ request: req('POST', '/box/' + BOX, JSON.stringify(drop('dropP_0123456789abcdef'))), env });
  ok('pages: a drop through the Pages function is stored', r.status === 200 && env.DROPS.puts.length === 1 && env.DROPS.puts[0].o.expirationTtl === 30 * 86400);
  r = await fn.onRequest({ request: req('GET', '/box/' + BOX), env });
  ok('pages: and reads back', r.status === 200 && (await r.json()).drop.id === 'dropP_0123456789abcdef');
}

/* ---------- the source stays small and safe ---------- */
{
  const fs = await import('node:fs');
  const src = fs.readFileSync(path.join(SRC, 'worker.js'), 'utf8');
  ok('never logs a body', !/console\.(log|info|warn|error)\s*\(/.test(src));
  ok('never calls out anywhere', !/\bfetch\s*\(/.test(src.replace(/fetch\(request, env\)/, '')));
}

console.log('\n' + pass + ' passed, ' + fail + ' failed');
process.exit(fail ? 1 : 0);
