/* WHOOP -> Iron Hub relay.  Run by .github/workflows/whoop-sync.yml.
 *
 * Refreshes the WHOOP token, pulls today's recovery / sleep / strain, and writes a single
 * whoop_data.json into the app's existing sync gist. Zero dependencies -- plain Node fetch,
 * so there is nothing to install and nothing to keep up to date.
 *
 * This is not part of the app. iron_hub.html stays a single file with no build step; this
 * runs on GitHub's infrastructure on a schedule and the app only ever reads its output.
 *
 * test_agents.js require()s this file for the pure history helpers at the bottom, which is
 * why the not-configured exit and main() only run when it is executed directly.
 */
'use strict';

const WHOOP_TOKEN_URL = 'https://api.prod.whoop.com/oauth/oauth2/token';
const WHOOP_API = 'https://api.prod.whoop.com/developer/v2';
const GH_API = 'https://api.github.com';
const IS_MAIN = require.main === module;

/* Not-configured is a SKIP, not a failure. This job is on a 2-hourly schedule, so treating
 * missing secrets as an error would mean a red run and a notification email every two hours
 * from the moment the workflow lands until the one-time setup is done -- which trains you to
 * ignore exactly the notifications that matter once it IS configured. Exit 0 and say why. */
const REQUIRED = ['WHOOP_CLIENT_ID', 'WHOOP_CLIENT_SECRET', 'IRONHUB_GIST_ID',
                  'IRONHUB_GIST_TOKEN', 'IRONHUB_STATE_GIST_ID'];
const missing = REQUIRED.filter((k) => !process.env[k]);
if (IS_MAIN && missing.length) {
  console.log('WHOOP sync is not set up yet - missing: ' + missing.join(', ') + '.');
  console.log('See the setup notes at the top of .github/workflows/whoop-sync.yml.');
  console.log('Nothing to do; this is not a failure.');
  process.exit(0);
}

const CLIENT_ID = process.env.WHOOP_CLIENT_ID;
const CLIENT_SECRET = process.env.WHOOP_CLIENT_SECRET;
const GIST_ID = process.env.IRONHUB_GIST_ID;
const RAW_GIST_TOKEN = process.env.IRONHUB_GIST_TOKEN || '';
const GIST_TOKEN = RAW_GIST_TOKEN.trim();
/* Never prints the token. Length and prefix-shape are enough to separate the three causes that
   all surface as 401, and neither is a secret. */
function describeGistToken() {
  if (!GIST_TOKEN) return 'The IRONHUB_GIST_TOKEN secret is EMPTY or not set on this repository at all.';
  const bits = ['The secret holds ' + GIST_TOKEN.length + ' characters'];
  if (RAW_GIST_TOKEN !== GIST_TOKEN) {
    bits.push('and it had surrounding whitespace, which this run trimmed -- if that was the ' +
              'problem it is fixed now, but re-paste it without the stray newline');
  }
  if (!/^(ghp_|gho_|github_pat_)/.test(GIST_TOKEN)) {
    bits.push('and it does NOT start with ghp_ or github_pat_, so it may not be a token at all ' +
              '(a gist ID or the WHOOP token pasted into the wrong secret would look like this)');
  }
  return bits.join(', ') + '.';
}
const STATE_GIST_ID = process.env.IRONHUB_STATE_GIST_ID;
const STATE_FILE = 'whoop_token.json';

const ghHeaders = {
  Authorization: 'Bearer ' + GIST_TOKEN,
  Accept: 'application/vnd.github+json',
  'Content-Type': 'application/json',
};

async function ghGet(id) {
  const res = await fetch(GH_API + '/gists/' + id, { headers: ghHeaders });
  if (!res.ok) throw new Error('gist read failed (' + res.status + ')');
  return res.json();
}
async function ghPatch(id, files) {
  const res = await fetch(GH_API + '/gists/' + id, {
    method: 'PATCH', headers: ghHeaders, body: JSON.stringify({ files }),
  });
  if (!res.ok) throw new Error('gist write failed (' + res.status + '): ' + (await res.text()).slice(0, 200));
  return res.json();
}

