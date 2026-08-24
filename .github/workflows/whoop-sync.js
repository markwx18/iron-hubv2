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

const env = (k) => {
  const v = process.env[k];
  if (!v) { console.error('Missing required secret: ' + k); process.exit(1); }
  return v;
};

const CLIENT_ID = env('WHOOP_CLIENT_ID');
const CLIENT_SECRET = env('WHOOP_CLIENT_SECRET');
const GIST_ID = env('IRONHUB_GIST_ID');
const GIST_TOKEN = env('IRONHUB_GIST_TOKEN');
const STATE_GIST_ID = env('IRONHUB_STATE_GIST_ID');
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
  try {
    const g = await ghGet(STATE_GIST_ID);
    const f = g.files && g.files[STATE_FILE];
    if (f && f.content) {
      const p = JSON.parse(f.content);
      if (p && typeof p.refresh_token === 'string' && p.refresh_token) return p.refresh_token;
    }
  } catch (e) {
    console.error('Could not read stored token (' + e.message + ') -- falling back to the secret.');
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

  // Only ever touch whoop_data.json. ironhub_data.json belongs to the app, and a PATCH that
  // named it would race the phone and could overwrite a session.
  await ghPatch(GIST_ID, { 'whoop_data.json': { content: JSON.stringify(out, null, 2) } });
  console.log('Wrote whoop_data.json:', JSON.stringify(out));
}

main().catch((e) => { console.error(e.message); process.exit(1); });
