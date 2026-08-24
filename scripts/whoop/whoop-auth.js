/* One-time WHOOP authorization, run locally, once.
 *
 *   node scripts/whoop/whoop-auth.js
 *
 * Prints a URL, waits for the redirect on http://localhost:8080/callback, exchanges the
 * code, and prints the refresh token to paste into the WHOOP_REFRESH_TOKEN repo secret.
 * After that this file is never needed again -- the scheduled job rotates the token itself.
 *
 * Set WHOOP_CLIENT_ID and WHOOP_CLIENT_SECRET in your shell before running. Nothing is
 * written to disk: the token is printed and it is up to you to paste it into the secret.
 */
'use strict';

const http = require('http');
const crypto = require('crypto');

const CLIENT_ID = process.env.WHOOP_CLIENT_ID;
const CLIENT_SECRET = process.env.WHOOP_CLIENT_SECRET;
const REDIRECT = 'http://localhost:8080/callback';
const SCOPES = 'offline read:recovery read:sleep read:cycles';

if (!CLIENT_ID || !CLIENT_SECRET) {
  console.error('Set WHOOP_CLIENT_ID and WHOOP_CLIENT_SECRET first, e.g.\n' +
    '  WHOOP_CLIENT_ID=... WHOOP_CLIENT_SECRET=... node scripts/whoop/whoop-auth.js');
  process.exit(1);
}

// CSRF guard on the redirect: without it, anything that can reach localhost:8080 during the
// window could feed this process an authorization code of its own choosing.
const state = crypto.randomBytes(16).toString('hex');

const authUrl = 'https://api.prod.whoop.com/oauth/oauth2/auth?' + new URLSearchParams({
  client_id: CLIENT_ID,
  redirect_uri: REDIRECT,
  response_type: 'code',
  scope: SCOPES,
  state,
});

console.log('\n1. Open this and approve:\n\n' + authUrl + '\n\n2. Waiting for the redirect on ' + REDIRECT + ' ...\n');

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, 'http://localhost:8080');
  if (url.pathname !== '/callback') { res.writeHead(404).end(); return; }

  const code = url.searchParams.get('code');
  const got = url.searchParams.get('state');
  const finish = (msg) => { res.writeHead(200, { 'Content-Type': 'text/plain' }).end(msg); };

  if (got !== state) { finish('State mismatch - ignored.'); console.error('State mismatch; ignoring this callback.'); return; }
  if (!code) { finish('No code in the callback.'); console.error('No code in the callback.'); return; }

  try {
    const r = await fetch('https://api.prod.whoop.com/oauth/oauth2/token', {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        grant_type: 'authorization_code',
        code,
        redirect_uri: REDIRECT,
        client_id: CLIENT_ID,
        client_secret: CLIENT_SECRET,
      }),
    });
    const j = await r.json();
    if (!r.ok || !j.refresh_token) {
      finish('Token exchange failed - check the terminal.');
      console.error('Token exchange failed:', JSON.stringify(j).slice(0, 400));
      process.exit(1);
    }
    finish('Done. You can close this tab and go back to the terminal.');
    console.log('\nRefresh token (paste into the WHOOP_REFRESH_TOKEN repo secret):\n\n' + j.refresh_token + '\n');
    server.close(() => process.exit(0));
  } catch (e) {
    finish('Error - check the terminal.');
    console.error(e.message);
    process.exit(1);
  }
});

server.listen(8080);