/* The token store: {token, seedTried}. token is the refresh token a previous run rotated in, if
 * any. WHOOP issues a NEW refresh token every time you spend the old one, so the seeded secret is
 * only ever good for the first run -- after that the live one lives here. seedTried is a short
 * hash of the WHOOP_REFRESH_TOKEN value last sent to WHOOP (see spendRefresh()). */
async function readStore() {
  let g;
  try {
    g = await ghGet(STATE_GIST_ID);
  } catch (e) {
    /* Fatal, and said plainly. Falling back to WHOOP_REFRESH_TOKEN here is guaranteed to fail:
     * that seed was spent and rotated away on the first run this relay ever made. All the
     * fallback achieved was reporting a GitHub problem as a WHOOP one. */
    throw new Error(
      'cannot read the WHOOP token store (' + e.message + '). This is a GITHUB auth failure, ' +
      'not a missing token. ' + describeGistToken() + ' A 401 means the credential was rejected ' +
      'outright -- expired, revoked, or not a token; a merely under-scoped token would give 403 ' +
      'or 404 instead, so this is the VALUE, not the permissions. The token that Iron Hub itself ' +
      'uses for cloud sync is known to work on these gists: Settings > Cloud Sync > Show token ' +
      'copies it, and pasting that exact value into IRONHUB_GIST_TOKEN is the shortest fix. ' +
      'Nothing is lost meanwhile; the rotated WHOOP refresh token is still in the state gist and ' +
      'the next run picks it up as soon as this secret can read it again.');
  }
  const store = { token: null, seedTried: null };
  try {
    const f = g.files && g.files[STATE_FILE];
    if (f && f.content) {
      const p = JSON.parse(f.content);
      if (p && typeof p.refresh_token === 'string' && p.refresh_token) store.token = p.refresh_token;
      if (p && typeof p.seedTried === 'string') store.seedTried = p.seedTried;
    }
  } catch (e) {
    // A gist we CAN read that holds no usable token really is the first-run case, and the
    // seeded secret is exactly right for it.
    console.error('Stored token file unusable (' + e.message + ') -- falling back to the seed.');
  }
  return store;
}
async function storeToken(refreshToken, seedTried) {
  const rec = { refresh_token: refreshToken, rotatedAt: new Date().toISOString() };
  if (seedTried) rec.seedTried = seedTried;
  await ghPatch(STATE_GIST_ID, { [STATE_FILE]: { content: JSON.stringify(rec, null, 2) } });
}

/* Identifies a seed value without storing it. 12 hex characters of a SHA-256 cannot be turned
 * back into a token, and only ever need to tell "this secret" from "a different secret". */
function seedHash(seed) {
  return require('crypto').createHash('sha256').update(String(seed)).digest('hex').slice(0, 12);
}

/* Never echo a credential into a log. Public repo logs are readable by any signed-in GitHub user,
 * and WHOOP's error bodies are not promised to leave the request out. */
function redact(text, secrets) {
  let s = String(text == null ? '' : text);
  for (const v of secrets || []) if (v && v.length >= 6) s = s.split(v).join('[redacted]');
  return s;
}

/* WHOOP's OAuth errors are Ory-style JSON, and the useful part is error_hint, which came AFTER the
 * 200 characters the relay used to keep. On 2026-10-04 the log read only "token refresh failed
 * (400): {"error":"invalid_request","error_description":"The request is missing a required
 * parameter, ...", the generic text, with the hint cut off. */
function whoopErrText(status, body) {
  let j = null;
  try { j = JSON.parse(body); } catch (e) { /* not JSON: an HTML 502 page, say */ }
  if (j && typeof j === 'object' && (j.error || j.error_hint || j.error_description)) {
    return [j.error, j.error_hint || j.error_description].filter(Boolean).join(': ').slice(0, 300);
  }
  return String(body || '').replace(/<[^>]*>/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 160);
}

