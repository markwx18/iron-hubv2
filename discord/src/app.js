/* Iron Hub × Discord — request handling. Network access comes in through `deps` so the test
   suite can drive the real handlers with a fake fetch and a fake PNG renderer.

   READ-ONLY BY CONSTRUCTION: the only GitHub calls in this file are GETs. The only writes go
   to Discord (replies and the alert webhook) and to this Worker's own KV watermark. The test
   suite scans the source for anything else. */
import { verifyDiscordRequest } from './verify.js';
import * as core from './core.js';
import { chartSVG } from './chart.js';

const DISCORD_API = 'https://discord.com/api/v10';
const GIST_FILE = 'ironhub_data.json';
const VIEW_FILE = 'discord_view.json';
const NO_MENTIONS = { parse: [] };
const EPHEMERAL = 64;

/* ---------- gist (GET only) ---------- */
let gistCache = { at: 0, id: '', value: null };
export function _resetCache() { gistCache = { at: 0, id: '', value: null }; }
async function readFile(f, env, deps) {
  if (!f) return null;
  let content = f.content;
  if (f.truncated) {
    const r = await deps.fetch(f.raw_url, { method: 'GET', headers: ghHeaders(env) });
    if (!r.ok) throw new Error('GitHub raw read failed (' + r.status + ')');
    content = await r.text();
  }
  return JSON.parse(content);
}
function ghHeaders(env) {
  return { Authorization: 'Bearer ' + env.GIST_TOKEN, Accept: 'application/vnd.github+json', 'User-Agent': 'ironhub-discord' };
}
export async function loadGist(env, deps, maxAgeMs) {
  const now = deps.now();
  if (gistCache.value && gistCache.id === env.GIST_ID && now - gistCache.at < (maxAgeMs == null ? 60000 : maxAgeMs)) return gistCache.value;
  const r = await deps.fetch('https://api.github.com/gists/' + env.GIST_ID, { method: 'GET', headers: ghHeaders(env) });
  if (!r.ok) throw new Error('GitHub gist read failed (' + r.status + ')' + (r.status === 401 ? ' — GIST_TOKEN is invalid or expired' : ''));
  const g = await r.json();
  const files = g.files || {};
  const payload = await readFile(files[GIST_FILE], env, deps);
  if (!payload || payload.app !== 'ironhub') throw new Error('The gist has no Iron Hub data file.');
  let view = null;
  try { view = await readFile(files[VIEW_FILE], env, deps); } catch (e) { view = null; } // optional: older builds never wrote it
  const value = { data: payload.data || {}, exportedAt: payload.exportedAt || 0, view };
  gistCache = { at: now, id: env.GIST_ID, value };
  return value;
}

/* ---------- interactions ---------- */
const json = (obj, status) => new Response(JSON.stringify(obj), { status: status || 200, headers: { 'Content-Type': 'application/json' } });

export async function handleRequest(request, env, ctx, deps) {
  const url = new URL(request.url);
  if (request.method === 'GET' && url.pathname === '/') return new Response('Iron Hub Discord endpoint. Nothing to see here.', { status: 200 });
  if (request.method !== 'POST' || url.pathname !== '/interactions') return new Response('Not found', { status: 404 });

  const body = await request.text();
  const ok = await verifyDiscordRequest(env.DISCORD_PUBLIC_KEY, request.headers.get('X-Signature-Ed25519'), request.headers.get('X-Signature-Timestamp'), body);
  if (!ok) return new Response('Bad request signature', { status: 401 });

  let ix;
  try { ix = JSON.parse(body); } catch (e) { return new Response('Bad JSON', { status: 400 }); }
  if (ix.type === 1) return json({ type: 1 }); // PING, used by the portal to validate the URL

  const userId = (ix.member && ix.member.user && ix.member.user.id) || (ix.user && ix.user.id) || '';
  const owner = !!env.DISCORD_OWNER_ID && userId === String(env.DISCORD_OWNER_ID);

  if (ix.type === 4) { // autocomplete must answer inline, fast -- cached gist
    if (!owner) return json({ type: 8, data: { choices: [] } });
    try { return json({ type: 8, data: { choices: await autocomplete(ix, env, deps) } }); }
    catch (e) { return json({ type: 8, data: { choices: [] } }); }
  }
  if (ix.type !== 2) return new Response('Unsupported interaction', { status: 400 });

  if (!owner) {
    return json({ type: 4, data: { content: 'Iron Hub only answers its owner.', flags: EPHEMERAL, allowed_mentions: NO_MENTIONS } });
  }
  // Always defer: a GitHub read (and a PNG render) can exceed Discord's 3-second window.
  ctx.waitUntil(runCommand(ix, env, deps).catch((e) => editOriginal(ix, env, deps, { content: '⚠️ ' + core.clip(e.message, 1800) })));
  return json({ type: 5 });
}

function subcommand(ix) {
  const top = (ix.data && ix.data.options && ix.data.options[0]) || {};
  const opts = {};
  (top.options || []).forEach((o) => { opts[o.name] = o; });
  return { name: top.name, opts, focused: (top.options || []).find((o) => o.focused) };
}
const optVal = (opts, k) => (opts[k] ? opts[k].value : undefined);

