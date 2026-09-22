/* Iron Hub × Discord — pure logic. No network, no Worker APIs, so the whole thing is testable
   in plain Node (see ../test_worker.js).

   HARD BOUNDARY: everything in here READS. Discord can look at Iron Hub, never change it.
   There is no function in this file that produces a write to the gist, and there must never be
   one -- approving a proposal, or anything else that mutates training data, happens in the app. */

export const COLORS = { amber: 0xF6862F, cyan: 0x46CDBA, violet: 0xB79BFF, zulu: 0xDFAE36, red: 0xE5534B, dim: 0x39424E };
export const AGENT_META = {
  zulu: { name: 'ZULU', color: COLORS.zulu },
  charlie: { name: 'CHARLIE', color: COLORS.cyan },
  delta: { name: 'DELTA', color: COLORS.amber },
  echo: { name: 'ECHO', color: COLORS.violet },
};
// Discord's limits. https://discord.com/developers/docs/resources/message#embed-object-embed-limits
export const LIM = { desc: 4096, title: 256, fieldName: 256, fieldValue: 1024, embedTotal: 6000, embedsPerMsg: 10, choice: 100, choices: 25, content: 2000 };

export function clip(s, n) {
  s = String(s == null ? '' : s);
  return s.length <= n ? s : s.slice(0, Math.max(0, n - 1)) + '…';
}
/* Model- and user-written text goes into markdown. Neutralise mentions and code fences so a
   log line cannot ping @everyone or break the message layout. allowed_mentions is also set on
   every message; this is the second line. */
