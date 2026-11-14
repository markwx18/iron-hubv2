#!/usr/bin/env node
/* Iron Hub: replay the progression engine over real sessions.
 *
 * CLAUDE.md, "A change to what the engine prescribes needs a replay over his real sessions first, old build
 * against new, with only the history before each session." This is that replay as one command. For every logged
 * session it moves the clock to noon on that day, keeps only the logs dated before it, and asks the engine what it
 * would have prescribed for each lift he then trained. It does that under two configurations and compares them:
 *
 *   node scripts/engine_replay.js --state my_state.json --on engine2
 *       one build, the named switch(es) forced OFF (A) against ON (B)
 *   node scripts/engine_replay.js --state my_state.json --a old.html --b iron_hub.html
 *       two builds, switches as the state stores them
 *   --list N     how many differing prescriptions to print (default 60)
 *   --json FILE  every row, for a closer look
 *
 * IRONHUB_STATE and IRONHUB_HTML stand in for --state and --a. The state file is his data: it is read, never
 * written and never committed (see .gitignore). Only logs are rewound; the split, flags and settings are today's
 * in both configurations, so a difference is the engine's and nothing else's.
 *
 * Exits 1 if configuration B ever prescribes a heavier weight than A, or if either engine throws. Dev-time only.
 */
const fs = require('fs'), path = require('path');
const { JSDOM } = require('jsdom');

const ROOT = path.join(__dirname, '..');
const argv = process.argv.slice(2);
function arg(name){ const i = argv.indexOf('--' + name); return i >= 0 ? argv[i + 1] : null; }
const STATE = arg('state') || process.env.IRONHUB_STATE;
const A_HTML = arg('a') || process.env.IRONHUB_HTML || path.join(ROOT, 'iron_hub.html');
const B_HTML = arg('b') || A_HTML;
const ON = (arg('on') || '').split(',').map(function(s){ return s.trim(); }).filter(Boolean);
const LIST = arg('list') === null ? 60 : Math.max(0, +arg('list') || 0);
const JSON_OUT = arg('json');
if(!STATE || !fs.existsSync(STATE)){
  console.error('Give a state file: --state path.json (a backup export, or the raw ironhub:v1 value).');
  process.exit(1);
}
if(A_HTML === B_HTML && !ON.length){
  console.error('Nothing to compare: name a switch with --on, or a second build with --b.');
  process.exit(1);
}

/* A backup export, a gist file, {S:...} and the bare state all hold the same object somewhere. */
function readState(p){
  let j = JSON.parse(fs.readFileSync(p, 'utf8'));
  for(let i = 0; i < 4 && j && !Array.isArray(j.logs); i++){
    if(typeof j === 'string'){ j = JSON.parse(j); continue; }
    const next = j.S || j.state || j.data || j['ironhub:v1'] || j.ironhub;
    if(!next) break;
    j = next;
  }
  if(!j || !Array.isArray(j.logs)) throw new Error('No logs found in ' + p);
  return j;
}

/* Inside the page: `new Date()` and Date.now() follow window.__clockOff, which the replay moves per session. A
   Date built from parts or a string is untouched, exactly as in scripts/clock_run.js. */
const SHIM = "\n;(function(){ try{ var R = Date; window.__RealDate = R; window.__clockOff = 0;" +
  " function D(a,b,c,d,e,f,g){ var off = window.__clockOff || 0; if(!(this instanceof D)) return new R(R.now()+off).toString();" +
  " var n = arguments.length; return n===0 ? new R(R.now()+off) : n===1 ? new R(a) : new R(a,b,n>2?c:1,n>3?d:0,n>4?e:0,n>5?f:0,n>6?g:0); }" +
  " D.prototype = R.prototype; D.now = function(){ return R.now() + (window.__clockOff || 0); }; D.UTC = R.UTC; D.parse = R.parse;" +
  " window.Date = D; }catch(e){} })();\n";