/* Why the sign-in failed, as the kind the app keys its advice on:
 *   'auth'      WHOOP answered and refused the token (400/401). It is dead, and only a new
 *               authorization fixes it.
 *   'auth-down' WHOOP's side failed (5xx) or no reply came. The token may or may not have been
 *               rotated before it failed -- the next run finds out.
 * The second is how the first usually starts. WHOOP has a known fault where its refresh endpoint
 * rotates the token and THEN returns a 502, so the new token never reaches the client and the
 * old one is already spent (WHOOP community, Jul-Aug 2026:
 * https://www.community.whoop.com/t/oauth-token-desync-caused-by-502-origin-gateway-errors-on-refresh-endpoint/15732).
 * 2026-10-03 looked like that: one run at 5:49 PM took 12 seconds to fail, then every run after
 * it got "400 invalid_request" in about a second. Nothing on this side can recover a token that
 * was never delivered, so the job here is to say so plainly and make the re-authorization a
 * single secret update. */
function authError(status, body, secrets) {
  const hint = redact(whoopErrText(status, body), secrets);
  const e = new Error('token refresh failed (' + status + ')' + (hint ? ': ' + hint : ''));
  e.kind = (status === 400 || status === 401) ? 'auth' : 'auth-down';
  e.status = status;
  return e;
}

/* Which refresh token to spend, and what to do when WHOOP refuses it.
 *
 * The stored token comes first, as always. Before 2026-10-04, though, the seed was used ONLY when
 * nothing was stored, so a dead stored token could never be replaced from the obvious place:
 * re-authorizing and pasting the new token into WHOOP_REFRESH_TOKEN changed nothing, because the
 * dead one in the state gist still won. Now a refused (400/401) stored token falls back to the
 * secret, but only to a secret value that has never been sent to WHOOP (seedTried):
 *   - A spent seed is not retried on every run. It is sent once, then remembered.
 *   - A 5xx does not fall back at all. The stored token may still be alive, and sending an older
 *     token from the same authorization is exactly what a refresh-token reuse check punishes.
 * refresh(token) resolves the token response or throws authError(). */
async function spendRefresh(store, seed, refresh) {
  const seedId = seed ? seedHash(seed) : null;
  if (store.token) {
    try {
      return { tok: await refresh(store.token), from: 'stored', spent: store.token, seedTried: store.seedTried };
    } catch (e) {
      const untried = seed && seed !== store.token && seedId !== store.seedTried;
      if (e.kind !== 'auth' || !untried) throw e;
      console.log('WHOOP refused the stored refresh token (' + e.message + '). The WHOOP_REFRESH_TOKEN ' +
                  'secret holds a value not tried before, so trying that.');
    }
  }
  if (!seed) {
    const e = new Error('No refresh token available (neither stored nor seeded).');
    e.kind = 'auth';
    throw e;
  }
  try {
    return { tok: await refresh(seed), from: 'seed', spent: seed, seedTried: seedId };
  } catch (e) {
    e.seedTried = seedId;   // the caller remembers it, so this seed is not sent again
    throw e;
  }
}

/* What the app is told when a run fails, written into whoop_data.json beside the last good data.
 * The app cannot read Actions logs, and until this it guessed: every failed run was "the
 * IRONHUB_GIST_TOKEN secret", which on 2026-10-04 sent him after a secret that was working while
 * WHOOP had refused the token. A run that cannot write the gist leaves no record, and the absence
 * is itself the evidence the app then reads as the gist secret. A successful run writes a fresh
 * file with no record in it, which clears it. */
function relayErrorRecord(e, nowIso) {
  const kind = ['auth', 'auth-down', 'whoop'].indexOf(e && e.kind) >= 0 ? e.kind : 'other';
  return { at: nowIso, kind, message: String((e && e.message) || 'unknown error').slice(0, 300), reauth: kind === 'auth' };
}

