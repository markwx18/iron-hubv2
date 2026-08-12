/* Agent-layer regression harness.
   Loads the real single-file app in jsdom and exercises the agent state machine:
   fix validation (the security boundary), apply dispatch, expiry, approve/reject. */
const fs = require('fs');
const path = require('path');
const { JSDOM } = require('jsdom');

// Resolve relative to this file so the suite runs from any cwd and on any machine.
// Override with: IRONHUB_HTML=/some/other/path.html node test_agents.js
const HTML_PATH = process.env.IRONHUB_HTML || path.join(__dirname, 'iron_hub.html');
if (!fs.existsSync(HTML_PATH)) {
  console.error('Cannot find app file at: ' + HTML_PATH);
  console.error('Run this from the repo root, or set IRONHUB_HTML to the correct path.');
  process.exit(1);
}
const html = fs.readFileSync(HTML_PATH, 'utf8');
let pass = 0, fail = 0;
function ok(name, cond, extra) {
  if (cond) { pass++; }
  else { fail++; console.log('  FAIL: ' + name + (extra ? ' -> ' + extra : '')); }
}

const dom = new JSDOM(html, {
  runScripts: 'dangerously',
  pretendToBeVisual: true,
  url: 'https://example.com/',
  beforeParse(w) {
    w.fetch = () => Promise.reject(new Error('network disabled in test'));
    w.alert = () => {};
    w.confirm = () => true;
    w.matchMedia = () => ({ matches: false, addListener(){}, removeListener(){}, addEventListener(){}, removeEventListener(){} });
  }
});