async function autocomplete(ix, env, deps) {
  const { name, opts, focused } = subcommand(ix);
  if (!focused) return [];
  const g = await loadGist(env, deps);
  if (name === 'chart' && focused.name === 'exercise') return core.exerciseChoices(Object.keys((g.view && g.view.charts) || {}), focused.value);
  if (name === 'compare' && focused.name === 'session') return core.sessionChoices(g.data, g.view, focused.value);
  if (name === 'compare' && focused.name === 'exercise') {
    const s = optVal(opts, 'session') && core.findSession(g.data, optVal(opts, 'session'));
    const names = s ? (s.entries || []).map((e) => e.exercise) : core.loggedExerciseNames(g.data);
    return core.exerciseChoices(names, focused.value);
  }
  return [];
}

export async function runCommand(ix, env, deps) {
  const { name, opts } = subcommand(ix);
  const g = await loadGist(env, deps);
  const now = deps.now();
  let msgs;
  switch (name) {
    case 'status': msgs = core.statusMessage(g.view, g.data, now); break;
    case 'week': msgs = core.weekMessage(g.view, now); break;
    case 'proposals': msgs = core.proposalsMessage(g.data); break;
    case 'pr': msgs = core.prMessage(g.data, optVal(opts, 'count')); break;
    case 'log': msgs = core.logMessages(g.data, optVal(opts, 'agent'), optVal(opts, 'count')); break;
    case 'compare': {
      const then = core.findSession(g.data, String(optVal(opts, 'session') || ''));
      if (!then) { msgs = { content: 'Pick a session from the suggestions — that one is not in the log.' }; break; }
      const scope = optVal(opts, 'scope') === 'exercise' ? 'exercise' : 'session';
      if (scope === 'exercise' && !optVal(opts, 'exercise')) { msgs = { content: 'Scope "one exercise" needs the `exercise` option too.' }; break; }
      msgs = core.compareMessage(g.view, core.compareSessions(g.data, then, scope, optVal(opts, 'exercise')));
      break;
    }
    case 'chart': return chartCommand(ix, env, deps, g, String(optVal(opts, 'exercise') || ''));
    default: msgs = { content: 'Unknown command.' };
  }
  const list = Array.isArray(msgs) ? msgs : [msgs];
  await editOriginal(ix, env, deps, list[0]);
  for (const m of list.slice(1)) await followup(ix, env, deps, m);
}

async function chartCommand(ix, env, deps, g, exercise) {
  const pts = core.chartSeries(g.view, exercise);
  if (!pts || !pts.length) {
    return editOriginal(ix, env, deps, { content: 'No chart data for **' + core.safe(exercise) + '** in the snapshot. Pick one from the suggestions (lifts trained in the last ~6 months).' });
  }
  const png = await deps.renderPng(chartSVG(exercise, pts));
  const last = pts[pts.length - 1][1], first = pts[0][1];
  const embed = {
    title: core.clip(exercise, core.LIM.title), color: core.COLORS.amber,
    description: 'e1RM ' + first + ' → **' + last + '** lb · ' + pts[0][0] + ' to ' + pts[pts.length - 1][0] + ' (' + pts.length + ' weeks logged)',
    image: { url: 'attachment://chart.png' },
  };
  return editOriginal(ix, env, deps, { embeds: [embed] }, { name: 'chart.png', bytes: png });
}

/* ---------- Discord writes (replies only) ---------- */
async function discordSend(deps, method, url, payload, file) {
  const p = Object.assign({ allowed_mentions: NO_MENTIONS }, payload);
  let init;
  if (file) {
    const fd = new FormData();
    p.attachments = [{ id: 0, filename: file.name }];
    fd.append('payload_json', JSON.stringify(p));
    fd.append('files[0]', new Blob([file.bytes], { type: 'image/png' }), file.name);
    init = { method, body: fd };
  } else {
    init = { method, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(p) };
  }
  const r = await deps.fetch(url, init);
  if (!r.ok) throw new Error('Discord ' + method + ' failed (' + r.status + '): ' + core.clip(await r.text().catch(() => ''), 300));
  return r;
}
function editOriginal(ix, env, deps, payload, file) {
  return discordSend(deps, 'PATCH', DISCORD_API + '/webhooks/' + env.DISCORD_APP_ID + '/' + ix.token + '/messages/@original', payload, file);
}
function followup(ix, env, deps, payload) {
  return discordSend(deps, 'POST', DISCORD_API + '/webhooks/' + env.DISCORD_APP_ID + '/' + ix.token, payload);
}

/* ---------- scheduled alerts ---------- */
const SEEN_KEY = 'alerts:seen:v1';
export async function runAlerts(env, deps) {
  if (!env.DISCORD_WEBHOOK_URL) return { posted: 0, skipped: 'no webhook' };
  const g = await loadGist(env, deps, 0); // always fresh: a cached copy could delay an alert by a whole cycle
  const prev = await env.ALERTS.get(SEEN_KEY, 'json');
  const { seen, messages } = core.diffAlerts(g.data, prev);
  for (const m of messages) await discordSend(deps, 'POST', env.DISCORD_WEBHOOK_URL + (env.DISCORD_WEBHOOK_URL.includes('?') ? '&' : '?') + 'wait=true', m);
  // Stored only after every post succeeded, so a failed post is retried next tick rather than
  // silently marked as delivered. Written only when something changed: KV's free tier is
  // 1000 writes/day and a write every 5 minutes would spend a third of it on nothing.
  if (seen) await env.ALERTS.put(SEEN_KEY, JSON.stringify(seen));
  return { posted: messages.length, initialised: !!(seen && (!prev || !prev.init)) };
}
