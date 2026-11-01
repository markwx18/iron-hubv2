/* Iron Hub's server runner: the nightly cycle and the morning brief with no device open (his ask, 2026-11-01).

   It loads index.html -- the file GitHub Pages serves -- in jsdom with IRONHUB_HEADLESS set, so the app's boot never
   runs, and calls the app's own runnerTick() and runnerFlush(). Nothing about the agents is re-implemented here: the
   gates, the cycle, the brief and the push (with its reconcile) are the app's, which is what keeps the server and the
   phone from ever disagreeing about what a night is.

   Started by .github/workflows/agents.yml, which the Cloudflare clock (clock/) dispatches at 9 PM and through the
   morning, and the brief's Reload button dispatches in 'reload' mode.

   Env: ANTHROPIC_API_KEY, IRONHUB_GIST_ID, IRONHUB_GIST_TOKEN, IRONHUB_STATE_GIST_ID (the relay's state gist, which
   also carries this runner's usage log between runs), RUN_MODE ('auto' | 'reload'), RUN_OVER ('1' when he said yes
   to going over the monthly cap), TZ (America/New_York; the app reads the hour from the local clock).
   IRONHUB_HTML points it at another copy, the way the suite does.

   The repo is public, so its Actions logs are too: this prints what it did, never his data or the brief. */
'use strict';
const fs = require('fs');
const path = require('path');

const HTML_PATH = process.env.IRONHUB_HTML || path.join(__dirname, '..', '..', 'index.html');
const LOCAL_FILE = 'runner_local.json';
/* The runner's own per-device localStorage, carried between runs. The usage log has to be: spendLedgerSync()
   REBUILDS this device's day records from it, so a run that started with an empty log would overwrite the morning's
   spend with the reload's alone. The device id keeps those records under one name. */
const CARRY = ['ironhub:usage', 'ironhub:device'];

function need(name){
  const v = process.env[name];
  if(!v) throw new Error('missing ' + name + ' (a repository secret; see clock/README.md)');
  return v;
}
function gh(url, opts){
  const o = opts || {};
  return fetch(url, Object.assign({}, o, {headers:Object.assign({
    'Authorization': 'Bearer ' + process.env.IRONHUB_GIST_TOKEN,
    'Accept': 'application/vnd.github+json',
    'User-Agent': 'ironhub-runner',
    'Content-Type': 'application/json'}, o.headers || {})}));
}
/* A read failure is fatal, not an empty start: writing back a fresh log would erase the runner's spend for the
   month, and the cap would stop seeing it. The same rule as the relay's token store. */
async function readCarry(gistId){
  const res = await gh('https://api.github.com/gists/' + gistId);
  if(!res.ok) throw new Error('could not read the state gist (' + res.status + '); check IRONHUB_GIST_TOKEN');
  const g = await res.json();
  const f = g.files && g.files[LOCAL_FILE];
  if(!f) return {};                                  // the first run
  let text = f.content;
  if(f.truncated) text = await (await fetch(f.raw_url)).text();
  const o = JSON.parse(text);
  return (o && typeof o === 'object') ? o : {};
}
async function writeCarry(gistId, obj){
  const res = await gh('https://api.github.com/gists/' + gistId, {method:'PATCH',
    body:JSON.stringify({files:{[LOCAL_FILE]:{content:JSON.stringify(obj)}}})});
  if(!res.ok) throw new Error('could not save the runner’s usage log (' + res.status + ')');
}

async function main(){
  const { JSDOM, VirtualConsole } = require('jsdom');
  const mode = process.env.RUN_MODE === 'reload' ? 'reload' : 'auto';
  const over = process.env.RUN_OVER === '1';
  const apiKey = need('ANTHROPIC_API_KEY'), gistId = need('IRONHUB_GIST_ID');
  need('IRONHUB_GIST_TOKEN');
  const stateId = need('IRONHUB_STATE_GIST_ID');

  const carry = await readCarry(stateId);
  const html = fs.readFileSync(HTML_PATH, 'utf8');
  // The app's own warnings can quote an API error; clipped, and nothing at log level.
  const vc = new VirtualConsole();
  const clip = function(a){ return Array.prototype.map.call(a, function(x){ return String(x && x.message || x); }).join(' ').slice(0, 200); };
  vc.on('warn', function(){ console.log('[app warn] ' + clip(arguments)); });
  vc.on('error', function(){ console.log('[app error] ' + clip(arguments)); });
  vc.on('jsdomError', function(e){ console.log('[jsdom] ' + String(e && e.message).slice(0, 200)); });

  const dom = new JSDOM(html, {
    runScripts: 'dangerously',
    pretendToBeVisual: true,
    url: 'https://markwx18.github.io/iron-hubv2/',
    virtualConsole: vc,
    beforeParse(w){
      w.IRONHUB_HEADLESS = true;
      // Node's networking, not jsdom's: the app streams the API reply and aborts on a timeout, and Node's fetch only
      // takes its own AbortSignal and hands back its own ReadableStream.
      w.fetch = function(u, o){ return fetch(u, o); };
      w.AbortController = AbortController;
      w.AbortSignal = AbortSignal;
      w.TextDecoder = TextDecoder;
      w.TextEncoder = TextEncoder;
      w.alert = function(m){ console.log('[alert] ' + String(m).slice(0, 200)); };
      // Only the cap asks here (spendManualOk()), and he answered it on the phone before the reload was sent.
      w.confirm = function(){ return over; };
      w.matchMedia = function(){ return {matches:false, addListener(){}, removeListener(){}, addEventListener(){}, removeEventListener(){}}; };
      w.Element.prototype.scrollIntoView = function(){};
      CARRY.forEach(function(k){ if(typeof carry[k] === 'string') w.localStorage.setItem(k, carry[k]); });
    }
  });
  const w = dom.window;
  if(typeof w.runnerTick !== 'function') throw new Error('this copy of the app has no runnerTick()');
  w.__cfg = {apiKey:apiKey, gistId:gistId, ghToken:process.env.IRONHUB_GIST_TOKEN};
  // Credentials live in this device's settings only; applyPulled() keeps them across the pull, as on a phone.
  w.eval('S.settings.apiKey = __cfg.apiKey; S.settings.gistId = __cfg.gistId; S.settings.ghToken = __cfg.ghToken;' +
         'S.settings.autoSync = true; delete window.__cfg;');

  const res = await w.eval('runnerTick(' + JSON.stringify(mode) + ')');
  const pushed = await w.eval('runnerFlush()');
  console.log('mode ' + mode + ': ' + (res && res.why || 'no answer') + (res && res.did ? ' [' + res.did + ']' : ''));

  const out = {};
  CARRY.forEach(function(k){ const v = w.localStorage.getItem(k); if(v !== null) out[k] = v; });
  if(CARRY.some(function(k){ return out[k] !== carry[k]; })) await writeCarry(stateId, out);

  if(!pushed){
    console.log('The gist does not hold this run’s changes: the push failed. Nothing was overwritten.');
    return 1;
  }
  return 0;
}

if(require.main === module){
  main().then(function(code){ process.exit(code || 0); },
              function(e){ console.log('runner failed: ' + String(e && e.message || e).slice(0, 300)); process.exit(1); });
}
module.exports = { main, CARRY, LOCAL_FILE };