async function refreshAccessToken(refreshToken) {
  const body = new URLSearchParams({
    grant_type: 'refresh_token',
    refresh_token: refreshToken,
    client_id: CLIENT_ID,
    client_secret: CLIENT_SECRET,
    scope: 'offline',
  });
  // No timeout, on purpose. Cutting a slow refresh off is how a client loses a token WHOOP has
  // already rotated (see authError()); waiting costs a few seconds of runner time at most.
  let res;
  try {
    res = await fetch(WHOOP_TOKEN_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body,
    });
  } catch (e) {
    const err = new Error('token refresh got no reply (' + e.message + ')');
    err.kind = 'auth-down';
    throw err;
  }
  if (!res.ok) {
    const text = await res.text().catch(() => '');
    const secrets = [refreshToken, CLIENT_SECRET];
    console.error('WHOOP token endpoint said (' + res.status + '): ' + redact(text, secrets).slice(0, 1000));
    throw authError(res.status, text, secrets);
  }
  return res.json();   // {access_token, refresh_token, expires_in, ...}
}

async function whoopGet(path, accessToken) {
  const res = await fetch(WHOOP_API + path, { headers: { Authorization: 'Bearer ' + accessToken } });
  if (res.status === 404) return null;              // nothing recorded yet
  if (!res.ok) {
    const e = new Error('WHOOP ' + path.split('?')[0] + ' failed (' + res.status + ')');
    e.kind = 'whoop';
    throw e;
  }
  return res.json();
}

const dayOf = (iso) => (typeof iso === 'string' ? iso.slice(0, 10) : null);

/* Set once the token store has been read, which proves IRONHUB_GIST_TOKEN works. Only then is
 * there any point trying to leave the app a note about a failure. */
let gistReadable = false;

async function main() {
  const store = await readStore();
  gistReadable = true;
  const seed = (process.env.WHOOP_REFRESH_TOKEN || '').trim();
  console.log('Using ' + (store.token ? 'the stored' : 'the seeded') + ' refresh token.');

  let got;
  try {
    got = await spendRefresh(store, seed, refreshAccessToken);
  } catch (e) {
    // A seed that was just sent and refused is remembered, so it is not sent again every run.
    if (e.seedTried && e.seedTried !== store.seedTried) {
      try { await storeToken(store.token, e.seedTried); } catch (e2) { /* the original error matters more */ }
    }
    throw e;
  }
  if (got.from === 'seed' && store.token) console.log('The new WHOOP_REFRESH_TOKEN secret worked; the relay is signed in again.');
  const tok = got.tok;
  // Persist the rotated token FIRST. If the gist write below fails, the worst case is a
  // whoop_data.json that is one cycle stale -- but losing the rotated refresh token means
  // every future run fails and the whole thing has to be re-authorized by hand.
  if (tok.refresh_token && tok.refresh_token !== got.spent) {
    await storeToken(tok.refresh_token, got.seedTried);
    console.log('Rotated refresh token stored.');
  }

  const access = tok.access_token;
  const fetchedAt = new Date().toISOString();

  // Recovery is attached to the most recent physiological cycle.
  const rec = await whoopGet('/recovery?limit=1', access);
  const sleep = await whoopGet('/activity/sleep?limit=1', access);
  const cycle = await whoopGet('/cycle?limit=1', access);
  const out = Object.assign({ fetchedAt },
    todaySections(rec && rec.records && rec.records[0],
                  sleep && sleep.records && sleep.records[0],
                  cycle && cycle.records && cycle.records[0], fetchedAt));

  if (!out.recovery && !out.sleep && !out.strain) {
    console.log('WHOOP returned nothing usable this run; leaving the existing file alone.');
    // Except a failure note from an earlier run: this run signed in and read WHOOP, so whatever
    // that note said is no longer true, and the app would go on repeating it.
    await clearRelayError();
    return;
  }

  /* Carry forward any section this run did not get.
   *
   * The PATCH below replaces whoop_data.json wholesale, so a run that came back with sleep and
   * strain but no recovery used to ERASE a recovery an earlier run had already written for
   * today. That is a routine occurrence, not an edge case: WHOOP creates the recovery record
   * before it scores it and omits the `score` object entirely while the cycle is
   * PENDING_SCORE, so any of the 15-minute runs landing in that window drops the section. The
   * score does come back on a later run, but in the gap the app has none -- and the morning
   * brief only waits until AG_BRIEF_WHOOP_CUTOFF before writing itself without one.
   *
   * Carrying a stale section forward is safe. The app gates every section on
   * date === todayKey() independently (whoopFresh(), whoopContext(), readinessNow()), so an
   * out-of-date reading is already treated as absent -- it can be ignored, never mistaken for
   * current. */
  let prev = null;
  try {
    const prevFiles = (await ghGet(GIST_ID)).files || {};
    const prevRaw = prevFiles['whoop_data.json'] && prevFiles['whoop_data.json'].content;
    prev = prevRaw ? JSON.parse(prevRaw) : null;
    for (const k of carryForward(out, prev)) console.log('Kept the previous ' + k + ' (this run returned none).');
  } catch (e) {
    console.error('Could not read the previous whoop_data.json (' + e.message + ') -- writing this run alone.');
  }

  /* The rolling daily history. Strictly best-effort: today's three sections above are what the
   * morning brief waits on, so nothing here may cost them. A failed fetch keeps the previous
   * history as it was. If the previous file could not be read either, this run writes no
   * history -- and the next run, finding none, backfills the whole window from WHOOP again, so
   * the worst case is a delay, never a permanent loss. */
  const prevHist = prev && Array.isArray(prev.history) ? prev.history : [];
  try {
    const backfill = prevHist.length === 0;
    const days = backfill ? HIST_DAYS : HIST_REFRESH_DAYS;
    const pages = backfill ? HIST_BACKFILL_PAGES : HIST_REFRESH_PAGES;
    const startIso = new Date(Date.now() - days * 86400000).toISOString();
    // Sequential, not parallel: a one-time backfill is ~25 requests and WHOOP does not publish
    // its rate limit, so there is no reason to find it the hard way.
    const recs = await whoopCollect('/recovery', access, startIso, pages);
    const sleeps = await whoopCollect('/activity/sleep', access, startIso, pages);
    const cycles = await whoopCollect('/cycle', access, startIso, pages);
    out.history = mergeHistory(prevHist, historyRows(recs, sleeps, cycles), Date.now());
    console.log('History: ' + out.history.length + ' days' + (backfill ? ' (backfilled ' + days + ' days)' : '') + '.');
  } catch (e) {
    console.error('History update failed (' + e.message + ') -- keeping the previous history.');
    if (prevHist.length) out.history = prevHist;
  }

  // Only ever touch whoop_data.json. ironhub_data.json belongs to the app, and a PATCH that
  // named it would race the phone and could overwrite a session.
  await ghPatch(GIST_ID, { 'whoop_data.json': { content: serializeWhoop(out) } });
  const { history, ...today } = out;
  console.log('Wrote whoop_data.json:', JSON.stringify(today), history ? '+ ' + history.length + ' history rows' : '');
}

