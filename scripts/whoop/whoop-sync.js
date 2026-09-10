/* WHOOP -> Iron Hub relay.  Run by .github/workflows/whoop-sync.yml.
 *
 * Refreshes the WHOOP token, pulls today's recovery / sleep / strain, and writes a single
 * whoop_data.json into the app's existing sync gist. Zero dependencies -- plain Node fetch,
 * so there is nothing to install and nothing to keep up to date.
 *
 * This is not part of the app. iron_hub.html stays a single file with no build step; this
 * runs on GitHub's infrastructure on a schedule and the app only ever reads its output.
 */
'use strict';

const WHOOP_TOKEN_URL = 'https://api.prod.whoop.com/oauth/oauth2/token';
const WHOOP_API = 'https://api.prod.whoop.com/developer/v2';
const GH_API = 'https://api.github.com';

/* Not-configured is a SKIP, not a failure. This job is on a 2-hourly schedule, so treating
 * missing secrets as an error would mean a red run and a notification email every two hours
 * from the moment the workflow lands until the one-time setup is done -- which trains you to
 * ignore exactly the notifications that matter once it IS configured. Exit 0 and say why. */
const REQUIRED = ['WHOOP_CLIENT_ID', 'WHOOP_CLIENT_SECRET', 'IRONHUB_GIST_ID',
                  'IRONHUB_GIST_TOKEN', 'IRONHUB_STATE_GIST_ID'];
const missing = REQUIRED.filter((k) => !process.env[k]);
if (missing.length) {
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

/* The stored refresh token, if a previous run rotated one. WHOOP issues a NEW refresh token
 * every time you spend the old one, so the seeded secret is only ever good for the first run
 * -- after that the live one lives here. */
async function readStoredToken() {
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
  try {
    const f = g.files && g.files[STATE_FILE];
    if (f && f.content) {
      const p = JSON.parse(f.content);
      if (p && typeof p.refresh_token === 'string' && p.refresh_token) return p.refresh_token;
    }
  } catch (e) {
    // A gist we CAN read that holds no usable token really is the first-run case, and the
    // seeded secret is exactly right for it.
    console.error('Stored token file unusable (' + e.message + ') -- falling back to the seed.');
  }
  return null;
}
async function storeToken(refreshToken) {
  await ghPatch(STATE_GIST_ID, {
    [STATE_FILE]: { content: JSON.stringify({ refresh_token: refreshToken, rotatedAt: new Date().toISOString() }, null, 2) },
  });
}

async function refreshAccessToken(refreshToken) {
  const body = new URLSearchParams({
    grant_type: 'refresh_token',
    refresh_token: refreshToken,
    client_id: CLIENT_ID,
    client_secret: CLIENT_SECRET,
    scope: 'offline',
  });
  const res = await fetch(WHOOP_TOKEN_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body,
  });
  if (!res.ok) throw new Error('token refresh failed (' + res.status + '): ' + (await res.text()).slice(0, 200));
  return res.json();   // {access_token, refresh_token, expires_in, ...}
}

async function whoopGet(path, accessToken) {
  const res = await fetch(WHOOP_API + path, { headers: { Authorization: 'Bearer ' + accessToken } });
  if (res.status === 404) return null;              // nothing recorded yet
  if (!res.ok) throw new Error('WHOOP ' + path + ' failed (' + res.status + ')');
  return res.json();
}

const dayOf = (iso) => (typeof iso === 'string' ? iso.slice(0, 10) : null);

async function main() {
  const stored = await readStoredToken();
  const startingToken = stored || process.env.WHOOP_REFRESH_TOKEN;
  if (!startingToken) { console.error('No refresh token available (neither stored nor seeded).'); process.exit(1); }
  console.log('Using ' + (stored ? 'the stored' : 'the seeded') + ' refresh token.');

  const tok = await refreshAccessToken(startingToken);
  // Persist the rotated token FIRST. If the gist write below fails, the worst case is a
  // whoop_data.json that is one cycle stale -- but losing the rotated refresh token means
  // every future run fails and the whole thing has to be re-authorized by hand.
  if (tok.refresh_token && tok.refresh_token !== startingToken) {
    await storeToken(tok.refresh_token);
    console.log('Rotated refresh token stored.');
  }

  const access = tok.access_token;
  const out = { fetchedAt: new Date().toISOString() };

  // Recovery is attached to the most recent physiological cycle.
  const rec = await whoopGet('/recovery?limit=1', access);
  const r0 = rec && rec.records && rec.records[0];
  if (r0 && r0.score) {
    out.recovery = {
      date: dayOf(r0.created_at) || dayOf(r0.updated_at),
      score: r0.score.recovery_score,
      hrv: r0.score.hrv_rmssd_milli,
      rhr: r0.score.resting_heart_rate,
    };
  }

  const sleep = await whoopGet('/activity/sleep?limit=1', access);
  const s0 = sleep && sleep.records && sleep.records[0];
  if (s0 && s0.score && s0.score.stage_summary) {
    const st = s0.score.stage_summary;
    const asleepMs = (st.total_light_sleep_time_milli || 0) +
                     (st.total_slow_wave_sleep_time_milli || 0) +
                     (st.total_rem_sleep_time_milli || 0);
    out.sleep = {
      date: dayOf(s0.end) || dayOf(s0.created_at),
      hours: +(asleepMs / 3600000).toFixed(2),
      performance: s0.score.sleep_performance_percentage,
    };
  }

  const cycle = await whoopGet('/cycle?limit=1', access);
  const c0 = cycle && cycle.records && cycle.records[0];
  if (c0 && c0.score) {
    out.strain = { date: dayOf(c0.start), score: c0.score.strain };
  }

  if (!out.recovery && !out.sleep && !out.strain) {
    console.log('WHOOP returned nothing usable this run; leaving the existing file alone.');
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
  try {
    const prevFiles = (await ghGet(GIST_ID)).files || {};
    const prevRaw = prevFiles['whoop_data.json'] && prevFiles['whoop_data.json'].content;
    const prev = prevRaw ? JSON.parse(prevRaw) : null;
    if (prev) {
      for (const k of ['recovery', 'sleep', 'strain']) {
        if (!out[k] && prev[k]) {
          out[k] = prev[k];
          console.log('Kept the previous ' + k + ' (this run returned none).');
        }
      }
    }
  } catch (e) {
    console.error('Could not read the previous whoop_data.json (' + e.message + ') -- writing this run alone.');
  }

  // Only ever touch whoop_data.json. ironhub_data.json belongs to the app, and a PATCH that
  // named it would race the phone and could overwrite a session.
  await ghPatch(GIST_ID, { 'whoop_data.json': { content: JSON.stringify(out, null, 2) } });
  console.log('Wrote whoop_data.json:', JSON.stringify(out));
}

main().catch((e) => { console.error(e.message); process.exit(1); });