const HELPER = "window.__rp = function(d, names, call, force){" +
  " S.logs = window.__allLogs.filter(function(l){ return l.date < d; });" +
  " window.__clockOff = new window.__RealDate(d + 'T12:00:00').getTime() - window.__RealDate.now();" +
  " if(force){ if(!S.overhaul || typeof S.overhaul !== 'object' || Array.isArray(S.overhaul)) S.overhaul = {};" +
  "   Object.keys(force).forEach(function(k){ S.overhaul[k] = force[k]; }); }" +
  // A reset in force today was not in force then, and it would hide the engine's own answer for that lift.
  " try{ invState().overrides = {}; }catch(e){}" +
  " var tier = callTier(call);" +
  " return names.map(function(nm){ var o = {nm: nm};" +
  "  try{ var r = recommend(nm, tier); o.w = (r.sets && r.sets[0] && r.sets[0].w !== '' && r.sets[0].w != null) ? +r.sets[0].w : null; o.target = r.target; }catch(e){ o.err = 'recommend: ' + e.message; }" +
  "  try{ var c = classifyDecision(nm, tier); o.code = c.code; o.from = c.from; o.to = c.to; }catch(e){ o.err = 'classify: ' + e.message; }" +
  "  try{ var b = buildOneLiveExerciseBase(nm, null, {call: call}); o.lw = (b.targetW === '' || b.targetW == null) ? null : +b.targetW; o.lo = b.lo; o.hi = b.hi;" +
  "       o.lcode = b._decision ? b._decision.code : null; o.aim = intraFirstAim(b);" +
  // The session then carries THIS engine's decision, as it would have had this engine been running: the rules read
  // what was asked last time. A session a reset or a recover day really shaped keeps the decision it stored.
  "       var dc = b._decision; if(dc){ window.__allLogs.forEach(function(l){ if(l.date !== d || l.deload) return;" +
  "         if(!(l.entries || []).some(function(e){ return e.exercise === nm; })) return;" +
  "         if(!l.decisions || Array.isArray(l.decisions)) l.decisions = {};" +
  "         var st = l.decisions[nm]; if(st && /^(inv-override|call-recover|deload|chat-today)$/.test(st.code || '')) return;" +
  "         l.decisions[nm] = {code: dc.code, from: dc.from, to: dc.to, moved: dc.moved, reason: ''}; }); }" +
  "  }catch(e){ o.err = 'live: ' + e.message; }" +
  "  return o; }); };";

function boot(htmlPath, state){
  const html = fs.readFileSync(htmlPath, 'utf8');
  const at = html.indexOf('<script>');
  if(at < 0) throw new Error('No <script> in ' + htmlPath);
  const dom = new JSDOM(html.slice(0, at + 8) + SHIM + html.slice(at + 8), {
    runScripts: 'dangerously', pretendToBeVisual: true, url: 'https://example.com/',
    beforeParse(w){
      w.fetch = function(){ return Promise.reject(new Error('network disabled in replay')); };
      w.alert = function(){}; w.confirm = function(){ return false; }; w.prompt = function(){ return null; };
      w.matchMedia = function(){ return {matches: false, addListener(){}, removeListener(){}, addEventListener(){}, removeEventListener(){}}; };
      w.Element.prototype.scrollIntoView = function(){};
      w.localStorage.setItem('ironhub:v1', JSON.stringify(state));
    }
  });
  const w = dom.window;
  w.__allLogs = JSON.parse(JSON.stringify(state.logs));
  w.eval(HELPER);
  return w;
}

function firstW(e){ return +((e.sets[0] || {}).w) || 0; }
function topW(e){ return Math.max.apply(null, e.sets.map(function(s){ return +s.w || 0; })); }
function pct(a, b){ return b ? Math.round(a / b * 100) + '%' : 'n/a'; }