/* ---------------- today's sections (pure; tested from test_agents.js) ----------------
 *
 * Recovery and sleep carry readAt: the moment THIS relay read them from WHOOP. It is not the
 * same thing as the file's fetchedAt, because carryForward() below copies a section from an
 * earlier run into a later file -- and the section is only as current as the run that read it.
 *
 * The app needs it because WHOOP scores a night provisionally. On 2026-09-25 a brief wake at
 * about 3 AM was scored as the end of the night: the 3:33 AM run read recovery 28% off 4.55h of
 * sleep, and by 7:16 AM WHOOP had extended the sleep and rescored the SAME recovery record to
 * 50% off 7.03h (HRV and RHR barely moved). Both readings are dated today, so date alone cannot
 * tell them apart; the morning brief went out at 6:41 quoting the 3 AM one. readAt is what lets
 * the app see that a reading predates the morning and ask for a fresh one first. */
function todaySections(r0, s0, c0, readAt) {
  const out = {};
  if (r0 && r0.score) {
    out.recovery = {
      date: dayOf(r0.created_at) || dayOf(r0.updated_at),
      score: r0.score.recovery_score,
      hrv: r0.score.hrv_rmssd_milli,
      rhr: r0.score.resting_heart_rate,
      readAt,
    };
  }
  if (s0 && s0.score && s0.score.stage_summary) {
    const st = s0.score.stage_summary;
    const asleepMs = (st.total_light_sleep_time_milli || 0) +
                     (st.total_slow_wave_sleep_time_milli || 0) +
                     (st.total_rem_sleep_time_milli || 0);
    out.sleep = {
      date: dayOf(s0.end) || dayOf(s0.created_at),
      hours: +(asleepMs / 3600000).toFixed(2),
      performance: s0.score.sleep_performance_percentage,
      readAt,
    };
  }
  if (c0 && c0.score) {
    out.strain = { date: dayOf(c0.start), score: c0.score.strain };
  }
  return out;
}