export function safe(s) {
  return String(s == null ? '' : s).replace(/@(everyone|here)/g, '@​$1').replace(/<@/g, '<@​').replace(/```/g, '`​``');
}
const unix = (ms) => Math.floor(ms / 1000);

/* ---------- data access ---------- */
export function logsOf(data) { return Array.isArray(data && data.logs) ? data.logs : []; }
function sortedLogs(data) {
  return logsOf(data).map((l, i) => ({ l, i })).sort((a, b) => (b.l.date || '').localeCompare(a.l.date || '') || b.i - a.i).map((x) => x.l);
}
export function logKey(l, idx) { return String(l.id || (l.date + '#' + idx)); }
export function epley(w, r) { return r <= 1 ? w : w * (1 + r / 30); }
function dayLabel(view, dk) {
  if (!dk) return '';
  if (dk === 'REST') return 'Rest';
  const n = view && view.days && view.days[dk];
  return n ? dk + ' ' + n : dk;
}
function snapshotNote(view, nowMs) {
  if (!view || !view.generatedAt) return 'No snapshot yet — open the app once so it can sync one.';
  const hrs = (nowMs - view.generatedAt) / 3600000;
  const base = 'Snapshot <t:' + unix(view.generatedAt) + ':R>';
  return hrs > 12 ? base + ' — stale; open the app to refresh it.' : base;
}

/* ---------- /ironhub status ---------- */
export function statusMessage(view, data, nowMs) {
  const st = view && view.status;
  if (!st) return { embeds: [{ title: 'Iron Hub — status', description: snapshotNote(view, nowMs), color: COLORS.dim }] };
  const rd = st.readiness;
  const fields = [];
  fields.push({ name: 'Recovery', value: rd ? rd.label.toUpperCase() + ' · ' + rd.pct + '%' + ' (' + rd.source + ')' : 'not logged today', inline: true });
  fields.push({ name: 'Streak', value: st.streak > 0 ? st.streak + ' days' : '—', inline: true });
  const t = st.today || {};
  fields.push({ name: 'Today', value: t.rest ? 'Rest day' : (dayLabel(view, t.dayKey) + (t.logged ? ' · ✅ logged' : '')), inline: true });
  if (Array.isArray(st.upcoming) && st.upcoming.length) {
    fields.push({ name: 'Next up', value: clip(st.upcoming.map((u) => '`' + u.date.slice(5) + '` ' + (u.day === 'REST' ? 'Rest' : dayLabel(view, u.day))).join('\n'), LIM.fieldValue) });
  }
  if (st.pending) fields.push({ name: 'Waiting on you', value: st.pending + ' proposal' + (st.pending === 1 ? '' : 's') + ' — approve in the app', inline: false });
  const brief = data && data.agents && data.agents.brief;
  if (brief && brief.text && view.date && brief.date === view.date) {
    fields.push({ name: 'Daily brief', value: clip(safe(brief.text), LIM.fieldValue) });
  }
  const color = !rd ? COLORS.dim : rd.tone === 'good' ? COLORS.cyan : rd.tone === 'low' ? COLORS.red : COLORS.amber;
  return { embeds: [{ title: 'Iron Hub — status', color, fields, footer: { text: 'build ' + (view.build || '?') }, description: snapshotNote(view, nowMs) }] };
}

/* ---------- /ironhub week ---------- */
const STATUS_SQ = { green: '🟩', yellow: '🟨', red: '🟥', off: '⬛' };
export function weekMessage(view, nowMs) {
  const wk = view && view.week;
  if (!wk || !Array.isArray(wk.groups)) return { embeds: [{ title: 'Weekly volume', description: snapshotNote(view, nowMs), color: COLORS.dim }] };
  const pad = Math.max(...wk.groups.map((g) => g.group.length));
  const fmt = (n) => (Math.round(n * 10) / 10).toString();
  const lines = wk.groups.map((g) => (STATUS_SQ[g.status] || '⬛') + ' `' + g.group.padEnd(pad) + ' ' + fmt(g.sets).padStart(4) + ' sets  last wk ' + fmt(g.lastSets).padStart(4) + '`');
  return { embeds: [{
    title: 'Weekly volume — week of ' + wk.start,
    color: COLORS.amber,
    description: lines.join('\n') + '\n\n🟩 10+ sets · 🟨 6–9 · 🟥 under 6 · ⬛ none\nLast week: ' + wk.lastStart + ' → ' + wk.lastEnd + '\n' + snapshotNote(view, nowMs),
  }] };
}

/* ---------- /ironhub proposals ---------- */
export function proposalsMessage(data) {
  const props = ((data && data.agents && data.agents.proposals) || []).filter((p) => p && p.status === 'pending');
  if (!props.length) return { embeds: [{ title: 'Proposals', description: 'Nothing waiting on you.', color: COLORS.dim }] };
  const embeds = props.slice(0, LIM.embedsPerMsg).map((p) => {
    const m = AGENT_META[p.agent] || { name: String(p.agent || '?').toUpperCase(), color: COLORS.dim };
    return {
      title: clip(m.name + ' · ' + safe(p.title), LIM.title),
      description: clip(safe(p.reasoning || ''), 1500),
      color: m.color,
      footer: { text: 'Proposed ' + (p.created || '?') + ' · expires ' + (p.expires || '?') + ' · approve or reject in the app' },
    };
  });
  return fitEmbeds(embeds, props.length > embeds.length ? '+' + (props.length - embeds.length) + ' more in the app' : '');
}

/* ---------- /ironhub pr ---------- */
export function prMessage(data, count) {
  const n = Math.max(1, Math.min(25, count || 10));
  const prs = ((data && data.prHistory) || []).slice().sort((a, b) => (b.date || '').localeCompare(a.date || '') || (b.t || 0) - (a.t || 0)).slice(0, n);
  if (!prs.length) return { embeds: [{ title: 'PR history', description: 'No PRs recorded yet.', color: COLORS.dim }] };
  const lines = prs.map((p) => '`' + p.date + '` **' + safe(p.exercise) + '** ' + p.weight + '×' + p.reps + ' → e1RM ' + p.e1rm + (p.gain ? ' (+' + p.gain + ')' : ''));
  return { embeds: [{ title: 'Recent PRs', color: COLORS.cyan, description: clip(lines.join('\n'), LIM.desc) }] };
}

/* ---------- /ironhub log ---------- */
export function logMessages(data, agent, count) {
  const id = String(agent || '').toLowerCase();
  const meta = AGENT_META[id];
  if (!meta) return [{ content: 'Unknown agent.' }];
  const n = Math.max(1, Math.min(20, count || 5));
  const entries = ((data && data.agents && data.agents.log) || []).filter((e) => e && e.agent === id).slice(0, n);
  if (!entries.length) return [{ embeds: [{ title: meta.name + ' — log', description: 'No entries.', color: meta.color }] }];
  // Full text, never trimmed: an entry longer than one embed is split across several.
  const embeds = [];
  entries.forEach((e) => {
    const parts = splitText(safe(e.text), 4000);
    parts.forEach((part, i) => {
      const ts = Date.parse(e.at);
      embeds.push({
        title: i === 0 ? meta.name + (isNaN(ts) ? '' : '') : undefined,
        description: (i === 0 && !isNaN(ts) ? '<t:' + unix(ts) + ':f>\n' : '') + part,
        color: meta.color,
        footer: parts.length > 1 ? { text: 'part ' + (i + 1) + '/' + parts.length } : undefined,
      });
    });
  });
  return packEmbeds(embeds);
}

/* Split on paragraph, then line, then word boundaries; hard-cut only as a last resort. */
export function splitText(text, max) {
  const out = [];
  let rest = String(text || '');
  while (rest.length > max) {
    let cut = rest.lastIndexOf('\n\n', max);
    if (cut < max * 0.5) cut = rest.lastIndexOf('\n', max);
    if (cut < max * 0.5) cut = rest.lastIndexOf(' ', max);
    if (cut < max * 0.5) cut = max;
    out.push(rest.slice(0, cut).trimEnd());
    rest = rest.slice(cut).replace(/^\s+/, '');
  }
  if (rest.length || !out.length) out.push(rest);
  return out;
}
function embedSize(e) {
  return (e.title || '').length + (e.description || '').length + ((e.footer && e.footer.text) || '').length +
    (e.fields || []).reduce((s, f) => s + f.name.length + f.value.length, 0);
}
/* Group embeds into messages that respect both the 10-embed and 6000-char per-message caps. */
export function packEmbeds(embeds) {
  const msgs = [];
  let cur = [], size = 0;
  embeds.forEach((e) => {
    const s = embedSize(e);
    if (cur.length && (cur.length >= LIM.embedsPerMsg || size + s > LIM.embedTotal - 100)) { msgs.push({ embeds: cur }); cur = []; size = 0; }
    cur.push(e); size += s;
  });
  if (cur.length) msgs.push({ embeds: cur });
  return msgs;
}
function fitEmbeds(embeds, content) {
  const msgs = packEmbeds(embeds);
  if (content) msgs[msgs.length - 1].content = content;
  return msgs.length === 1 ? msgs[0] : msgs;
}

/* ---------- /ironhub compare ---------- */
function bestSet(sets) {
  let best = null;
  (sets || []).forEach((s) => { const v = epley(+s.w || 0, +s.r || 0); if (!best || v > best.e1) best = { w: +s.w || 0, r: +s.r || 0, e1: v }; });
  return best;
}
function volume(sets) { return (sets || []).reduce((t, s) => t + (+s.w || 0) * (+s.r || 0), 0); }
function sessionChoiceName(view, l) {
  const ex = (l.entries || []).length;
  return clip(l.date + ' · ' + dayLabel(view, l.day) + ' · ' + ex + ' exercise' + (ex === 1 ? '' : 's') + (l.deload ? ' · deload' : ''), LIM.choice);
}
export function sessionChoices(data, view, typed) {
  const q = String(typed || '').toLowerCase().trim();
  const all = logsOf(data);
  return sortedLogs(data)
    .map((l) => ({ name: sessionChoiceName(view, l), value: clip(logKey(l, all.indexOf(l)), LIM.choice) }))
    .filter((c) => !q || c.name.toLowerCase().includes(q))
    .slice(0, LIM.choices);
}
export function exerciseChoices(names, typed) {
  const q = String(typed || '').toLowerCase().trim();
  return names.filter((n) => !q || n.toLowerCase().includes(q)).slice(0, LIM.choices).map((n) => ({ name: clip(n, LIM.choice), value: clip(n, LIM.choice) }));
}
export function loggedExerciseNames(data) {
  const seen = new Map();
  sortedLogs(data).forEach((l) => (l.entries || []).forEach((e) => { if (e && e.exercise && !seen.has(e.exercise)) seen.set(e.exercise, 1); }));
  return [...seen.keys()];
}
export function findSession(data, key) {
  const all = logsOf(data);
  const i = all.findIndex((l, idx) => logKey(l, idx) === key);
  return i >= 0 ? all[i] : null;
}
/* Whole session: against the most recent OTHER session on the same split day.
   One exercise: against the most recent OTHER session containing that exercise, on any day --
   an exercise moved between days is still the same lift. */
export function compareSessions(data, then, scope, exercise) {
  const others = sortedLogs(data).filter((l) => l !== then);
  if (scope === 'exercise') {
    const e0 = (then.entries || []).find((e) => e.exercise === exercise);
    if (!e0) return { error: '**' + safe(exercise) + '** was not logged on ' + then.date + '.' };
    const now = others.find((l) => (l.entries || []).some((e) => e.exercise === exercise));
    if (!now) return { error: 'No other session has **' + safe(exercise) + '** to compare against.' };
    return { then, now, rows: [row(exercise, e0, now.entries.find((e) => e.exercise === exercise))] };
  }
  const now = others.find((l) => l.day === then.day);
  if (!now) return { error: 'No other ' + (then.day || 'matching') + ' session to compare against.' };
  const names = [...new Set([...(then.entries || []), ...(now.entries || [])].map((e) => e.exercise))];
  return { then, now, rows: names.map((n) => row(n, (then.entries || []).find((e) => e.exercise === n), (now.entries || []).find((e) => e.exercise === n))) };
}
function row(name, a, b) {
  const side = (e) => e ? { sets: e.sets.length, best: bestSet(e.sets), vol: volume(e.sets) } : null;
  return { name, then: side(a), now: side(b) };
}
export function compareMessage(view, cmp) {
  if (cmp.error) return { content: cmp.error };
  const { then, now, rows } = cmp;
  const r1 = (n) => Math.round(n * 10) / 10;
  const delta = (a, b, unit) => { const d = r1(b - a); return (d > 0 ? '+' : '') + d + (unit || ''); };
  const fields = rows.slice(0, 25).map((r) => {
    const t = r.then, n = r.now;
    const fmt = (s) => s ? s.sets + '× · best ' + s.best.w + '×' + s.best.r + ' · vol ' + Math.round(s.vol) : '—';
    let v = 'then  ' + fmt(t) + '\nnow   ' + fmt(n);
    if (t && n) v += '\nΔ     e1RM ' + delta(t.best.e1, n.best.e1) + ' · vol ' + delta(t.vol, n.vol);
    else v += '\n' + (t ? 'not in the newer session' : 'new since then');
    return { name: clip(safe(r.name), LIM.fieldName), value: clip('```' + v + '```', LIM.fieldValue) };
  });
  const days = Math.round((Date.parse(now.date) - Date.parse(then.date)) / 86400000);
  return { embeds: [{
    title: clip('Compare · ' + then.date + ' → ' + now.date, LIM.title),
    description: dayLabel(view, then.day) + ' then · ' + dayLabel(view, now.day) + ' now · ' + Math.abs(days) + ' days apart' + (then.deload || now.deload ? '\n⚠️ one side is a deload session' : ''),
    color: COLORS.amber,
    fields,
  }] };
}

/* ---------- push alerts ---------- */
export function alertKeys(data) {
  const prs = ((data && data.prHistory) || []).map((p) => p.exercise + '|' + p.date + '|' + p.e1rm);
  const flags = (((data && data.invest) || {}).flags || []).filter((f) => f && f.status === 'active').map((f) => String(f.id));
  const proposals = ((data && data.agents && data.agents.proposals) || []).filter((p) => p && p.status === 'pending').map((p) => String(p.id));
  const brief = (data && data.agents && data.agents.brief && data.agents.brief.date) || '';
  // Keyed on `at`, not `week`: S.agents.letter is replaced in place, so a letter rewritten for
  // the same Sunday would be invisible under `week` and would never reach the channel.
  const letter = (data && data.agents && data.agents.letter && data.agents.letter.at) || '';
  return { prs, flags, proposals, brief, letter };
}
/* Each alert kind goes to its own Discord channel, and each channel owns the part of the
   watermark it is responsible for. That pairing is the point: with one shared watermark, a post
   that failed in #alerts would hold back #prs's record too, and the retry would post the PR a
   second time. The channel -> watermark-keys map lives here so the two cannot drift apart. */
export const ALERT_CHANNELS = {
  prs: { keys: ['prs'] },
  alerts: { keys: ['flags', 'proposals'] },
  brief: { keys: ['brief'] },
  // The weekly letter gets its own channel and its own watermark slice for the same reason as
  // the rest: sharing the brief's key would let a Sunday letter and that day's brief suppress
  // each other, since both would advance one scalar.
  letter: { keys: ['letter'] },
};
/* Returns {init, cur, channels:{prs:[msgs], alerts:[msgs], brief:[msgs]}}. `cur` is the full
   current key set; the caller adopts each channel's slice of it only once that channel's posts
   succeed. The FIRST run (no stored watermark) posts nothing, so months of history do not
   flood the channels on day one. */
export function diffAlerts(data, prevSeen) {
  const cur = alertKeys(data);
  const channels = { prs: [], alerts: [], brief: [], letter: [] };
  if (!prevSeen || !prevSeen.init) return { init: true, cur, channels };
  const had = (arr) => new Set(arr || []);
  const pSeen = had(prevSeen.prs), fSeen = had(prevSeen.flags), qSeen = had(prevSeen.proposals);

  const newPrs = (data.prHistory || []).filter((p) => !pSeen.has(p.exercise + '|' + p.date + '|' + p.e1rm));
  if (newPrs.length) {
    channels.prs = packEmbeds([{ title: '🏆 New PR' + (newPrs.length > 1 ? 's' : ''), color: COLORS.cyan,
      description: clip(newPrs.map((p) => '**' + safe(p.exercise) + '** ' + p.weight + '×' + p.reps + ' → e1RM ' + p.e1rm + (p.gain ? ' (+' + p.gain + ')' : '')).join('\n'), LIM.desc) }]);
  }
  const alertEmbeds = [];
  const newFlags = ((data.invest || {}).flags || []).filter((f) => f && f.status === 'active' && !fSeen.has(String(f.id)));
  const SEV = { yellow: 'ADVISORY', orange: 'WATCH', red: 'WARNING' };
  newFlags.forEach((f) => alertEmbeds.push({
    title: clip('🔎 ' + (SEV[f.severity] || 'FLAG') + ' · ' + safe(f.title), LIM.title),
    color: f.severity === 'red' ? COLORS.red : f.severity === 'orange' ? COLORS.amber : COLORS.zulu,
    description: clip((f.findings || []).map((x) => '• ' + safe(x)).join('\n'), 1500),
  }));
  const newProps = ((data.agents || {}).proposals || []).filter((p) => p && p.status === 'pending' && !qSeen.has(String(p.id)));
  if (newProps.length) {
    alertEmbeds.push({ title: '📋 ' + newProps.length + ' proposal' + (newProps.length > 1 ? 's' : '') + ' ready', color: COLORS.zulu,
      description: clip(newProps.map((p) => '**' + ((AGENT_META[p.agent] || {}).name || p.agent) + '** — ' + safe(p.title)).join('\n'), 3500) + '\n\nApprove or reject in the app.' });
  }
  if (alertEmbeds.length) channels.alerts = packEmbeds(alertEmbeds);
  const brief = data.agents && data.agents.brief;
  if (cur.brief && cur.brief !== prevSeen.brief && brief && brief.text) {
    channels.brief = packEmbeds(splitText(safe(brief.text), 4000).map((part, i) => ({ title: i === 0 ? '☀️ Daily brief · ' + brief.date : undefined, color: COLORS.zulu, description: part })));
  }
  const letter = data.agents && data.agents.letter;
  /* `undefined` means this deployment has never tracked the letter key at all -- the channel was
     added after the first run, so prevSeen.init is already true and the init guard above does not
     cover it. Posting here would fire off whatever letter happens to be sitting in state, quite
     possibly one from several Sundays ago. Adopt it silently instead; runAlerts() advances the
     watermark for a key it has never seen. Same reasoning as init, one level down. */
  if (prevSeen.letter !== undefined && cur.letter && cur.letter !== prevSeen.letter && letter && letter.text) {
    channels.letter = packEmbeds(splitText(safe(letter.text), 4000).map((part, i) => ({
      title: i === 0 ? '\u{1F4EC} Weekly letter' + (letter.week ? ' \u00b7 ' + letter.week : '') : undefined,
      color: COLORS.zulu, description: part })));
  }
  return { init: false, cur, channels };
}

/* ---------- chart data ---------- */
export function chartSeries(view, exercise) {
  const pts = view && view.charts && view.charts[exercise];
  return Array.isArray(pts) ? pts : null;
}