setTimeout(function(){
  const state = readState(STATE);
  const force = function(v){ const o = {}; ON.forEach(function(k){ o[k] = v; }); return ON.length ? o : null; };
  const wa = boot(A_HTML, state), wb = boot(B_HTML, state);
  const sessions = state.logs.filter(function(l){ return l && l.date && !l.deload && !l.home && Array.isArray(l.entries); })
    .slice().sort(function(x, y){ return x.date.localeCompare(y.date); });
  const rows = [], errs = [];
  sessions.forEach(function(l){
    const ents = l.entries.filter(function(e){ return e && e.exercise && e.sets && e.sets.length; });
    if(!ents.length) return;
    const names = ents.map(function(e){ return e.exercise; });
    const call = (l.call && l.call.call && !l.call.off) ? l.call.call : 'normal';
    wa.__args = wb.__args = null;
    const ra = wa.__rp(l.date, names, call, force(false)), rb = wb.__rp(l.date, names, call, force(true));
    ents.forEach(function(e, i){
      const a = ra[i], b = rb[i];
      if(a.err) errs.push('A ' + l.date + ' ' + e.exercise + ': ' + a.err);
      if(b.err) errs.push('B ' + l.date + ' ' + e.exercise + ': ' + b.err);
      rows.push({date: l.date, lift: e.exercise, did: e.sets.map(function(s){ return s.w + 'x' + s.r; }).join(','),
        first: firstW(e), top: topW(e), a: a, b: b});
    });
  });

  const same = function(x, y){ return x === y || (x == null && y == null); };
  const dW = rows.filter(function(r){ return !same(r.a.w, r.b.w) || !same(r.a.lw, r.b.lw); });
  const dRange = rows.filter(function(r){ return dW.indexOf(r) < 0 && (!same(r.a.lo, r.b.lo) || !same(r.a.hi, r.b.hi)); });
  const dAim = rows.filter(function(r){ return dW.indexOf(r) < 0 && dRange.indexOf(r) < 0 && !same(r.a.aim, r.b.aim); });
  const dCode = rows.filter(function(r){ return dW.indexOf(r) < 0 && dRange.indexOf(r) < 0 && dAim.indexOf(r) < 0 && (!same(r.a.code, r.b.code) || !same(r.a.target, r.b.target)); });
  const heavier = rows.filter(function(r){ return (r.b.w != null && r.a.w != null && r.b.w > r.a.w) || (r.b.lw != null && r.a.lw != null && r.b.lw > r.a.lw); });
  const withW = rows.filter(function(r){ return r.a.lw != null && r.b.lw != null && r.first > 0; });
  const agree = function(k){ return withW.filter(function(r){ return r[k].lw === r.first || r[k].lw === r.top; }).length; };
  const JUMP = /^(increase|double|form-increase|step-small)$/;
  const jumps = function(k){
    const j = rows.filter(function(r){ return JUMP.test(r[k].code || '') && r[k].to != null; });
    return {asked: j.length, taken: j.filter(function(r){ return r.top >= r[k].to; }).length};
  };
  const codes = function(k){ const o = {}; rows.forEach(function(r){ const c = r[k].lcode || r[k].code || '(none)'; o[c] = (o[c] || 0) + 1; }); return o; };

  console.log('Engine replay: ' + sessions.length + ' sessions, ' + rows.length + ' prescriptions');
  console.log('  A: ' + path.relative(ROOT, A_HTML) + (ON.length ? '  [' + ON.join(', ') + ' off]' : ''));
  console.log('  B: ' + path.relative(ROOT, B_HTML) + (ON.length ? '  [' + ON.join(', ') + ' on]' : ''));
  console.log('Differences: weight ' + dW.length + ', range only ' + dRange.length + ', first-set aim only ' + dAim.length + ', wording or code only ' + dCode.length);
  console.log('B heavier than A: ' + heavier.length + (heavier.length ? '   <-- must be 0' : ''));
  const ja = jumps('a'), jb = jumps('b');
  console.log('Prescribed weight was the weight he loaded: A ' + agree('a') + '/' + withW.length + ' (' + pct(agree('a'), withW.length) + '), B ' + agree('b') + '/' + withW.length + ' (' + pct(agree('b'), withW.length) + ')');
  console.log('Jumps asked and taken: A ' + ja.taken + '/' + ja.asked + ' (' + pct(ja.taken, ja.asked) + '), B ' + jb.taken + '/' + jb.asked + ' (' + pct(jb.taken, jb.asked) + ')');
  console.log('Codes A: ' + JSON.stringify(codes('a')));
  console.log('Codes B: ' + JSON.stringify(codes('b')));
  const show = function(title, list){
    if(!list.length || !LIST) return;
    console.log('\n' + title + ' (' + list.length + ')');
    list.slice(0, LIST).forEach(function(r){
      const f = function(x){ return (x.lw == null ? '-' : x.lw) + ' lb ' + x.lo + '-' + x.hi + ' aim ' + x.aim + ' [' + (x.lcode || x.code) + ']'; };
      console.log('  ' + r.date + '  ' + r.lift + ':  A ' + f(r.a) + '  ->  B ' + f(r.b) + '   did ' + r.did);
    });
    if(list.length > LIST) console.log('  ... and ' + (list.length - LIST) + ' more');
  };
  show('Weight differs', dW); show('Range differs', dRange); show('First-set aim differs', dAim); show('Wording or code differs', dCode);
  if(errs.length){ console.log('\nERRORS (' + errs.length + ')'); errs.slice(0, 20).forEach(function(e){ console.log('  ' + e); }); }
  if(JSON_OUT) fs.writeFileSync(JSON_OUT, JSON.stringify(rows));
  process.exit((heavier.length || errs.length) ? 1 : 0);
}, 400);