/* Fills in, from the previous file, any section this run did not get, and returns the names it
 * kept. A kept section keeps its OWN readAt -- stamping it with this run's time would make a
 * 3 AM score look like a 7 AM re-read, which is the one thing readAt exists to prevent. A
 * section written before readAt existed is stamped with the previous file's fetchedAt, the
 * closest thing it has to when it was read. */
function carryForward(out, prev) {
  const kept = [];
  if (!prev) return kept;
  for (const k of ['recovery', 'sleep', 'strain']) {
    if (!out[k] && prev[k]) {
      out[k] = (k !== 'strain' && !prev[k].readAt && prev.fetchedAt)
        ? Object.assign({}, prev[k], { readAt: prev.fetchedAt }) : prev[k];
      kept.push(k);
    }
  }
  return kept;
}

/* ---------------- daily history (pure; tested from test_agents.js) ----------------
 *
 * whoop_data.json used to hold today and nothing else, so every recovery was overwritten by
 * the next one and there was nothing to correlate training against. It now also carries a
 * rolling window of one row per day: {date, recovery, hrv, rhr, sleepHours, sleepPerf, strain}.
 *
 * Each field is dated exactly the way today's section for it is dated above (recovery by
 * created_at, sleep by its end, strain by its cycle's start), so the history row for today can
 * never disagree with today's sections about which day a number belongs to. */
const HIST_DAYS = 180;
const HIST_REFRESH_DAYS = 30;     // a normal run re-reads a month, so missed runs heal themselves
const HIST_BACKFILL_PAGES = 12;   // 25 per page: ~300 records, enough for 180 days of sleeps with naps
const HIST_REFRESH_PAGES = 3;

async function whoopCollect(path, accessToken, startIso, maxPages) {
  const all = [];
  let next = null;
  for (let p = 0; p < maxPages; p++) {
    const q = '?limit=25&start=' + encodeURIComponent(startIso) +
              (next ? '&nextToken=' + encodeURIComponent(next) : '');
    const page = await whoopGet(path + q, accessToken);
    const got = (page && page.records) || [];
    all.push(...got);
    next = page && page.next_token;   // the response says next_token; the query takes nextToken
    if (!next || !got.length) break;
  }
  return all;
}

const round1 = (v) => Math.round(v * 10) / 10;

/* WHOOP lists newest first, so on a date collision the first value seen -- the newest -- wins.
 * Unscored records (PENDING_SCORE omits the score object) and naps contribute nothing: a nap
 * is not the night's sleep, and an absent score must stay absent rather than become 0. */
function historyRows(recoveries, sleeps, cycles) {
  const by = {};
  const put = (d, k, v) => {
    if (!d || v === null || v === undefined || v === '' || !isFinite(+v)) return;
    const row = by[d] || (by[d] = { date: d });
    if (row[k] === undefined) row[k] = +v;
  };
  for (const r of recoveries || []) {
    if (!r || !r.score) continue;
    const d = dayOf(r.created_at) || dayOf(r.updated_at);
    put(d, 'recovery', r.score.recovery_score);
    put(d, 'hrv', r.score.hrv_rmssd_milli == null ? null : round1(r.score.hrv_rmssd_milli));
    put(d, 'rhr', r.score.resting_heart_rate);
  }
  for (const s of sleeps || []) {
    if (!s || s.nap || !s.score || !s.score.stage_summary) continue;
    const st = s.score.stage_summary;
    const asleepMs = (st.total_light_sleep_time_milli || 0) +
                     (st.total_slow_wave_sleep_time_milli || 0) +
                     (st.total_rem_sleep_time_milli || 0);
    const d = dayOf(s.end) || dayOf(s.created_at);
    if (asleepMs > 0) put(d, 'sleepHours', +(asleepMs / 3600000).toFixed(2));
    put(d, 'sleepPerf', s.score.sleep_performance_percentage);
  }
  for (const c of cycles || []) {
    if (!c || !c.score) continue;
    put(dayOf(c.start), 'strain', c.score.strain == null ? null : round1(c.score.strain));
  }
  return by;
}