const w = dom.window;
const ev = (expr) => w.eval(expr);
const call = (fn, ...args) => { w.__a = args; return w.eval(fn + '.apply(null, window.__a)'); };
setTimeout(async () => {
  console.log('=== AGENT LAYER ===');

  // --- registry wiring ---
  ok('AGENTS registry has 4 agents', Object.keys(ev('AGENTS')).length === 4, Object.keys(ev('AGENTS')).join(','));
  ok('ZULU is the lead', ev('AGENTS').zulu.lead === true);
  ok('AG_ORDER excludes zulu', ev('AG_ORDER').indexOf('zulu') === -1);

  // --- nav: coach replaced by ops, legacy still routes ---
  const navIds = ev('NAV_MODEL').map(n => n.id);
  ok('nav has ops', navIds.indexOf('ops') >= 0, navIds.join(','));
  ok('nav no longer has coach', navIds.indexOf('coach') === -1);
  ok('legacy coach -> ops', ev('NAV_LEGACY').coach && ev('NAV_LEGACY').coach[0] === 'ops');
  ok('ops section exists in DOM', !!w.document.getElementById('ops'));
  ok('REVIEW_RENDER.ops wired', typeof ev('REVIEW_RENDER').ops === 'function');

  // --- state shape ---
  const st = ev('agState')();
  ok('agState creates proposals[]', Array.isArray(st.proposals));
  ok('agState creates log[]', Array.isArray(st.log));
  ok('agState seeds all chat buckets', ev('AG_ORDER').every(k => Array.isArray(st.chats[k])));
  ok('autoRun defaults true', st.autoRun === true);

  // --- memory migration: coach data must be reachable, not copied ---
  ok('S.chat still the ZULU history', Array.isArray(ev('S').chat));
  ok('coachMemContext still callable', typeof ev('coachMemContext') === 'function');
  ok('renderCoach now repaints ops', typeof ev('renderCoach') === 'function');

  // ============ agValidateFix: the security boundary ============
  console.log('=== FIX VALIDATION ===');
  const V = ev('agValidateFix');

  ok('null fix -> null', V(null) === null);
  ok('unknown type rejected', V({ type: 'rm -rf', payload: {} }) === null);
  ok('type absent rejected', V({ payload: { delta: 10 } }) === null);

  // cal clamping
  ok('cal +200 ok', V({ type: 'cal', payload: { delta: 200 } }).payload.delta === 200);
  ok('cal -200 ok', V({ type: 'cal', payload: { delta: -200 } }).payload.delta === -200);
  ok('cal 0 rejected', V({ type: 'cal', payload: { delta: 0 } }) === null);
  ok('cal 5000 rejected (clamp)', V({ type: 'cal', payload: { delta: 5000 } }) === null);
  ok('cal -9999 rejected (clamp)', V({ type: 'cal', payload: { delta: -9999 } }) === null);
  ok('cal string coerced', V({ type: 'cal', payload: { delta: '150' } }).payload.delta === 150);

  // protein bounds
  ok('pro 170 ok', V({ type: 'pro', payload: { to: 170 } }).payload.to === 170);
  ok('pro 10 rejected', V({ type: 'pro', payload: { to: 10 } }) === null);
  ok('pro 9000 rejected', V({ type: 'pro', payload: { to: 9000 } }) === null);

  // liftReset
  ok('liftReset valid', V({ type: 'liftReset', payload: { name: 'Barbell Bench Press', w: 145, days: 14 } }).payload.w === 145);
  ok('liftReset no name rejected', V({ type: 'liftReset', payload: { w: 145, days: 14 } }) === null);
  ok('liftReset w<=0 rejected', V({ type: 'liftReset', payload: { name: 'X', w: 0, days: 5 } }) === null);
  ok('liftReset days>30 rejected', V({ type: 'liftReset', payload: { name: 'X', w: 100, days: 400 } }) === null);

  // split ops must reference real days/exercises
  const realDay = Object.keys(ev('S').split)[0];
  ok('addEx real day ok', V({ type: 'addEx', payload: { name: 'Face Pull', day: realDay } }) !== null);
  ok('addEx fake day rejected', V({ type: 'addEx', payload: { name: 'Face Pull', day: 'D99' } }) === null);
  ok('swapEx ok', V({ type: 'swapEx', payload: { from: 'A', to: 'B' } }) !== null);
  ok('swapEx missing to rejected', V({ type: 'swapEx', payload: { from: 'A' } }) === null);

  // schedule must be a complete, valid week
  const full = { 0: 'REST', 1: realDay, 2: realDay, 3: realDay, 4: realDay, 5: realDay, 6: 'REST' };
  ok('schedule full week ok', V({ type: 'schedule', payload: { map: full } }) !== null);
  const partial = { 0: 'REST', 1: realDay };
  ok('schedule partial week rejected', V({ type: 'schedule', payload: { map: partial } }) === null);
  const bogus = Object.assign({}, full, { 3: 'D404' });
  ok('schedule bogus day rejected', V({ type: 'schedule', payload: { map: bogus } }) === null);

  ok('deload always valid', V({ type: 'deload', payload: {} }).type === 'deload');

  // ============ apply dispatch actually mutates ============
  console.log('=== APPLY DISPATCH ===');
  ev('S').fuel = ev('S').fuel || {};
  const cal0 = ev('S').fuel.calTarget || 3000;
  ev('agApplyFix')({ type: 'cal', payload: { delta: 250 } });
  ok('cal apply adds delta', ev('S').fuel.calTarget === cal0 + 250, String(ev('S').fuel.calTarget));

  ev('agApplyFix')({ type: 'pro', payload: { to: 175 } });
  ok('pro apply sets target', ev('S').fuel.proTarget === 175);

  ev('agApplyFix')({ type: 'liftReset', payload: { name: 'Test Lift', w: 123, days: 10 } });
  const ovr = ev('invState')().overrides['Test Lift'];
  ok('liftReset writes override', ovr && ovr.w === 123, JSON.stringify(ovr));

  const schedBefore = JSON.stringify(ev('S').schedule);
  ev('agApplyFix')({ type: 'schedule', payload: { map: full } });
  ok('schedule apply mutates', JSON.stringify(ev('S').schedule) !== schedBefore || schedBefore === JSON.stringify(full));

  const dayKey = Object.keys(ev('S').split)[0];
  const nBefore = ev('S').split[dayKey].exercises.length;
  ev('agApplyFix')({ type: 'addEx', payload: { name: 'Cable Face Pull', day: dayKey } });
  ok('addEx appends to split', ev('S').split[dayKey].exercises.length === nBefore + 1);

  // ============ proposal lifecycle ============
  console.log('=== PROPOSAL LIFECYCLE ===');
  const A = ev('agState')();
  A.proposals.length = 0;

  const mk = (over) => Object.assign({
    id: ev('agUid')(), agent: 'delta', title: 'T', reasoning: 'R', fix: null,
    created: ev('todayKey')(),
    expires: ev('dateKeyOf')(new Date(Date.now() + 7 * 86400000)),
    status: 'pending'
  }, over || {});

  const p1 = mk({ fix: { type: 'cal', payload: { delta: 100 } }, agent: 'echo' });
  A.proposals.push(p1);
  ok('agPending sees it', ev('agPending')().length === 1);
  ok('agPendingFor filters by agent', ev('agPendingFor')('echo').length === 1 && ev('agPendingFor')('delta').length === 0);

  const calBefore = ev('S').fuel.calTarget;
  ev('agApprove')(p1.id);
  ok('approve marks approved', p1.status === 'approved', p1.status);
  ok('approve applied the fix', ev('S').fuel.calTarget === calBefore + 100);
  ok('approve logged', A.log.length > 0);
  ok('approved leaves pending queue', ev('agPending')().length === 0);

  const p2 = mk();
  A.proposals.push(p2);
  ev('agReject')(p2.id);
  ok('reject marks rejected', p2.status === 'rejected');
  ok('rejected leaves pending queue', ev('agPending')().length === 0);

  // double-approve must be a no-op
  const calNow = ev('S').fuel.calTarget;
  ev('agApprove')(p1.id);
  ok('re-approving does not re-apply', ev('S').fuel.calTarget === calNow);

  // expiry
  const p3 = mk({ expires: ev('dateKeyOf')(new Date(Date.now() - 2 * 86400000)) });
  A.proposals.push(p3);
  const swept = ev('agSweepExpired')();
  ok('sweep expires stale proposal', p3.status === 'expired' && swept >= 1);
  const p4 = mk();
  A.proposals.push(p4);
  ev('agSweepExpired')();
  ok('sweep spares fresh proposal', p4.status === 'pending');

  // rejected proposals must be fed back so agents stop re-proposing
  ok('context lists rejected proposals', ev('agContext')().indexOf('REJECTED') >= 0);

  // ============ sync-pull must not erase same-day agent state ============
  console.log('=== SYNC PULL PRESERVES AGENT STATE ===');
  const A2 = ev('agState()');
  const today = ev('todayKey()');
  ev("agState().lastRun = todayKey()");
  ev("agState().lastRunAt = new Date().toISOString()");
  ev("agState().status.zulu = {summary:'local run happened', at:new Date().toISOString()}");
  ev("agState().log.unshift({id:'local1', agent:'zulu', text:'local entry', at:new Date().toISOString()})");
  const beforeLastRun = ev('agState().lastRun');
  // simulate a stale cloud snapshot from before today's run (agents key entirely absent,
  // as it would be for a gist written before this feature existed, or an older same-day pull)
  ev("window.__staleDump = JSON.parse(JSON.stringify(S)); delete window.__staleDump.agents;");
  ev("applyPulled(window.__staleDump)");
  ok('lastRun survives a stale pull', ev('agState().lastRun') === beforeLastRun, ev('agState().lastRun'));
  ok('lastRunAt survives a stale pull', !!ev('agState().lastRunAt'));
  ok('local log entry survives a stale pull', ev("agState().log.some(l=>l.id==='local1')"));
  ok('local status survives a stale pull', ev("!!agState().status.zulu"));
  // now simulate a genuinely newer cloud snapshot (a second device ran later) \u2014 that one should win
  ev("window.__newerDump = JSON.parse(JSON.stringify(S)); window.__newerDump.agents.lastRunAt = new Date(Date.now()+999999).toISOString();");
  ev("applyPulled(window.__newerDump)");
  ok('genuinely newer remote timestamp is kept', ev('agState().lastRunAt') === ev('window.__newerDump.agents.lastRunAt'));

  console.log('=== INVESTIGATION HISTORY DELETE SURVIVES A SYNC PULL ===');
  try {
    // Seed a history entry, exactly like a resolved/dismissed flag would look.
    ev("invState().history.unshift({id:'histdeltest1', title:'Test flag', severity:'watch', status:'dismissed', closed:todayKey(), created:todayKey()})");
    ok('history entry seeded', ev("invState().history.some(f=>f.id==='histdeltest1')"));

    // Simulate: local changedAt is stale (last touched a while ago), and the gist
    // already holds this entry from a real push that landed *after* that touch —
    // the exact ordering that happens in practice between two real saves.
    ev('S.meta = S.meta || {}; S.meta.changedAt = Date.now() - 100000;');
    ev("window.__staleRemote = {exportedAt: Date.now() - 50000, data: JSON.parse(JSON.stringify(S))};");

    ev("invDeleteHistory('histdeltest1')");
    ok('entry removed from local state', !ev("invState().history.some(f=>f.id==='histdeltest1')"));

    // The bug: invDeleteHistory used save(false), which never bumps S.meta.changedAt.
    // bgSyncTick/autoPullOnLoad decide whether to pull with exactly this comparison
    // (see iron_hub.html) — if changedAt wasn't bumped past the stale remote's
    // exportedAt, the very next pull overwrites S wholesale and resurrects the
    // "deleted" row.
    const wouldPullStaleData = ev('window.__staleRemote.exportedAt > S.meta.changedAt');
    ok('delete bumps changedAt past the stale remote snapshot (no revert on next pull)', !wouldPullStaleData,
      'changedAt=' + ev('S.meta.changedAt') + ' staleRemoteExportedAt=' + ev('window.__staleRemote.exportedAt'));

    // Demonstrate the actual failure mode this guards against: if the gate had let
    // the stale snapshot through, applyPulled would restore the deleted entry.
    ev('applyPulled(window.__staleRemote.data)');
    ok('sanity: pulling the stale remote directly would have resurrected the entry (confirms the gate is what matters)',
      ev("invState().history.some(f=>f.id==='histdeltest1')"));

    // cleanup: undo the direct applyPulled above and drop the seeded fixture
    ev("invState().history = invState().history.filter(f=>f.id!=='histdeltest1')");
  } catch (e) {
    ok('investigation history delete survives a sync pull', false, e.message);
  }

  console.log('=== LIVE DELTA + CLEAR CHAT ===');
  ok('liveDeltaPanelHTML exists', ev("typeof liveDeltaPanelHTML") === 'function');
  ok('liveDeltaContext exists', ev("typeof liveDeltaContext") === 'function');
  ok('agClearChat exists', ev("typeof agClearChat") === 'function');

  ev("S.settings.apiKey=''");
  ok('no panel without API key', ev('liveDeltaPanelHTML()') === '');
  ev("S.settings.apiKey='sk-test'");

  const dayKey2 = ev("Object.keys(S.split)[0]");
  ev("live = {day: '" + dayKey2 + "', exercises: [{name:'Test Ex', sets:[{w:100,r:8}], done:true}, {name:'Test Ex 2', sets:[], done:false}]}; liveActiveIdx = 1;");
  let liveThrew = false;
  try { ev('renderLive()'); } catch (e) { liveThrew = true; console.log('  renderLive threw:', e.message); }
  ok('renderLive does not throw mid-session', !liveThrew);
  let liveOut = ev("document.getElementById('liveBody').innerHTML");
  ok('LIVE view includes the collapsed DELTA header', liveOut.indexOf('DELTA') >= 0);
  ok('collapsed panel has no composer yet', liveOut.indexOf('liveDeltaIn') === -1);
  // liveDeltaToggle() re-renders LIVE itself \u2014 mirrors the real tap-to-expand interaction
  ev('liveDeltaOpen = false; liveDeltaToggle();');
  liveOut = ev("document.getElementById('liveBody').innerHTML");
  ok('expanded panel shows the composer', liveOut.indexOf('liveDeltaIn') >= 0);
  ev('liveDeltaOpen = false;'); // reset for later sections
  ok('liveDeltaContext reflects in-session state', ev('liveDeltaContext()').indexOf('Test Ex') >= 0);
  ev('live = null');


  ev("S.chat = [{role:'user', content:'hi'}]");
  ev("agState().chats.delta = [{role:'user', content:'hey delta'}]");
  ev("agState().chats.echo = [{role:'user', content:'hey echo'}]");
  ev("agClearChat('zulu')");
  ok('clearing zulu empties S.chat', ev('S.chat.length') === 0);
  ok('clearing zulu leaves delta chat untouched', ev('agState().chats.delta.length') === 1);
  ev("agClearChat('delta')");
  ok('clearing delta empties only delta', ev('agState().chats.delta.length') === 0);
  ok('echo chat still untouched', ev('agState().chats.echo.length') === 1);


  console.log('=== JSON PARSE HARDENING ===');
  // the exact shape that broke the real cycle: valid JSON followed by prose containing a brace
  const trailing = '{"zulu":{"summary":"ok","proposals":[]}}\nNote: the {schedule} fix was skipped.';
  let parsedTrailing = null, parseThrew = false;
  try { parsedTrailing = ev('parseLooseJSON(' + JSON.stringify(trailing) + ')'); }
  catch (e) { parseThrew = true; console.log('  parse threw:', e.message); }
  ok('parses JSON followed by brace-containing prose', !parseThrew && !!parsedTrailing);
  ok('extracted the right object', parsedTrailing && parsedTrailing.zulu && parsedTrailing.zulu.summary === 'ok');
  // still handles the normal cases
  ok('plain JSON still parses', ev('parseLooseJSON(\'{"a":1}\')').a === 1);
  ok('fenced JSON still parses', ev("parseLooseJSON('```json\\n{\"a\":2}\\n```')").a === 2);
  ok('leading prose still parses', ev("parseLooseJSON('Here you go:\\n{\"a\":3}')").a === 3);

  console.log('=== FAILURE CLOSES THE DAILY GATE ===');
  ev("window.__realCall = callClaudeWithTools;");

  // Case 1: the API call itself throws (network, 401, rate limit)
  ev("agState().lastRun = ''; agState().lastRunAt = '';");
  ev("S.settings.apiKey = 'sk-test'");
  ev("callClaudeWithTools = async () => { throw new Error('API 429: rate limited'); };");
  await ev('agRunAll(true)');
  ok('[api throw] lastRun still stamped', ev('agState().lastRun') === ev('todayKey()'),
     'lastRun=' + ev('agState().lastRun'));
  ok('[api throw] failure was logged', ev("agState().log.some(l=>/Cycle failed/.test(l.text))"));
  ok('[api throw] in-flight flag released', ev('_agRunning') === false);

  // Case 2: a response with no JSON at all \u2014 genuinely unparseable, not recoverable
  ev("agState().lastRun = ''; agState().lastRunAt = '';");
  ev("callClaudeWithTools = async () => ({text:'I could not complete that request.', actions:[]});");
  await ev('agRunAll(true)');
  ok('[bad json] lastRun still stamped', ev('agState().lastRun') === ev('todayKey()'),
     'lastRun=' + ev('agState().lastRun'));
  ok('[bad json] in-flight flag released', ev('_agRunning') === false);

  // with the gate closed, the scheduler must not fire a second cycle
  ev("window.__realRun = agRunAll; agRunAll = () => { window.__refired = true; };");
  ev("window.__refired = false; agState().autoRun = true;");
  ev('agMaybeAutoRun()');
  ok('scheduler does not re-fire after a failed cycle', ev('window.__refired') === false);

  // but the manual button deliberately ignores the gate
  ev("window.__refired = false;");
  ev('agRunAll(true)');
  ok('manual run still works despite the closed gate', ev('window.__refired') === true);

  ev("agRunAll = window.__realRun; callClaudeWithTools = window.__realCall;");


  console.log('=== _running NOT PERSISTED ===');
  ok('_agRunning is module-scoped, not on S', ev("!('_running' in agState())"));
  ev("agState()._running = true; agState();");
  ok('legacy persisted _running is purged', ev("!('_running' in agState())"));

  console.log('=== LIVE REFRESH GUARDS ===');
  ok('refreshBlocked exists', ev('typeof refreshBlocked') === 'function');
  ok('rerenderActive exists', ev('typeof rerenderActive') === 'function');
  ok('bgSyncTick exists', ev('typeof bgSyncTick') === 'function');
  ev('live = null; MODE = "review";');
  ok('not blocked when idle in review', ev('refreshBlocked()') === false);
  // must refuse to repaint during an active LIVE session (would wipe typed dock values)
  ev("live = {day:'D1', exercises:[{name:'X', sets:[], done:false}]}; MODE='live';");
  ok('blocked during an active LIVE session', ev('refreshBlocked()') === true);
  ev('live = null; MODE = "review";');
  // must refuse to repaint while a field is focused
  ev("var _ti=document.createElement('input'); _ti.id='__focustest'; document.body.appendChild(_ti); _ti.focus();");
  ok('blocked while an input has focus', ev('refreshBlocked()') === true);
  ev("document.getElementById('__focustest').blur(); document.getElementById('__focustest').remove();");
  ok('unblocked after blur', ev('refreshBlocked()') === false);
  let rerenderThrew = false;
  try { ev('rerenderActive()'); } catch (e) { rerenderThrew = true; }
  ok('rerenderActive does not throw', !rerenderThrew);

  console.log('=== PULL LANDING MID-CYCLE (stale reference) ===');
  // The real-world failure: a background gist pull completes during the ~60s API call.
  // applyPulled replaces S wholesale, so anything written through a reference captured before
  // the await lands on an orphaned object and is silently dropped by save().
  ev("window.__realCall2 = callClaudeWithTools;");
  ev("agState().lastRun = ''; agState().lastRunAt = ''; agState().status = {};");
  ev("S.settings.apiKey = 'sk-test'");
  // mid-flight, simulate the pull swapping S out from under the running cycle
  ev(`callClaudeWithTools = async () => {
        window.__midDump = JSON.parse(JSON.stringify(S));
        window.__midDump.agents.lastRun = '2020-01-01';
        window.__midDump.agents.lastRunAt = '2020-01-01T00:00:00.000Z';
        window.__midDump.agents.status = {};
        applyPulled(window.__midDump);
        return {text: JSON.stringify({zulu:{summary:'brief after swap',proposals:[]},
                                      delta:{summary:'d',proposals:[]},
                                      charlie:{summary:'c',proposals:[]},
                                      echo:{summary:'e',proposals:[]}}), actions:[]};
      };`);
  await ev('agRunAll(true)');
  ok('lastRun survives a pull landing mid-cycle', ev('agState().lastRun') === ev('todayKey()'),
     'lastRun=' + ev('agState().lastRun'));
  ok('lastRunAt is not the pre-pull stale value', ev('agState().lastRunAt') !== '2020-01-01T00:00:00.000Z',
     'lastRunAt=' + ev('agState().lastRunAt'));
  ok('agent status lands on the live state object', ev("!!agState().status.zulu"),
     'status=' + JSON.stringify(ev('agState().status')));
  ok('status content is from this cycle', ev("agState().status.zulu && agState().status.zulu.summary") === 'brief after swap');
  ok('log entries also survived', ev("agState().log.some(l=>/brief after swap/.test(l.text))"));
  // and the gate is genuinely closed now
  ev("window.__realRun2 = agRunAll; agRunAll = () => { window.__refired2 = true; };");
  ev("window.__refired2 = false; agState().autoRun = true;");
  ev('agMaybeAutoRun()');
  ok('no re-fire after a mid-cycle pull', ev('window.__refired2') === false);
  ev("agRunAll = window.__realRun2; callClaudeWithTools = window.__realCall2;");

  console.log('=== ENSEMBLE PREDICTIONS ===');
  ok('anEnsembleFor exists', ev('typeof anEnsembleFor') === 'function');
  ok('anResidualStd exists', ev('typeof anResidualStd') === 'function');
  ok('anEnsembleCardHTML exists', ev('typeof anEnsembleCardHTML') === 'function');
  ok('anEnsembleChartSVG exists', ev('typeof anEnsembleChartSVG') === 'function');

  // build a clean, known synthetic trend so the math is checkable by hand:
  // +2 lb/week for 8 weeks on a lift with no other history, zero noise.
  ev(`(function(){
    S.logs = (S.logs||[]).filter(l => !l.entries.some(e=>e.exercise==='Ens Test Lift'));
    const start = new Date('2026-01-01T00:00:00');
    for(let i=0;i<8;i++){
      const d = new Date(start.getTime() + i*7*86400000);
      const w = 100 + i*2; // clean +2lb/wk, no noise
      S.logs.push({date: d.toISOString().slice(0,10), entries:[{exercise:'Ens Test Lift', sets:[{w:w, r:1}]}]});
    }
  })();`);

  const noNoise = ev("anEnsembleFor('Ens Test Lift', 84)");
  ok('resolves ok with enough history', noNoise.ok === true, JSON.stringify(noNoise.why));
  ok('zero-noise data collapses all three bands together',
     Math.abs(noNoise.series['10'][8].v - noNoise.series['90'][8].v) < 0.5,
     'p10=' + noNoise.series['10'][8].v + ' p90=' + noNoise.series['90'][8].v);
  ok('median line trends upward with a clean positive slope', noNoise.perWeek > 1.5 && noNoise.perWeek < 2.5,
     'perWeek=' + noNoise.perWeek);
  ok('all three bands start at the real current e1RM', 
     noNoise.series['10'][0].v === noNoise.cur && noNoise.series['90'][0].v === noNoise.cur);

  // now inject real noise and confirm the bands actually separate and order correctly
  ev(`(function(){
    S.logs = (S.logs||[]).filter(l => !l.entries.some(e=>e.exercise==='Ens Noisy Lift'));
    const start = new Date('2026-01-01T00:00:00');
    const noisy = [100,103,99,107,102,110,105,115]; // upward but bouncy
    noisy.forEach((w,i)=>{
      const d = new Date(start.getTime() + i*7*86400000);
      S.logs.push({date: d.toISOString().slice(0,10), entries:[{exercise:'Ens Noisy Lift', sets:[{w:w, r:1}]}]});
    });
  })();`);
  const noisy = ev("anEnsembleFor('Ens Noisy Lift', 84)");
  ok('noisy lift resolves ok', noisy.ok === true);
  ok('p10 <= p50 <= p90 at every sampled point', ev(`(function(){
    var r = anEnsembleFor('Ens Noisy Lift', 84);
    for(var i=0;i<r.series['50'].length;i++){
      if(!(r.series['10'][i].v <= r.series['50'][i].v + 0.01 && r.series['50'][i].v <= r.series['90'][i].v + 0.01)) return false;
    }
    return true;
  })()`) === true);
  ok('noisy data produces real separation between bands', 
     (noisy.series['90'][8].v - noisy.series['10'][8].v) > 3,
     'spread=' + (noisy.series['90'][8].v - noisy.series['10'][8].v));
  ok('band spread widens further into the future (sqrt-time growth)', (() => {
    const near = noisy.series['90'][2].v - noisy.series['10'][2].v;
    const far  = noisy.series['90'][14].v - noisy.series['10'][14].v;
    return far > near;
  })(), 'near=' + (noisy.series['90'][2].v-noisy.series['10'][2].v) + ' far=' + (noisy.series['90'][14].v-noisy.series['10'][14].v));

  // insufficient history must fail closed with a reason, not throw or fabricate a trend
  ev("S.logs = (S.logs||[]).filter(l => !l.entries.some(e=>e.exercise==='Ens Sparse Lift')); S.logs.push({date:'2026-06-01', entries:[{exercise:'Ens Sparse Lift', sets:[{w:100,r:1}]}]});");
  const sparse = ev("anEnsembleFor('Ens Sparse Lift', 84)");
  ok('sparse history fails closed with a reason', sparse.ok === false && !!sparse.why);

  // chart SVG must not throw and must contain all three percentile colors
  let chartThrew = false, svgOut = '';
  try { svgOut = ev("anEnsembleChartSVG(anEnsembleFor('Ens Noisy Lift', 84), 640, 220)"); }
  catch (e) { chartThrew = true; console.log('  chart threw:', e.message); }
  ok('chart SVG renders without throwing', !chartThrew);
  ok('chart SVG is well-formed svg markup', svgOut.startsWith('<svg') && svgOut.endsWith('</svg>'));
  ok('chart SVG references all three band colors', ['var(--dim)', 'var(--amber)', 'var(--cyan)'].every(c => svgOut.indexOf(c) >= 0));

  // dropdown wiring: selecting an exercise/range persists and reflects in the rendered card
  ev("anEnsembleChangeEx('Ens Noisy Lift')");
  ok('exercise selection persists', ev('anEnsembleEx') === 'Ens Noisy Lift');
  ev("anEnsembleChangeRange(365)");
  ok('range selection persists', ev('anEnsembleRange') === 365);
  let cardOut = '';
  try { cardOut = ev('anEnsembleCardHTML()'); } catch (e) { console.log('  card threw:', e.message); }
  ok('card HTML includes the selected exercise as the chosen option', 
     new RegExp('<option value="Ens Noisy Lift"[^>]*selected').test(cardOut));
  ok('card HTML includes a working select/chart', cardOut.indexOf('<select') >= 0 && cardOut.indexOf('<svg') >= 0);

  // full Predictions tab render must not throw with the ensemble card embedded
  ev("anEnsembleEx = null;"); // simulate first-ever visit, nothing chosen yet
  let predThrew = false;
  try { ev('renderAnPred()'); } catch (e) { predThrew = true; console.log('  renderAnPred threw:', e.message); }
  ok('renderAnPred does not throw with ensemble embedded', !predThrew);
  const predOut = ev("document.getElementById('an_pred').innerHTML");
  ok('Predictions tab includes the Ensemble projection card', predOut.indexOf('Ensemble projection') >= 0);

  // cleanup synthetic data so it doesn't bleed into other sections' assertions
  ev("S.logs = (S.logs||[]).filter(l => !l.entries.some(e=>/^Ens /.test(e.exercise)));");


  console.log('=== CHAT SEND WIRING ===');
  // The prior suite only checked that the composer RENDERED, never that Send worked. ZULU
  // routes through the legacy sendChat(), which was still reading the removed Coach element
  // IDs \u2014 it threw a TypeError on every send while DELTA/CHARLIE/ECHO worked fine.
  ev("S.settings.apiKey = 'sk-test'");
  ev("window.__realCall3 = callClaudeWithTools;");
  ev("callClaudeWithTools = async () => ({text:'ack from agent', actions:[]});");

  // every agent's rendered composer must match the ID its send handler reads
  for (const who of ['zulu', 'charlie', 'delta', 'echo']) {
    ev("agSelectChat('" + who + "')");
    ev('renderOps()');
    const hasComposer = ev("!!document.getElementById('agChatIn')");
    ok('[' + who + '] composer element exists after render', hasComposer);
  }

  // ZULU: type into the real composer and invoke the real handler
  ev("agSelectChat('zulu'); renderOps();");
  ev("S.chat = [];");
  ev("document.getElementById('agChatIn').value = 'zulu ping';");
  let zuluThrew = false;
  try { await ev('sendChat()'); } catch (e) { zuluThrew = true; console.log('  sendChat threw:', e.message); }
  ok('ZULU sendChat does not throw', !zuluThrew);
  ok('ZULU user message was recorded', ev("S.chat.some(m=>m.role==='user' && m.content==='zulu ping')"),
     'chat=' + JSON.stringify(ev('S.chat')));
  ok('ZULU assistant reply was recorded', ev("S.chat.some(m=>m.role==='assistant' && /ack from agent/.test(m.content||''))"));

  // a non-lead agent through its own handler
  ev("agSelectChat('delta'); renderOps();");
  ev("agState().chats.delta = [];");
  ev("document.getElementById('agChatIn').value = 'delta ping';");
  let deltaThrew = false;
  try { await ev("agSendChat('delta')"); } catch (e) { deltaThrew = true; console.log('  agSendChat threw:', e.message); }
  ok('DELTA agSendChat does not throw', !deltaThrew);
  ok('DELTA user message was recorded', ev("agState().chats.delta.some(m=>m.role==='user' && m.content==='delta ping')"));
  ok('DELTA assistant reply was recorded', ev("agState().chats.delta.some(m=>m.role==='assistant')"));

  // empty input must be a clean no-op, not an error or a blank message
  ev("S.chat = [];");
  ev("agSelectChat('zulu'); renderOps();");
  ev("document.getElementById('agChatIn').value = '   ';");
  let emptyThrew = false;
  try { await ev('sendChat()'); } catch (e) { emptyThrew = true; }
  ok('whitespace-only input is a clean no-op', !emptyThrew && ev('S.chat.length') === 0);

  ev("callClaudeWithTools = window.__realCall3;");

  console.log('=== ADVISORY PROPOSALS FOLD INTO LOG, NOT THE QUEUE ===');
  ev("agState().lastRun = ''; agState().lastRunAt = ''; agState().proposals = []; agState().log = [];");
  ev("S.settings.apiKey = 'sk-test'");
  ev("window.__realCall4 = callClaudeWithTools;");
  ev(`callClaudeWithTools = async () => ({text: JSON.stringify({
        zulu:{summary:'brief', proposals:[
          {title:'Watch Thursday squat session', reasoning:'fatigue is elevated', fix:null}
        ]},
        delta:{summary:'d', proposals:[
          {title:'Bump bench volume', reasoning:'trend is clean', fix:{type:'cal', payload:{delta:100}}}
        ]},
        charlie:{summary:'c', proposals:[]},
        echo:{summary:'e', proposals:[]}
      }), actions:[]});`);
  await ev('agRunAll(true)');
  ok('advisory-only proposal is NOT in the queue', ev("agState().proposals.some(p=>p.title==='Watch Thursday squat session')") === false,
     JSON.stringify(ev('agState().proposals')));
  ok('advisory text is preserved in the activity log instead', ev("agState().log.some(l=>/Watch Thursday squat session/.test(l.text))"));
  ok('a real fix still reaches the queue normally', ev("agState().proposals.some(p=>p.title==='Bump bench volume' && p.fix && p.fix.type==='cal')"));
  ok('queue contains exactly one entry (the real fix, not the advisory)', ev('agState().proposals.length') === 1,
     'count=' + ev('agState().proposals.length'));

  // a malformed fix (invalid shape, not explicitly null) must still be silently dropped \u2014
  // that's a model error, not an intentional advisory, so it should NOT get logged as one
  ev("agState().proposals = []; agState().log = [];");
  ev(`callClaudeWithTools = async () => ({text: JSON.stringify({
        zulu:{summary:'brief2', proposals:[
          {title:'Bad fix attempt', reasoning:'r', fix:{type:'cal', payload:{delta:99999}}}
        ]}
      }), actions:[]});`);
  await ev('agRunAll(true)');
  ok('malformed fix does not reach the queue', ev("agState().proposals.some(p=>p.title==='Bad fix attempt')") === false);
  ok('malformed fix is NOT folded into the log as if it were an advisory', 
     ev("!agState().log.some(l=>/Bad fix attempt/.test(l.text))"));

  ev("callClaudeWithTools = window.__realCall4;");

  // Re-resolve fresh here rather than reusing the `A` captured near the top of this file:
  // several sections since then (SYNC PULL, PULL LANDING MID-CYCLE) call applyPulled(), which
  // replaces S wholesale \u2014 the exact stale-reference class this whole session was about,
  // now caught in the test harness itself rather than the app.
  console.log('=== CHAT UX: ANIMATION / EXPAND / SCROLL / REFRESH ===');
  ev("S.settings.apiKey = 'sk-test'");
  ev("window.__realCall5 = callClaudeWithTools;");
  ev("callClaudeWithTools = async () => ({text:'reply body', actions:[]});");

  // --- animation: only genuinely new messages get the entrance class ---
  ev("agSelectChat('echo'); agState().chats.echo = []; for(var k in agSeen) delete agSeen[k]; renderOps();");
  ev("agState().chats.echo = [{role:'user',content:'old one'},{role:'assistant',content:'old two'}];");
  ev("delete agSeen['echo']; renderOps();");
  let out = ev("document.getElementById('agChatBox').innerHTML");
  ok('existing history does not animate on first view', (out.match(/ag-new/g) || []).length === 0,
     'ag-new count=' + (out.match(/ag-new/g) || []).length);
  // a genuinely new message should animate
  ev("agState().chats.echo.push({role:'assistant',content:'brand new'}); renderOps();");
  out = ev("document.getElementById('agChatBox').innerHTML");
  ok('a newly arrived message gets the animation class', (out.match(/ag-new/g) || []).length === 1,
     'ag-new count=' + (out.match(/ag-new/g) || []).length);
  // repainting again must NOT re-animate it
  ev('renderOps()');
  out = ev("document.getElementById('agChatBox').innerHTML");
  ok('repaint does not re-animate the same message', (out.match(/ag-new/g) || []).length === 0);

  // --- expand toggle ---
  ev("agChatTall = false; renderOps();");
  ok('chat box not tall by default', ev("document.getElementById('agChatBox').className").indexOf('tall') === -1);
  ev('agChatToggleTall()');
  ok('expand toggle adds tall class', ev("document.getElementById('agChatBox').className").indexOf('tall') >= 0);
  ok('expand button now reads Shrink', ev("document.getElementById('ops').innerHTML").indexOf('Shrink') >= 0);
  ev('agChatToggleTall()');
  ok('toggle returns to normal height', ev("document.getElementById('agChatBox').className").indexOf('tall') === -1);

  // --- typing indicator ---
  ev("agThinkingFor = 'echo'; renderOps();");
  ok('typing indicator shows for the active agent', ev("document.getElementById('agChatBox').innerHTML").indexOf('ag-typing') >= 0);
  ev("agThinkingFor = 'delta'; renderOps();");
  ok('typing indicator hidden when another agent is thinking',
     ev("document.getElementById('agChatBox').innerHTML").indexOf('ag-typing') === -1);
  ev("agThinkingFor = null; renderOps();");

  // --- error surfaces in-box rather than throwing ---
  ev("callClaudeWithTools = async () => { throw new Error('boom'); };");
  ev("agSelectChat('echo'); renderOps();");
  ev("document.getElementById('agChatIn').value = 'trigger failure';");
  let errThrew = false;
  try { await ev("agSendChat('echo')"); } catch (e) { errThrew = true; }
  ok('chat error does not throw', !errThrew);
  ok('chat error is shown in the transcript', ev("document.getElementById('agChatBox').innerHTML").indexOf('unavailable') >= 0);
  ok('typing indicator cleared after failure', ev('agThinkingFor') === null);
  ev("callClaudeWithTools = async () => ({text:'reply body', actions:[]});");
  ev("agChatErr = null;");

  // --- live refresh must not churn the chat when nothing changed ---
  ev("MODE = 'review'; activeMainTab = 'ops'; activeReviewTab = 'ops'; navMemory.ops = 'ops';");
  ev('renderOps()');
  ev("window.__renderCount = 0; window.__realRenderOps = renderOps;");
  // count repaints triggered by the refresh tick while nothing changes
  const sigBefore = ev('opsSignature()');
  ev('rerenderActive()');
  ok('signature is stable when nothing changed', ev('opsSignature()') === sigBefore);
  ok('rerenderActive skips repaint when ops signature is unchanged', ev('opsSignature() === _opsSig') === true);
  // a real change must break the signature so the tab does update
  ev("agState().log.unshift({id:'sigtest', agent:'zulu', text:'something happened', at:new Date().toISOString()});");
  ok('signature changes when the log grows', ev('opsSignature()') !== sigBefore);

  // --- scroll preservation ---
  ev("agSelectChat('echo'); agState().chats.echo = [];");
  ev("for(var i=0;i<40;i++) agState().chats.echo.push({role: i%2?'assistant':'user', content:'filler message '+i});");
  ev("delete agSeen['echo']; renderOps();");
  ev(`(function(){
      var b = document.getElementById('agChatBox');
      // jsdom has no layout, so fake the metrics a real browser would provide
      Object.defineProperty(b, 'scrollHeight', {value: 2000, configurable: true});
      Object.defineProperty(b, 'clientHeight', {value: 300, configurable: true});
      b.scrollTop = 100; // user has scrolled well up to read history
    })();`);
  ev('renderOps()');
  ok('scroll position preserved when user has scrolled up', ev("document.getElementById('agChatBox').scrollTop") === 100,
     'scrollTop=' + ev("document.getElementById('agChatBox').scrollTop"));
  // but if they were already at the bottom, stay pinned to the bottom.
  // NOTE: jsdom has no layout engine, so the fresh post-innerHTML box reports scrollHeight 0
  // and "pinned to bottom" lands at 0. What's verifiable here is the BRANCH taken: restoring
  // the prior offset would leave 1700, so anything else proves it chose to pin instead.
  ev(`(function(){
      var b = document.getElementById('agChatBox');
      Object.defineProperty(b, 'scrollHeight', {value: 2000, configurable: true});
      Object.defineProperty(b, 'clientHeight', {value: 300, configurable: true});
      b.scrollTop = 1700; // at the bottom
    })();`);
  ev('renderOps()');
  ok('pins to bottom (does not restore prior offset) when already at bottom',
     ev("document.getElementById('agChatBox').scrollTop") !== 1700,
     'scrollTop=' + ev("document.getElementById('agChatBox').scrollTop"));

  ev("callClaudeWithTools = window.__realCall5;");
  ev("agState().chats.echo = []; agChatErr = null; agThinkingFor = null;");

  console.log('=== MAXED FLAG ===');
  ok('isMaxed exists', ev('typeof isMaxed') === 'function');
  ok('toggleMaxed exists', ev('typeof toggleMaxed') === 'function');
  ok('maxedList exists', ev('typeof maxedList') === 'function');

  const mDay = ev("Object.keys(S.split)[0]");
  ev("S.split['" + mDay + "'].exercises.push({name:'Maxed Machine', inc:5});");
  const mIdx = ev("S.split['" + mDay + "'].exercises.length - 1");
  ok('not maxed before toggling', ev("isMaxed('Maxed Machine')") === false);
  ev("toggleMaxed('" + mDay + "'," + mIdx + ")");
  ok('toggle sets the flag', ev("isMaxed('Maxed Machine')") === true);
  ok('maxedList reports it', ev("maxedList().indexOf('Maxed Machine')") >= 0);

  // flag must apply to the same machine on every day it appears
  const mDay2 = ev("Object.keys(S.split)[1]");
  if (mDay2) {
    ev("S.split['" + mDay2 + "'].exercises.push({name:'Maxed Machine', inc:5});");
    ev("toggleMaxed('" + mDay + "'," + mIdx + ")");  // off
    ev("toggleMaxed('" + mDay + "'," + mIdx + ")");  // on again, should propagate
    ok('flag propagates across days', ev(`(function(){
      var n=0; for(var d in S.split){ (S.split[d].exercises||[]).forEach(function(x){
        if(typeof x==='object' && x.name==='Maxed Machine' && x.maxed) n++; }); } return n; })()`) === 2);
  }

  // investigation: a flat trend on a maxed lift must NOT be flagged
  ev(`(function(){
    S.logs = (S.logs||[]).filter(function(l){ return !l.entries.some(function(e){ return e.exercise==='Maxed Machine'; }); });
    var start = new Date('2026-04-01T00:00:00');
    for(var i=0;i<6;i++){
      var d = new Date(start.getTime() + i*7*86400000);
      S.logs.push({date:d.toISOString().slice(0,10), entries:[{exercise:'Maxed Machine', sets:[{w:200,r:10}]}]});
    }
  })();`);
  const mFlat = ev("investigateLift('Maxed Machine')");
  ok('flat maxed lift is not flagged', mFlat.severity === null, 'severity=' + mFlat.severity);
  ok('flat maxed lift explains the ceiling', /MAXED|ceiling/.test(JSON.stringify(mFlat.findings)));

  // same data, NOT maxed, should flag as flat
  ev("for(var d in S.split){ (S.split[d].exercises||[]).forEach(function(x){ if(typeof x==='object' && x.name==='Maxed Machine') x.maxed=false; }); }");
  const mFlat2 = ev("investigateLift('Maxed Machine')");
  ok('same flat data DOES flag when not maxed', mFlat2.severity === 'yellow', 'severity=' + mFlat2.severity);
  ev("for(var d in S.split){ (S.split[d].exercises||[]).forEach(function(x){ if(typeof x==='object' && x.name==='Maxed Machine') x.maxed=true; }); }");

  // progression: hitting the rep ceiling must not propose more load
  const mDec = ev("classifyDecision('Maxed Machine','normal')");
  ok('maxed lift never proposes a load increase', mDec.moved === false, 'code=' + mDec.code + ' moved=' + mDec.moved);
  ok('maxed decision points at reps/sets instead', /rep|set|eccentric|ceiling/i.test(mDec.reason || ''), mDec.reason);

  // agent context must warn the agents off proposing load
  const mCtx = ev('agContext()');
  ok('agent context lists maxed lifts', mCtx.indexOf('Maxed Machine') >= 0 && /MAXED OUT/.test(mCtx));
  ok('agent context forbids adding load to them', /NEVER propose adding load/.test(mCtx));

  // predictions must not forecast a higher weight
  const mPred = ev("anPredictFor('Maxed Machine')");
  ok('prediction marks the lift as maxed', mPred.maxed === true);
  ok('prediction gives no weight ETA', !mPred.etas || mPred.etas.length === 0);

  // cleanup
  ev(`(function(){
    S.logs = (S.logs||[]).filter(function(l){ return !l.entries.some(function(e){ return e.exercise==='Maxed Machine'; }); });
    for(var d in S.split){ S.split[d].exercises = (S.split[d].exercises||[]).filter(function(x){ return !(typeof x==='object' && x.name==='Maxed Machine'); }); }
  })();`);

  console.log('=== BACKOFF SETS ===');
  ok('backoffWeightFor exists', ev('typeof backoffWeightFor') === 'function');
  ok('isNoBackoff exists', ev('typeof isNoBackoff') === 'function');

  const bDay = ev("Object.keys(S.split)[0]");
  ev("S.split['" + bDay + "'].exercises.push({name:'Backoff Bar', inc:5, repMode:'str'});");
  const bIdx = ev("S.split['" + bDay + "'].exercises.length - 1");

  ok('strength lift gets a backoff weight', ev("backoffWeightFor('Backoff Bar', 225)") === 205,
     'got=' + ev("backoffWeightFor('Backoff Bar', 225)"));
  ok('backoff rounds to the exercise increment', ev("backoffWeightFor('Backoff Bar', 225) % 5") === 0);
  ok('backoff is always at least one increment below top',
     ev("backoffWeightFor('Backoff Bar', 10)") < 10, 'got=' + ev("backoffWeightFor('Backoff Bar', 10)"));

  // hypertrophy lifts must NOT get backoff
  ev("S.split['" + bDay + "'].exercises.push({name:'Hyp Cable', inc:5});");
  ok('hypertrophy lift gets no backoff', ev("backoffWeightFor('Hyp Cable', 100)") === null);

  // opt-out
  ev("toggleNoBackoff('" + bDay + "'," + bIdx + ")");
  ok('opt-out flag set', ev("isNoBackoff('Backoff Bar')") === true);
  ok('opted-out lift gets no backoff', ev("backoffWeightFor('Backoff Bar', 225)") === null);
  ev("toggleNoBackoff('" + bDay + "'," + bIdx + ")");
  ok('opt-out toggles back off', ev("isNoBackoff('Backoff Bar')") === false);
  ok('backoff returns after re-enabling', ev("backoffWeightFor('Backoff Bar', 225)") === 205);

  // intraAdvice: after a clean top set, suggest the backoff weight
  const advClean = ev(`intraAdvice({name:'Backoff Bar', targetW:225, backoffW:205, lo:3, hi:6,
    sets:[{w:225, r:5, e:'easy'}]})`);
  ok('after top set, advice drops to backoff weight', advClean.w === 205, 'w=' + advClean.w);
  ok('backoff advice is tagged', advClean.tag === 'Backoff');

  // a FAILED top set must take precedence \u2014 never suggest heavier than the safety response
  const advFail = ev(`intraAdvice({name:'Backoff Bar', targetW:225, backoffW:205, lo:3, hi:6,
    sets:[{w:225, r:1, e:'fail'}]})`);
  ok('failed top set keeps the safety back-off, not the scheme', advFail.cls === 'back', 'cls=' + advFail.cls);
  ok('failed set never suggests more than the autoregulated weight', advFail.w <= 220, 'w=' + advFail.w);

  // first set of the session still gets the top weight
  const advFirst = ev(`intraAdvice({name:'Backoff Bar', targetW:225, backoffW:205, lo:3, hi:6,
    recDetail:'x', sets:[]})`);
  ok('first set still prescribes the top weight', advFirst.w === 225);

  // backoff must not compound downward set after set
  const advThird = ev(`intraAdvice({name:'Backoff Bar', targetW:225, backoffW:205, lo:3, hi:6,
    sets:[{w:225,r:5,e:'easy'},{w:205,r:6,e:''}]})`);
  ok('third set holds backoff weight rather than dropping again', advThird.w === 205, 'w=' + advThird.w);

  ev(`(function(){
    for(var d in S.split){ S.split[d].exercises = (S.split[d].exercises||[]).filter(function(x){
      return !(typeof x==='object' && (x.name==='Backoff Bar' || x.name==='Hyp Cable')); }); }
  })();`);

  console.log('=== WORKOUT FUEL TIMING ===');
  ok('fuelClockFrom exists', ev('typeof fuelClockFrom') === 'function');
  ok('fuelTimingHTML exists', ev('typeof fuelTimingHTML') === 'function');
  ok('fuelFoodAllowed exists', ev('typeof fuelFoodAllowed') === 'function');

  // clock math, including the offsets the windows actually use
  ok('computes a pre-workout time', ev("fuelClockFrom('17:00', -165)") === '2:15 PM',
     ev("fuelClockFrom('17:00', -165)"));
  ok('computes a post-workout time', ev("fuelClockFrom('17:00', 120)") === '7:00 PM',
     ev("fuelClockFrom('17:00', 120)"));
  ok('wraps backwards past midnight', ev("fuelClockFrom('01:00', -165)") === '10:15 PM',
     ev("fuelClockFrom('01:00', -165)"));
  ok('wraps forwards past midnight', ev("fuelClockFrom('23:30', 120)") === '1:30 AM',
     ev("fuelClockFrom('23:30', 120)"));
  ok('handles noon correctly', ev("fuelClockFrom('12:00', 0)") === '12:00 PM', ev("fuelClockFrom('12:00', 0)"));
  ok('handles midnight correctly', ev("fuelClockFrom('00:00', 0)") === '12:00 AM', ev("fuelClockFrom('00:00', 0)"));
  ok('rejects malformed time', ev("fuelClockFrom('', -60)") === null);

  // exclusion filtering \u2014 the important correctness property
  ev("fuelInit(); S.fuel.dislikes = 'eggs, cup yogurt, rice, cottage cheese'; S.fuel.limits = '';");
  const toks = ev('fuelExclusionTokens()');
  ok('parses exclusion tokens', toks.indexOf('eggs') >= 0 && toks.indexOf('cottage cheese') >= 0,
     JSON.stringify(toks));
  ok('blocks an excluded food', ev("fuelFoodAllowed({n:'Scrambled eggs + toast', t:['egg']}, fuelExclusionTokens())") === false);
  ok('allows a non-excluded food', ev("fuelFoodAllowed({n:'Chicken breast + potato', t:['chicken']}, fuelExclusionTokens())") === true);
  ok('blocks by tag as well as name', ev("fuelFoodAllowed({n:'Breakfast bowl', t:['rice']}, fuelExclusionTokens())") === false);

  // a real render must not surface anything from the exclusion list
  ev("S.fuel.workoutTime = '17:00'; S.fuel.sessionLen = 60;");
  let fuelHtml = '';
  let fuelThrew = false;
  try { fuelHtml = ev('fuelTimingHTML()'); } catch (e) { fuelThrew = true; console.log('  threw:', e.message); }
  ok('fuelTimingHTML does not throw', !fuelThrew);
  ok('renders all six timing windows', (fuelHtml.match(/fuel-slot/g) || []).length === 6,
     'windows=' + (fuelHtml.match(/fuel-slot/g) || []).length);
  ok('renders computed clock times', fuelHtml.indexOf('2:15 PM') >= 0);
  ok('no excluded food appears in the output', !/cottage cheese|scrambled egg/i.test(fuelHtml));
  ok('includes the nausea guidance', /nausea/i.test(fuelHtml));
  ok('nausea guidance points to a doctor for persistent cases', /doctor/i.test(fuelHtml));

  // session-length gating: during-workout carbs only on longer sessions
  ev("S.fuel.sessionLen = 60;");
  const shortHtml = ev('fuelTimingHTML()');
  ev("S.fuel.sessionLen = 90;");
  const longHtml = ev('fuelTimingHTML()');
  ok('short session hides during-workout sports drink', shortHtml.indexOf('Sports drink, sipped') === -1);
  ok('long session shows during-workout sports drink', longHtml.indexOf('Sports drink, sipped') >= 0);
  ok('water advice shows regardless of length', shortHtml.indexOf('Water') >= 0 && longHtml.indexOf('Water') >= 0);

  // no time set = prompt, not a broken plan
  ev("S.fuel.workoutTime = '';");
  const emptyHtml = ev('fuelTimingHTML()');
  ok('prompts for a time when none set', /Pick a time/.test(emptyHtml));
  ok('shows no windows without a time', (emptyHtml.match(/fuel-slot/g) || []).length === 0);

  // full tab render
  ev("S.fuel.workoutTime = '17:00';");
  let renderThrew = false;
  try { ev('renderFuel()'); } catch (e) { renderThrew = true; console.log('  renderFuel threw:', e.message); }
  ok('renderFuel does not throw with the planner embedded', !renderThrew);
  ok('Fuel tab contains the timing section', ev("document.getElementById('fuel').innerHTML").indexOf('Workout Fuel Timing') >= 0);

  console.log('=== ROTATING CYCLE SCHEDULE ===');
  ok('scheduleInit exists', ev('typeof scheduleInit') === 'function');
  ok('cyclePosition exists', ev('typeof cyclePosition') === 'function');
  ok('scheduledDayFor exists', ev('typeof scheduledDayFor') === 'function');

  // default mode must stay 'dow' for existing installs \u2014 switching is opt-in
  ev("delete S.scheduleMode; delete S.cycleSchedule;");
  ok('defaults to dow mode (non-breaking for existing users)', ev('scheduleMode()') === 'dow');
  ok('pre-fills the requested pattern even before switching', 
     JSON.stringify(ev('cyclePattern()')) === JSON.stringify(['D1','D2','D3','REST','D4','D5','D6','REST']));

  // set up the exact scenario: anchor = a known Monday, 8-day pattern
  ev("S.scheduleMode='cycle'; S.cycleSchedule={anchor:'2026-08-03', pattern:['D1','D2','D3','REST','D4','D5','D6','REST']};");
  ok('day 0 (anchor) resolves to D1', ev("scheduledDayFor('2026-08-03')") === 'D1');
  ok('day 3 resolves to REST (first rest day)', ev("scheduledDayFor('2026-08-06')") === 'REST');
  ok('day 7 resolves to REST (second rest day)', ev("scheduledDayFor('2026-08-10')") === 'REST');
  ok('day 8 wraps back to D1', ev("scheduledDayFor('2026-08-11')") === 'D1');
  ok('a date before the anchor still resolves correctly (backward wrap)', 
     ev("scheduledDayFor('2026-08-02')") === 'REST', ev("scheduledDayFor('2026-08-02')"));

  // currentDayKey must go through the resolver, and overrideDay must still win
  ev("delete S.overrideDay;");
  const todayISO = ev('todayKey()');
  ev("S.cycleSchedule.anchor = todayKey();"); // anchor = today, so today is day0 = D1
  ok('currentDayKey resolves via the cycle on a plain day', ev('currentDayKey()') === 'D1');
  ev("S.overrideDay = {date: todayKey(), day:'D5'};");
  ok('override day still wins over the cycle', ev('currentDayKey()') === 'D5');
  ev("delete S.overrideDay;");

  // THE ACTUAL BUG BEING FIXED: week boundary must reset once per full cycle (8 days),
  // not after every individual rest day.
  ev("S.cycleSchedule = {anchor:'2026-08-03', pattern:['D1','D2','D3','REST','D4','D5','D6','REST']};");
  // simulate "today" being day 5 of the cycle (2026-08-08, a D5 day, i.e. AFTER the first
  // rest day but still within the SAME pass through the split)
  ev(`(function(){
    var real = Date;
    window.__fakeToday = '2026-08-08T12:00:00';
    Date = function(...args){ return args.length ? new real(...args) : new real(window.__fakeToday); };
    Date.prototype = real.prototype;
    Object.setPrototypeOf(Date, real);
    window.__realDate = real;
  })();`);
  const wsDuringCycle = ev('weekStartKey()');
  ok('week boundary does NOT reset at the first rest day (day 3)', 
     wsDuringCycle === '2026-08-03', 'got=' + wsDuringCycle);
  ok('week boundary sits at the true cycle start (position 0)', wsDuringCycle === '2026-08-03');
  ev("Date = window.__realDate;");

  // lastCompletedWeekRange must use the real 8-day cycle length, not a hardcoded 7
  ev(`(function(){
    var real = Date;
    window.__fakeToday2 = '2026-08-11T12:00:00'; // day 8 = start of the NEXT cycle
    Date = function(...args){ return args.length ? new real(...args) : new real(window.__fakeToday2); };
    Date.prototype = real.prototype;
    Object.setPrototypeOf(Date, real);
  })();`);
  const lcwr = ev('lastCompletedWeekRange()');
  ok('previous window spans the full 8-day cycle, not 7', 
     ev("daysBetween('" + lcwr.start + "','" + lcwr.end + "')") === 7, // inclusive 8-day span = 7 days between
     JSON.stringify(lcwr));
  ok('previous window ends the day before the new cycle starts', lcwr.end === '2026-08-10', JSON.stringify(lcwr));
  ev("Date = window.__realDate;");

  // streak calc must not break on cycle-mode rest days
  ev(`(function(){
    S.logs = (S.logs||[]).filter(function(l){ return l.date < '2026-08-01' || l.date > '2026-08-11'; });
    ['2026-08-03','2026-08-04','2026-08-05','2026-08-07','2026-08-08'].forEach(function(dk){
      S.logs.push({date:dk, entries:[{exercise:'Cycle Streak Test', sets:[{w:100,r:5}]}]});
    });
  })();`);
  ev(`(function(){
    var real = Date;
    window.__fakeToday3 = '2026-08-08T12:00:00';
    Date = function(...args){ return args.length ? new real(...args) : new real(window.__fakeToday3); };
    Date.prototype = real.prototype;
    Object.setPrototypeOf(Date, real);
  })();`);
  let streakThrew = false;
  let streakVal = null;
  try { streakVal = ev('streakDays()'); } catch (e) { streakThrew = true; console.log('  threw:', e.message); }
  ok('streakDays does not throw in cycle mode', !streakThrew);
  ok('streak correctly skips cycle-mode rest days', streakVal === 5, 'streak=' + streakVal);
  ev("Date = window.__realDate; S.logs = (S.logs||[]).filter(function(l){ return l.date < '2026-08-01' || l.date > '2026-08-11'; });");

  // agent-facing: schedule fix must be rejected outright in cycle mode
  ok('schedule fix is rejected while cycle mode is active', 
     ev('agValidateFix({type:"schedule",payload:{map:{0:"REST",1:"D1",2:"D2",3:"D3",4:"D4",5:"D5",6:"REST"}}})') === null);
  ok('agent context flags cycle mode explicitly', /ROTATING CYCLE/.test(ev('agContext()')));
  ok('agent context tells agents not to use weekday framing', /do NOT describe this in terms of weekdays/.test(ev('agContext()')));

  // and confirm dow mode still works exactly as before (no regression)
  ev("S.scheduleMode='dow';");
  ok('schedule fix validates normally in dow mode', 
     ev('agValidateFix({type:"schedule",payload:{map:{0:"REST",1:"D1",2:"D2",3:"D3",4:"D4",5:"D5",6:"REST"}}})') !== null);
  ok('agent context uses weekday framing in dow mode', /Sun=|Mon=/.test(ev('agContext()')));
  ev("S.scheduleMode='dow';"); // leave the harness in the default mode for later sections

  console.log('=== AGENT CYCLE SCHEDULE EDITS ===');
  ok('cycleSchedule is in the fix whitelist', ev('AG_FIX_TYPES').indexOf('cycleSchedule') >= 0);

  // gating: only valid IN cycle mode (opposite of the plain 'schedule' fix)
  ev("S.scheduleMode='dow';");
  ok('cycleSchedule fix rejected in dow mode', 
     ev('agValidateFix({type:"cycleSchedule",payload:{pattern:["D1","D2","D3","REST","D4","D5","D6","REST"]}})') === null);

  ev("S.scheduleMode='cycle'; S.cycleSchedule={anchor:'2026-08-03', pattern:['D1','D2','D3','REST','D4','D5','D6','REST']};");
  const goodFix = ev('agValidateFix({type:"cycleSchedule",payload:{pattern:["D1","D2","D3","REST","D4","D5","D6","REST"]}})');
  ok('cycleSchedule fix validates in cycle mode', goodFix !== null);
  ok('validated fix preserves the pattern', JSON.stringify(goodFix.payload.pattern) === JSON.stringify(['D1','D2','D3','REST','D4','D5','D6','REST']));

  // content validation
  ok('rejects a pattern referencing a nonexistent split day', 
     ev('agValidateFix({type:"cycleSchedule",payload:{pattern:["D1","D99","REST"]}})') === null);
  ok('rejects an empty pattern', ev('agValidateFix({type:"cycleSchedule",payload:{pattern:[]}})') === null);
  ok('rejects an all-REST pattern (never legitimate)', 
     ev('agValidateFix({type:"cycleSchedule",payload:{pattern:["REST","REST","REST"]}})') === null);
  ok('rejects a pattern over 14 days', 
     ev('agValidateFix({type:"cycleSchedule",payload:{pattern:new Array(15).fill("D1")}})') === null);
  ok('accepts a shorter, legitimate rotation', 
     ev('agValidateFix({type:"cycleSchedule",payload:{pattern:["D1","D2","REST"]}})') !== null);

  // anchor must NEVER move via a proposal, even if the model sends one
  const anchorAttempt = ev('agValidateFix({type:"cycleSchedule",payload:{pattern:["D1","D2","REST"],anchor:"2020-01-01"}})');
  ok('anchor field is stripped even if the model includes one', 
     anchorAttempt.payload.anchor === undefined, JSON.stringify(anchorAttempt.payload));

  // apply and confirm the live state actually changes, and ONLY the pattern
  ev("S.cycleSchedule = {anchor:'2026-08-03', pattern:['D1','D2','D3','REST','D4','D5','D6','REST']};");
  const fixToApply = ev('agValidateFix({type:"cycleSchedule",payload:{pattern:["D1","D2","REST","D4","D5","REST"]}})');
  ev('agApplyFix(' + JSON.stringify(fixToApply) + ')');
  ok('applying the fix updates the live pattern', 
     JSON.stringify(ev('S.cycleSchedule.pattern')) === JSON.stringify(['D1','D2','REST','D4','D5','REST']));
  ok('applying the fix leaves the anchor untouched', ev('S.cycleSchedule.anchor') === '2026-08-03');

  // human-readable summary for the proposal card
  const summaryFix = {type:'cycleSchedule', payload:{pattern:['D1','D2','REST','D4','D5','REST']}};
  ok('fix summary shows the actual new pattern', 
     ev('agFixSummary(' + JSON.stringify(summaryFix) + ')').indexOf('D1') >= 0 &&
     ev('agFixSummary(' + JSON.stringify(summaryFix) + ')').indexOf('REST') >= 0);

  // agent context: no longer says agents can't propose changes, and describes the ability
  ev("S.cycleSchedule = {anchor:'2026-08-03', pattern:['D1','D2','D3','REST','D4','D5','D6','REST']};");
  const ctxNow = ev('agContext()');
  ok('agent context no longer claims agents cannot propose schedule changes', 
     !/You cannot propose a schedule fix/.test(ctxNow));
  ok('agent context describes the cycleSchedule capability', /cycleSchedule fix/.test(ctxNow));
  ok('agent context still marks the anchor as fixed/non-editable', /not editable by proposal|fixed/.test(ctxNow));

  // reciprocal check: plain 'schedule' fix still correctly rejected in cycle mode (no regression)
  ok('plain schedule fix still rejected in cycle mode', 
     ev('agValidateFix({type:"schedule",payload:{map:{0:"REST",1:"D1",2:"D2",3:"D3",4:"D4",5:"D5",6:"REST"}}})') === null);

  ev("S.scheduleMode='dow';"); // leave harness in default mode

  console.log('=== SCHEDULER ===');
  const Asched = ev('agState()');
  ev("agState().lastRun = todayKey(); agState().autoRun = true;");
  ev('S').settings.apiKey = 'sk-test';
  let ran = false;
  const realRun = w.agRunAll;
  w.agRunAll = () => { ran = true; };
  ev('agMaybeAutoRun')();
  ok('does not re-run same day', ran === false);
  ev("agState().lastRun = '2020-01-01';");
  ev('agMaybeAutoRun')();
  const lateEnough = new Date().getHours() >= 21;
  ok('respects the 9PM gate', ran === lateEnough, 'hour=' + new Date().getHours() + ' ran=' + ran);
  ran = false;
  ev('S').settings.apiKey = '';
  ev('agMaybeAutoRun')();
  ok('never runs without an API key', ran === false);
  w.agRunAll = realRun;

  console.log('=== HOME MODE ===');
  ok('roundToEquipList exists', ev('typeof roundToEquipList') === 'function');
  ok('homeActiveToday exists', ev('typeof homeActiveToday') === 'function');
  ok('toggleHomeToday exists', ev('typeof toggleHomeToday') === 'function');
  ok('homeSkipFor exists', ev('typeof homeSkipFor') === 'function');
  ok('homeSubFor exists', ev('typeof homeSubFor') === 'function');
  ok('setHomeMode exists', ev('typeof setHomeMode') === 'function');

  // --- roundToEquipList: boundary values ---
  ok('rounds down to nearer neighbor', ev('roundToEquipList(23, [10,20,30])') === 20);
  ok('rounds up to nearer neighbor', ev('roundToEquipList(27, [10,20,30])') === 30);
  ok('tie rounds up rather than left un-rounded', ev('roundToEquipList(25, [20,30])') === 30);
  ok('exact match returns itself', ev('roundToEquipList(20, [10,20,30])') === 20);
  ok('clamps below the list minimum', ev('roundToEquipList(1, [10,20,30])') === 10);
  ok('clamps above the list maximum', ev('roundToEquipList(999, [10,20,30])') === 30);
  ok('empty list leaves target un-rounded (no equipment configured)', ev('roundToEquipList(23, [])') === 23);

  // --- S.homeToday: auto-expiry, same pattern as overrideDay ---
  ev("S.homeToday = {date:'2020-01-01'};");
  ok('a past date does not count as active today', ev('homeActiveToday()') === false);
  ev("S.homeToday = {date: todayKey()};");
  ok('a current date counts as active', ev('homeActiveToday()') === true);
  ev("S.homeToday = null;");
  ok('cleared toggle is inactive', ev('homeActiveToday()') === false);

  // --- split editor round-trip: homeSkip/homeSub alongside MAXED/FORM/BACK on the same exercise ---
  ev("S.deload = null;"); // neutralize any deload state left by earlier sections
  const hDay = ev("Object.keys(S.split)[0]");
  ev("S.split['" + hDay + "'].exercises.push({name:'Home Test Squat', inc:10, maxed:true, formFocus:true});");
  const hIdx = ev("S.split['" + hDay + "'].exercises.length - 1");

  ev("setHomeMode('" + hDay + "'," + hIdx + ",'sub')");
  ev("setHomeSubName('" + hDay + "'," + hIdx + ",'Home Test DB Squat')");
  ev("setHomeSubEquip('" + hDay + "'," + hIdx + ",'db')");
  let hEx = ev("S.split['" + hDay + "'].exercises[" + hIdx + "]");
  ok('homeSub name round-trips', hEx.homeSub && hEx.homeSub.name === 'Home Test DB Squat', JSON.stringify(hEx));
  ok('homeSub equip round-trips', hEx.homeSub && hEx.homeSub.equip === 'db', JSON.stringify(hEx));
  ok('homeSkip stays false while substituting', hEx.homeSkip === false);
  ok('MAXED survives the HOME edit', hEx.maxed === true);
  ok('FORM survives the HOME edit', hEx.formFocus === true);

  ev("setHomeMode('" + hDay + "'," + hIdx + ",'skip')");
  hEx = ev("S.split['" + hDay + "'].exercises[" + hIdx + "]");
  ok('switching to skip sets homeSkip', hEx.homeSkip === true);
  ok('switching to skip clears homeSub (mutually exclusive)', !hEx.homeSub);
  ok('MAXED still intact after switching to skip', hEx.maxed === true);
  ok('FORM still intact after switching to skip', hEx.formFocus === true);
  ok('homeSkipFor reflects the split state', ev("homeSkipFor('Home Test Squat')") === true);

  // cross-day propagation, same shape as toggleMaxed/toggleNoBackoff (and promotes a legacy string entry)
  const hDay2 = ev("Object.keys(S.split)[1]");
  ev("S.split['" + hDay2 + "'].exercises.push('Home Test Squat');");
  ev("setHomeMode('" + hDay + "'," + hIdx + ",'sub')");
  ev("setHomeSubName('" + hDay + "'," + hIdx + ",'Home Test DB Squat')");
  ev("setHomeSubEquip('" + hDay + "'," + hIdx + ",'db')");
  const propCount = ev(`(function(){
    var n=0; for(var d in S.split){ (S.split[d].exercises||[]).forEach(function(x){
      if(typeof x==='object' && x.name==='Home Test Squat' && x.homeSub && x.homeSub.name==='Home Test DB Squat') n++; }); } return n; })()`);
  ok('homeSub propagates across every day the exercise appears on', propCount === 2, 'count=' + propCount);

  // register the substitute itself as a real strength-mode exercise on a different day,
  // so recommend()/classifyDecision()/backoffWeightFor() have real history + flags to read
  ev("S.split['" + hDay2 + "'].exercises.push({name:'Home Test DB Squat', inc:5, repMode:'str'});");
  ev("S.split['" + hDay + "'].exercises.push({name:'Home Test Skip Ex', inc:5, homeSkip:true});");

  // one prior session at a non-equipment weight so recommend() holds it unchanged
  // (reps within the 3–6 str range, below the ceiling — target stays at topW)
  ev(`(function(){
    S.logs = (S.logs||[]).filter(function(l){ return !l.entries.some(function(e){ return e.exercise==='Home Test DB Squat'; }); });
    S.logs.push({id:1, date:'2026-01-01', day:'${hDay2}', entries:[{exercise:'Home Test DB Squat', sets:[{w:37, r:4}]}]});
  })();`);

  ok('sanity: not in a deload week', ev('deloadActive()') === false);
  ev("S.homeToday = {date: todayKey()};");

  const builtHomeRes = ev(`(function(){
    try{ return {ok:true, list: buildLiveExercises('${hDay}')}; }
    catch(e){ return {ok:false, err:e.message}; }
  })()`);
  ok('HOME session builds without throwing', builtHomeRes.ok, builtHomeRes.err);
  const builtHomeNames = builtHomeRes.ok ? builtHomeRes.list.map(e => e.name) : [];
  ok('homeSkip exercise is omitted, not present-but-broken', builtHomeNames.indexOf('Home Test Skip Ex') === -1, JSON.stringify(builtHomeNames));
  ok('other real exercises on the day still build', builtHomeNames.length > 0);
  ok('substituted slot shows the substitute name, not the original', builtHomeNames.indexOf('Home Test Squat') === -1 && builtHomeNames.indexOf('Home Test DB Squat') >= 0, JSON.stringify(builtHomeNames));

  const dbList = ev('S.homeEquipment.dumbbells');
  const builtSub = builtHomeRes.ok ? builtHomeRes.list.find(e => e.name === 'Home Test DB Squat') : null;
  ok('substitute exercise found in the built session', !!builtSub, JSON.stringify(builtHomeNames));
  if (builtSub) {
    ok('suggested weight is snapped to the dumbbell list, not left at the raw computed value',
       dbList.indexOf(+builtSub.targetW) >= 0 && +builtSub.targetW !== 37, 'targetW=' + builtSub.targetW);
    ok('backoff weight is also snapped to the dumbbell list, not the normal 5 lb increment',
       dbList.indexOf(+builtSub.backoffW) >= 0 && +builtSub.backoffW !== 35, 'backoffW=' + builtSub.backoffW);
  }

  // a non-HOME build of the same day must NOT skip/substitute/round anything
  ev("S.homeToday = null;");
  const builtGymNames = ev(`buildLiveExercises('${hDay}').map(function(e){ return e.name; })`);
  ok('outside HOME mode, the skip-flagged exercise still builds normally', builtGymNames.indexOf('Home Test Skip Ex') >= 0, JSON.stringify(builtGymNames));
  ok('outside HOME mode, the substitute-flagged exercise keeps its own name', builtGymNames.indexOf('Home Test Squat') >= 0 && builtGymNames.indexOf('Home Test DB Squat') === -1, JSON.stringify(builtGymNames));

  // --- endLiveSession log tagging + Investigation carve-out ---
  ok('e1rmSeries accepts an excludeHome option', ev('typeof e1rmSeries') === 'function');
  ev(`(function(){
    S.logs = (S.logs||[]).filter(function(l){ return !l.entries.some(function(e){ return e.exercise==='Home Decline Test'; }); });
    var start = new Date('2026-04-01T00:00:00');
    var weights = [220,210,200,190,180,170];
    for(var i=0;i<weights.length;i++){
      var d = new Date(start.getTime() + i*7*86400000);
      S.logs.push({date:d.toISOString().slice(0,10), home:true, entries:[{exercise:'Home Decline Test', sets:[{w:weights[i],r:8}]}]});
    }
  })();`);
  const hDecline = ev("investigateLift('Home Decline Test')");
  ok('a home-tagged decline is not flagged', hDecline.severity === null, 'severity=' + hDecline.severity + ' findings=' + JSON.stringify(hDecline.findings));

  // same data, NOT tagged home, must flag as a real decline — proves suppression, not coincidence
  ev("S.logs.forEach(function(l){ l.entries.forEach(function(e){ if(e.exercise==='Home Decline Test') l.home=false; }); });");
  const hDecline2 = ev("investigateLift('Home Decline Test')");
  ok('the same declining data DOES flag when not tagged home', hDecline2.severity === 'red', 'severity=' + hDecline2.severity);

  // endLiveSession itself tags the log record from the live session's own home flag
  ev(`(function(){
    live = { date: todayKey(), day:'${hDay2}', startedAt: Date.now(), curIdx:0, trimmed:false, home:true,
      exercises:[{ name:'Home Session Tag Test', sets:[{w:20,r:8}], done:true }] };
  })();`);
  ev('endLiveSession()');
  const hTaggedLog = ev(`S.logs.slice().reverse().find(function(l){ return l.entries.some(function(e){ return e.exercise==='Home Session Tag Test'; }); })`);
  ok('endLiveSession tags the log record home:true when the session was HOME', hTaggedLog && hTaggedLog.home === true, JSON.stringify(hTaggedLog));

  // agent context surfaces the HOME tag to DELTA/CHARLIE
  const hTrainCtx = ev('trainingContext()');
  ok('trainingContext flags the HOME session for the nightly agents', /HOME/.test(hTrainCtx));

  // cleanup
  ev(`(function(){
    S.logs = (S.logs||[]).filter(function(l){ return !l.entries.some(function(e){
      return e.exercise==='Home Test DB Squat' || e.exercise==='Home Decline Test' || e.exercise==='Home Session Tag Test'; }); });
    for(var d in S.split){ S.split[d].exercises = (S.split[d].exercises||[]).filter(function(x){
      return !(typeof x==='object' && (x.name==='Home Test Squat' || x.name==='Home Test DB Squat' || x.name==='Home Test Skip Ex')); }); }
    S.homeToday = null;
    live = null;
  })();`);

  console.log('=== BENCH PRACTICE ===');
  ok('openBenchPractice exists', ev('typeof openBenchPractice') === 'function');
  ok('saveBenchPractice exists', ev('typeof saveBenchPractice') === 'function');
  ok('S.benchPractice defaults to an array', Array.isArray(ev('S.benchPractice')));

  // start clean
  ev("S.benchPractice = (S.benchPractice||[]).filter(function(e){ return e.date !== todayKey(); });");

  // openBenchPractice renders blank rows, no prior session -> no seeded weight
  ev('openBenchPractice()');
  ok('bp overlay shown after open', ev("document.getElementById('bpOverlay').classList.contains('show')") === true);
  ok('first weight input starts blank with no history', ev("document.getElementById('bp-w-0').value") === '');

  // fill 3 sets and save
  ev(`(function(){
    document.getElementById('bp-w-0').value = '135'; document.getElementById('bp-r-0').value = '5';
    document.getElementById('bp-w-1').value = '135'; document.getElementById('bp-r-1').value = '5';
    document.getElementById('bp-w-2').value = '145'; document.getElementById('bp-r-2').value = '3';
  })();`);
  ev('saveBenchPractice()');
  ok('overlay closes on save', ev("document.getElementById('bpOverlay').classList.contains('show')") === false);
  let bpToday = ev('bpTodayEntry()');
  ok('today entry created with the three filled sets', bpToday && bpToday.sets.length === 3, JSON.stringify(bpToday));
  ok('blank trailing rows are not saved as zero sets', bpToday.sets.every(s => s.w > 0 && s.r > 0), JSON.stringify(bpToday));
  ok('set values round-trip correctly', bpToday.sets[2].w === 145 && bpToday.sets[2].r === 3, JSON.stringify(bpToday));

  // reopening the same day pre-fills existing sets, not blank
  ev('openBenchPractice()');
  ok('reopening same day shows the already-logged first set', ev("document.getElementById('bp-w-0').value") === '135');

  // re-saving with fewer sets replaces (upserts) rather than appending a second entry for today
  ev(`(function(){
    document.getElementById('bp-w-0').value = '140'; document.getElementById('bp-r-0').value = '5';
    for(var si=1; document.getElementById('bp-w-'+si); si++){ document.getElementById('bp-w-'+si).value=''; document.getElementById('bp-r-'+si).value=''; }
  })();`);
  ev('saveBenchPractice()');
  const bpTodayCount = ev("(S.benchPractice||[]).filter(function(e){ return e.date===todayKey(); }).length");
  ok('saving again upserts today rather than duplicating', bpTodayCount === 1, 'count=' + bpTodayCount);
  bpToday = ev('bpTodayEntry()');
  ok('upsert replaced the sets with the new values', bpToday.sets.length === 1 && bpToday.sets[0].w === 140, JSON.stringify(bpToday));

  // saving with everything blank removes today's entry entirely
  ev('openBenchPractice()');
  ev(`(function(){ for(var si=0; document.getElementById('bp-w-'+si); si++){ document.getElementById('bp-w-'+si).value=''; document.getElementById('bp-r-'+si).value=''; } })();`);
  ev('saveBenchPractice()');
  ok('an all-blank save clears today\'s entry rather than storing an empty one', ev('bpTodayEntry()') === null);

  // seeding: the next-open weight seeds from the last entry once no entry exists for today
  ev("S.benchPractice = [{date:'2026-01-01', sets:[{w:130,r:5}]}];");
  ev('openBenchPractice()');
  ok('first weight input seeds from the last recorded practice session', ev("document.getElementById('bp-w-0').value") === '130');
  ev('closeBenchPractice()');

  // separation: bench practice sets must never be visible to progression/trend/Investigation code,
  // which only ever reads S.logs — proven here by an extreme, obviously-would-flag practice weight
  // that changes nothing about a real declining bench trend.
  ev(`(function(){
    S.logs = (S.logs||[]).filter(function(l){ return !l.entries.some(function(e){ return e.exercise==='BP Separation Test'; }); });
    var start = new Date('2026-05-01T00:00:00');
    var weights = [200,190,180,170,160,150];
    for(var i=0;i<weights.length;i++){
      var d = new Date(start.getTime() + i*7*86400000);
      S.logs.push({date: d.toISOString().slice(0,10), entries:[{exercise:'BP Separation Test', sets:[{w:weights[i],r:8}]}]});
    }
    S.benchPractice = [{date: todayKey(), sets:[{w:999,r:1}]}]; // wildly out of range, should have zero influence
  })();`);
  const bpSepDecline = ev("investigateLift('BP Separation Test')");
  ok('a real declining lift still flags red even with an unrelated bench-practice entry present', bpSepDecline.severity === 'red', 'severity=' + bpSepDecline.severity);
  const bpSepE1rm = ev("e1rmSeries('BP Separation Test')");
  ok('e1rmSeries never picks up bench-practice sets (series length matches S.logs only)', bpSepE1rm.length === 6, 'len=' + bpSepE1rm.length);

  // agent context: informational only, clearly labeled advisory, present when entries exist
  ev("S.benchPractice = [{date:'2026-06-01', sets:[{w:135,r:5}]}];");
  let bpCtx = ev('trainingContext()');
  ok('trainingContext surfaces recent bench-practice sessions for advisory commentary', /BENCH PRACTICE/.test(bpCtx) && /135/.test(bpCtx), bpCtx.slice(0, 50));
  ok('trainingContext explicitly tells agents not to use it for progression/Investigation/trend calls', /do NOT use this for progression, Investigation, or trend/.test(bpCtx));
  ev("S.benchPractice = [];");
  bpCtx = ev('trainingContext()');
  ok('trainingContext falls back to "none logged" with no bench-practice history', /none logged/.test(bpCtx));

  // welcome screen affordance
  ev("S.benchPractice = (S.benchPractice||[]).filter(function(e){ return e.date !== todayKey(); });");
  let bpWelcome = ev('welcomeHTML()');
  ok('welcome screen offers the Bench Practice entry point', /Bench Practice/.test(bpWelcome));
  ok('welcome screen keeps it separate from the Train at home today toggle', /Train at home today/.test(bpWelcome) && /Bench Practice/.test(bpWelcome));
  ev("S.benchPractice = [{date: todayKey(), sets:[{w:135,r:5}]}];");
  bpWelcome = ev('welcomeHTML()');
  ok('welcome screen reflects that practice was already logged today', /Bench practice logged/.test(bpWelcome), bpWelcome);

  // ---- agent-managed frequency target (bpFreq) ----
  const Vbp = ev('agValidateFix');
  ok('bpFreq valid clamp', JSON.stringify(Vbp({ type: 'bpFreq', payload: { daysPerWeek: 2, pct: 80 } })) === JSON.stringify({ type: 'bpFreq', payload: { daysPerWeek: 2, pct: 80 } }));
  ok('bpFreq daysPerWeek 0 rejected', Vbp({ type: 'bpFreq', payload: { daysPerWeek: 0, pct: 80 } }) === null);
  ok('bpFreq daysPerWeek 5 rejected', Vbp({ type: 'bpFreq', payload: { daysPerWeek: 5, pct: 80 } }) === null);
  ok('bpFreq pct below 60 rejected', Vbp({ type: 'bpFreq', payload: { daysPerWeek: 2, pct: 50 } }) === null);
  ok('bpFreq pct above 95 rejected', Vbp({ type: 'bpFreq', payload: { daysPerWeek: 2, pct: 96 } }) === null);

  ev('S.benchPracticeFreq = null;');
  ev('agApplyFix')({ type: 'bpFreq', payload: { daysPerWeek: 2, pct: 80 } });
  const bpf = ev('S.benchPracticeFreq');
  ok('bpFreq apply writes target with agent provenance', bpf && bpf.daysPerWeek === 2 && bpf.pct === 80 && bpf.setBy === 'agent', JSON.stringify(bpf));

  // suggested weight derives from tracked Barbell Bench Press working weight, not bench-practice history
  ev(`(function(){
    S.logs = (S.logs||[]).filter(function(l){ return !l.entries.some(function(e){ return e.exercise==='Barbell Bench Press'; }); });
    S.logs.push({date:'2026-08-01', entries:[{exercise:'Barbell Bench Press', sets:[{w:200,r:5},{w:200,r:5},{w:200,r:5}]}]});
  })();`);
  const bpSug = ev('bpSuggestedWeight()');
  ok('bpSuggestedWeight is 80% of 200 lb, rounded to nearest 5', bpSug === 160, 'got=' + bpSug);

  ev("S.benchPractice = (S.benchPractice||[]).filter(function(e){ return e.date !== todayKey(); });");
  ev('openBenchPractice()');
  ok('modal seeds the agent-suggested weight over the last-practice weight', ev("document.getElementById('bp-w-0').value") === '160');
  const bpModalHtml = ev("document.getElementById('bpBody').innerHTML");
  ok('modal surfaces the DELTA target line', /DELTA target/.test(bpModalHtml) && /2x\/week/.test(bpModalHtml), bpModalHtml.slice(0, 200));
  ev('closeBenchPractice()');

  // welcome screen shows this-week progress against the target
  ev("S.benchPractice = (S.benchPractice||[]).filter(function(e){ return e.date !== todayKey(); });");
  let bpFreqWelcome = ev('welcomeHTML()');
  ok('welcome screen shows 0/2 against an active target with nothing logged this week', /Bench Practice \(0\/2 this week\)/.test(bpFreqWelcome), bpFreqWelcome);
  ev("S.benchPractice.push({date: todayKey(), sets:[{w:160,r:5}]});");
  bpFreqWelcome = ev('welcomeHTML()');
  ok('welcome screen shows logged state once today is done, not the frequency counter', /Bench practice logged/.test(bpFreqWelcome));

  // no target set -> old manual behavior is untouched
  ev('S.benchPracticeFreq = null;');
  ev("S.benchPractice = (S.benchPractice||[]).filter(function(e){ return e.date !== todayKey(); });");
  ok('bpSuggestedWeight returns null with no active target', ev('bpSuggestedWeight()') === null);
  ev('openBenchPractice()');
  ok('with no target, modal falls back to blank/last-entry seeding (no DELTA target line)', ev("document.getElementById('bpBody').innerHTML").indexOf('DELTA target') === -1);
  ev('closeBenchPractice()');

  // cleanup
  ev(`(function(){
    S.logs = (S.logs||[]).filter(function(l){ return !l.entries.some(function(e){ return e.exercise==='BP Separation Test' || e.exercise==='Barbell Bench Press'; }); });
    S.benchPractice = [];
    S.benchPracticeFreq = null;
    closeBenchPractice();
  })();`);

  // ============ render smoke ============
  console.log('=== TODAY TAB HONORS INVESTIGATION OVERRIDE ===');
  try {
    const OV_EX = 'Override Sync Test Lift';
    // seed history that would earn a STR-mode weight jump on its own (top set hit the ceiling)
    ev("S.logs = (S.logs||[]).filter(l => !l.entries.some(e=>e.exercise==='" + OV_EX + "'));");
    ev("S.logs.push({date:'2026-08-01', entries:[{exercise:'" + OV_EX + "', sets:[{w:145,r:6},{w:145,r:5},{w:145,r:5}]}]});");
    // force STR mode so recommend() takes the ceiling-jump branch (mirrors Barbell Bench Press config)
    ev("S.split[Object.keys(S.split)[0]].exercises.push({name:'" + OV_EX + "', inc:5, repMode:'str'});");
    const withoutOverride = call('recommend', OV_EX, 'ok');
    ok('sanity: history alone earns a jump to 150', withoutOverride.sets[0].w === 150, JSON.stringify(withoutOverride.sets[0]));

    // apply an active liftReset override locking this lift at 145 for 14 days
    ev('agApplyFix')({ type: 'liftReset', payload: { name: OV_EX, w: 145, days: 14 } });
    const ov = ev('invState')().overrides[OV_EX];
    ok('override active and unexpired', ov && ov.w === 145 && ov.until >= ev('todayKey')());

    // Today tab render must reflect the lock, not the raw recommend() jump
    ev('todaySwaps = {}');
    const html = call('exBlockHTML', 0, { name: OV_EX, inc: 5, repMode: 'str' }, 'ok');
    ok('Today tab shows locked 145, not the earned 150', html.indexOf('145 lb') >= 0 && html.indexOf('150 lb') === -1, html.slice(0, 300));

    // cleanup
    ev("delete invState().overrides['" + OV_EX + "'];");
    ev("S.logs = (S.logs||[]).filter(l => !l.entries.some(e=>e.exercise==='" + OV_EX + "'));");
    ev("var _dk = Object.keys(S.split)[0]; S.split[_dk].exercises = S.split[_dk].exercises.filter(x => (typeof x==='object'?x.name:x) !== '" + OV_EX + "');");
  } catch (e) {
    ok('Today tab honors investigation override', false, e.message);
  }

  console.log('=== RENDER ===');
  try {
    ev('renderOps')();
    const out = w.document.getElementById('ops').innerHTML;
    ok('renderOps produces markup', out.length > 500, 'len=' + out.length);
    ok('renders all four agent names', ['ZULU', 'CHARLIE', 'DELTA', 'ECHO'].every(n => out.indexOf(n) >= 0));
    ok('renders activity log section', out.indexOf('Activity log') >= 0);
    ok('renders pending section', out.indexOf('Pending proposals') >= 0);
    ok('renders chat composer', out.indexOf('agChatIn') >= 0);
  } catch (e) {
    ok('renderOps throws', false, e.message);
  }
  try { ev('renderCoach')(); ok('renderCoach alias safe', true); }
  catch (e) { ok('renderCoach alias safe', false, e.message); }

  console.log('\nRESULT: ' + pass + ' passed, ' + fail + ' failed');
  process.exit(fail ? 1 : 0);
}, 1200);