/* Fresh values win field by field; a field this run did not get keeps its previous value. That
 * is the same carry-forward rule as today's sections: a recovery still PENDING_SCORE on this
 * run must not erase the score an earlier run already recorded for that day. Rows older than
 * the window are dropped, and the result is oldest first. */
function mergeHistory(prevRows, freshByDate, nowMs) {
  const merged = {};
  for (const r of prevRows || []) {
    if (r && typeof r.date === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(r.date)) merged[r.date] = Object.assign({}, r);
  }
  for (const d of Object.keys(freshByDate || {})) merged[d] = Object.assign(merged[d] || {}, freshByDate[d]);
  const cutoff = new Date(nowMs - HIST_DAYS * 86400000).toISOString().slice(0, 10);
  return Object.keys(merged).filter((d) => d >= cutoff).sort().map((d) => merged[d]);
}

/* Today's sections stay pretty-printed; history rows are one line each. The app re-reads this
 * file on every 60-second pull, so 180 rows at one line apiece (~15 KB) instead of seven lines
 * apiece is worth the small custom step. The output is ordinary JSON either way. */
function serializeWhoop(out) {
  const { history, ...rest } = out;
  let s = JSON.stringify(rest, null, 2);
  if (history && history.length) {
    s = s.slice(0, -2) + ',\n  "history": [\n' +
        history.map((h) => '    ' + JSON.stringify(h)).join(',\n') + '\n  ]\n}';
  }
  return s;
}

/* ---------------- failure notes for the app ---------------- */

/* The previous file with a failure note added (or removed, with rec null). Everything else in it
 * is kept exactly, so a failed run never costs the app the data it already had. */
function withRelayError(prev, rec) {
  const out = Object.assign({}, prev || {});
  if (rec) out.relayError = rec; else delete out.relayError;
  return out;
}
async function readWhoopFile() {
  const f = ((await ghGet(GIST_ID)).files || {})['whoop_data.json'];
  return f && f.content ? JSON.parse(f.content) : null;
}
async function clearRelayError() {
  try {
    const prev = await readWhoopFile();
    if (prev && prev.relayError) {
      await ghPatch(GIST_ID, { 'whoop_data.json': { content: serializeWhoop(withRelayError(prev, null)) } });
      console.log('Cleared the failure note an earlier run left.');
    }
  } catch (e) { /* best effort; the next run that writes data clears it anyway */ }
}
/* Best effort, and never allowed to hide the real error: that is printed first and the run
 * still fails. */
async function reportFailure(e) {
  if (!gistReadable) return;   // the gist secret itself failed; there is no way to write anything
  try {
    const prev = await readWhoopFile();
    await ghPatch(GIST_ID, { 'whoop_data.json': { content: serializeWhoop(withRelayError(prev, relayErrorRecord(e, new Date().toISOString()))) } });
    console.error('Left a note for the app in whoop_data.json.');
  } catch (e2) {
    console.error('Could not leave a note for the app (' + e2.message + ').');
  }
}

module.exports = { todaySections, carryForward, historyRows, mergeHistory, serializeWhoop, HIST_DAYS,
                   spendRefresh, seedHash, redact, whoopErrText, authError, relayErrorRecord, withRelayError };

if (IS_MAIN) main().catch(async (e) => {
  console.error(e.message);
  if (e.kind === 'auth') {
    console.error('WHOOP needs re-authorizing. On the laptop: node scripts/whoop/whoop-auth.js, approve, ' +
                  'then paste the token it prints into the WHOOP_REFRESH_TOKEN repository secret. The ' +
                  'next run uses it.');
  }
  await reportFailure(e);
  process.exit(1);
});
