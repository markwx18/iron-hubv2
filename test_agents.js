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
    // jsdom has no layout engine, so it does not implement scrollIntoView. The app calls it
    // whenever it advances to the next exercise. Stub it rather than route tests around it --
    // this is a harness gap, not app behaviour, and steering fixtures away from a real code
    // path to keep jsdom happy is how you end up testing something other than the app.
    w.Element.prototype.scrollIntoView = function(){};
  }
});

const w = dom.window;
const ev = (expr) => w.eval(expr);
const call = (fn, ...args) => { w.__a = args; return w.eval(fn + '.apply(null, window.__a)'); };

// The nightly cycle is four calls now (three specialists in parallel, then the lead), not one
// combined call, so a stub has to answer PER AGENT instead of returning one object with four
// keys in it. Routes on the role line in the system prompt, which is the same thing the model
// itself keys off. Pass '__THROW__' for an agent to make its call fail.
function stubAgents(byAgent) {
  w.eval("window.__realData = window.__realData || callClaudeWithData;");
  w.eval("window.__stub = " + JSON.stringify(byAgent) + ";");
  w.eval(`callClaudeWithData = async function(msgs, sys){
    const who = /You are CHARLIE/.test(sys) ? 'charlie'
              : /You are DELTA/.test(sys)   ? 'delta'
              : /You are ECHO/.test(sys)    ? 'echo'
              : 'zulu';
    window.__stubSeen = window.__stubSeen || [];
    window.__stubSeen.push(who);
    const v = window.__stub[who];
    if (v === undefined) return {text: JSON.stringify({summary: who + ' had nothing.', proposals: []}), toolsUsed: 0};
    if (v === '__THROW__') throw new Error('API 429: rate limited');
    return {text: (typeof v === 'string' ? v : JSON.stringify(v)), toolsUsed: 0};
  };`);
  w.eval("window.__stubSeen = [];");
}
function unstubAgents() { w.eval("if(window.__realData) callClaudeWithData = window.__realData;"); }
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

  // Reproduces the real report: 159.0 lb, +1.27 lb/wk, protein target 150g. proFloor is
  // round(159*0.95) = 151, so an exact comparison prescribed "raise protein 150 -> 151g".
  console.log('=== BULK INVESTIGATION: PROTEIN DEADBAND ===');
  try {
    ev("window.__wSave = JSON.parse(JSON.stringify(S.weights)); window.__fSave = S.fuel ? JSON.parse(JSON.stringify(S.fuel)) : null;");
    // four Sundays, one per Monday-anchored week so the smoother keeps all four points:
    // 155.2 -> 159.0 over 21 days = +1.267 lb/week (the "slightly hot" band, >1.0 and <=1.5)
    ev("S.weights = [{date:'2026-07-26',lbs:155.2},{date:'2026-08-02',lbs:156.5},{date:'2026-08-09',lbs:157.7},{date:'2026-08-16',lbs:159.0}];");
    ev("S.fuel = Object.assign({}, S.fuel||{}, {proTarget:150, calTarget:3200});");

    const rate = ev("(function(){var r=linreg(bodyweightSeriesSmoothed().slice(-4)); return r?r.slope*7:0;})()");
    ok('fixture reproduces the reported +1.27 lb/wk rate', Math.abs(rate - 1.26) < 0.02, rate);
    ok('fixture reproduces a 1g gap to the protein floor',
      ev("Math.round(bodyweightSeriesSmoothed().slice(-1)[0].v*0.95)") === 151);

    const r1 = ev("investigateBulk()");
    ok('slightly-hot bulk is a yellow advisory', r1.severity === 'yellow', r1.severity + ' / ' + r1.title);
    ok('a 1g protein shortfall produces no fix', r1.fix === null, JSON.stringify(r1.fix));
    ok('a 1g protein shortfall is not even mentioned in the findings',
      !r1.findings.some(f => /protein/i.test(f)), r1.findings.join(' | '));

    // but a materially low target must still be caught
    ev("S.fuel.proTarget = 120;");
    const r2 = ev("investigateBulk()");
    ok('a materially low protein target still gets a fix', !!(r2.fix && r2.fix.type === 'pro'), JSON.stringify(r2.fix));
    ok('recommendation is a round number, not the raw floor',
      !!r2.fix && r2.fix.payload.to === 155, r2.fix && r2.fix.payload.to);
    ok('materially low protein is stated in the findings', r2.findings.some(f => /protein/i.test(f)));

    ev("S.weights = window.__wSave; if(window.__fSave) S.fuel = window.__fSave; else delete S.fuel;");
  } catch (e) {
    ok('bulk investigation protein deadband', false, e.message);
    ev("if(window.__wSave) S.weights = window.__wSave;");
  }

  // A pushed payload always stamps exportedAt AFTER the changedAt it carries, so the pull
  // gate (exportedAt > changedAt) stays true forever against an UNCHANGED gist. bgSyncTick
  // asks that question every 60s, so the same snapshot was being re-applied on a loop and
  // each replay reverted anything written with save(false) since — which is why a freshly
  // raised investigation flag disappeared about a minute after it appeared.
  console.log('=== BACKGROUND PULL DOES NOT REPLAY THE SAME SNAPSHOT ===');
  try {
    ev("S.meta = S.meta || {changedAt:0,lastSync:0}; S.meta.changedAt = Date.now() - 100000;");
    ev("window.__snap = {exportedAt: Date.now() - 50000, data: JSON.parse(JSON.stringify(S))};");
    ok('fixture has the gate open before the pull', ev('window.__snap.exportedAt > S.meta.changedAt'));

    // Re-parse on every apply, the way fetchGistData() does. Handing applyPulled the same
    // object twice would let it become S.invest by reference, so a later local mutation
    // would silently edit the "remote" fixture too and the replay test would prove nothing.
    ev("window.__snapFresh = () => JSON.parse(JSON.stringify(window.__snap.data));");
    ev("applyPulled(window.__snapFresh(), window.__snap.exportedAt)");
    ok('consuming a snapshot closes the gate against that same snapshot',
      !ev('window.__snap.exportedAt > S.meta.changedAt'),
      'changedAt=' + ev('S.meta.changedAt') + ' exportedAt=' + ev('window.__snap.exportedAt'));
    ok('a genuinely newer remote snapshot still passes the gate',
      ev('(window.__snap.exportedAt + 60000) > S.meta.changedAt'));

    // Behavioural form of the same bug: raise a flag the way invAutoRun does (save(false),
    // deliberately no touch) and then ask what the next background tick would do.
    ev("invState().flags.push({id:'replaytest1', cat:'bulk', key:'replaytest', severity:'yellow', title:'Replay test', findings:[], fix:null, status:'active', source:'auto', created:todayKey(), updated:todayKey()}); save(false);");
    if (ev('window.__snap.exportedAt > S.meta.changedAt')) {   // exactly bgSyncTick's condition
      ev("applyPulled(window.__snapFresh(), window.__snap.exportedAt)");
    }
    ok('a flag written with save(false) survives the next background tick',
      ev("invState().flags.some(f=>f.id==='replaytest1')"));
    ev("invState().flags = invState().flags.filter(f=>f.id!=='replaytest1')");
  } catch (e) {
    ok('background pull does not replay the same snapshot', false, e.message);
  }

  console.log('=== MANUAL INVESTIGATION SURVIVES A SYNC PULL ===');
  try {
    ev("window.__wSave3 = JSON.parse(JSON.stringify(S.weights));");
    ev("S.weights = [{date:'2026-07-26',lbs:155.2},{date:'2026-08-02',lbs:156.5},{date:'2026-08-09',lbs:157.7},{date:'2026-08-16',lbs:159.0}];");
    ev("S.meta.changedAt = Date.now() - 100000;");
    ev("window.__manualRemote = {exportedAt: Date.now() - 50000, data: JSON.parse(JSON.stringify(S))};");

    ev("invRunManual('bulk')");
    ok('manual bulk investigation raised a flag', ev("invActiveFlags().some(f=>f.key==='bulk')"));
    // invRaise() only save(false)s on purpose (a boot-time auto-run must not bump changedAt,
    // or autoPullOnLoad would skip its pull and push stale local state). The manual entry
    // point has to touch instead, or the flag is local-only and the next pull eats it.
    ok('a hand-run investigation bumps changedAt past the stale remote',
      !ev('window.__manualRemote.exportedAt > S.meta.changedAt'),
      'changedAt=' + ev('S.meta.changedAt') + ' remoteExportedAt=' + ev('window.__manualRemote.exportedAt'));

    // dismissing is a user action too, so it must reach the gist rather than be resurrected
    ev("S.meta.changedAt = Date.now() - 100000;");
    ev("window.__dismissRemote = {exportedAt: Date.now() - 50000};");
    ev("invDismiss(invActiveFlags().find(f=>f.key==='bulk').id)");
    ok('dismiss removes the flag locally', !ev("invActiveFlags().some(f=>f.key==='bulk')"));
    ok('dismiss bumps changedAt past the stale remote',
      !ev('window.__dismissRemote.exportedAt > S.meta.changedAt'),
      'changedAt=' + ev('S.meta.changedAt'));

    ev("S.weights = window.__wSave3; invState().history = invState().history.filter(f=>f.key!=='bulk');");
  } catch (e) {
    ok('manual investigation survives a sync pull', false, e.message);
    ev("if(window.__wSave3) S.weights = window.__wSave3;");
  }

  console.log('=== A PUSH DOES NOT READ AS NEWER THAN US ===');
  try {
    const realFetch = w.fetch;
    w.fetch = () => Promise.resolve({ ok: true, json: () => Promise.resolve({ id: 'gist1' }) });
    ev("S.settings.ghToken='tok'; S.settings.gistId='gist1'; S.meta.changedAt = Date.now() - 100000;");
    await ev("syncPush(false)");
    const pushedAt = ev('_lastPushExportedAt');
    ok('push stamped an exportedAt', pushedAt > 0, pushedAt);
    ok('our own push does not read as newer than us on the next tick',
      !(pushedAt > ev('S.meta.changedAt')),
      'changedAt=' + ev('S.meta.changedAt') + ' pushedAt=' + pushedAt);
    w.fetch = realFetch;
    ev("S.settings.ghToken=''; S.settings.gistId='';");
  } catch (e) {
    ok('a push does not read as newer than us', false, e.message);
    ev("S.settings.ghToken=''; S.settings.gistId='';");
  }

  // A push debounced by schedulePush() (2.5s after save()) can be lost entirely if the tab is
  // backgrounded or killed before the timer fires — exactly what happens finishing a workout
  // and then locking the phone. Nothing previously retried it, so the session sat in
  // localStorage forever, invisible to every other device even though the local app correctly
  // showed it as logged. S.meta.pushedAt tracks what's actually confirmed on the gist;
  // pushUnconfirmedChanges() closes the gap on the next launch.
  console.log('=== PUSHEDAT WATERMARK TRACKS A CONFIRMED PUSH ===');
  try {
    const realFetch = w.fetch;
    w.fetch = () => Promise.resolve({ ok: true, json: () => Promise.resolve({ id: 'gist1' }) });
    // changedAt starts well behind "now" (as it does after a real debounced save()) so the
    // push's own Math.max(changedAt, exportedAt) bump is exercised, not masked by a tie.
    ev("S.settings.ghToken='tok'; S.settings.gistId='gist1'; S.meta.pushedAt=0; S.meta.changedAt = Date.now() - 5000;");
    await ev("syncPush(false)");
    const exportedAt = ev('_lastPushExportedAt');
    ok('push stamped an exportedAt', exportedAt > 0, exportedAt);
    ok('a confirmed push advances pushedAt to exactly what it uploaded',
      ev('S.meta.pushedAt') === exportedAt,
      'pushedAt=' + ev('S.meta.pushedAt') + ' exportedAt=' + exportedAt);
    ok('pushedAt catches up with changedAt so nothing looks stranded right after a push',
      ev('S.meta.pushedAt') === ev('S.meta.changedAt'),
      'pushedAt=' + ev('S.meta.pushedAt') + ' changedAt=' + ev('S.meta.changedAt'));
    w.fetch = realFetch;
    ev("S.settings.ghToken=''; S.settings.gistId='';");
  } catch (e) {
    ok('pushedAt watermark tracks a confirmed push', false, e.message);
    ev("S.settings.ghToken=''; S.settings.gistId='';");
  }

  console.log('=== APPLYPULLED MARKS THE CONSUMED SNAPSHOT AS PUSHED ===');
  try {
    ev("S.meta.changedAt = Date.now() - 100000; S.meta.pushedAt = 0;");
    ev("window.__cuSnap = {exportedAt: Date.now() - 50000, data: JSON.parse(JSON.stringify(S))};");
    ev("applyPulled(JSON.parse(JSON.stringify(window.__cuSnap.data)), window.__cuSnap.exportedAt)");
    ok('consuming a pull leaves nothing pending for the boot catch-up push',
      ev('S.meta.pushedAt') === ev('S.meta.changedAt'),
      'pushedAt=' + ev('S.meta.pushedAt') + ' changedAt=' + ev('S.meta.changedAt'));
  } catch (e) {
    ok('applyPulled marks the consumed snapshot as pushed', false, e.message);
  }

  console.log('=== BOOT CATCH-UP RECOVERS A PUSH LOST TO A KILLED TAB ===');
  try {
    let patchCalls = [];
    const realFetch = w.fetch;
    w.fetch = (url, opts) => {
      if (opts && opts.method === 'PATCH') {
        const body = JSON.parse(opts.body);
        patchCalls.push(JSON.parse(body.files['ironhub_data.json'].content));
      }
      return Promise.resolve({ ok: true, json: () => Promise.resolve({ id: 'gist1' }) });
    };
    ev("S.settings.ghToken='tok'; S.settings.gistId='gist1';");

    // No pending change: pushUnconfirmedChanges must be a no-op (nothing was lost, no API call spent).
    ev("S.meta.changedAt = 5000; S.meta.pushedAt = 5000;");
    await ev("pushUnconfirmedChanges()");
    ok('catch-up does nothing when nothing is pending', patchCalls.length === 0, patchCalls.length);

    // Simulate the real bug: a session gets logged (save() touches changedAt and would
    // debounce a push 2.5s later), then the tab is killed before that timer fires.
    ev("window.__cuLogsBefore = S.logs.length;");
    ev("S.logs.push({id:'catchuptest1', date:'2026-08-18', day:'D1', entries:[{exercise:'Catch-up Test Lift', sets:[{w:135,r:8}]}]}); save();");
    ev("clearTimeout(_pushTimer); _pushTimer = null;"); // the timer that never got to fire
    ok('a save() with a killed debounce leaves changedAt ahead of pushedAt',
      ev('S.meta.changedAt > S.meta.pushedAt'),
      'changedAt=' + ev('S.meta.changedAt') + ' pushedAt=' + ev('S.meta.pushedAt'));
    ok('the lost push really never reached the gist', patchCalls.length === 0, patchCalls.length);

    await ev("pushUnconfirmedChanges()");
    ok('catch-up actually uploaded the stranded session',
      patchCalls.length === 1 && patchCalls[0].data.logs.some(l => l.id === 'catchuptest1'),
      JSON.stringify(patchCalls.map(p => p.data.logs.length)));
    ok('catch-up closes the pushedAt gap',
      ev('S.meta.pushedAt') === ev('S.meta.changedAt'),
      'pushedAt=' + ev('S.meta.pushedAt') + ' changedAt=' + ev('S.meta.changedAt'));

    ev("S.logs = S.logs.filter(l => l.id !== 'catchuptest1');");
    w.fetch = realFetch;
    ev("S.settings.ghToken=''; S.settings.gistId='';");
  } catch (e) {
    ok('boot catch-up recovers a push lost to a killed tab', false, e.message);
    ev("S.logs = S.logs.filter(l => l.id !== 'catchuptest1'); S.settings.ghToken=''; S.settings.gistId='';");
  }

  // The incident this guards against: Device A (PC) logs nothing new today and hits "Push
  // Now". Device B (phone) logged a real session hours earlier that never made it off the
  // device (killed debounce). A's push lands AFTER B's local edit, so it carries a fresher
  // exportedAt despite being strictly less complete. Before this fix, B's next background
  // sync compared timestamps only, saw A's push as "newer," and applyPulled() silently
  // replaced B's local S — destroying the only copy of that session. The fix: push local
  // first, always, before ever accepting an incoming pull.
  console.log('=== BACKGROUND SYNC PUSHES LOCAL EDITS BEFORE PULLING (stale-but-fresher remote must not clobber them) ===');
  try {
    let mockGist = null;
    const realFetch = w.fetch;
    w.fetch = (url, opts) => {
      if (opts && opts.method === 'PATCH') {
        const body = JSON.parse(opts.body);
        const payload = JSON.parse(body.files['ironhub_data.json'].content);
        mockGist = { exportedAt: payload.exportedAt, data: payload.data };
        return Promise.resolve({ ok: true, json: () => Promise.resolve({ id: 'gist1' }) });
      }
      return Promise.resolve({ ok: true, json: () => Promise.resolve({
        files: { 'ironhub_data.json': { content: JSON.stringify({ app: 'ironhub', v: 1, exportedAt: mockGist.exportedAt, data: mockGist.data }) } }
      }) });
    };
    ev("S.settings.ghToken='tok'; S.settings.gistId='gist1'; S.settings.autoSync=true;");

    // Baseline: this device and the gist agree (no marker session yet).
    ev("S.meta.changedAt = Date.now() - 20000; S.meta.pushedAt = S.meta.changedAt;");
    mockGist = { exportedAt: ev('S.meta.changedAt'), data: JSON.parse(ev('JSON.stringify(S)')) };

    // Device B: log a session locally, then the tab gets killed before the debounced push fires.
    ev("S.logs.push({id:'clobbertest1', date:'2026-08-18', day:'D1', entries:[{exercise:'Clobber Test Lift', sets:[{w:225,r:5}]}]}); save();");
    ev("clearTimeout(_pushTimer); _pushTimer = null;");
    const localChangedAt = ev('S.meta.changedAt');

    // Device A: a stale device without the session pushes moments later — fresh timestamp, stale content.
    const staleData = mockGist.data;
    mockGist = { exportedAt: localChangedAt + 50, data: staleData };
    ok('fixture: the stale push out-times the local edit', mockGist.exportedAt > localChangedAt);
    ok('fixture: the stale push really lacks the local session', !mockGist.data.logs.some(l => l.id === 'clobbertest1'));

    await ev("bgSyncTick()");

    ok('the local session survives a background sync racing a stale-but-fresher remote push',
      ev("S.logs.some(l=>l.id==='clobbertest1')"));
    ok('the local edit was actually pushed to the gist, not just left unpulled',
      mockGist.data.logs.some(l => l.id === 'clobbertest1'),
      JSON.stringify(mockGist.data.logs.map(l => l.id)));

    ev("S.logs = S.logs.filter(l=>l.id!=='clobbertest1');");
    w.fetch = realFetch;
    ev("S.settings.ghToken=''; S.settings.gistId='';");
  } catch (e) {
    ok('background sync pushes local edits before pulling', false, e.message);
    ev("S.logs = S.logs.filter(l=>l.id!=='clobbertest1'); S.settings.ghToken=''; S.settings.gistId='';");
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

  // Case 1: every agent's call throws (network, 401, rate limit). All four have to fail for
  // the cycle itself to be reported as failed -- one specialist going down is survivable now
  // and is covered separately below.
  ev("agState().lastRun = ''; agState().lastRunAt = '';");
  ev("S.settings.apiKey = 'sk-test'");
  stubAgents({charlie:'__THROW__', delta:'__THROW__', echo:'__THROW__', zulu:'__THROW__'});
  await ev('agRunAll(true)');
  ok('[api throw] lastRun still stamped', ev('agState().lastRun') === ev('todayKey()'),
     'lastRun=' + ev('agState().lastRun'));
  ok('[api throw] failure was logged', ev("agState().log.some(l=>/Cycle failed/.test(l.text))"));
  ok('[api throw] in-flight flag released', ev('_agRunning') === false);

  // Case 2: a response with no JSON at all \u2014 genuinely unparseable, not recoverable
  ev("agState().lastRun = ''; agState().lastRunAt = '';");
  stubAgents({charlie:'I could not complete that request.', delta:'I could not complete that request.',
              echo:'I could not complete that request.', zulu:'I could not complete that request.'});
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
  unstubAgents();

  // One specialist failing must NOT cost the other two their night. Under the old single-call
  // design a malformed reply took all four down together, which is the reason for the split.
  ev("agState().lastRun = ''; agState().proposals = []; agState().log = []; agState().status = {};");
  stubAgents({charlie:'__THROW__',
              delta:{summary:'delta still reported', proposals:[]},
              echo:{summary:'echo still reported', proposals:[]}});
  await ev('agRunAll(true)');
  ok('a failing specialist does not silence the others',
     ev("!!agState().status.delta && !!agState().status.echo"), JSON.stringify(ev('Object.keys(agState().status)')));
  ok('the failing one is reported rather than hidden',
     ev("agState().log.some(l=>/could not complete/.test(l.text))"));
  ok('the survivors kept their own summaries',
     ev("agState().status.delta.summary") === 'delta still reported', ev("agState().status.delta.summary"));
  unstubAgents();


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

  // --- cards must not close themselves on the refresh timer ---
  // jsdom has no layout engine, so this asserts WHICH BRANCH the markup generator took
  // (does the emitted HTML carry the 'open' class?) rather than any measured height.
  ev('subOpen = {}; activeMainTab = "settings"; navMemory = {settings:"settings"};');
  const closedHTML = ev("subSection('Sleep & performance', '<i>x</i>', false)");
  ok('a sub-section closed by default emits no open class', closedHTML.indexOf('class="sub"') >= 0, closedHTML.slice(0, 80));
  ok('a sub-section carries its key for the toggle to find', closedHTML.indexOf('data-subkey=') >= 0);
  // simulate the user opening it, exactly as the click handler would
  ev("subOpen[subKey('Sleep & performance')] = true;");
  const reopened = ev("subSection('Sleep & performance', '<i>x</i>', false)");
  ok('a sub-section the user opened is still open on the next repaint',
     reopened.indexOf('class="sub open"') >= 0, reopened.slice(0, 90));
  // and an explicit close must survive too, not fall back to openByDefault
  ev("subOpen[subKey('Notes')] = false;");
  const reclosed = ev("subSection('Notes', '<i>x</i>', true)");
  ok('a sub-section the user closed stays closed even if it defaults open',
     reclosed.indexOf('class="sub"') >= 0 && reclosed.indexOf('open') < 0, reclosed.slice(0, 90));
  // keys are per-tab, so two tabs can hold a card with the same title independently
  ev('activeMainTab = "progress"; navMemory = {progress:"progress"};');
  const otherTab = ev("subSection('Notes', '<i>x</i>', true)");
  ok('the same card title on another tab keeps its own state',
     otherTab.indexOf('class="sub open"') >= 0, otherTab.slice(0, 90));
  ev('subOpen = {}; activeMainTab = "progress"; navMemory = {};');

  // --- the split editor's expanded day, same problem, same shape of fix ---
  ev('sdOpen = {};');
  const sdClosed = ev('splitEditorHTML()');
  ok('split editor days start closed', sdClosed.indexOf('class="sd-body"') >= 0);
  ev('sdOpen["D1"] = true;');
  const sdOpened = ev('splitEditorHTML()');
  ok('an expanded split-editor day survives a repaint',
     sdOpened.indexOf('class="sd-body open" id="sdbody-D1"') >= 0);
  ok('only the expanded day is open', sdOpened.indexOf('class="sd-body open" id="sdbody-D2"') < 0);
  ok('the chevron matches the remembered state', sdOpened.indexOf('id="chev-D1">▴') >= 0);
  // the per-exercise HOME substitution row inside a day has the same DOM-only problem
  ev('sdOpen = {"D1":true}; sdHomeOpen = {};');
  ok('a home-substitution row starts closed', ev('splitEditorHTML()').indexOf('class="sd-ex-home"') >= 0);
  ev('sdHomeOpen["D1-0"] = true;');
  ok('an expanded home-substitution row survives a repaint',
     ev('splitEditorHTML()').indexOf('class="sd-ex-home open" id="sdhome-D1-0"') >= 0);
  ok('only the targeted home row is open',
     ev('splitEditorHTML()').indexOf('class="sd-ex-home open" id="sdhome-D1-1"') < 0);
  ev('sdOpen = {}; sdHomeOpen = {};');

  // --- and the timer must not repaint at all when nothing moved ---
  ev('MODE = "review"; activeMainTab = "settings"; navMemory = {settings:"settings"};');
  ev('window.__renders = 0; window.__realSettings = REVIEW_RENDER.settings;');
  ev('REVIEW_RENDER.settings = function(){ window.__renders++; };');
  ev('_tabSig = ""; rerenderActive();');
  ok('first call repaints', ev('window.__renders') === 1, String(ev('window.__renders')));
  ev('rerenderActive();');
  ok('a second call with nothing changed does NOT repaint', ev('window.__renders') === 1, String(ev('window.__renders')));
  ev('S.meta.changedAt = Date.now() + 1234; rerenderActive();');
  ok('a real state change does repaint', ev('window.__renders') === 2, String(ev('window.__renders')));
  ev('rerenderActive(true);');
  ok('force repaints regardless of the signature', ev('window.__renders') === 3, String(ev('window.__renders')));
  ev('REVIEW_RENDER.settings = window.__realSettings; navMemory = {}; activeMainTab = "progress";');

  console.log('=== PULL LANDING MID-CYCLE (stale reference) ===');
  // The real-world failure: a background gist pull completes during the ~60s API call.
  // applyPulled replaces S wholesale, so anything written through a reference captured before
  // the await lands on an orphaned object and is silently dropped by save().
  ev("window.__realCall2 = callClaudeWithTools;");
  ev("agState().lastRun = ''; agState().lastRunAt = ''; agState().status = {};");
  ev("S.settings.apiKey = 'sk-test'");
  // mid-flight, simulate the pull swapping S out from under the running cycle
  ev("window.__realData2 = callClaudeWithData; window.__swapped = false;");
  ev(`callClaudeWithData = async function(msgs, sys){
        // swap S out exactly once, part-way through the fan-out
        if(!window.__swapped){
          window.__swapped = true;
          window.__midDump = JSON.parse(JSON.stringify(S));
          window.__midDump.agents.lastRun = '2020-01-01';
          window.__midDump.agents.lastRunAt = '2020-01-01T00:00:00.000Z';
          window.__midDump.agents.status = {};
          applyPulled(window.__midDump);
        }
        const who = /You are CHARLIE/.test(sys) ? 'charlie'
                  : /You are DELTA/.test(sys)   ? 'delta'
                  : /You are ECHO/.test(sys)    ? 'echo'
                  : 'zulu';
        return {text: JSON.stringify({summary: who==='zulu' ? 'brief after swap' : who,
                                      brief:'b', proposals:[]}), toolsUsed:0};
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
  ev("callClaudeWithData = window.__realData2;");

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

  // a non-lead agent through its own handler. agSendChat routes through the read-only tool
  // loop now (it can look history up), so the stub has to sit on that seam.
  ev("window.__realData4 = callClaudeWithData;");
  ev("callClaudeWithData = async () => ({text:'ack from agent', toolsUsed:0});");
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
  ev("if(window.__realData4) callClaudeWithData = window.__realData4;");

  console.log('=== ADVISORY PROPOSALS FOLD INTO LOG, NOT THE QUEUE ===');
  ev("agState().lastRun = ''; agState().lastRunAt = ''; agState().proposals = []; agState().log = [];");
  ev("S.settings.apiKey = 'sk-test'");
  ev("window.__realCall4 = callClaudeWithTools;");
  stubAgents({
    zulu:    {summary:'brief', brief:'nothing needs you today', proposals:[
               {title:'Watch Thursday squat session', reasoning:'fatigue is elevated', fix:null}]},
    delta:   {summary:'d', proposals:[
               {title:'Bump bench volume', reasoning:'trend is clean', fix:{type:'cal', payload:{delta:100}}}]},
    charlie: {summary:'c', proposals:[]},
    echo:    {summary:'e', proposals:[]}
  });
  await ev('agRunAll(true)');
  ok('advisory-only proposal is NOT in the queue', ev("agState().proposals.some(p=>p.title==='Watch Thursday squat session')") === false,
     JSON.stringify(ev('agState().proposals')));
  ok('advisory text is preserved in the activity log instead', ev("agState().log.some(l=>/Watch Thursday squat session/.test(l.text))"));
  ok('a real fix still reaches the queue normally', ev("agState().proposals.some(p=>p.title==='Bump bench volume' && p.fix && p.fix.type==='cal')"));
  ok('queue contains exactly one entry (the real fix, not the advisory)', ev('agState().proposals.length') === 1,
     'count=' + ev('agState().proposals.length'));

  // A malformed fix (invalid shape, not explicitly null) must never reach the queue, and its
  // reasoning must never be laundered into the log AS ADVICE \u2014 that's a model error, not an
  // intentional advisory.
  //
  // It must, however, leave a trace. This assertion used to forbid any mention at all, which
  // meant a rejected fix vanished completely while the agent's free-text summary went on
  // announcing the change ("capping Incline DB Press at 60 lb") \u2014 you'd read that, believe an
  // override was live, and LIVE would quietly disagree. That was a real reported bug. So the
  // rule is sharper now, not looser: no advisory laundering, but a visible rejection notice.
  ev("agState().proposals = []; agState().log = [];");
  stubAgents({
    zulu: {summary:'brief2', proposals:[
            {title:'Bad fix attempt', reasoning:'SHOULD_NOT_APPEAR', fix:{type:'cal', payload:{delta:99999}}}]}
  });
  await ev('agRunAll(true)');
  ok('malformed fix does not reach the queue', ev("agState().proposals.some(p=>p.title==='Bad fix attempt')") === false);
  ok('malformed fix reasoning is NOT presented as advice',
     ev("!agState().log.some(l=>/SHOULD_NOT_APPEAR/.test(l.text))"));
  ok('malformed fix leaves a visible rejection notice instead of vanishing',
     ev("agState().log.some(l=>/Bad fix attempt/.test(l.text) && /NOTHING was applied/.test(l.text))"),
     JSON.stringify(ev('agState().log.map(l=>l.text)')));
  ok('the rejection notice names why it was turned down',
     ev("agState().log.some(l=>/out of the allowed range/.test(l.text))"),
     JSON.stringify(ev('agState().log.map(l=>l.text)')));
  // and a bad exercise name is named specifically, since that is the common real case
  ev("agState().proposals = []; agState().log = [];");
  stubAgents({
    delta: {summary:'d', proposals:[
             {title:'Cap the trap bar', reasoning:'r', fix:{type:'liftReset', payload:{name:'Trap Bar Deadlift', w:225, days:14}}}]}
  });
  await ev('agRunAll(true)');
  ok('an unresolvable lift name is called out by name in the rejection',
     ev("agState().log.some(l=>/Trap Bar Deadlift/.test(l.text) && /not a lift you train/.test(l.text))"),
     JSON.stringify(ev('agState().log.map(l=>l.text)')));

  ev("callClaudeWithTools = window.__realCall4;");
  unstubAgents();

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

  // predictions must not forecast a higher weight. anPredictFor() is gone with the
  // per-lift milestone cards, so this now asserts on the card the tab actually renders.
  ev("anEnsembleEx='Maxed Machine'; anEnsembleRange=182;");
  const mCard = ev('anEnsembleCardHTML()');
  ok('maxed lift card names the machine ceiling', /machine ceiling|MAXED/.test(mCard), mCard.slice(0, 200));
  ok('maxed lift card offers no weight ETA', mCard.indexOf('an-eta') === -1);
  // and the milestone generator itself refuses to invent one
  const mRes = ev("anEnsembleFor('Maxed Machine', 182)");
  ok('maxed lift still projects a trend', mRes.ok === true, JSON.stringify(mRes.why));
  ok('flat maxed trend yields no milestones', ev("anFanMilestones(anEnsembleFor('Maxed Machine',182),182)").length === 0);
  ev('anEnsembleEx=null;');

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

  console.log('=== BENCH PRACTICE REMOVED ===');
  // The standalone Bench Practice log and DELTA's bpFreq target were removed 2026-08-25.
  // These assert the feature is gone from every surface it reached, including the agent
  // prompts — a leftover mention there would have the agents coaching a tool he no longer has.
  ok('the modal and its helpers are gone', ev('typeof openBenchPractice') === 'undefined'
    && ev('typeof saveBenchPractice') === 'undefined' && ev('typeof bpSuggestedWeight') === 'undefined');
  ok('the overlay is out of the DOM', ev("document.getElementById('bpOverlay')") === null);
  ok('welcome screen no longer offers a Bench Practice entry point', !/Bench Practice/i.test(ev('welcomeHTML()')));
  ok('trainingContext no longer feeds agents a bench-practice block', !/BENCH PRACTICE/.test(ev('trainingContext()')));
  const agCtxNoBp = ev('agContext()') + ev('agSharedBrief()') + ev('AG_ROLE_BRIEF').delta + ev('AG_FIX_MENU').delta;
  ok('no agent prompt still mentions bench practice or bpFreq', !/bench practice|bpFreq/i.test(agCtxNoBp),
    (agCtxNoBp.match(/.{0,60}(bench practice|bpFreq).{0,60}/i) || [''])[0]);
  ok('bpFreq is no longer a valid fix type', ev('AG_FIX_TYPES').indexOf('bpFreq') === -1);
  ok('agValidateFix rejects a bpFreq proposal outright',
    ev('agValidateFix')({ type: 'bpFreq', payload: { daysPerWeek: 2, pct: 80 } }) === null);
  ok('agApplyFix refuses to apply one', ev('agApplyFix')({ type: 'bpFreq', payload: { daysPerWeek: 2, pct: 80 } }) === false);

  // stale state left over from the feature: dropped on first touch, exactly as V4's
  // dateOverrides were. A pending bpFreq proposal goes too — its Approve button could
  // now only ever fail, since agValidateFix() no longer knows the type.
  ev("S.benchPractice = [{date:'2026-08-01', sets:[{w:135,r:5}]}]; S.benchPracticeFreq = {daysPerWeek:2, pct:80};");
  ev("agState().proposals.push({id:'bp-stale-pending', agent:'delta', title:'stale bp', status:'pending', fix:{type:'bpFreq', payload:{daysPerWeek:2, pct:80}}});");
  ev("agState().proposals.push({id:'bp-stale-done', agent:'delta', title:'old bp', status:'approved', fix:{type:'bpFreq', payload:{daysPerWeek:2, pct:80}}});");
  ok('pruneRemovedKeys reports it changed something', ev('pruneRemovedKeys()') === true);
  ok('benchPractice is pruned from state', ev("'benchPractice' in S") === false);
  ok('benchPracticeFreq is pruned from state', ev("'benchPracticeFreq' in S") === false);
  ok('a pending bpFreq proposal is dropped from the queue',
    ev("agState().proposals.some(function(p){ return p.id==='bp-stale-pending'; })") === false);
  ok('an already-decided bpFreq proposal is kept as history',
    ev("agState().proposals.some(function(p){ return p.id==='bp-stale-done'; })") === true);

  // cleanup
  ev("agState().proposals = agState().proposals.filter(function(p){ return String(p.id).indexOf('bp-stale-') !== 0; });");

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

  console.log('=== GEAR FLAGS (wraps / belt / knee sleeves) ===');
  try {
    const gear = n => call('gearFor', n);
    // pressing loads the wrist, but a bench press needs neither belt nor sleeves
    const bench = gear('Barbell Bench Press');
    ok('bench: wraps yes', bench.wraps === true);
    ok('bench: belt no', bench.belt === false);
    ok('bench: sleeves no', bench.sleeves === false);
    // back squat is the inverse: belt + sleeves, bar rides the back so no wraps
    const sq = gear('Barbell Back Squat');
    ok('back squat: wraps no', sq.wraps === false);
    ok('back squat: belt yes', sq.belt === true);
    ok('back squat: sleeves yes', sq.sleeves === true);
    // front rack forces wrist extension -> all three
    const fsq = gear('Front Squat');
    ok('front squat: all three', fsq.wraps && fsq.belt && fsq.sleeves);
    // isolation work gets nothing
    const lat = gear('Cable Lateral Raise');
    ok('lateral raise: none', !lat.wraps && !lat.belt && !lat.sleeves);
    const lc = gear('Machine Leg Curl');
    ok('leg curl: none', !lc.wraps && !lc.belt && !lc.sleeves);
    // "leg press" contains "press" but must not read as a wrist-loaded press
    const lp = gear('Leg Press');
    ok('leg press: wraps no (not an upper-body press)', lp.wraps === false);
    ok('leg press: belt + sleeves', lp.belt === true && lp.sleeves === true);
    // hinges earn a belt, nothing else
    const dl = gear('Trap Bar Deadlift');
    ok('deadlift: belt only', dl.belt === true && dl.wraps === false && dl.sleeves === false);
    // seated/machine pressing does not load the spine
    ok('seated shoulder press: no belt', gear('Seated Dumbbell Shoulder Press').belt === false);
    ok('standing OHP: belt', gear('Standing Overhead Press').belt === true);
    // unilateral squat patterns load the knee but aren't a braced axial lift
    const bss = gear('Bulgarian Split Squat');
    ok('split squat: sleeves but no belt', bss.sleeves === true && bss.belt === false);
    ok('goblet squat: sleeves but no belt', gear('Goblet Squat').sleeves === true && gear('Goblet Squat').belt === false);
    // unknown names still resolve without throwing
    ok('unknown lift resolves', typeof gear('Some Novel Machine Thing').belt === 'boolean');
    ok('empty name resolves', gear('').wraps === false);

    // the card must actually render the flags, between Setup and Cues
    const card = call('exInfoCardHTML', 'Barbell Back Squat');
    ok('card has a Gear section', card.indexOf('>Gear<') >= 0);
    ok('card lists all three items',
      card.indexOf('Wrist Wraps') >= 0 && card.indexOf('Belt') >= 0 && card.indexOf('Knee Sleeves') >= 0);
    ok('gear sits between Setup and Cues',
      card.indexOf('>Setup<') < card.indexOf('>Gear<') && card.indexOf('>Gear<') < card.indexOf('>Cues<'));
    // squat: Belt/Knee Sleeves affirmative, Wrist Wraps struck out
    const wrapItem = /<div class="gear-item no"><span>✗<\/span>Wrist Wraps<\/div>/.test(card);
    const beltItem = /<div class="gear-item"><span>✓<\/span>Belt<\/div>/.test(card);
    ok('squat card marks Wrist Wraps with an X', wrapItem, card.slice(card.indexOf('Gear'), card.indexOf('Gear') + 320));
    ok('squat card marks Belt with a check', beltItem);
    // and the LIVE screen reaches the same card through the same modal
    ok('live info button opens showExInfo', typeof ev('showExInfo') === 'function');
  } catch (e) {
    ok('gear flags section', false, e.message);
  }

  console.log('=== STRENGTH BLOCK: PATTERN CLASSIFICATION ===');
  try {
    const pat = n => ev('mesoPattern(' + JSON.stringify(n) + ')');
    ok('back squat -> squat', pat('Barbell Back Squat') === 'squat');
    ok('leg press -> squat', pat('Leg Press') === 'squat');
    ok('deadlift -> hinge', pat('Trap Bar Deadlift') === 'hinge');
    ok('hip thrust -> hinge', pat('Hip Thrust Machine') === 'hinge');
    ok('bench -> push', pat('Barbell Bench Press') === 'push');
    ok('lat pulldown -> pull', pat('Lat Pulldown') === 'pull');
    ok('cable row -> pull', pat('Cable Row') === 'pull');
    // regression: unanchored /chin/ matches inside "maCHINe", which classified every
    // machine press as a pull and scrambled the day anchors
    ok('overhead press MACHINE -> push, not pull', pat('Overhead Press Machine') === 'push', pat('Overhead Press Machine'));
    ok('smith MACHINE bench -> push', pat('Smith Machine Bench Press') === 'push', pat('Smith Machine Bench Press'));
    ok('incline press MACHINE -> push', pat('Incline Press Machine') === 'push', pat('Incline Press Machine'));
    ok('row machine still reads as a pull', pat('Row Machine') === 'pull', pat('Row Machine'));
    ok('chin-up still reads as a pull', pat('Chin-Up') === 'pull', pat('Chin-Up'));
    // plural: /\bdip\b/ missed "Dips" entirely
    ok('Dips -> push', pat('Dips') === 'push', pat('Dips'));
    ok('Dips gets wrist wraps', ev('gearFor("Dips")').wraps === true);
  } catch (e) {
    ok('pattern classification', false, e.message);
  }

  console.log('=== STRENGTH BLOCK: SPLIT GENERATION ===');
  try {
    const gen = JSON.parse(ev('JSON.stringify(mesoGenerateStrengthSplit())'));
    const keys = Object.keys(gen.split);
    ok('collapses to exactly three days', keys.length === 3, keys.join(','));
    ok('uses S1/S2/S3 keys, not D-keys', keys.join(',') === 'S1,S2,S3', keys.join(','));
    ok('days are named', keys.every(k => !!gen.split[k].name), keys.map(k => gen.split[k].name).join('|'));
    ok('day colours are tokens, not raw hex', keys.every(k => /^var\(--/.test(gen.split[k].hex || '')),
      keys.map(k => gen.split[k].hex).join('|'));
    ok('five exercises per day', keys.every(k => gen.split[k].exercises.length === 5),
      keys.map(k => k + ':' + gen.split[k].exercises.length).join(' '));
    ok('two heavy compounds per day', keys.every(k =>
      gen.split[k].exercises.filter(x => x.repMode === 'str').length === 2),
      keys.map(k => k + ':' + gen.split[k].exercises.filter(x => x.repMode === 'str').length).join(' '));
    // no exercise appears on two days — six days of lifts have to divide, not duplicate
    const all = keys.flatMap(k => gen.split[k].exercises.map(x => x.name));
    ok('no exercise duplicated across days', new Set(all).size === all.length, all.join(','));

    // the anchor rule: each day's heaviest pattern is distinct...
    const heavyPats = keys.map(k => gen.split[k].exercises.filter(x => x.repMode === 'str')
      .map(x => ev('mesoPattern(' + JSON.stringify(x.name) + ')')));
    const anchors = heavyPats.map(p => p[0]);
    ok('each day anchors a different movement pattern', new Set(anchors).size === 3, anchors.join(','));
    // ...and the secondary doesn't smuggle an adjacent day's pattern back in. Only
    // S1/S2 and S2/S3 are consecutive — two rest days sit between S3 and the next S1.
    // Pull is exempt by design (see the generator comment): with squat/hinge/push all
    // taken as anchors, barring pull would force heavy squat + heavy hinge into one day.
    let collision = '';
    for (let i = 0; i < 2; i++) {
      const shared = heavyPats[i].filter(p => p !== 'pull' && heavyPats[i + 1].indexOf(p) >= 0);
      if (shared.length) collision = 'S' + (i + 1) + '/S' + (i + 2) + ' both load ' + shared.join(',') + ' heavy';
    }
    ok('no fatiguing pattern loaded heavy on consecutive days', collision === '', collision);
    // the thing the exemption is protecting against
    let axial = '';
    heavyPats.forEach((p, i) => {
      if (p.indexOf('squat') >= 0 && p.indexOf('hinge') >= 0) axial = 'S' + (i + 1) + ' stacks heavy squat and hinge';
    });
    ok('no day stacks heavy squat and heavy hinge together', axial === '', axial);
    ok('reports what it cut', gen.rationale.some(r => /Cut for the block/.test(r)), gen.rationale.join(' | '));
  } catch (e) {
    ok('strength split generation', false, e.message);
  }

  console.log('=== STRENGTH BLOCK: ROTATION OVERRIDES THE SCHEDULE ===');
  try {
    const before = ev('scheduledDayFor(todayKey())');
    ev("mesoStart({phases:[{id:'p1',type:'str',name:'Strength',weeks:2,repLo:3,repHi:5,rpeLo:8,rpeHi:9}],repeat:false,cycles:1}, todayKey())");
    ev('mesoEnsureProposals()');
    const start = ev('mesoActive().weeks[0].startKey');
    const bid = ev('mesoActive().weeks[0].blockId');
    const at = n => ev('scheduledDayFor(mesoAddDays(' + JSON.stringify(start) + ',' + n + '))');

    // proposed but not approved changes NOTHING — same gate as the split itself
    ok('unapproved block leaves the schedule alone', at(0) === ev('S.schedule[new Date(' + JSON.stringify(start) + '+"T00:00:00").getDay()] || "REST"'), at(0));
    ok('unapproved block leaves the split alone', ev('Object.keys(activeSplitObj()).join(",")').indexOf('S1') < 0);

    ev('mesoApproveSplit(' + JSON.stringify(bid) + ')');
    ok('approved block swaps the split in', ev('Object.keys(activeSplitObj()).join(",")') === 'S1,S2,S3');
    // 3 on / 2 off, anchored to the block's first day rather than the calendar week
    const seq = [];
    for (let i = 0; i < 15; i++) seq.push(at(i));
    ok('rotation is S1,S2,S3,REST,REST', seq.slice(0, 5).join(',') === 'S1,S2,S3,REST,REST', seq.slice(0, 5).join(','));
    ok('rotation repeats on a 5-day cycle', seq[5] === 'S1' && seq[10] === 'S1', seq.join(','));
    ok('rotation does not follow the 7-day week', seq[7] !== seq[0], seq[0] + ' vs ' + seq[7]);
    ok('9 training days across the 14-day block', seq.slice(0, 14).filter(d => d !== 'REST').length === 9,
      String(seq.slice(0, 14).filter(d => d !== 'REST').length));
    // day 15 is past the last week's endKey -> back to the permanent schedule
    ok('schedule reverts the day the block ends', seq[14].indexOf('S') !== 0, seq[14]);

    // a manual day override still wins over the rotation
    ev('S.overrideDay={date:todayKey(), day:"S2"}');
    ok('manual override still beats the rotation', ev('currentDayKey()') === 'S2');
    ev('S.overrideDay=null');

    // block day keys must resolve everywhere that used to read S.split directly
    ok('dayMeta resolves a block key', !!ev('dayMeta("S1")'));
    ok('dayName resolves a block key', ev('dayName("S1")').length > 0, ev('dayName("S1")'));
    ok('S1 is genuinely absent from the permanent split', ev('!S.split.S1') === true);
    ok('dayExNames returns the block exercises', ev('dayExNames("S1").length') === 5);

    // the two renders that read a day name unguarded, and would white-screen on launch
    ev('S.overrideDay={date:todayKey(), day:"S1"}');
    try { ev('renderHeader()'); ok('renderHeader survives a block day key', true); }
    catch (e) { ok('renderHeader survives a block day key', false, e.message); }
    try { ev('setAccent()'); ok('setAccent survives a block day key', true); }
    catch (e) { ok('setAccent survives a block day key', false, e.message); }
    try {
      ev('renderToday()');
      const t = w.document.getElementById('today').innerHTML;
      ok('Today renders the block day, not the permanent one', t.indexOf('S1 — ') >= 0, t.slice(0, 200));
      ok('Today shows the block exercises', ev('dayExNames("S1")').every(n => t.indexOf(n) >= 0));
    } catch (e) { ok('renderToday survives a block day key', false, e.message); }

    // manual 3-6 (STR) vs accessory toggle on a strength-block exercise, reachable from the
    // block's own split-edit overlay (mesoOpenSplitEdit) — the auto-classifier's compound
    // guess is a starting point, not a guarantee (it mistagged a single-arm row once).
    ev("_mesoEditBlock = " + JSON.stringify(bid) + ";");
    const s1ExBeforeToggle = ev("JSON.stringify(mesoActive().splits[" + JSON.stringify(bid) + "].split.S1.exercises)");
    const anchorRepModeBefore = ev("mesoActive().splits[" + JSON.stringify(bid) + "].split.S1.exercises[0].repMode");
    ok('control: block anchor exercise starts tagged STR by the generator', anchorRepModeBefore === 'str');
    ev('mesoEdToggleRepMode("S1", 0)');
    ok('mesoEdToggleRepMode flips repMode off',
       ev("mesoActive().splits[" + JSON.stringify(bid) + "].split.S1.exercises[0].repMode") == null);
    ev('mesoEdToggleRepMode("S1", 0)');
    ok('mesoEdToggleRepMode flips repMode back on',
       ev("mesoActive().splits[" + JSON.stringify(bid) + "].split.S1.exercises[0].repMode") === 'str');
    ok('toggling only touches the targeted exercise',
       ev("JSON.stringify(mesoActive().splits[" + JSON.stringify(bid) + "].split.S1.exercises)") === s1ExBeforeToggle);
    ok('mesoEdToggleRepMode never touches the permanent split', ev('!S.split.S1') === true);
    ev('_mesoEditBlock = null;');

    ok('mesoActiveStrBlockId finds the live block', ev('mesoActiveStrBlockId()') === bid, ev('mesoActiveStrBlockId()'));

    // agents were blind to an active strength block — the nightly context never mentioned it
    // at all, so DELTA/ZULU would reason about his usual split while he's actually running
    // S1/S2/S3 this week. agContext() must surface the block's real content and dates.
    const ctxWithBlock = ev('agContext()');
    ok('agent context flags the active meso strength block', /ACTIVE MESO STRENGTH BLOCK/.test(ctxWithBlock));
    ok('agent context shows the block\'s actual exercises', ctxWithBlock.indexOf('Barbell Back Squat') >= 0, ctxWithBlock.slice(0, 400));
    ok('agent context tells agents this is temporary, not a plan deviation',
       /replaces the permanent split|REPLACES the permanent split/i.test(ctxWithBlock));
    ev('mesoStop();');
    ok('agent context drops the block section once it ends', !/ACTIVE MESO STRENGTH BLOCK/.test(ev('agContext()')));
    // re-approve so the rest of this section's cleanup below runs against a real state
    ev("mesoStart({phases:[{id:'p1',type:'str',name:'Strength',weeks:2,repLo:3,repHi:5,rpeLo:8,rpeHi:9}],repeat:false,cycles:1}, todayKey()); mesoEnsureProposals(); mesoApproveSplit(mesoActive().weeks[0].blockId);");

    // sessions logged during the block keep their label after the block is gone
    ev("live = {date:todayKey(), day:'S1', startedAt:Date.now(), exercises:[{name:'Barbell Back Squat', sets:[{w:185,r:5}]}], curIdx:0};");
    ev('endLiveSession()');
    const rec = ev('S.logs[S.logs.length-1]');
    ok('log stamps the day name at save time', rec.day === 'S1' && !!rec.dayName, JSON.stringify({ d: rec.day, n: rec.dayName }));
    ev("S.logs = S.logs.filter(l => l.day !== 'S1');");
    ev('live = null');

    // cleanup — the plan must not leak into later sections
    ev('S.overrideDay=null'); ev('mesoStop()');
    ok('cleanup: schedule restored', ev('scheduledDayFor(todayKey())') === before, ev('scheduledDayFor(todayKey())'));
    ok('cleanup: permanent split back in force', ev('Object.keys(activeSplitObj()).join(",")') === ev('Object.keys(S.split).join(",")'));
  } catch (e) {
    ok('strength block rotation', false, e.message);
    ev('S.overrideDay=null'); ev('mesoStop()'); ev('live=null');
  }

  console.log('=== CALENDAR OVERRIDE REMOVED (V4) ===');
  try {
    // The exact-date override is gone by request. It existed to work around a plan model that
    // could only think in whole weeks; a mesocycle phase can be measured in days now, so the
    // thing it papered over does not exist any more.
    ok('the override editor is gone', ev('typeof dateOverridesEditorHTML') === 'undefined');
    ok('its mutators are gone too',
       ev('typeof dateOverrideAdd') === 'undefined' && ev('typeof dateOverrideSetDay') === 'undefined' &&
       ev('typeof dateOverrideRemove') === 'undefined');

    // The schedule must ignore leftover data entirely -- his live state still contains
    // entries written before the removal, and they must not quietly keep applying.
    ev("S.scheduleMode='dow'; S.schedule={0:'REST',1:'D1',2:'D2',3:'D3',4:'D4',5:'D5',6:'D6'};");
    ok('control: dow map gives D5 on that Friday', ev("scheduledDayFor('2026-08-21')") === 'D5', ev("scheduledDayFor('2026-08-21')"));
    ev("S.dateOverrides = {'2026-08-21':'S1'};");   // simulate leftover state from before V4
    ok('a leftover override no longer changes the schedule',
       ev("scheduledDayFor('2026-08-21')") === 'D5', ev("scheduledDayFor('2026-08-21')"));
    ev("S.scheduleMode='cycle'; S.cycleSchedule={anchor:'2026-08-20', pattern:['D1','D2','D3','D4','D5','D6','REST']};");
    ok('and it does not override the rotating cycle either',
       ev("scheduledDayFor('2026-08-21')") === 'D2', ev("scheduledDayFor('2026-08-21')"));
    ev("S.scheduleMode='dow';");

    // and the orphaned key gets pruned rather than riding along in every gist push forever
    ok('leftover data is present before the prune', ev("'dateOverrides' in S") === true);
    ok('pruneRemovedKeys reports that it removed something', ev('pruneRemovedKeys()') === true);
    ok('the orphaned key is gone', ev("'dateOverrides' in S") === false);
    ok('pruning again is a no-op', ev('pruneRemovedKeys()') === false);
    ok('a fresh state never has the key', ev("'dateOverrides' in DEFAULT_STATE") === false);

    // --- an active meso strength-block rotation still outranks a dateOverrides entry ---
    // Use the block's own start date (always position 0 of the rotation = S1), not todayKey():
    // mesoStart() rounds the start back to that week's Monday, so todayKey() itself can land
    // anywhere in the 5-day rotation (including a REST slot) depending on which real weekday
    // the suite happens to run on.
    const before2 = ev('scheduledDayFor(todayKey())');
    ev("mesoStart({phases:[{id:'p2',type:'str',name:'Strength',weeks:2,repLo:3,repHi:5,rpeLo:8,rpeHi:9}],repeat:false,cycles:1}, todayKey())");
    ev('mesoEnsureProposals()');
    const start2 = ev('mesoActive().weeks[0].startKey');
    const bid2 = ev('mesoActive().weeks[0].blockId');
    ev('mesoApproveSplit(' + JSON.stringify(bid2) + ')');
    ok('an active meso rotation drives the day on its own dates',
       ev('scheduledDayFor(' + JSON.stringify(start2) + ')') === 'S1', ev('scheduledDayFor(' + JSON.stringify(start2) + ')'));
    ev('mesoStop();');
    ok('cleanup: schedule restored after the meso rotation check',
       ev('scheduledDayFor(todayKey())') === before2, ev('scheduledDayFor(todayKey())'));

    // --- deload window: exact lower AND upper bound (the bug this task fixed) ---
    ev("S.deload = {startedAt:'2026-08-25', until:'2026-08-27'};");
    const fakeDeloadDay = (iso) => {
      ev(`(function(){
        var real = Date;
        window.__fakeDeload = '${iso}';
        Date = function(...args){ return args.length ? new real(...args) : new real(window.__fakeDeload); };
        Date.prototype = real.prototype;
        Object.setPrototypeOf(Date, real);
        window.__realDateDeload = real;
      })();`);
      const v = ev('deloadActive()');
      ev('Date = window.__realDateDeload;');
      return v;
    };
    ok('deload NOT active the day before startedAt (this is the bug: was true without the fix)',
       fakeDeloadDay('2026-08-24T12:00:00') === false);
    ok('deload active on startedAt', fakeDeloadDay('2026-08-25T12:00:00') === true);
    ok('deload active inside the window', fakeDeloadDay('2026-08-26T12:00:00') === true);
    ok('deload active on until (inclusive)', fakeDeloadDay('2026-08-27T12:00:00') === true);
    ok('deload NOT active the day after until', fakeDeloadDay('2026-08-28T12:00:00') === false);

    // agents were blind to deload state too — nothing in the nightly context ever mentioned
    // it, so a flat/lighter week during deload could read as a stall to DELTA/ZULU.
    ev("S.deload = {startedAt:todayKey(), until:todayKey()};");
    ok('agent context flags an active deload window', /DELOAD ACTIVE/.test(ev('agContext()')));
    ok('agent context tells agents not to read it as a stall', /not flag this window as a stall/.test(ev('agContext()')));
    ev('S.deload = null;');
    ok('agent context drops the deload line once it ends', !/DELOAD ACTIVE/.test(ev('agContext()')));

    // startDeloadWeek must accept explicit overrides without breaking its no-arg default use
    ev("startDeloadWeek('2026-08-27','2026-08-25')");
    ok('startDeloadWeek honors explicit start/until overrides',
       ev('S.deload.startedAt') === '2026-08-25' && ev('S.deload.until') === '2026-08-27', JSON.stringify(ev('S.deload')));
    ev('S.deload = null;');

    // With the standalone block gone, S.split is the only day map outside an approved meso
    // block -- dayMeta()/activeDayKeys() must not resolve an S-day from anywhere else.
    ok('dayMeta does not resolve an S-day with no block in force', ev('dayMeta("S1")') === null);
    ok('activeDayKeys offers only the permanent split',
       ev('activeDayKeys().join(",")') === ev('Object.keys(S.split).join(",")'),
       ev('activeDayKeys().join(",")'));

    // Settings must distinguish "scheduled for a future date" from "active now" — a deload
    // window set for next week is correctly not active yet, but must not look unset/failed.
    const futureStart = ev("mesoAddDays(todayKey(), 5)");
    const futureUntil = ev("mesoAddDays(todayKey(), 10)");
    ev("S.deload = {startedAt:" + JSON.stringify(futureStart) + ", until:" + JSON.stringify(futureUntil) + "};");
    ok('a future deload window is correctly not active yet', ev('deloadActive()') === false);
    ev('renderSettings()');
    const settingsHtmlScheduled = ev('document.getElementById("settings").innerHTML');
    ok('Settings shows the window as Scheduled, not silently absent', settingsHtmlScheduled.indexOf('Scheduled:') >= 0);
    ok('Settings does not falsely claim the deload is active', settingsHtmlScheduled.indexOf('Deload active') === -1);

    ev("S.dateOverrides = {}; S.deload = null; S.scheduleMode='dow';");
  } catch (e) {
    ok('date overrides / deload window', false, e.message);
    ev("S.dateOverrides = {}; S.deload = null; S.scheduleMode='dow'; mesoStop(); live=null;");
  }

  console.log('=== STANDALONE STRENGTH BLOCK REMOVED ===');
  try {
    // The Settings card that generated a standalone S1/S2/S3 window is gone by request: it was
    // a one-off, and a meso strength block already expresses the same thing as part of a plan.
    // Two things have to hold. Every entry point must be gone -- and, because that card was the
    // ONLY way to turn a window off, a window still sitting in his saved state must stop
    // resolving rather than override the calendar with no UI left that could clear it.
    ok('the generator is gone', ev('typeof generateTempStrengthDays') === 'undefined');
    ok('the window mutators are gone too',
       ev('typeof setTempStrengthWindow') === 'undefined' && ev('typeof clearTempStrengthDays') === 'undefined' &&
       ev('typeof tempStrengthDayFor') === 'undefined' && ev('typeof tempStrengthActive') === 'undefined');
    ok('the Settings editor and its rep-mode toggles are gone',
       ev('typeof tempStrengthEditorHTML') === 'undefined' && ev('typeof tempStrengthToggleRepMode') === 'undefined' &&
       ev('typeof toggleTempRepMode') === 'undefined');

    ev("mesoStop(); live=null; S.overrideDay=null; S.deload=null;");
    ev("S.scheduleMode='dow'; S.schedule={0:'REST',1:'D1',2:'D2',3:'D3',4:'D4',5:'D5',6:'D6'};");
    // Fixed dates: currentDayKey() resolves against the real calendar, so anything leaning on
    // "today" is red on whichever weekday the suite happens to run.
    ok('control: the dow map owns 2026-08-21 (a Friday)', ev("scheduledDayFor('2026-08-21')") === 'D5', ev("scheduledDayFor('2026-08-21')"));

    // exactly what his phone is still carrying: a generated block AND a window covering today
    ev("S.tempStrengthSplit = {S1:{name:'Squat Day',hex:'#F6862F',exercises:[{name:'Leftover Block Lift',inc:15,repMode:'str'}]}," +
       "S2:{name:'Press Day',hex:'#46CDBA',exercises:[{name:'Leftover Press',inc:10}]}," +
       "S3:{name:'Pull Day',hex:'#B79BFF',exercises:[{name:'Leftover Pull',inc:10}]}};");
    ev("S.tempStrengthWindow = {start:'2026-08-19', end:'2026-08-26'};");
    ok('a leftover window no longer puts S1 on the calendar',
       ev("scheduledDayFor('2026-08-21')") === 'D5', ev("scheduledDayFor('2026-08-21')"));
    ev("S.scheduleMode='cycle'; S.cycleSchedule={anchor:'2026-08-20', pattern:['D1','D2','D3','D4','D5','D6','REST']};");
    ok('and it does not override the rotating cycle either',
       ev("scheduledDayFor('2026-08-21')") === 'D2', ev("scheduledDayFor('2026-08-21')"));
    ev("S.scheduleMode='dow';");
    ok('activeSplitObj stays on the permanent split', ev('activeSplitObj() === S.split') === true);
    ok('dayMeta cannot resolve the orphaned S1', ev('dayMeta("S1")') === null);
    ok('activeDayKeys does not offer it in the picker', ev('activeDayKeys().indexOf("S1")') === -1);
    // the property-lookup path that caused the +15-turned-into-5 bug, in reverse: nothing may
    // read a rep mode or an increment out of the orphaned block any more
    ok('isStrMode cannot see the orphaned block STR tag', ev("isStrMode('Leftover Block Lift')") === false);
    ok('agent context never mentions a standalone block', !/STANDALONE STRENGTH BLOCK/.test(ev('agContext()')));

    // and the orphaned keys get pruned rather than riding along in every gist push forever
    ok('the leftover keys are present before the prune',
       ev("'tempStrengthSplit' in S") === true && ev("'tempStrengthWindow' in S") === true);
    ok('pruneRemovedKeys reports that it removed something', ev('pruneRemovedKeys()') === true);
    ok('both orphaned keys are gone', ev("'tempStrengthSplit' in S") === false && ev("'tempStrengthWindow' in S") === false);
    ok('pruning again is a no-op', ev('pruneRemovedKeys()') === false);
    ok('a fresh state carries neither key',
       ev("'tempStrengthSplit' in DEFAULT_STATE") === false && ev("'tempStrengthWindow' in DEFAULT_STATE") === false);

    // Settings must not offer any of it, while the deload half of that card survives intact
    ev('renderSettings()');
    const rmHtml = ev('document.getElementById("settings").innerHTML');
    ok('Settings no longer offers strength-day generation', rmHtml.indexOf('Generate strength days') === -1);
    ok('Settings no longer offers the window inputs', rmHtml.indexOf('tsWinStart') === -1 && rmHtml.indexOf('tsWinEnd') === -1);
    ok('the custom deload control is untouched', rmHtml.indexOf('Custom deload window') >= 0);
  } catch (e) {
    ok('standalone strength block removal', false, e.message);
    ev("S.scheduleMode='dow'; mesoStop(); live=null;");
    ev('try{ pruneRemovedKeys(); }catch(_){}');
  }

  console.log('=== SESSION WARM-UP ===');
  try {
    const EXW = 'Warmup Probe Squat';
    ev("S.logs.push({date:'2026-08-05', day:'D1', entries:[{exercise:'Barbell Back Squat', sets:[{w:185,r:5},{w:185,r:5}]}]});");
    // Not currentDayKey(): that resolves against the real calendar, so on a weekday the
    // split marks as rest it correctly returns null and this section failed for reasons
    // that had nothing to do with warm-ups. Ask about a day that is always a training day.
    const plan = JSON.parse(ev('JSON.stringify(warmupPlanFor("D1"))'));
    ok('a plan is produced for a normal training day', !!plan && Array.isArray(plan.prep));
    ok('prep is keyed to a movement pattern', ['squat', 'hinge', 'push', 'pull'].indexOf(plan.pattern) >= 0, plan.pattern);

    // ramp percentages come off the actual prescribed top set
    const sq = JSON.parse(ev('JSON.stringify(warmupPlanFor("D1"))'));
    ev("S.split.D1.exercises.unshift({name:'Barbell Back Squat', inc:10, repMode:'str'});");
    const sq2 = JSON.parse(ev('JSON.stringify(warmupPlanFor("D1"))'));
    const r = sq2.ramps.find(x => x.name === 'Barbell Back Squat');
    ok('squat gets a ramp', !!r, sq2.ramps.map(x => x.name).join(','));
    if (r) {
      ok('ramp starts with the empty bar on a barbell lift', r.steps[0].w === 'Bar', JSON.stringify(r.steps[0]));
      ok('ramp ends on the working weight', r.steps[r.steps.length - 1].w === r.top && r.steps[r.steps.length - 1].work === true);
      const mid = r.steps.filter(s => s.pct > 0 && !s.work);
      ok('intermediate steps are a fraction of the top set',
        mid.every(s => s.w < r.top && s.w >= 5), JSON.stringify(mid.map(s => s.w)));
      ok('steps climb monotonically', mid.every((s, i) => i === 0 || s.w >= mid[i - 1].w), JSON.stringify(mid.map(s => s.w)));
      ok('40% step is ~40% of the top set',
        Math.abs(mid[0].w - Math.round(r.top * 0.40 / 5) * 5) < 0.01, mid[0].w + ' vs top ' + r.top);
    }
    // the second heavy lift gets feeders, not a second full ramp
    if (sq2.ramps.length > 1) {
      ok('second heavy lift gets a shorter feeder ramp', sq2.ramps[1].steps.length < r.steps.length,
        sq2.ramps[1].steps.length + ' vs ' + r.steps.length);
      ok('non-barbell feeder has no empty-bar step', sq2.ramps[1].steps.every(s => s.w !== 'Bar') ||
        ev('warmIsBarbell(' + JSON.stringify(sq2.ramps[1].name) + ')') === true);
    }
    ok('barbell detection: back squat yes, cable row no',
      ev('warmIsBarbell("Barbell Back Squat")') === true && ev('warmIsBarbell("Cable Row")') === false);

    // gear from improvement #1 surfaces here too
    ok('plan carries the gear flags for the lead lift', typeof sq2.gear.belt === 'boolean');

    // a lift with no history has no target to ramp to -> prep still renders, ramp doesn't
    ev("S.split.D1.exercises.unshift({name:'" + EXW + "', inc:5, repMode:'str'});");
    const noHist = JSON.parse(ev('JSON.stringify(warmupPlanFor("D1"))'));
    ok('unrampable lift is listed, not silently dropped', noHist.unknown.indexOf(EXW) >= 0, noHist.unknown.join(','));
    ev('warmupOpen = true');
    const cardNo = ev('warmupCardHTML("D1")');
    ok('card explains why a lift has no ramp', cardNo.indexOf('no logged history yet') >= 0);

    // the case that matters: a day where NOTHING is rampable. The prep work is the whole
    // point of the card on a day full of untrained lifts, so it must not vanish.
    const savedD6 = ev('JSON.stringify(S.split.D6.exercises)');
    ev("S.split.D6.exercises = [{name:'" + EXW + " Two', inc:5, repMode:'str'}];");
    const bare = JSON.parse(ev('JSON.stringify(warmupPlanFor("D6"))'));
    ok('sanity: that day really has no ramps', bare.ramps.length === 0, JSON.stringify(bare.ramps.map(r => r.name)));
    const cardBare = ev('warmupCardHTML("D6")');
    ok('card still renders with zero ramps', cardBare.length > 0);
    ok('card still renders general prep with zero ramps', cardBare.indexOf('General prep') >= 0, cardBare.slice(0, 200));
    ev('S.split.D6.exercises = ' + savedD6 + ';');

    // warm-up sets are a guide: building a plan must not touch logs or state
    const logsBefore = ev('S.logs.length');
    ev('warmupPlanFor("D1"); warmupCardHTML("D1");');
    ok('building a warm-up logs nothing', ev('S.logs.length') === logsBefore);
    ok('card says warm-up sets are never logged', cardNo.indexOf('never logged') >= 0);

    // collapsed by default outside a strength block, open inside one
    ev('warmupOpen = null; mesoStop();');
    ok('collapsed by default outside a strength block', ev('warmupIsOpen()') === false);
    ev("mesoStart({phases:[{id:'p2',type:'str',name:'Strength',weeks:2,repLo:3,repHi:5,rpeLo:8,rpeHi:9}],repeat:false,cycles:1}, todayKey())");
    ok('auto-opens during a strength block', ev('warmupIsOpen()') === true);
    ev('warmupOpen = false');
    ok('an explicit collapse still wins inside the block', ev('warmupIsOpen()') === false);
    ev('warmupOpen = null; mesoStop();');

    // cleanup
    ev("S.split.D1.exercises = S.split.D1.exercises.filter(x => (typeof x==='object'?x.name:x) !== '" + EXW + "');");
    ev("S.split.D1.exercises.shift();");
    ev("S.logs = S.logs.filter(l => l.date !== '2026-08-05');");
    ok('cleanup: probe lift removed from the split', ev('dayExNames("D1")').indexOf(EXW) < 0);
  } catch (e) {
    ok('session warm-up', false, e.message);
    ev('warmupOpen = null'); ev('mesoStop()');
  }

  console.log('=== PR HISTORY ===');
  try {
    const PRX = 'PR Probe Lift', PRX2 = 'PR Probe Lift Two';
    const mkLog = (date, ex, w, r, extra) =>
      "S.logs.push(Object.assign({id:" + Date.now() + Math.floor(Math.random()*1e6) +
      ", date:'" + date + "', day:'D1', entries:[{exercise:'" + ex + "', sets:[{w:" + w + ",r:" + r + "}]}]}, " + (extra || '{}') + "));";

    // --- state shape ---
    ok('S.prHistory defaults to an array', Array.isArray(ev('S.prHistory')));
    ok('S.prBackfilled defaults false', ev('DEFAULT_STATE.prBackfilled') === false);
    ok('prHistory survives a load() of state that predates it',
      Array.isArray(ev("(function(){ var o = Object.assign(JSON.parse(JSON.stringify(DEFAULT_STATE)), {logs:[]}); return o.prHistory; })()")));

    // --- live detection through checkPRs ---
    // backfill is switched off here so every row asserted below came from checkPRs itself
    ev("S.prHistory = []; S.prBackfilled = true;");
    ev(mkLog('2026-06-01', PRX, 100, 5));       // baseline session
    const before1 = ev('snapshotPRs()');
    ok('snapshotPRs covers every exercise, not just the watch list', before1[PRX] > 116 && before1[PRX] < 117, JSON.stringify(before1[PRX]));
    ev(mkLog('2026-06-04', PRX, 105, 5));       // +5 lb -> PR
    ev('__before1 = ' + JSON.stringify(before1) + ';');
    ev('checkPRs(__before1)');
    let hist = ev("S.prHistory.filter(function(p){ return p.exercise==='" + PRX + "'; })");
    ok('checkPRs records a PR row', hist.length === 1, 'len=' + hist.length);
    ok('PR row carries the set that produced it', hist[0] && hist[0].weight === 105 && hist[0].reps === 5, JSON.stringify(hist[0]));
    ok('PR row carries e1rm', hist[0] && Math.abs(hist[0].e1rm - 122.5) < 0.05, hist[0] && hist[0].e1rm);
    ok('PR row carries the previous best', hist[0] && Math.abs(hist[0].prev - 116.7) < 0.05, hist[0] && hist[0].prev);
    ok('PR row carries the jump size', hist[0] && Math.abs(hist[0].gain - 5.8) < 0.05, hist[0] && hist[0].gain);
    ok('PR row carries the session date', hist[0] && hist[0].date === '2026-06-04', hist[0] && hist[0].date);

    // replaying the same snapshot must not double-log (repeat call / second device via gist)
    ev('checkPRs(__before1)');
    ok('replaying the same snapshot does not double-log',
      ev("S.prHistory.filter(function(p){ return p.exercise==='" + PRX + "'; }).length") === 1);

    // a session that does not beat the best is not a PR
    const before2 = ev('snapshotPRs()');
    ev('__before2 = ' + JSON.stringify(before2) + ';');
    ev(mkLog('2026-06-07', PRX, 95, 5));
    ev('checkPRs(__before2)');
    ok('a non-PR session records nothing',
      ev("S.prHistory.filter(function(p){ return p.exercise==='" + PRX + "'; }).length") === 1);

    // deload weeks are excluded from the e1RM trend, so they cannot set a PR
    const before3 = ev('snapshotPRs()');
    ev('__before3 = ' + JSON.stringify(before3) + ';');
    ev(mkLog('2026-06-10', PRX, 200, 5, '{deload:true}'));
    ev('checkPRs(__before3)');
    ok('a deload session cannot set a PR',
      ev("S.prHistory.filter(function(p){ return p.exercise==='" + PRX + "'; }).length") === 1);
    ok('snapshotPRs ignores deload sets', ev('snapshotPRs()')[PRX] < 130, ev('snapshotPRs()')[PRX]);

    // a lift's first-ever session is a baseline, not a PR
    const before4 = ev('snapshotPRs()');
    ev('__before4 = ' + JSON.stringify(before4) + ';');
    ev(mkLog('2026-06-11', PRX2, 150, 5));
    ev('checkPRs(__before4)');
    ok('first-ever session of a lift is not a PR',
      ev("S.prHistory.filter(function(p){ return p.exercise==='" + PRX2 + "'; }).length") === 0);

    // --- celebration scope is unchanged: history is universal, the popup is not ---
    ev("Array.prototype.slice.call(document.querySelectorAll('.pr-overlay')).forEach(function(o){ o.remove(); });");
    const before5 = ev('snapshotPRs()');
    ev('__before5 = ' + JSON.stringify(before5) + ';');
    ev(mkLog('2026-06-12', PRX, 115, 5));       // PR on a NON-watch-list lift
    ev('checkPRs(__before5)');
    ok('a non-watch-list PR is still recorded',
      ev("S.prHistory.filter(function(p){ return p.exercise==='" + PRX + "'; }).length") === 2);
    ok('a non-watch-list PR does NOT fire the popup',
      ev("document.querySelectorAll('.pr-overlay').length") === 0);

    ev(mkLog('2026-06-13', 'Barbell Bench Press', 900, 3));   // baseline above any real history
    const before6 = ev('snapshotPRs()');
    ev('__before6 = ' + JSON.stringify(before6) + ';');
    ev(mkLog('2026-06-14', 'Barbell Bench Press', 950, 3));
    ev('checkPRs(__before6)');
    ok('a watch-list PR still fires the popup',
      ev("document.querySelectorAll('.pr-overlay').length") === 1);
    ev("Array.prototype.slice.call(document.querySelectorAll('.pr-overlay')).forEach(function(o){ o.remove(); });");
    ev("S.logs = S.logs.filter(function(l){ return l.date!=='2026-06-13' && l.date!=='2026-06-14'; });");
    ev("S.prHistory = S.prHistory.filter(function(p){ return p.exercise!=='Barbell Bench Press' || p.date.slice(0,7)!=='2026-06'; });");

    // --- backfill from existing logs ---
    ev("S.logs = S.logs.filter(function(l){ return !l.entries.some(function(e){ return e.exercise==='" + PRX + "' || e.exercise==='" + PRX2 + "'; }); });");
    ev("S.prHistory = []; S.prBackfilled = false;");
    ev(mkLog('2026-06-01', PRX, 100, 5));   // baseline
    ev(mkLog('2026-06-04', PRX, 105, 5));   // PR
    ev(mkLog('2026-06-07', PRX,  95, 5));   // regression, not a PR
    ev(mkLog('2026-06-11', PRX, 110, 5));   // PR
    const bf = ev("prBackfill().filter(function(p){ return p.exercise==='" + PRX + "'; })");
    ok('backfill emits one row per new max', bf.length === 2, 'len=' + bf.length);
    ok('backfill skips the baseline session', bf[0] && bf[0].date === '2026-06-04', bf[0] && bf[0].date);
    ok('backfill skips a regression session', bf.every(p => p.date !== '2026-06-07'));
    ok('backfill rows carry the real set', bf[1] && bf[1].weight === 110 && bf[1].reps === 5, JSON.stringify(bf[1]));

    // a warm-up plus a top set on one date is ONE pr, not two
    ev("S.logs.push({id:" + (Date.now() + 7) + ", date:'2026-06-18', day:'D1', entries:[{exercise:'" + PRX + "', sets:[{w:112,r:5},{w:120,r:5}]}]});");
    const bf2 = ev("prBackfill().filter(function(p){ return p.exercise==='" + PRX + "' && p.date==='2026-06-18'; })");
    ok('warm-up + top set on one date yields a single PR row', bf2.length === 1, 'len=' + bf2.length);
    ok('that row is the top set, not the warm-up', bf2[0] && bf2[0].weight === 120, bf2[0] && bf2[0].weight);

    ev('prBackfillOnce()');
    const afterOnce = ev("S.prHistory.filter(function(p){ return p.exercise==='" + PRX + "'; }).length");
    ok('prBackfillOnce writes the reconstructed rows', afterOnce === 3, 'n=' + afterOnce);
    ok('prBackfillOnce sets its once-flag', ev('S.prBackfilled') === true);
    ev('S.prBackfilled = false;');
    ev('prBackfillOnce()');
    ok('prBackfillOnce is idempotent',
      ev("S.prHistory.filter(function(p){ return p.exercise==='" + PRX + "'; }).length") === afterOnce);

    // --- render ---
    ev("anPRPick = 'all';");
    ev('renderAnPRs()');
    let out = w.document.getElementById('an_strength').innerHTML;
    ok('PR history renders the lift name', out.indexOf(PRX) >= 0);
    ok('PR history renders the jump size', /\+\d/.test(out), out.slice(0, 200));
    ok('PR history renders a PR count', /\d+ PRs/.test(out));
    ok('PR history renders newest first',
      out.indexOf('120 lb') >= 0 && out.indexOf('120 lb') < out.indexOf('105 lb'),
      'idx120=' + out.indexOf('120 lb') + ' idx105=' + out.indexOf('105 lb'));

    // filter actually filters
    ev(mkLog('2026-06-20', PRX2, 150, 5));
    ev(mkLog('2026-06-23', PRX2, 160, 5));
    ev("S.prBackfilled = false;"); ev('prBackfillOnce()');
    ev('renderAnPRs()');
    out = w.document.getElementById('an_strength').innerHTML;
    // match the row markup (<b>Name</b>), not the filter dropdown — the dropdown lists
    // every lift whatever the filter is, so a bare name search would always hit
    const rowOf = (name) => '>' + name + '</b>';
    ok('unfiltered view shows both lifts', out.indexOf(rowOf(PRX2)) >= 0 && out.indexOf(rowOf(PRX)) >= 0);
    ev("anPRPick = '" + PRX2 + "';");
    ev('renderAnPRs()');
    out = w.document.getElementById('an_strength').innerHTML;
    ok('filtering to one lift hides the other',
      out.indexOf(rowOf(PRX2)) >= 0 && out.indexOf(rowOf(PRX)) < 0);
    ev("anPRPick = 'all';");

    // empty state
    ev("__savedPR = S.prHistory; S.prHistory = []; S.prBackfilled = true;");
    ev('renderAnPRs()');
    out = w.document.getElementById('an_strength').innerHTML;
    ok('empty PR history renders the empty state', out.indexOf('No PRs on record yet') >= 0);
    ev("S.prHistory = __savedPR;");

    // --- wiring ---
    const anSubs = ev("NAV_MODEL.find(function(n){ return n.id==='analytics'; }).subs");
    ok('nav labels the tab PR history',
      anSubs.some(s => s.id === 'an_strength' && s.label === 'PR history'),
      JSON.stringify(anSubs.map(s => s.label)));
    ok('REVIEW_RENDER.an_strength still wired', typeof ev('REVIEW_RENDER').an_strength === 'function');
    ok('the old strength-curve renderer is gone', ev('typeof renderAnStrength') === 'undefined');
    ok('the old strength-curve helper is gone', ev('typeof anStrengthCurve') === 'undefined');

    // cleanup
    ev("S.logs = S.logs.filter(function(l){ return !l.entries.some(function(e){ return e.exercise==='" + PRX + "' || e.exercise==='" + PRX2 + "'; }); });");
    ev("S.prHistory = S.prHistory.filter(function(p){ return p.exercise!=='" + PRX + "' && p.exercise!=='" + PRX2 + "'; });");
    ok('cleanup: PR probe logs removed',
      ev("S.logs.filter(function(l){ return l.entries.some(function(e){ return e.exercise==='" + PRX + "'; }); }).length") === 0);
    ok('cleanup: PR probe history removed',
      ev("S.prHistory.filter(function(p){ return p.exercise==='" + PRX + "'; }).length") === 0);
  } catch (e) {
    ok('PR history section', false, e.message);
  }

  console.log('=== READINESS vs OUTCOME ===');
  try {
    const RDX = 'RD Probe Lift';
    let rdId = 900000;
    const savedRd = ev('JSON.stringify(S.readiness)');
    const resetRd = () => {
      ev('S.readiness = [];');
      ev("S.logs = S.logs.filter(function(l){ return !l.entries.some(function(e){ return e.exercise==='" + RDX + "'; }); });");
    };
    // one session: `tagged` effort-tagged sets of which `hard` are grinds, plus `untagged` bare sets
    const pushSess = (date, tagged, hard, untagged, extra) => {
      const sets = [];
      for (let i = 0; i < tagged; i++) sets.push({ w: 100, r: 8, e: i < hard ? 'grind' : 'solid' });
      for (let i = 0; i < (untagged || 0); i++) sets.push({ w: 100, r: 8 });
      const rec = Object.assign({ id: rdId++, date: date, day: 'D1', entries: [{ exercise: RDX, sets: sets }] }, extra || {});
      ev('S.logs.push(' + JSON.stringify(rec) + ')');
    };
    const pushRd = (date, tier) =>
      ev('S.readiness.push(' + JSON.stringify({ date: date, sleep: '7-8', sore: 'mild', energy: 'ok', tier: tier }) + ')');
    const D = (n) => '2026-05-' + String(n).padStart(2, '0');

    // --- the gate ---
    resetRd();
    ok('no data at all -> not enough', ev('anReadinessOutcome()').ok === false);
    for (let i = 1; i <= 3; i++) { pushRd(D(i), 'low'); pushSess(D(i), 10, 6); }
    for (let i = 11; i <= 14; i++) { pushRd(D(i), 'ok'); pushSess(D(i), 10, 2); }
    ok('3 low sessions is still not enough', ev('anReadinessOutcome()').ok === false,
      'lowN=' + ev('anReadinessOutcome()').groups.low.n);
    pushRd(D(4), 'low'); pushSess(D(4), 10, 6);
    let R = ev('anReadinessOutcome()');
    ok('4 per side clears the gate', R.ok === true);
    ok('low-readiness grind rate is pooled correctly', Math.abs(R.groups.low.rate - 0.6) < 1e-9, R.groups.low.rate);
    ok('ok/high grind rate is pooled correctly', Math.abs(R.groups.rest.rate - 0.2) < 1e-9, R.groups.rest.rate);
    ok('diff is low minus rest', Math.abs(R.diff - 0.4) < 1e-9, R.diff);
    ok('sets/session is tracked per group', Math.abs(R.groups.low.setsPer - 10) < 1e-9, R.groups.low.setsPer);

    // --- exclusions: each must not move the numbers ---
    const baseLowN = R.groups.low.n, baseLowRate = R.groups.low.rate;
    pushRd(D(5), 'low'); pushSess(D(5), 4, 4);                  // under the tagged-set floor
    R = ev('anReadinessOutcome()');
    ok('a session under the tagged-set floor is excluded',
      R.groups.low.n === baseLowN && Math.abs(R.groups.low.rate - baseLowRate) < 1e-9,
      'n=' + R.groups.low.n + ' rate=' + R.groups.low.rate);

    pushSess(D(6), 10, 10);                                     // no check-in that day
    R = ev('anReadinessOutcome()');
    ok('a session with no check-in is excluded',
      R.groups.low.n === baseLowN && R.groups.rest.n === 4, 'lowN=' + R.groups.low.n + ' restN=' + R.groups.rest.n);

    pushRd(D(7), 'low'); pushSess(D(7), 10, 10, 0, { deload: true });
    R = ev('anReadinessOutcome()');
    ok('a deload session is excluded',
      R.groups.low.n === baseLowN && Math.abs(R.groups.low.rate - baseLowRate) < 1e-9,
      'n=' + R.groups.low.n + ' rate=' + R.groups.low.rate);

    // untagged sets are unknown, not clean: they must not dilute the rate
    pushRd(D(8), 'low'); pushSess(D(8), 10, 6, 20);
    R = ev('anReadinessOutcome()');
    ok('untagged sets do not count toward the grind rate',
      Math.abs(R.groups.low.rate - 0.6) < 1e-9, R.groups.low.rate);
    // 4 sessions of 10 sets + one of 30 = 14/session. If untagged sets were dropped from
    // the work-done count too, that last session would read as 10 and the mean would stay 10.
    ok('untagged sets still count as work done',
      Math.abs(R.groups.low.setsPer - 14) < 1e-9, R.groups.low.setsPer);

    // --- pooled, not mean-of-session-rates ---
    resetRd();
    pushRd(D(1), 'low'); pushSess(D(1), 20, 10);   // 50% over a big session
    for (let i = 2; i <= 4; i++) { pushRd(D(i), 'low'); pushSess(D(i), 5, 0); }   // 0% over small ones
    for (let i = 11; i <= 14; i++) { pushRd(D(i), 'high'); pushSess(D(i), 10, 1); }
    R = ev('anReadinessOutcome()');
    // mean of per-session rates would be 12.5%; pooled is 10/35 = 28.57%
    ok('grind rate pools sets, not sessions',
      Math.abs(R.groups.low.rate - 10 / 35) < 1e-9, R.groups.low.rate);
    ok('pooled tagged-set count is exposed', R.groups.low.tagged === 35, R.groups.low.tagged);

    // --- trim effectiveness ---
    ok('trim analysis is unavailable when no log records the choice',
      R.trim.ok === false && R.trim.trimmed === 0 && R.trim.kept === 0, JSON.stringify(R.trim));
    resetRd();
    for (let i = 1; i <= 3; i++) { pushRd(D(i), 'low'); pushSess(D(i), 10, 2, 0, { trimmed: true }); }
    for (let i = 5; i <= 7; i++) { pushRd(D(i), 'low'); pushSess(D(i), 10, 7, 0, { trimmed: false }); }
    for (let i = 11; i <= 14; i++) { pushRd(D(i), 'ok'); pushSess(D(i), 10, 3); }
    R = ev('anReadinessOutcome()');
    ok('trim analysis unlocks at 3 per side', R.trim.ok === true, JSON.stringify(R.trim));
    ok('trimmed grind rate is correct', Math.abs(R.trim.trimRate - 0.2) < 1e-9, R.trim.trimRate);
    ok('kept-full grind rate is correct', Math.abs(R.trim.keptRate - 0.7) < 1e-9, R.trim.keptRate);
    // one fewer kept-full session drops it back below the floor
    ev("S.logs = S.logs.filter(function(l){ return l.date !== '" + D(7) + "'; });");
    ok('trim analysis re-locks below the floor', ev('anReadinessOutcome()').trim.ok === false);
    ev('S.logs.push(' + JSON.stringify({ id: rdId++, date: D(7), day: 'D1', trimmed: false,
        entries: [{ exercise: RDX, sets: Array.from({ length: 10 }, (_, i) => ({ w: 100, r: 8, e: i < 7 ? 'grind' : 'solid' })) }] }) + ')');

    // legacy sessions (no trimmed field) must sit out, not be read as "kept full"
    pushRd(D(9), 'low'); pushSess(D(9), 10, 9);
    R = ev('anReadinessOutcome()');
    ok('a log with no trimmed field counts in neither trim bucket',
      R.trim.trimmed === 3 && R.trim.kept === 3, JSON.stringify(R.trim));
    ok('but it still counts in the low-readiness group', R.groups.low.n === 7, R.groups.low.n);

    // --- endLiveSession stamps the choice ---
    ev("(function(){ live = { date: todayKey(), day:'D1', startedAt: Date.now(), curIdx:0, trimmed:true, home:false," +
       " exercises:[{ name:'RD Trim Stamp Test', sets:[{w:100,r:8,e:'grind'}], done:true }] }; })();");
    ev('endLiveSession()');
    let stamped = ev("S.logs.slice().reverse().find(function(l){ return l.entries.some(function(e){ return e.exercise==='RD Trim Stamp Test'; }); })");
    ok('endLiveSession stamps trimmed:true when the trim was taken', stamped && stamped.trimmed === true, JSON.stringify(stamped && stamped.trimmed));
    ev("S.logs = S.logs.filter(function(l){ return !l.entries.some(function(e){ return e.exercise==='RD Trim Stamp Test'; }); });");
    ev("(function(){ live = { date: todayKey(), day:'D1', startedAt: Date.now(), curIdx:0, trimmed:false, home:false," +
       " exercises:[{ name:'RD Trim Stamp Test', sets:[{w:100,r:8,e:'grind'}], done:true }] }; })();");
    ev('endLiveSession()');
    stamped = ev("S.logs.slice().reverse().find(function(l){ return l.entries.some(function(e){ return e.exercise==='RD Trim Stamp Test'; }); })");
    ok('endLiveSession stamps trimmed:false when the full plan was kept',
      stamped && stamped.trimmed === false, JSON.stringify(stamped && stamped.trimmed));
    ok('"kept full" is a real false, not a missing field',
      stamped && typeof stamped.trimmed === 'boolean', typeof (stamped && stamped.trimmed));
    ev("S.logs = S.logs.filter(function(l){ return !l.entries.some(function(e){ return e.exercise==='RD Trim Stamp Test'; }); });");
    ev('live = null;');

    // --- render ---
    ev('renderAnReadiness()');
    let rout = w.document.getElementById('an_recovery').innerHTML;
    ok('readiness view renders both group rates', /20% grind\/fail/.test(rout) && /70% grind\/fail/.test(rout), rout.slice(0, 300));
    ok('readiness view names the low-readiness verdict', rout.indexOf('Low-readiness days') >= 0);
    ok('readiness view renders the work-done comparison', rout.indexOf('sets/session') >= 0);
    ok('readiness view renders the trim card', rout.indexOf('Is the volume trim working?') >= 0);
    ok('readiness view flags the small sample', rout.indexOf('Sample is still small') >= 0);

    resetRd();
    ev('renderAnReadiness()');
    rout = w.document.getElementById('an_recovery').innerHTML;
    ok('with no data the view says so instead of showing a number',
      rout.indexOf('Not enough data yet') >= 0 && !/\d+% grind/.test(rout), rout.slice(0, 300));

    // --- wiring ---
    const anSubs2 = ev("NAV_MODEL.find(function(n){ return n.id==='analytics'; }).subs");
    ok('nav labels the tab Readiness', anSubs2.some(s => s.id === 'an_recovery' && s.label === 'Readiness'),
      JSON.stringify(anSubs2.map(s => s.label)));
    ok('REVIEW_RENDER.an_recovery still wired', typeof ev('REVIEW_RENDER').an_recovery === 'function');
    ok('the old rest-gap recovery engine is gone', ev('typeof anRecoveryFor') === 'undefined');
    ok('the old recovery renderer is gone', ev('typeof renderAnRecovery') === 'undefined');

    // cleanup
    ev('S.readiness = ' + savedRd + ';');
    ev("S.logs = S.logs.filter(function(l){ return !l.entries.some(function(e){ return e.exercise==='" + RDX + "'; }); });");
    ok('cleanup: readiness probe logs removed',
      ev("S.logs.filter(function(l){ return l.entries.some(function(e){ return e.exercise==='" + RDX + "'; }); }).length") === 0);
    ok('cleanup: readiness restored', ev('JSON.stringify(S.readiness)') === savedRd);
  } catch (e) {
    ok('readiness section', false, e.message);
    ev('live = null;');
  }

  console.log('=== BULK QUALITY ===');
  const savedLogs = ev('JSON.stringify(S.logs)');
  const savedWeights = ev('JSON.stringify(S.weights)');
  try {
    const BQX = 'BQ Probe Lift';
    let bqId = 700000;
    const dayOff = (n) => ev('mesoAddDays(todayKey(), ' + n + ')');
    // The window scans every exercise in the log, so the section runs on an isolated
    // S.logs/S.weights rather than trying to out-shout the other sections' fixtures.
    const resetBq = () => { ev('S.logs = []; S.weights = [];'); };
    // 11 weekly points across 70 days, all inside the default 12-week window
    const OFFS = [];
    for (let i = 0; i <= 10; i++) OFFS.push(-77 + i * 7);
    const seedBw = (fn) => OFFS.forEach((o, i) =>
      ev('S.weights.push(' + JSON.stringify({ date: dayOff(o), lbs: fn(i) }) + ')'));
    // r:1 means epley() returns the weight untouched, so e1RM is exactly what's asserted
    const seedLift = (name, fn, offs, extra) => (offs || OFFS).forEach((o, i) =>
      ev('S.logs.push(' + JSON.stringify(Object.assign(
        { id: bqId++, date: dayOff(o), day: 'D1', entries: [{ exercise: name, sets: [{ w: fn(i), r: 1 }] }] },
        extra || {})) + ')'));

    // --- bodyweight +10 lb, strength +20%: the healthy case ---
    resetBq();
    seedBw(i => 170 + i);
    seedLift(BQX, i => 200 + i * 4);
    let B = ev('anBulkQuality(12)');
    ok('bulk quality reads a full window', B.ok === true, B.why);
    ok('bodyweight change comes off the fitted line', Math.abs(B.bwLb - 10) < 0.01, B.bwLb);
    ok('bodyweight percent change is right', Math.abs(B.bwPct - 5.882) < 0.01, B.bwPct);
    ok('rate of gain is right', Math.abs(B.bwPerWeek - 1) < 0.001, B.bwPerWeek);
    ok('strength percent change is right', Math.abs(B.stPct - 20) < 0.01, B.stPct);
    ok('ratio is strength percent per bodyweight percent', Math.abs(B.ratio - 3.4) < 0.01, B.ratio);
    ok('a 3.4x ratio reads as strength outpacing the scale', B.key === 'strong', B.key);
    ok('per-lift breakdown is exposed for auditing', B.lifts.length === 1 && B.lifts[0].ex === BQX,
      JSON.stringify(B.lifts.map(l => l.ex)));
    ok('per-lift weekly rate is right', Math.abs(B.lifts[0].perWeek - 4) < 0.001, B.lifts[0].perWeek);

    // --- same weight gain, no strength gain: the case this tab exists to catch ---
    ev("S.logs = [];");
    seedLift(BQX, () => 200);
    B = ev('anBulkQuality(12)');
    ok('flat strength under a real weight gain scores weak', B.key === 'weak', B.key + ' ratio=' + B.ratio);
    ok('flat strength reports ~0% gain', Math.abs(B.stPct) < 0.01, B.stPct);

    // --- a ratio between 1 and 2 is "good", not "strong" ---
    ev("S.logs = [];");
    seedLift(BQX, i => 200 + i * 1.764);   // +17.64 lb on 200 = +8.82%, a ratio of ~1.5
    B = ev('anBulkQuality(12)');
    ok('a 1.5x ratio reads as good, not strong', B.key === 'good', B.key + ' ratio=' + B.ratio);
    ok('that ratio lands between 1 and 2', B.ratio > 1 && B.ratio < 2, B.ratio);

    // --- flat bodyweight: no ratio at all, rather than a number divided by noise ---
    ev("S.weights = [];");
    seedBw(() => 170);
    ev("S.logs = [];");
    seedLift(BQX, i => 200 + i * 4);
    B = ev('anBulkQuality(12)');
    ok('flat bodyweight takes the flat branch', B.key === 'flat' && B.flat === true, B.key);
    ok('flat bodyweight yields no ratio', B.ratio === null, B.ratio);
    ok('strength still reported on a flat window', Math.abs(B.stPct - 20) < 0.01, B.stPct);

    // --- falling bodyweight ---
    ev("S.weights = [];");
    seedBw(i => 180 - i);
    B = ev('anBulkQuality(12)');
    ok('falling bodyweight takes the losing branch', B.key === 'losing' && B.losing === true, B.key);
    ok('falling bodyweight yields no ratio', B.ratio === null, B.ratio);

    // --- the gates ---
    ev("S.weights = [];");
    ev('S.weights.push(' + JSON.stringify({ date: dayOff(-70), lbs: 170 }) + ')');
    ev('S.weights.push(' + JSON.stringify({ date: dayOff(-63), lbs: 171 }) + ')');
    B = ev('anBulkQuality(12)');
    ok('two bodyweight points is not enough', B.ok === false && /bodyweight entries/.test(B.why), B.why);
    ev("S.weights = [];"); seedBw(i => 170 + i);
    ev("S.logs = [];");
    B = ev('anBulkQuality(12)');
    ok('no qualifying lift is reported as such', B.ok === false && /lift/.test(B.why), B.why);

    // a lift needs 4+ sessions
    seedLift('BQ Too Few', i => 100 + i, [-70, -42, -14]);
    B = ev('anBulkQuality(12)');
    ok('a lift with 3 sessions does not qualify', B.ok === false, B.ok && JSON.stringify(B.lifts.map(l => l.ex)));
    // ...and 21+ days of span
    seedLift('BQ Too Short', i => 100 + i, [-12, -10, -8, -6, -4]);
    B = ev('anBulkQuality(12)');
    ok('a lift crammed into 8 days does not qualify', B.ok === false, B.ok && JSON.stringify(B.lifts.map(l => l.ex)));
    seedLift(BQX, i => 200 + i * 4);
    B = ev('anBulkQuality(12)');
    ok('only qualifying lifts enter the index', B.lifts.length === 1 && B.lifts[0].ex === BQX,
      JSON.stringify(B.lifts.map(l => l.ex)));

    // --- data outside the window must not move the numbers ---
    const inWindow = { bwLb: B.bwLb, stPct: B.stPct };
    ev('S.weights.push(' + JSON.stringify({ date: dayOff(-400), lbs: 100 }) + ')');
    seedLift(BQX, () => 999, [-400, -393, -386, -379]);
    B = ev('anBulkQuality(12)');
    ok('bodyweight before the window is excluded', Math.abs(B.bwLb - inWindow.bwLb) < 0.001, B.bwLb);
    ok('sessions before the window are excluded', Math.abs(B.stPct - inWindow.stPct) < 0.001, B.stPct);
    // a wider window does pick them up — proves the filter is the window, not a coincidence
    const wide = ev('anBulkQuality(80)');
    ok('a wider window does reach the older data', Math.abs(wide.bwLb - inWindow.bwLb) > 1, wide.bwLb);

    // --- deload sessions are excluded from the strength side ---
    seedLift(BQX, () => 999, [-35], { deload: true });
    B = ev('anBulkQuality(12)');
    ok('deload sessions do not inflate the strength trend',
      Math.abs(B.stPct - inWindow.stPct) < 0.001, B.stPct);

    // --- the trend is fitted, not read off the endpoints ---
    // Ten sessions climbing 200 -> 236, then one bad day at 205. Endpoint arithmetic would
    // call that +2.5% and let a single session define the verdict; the fitted line says +11.8%.
    ev("S.logs = []; S.weights = [];");
    seedBw(i => 170 + i);
    OFFS.forEach((o, i) => ev('S.logs.push(' + JSON.stringify({ id: bqId++, date: dayOff(o), day: 'D1',
      entries: [{ exercise: BQX, sets: [{ w: i === 10 ? 205 : 200 + 4 * i, r: 1 }] }] }) + ')'));
    B = ev('anBulkQuality(12)');
    ok('one bad last session does not define the strength trend',
      Math.abs(B.stPct - 11.76) < 0.05, B.stPct + ' (endpoints would say 2.5)');
    ok('the fitted start is above the first raw point',
      Math.abs(B.lifts[0].start - 204.77) < 0.05, B.lifts[0].start);
    // same for bodyweight: a single heavy weigh-in on the last day must not become the trend
    ev("S.weights = [];");
    OFFS.forEach((o, i) => ev('S.weights.push(' + JSON.stringify({ date: dayOff(o), lbs: i === 10 ? 176 : 170 + i }) + ')'));
    B = ev('anBulkQuality(12)');
    ok('one off weigh-in does not define the bodyweight trend',
      Math.abs(B.bwLb - 8.18) < 0.05, B.bwLb + ' (endpoints would say 6)');

    // restore the clean linear fixture for the series/render assertions below
    ev("S.logs = []; S.weights = [];");
    seedBw(i => 170 + i);
    seedLift(BQX, i => 200 + i * 4);
    B = ev('anBulkQuality(12)');

    // --- the two series ---
    ok('both chart lines are percent change from the window start',
      Math.abs(B.bwLine[0].v) < 1e-9 && Math.abs(B.stLine[0].v) < 1e-9,
      JSON.stringify([B.bwLine[0], B.stLine[0]]));
    ok('the bodyweight line ends at the measured percent change',
      Math.abs(B.bwLine[B.bwLine.length - 1].v - 5.882) < 0.05, B.bwLine[B.bwLine.length - 1].v);
    const spark = ev("anDualSpark(" + JSON.stringify(B.bwLine) + "," + JSON.stringify(B.stLine) + ",300,74,'var(--violet)','var(--amber)')");
    ok('the dual chart draws two lines', (spark.match(/<path/g) || []).length === 2, spark.slice(0, 120));
    const crossing = ev("anDualSpark([{date:'2026-01-01',v:-5},{date:'2026-02-01',v:5}],[{date:'2026-01-01',v:-2},{date:'2026-02-01',v:3}],300,74,'a','b')");
    const above = ev("anDualSpark([{date:'2026-01-01',v:10},{date:'2026-02-01',v:20}],[{date:'2026-01-01',v:12},{date:'2026-02-01',v:18}],300,74,'a','b')");
    ok('the dual chart draws a zero reference when the range crosses it', crossing.indexOf('stroke-dasharray') >= 0);
    ok('the dual chart omits it when the range never reaches zero', above.indexOf('stroke-dasharray') < 0);
    ok('the dual chart refuses a single-point series',
      /not enough points/.test(ev("anDualSpark([{date:'2026-01-01',v:0}],[{date:'2026-01-01',v:0},{date:'2026-01-08',v:1}],300,74,'a','b')")));
    // x is mapped by DATE, not by position in the array. Bodyweight and lifting rarely cover
    // the same weeks, so an index-mapped chart would stretch a short series across the full
    // width and put the two lines out of register. The fixture is deliberately non-uniform:
    // series A runs Jan 1 / Jan 8 / Mar 1, series B starts a month late at Feb 1 / Mar 1.
    // Across a 59-day span on a 300-wide viewBox, x = 4 + (days/59)*292.
    const uneven = ev("anDualSpark(" +
      "[{date:'2026-01-01',v:0},{date:'2026-01-08',v:1},{date:'2026-03-01',v:2}]," +
      "[{date:'2026-02-01',v:0},{date:'2026-03-01',v:3}],300,74,'a','b')");
    const paths = (uneven.match(/ d="([^"]+)"/g) || []).map(s => s.slice(4, -1));
    ok('unequal-length series still chart', paths.length === 2, JSON.stringify(paths));
    const xsOf = (d) => d.split(/[ML]/).filter(Boolean).map(seg => parseFloat(seg.trim().split(' ')[0]));
    const xa = xsOf(paths[0] || ''), xb = xsOf(paths[1] || '');
    ok('a series starting a month late starts a month in, not at the left edge',
      Math.abs(xb[0] - 157.4) < 0.5, xb[0] + ' (index mapping would put it at 4)');
    ok('a point 7 days in sits 7 days in, not at the array midpoint',
      Math.abs(xa[1] - 38.7) < 0.5, xa[1] + ' (index mapping would put it at 150)');
    ok('both series end on the same x', Math.abs(xa[xa.length - 1] - xb[xb.length - 1]) < 0.05,
      xa[xa.length - 1] + ' vs ' + xb[xb.length - 1]);

    // --- render ---
    ev('anBqWeeks = 12;');
    ev('renderAnBulkQuality()');
    let bout = w.document.getElementById('an_dev').innerHTML;
    ok('bulk quality renders a verdict', bout.indexOf('outpacing the scale') >= 0 || bout.indexOf('ahead of the scale') >= 0, bout.slice(0, 400));
    ok('bulk quality renders the bodyweight delta', /\+10 lb/.test(bout), 'no +10 lb');
    ok('bulk quality renders the ratio', /3\.4×/.test(bout), 'no ratio');
    ok('bulk quality renders the per-lift breakdown', bout.indexOf(BQX) >= 0);
    ok('bulk quality renders the rate-of-gain context', bout.indexOf('lean-bulk band') >= 0);
    ok('bulk quality defers calorie changes rather than prescribing', bout.indexOf('Investigate and ECHO') >= 0);
    ok('bulk quality renders the window picker', /24 wk/.test(bout));
    ev('anBqSetWindow(24)');
    ok('the window picker changes the window', ev('anBqWeeks') === 24);
    ev('anBqSetWindow(12)');

    ev("S.weights = []; S.logs = [];");
    ev('renderAnBulkQuality()');
    bout = w.document.getElementById('an_dev').innerHTML;
    ok('with no data the view explains what it needs rather than showing a number',
      /bodyweight entries/.test(bout) && bout.indexOf('Ratio') < 0 && bout.indexOf('lean-bulk band') < 0,
      bout.slice(0, 300));

    // --- wiring ---
    const anSubs3 = ev("NAV_MODEL.find(function(n){ return n.id==='analytics'; }).subs");
    ok('nav labels the tab Bulk quality', anSubs3.some(s => s.id === 'an_dev' && s.label === 'Bulk quality'),
      JSON.stringify(anSubs3.map(s => s.label)));
    ok('REVIEW_RENDER.an_dev still wired', typeof ev('REVIEW_RENDER').an_dev === 'function');
    ok('the old development renderer is gone', ev('typeof renderAnDev') === 'undefined');
    ok('the old muscle-group weekly helper is gone', ev('typeof anGroupWeekly') === 'undefined');
    ok('the weekly heatmap it overlapped with is untouched', typeof ev('weeklyVolumeByGroup') === 'function');

    // cleanup
    ev('S.logs = ' + savedLogs + '; S.weights = ' + savedWeights + ';');
    ok('cleanup: real logs restored', ev('JSON.stringify(S.logs)') === savedLogs);
    ok('cleanup: real bodyweight restored', ev('JSON.stringify(S.weights)') === savedWeights);
  } catch (e) {
    ok('bulk quality section', false, e.message);
    ev('S.logs = ' + savedLogs + '; S.weights = ' + savedWeights + ';');
  }

  console.log('=== LIFT OVERRIDE NAME MATCHING ===');
  {
    const savedOv = ev('JSON.stringify(invState().overrides)');
    const FUT = ev("mesoAddDays(todayKey(), 20)");
    ev("invState().overrides = {}; invState().overrides['Barbell Bench Press'] = {w:150, until:'" + FUT + "', note:'t'};");

    ok('exact name still resolves', (ev("invOverrideFor('Barbell Bench Press')") || {}).w === 150);
    // These are the near misses that used to write a key nothing could ever read back.
    ok('lowercase variant resolves', (ev("invOverrideFor('barbell bench press')") || {}).w === 150);
    ok('mixed case variant resolves', (ev("invOverrideFor('Barbell Bench press')") || {}).w === 150);
    ok('double-space variant resolves', (ev("invOverrideFor('Barbell  Bench Press')") || {}).w === 150);
    ok('trailing-space variant resolves', (ev("invOverrideFor('Barbell Bench Press ')") || {}).w === 150);
    ok('punctuation variant resolves', (ev("invOverrideFor('Barbell-Bench-Press')") || {}).w === 150);
    // ...but leniency must not become "matches anything"
    ok('a different lift does NOT resolve', ev("invOverrideFor('Barbell Back Squat')") === null);
    ok('a substring does NOT resolve', ev("invOverrideFor('Bench Press')") === null);

    // stored the other way round: a sloppy key must still be found by the split's real name
    ev("invState().overrides = {}; invState().overrides['barbell bench  press'] = {w:135, until:'" + FUT + "', note:'t'};");
    ok('sloppy stored key found by canonical name', (ev("invOverrideFor('Barbell Bench Press')") || {}).w === 135);
    ok('override actually reaches the LIVE build', ev("buildOneLiveExercise('Barbell Bench Press').targetW") === 135);
    ok('LIVE marks it as an override decision', ev("buildOneLiveExercise('Barbell Bench Press')._decision.code") === 'inv-override');

    // expiry still wins over the looser matching
    const PAST = ev("mesoAddDays(todayKey(), -3)");
    ev("invState().overrides = {}; invState().overrides['barbell bench press'] = {w:99, until:'" + PAST + "', note:'t'};");
    ok('expired override still ignored (loose key)', ev("invOverrideFor('Barbell Bench Press')") === null);

    ev('invState().overrides = ' + savedOv + ';');
    ok('cleanup: overrides restored', ev('JSON.stringify(invState().overrides)') === savedOv);
  }

  console.log('=== liftReset NAMES ARE RESOLVED, NOT TRUSTED ===');
  {
    const V2 = ev('agValidateFix');
    ok('exact split name accepted', V2({ type:'liftReset', payload:{name:'Barbell Bench Press', w:150, days:14} }).payload.name === 'Barbell Bench Press');
    // canonicalisation: the override must land under the spelling the split uses
    ok('near-miss name is canonicalised', V2({ type:'liftReset', payload:{name:'barbell  BENCH press', w:150, days:14} }).payload.name === 'Barbell Bench Press');
    // the real proposal DELTA made on 2026-07-30 for a lift that is not in the split at all
    ok('unknown exercise rejected', V2({ type:'liftReset', payload:{name:'Trap Bar Deadlift', w:185, days:7} }) === null);
    ok('gibberish name rejected', V2({ type:'liftReset', payload:{name:'Zzz Not A Lift', w:100, days:7} }) === null);
    ok('empty name still rejected', V2({ type:'liftReset', payload:{name:'   ', w:100, days:7} }) === null);
    // numeric clamps must be untouched by the new check
    ok('w<=0 still rejected', V2({ type:'liftReset', payload:{name:'Barbell Bench Press', w:0, days:7} }) === null);
    ok('days>30 still rejected', V2({ type:'liftReset', payload:{name:'Barbell Bench Press', w:100, days:99} }) === null);

    // end to end: validate -> apply -> LIVE reads it back
    const savedOv2 = ev('JSON.stringify(invState().overrides)');
    ev("invState().overrides = {};");
    ev("agApplyFix(agValidateFix({type:'liftReset', payload:{name:'barbell bench press', w:160, days:9}}));");
    ok('applied under the canonical key', Object.keys(ev('invState().overrides'))[0] === 'Barbell Bench Press');
    ok('LIVE picks up the applied override', ev("buildOneLiveExercise('Barbell Bench Press').targetW") === 160);
    ev('invState().overrides = ' + savedOv2 + ';');
    ok('cleanup: overrides restored again', ev('JSON.stringify(invState().overrides)') === savedOv2);
  }

  console.log('=== musclesFor: SHORT TOKENS ARE ANCHORED ===');
  {
    // /lat/ used to match inside "PLATe", so a chest press classified as Back
    ok('Plate Loaded Chest Press is Chest', ev("musclesFor('Plate Loaded Chest Press').p[0]") === 'Chest');
    ok('Plate Loaded Row is still Back', ev("musclesFor('Plate Loaded Row').p[0]") === 'Back');
    // /ab/ used to match inside "cABle" and "ABductor"
    ok('Abductor/Adductor Machine is Glutes', ev("musclesFor('Abductor/Adductor Machine').p[0]") === 'Glutes');
    ok('Abdominal Machine is still Abs', ev("musclesFor('Abdominal Machine').p[0]") === 'Abs');
    ok('Cable Crunches is still Abs', ev("musclesFor('Cable Crunches').p[0]") === 'Abs');
    ok('Lat Pulldown is still Back', ev("musclesFor('Lat Pulldown').p[0]") === 'Back');
  }

  console.log('=== REPLACEMENT TIER LIST ===');
  {
    const savedLogsT = ev('JSON.stringify(S.logs)');
    ev('S.logs = [];');   // no history, so scoring is pure name/muscle signal

    ok('same muscle + pattern + equipment ranks S',
      ev("swapTierFor(swapScore('Lat Pulldown','Plate-Loaded Lat Pulldown'))") === 'S',
      'score=' + ev("swapScore('Lat Pulldown','Plate-Loaded Lat Pulldown')"));
    // vertical vs horizontal pull share muscles but are not interchangeable
    const vert = ev("swapScore('Lat Pulldown','Plate-Loaded Lat Pulldown')");
    const horiz = ev("swapScore('Lat Pulldown','Cable Row')");
    ok('vertical pull outranks a row for a pulldown', vert > horiz, vert + ' vs ' + horiz);
    // bench and overhead press both read "push" to mesoPattern; they must not tie
    const flat = ev("swapScore('Barbell Bench Press','Smith Machine Bench Press')");
    const oh = ev("swapScore('Barbell Bench Press','Overhead Press Machine')");
    ok('bench outranks overhead press as a bench swap', flat > oh, flat + ' vs ' + oh);
    ok('an unrelated lift scores below the display floor',
      ev("swapScore('Barbell Bench Press','Machine Leg Curl')") < ev('SWAP_SHOW_FLOOR'));
    ok('no muscle data yields null, not a score', ev("swapScore('Calve Raises','Leg Press')") === null);

    const cands = ev("swapCandidates('Barbell Bench Press', {})");
    ok('candidates are returned', cands.length > 0);
    ok('never returns the source exercise', cands.every(r => r.name !== 'Barbell Bench Press'));
    ok('never returns an F tier', cands.every(r => r.tier !== 'F'));
    ok('sorted best first', cands.every((r, i) => i === 0 || cands[i - 1].score >= r.score));
    ok('bench list is chest work, not legs', cands.every(r => /press|bench|fly|dip|pec/i.test(r.name)),
      cands.map(r => r.name).join(','));

    const excl = ev("swapCandidates('Barbell Bench Press', {exclude:['Smith Machine Bench Press','Incline Press Machine']})");
    ok('exclude list is honoured', excl.every(r => r.name !== 'Smith Machine Bench Press' && r.name !== 'Incline Press Machine'));
    ok('excluding does not empty the list', excl.length > 0);

    // dedupe: his real data holds "Hanging Leg Raise" AND "Hanging Leg Raises"
    ev("S.logs = [{date:'2026-01-01', entries:[{exercise:'Hanging Leg Raises', sets:[{w:10,r:10}]}]}];");
    const abs = ev("swapCandidates('Abdominal Machine', {})");
    ok('near-duplicate names collapse to one row',
      abs.filter(r => /^hanging leg raises?$/i.test(r.name)).length === 1,
      abs.map(r => r.name).join(','));

    // thin field must not be padded out to look full
    ev('S.logs = [];');
    const thin = ev("swapCandidates('Abductor/Adductor Machine', {})");
    ok('thin field stays short', thin.length <= 5, 'n=' + thin.length);
    ok('thin field still returns its best option', thin.length > 0 && thin[0].score >= ev('SWAP_THIN_FLOOR'));

    // rendering: rows are indexed, names are escaped, nothing is invented
    const listHTML = ev("swapListHTML('Barbell Bench Press','liveSwapPick',{})");
    ok('list renders one button per candidate',
      (listHTML.match(/class="swap-row"/g) || []).length === ev('_swapRows').length);
    ok('rows carry their tier letter', /class="swap-tier"/.test(listHTML));
    ok('pick resolves by index, not by name string', ev('swapPickedName(0)') === ev('_swapRows')[0].name);
    ok('out-of-range pick returns null', ev('swapPickedName(999)') === null);
    // a name with an apostrophe must survive rendering without breaking the onclick
    ev("S.logs = [{date:'2026-01-01', entries:[{exercise:\"Coach's Bench Press\", sets:[{w:10,r:10}]}]}];");
    const q = ev("swapListHTML('Barbell Bench Press','liveSwapPick',{})");
    ok('apostrophe names are escaped, not interpolated into onclick', q.indexOf("Coach's Bench") === -1 && /Coach&#39;s|Coach&amp;#39;s/.test(q));

    // empty is an honest answer, not an error
    ev('S.logs = [];');
    const none = ev("swapListHTML('Calve Raises','liveSwapPick',{})");
    ok('no-overlap case explains itself instead of padding', /honest answer|closely enough/.test(none));
    ok('no-overlap case renders no rows', none.indexOf('swap-row') === -1);

    ev('S.logs = ' + savedLogsT + ';');
    ok('cleanup: logs restored after tier list', ev('JSON.stringify(S.logs)') === savedLogsT);
  }

  console.log('=== PREDICTIONS: SELECTION ONLY, HISTORY DRAWN, CONFIDENCE VISIBLE ===');
  {
    const savedLogsP = ev('JSON.stringify(S.logs)');
    // two lifts with enough history; only the selected one may appear
    ev(`(function(){
      S.logs = [];
      var start = new Date('2026-01-05T00:00:00');
      for(var i=0;i<9;i++){
        var d = new Date(start.getTime() + i*7*86400000).toISOString().slice(0,10);
        S.logs.push({date:d, entries:[
          {exercise:'Pred Alpha', sets:[{w:100+i*5, r:5}]},
          {exercise:'Pred Beta',  sets:[{w:200+i*5, r:5}]}
        ]});
      }
    })();`);
    ev("anEnsembleEx='Pred Alpha'; anEnsembleRange=84;");
    ev('renderAnPred')();
    const pred = w.document.getElementById('an_pred').innerHTML;
    ok('selected lift is shown', pred.indexOf('Pred Alpha') >= 0);
    ok('every lift is still offered in the picker', pred.indexOf('Pred Beta') >= 0);
    // The old tab appended a milestone card for every big lift regardless of the dropdown.
    // Outside the <select>, the unselected lift must not appear at all.
    const outsidePicker = pred.replace(/<select[\s\S]*?<\/select>/g, '');
    ok('unselected lift has no content of its own', outsidePicker.indexOf('Pred Beta') === -1);
    ok('exactly one projection card is rendered', (pred.match(/anEnsembleChangeEx/g) || []).length === 1);
    ok('no stray per-lift milestone cards remain', (pred.match(/class="card"/g) || []).length === 2,
      'cards=' + (pred.match(/class="card"/g) || []).length);

    const res = ev("anEnsembleFor('Pred Alpha', 84)");
    ok('projection resolves', res.ok === true, JSON.stringify(res.why));
    ok('history comes back with the projection', Array.isArray(res.hist) && res.hist.length === 9, 'n=' + (res.hist || []).length);
    const svg = ev('anEnsembleChartSVG(' + JSON.stringify(res).replace(/</g, '\\u003c') + ', 640, 240)');
    // three endpoint dots belong to the projection; anything beyond them is real history
    ok('historical points are plotted on the chart',
      (svg.match(/<circle/g) || []).length > 3, 'circles=' + (svg.match(/<circle/g) || []).length);
    ok('a today divider separates past from forecast', svg.indexOf('<line') >= 0);
    ok('confidence appears on the chart as a number', /R²/.test(svg));
    ok('confidence appears on the chart as a meter', (svg.match(/<rect/g) || []).length >= 3);
    ok('confidence wording matches the computed r2',
      svg.indexOf(res.conf) >= 0, res.conf);

    // milestones belong to the selected lift and respect the selected horizon
    const near = ev("anFanMilestones(anEnsembleFor('Pred Alpha',28), 28)");
    const far = ev("anFanMilestones(anEnsembleFor('Pred Alpha',365), 365)");
    ok('a longer horizon exposes at least as many milestones', far.length >= near.length, far.length + ' vs ' + near.length);
    ok('no milestone lands beyond the horizon', far.every(m => m.days <= 365));
    ok('milestones climb in 5 lb steps', far.length < 2 || far[1].target - far[0].target === 5);

    ev('S.logs = ' + savedLogsP + '; anEnsembleEx=null; anEnsembleRange=84;');
    ok('cleanup: logs restored after predictions', ev('JSON.stringify(S.logs)') === savedLogsP);
  }

  console.log('=== BODYWEIGHT PROJECTION ===');
  {
    const savedW = ev('JSON.stringify(S.weights)');
    ok('too little data refuses rather than guessing',
      ev('(function(){ S.weights=[{date:"2026-01-01",lbs:150}]; return bwProjectFor(84).ok; })()') === false);
    ok('the refusal explains what is missing', /weigh-in|weeks/.test(ev('bwProjectFor(84).why')));

    // Deliberately noisy, because a real scale is: a perfectly linear fixture has zero
    // residual variance, which collapses the fan to a single line and would let a broken
    // spread calculation pass unnoticed. Fixed offsets, not random — the suite stays
    // deterministic.
    const WOBBLE = [0, 0.6, -0.5, 0.4, -0.7, 0.3, 0.5, -0.4, 0.2, -0.6, 0.7, -0.3];
    w.__wobble = WOBBLE;
    // THREE weigh-ins per week, not one. With a single reading per week the weekly average
    // equals that reading, and an anchor bug (fanning out from the week average instead of
    // from today's actual weight) would be invisible.
    ev(`(function(){
      S.weights = [];
      var start = new Date('2026-01-05T00:00:00');
      for(var i=0;i<12;i++){
        var base = 150 + i*0.8 + window.__wobble[i];
        [0,2,4].forEach(function(off, j){
          var d = new Date(start.getTime() + i*7*86400000 + off*86400000).toISOString().slice(0,10);
          S.weights.push({date:d, lbs: Math.round((base + (j-1)*0.9)*10)/10});
        });
      }
    })();`);
    const bw = ev('bwProjectFor(84)');
    ok('projection resolves with enough weigh-ins', bw.ok === true, JSON.stringify(bw.why));
    ok('three paces are produced', [10, 50, 90].every(p => Array.isArray(bw.series[p]) && bw.series[p].length > 1));
    // all three branch from TODAY'S weight, not from a week average
    const last = ev('bodyweightSeries()').slice(-1)[0].v;
    const lastWeekAvg = ev('bodyweightSeriesSmoothed()').slice(-1)[0].v;
    ok('fixture separates latest weigh-in from its week average', last !== lastWeekAvg, last + ' vs ' + lastWeekAvg);
    ok('every pace starts at the latest weigh-in', [10, 50, 90].every(p => bw.series[p][0].v === last), 'anchor=' + bw.cur + ' last=' + last);
    ok('anchor is not the weekly average', bw.cur !== lastWeekAvg, 'cur=' + bw.cur);
    const endOf = p => bw.series[p][bw.series[p].length - 1].v;
    ok('leaner < your pace < heavier at the horizon', endOf(10) < endOf(50) && endOf(50) < endOf(90),
      endOf(10) + '/' + endOf(50) + '/' + endOf(90));
    ok('centre pace matches the measured lb/week', Math.abs(bw.perWeek - 0.8) < 0.15, 'perWeek=' + bw.perWeek);
    ok('the leaner and heavier paces are genuinely different rates',
      Math.abs((endOf(90) - endOf(10))) > 0.5, 'spread=' + (endOf(90) - endOf(10)));
    // same core as the lift projection, not a second implementation
    ok('the fan widens with distance',
      (endOf(90) - endOf(10)) > (bw.series[90][1].v - bw.series[10][1].v));
    ok('projection carries history for the chart', Array.isArray(bw.hist) && bw.hist.length >= 4);

    const card = ev('bwProjectionCardHTML()');
    ok('card renders a chart', card.indexOf('<svg') >= 0);
    ok('card names all three paces', ['Leaner pace', 'Your pace', 'Heavier pace'].every(l => card.indexOf(l) >= 0));
    ok('card states the measured rate', /lb\/wk/.test(card));
    ok('card reads the lean-bulk band', /lean-bulk pocket/.test(card), card.slice(-260));
    ok('bulk tab embeds the projection', (ev('renderBulk')(), w.document.getElementById('bulk').innerHTML).indexOf('Bulk projection') >= 0);

    // A scale with literally no week-to-week variance collapses the fan. That is the honest
    // reading of noiseless data rather than a bug, but the card must say so instead of
    // silently printing the same number three times.
    ev(`(function(){
      S.weights = [];
      var start = new Date('2026-01-05T00:00:00');
      for(var i=0;i<12;i++){
        S.weights.push({date:new Date(start.getTime()+i*7*86400000).toISOString().slice(0,10), lbs:150+i*0.8});
      }
    })();`);
    const flatFan = ev('bwProjectFor(84)');
    ok('noiseless data still projects', flatFan.ok === true);
    ok('noiseless data collapses the fan to one line', flatFan.sd === 0);
    ok('the card explains a collapsed fan', /no week-to-week variance|single line/.test(ev('bwProjectionCardHTML()')));

    ev('S.weights = ' + savedW + ';');
    ok('cleanup: bodyweight restored', ev('JSON.stringify(S.weights)') === savedW);
  }

  console.log('=== OVERLOAD STATUS ===');
  {
    const savedLogsO = ev('JSON.stringify(S.logs)');
    const savedAgO = ev('JSON.stringify(agState().overload || null)');
    ev(`(function(){
      S.logs = [];
      var start = new Date('2026-01-05T00:00:00');
      for(var i=0;i<8;i++){
        var d = new Date(start.getTime() + i*7*86400000).toISOString().slice(0,10);
        S.logs.push({date:d, entries:[
          {exercise:'OL Climber',  sets:[{w:100+i*5, r:5, e:'solid'}]},
          {exercise:'OL Sinker',   sets:[{w:200-i*5, r:5, e:'solid'}]},
          {exercise:'OL Flat',     sets:[{w:150,     r:5, e:'solid'}]},
          {exercise:'OL Grinder',  sets:[{w:120,     r:5, e:'grind'}]}
        ]});
      }
    })();`);
    const sigs = ev('olSignals()');
    const by = {}; sigs.forEach(s => by[s.lift] = s);
    ok('a rising lift reads up', by['OL Climber'].dir === 'up', JSON.stringify(by['OL Climber'] && by['OL Climber'].perWeek));
    ok('a falling lift reads down', by['OL Sinker'].dir === 'down');
    ok('a flat lift reads flat', by['OL Flat'].dir === 'flat');
    ok('rising lift is on track', by['OL Climber'].verdict === 'on-track');
    ok('falling lift needs attention', by['OL Sinker'].verdict === 'attention');
    ok('flat lift is stalling', by['OL Flat'].verdict === 'stalling');
    ok('heavy grind density escalates a flat lift', by['OL Grinder'].verdict === 'attention', 'hardPct=' + by['OL Grinder'].hardPct);
    ok('worst lifts sort to the top', sigs[0].verdict === 'attention');
    ok('signals carry the numbers the tab prints',
      typeof by['OL Climber'].r2 === 'number' && by['OL Climber'].sessions === 8);

    // MAXED must not read as a stall — load cannot climb by definition
    ev("S.split.D1.exercises.push({name:'OL Flat', inc:5, maxed:true});");
    const maxedSig = ev('olSignals()').find(s => s.lift === 'OL Flat');
    ok('maxed flat lift is not called stalling', maxedSig.verdict === 'on-track', maxedSig.verdict);
    ok('maxed lift is still reported flat', maxedSig.dir === 'flat');
    ev("S.split.D1.exercises = S.split.D1.exercises.filter(function(x){ return !(typeof x==='object' && x.name==='OL Flat'); });");

    // ---- the sanity gate ----
    const sigs2 = ev('olSignals()');
    w.__sigs = sigs2;
    const val = (raw) => { w.__raw = raw; return ev('olValidateReport(window.__raw, window.__sigs)'); };
    ok('junk input yields null', val(null) === null);
    ok('missing lifts array yields null', val({ nope: 1 }) === null);
    ok('a lift the app does not track is dropped',
      val({ lifts: [{ lift: 'Not A Lift', direction: 'up', verdict: 'on-track', tip: 'x' }] }) === null);
    ok('a valid row survives',
      val({ lifts: [{ lift: 'OL Climber', direction: 'up', verdict: 'on-track', tip: 'Keep going.' }] }).lifts.length === 1);
    ok('a near-miss lift name is canonicalised',
      val({ lifts: [{ lift: 'ol  CLIMBER', direction: 'up', verdict: 'on-track', tip: 'x' }] }).lifts[0].lift === 'OL Climber');
    // the important one: the model does not get to contradict the arithmetic
    ok('a direction that contradicts the trend is dropped',
      val({ lifts: [{ lift: 'OL Sinker', direction: 'up', verdict: 'on-track', tip: 'x' }] }) === null);
    ok('an inverted verdict is dropped',
      val({ lifts: [{ lift: 'OL Sinker', direction: 'down', verdict: 'on-track', tip: 'x' }] }) === null);
    ok('a one-step softer verdict is allowed',
      val({ lifts: [{ lift: 'OL Sinker', direction: 'down', verdict: 'stalling', tip: 'x' }] }).lifts[0].verdict === 'stalling');
    ok('an unknown verdict word is dropped',
      val({ lifts: [{ lift: 'OL Climber', direction: 'up', verdict: 'vibes', tip: 'x' }] }) === null);
    ok('duplicate rows collapse to one',
      val({ lifts: [
        { lift: 'OL Climber', direction: 'up', verdict: 'on-track', tip: 'first' },
        { lift: 'OL Climber', direction: 'up', verdict: 'on-track', tip: 'second' }] }).lifts.length === 1);
    const longTip = val({ lifts: [{ lift: 'OL Climber', direction: 'up', verdict: 'on-track', tip: 'y'.repeat(400) }] });
    ok('an overlong tip is truncated', longTip.lifts[0].tip.length <= ev('OL_MAX_TIP') + 1, 'len=' + longTip.lifts[0].tip.length);
    ok('a missing tip is tolerated',
      val({ lifts: [{ lift: 'OL Climber', direction: 'up', verdict: 'on-track' }] }).lifts[0].tip === '');
    ok('a validated report is date-stamped', longTip.day === ev('todayKey()'));

    // ---- render: computed content survives a missing or bad report ----
    ev('delete agState().overload;');
    ev('renderAnOverload')();
    let olHTML = w.document.getElementById('an_overload').innerHTML;
    ok('tab renders with no agent report at all', olHTML.indexOf('OL Climber') >= 0 && olHTML.indexOf('ol-row') >= 0);
    ok('tab says why there are no tips yet', /haven’t written|haven't written/.test(olHTML));
    ok('tab still shows verdicts without the agents', olHTML.indexOf('Needs attention') >= 0);

    ev("agState().overload = olValidateReport({lifts:[{lift:'OL Climber',direction:'up',verdict:'on-track',tip:'Add a rep before the weight.'}]}, olSignals());");
    ev('renderAnOverload')();
    olHTML = w.document.getElementById('an_overload').innerHTML;
    ok('a fresh agent tip is displayed', olHTML.indexOf('Add a rep before the weight.') >= 0);
    ok('fresh report is labelled as refreshed', /last refreshed/.test(olHTML));

    // stale report must be held back, but the computed rows must not be
    ev("agState().overload.day = mesoAddDays(todayKey(), -" + (ev('OL_STALE_DAYS') + 5) + ");");
    ev('renderAnOverload')();
    olHTML = w.document.getElementById('an_overload').innerHTML;
    ok('a stale tip is withheld', olHTML.indexOf('Add a rep before the weight.') === -1);
    ok('stale case says so', /days old/.test(olHTML));
    ok('stale case still renders the computed rows', olHTML.indexOf('OL Climber') >= 0);

    // the agents are told the same numbers the tab renders
    const olCtx = ev('olAgentContext()');
    ok('agent context lists the tracked lifts', olCtx.indexOf('OL Climber') >= 0 && olCtx.indexOf('OL Sinker') >= 0);
    ok('agent context carries the computed verdict', /app verdict=/.test(olCtx));
    ok('agent context carries the direction', /dir=down/.test(olCtx));
    // The nightly run is four calls now, so the prompt that asks for this lives in the
    // per-agent spec and the computed signals arrive through agBaseContext. Same two claims,
    // read across the whole pipeline instead of one function.
    const runSrc = [ev('agRunAll.toString()'), ev('agJsonSpec.toString()'),
                    ev('agBaseContext.toString()'), ev('agRunSpecialist.toString()')].join('\n');
    ok('the daily cycle asks for an overload block', runSrc.indexOf('"overload"') >= 0);
    ok('the daily cycle validates it before storing', /olValidateReport/.test(runSrc));
    ok('the daily cycle feeds the agents the computed signals', /olAgentContext/.test(runSrc));
    ok('a rejected report keeps the previous one', /kept the previous read|previous read kept/.test(runSrc));
    // and only DELTA is asked for it -- the other two have no business reporting on overload
    ok('only DELTA is asked for the overload block',
       ev("agJsonSpec('delta')").indexOf('"overload"') >= 0 &&
       ev("agJsonSpec('echo')").indexOf('"overload"') < 0 &&
       ev("agJsonSpec('charlie')").indexOf('"overload"') < 0);

    ev('S.logs = ' + savedLogsO + ';');
    ev(savedAgO === 'null' ? 'delete agState().overload;' : 'agState().overload = ' + savedAgO + ';');
    ok('cleanup: logs restored after overload', ev('JSON.stringify(S.logs)') === savedLogsO);
  }

  // ============ MUSCLE MAP DATA CORE ============
  // bmViewerData() is what both renderers draw from, so the numbers behind the
  // colouring are asserted here rather than the pixels, which jsdom cannot see.
  console.log('=== MUSCLE MAP DATA ===');
  {
    const savedLogsBM = ev('JSON.stringify(S.logs)');

    ok('bmViewerData returns every muscle group',
       ev('bmViewerData("weekly").length') === ev('BM_GROUPS.length'));
    ok('rows keep BM_GROUPS order',
       ev('bmViewerData("weekly").map(r=>r.key).join(",")') === ev('BM_GROUPS.join(",")'));
    ok('every group resolves to a broad group',
       ev('bmViewerData("weekly").every(r=>!!r.broad)'));
    ok('every group carries a label',
       ev('bmViewerData("weekly").every(r=>!!r.label)'));

    // Primary counts a full set, secondary counts half. Bench is primary Chest and
    // secondary Triceps, so one exercise proves both halves of the rule at once.
    const wk = ev('weekStartKey()');
    ev('S.logs = [];');
    ev("S.logs.push({date:'" + wk + "', entries:[{exercise:'Barbell Bench Press', sets:[{w:135,r:5},{w:135,r:5},{w:135,r:5},{w:135,r:5}]}]});");
    const chest = ev('bmViewerData("weekly").find(r=>r.key==="chest").volume');
    const tri   = ev('bmViewerData("weekly").find(r=>r.key==="triceps").volume');
    ok('primary muscle counts one per set', chest === 4, 'chest=' + chest);
    ok('secondary muscle counts half per set', tri === 2, 'triceps=' + tri);

    // A log from before the week window must not leak into "this week".
    ev("S.logs.push({date:'2020-01-06', entries:[{exercise:'Barbell Bench Press', sets:[{w:135,r:5},{w:135,r:5},{w:135,r:5},{w:135,r:5},{w:135,r:5},{w:135,r:5},{w:135,r:5},{w:135,r:5}]}]});");
    const chestAfter = ev('bmViewerData("weekly").find(r=>r.key==="chest").volume');
    ok('volume ignores logs before the week window', chestAfter === 4, 'chest=' + chestAfter);

    // Threshold table: 0 -> off, <6 -> red, <10 -> yellow, >=10 -> green.
    const setsJSON = n => JSON.stringify(Array.from({ length: n }, () => ({ w: 135, r: 5 })));
    const chestStatus = n => {
      ev('S.logs = [];');
      ev("S.logs.push({date:'" + wk + "', entries:[{exercise:'Pec Deck Fly', sets:" + setsJSON(n) + "}]});");
      return ev('bmViewerData("weekly").find(r=>r.key==="chest").status');
    };
    ev('S.logs = [];');
    ok('no volume reads as not-trained',
       ev('bmViewerData("weekly").find(r=>r.key==="chest").status') === 'off');
    ok('5 sets reads as neglected', chestStatus(5) === 'red');
    ok('6 sets crosses into maintaining', chestStatus(6) === 'yellow');
    ok('9 sets still maintaining', chestStatus(9) === 'yellow');
    ok('10 sets reads as progressing', chestStatus(10) === 'green');
    ok('18 sets stays progressing', chestStatus(18) === 'green');

    // recovery mode keys off days since the group was last trained.
    // Build the key the way todayKey() does — LOCAL date parts. toISOString() is
    // UTC and lands a day ahead east of Greenwich, which makes "trained today"
    // read as a future log, get filtered out, and the test fail only in some
    // timezones and only at some hours.
    const dayAgo = n => ev('(function(){var d=new Date();d.setDate(d.getDate()-' + n + ');' +
      'return d.getFullYear()+"-"+String(d.getMonth()+1).padStart(2,"0")+"-"+String(d.getDate()).padStart(2,"0");})()');
    const chestRecovery = n => {
      ev('S.logs = [];');
      ev("S.logs.push({date:'" + dayAgo(n) + "', entries:[{exercise:'Pec Deck Fly', sets:[{w:100,r:10}]}]});");
      return ev('bmViewerData("recovery").find(r=>r.key==="chest").status');
    };
    // Probe the boundaries, not the middle of each band: testing 0 / 2 / 4 left
    // the d<2 edge unpinned, and a mutant that moved it to d<1 stayed green.
    ok('trained today needs rest', chestRecovery(0) === 'red');
    ok('one day out still needs rest', chestRecovery(1) === 'red');
    ok('two days out is recovering', chestRecovery(2) === 'yellow');
    ok('three days out is still recovering', chestRecovery(3) === 'yellow');
    ok('four days out is recovered', chestRecovery(4) === 'green');
    ev('S.logs = [];');
    ok('never trained reads as no data',
       ev('bmViewerData("recovery").find(r=>r.key==="chest").status') === 'off');
    ok('never trained reports infinite days since',
       ev('bmViewerData("recovery").find(r=>r.key==="chest").daysSince') === Infinity);

    // today mode: primary green, secondary yellow, uninvolved off
    ev('S.overrideDay = {date: todayKey(), day:"D1"};');   // D1 = Chest + Triceps
    const today = k => ev('bmViewerData("today").find(r=>r.key==="' + k + '").status');
    ok('today marks a primary target', today('chest') === 'green');
    ok('today marks a secondary target', today('triceps') === 'green');
    ok('today leaves an untrained group off', today('calves') === 'off');
    ev('S.overrideDay = {date: todayKey(), day:"REST"};');
    ok('a rest day targets nothing',
       ev('bmViewerData("today").every(r=>r.status==="off")'));
    ev('S.overrideDay = null;');

    // the exercise list behind a tap comes from his own split, primary first
    const chestEx = ev('JSON.stringify(bmViewerData("weekly").find(r=>r.key==="chest").exercises)');
    ok('tapping a muscle lists exercises from his split',
       chestEx.indexOf('Barbell Bench Press') >= 0, chestEx);
    ok('the exercise list is capped at four',
       ev('bmViewerData("weekly").every(r=>r.exercises.length<=4)'));

    ev('S.logs = ' + savedLogsBM + ';');
    ok('cleanup: logs restored after muscle map', ev('JSON.stringify(S.logs)') === savedLogsBM);
  }

  // ============ 3D VIEWER WIRING ============
  // The rendering itself cannot be verified here — jsdom has no WebGL and no
  // layout engine. What IS verifiable: which renderer each surface asks for,
  // that the 3D model covers every group the data does, and that a machine with
  // no WebGL still gets a working map rather than an empty card.
  console.log('=== 3D VIEWER WIRING ===');
  {
    ok('the Progress card asks for the 3D viewer', ev('bmUses3D("progress")') === true);
    ok('the LIVE idle screen stays on the flat map', ev('bmUses3D("live")') === false);

    // "Don't lose information in the redesign" — enforced, not hoped for.
    const plateKeys = ev('BM3D_PLATES.map(p=>p[0]).sort().join(",")');
    const groupKeys = ev('BM_GROUPS.slice().sort().join(",")');
    ok('the 3D model has a plate for every muscle group the data reports',
       plateKeys === groupKeys, plateKeys);

    ok('three.js is pinned, not floating on latest', /three@\d+\.\d+\.\d+/.test(ev('BM3D_SRC')));
    ok('three.js is fetched at runtime, not bundled', /^https:/.test(ev('BM3D_SRC')));
    ok('the viewer is imported lazily rather than at boot',
       /import\(/.test(ev('bm3dLoad.toString()')));
    ok('WebGL contexts are disposed, not leaked',
       /renderer\.dispose/.test(ev('bm3dDispose.toString()')));

    // With no WebGL (this harness, and any old device), Progress must degrade to
    // the flat bodies rather than showing an empty box.
    ok('no WebGL is detected as unsupported', ev('bm3dSupported()') === false);
    ev('renderProgressV2();');
    const sec = w.document.getElementById('progress');
    ok('fallback replaced the viewer with the flat bodies',
       !w.document.getElementById('bm3dwrap-progress') && !!w.document.getElementById('bmfront-progress'));
    ok('fallback still draws the anterior muscle groups',
       w.document.querySelectorAll('#bmfront-progress .bm-mgrp').length >= 8);
    ok('fallback still draws the posterior muscle groups',
       w.document.querySelectorAll('#bmback-progress .bm-mgrp').length >= 8);
    ok('fallback keeps all four modes', sec.querySelectorAll('.bm-modes button').length === 4);
    ok('fallback keeps the legend', sec.querySelectorAll('.bm-legend .bm-sw').length === 4);
    ok('fallback marks state as 2D so mode switches use the SVG path',
       ev('bmState.progress.three') === false);

    // Both renderers must classify identically — that is the whole point of the
    // shared data core.
    ok('the SVG renderer and the data core agree on status',
       ev('BM_GROUPS.every(k => bmStatus("progress", k) === bmViewerData(bmState.progress.mode).find(r=>r.key===k).status)'));
  }

  console.log('=== PROGRESS TIERS: RAPID GATE ===');
  // Everything the composite reads is global (every log, every weigh-in), so this section
  // runs on an isolated S and puts the real one back at the end.
  const savedPT = ev('JSON.stringify({logs:S.logs, weights:S.weights, prHistory:S.prHistory||[], invest:S.invest||null, schedule:S.schedule})');
  try {
    const ptOff = (n) => ev('mesoAddDays(todayKey(), ' + n + ')');
    const PT_WK = []; for (let i = 0; i <= 11; i++) PT_WK.push(-77 + i * 7);  // 12 weekly points
    let ptId = 900000;
    const ptPush = (date, ex, wt) => ev('S.logs.push(' + JSON.stringify(
      { id: ptId++, date, day: 'D1', entries: [{ exercise: ex, sets: [{ w: wt, r: 1 }] }] }) + ')');
    const ptCount = (h, needle) => h.split(needle).length - 1;

    // A fixture that lands squarely in the top band with all four RAPID checks clear, built so
    // each check can be broken on its own by one option. bench/squat are lb/week and PR_LIFTS
    // caps them at 1.75 and 2.5, so the ratio the gate reads back out is exactly bench/1.75.
    // r:1 keeps epley() from touching the logged weight.
    const ptSeed = (opt) => {
      const o = Object.assign({ bench: 2.1, squat: 2.375, bw: (i) => 170 + i * 0.8, pr: -3 }, opt || {});
      ev('S.logs = []; S.weights = []; S.prHistory = [];');
      ev('S.invest = {flags:[], history:[], lastAuto:{}, overrides:{}};');
      ev("S.schedule = {1:'D1',2:'D2',3:'D3',4:'D4',5:'D5',6:'D6',0:'REST'};");  // 6 training days
      PT_WK.forEach((d, i) => {
        ev('S.weights.push(' + JSON.stringify({ date: ptOff(d), lbs: o.bw(i) }) + ')');
        ptPush(ptOff(d), 'Barbell Bench Press', 200 + i * o.bench);
        ptPush(ptOff(d), 'Barbell Back Squat', 300 + i * o.squat);
      });
      // Six distinct days inside the last week so consistencyScore() reads a full 6/6. A
      // separate lift on purpose: crammed into 6 days it is too short a span to enter
      // anBqLifts(), and too steep to read as anything but 'up' in olSignals().
      for (let i = 0; i <= 5; i++) ptPush(ptOff(-5 + i), 'Filler Cable Row', 100 + i * 2);
      if (o.pr !== null) ev('S.prHistory.push(' + JSON.stringify({ exercise: 'Barbell Bench Press',
        weight: 225, reps: 1, e1rm: 225, prev: 220, gain: 5, date: ptOff(o.pr) }) + ')');
    };
    const unmetOf = (R) => ((R.rapid && R.rapid.unmet) || []).join(' | ');

    // --- the ladder itself ---
    ok('tier order runs low to high with rapid on top',
      ev('TIER_ORDER').join(',') === 'none,slow,prog,accel,rapid', ev('TIER_ORDER').join(','));
    ok('the middle tier is renamed Steady Progress', ev('TIER_LABELS').prog === 'Steady Progress',
      ev('TIER_LABELS').prog);
    ok('rapid is spelled in caps', ev('TIER_LABELS').rapid === 'RAPID PROGRESS', ev('TIER_LABELS').rapid);
    // The two maps were hand-maintained duplicates and had already drifted on accel's colour.
    const ptTiers = ev('PSTATUS_TIERS'), ptLab = ev('TIER_LABELS'), ptCol = ev('TIER_COLS');
    ok('label and colour maps are derived from the tier list, so they cannot drift',
      ptTiers.every(t => ptLab[t.key] === t.label && ptCol[t.key] === t.col));
    ok('every tier colour is a token, not a literal', ptTiers.every(t => t.col.indexOf('var(--') === 0),
      ptTiers.map(t => t.col).join(','));

    // --- all four checks clear ---
    ptSeed();
    let R = ev('computeProgressStatus()');
    ok('the fixture blends into the top band', R.blended >= 0.75, R.blended);
    ok('each component is maxed', R.st.score === 1 && R.co.score === 1 && R.bu.score === 1,
      R.st.score + '/' + R.co.score + '/' + R.bu.score);
    ok('all four RAPID checks clear', R.rapid && R.rapid.pass === true, unmetOf(R));
    ok('clearing the gate promotes accel to rapid', R.tier === 'rapid', R.tier);
    // The whole premise of the gate: the blend is already pinned at accel, so it cannot be
    // what separates the top two tiers.
    ok('the blend is already at its ceiling, so it cannot be what promotes',
      Math.abs(R.blended - 1) < 1e-9, R.blended);

    // --- 1. at the cap rate is not past the cap rate ---
    ptSeed({ bench: 1.75 });   // ratio exactly 1.0: still the top strength bucket, still accel
    R = ev('computeProgressStatus()');
    ok('a lift merely at its cap rate still blends into the top band', R.blended >= 0.75, R.blended);
    ok('merely matching the cap rate does not earn RAPID', R.tier === 'accel', R.tier);
    ok('...and the gate says the cap is the reason', unmetOf(R).indexOf('past its cap rate') >= 0, unmetOf(R));
    ok('...naming the lift in full, not as its last word', unmetOf(R).indexOf('Barbell Bench Press') >= 0, unmetOf(R));
    ok('only that one check failed', R.rapid.unmet.length === 1, unmetOf(R));

    // --- 2. an acceptable scale rate is not the same as a good bulk ---
    // bulkScore() only reads the last 28 days, so a window that opens with a fast climb and
    // settles to +0.8 lb/wk still scores a full 1.0 there, while anBulkQuality() fits the whole
    // 12 weeks and sees bodyweight outrunning the bar. Without check 2 this fixture is RAPID.
    ptSeed({ bw: (i) => 170 + (i <= 7 ? i * 2.5 : 17.5 + (i - 7) * 0.8) });
    R = ev('computeProgressStatus()');
    ok('the recent scale rate alone still scores full marks', R.bu.score === 1, R.bu.rate);
    ok('a bodyweight-outrunning-strength window blocks RAPID', R.tier === 'accel', R.tier);
    ok('...and the gate names bulk quality', unmetOf(R).indexOf('Bulk quality') >= 0, unmetOf(R));
    ok('only that one check failed', R.rapid.unmet.length === 1, unmetOf(R));

    // --- 3. a favourable slope is not a PR ---
    ptSeed({ pr: -40 });
    R = ev('computeProgressStatus()');
    ok('a PR older than the window does not count', R.tier === 'accel', R.tier);
    ok('...and the gate names the PR drought', unmetOf(R).indexOf('No PR') >= 0, unmetOf(R));
    ok('only that one check failed', R.rapid.unmet.length === 1, unmetOf(R));
    ptSeed({ pr: null });
    ok('no PR history at all does not count', ev('computeProgressStatus()').tier === 'accel');
    ptSeed({ pr: -20 });
    ok('a PR just inside the window does count', ev('computeProgressStatus()').tier === 'rapid');

    // --- 4. a flagged lift blocks the top tier however good the averages look ---
    ptSeed();
    ev("S.invest.flags.push({key:'lift:Barbell Bench Press', severity:'red', status:'active', title:'Bench stalled', at:todayKey()})");
    R = ev('computeProgressStatus()');
    ok('an active red flag blocks RAPID', R.tier === 'accel', R.tier);
    ok('...and the gate points at Overload Status', unmetOf(R).indexOf('Overload Status') >= 0, unmetOf(R));
    ok('only that one check failed', R.rapid.unmet.length === 1, unmetOf(R));
    // A dismissed flag is not an active one, so it must not hold the tier down forever.
    ev("S.invest.flags[0].status = 'dismissed'");
    ok('a dismissed flag stops blocking', ev('computeProgressStatus()').tier === 'rapid');

    // --- nothing below accel reaches the gate at all ---
    ev('S.logs = []; S.weights = []; S.prHistory = [];');
    ok('an empty state has no tier at all', ev('computeProgressStatus()').tier === null);

    // --- the cards ---
    ptSeed();
    let card = ev('nextLevelCardHTML(computeProgressStatus())');
    ok('the RAPID card says excelling', card.indexOf('excelling') >= 0, card.slice(0, 160));
    ok('the RAPID card names the tier', card.indexOf('RAPID PROGRESS') >= 0);
    ok('the RAPID card is not the ACCELERATED card', card.indexOf('ACCELERATED') === -1);
    ok('the RAPID card quotes the lift that beat its cap', card.indexOf('120% of its cap rate') >= 0,
      card.slice(0, 400));

    ptSeed({ pr: null });
    card = ev('nextLevelCardHTML(computeProgressStatus())');
    ok('the ACCELERATED card keeps its own copy', card.indexOf('doing everything right') >= 0);
    ok('...and still says the job is consistency', card.indexOf('The job now is consistency') >= 0);
    ok('...and appends what is still blocking RAPID', card.indexOf('Still between you and RAPID') >= 0);
    ok('...naming the check that actually failed', card.indexOf('No PR on any lift') >= 0);
    // A cleared gate must drop the footer entirely rather than render an empty heading.
    ptSeed();
    card = ev('nextLevelCardHTML(computeProgressStatus())');
    ok('a cleared gate renders no blocking footer', card.indexOf('Still between you and RAPID') === -1);

    // --- the step bar ---
    // jsdom has no layout engine, so this asserts which steps the renderer chose to fill,
    // not how wide they came out. Widths have to be eyeballed in a real browser.
    let bar = ev('progressStatusCardHTML(computeProgressStatus())');
    ok('the step bar draws one step per tier', ptCount(bar, 'ptier-seg') === 5,
      String(ptCount(bar, 'ptier-seg')));
    ok('the step bar marks exactly one current step', ptCount(bar, 'ptier-seg cur') === 1);
    ok('at RAPID the bar reads step 5 of 5', bar.indexOf('Step 5 of 5') >= 0);
    ok('the bar carries a screen-reader label', bar.indexOf('role="img"') >= 0);
    // Filled steps carry their own tier token inline; unreached ones carry none and fall
    // back to the flat CSS background.
    ok('every step up to the current one is filled', ptCount(bar, 'background:var(--tier-') === 5,
      String(ptCount(bar, 'background:var(--tier-')));
    ptSeed({ pr: null });
    bar = ev('progressStatusCardHTML(computeProgressStatus())');
    ok('at ACCELERATED the bar reads step 4 of 5', bar.indexOf('Step 4 of 5') >= 0);
    ok('...and leaves the last step unfilled', ptCount(bar, 'background:var(--tier-') === 4,
      String(ptCount(bar, 'background:var(--tier-')));
    ok('...and still marks exactly one current step', ptCount(bar, 'ptier-seg cur') === 1);

    // --- cleanup ---
    const ptSaved = JSON.parse(savedPT);
    ev('S.logs = ' + JSON.stringify(ptSaved.logs) + '; S.weights = ' + JSON.stringify(ptSaved.weights) +
       '; S.prHistory = ' + JSON.stringify(ptSaved.prHistory) + '; S.invest = ' + JSON.stringify(ptSaved.invest) +
       '; S.schedule = ' + JSON.stringify(ptSaved.schedule) + ';');
    ok('cleanup: real logs restored', ev('JSON.stringify(S.logs)') === JSON.stringify(ptSaved.logs));
    ok('cleanup: real bodyweight restored', ev('JSON.stringify(S.weights)') === JSON.stringify(ptSaved.weights));
    ok('cleanup: real schedule restored', ev('JSON.stringify(S.schedule)') === JSON.stringify(ptSaved.schedule));
  } catch (e) {
    ok('progress tier section', false, e.message);
    const ptSaved = JSON.parse(savedPT);
    ev('S.logs = ' + JSON.stringify(ptSaved.logs) + '; S.weights = ' + JSON.stringify(ptSaved.weights) +
       '; S.prHistory = ' + JSON.stringify(ptSaved.prHistory) + '; S.invest = ' + JSON.stringify(ptSaved.invest) +
       '; S.schedule = ' + JSON.stringify(ptSaved.schedule) + ';');
  }

  // ============================================================
  //  V4 PHASE 1 REGRESSIONS
  // ============================================================
  console.log('=== INCREMENTS FOLLOW THE SPLIT IN FORCE (meso block) ===');
  try {
    const savedInc = ev('JSON.stringify({split:S.split, logs:S.logs})');
    // A configured increment only proves anything if it lives in a split that ISN'T S.split.
    // With no block active, incForExercise() reads S.split and passes either way, so this
    // fixture has to stand up a real, APPROVED meso strength block first.
    ev("mesoStart({phases:[{id:'pi',type:'str',name:'Strength',weeks:2,repLo:3,repHi:5,rpeLo:8,rpeHi:9}],repeat:false,cycles:1}, todayKey())");
    ev('mesoEnsureProposals()');
    const bid = ev('mesoActive().weeks[0].blockId');
    ev('mesoApproveSplit(' + JSON.stringify(bid) + ')');
    ok('control: block is actually in force', ev("Object.keys(activeSplitObj()).join(',')") === 'S1,S2,S3',
       ev("Object.keys(activeSplitObj()).join(',')"));

    // put a deliberately non-default increment on a block exercise, and make sure the name
    // is one incFor() would otherwise guess differently for (Leg Press defaults to 10)
    ev("mesoActive().splits[" + JSON.stringify(bid) + "].split.S1.exercises[0] = {name:'Leg Press', inc:15};");
    ok('control: Leg Press is absent from the permanent split S1', ev('!S.split.S1') === true);
    ok('control: incFor default for Leg Press is 10, not 15', ev("incFor('Leg Press')") === 10, String(ev("incFor('Leg Press')")));
    ok('incForExercise reads the block increment (15), not the default',
       ev("incForExercise('Leg Press')") === 15, String(ev("incForExercise('Leg Press')")));

    // and the decrease path actually uses it: a failed set must back off by 15, not 10
    ev("S.logs = S.logs.filter(l=>!(l.entries||[]).some(e=>e.exercise==='Leg Press'));");
    ev("S.logs.push({id:99201, date:mesoAddDays(todayKey(),-3), day:'S1', entries:[" +
       "{exercise:'Leg Press', sets:[{w:200,r:2,e:'fail'},{w:200,r:2,e:'fail'}]}]});");
    // reps deliberately BELOW the range floor: at or inside the range a failed set is a 'hold'
    // (win the reps back at the same load), and only a below-range failure triggers the back-off
    // branch whose step size is the thing under test.
    const dec = ev("classifyDecision('Leg Press')");
    ok('a failed session backs off by the configured 15, not the default 10',
       dec && dec.to === 185, JSON.stringify(dec));

    // intra-session back-off reads the same number
    const adv = ev("intraAdvice({name:'Leg Press', sets:[{w:200,r:3,e:'fail'}], lo:3, hi:6, targetW:200, recDetail:''})");
    ok('mid-session back-off also uses 15', adv && adv.w === 185, JSON.stringify(adv));

    // formFocus resolves through the same path
    ev("mesoActive().splits[" + JSON.stringify(bid) + "].split.S1.exercises[1] = {name:'Barbell Bench Press', inc:5, formFocus:true};");
    ok('isFormFocus sees a block exercise too', ev("isFormFocus('Barbell Bench Press')") === true);

    ev('mesoStop();');
    const restInc = JSON.parse(savedInc);
    ev('S.split = ' + JSON.stringify(restInc.split) + '; S.logs = ' + JSON.stringify(restInc.logs) + ';');
    ok('fixture cleaned up', ev("S.logs.every(l=>l.id!==99201)"));
  } catch (e) {
    ok('increment/meso section', false, e.message);
    ev('mesoStop();');
  }

  console.log('=== API REQUEST SHAPE (Sonnet 5 migration) ===');
  try {
    const htmlSrc = require('fs').readFileSync(HTML_PATH, 'utf8');
    ok('the model is declared exactly once', (htmlSrc.match(/const AI_MODEL =/g) || []).length === 1);
    ok('model is claude-sonnet-5', ev('AI_MODEL') === 'claude-sonnet-5', ev('AI_MODEL'));
    ok('no stale model literal remains anywhere', htmlSrc.indexOf('claude-sonnet-4-6') < 0);

    // Capture what the app WOULD send. This is the only part of the migration testable
    // without a live API key, so it is worth being thorough about: every one of these
    // assertions corresponds to something that returns a 400 on Sonnet 5.
    ev("window.__sent = []; window.__realFetch = window.fetch;");
    ev("window.fetch = function(url, init){ window.__sent.push({url:url, init:init}); " +
       "return Promise.resolve({ok:true, json:function(){ return Promise.resolve({content:[{type:'text', text:'{}'}]}); }}); };");
    ev("S.settings.apiKey = 'sk-test';");
    ev("(function(){ return callClaude([{role:'user', content:'hi'}], 'sys', 500); })()");
    await new Promise(r => setTimeout(r, 30));
    const sent = ev('window.__sent');
    ok('a request was actually issued', sent.length >= 1, 'count=' + sent.length);
    const body = JSON.parse(sent[0].init.body);
    const hdrs = sent[0].init.headers;
    ok('request targets the messages endpoint', String(sent[0].url).indexOf('/v1/messages') > 0, String(sent[0].url));
    ok('body carries the shared model constant', body.model === 'claude-sonnet-5', body.model);
    // these three were REMOVED on Sonnet 5 and 400 if present
    ok('no temperature (removed on Sonnet 5)', body.temperature === undefined);
    ok('no top_p (removed on Sonnet 5)', body.top_p === undefined);
    ok('no top_k (removed on Sonnet 5)', body.top_k === undefined);
    // budget_tokens is likewise gone; adaptive thinking is controlled via effort
    ok('no thinking.budget_tokens', !body.thinking || body.thinking.budget_tokens === undefined);
    ok('effort is set so adaptive thinking does not run unbounded',
       body.output_config && typeof body.output_config.effort === 'string', JSON.stringify(body.output_config));
    ok('default effort is medium', body.output_config.effort === 'medium', body.output_config.effort);
    ok('browser-direct-access header present', hdrs['anthropic-dangerous-direct-browser-access'] === 'true');
    ok('api version header present', hdrs['anthropic-version'] === '2023-06-01');
    // a prefill (last message from the assistant) 400s on Sonnet 5
    ok('messages do not end on an assistant turn (prefill 400s)',
       body.messages[body.messages.length - 1].role === 'user', body.messages[body.messages.length - 1].role);

    // the nightly cycle needs room for thinking AND a complete four-agent JSON object
    ev("window.__sent = [];");
    ev("agState().lastRun = ''; agState().status = {};");
    await ev('agRunAll(true)');
    const nightly = ev('window.__sent');
    ok('nightly cycle issued a request', nightly.length >= 1, 'count=' + nightly.length);
    const nb = JSON.parse(nightly[0].init.body);
    ok('nightly max_tokens leaves room for thinking + full JSON', nb.max_tokens >= 8000, String(nb.max_tokens));
    ok('nightly runs at raised effort', nb.output_config.effort === 'high', nb.output_config.effort);
    ok('nightly still sends a single user turn', nb.messages.length === 1 && nb.messages[0].role === 'user');

    // Every cap in the app must leave room for adaptive thinking. The mid-workout DELTA
    // chat was the tight one (500), where a long think could have returned a blank reply
    // while he was standing at the rack.
    const caps = (htmlSrc.match(/await callClaude(?:WithTools|WithData)?\([\s\S]{0,220}?\)\s*;/g) || [])
      .map(function(c){ var m = c.match(/(\d{3,6})\s*(?:,\s*\{[^}]*\})?\s*\)\s*;\s*$/); return m ? +m[1] : null; })
      .filter(function(v){ return v !== null; });
    ok('found every API call site to check', caps.length >= 7, 'found=' + caps.length + ' -> ' + caps.join(','));
    ok('no max_tokens cap is small enough for thinking to swallow the answer',
       caps.every(function(v){ return v >= 4000; }), caps.join(','));

    ev("window.fetch = window.__realFetch; window.__sent = [];");
  } catch (e) {
    ok('api request shape section', false, e.message);
    ev("if(window.__realFetch) window.fetch = window.__realFetch;");
  }

  console.log('=== LIFT OVERRIDES REACH EVERY SURFACE ===');
  try {
    const savedOv = ev('JSON.stringify({logs:S.logs, inv:S.invest, live:null})');
    ev("S.logs = S.logs.filter(l=>!(l.entries||[]).some(e=>e.exercise==='Barbell Bench Press'));");
    ev("S.logs.push({id:99301, date:mesoAddDays(todayKey(),-3), day:'D1', entries:[" +
       "{exercise:'Barbell Bench Press', sets:[{w:185,r:12,e:'easy'},{w:185,r:12,e:'easy'}]}]});");
    // 12 clean easy reps: the engine WANTS to jump. An override has to beat that everywhere.
    const wantsJump = ev("recommend('Barbell Bench Press').sets[0].w");
    ok('control: without an override the engine raises the weight above 185', +wantsJump > 185, String(wantsJump));

    ev("invState().overrides['Barbell Bench Press'] = {w:155, until: mesoAddDays(todayKey(), 14), note:'test cap'};");
    ok('control: the override resolves', ev("!!invOverrideFor('Barbell Bench Press')") === true);

    // the warm-up ramp used to be built off recommend() directly and ignored the cap, so it
    // ramped toward a top weight the session was never going to use
    const src = ev("warmupSourceFor('D1').find(function(s){return s.name==='Barbell Bench Press';})");
    ok('warm-up ramp is built off the override weight, not the engine suggestion',
       src && src.w === 155, JSON.stringify(src));

    // LIVE and Today already honoured it -- assert they still do, so a future refactor can't
    // quietly regress the two surfaces that were correct
    const built = ev("buildOneLiveExercise('Barbell Bench Press')");
    ok('LIVE target still honours the override', built && +built.targetW === 155, JSON.stringify(built && built.targetW));

    ev("invState().overrides = {};");
    const restOv = JSON.parse(savedOv);
    ev('S.logs = ' + JSON.stringify(restOv.logs) + '; S.invest = ' + JSON.stringify(restOv.inv) + ';');
    ok('override fixture cleaned up', ev("S.logs.every(l=>l.id!==99301)"));
  } catch (e) {
    ok('override reach section', false, e.message);
    ev("invState().overrides = {};");
  }

  console.log('=== liftReset RESOLVES AGAINST THE SPLIT IN FORCE ===');
  try {
    const savedLR = ev('JSON.stringify({split:S.split, logs:S.logs})');
    ev("mesoStart({phases:[{id:'pl',type:'str',name:'Strength',weeks:2,repLo:3,repHi:5,rpeLo:8,rpeHi:9}],repeat:false,cycles:1}, todayKey())");
    ev('mesoEnsureProposals()');
    const lbid = ev('mesoActive().weeks[0].blockId');
    ev('mesoApproveSplit(' + JSON.stringify(lbid) + ')');
    // a lift that exists ONLY inside the approved block, never in S.split and never logged
    ev("mesoActive().splits[" + JSON.stringify(lbid) + "].split.S2.exercises[0] = {name:'Safety Bar Squat', inc:10, repMode:'str'};");
    ok('control: the lift is absent from the permanent split', ev("!agTrainedExNames.toString||true") === true);
    ok('control: the lift was never logged', ev("!S.logs.some(l=>(l.entries||[]).some(e=>e.exercise==='Safety Bar Squat'))") === true);
    ok('control: the lift is not in the permanent split either',
       ev("!Object.keys(S.split).some(function(dk){return (S.split[dk].exercises||[]).some(function(x){return exName(x)==='Safety Bar Squat';});})") === true);

    // Before the fix agTrainedExNames() only scanned S.split + logs, so this resolved to null
    // and agValidateFix() discarded a perfectly legitimate proposal.
    ok('a block-only lift is recognised as one he trains',
       ev("agResolveExName('Safety Bar Squat')") === 'Safety Bar Squat', String(ev("agResolveExName('Safety Bar Squat')")));
    const vfix = ev("agValidateFix({type:'liftReset', payload:{name:'Safety Bar Squat', w:225, days:14}})");
    ok('liftReset against a block-only lift now validates', vfix && vfix.payload.name === 'Safety Bar Squat', JSON.stringify(vfix));
    // and the boundary still holds for a genuinely unknown lift
    ok('an invented lift is still rejected',
       ev("agValidateFix({type:'liftReset', payload:{name:'Zercher Cable Jefferson Curl', w:225, days:14}})") === null);

    ev('mesoStop();');
    const restLR = JSON.parse(savedLR);
    ev('S.split = ' + JSON.stringify(restLR.split) + '; S.logs = ' + JSON.stringify(restLR.logs) + ';');
  } catch (e) {
    ok('liftReset resolution section', false, e.message);
    ev('mesoStop();');
  }

  console.log('=== ONE BODYWEIGHT RATE, CORRECT BANDS ===');
  try {
    const savedW = ev('JSON.stringify(S.weights)');
    // The case he reported: a real, steady climb that is still short of the 0.5 lb/wk pocket
    // floor, which renderBulk() used to call "right in the lean-bulk pocket" anyway.
    // Deliberately NOT a clean straight line — a perfectly linear series makes the weekly
    // average equal the raw value, which would hide an anchoring bug. Fixed offsets, never
    // random, so the suite stays deterministic.
    // The trend is +0.30 rather than the +0.15 he actually reported ON PURPOSE: 0.15 is
    // exactly the flat/under band EDGE, so a fixture aimed there decides the band on rounding
    // noise and flips to 'flat' on any change to the bucketing. Mid-band proves the same
    // claim (below the pocket floor, and not called 'pocket') without balancing on a knife.
    const wob = [0, 0.4, -0.3, 0.2, -0.4, 0.3, -0.2, 0.1, 0.35, -0.35, 0.15, -0.15];
    ev('S.weights = [];');
    // End the series on a SUNDAY, not on "today". bodyweightSeriesSmoothed() buckets into
    // Monday-anchored weeks, so a fixture ending on today leaves a final partial week whose
    // size is whatever weekday the suite happens to run on -- and the 4-week regression over
    // those averages moves with it. This exact fixture read +0.26 lb/wk on a Wednesday and
    // +0.13 (a different BAND, so four red assertions) on the Thursday, with no code change
    // between them. Anchoring to Sunday makes every bucket a full seven days on every day.
    const backToSun = ev("new Date(todayKey()+'T00:00:00').getDay()");
    for (let i = 0; i < 42; i++) {
      const lbs = (150 + i * (0.30 / 7) + wob[i % wob.length]).toFixed(1);
      ev("S.weights.push({date: mesoAddDays(todayKey(), " + (i - 41 - backToSun) + "), lbs: " + lbs + "});");
    }
    const br = ev('bulkRate(4)');
    ok('bulkRate returns a rate from weekly averages', br && typeof br.rate === 'number', JSON.stringify(br));
    // Measured pace lands near +0.26 rather than the +0.15 underlying trend, because the
    // wobble is not mean-zero across a 4-week window. That is the point: real weigh-in noise
    // moves the number, and the band still has to be right. Bounded on both sides so a future
    // fixture edit that drifts it into a different band fails loudly instead of silently.
    ok('measured rate sits between the flat floor and the pocket floor', br.rate > 0.2 && br.rate < 0.45, String(br && br.rate));
    ok('a gaining-but-below-0.5 rate bands as "under", not "pocket"', ev('bulkBand(' + br.rate + ')') === 'under',
       ev('bulkBand(' + br.rate + ')') + ' @ ' + br.rate);

    // the actual reported symptom, asserted on rendered output
    ev('renderBulk()');
    const bulkHTML = w.document.getElementById('bulk').innerHTML;
    ok('Bulk tab no longer claims the lean-bulk pocket at this rate',
       bulkHTML.indexOf('Right in the lean-bulk pocket') < 0, bulkHTML.slice(0, 300));
    ok('Bulk tab says he is under the band instead',
       bulkHTML.indexOf('lean-bulk pocket') >= 0 && bulkHTML.indexOf('Add ~150') >= 0, bulkHTML.slice(0, 400));

    // band edges
    ok('band: 0.0 is flat', ev('bulkBand(0.0)') === 'flat');
    ok('band: 0.15 is under', ev('bulkBand(0.15)') === 'under');
    ok('band: 0.49 is under', ev('bulkBand(0.49)') === 'under');
    ok('band: 0.5 is the pocket floor', ev('bulkBand(0.5)') === 'pocket');
    ok('band: 1.0 is the pocket ceiling', ev('bulkBand(1.0)') === 'pocket');
    ok('band: 1.01 is hot', ev('bulkBand(1.01)') === 'hot');
    ok('band: negative is losing', ev('bulkBand(-0.2)') === 'losing');

    // all three surfaces must quote the SAME number now
    const invRate = ev("(function(){var f=investigateBulk().findings.join(' ');var m=f.match(/Trailing rate: ([+-][0-9.]+)/);return m?parseFloat(m[1]):null;})()");
    ok('Investigation quotes the same rate as bulkRate', invRate !== null && Math.abs(invRate - br.rate) < 0.005,
       'inv=' + invRate + ' bulkRate=' + br.rate);

    // The fourth surface, and the one he caught disagreeing on screen: the Progress verdict's
    // "bulk rate" stat ran its OWN raw first-vs-last weigh-in over 28 days, so it read one
    // number while the Bulk tab read another off the identical weigh-ins on the same day.
    const bu = ev('bulkScore()');
    ok('the Progress verdict is available on this fixture', bu && bu.available === true, JSON.stringify(bu));
    ok('the Progress verdict quotes the same rate as bulkRate',
       Math.abs(bu.rate - br.rate) < 0.005, 'progress=' + (bu && bu.rate) + ' bulkRate=' + br.rate);
    // and the words under the number have to agree with the band, not contradict it -- at this
    // rate the Bulk tab says "under the pocket, add calories", so the verdict cannot say
    // "right in the lean-bulk range"
    ok('the Progress note agrees with the band', ev('bulkScore().note').indexOf('under the') >= 0, ev('bulkScore().note'));
    ok('an under-pocket rate does not score as a full-credit bulk', bu.score < 0.75, String(bu.score));
    const shownRate = (br.rate >= 0 ? '+' : '') + br.rate.toFixed(2) + ' lb/wk';
    const progHTML = ev('progressStatusCardHTML()');
    ok('the Progress card prints the same lb/wk figure the Bulk tab does',
       progHTML.indexOf(shownRate) >= 0, shownRate + ' | ' + progHTML.slice(0, 500));

    ev('S.weights = ' + savedW + ';');
    ok('bodyweight fixture cleaned up', ev('S.weights.length') === JSON.parse(savedW).length);
  } catch (e) {
    ok('bulk rate section', false, e.message);
  }

  console.log('=== WHOOP RELAY (data in, never out) ===');
  try {
    ev('delete S.whoop;');
    // applyWhoop is a validator, not a setter. The file it reads is written by a scheduled
    // job into a gist, so it gets the same treatment as model output: take only the shapes
    // we understand, clamp what we take, ignore the rest.
    ok('garbage is refused', ev('applyWhoop(null)') === false && ev("applyWhoop('nope')") === false &&
       ev('applyWhoop({})') === false);
    ok('nothing was written by a refused payload', ev('!S.whoop') === true);
    ok('a payload with no usable section is refused', ev("applyWhoop({fetchedAt:'x', junk:1})") === false);

    ok('a valid recovery lands', ev("applyWhoop({recovery:{date:todayKey(), score:71, hrv:88, rhr:52}})") === true);
    ok('the score is stored', ev('S.whoop.recovery.score') === 71);
    ok('a bad date shape is refused', ev("applyWhoop({recovery:{date:'yesterday', score:71}})") === false);
    ev('delete S.whoop;');
    ok('an out-of-range score is clamped, not taken raw',
       ev("applyWhoop({recovery:{date:todayKey(), score:9999}})") && ev('S.whoop.recovery.score') === 100,
       String(ev('S.whoop && S.whoop.recovery.score')));
    ev('delete S.whoop;');
    ok('a non-numeric score is dropped', ev("applyWhoop({recovery:{date:todayKey(), score:'lots'}})") === false);
    ok('sleep alone is enough to store', ev("applyWhoop({sleep:{date:todayKey(), hours:7.5, performance:88}})") === true);
    ok('sleep hours are kept', ev('S.whoop.sleep.hours') === 7.5);

    // freshness: a score from three days ago is worse than none, because it looks current
    ev("applyWhoop({recovery:{date:todayKey(), score:60}});");
    ok('today\u2019s data is fresh', ev('whoopFresh()') === true);
    ev("S.whoop.recovery.date = '2020-01-01';");
    ok('old data is not fresh', ev('whoopFresh()') === false);
    ok('and readiness falls back to the check-in',
       ev("(function(){ S.readiness=[{date:todayKey(),tier:'high',sleep:8,sore:'mild',energy:'good'}]; return readinessNow().source; })()") === 'self-reported');
    ok('a stale score contributes nothing to the agent prompt', ev('whoopContext()') === '');

    // fresh data reaches the agents and is labelled as measured
    ev("applyWhoop({recovery:{date:todayKey(), score:71, hrv:88, rhr:52}, sleep:{date:todayKey(), hours:7.5, performance:88}});");
    const wc = ev('whoopContext()');
    ok('fresh WHOOP reaches the agent prompt', wc.indexOf('71%') >= 0, wc.slice(0, 140));
    ok('sleep is included', wc.indexOf('7.5h') >= 0, wc);
    ok('agents are told it is measured, not self-reported', /measured data, not self-reported/.test(wc));
    ok('it reaches the real training context', ev('trainingContext()').indexOf('WHOOP TODAY') >= 0);

    // THE sync rule: WHOOP comes in, it never goes back out
    ev("S.settings.ghToken='t'; S.settings.gistId='g';");
    const payload = JSON.parse(ev('syncPayload()'));
    ok('WHOOP is stripped from the sync payload', payload.data.whoop === undefined,
       JSON.stringify(payload.data.whoop));
    ok('control: it is still in local state', ev('!!S.whoop') === true);
    ok('secrets are still stripped too',
       payload.data.settings.ghToken === undefined && payload.data.settings.apiKey === undefined);
    ev('delete S.whoop; S.readiness = [];');
  } catch (e) {
    ok('whoop section', false, e.message);
    ev('delete S.whoop;');
  }

  console.log('=== READINESS CHECK-IN REFLECTS THE WHOOP PRE-FILL ===');
  try {
    // Values landing in _rdV3 is necessary but not sufficient -- the actual bug was that a
    // set value with no visibly selected pill looks identical to nothing having happened,
    // which contradicts the intro text telling him it was pre-filled.
    ev("if(!document.getElementById('readyOverlay')){ var d=document.createElement('div'); d.id='readyOverlay'; document.body.appendChild(d); }");
    ev("if(!document.getElementById('readyBody')){ var d2=document.createElement('div'); d2.id='readyBody'; document.body.appendChild(d2); }");
    ev("applyWhoop({recovery:{date:todayKey(), score:82, hrv:90, rhr:48}, sleep:{date:todayKey(), hours:8.4, performance:91}});");
    ev("openReadyCheck('D1')");

    const classFor = (k, v) => ev(
      "(function(){ var b = Array.prototype.find.call(document.querySelectorAll('.rd3-pill'), " +
      "function(x){ return x.dataset.k===" + JSON.stringify(k) + " && x.dataset.v===" + JSON.stringify(v) + "; }); " +
      "return b ? b.className : null; })()"
    );

    ok('the 8+ sleep pill carries the on class', /\bon\b/.test(classFor('sleep', '8+') || ''), classFor('sleep', '8+'));
    ok('the high energy pill carries the on class (score 82 >= 67)', /\bon\b/.test(classFor('energy', 'high') || ''), classFor('energy', 'high'));
    ok('a non-matching sleep pill does NOT carry it', !/\bon\b/.test(classFor('sleep', '6-7') || ''), classFor('sleep', '6-7'));

    // categories WHOOP does not measure must stay untouched -- no pill pre-selected
    ['fresh', 'mild', 'beat up'].forEach(function(v){
      ok('soreness option "' + v + '" has no pre-selected pill', !/\bon\b/.test(classFor('sore', v) || ''), classFor('sore', v));
    });

    ok('_rdV3 itself carries the value, not just the pixel', ev('_rdV3.sleep') === '8+' && ev('_rdV3.energy') === 'high');

    // and it must still be possible to override: tapping a different pill wins
    ev(
      "(function(){ var b = Array.prototype.find.call(document.querySelectorAll('.rd3-pill'), " +
      "function(x){ return x.dataset.k==='sleep' && x.dataset.v==='6-7'; }); rd3Pick(b); })()"
    );
    ok('tapping a different pill overrides the WHOOP pre-fill', ev('_rdV3.sleep') === '6-7');
    ok('the previously pre-filled pill loses its on class once overridden', !/\bon\b/.test(classFor('sleep', '8+') || ''));

    ev('delete S.whoop; S.readiness = [];');
    ev("document.getElementById('readyOverlay').classList.remove('show');");
  } catch (e) {
    ok('readiness pre-fill visibility section', false, e.message);
    ev('delete S.whoop;');
  }

  console.log('=== PROGRESS PHOTOS (index in state, blobs elsewhere) ===');
  try {
    ev("S.photos = {gistId:'', index:[]};");
    ok('photoState initialises', Array.isArray(ev('photoState().index')));
    ok('month keys are year-month', ev("photoMonthKey('2026-08-24')") === '2026-08');
    ok('no photo for an empty month', ev("photoForMonth('2026-08')") === null);
    ev("S.photos.index = [{id:'a', date:'2026-08-03', w:480, h:640, bytes:1000}];");
    ok('a photo is found by its month', ev("photoForMonth('2026-08').id") === 'a');
    ok('a different month does not match', ev("photoForMonth('2026-07')") === null);

    // THE storage rule: state holds an index, never image data. If a blob ever lands in S it
    // gets JSON-encoded into localStorage on every save and re-uploaded on every sync.
    const stateStr = ev('JSON.stringify(S.photos)');
    ok('no image data in state', stateStr.indexOf('data:image') < 0, stateStr.slice(0, 200));
    ok('the index stays small', stateStr.length < 600, 'len=' + stateStr.length);
    ok('the index records size so growth is visible', ev('S.photos.index[0].bytes') === 1000);

    // the downscale is what keeps a phone portrait from being a megabyte
    ok('the long edge is capped', ev('PHOTO_MAX_EDGE') <= 1024 && ev('PHOTO_MAX_EDGE') >= 320, String(ev('PHOTO_MAX_EDGE')));
    ok('and it is re-encoded as lossy JPEG', ev('PHOTO_QUALITY') > 0 && ev('PHOTO_QUALITY') < 1, String(ev('PHOTO_QUALITY')));

    // the card degrades rather than breaking when sync is not connected
    const savedTok = ev('S.settings.ghToken');
    ev("S.settings.ghToken = ''; photoOpen = true;");
    const noSync = ev('photoCardHTML()');
    ok('without sync the card explains itself instead of failing', /Connect cloud sync/.test(noSync), noSync.slice(0, 200));
    ok('and offers no upload control it cannot honour', noSync.indexOf('type="file"') < 0);
    ev("S.settings.ghToken = 'tok';");
    const withSync = ev('photoCardHTML()');
    ok('with sync it offers the upload', withSync.indexOf('type="file"') >= 0);
    ok('an empty history says so rather than showing a gap',
       /Nothing yet/.test(ev("(function(){ S.photos.index=[]; return photoCardHTML(); })()")));
    ev("S.photos.index = [{id:'a', date:'2026-08-03', w:1, h:1, bytes:1}];");
    ok('collapsed, the card renders nothing heavy',
       ev("(function(){ photoOpen=false; var h=photoCardHTML(); photoOpen=true; return h; })()").indexOf('type="file"') < 0);

    ev("photoOpen = false; S.photos = {gistId:'', index:[]};");
    ev("S.settings.ghToken = " + JSON.stringify(savedTok) + ";");
  } catch (e) {
    ok('photo section', false, e.message);
    ev("photoOpen = false; S.photos = {gistId:'', index:[]};");
  }

  console.log('=== DAY-GRANULAR MESOCYCLE ===');
  try {
    const savedMeso = ev('JSON.stringify(mesoState())');
    // Exactly the plan from the brief: a 7-week hypertrophy block, then strength and deload
    // measured in DAYS -- S1-S3 is three days, a rest day, three deload days, then reset.
    ev("mesoStart({phases:[" +
       "{id:'h',type:'hyp',   name:'Hypertrophy',weeks:7,repLo:8,repHi:12,rpeLo:7,rpeHi:8}," +
       "{id:'s',type:'str',   name:'Strength',   unit:'days',days:3,repLo:3,repHi:5,rpeLo:8,rpeHi:9}," +
       "{id:'r',type:'rest',  name:'Rest',       unit:'days',days:1,repLo:0,repHi:0,rpeLo:0,rpeHi:0}," +
       "{id:'d',type:'deload',name:'Deload',     unit:'days',days:3,repLo:8,repHi:12,rpeLo:5,rpeHi:6}" +
       "],repeat:false,cycles:1}, '2026-03-02')");
    const segs = ev('mesoActive().weeks');
    ok('a weeks phase still makes one segment per week', segs.filter(function(w){ return w.type==='hyp'; }).length === 7,
       String(segs.filter(function(w){ return w.type==='hyp'; }).length));
    ok('a days phase makes ONE segment, not one per day',
       segs.filter(function(w){ return w.type==='str'; }).length === 1,
       String(segs.filter(function(w){ return w.type==='str'; }).length));
    ok('total segments = 7 weeks + 3 day-blocks', segs.length === 10, String(segs.length));

    const str = segs.find(function(w){ return w.type==='str'; });
    const rest = segs.find(function(w){ return w.type==='rest'; });
    const del = segs.find(function(w){ return w.type==='deload'; });
    ok('the strength block is 3 days long', str.days === 3, String(str.days));
    ok('and spans exactly 3 calendar days', str.startKey === '2026-04-20' && str.endKey === '2026-04-22',
       str.startKey + '..' + str.endKey);
    ok('the rest day is a single day', rest.days === 1 && rest.startKey === rest.endKey, rest.startKey + '..' + rest.endKey);
    ok('it starts the day after strength ends', rest.startKey === '2026-04-23', rest.startKey);
    ok('deload is 3 days and follows the rest day', del.days === 3 && del.startKey === '2026-04-24', del.startKey + ' x' + del.days);
    ok('segments are contiguous with no gaps or overlaps',
       segs.every(function(w, i){ return i === 0 || w.startKey === ev("mesoAddDays(" + JSON.stringify(segs[i-1].endKey) + ", 1)"); }));

    // the day resolution everything else depends on
    ok('a date inside the 3-day strength block resolves to it', ev("mesoWeekAt('2026-04-21').type") === 'str');
    ok('the day after it does not', ev("mesoWeekAt('2026-04-23').type") === 'rest');
    ok('a hypertrophy week still resolves', ev("mesoWeekAt('2026-03-09').type") === 'hyp');

    // plan length has to count day-phases at their real length, not ignore them
    const tplDays = ev("mesoTotalDays({phases:[{type:'hyp',weeks:7},{type:'str',unit:'days',days:3},{type:'rest',unit:'days',days:1},{type:'deload',unit:'days',days:3}],repeat:false,cycles:1})");
    ok('total days = 49 + 3 + 1 + 3', tplDays === 56, String(tplDays));

    // a plan saved before this change must materialize identically
    ev("mesoStop(); mesoStart({phases:[{id:'o',type:'hyp',name:'Old',weeks:3,repLo:8,repHi:12,rpeLo:7,rpeHi:8}],repeat:false,cycles:1}, '2026-03-02')");
    const legacy = ev('mesoActive().weeks');
    ok('a legacy weeks-only plan still yields 7-day segments',
       legacy.length === 3 && legacy.every(function(w){ return w.days === 7; }),
       JSON.stringify(legacy.map(function(w){ return w.days; })));
    ok('and its dates are unchanged', legacy[0].startKey === '2026-03-02' && legacy[0].endKey === '2026-03-08',
       legacy[0].startKey + '..' + legacy[0].endKey);

    ev('mesoStop();');
    ev('S.meso = ' + savedMeso + ';');
  } catch (e) {
    ok('day-granular mesocycle section', false, e.message);
    ev('mesoStop();');
  }

  console.log('=== DASHBOARD / STATUS STRIP / NOTIFICATIONS ===');
  try {
    const savedRd = ev('JSON.stringify(S.readiness)');
    ev("S.readiness = [{date:todayKey(), tier:'high', sleep:8, sore:'mild', energy:'good'}];");

    // one readiness reading, shared, so the two surfaces cannot disagree
    const rn = ev('readinessNow()');
    ok('readinessNow reads the check-in', rn && rn.label === 'high', JSON.stringify(rn));
    ok('and reports where it came from', rn.source === 'self-reported', rn.source);
    ev("S.readiness = [];");
    ok('no check-in yields no reading rather than a fake one', ev('readinessNow()') === null);
    ev("S.readiness = [{date:todayKey(), tier:'low', sleep:5, sore:'high', energy:'flat'}];");
    ok('a low check-in reads as low', ev('readinessNow()').label === 'low');
    // WHOOP is not connected yet, but the branch must already prefer it when it lands
    ev("S.whoop = {recovery:{date:todayKey(), score:71}};");
    const wr = ev('readinessNow()');
    ok('a WHOOP score takes precedence when present', wr.source === 'WHOOP' && wr.pct === 71, JSON.stringify(wr));
    ev("S.whoop = {recovery:{date:'2020-01-01', score:71}};");
    ok('a stale WHOOP score falls back to the check-in', ev('readinessNow()').source === 'self-reported');
    ev('delete S.whoop;');

    // the strip
    ev('MODE = "review";');
    const strip = ev('statusStripHTML()');
    ok('the strip shows recovery', strip.indexOf('recovery') >= 0);
    ok('the strip shows the streak', strip.indexOf('streak') >= 0);
    ok('the strip shows what day is on', strip.indexOf('today') >= 0);
    ok('the strip labels the readiness source', strip.indexOf('self') >= 0, strip.slice(0, 200));

    // THE rule from the brief: never during a LIVE session
    ev('MODE = "live"; renderStatusStrip();');
    ok('the strip is empty during LIVE', ev("document.getElementById('statusStrip').innerHTML") === '');
    ev('rerenderActive(true);');
    ok('and the refresh loop does not put it back', ev("document.getElementById('statusStrip').innerHTML") === '');
    ev('MODE = "review"; renderStatusStrip();');
    ok('it comes back on leaving LIVE', ev("document.getElementById('statusStrip').innerHTML").length > 0);
    // it must survive the guard that blocks full repaints, or it would go stale while typing
    ev("var _si=document.createElement('input'); _si.id='__stripfocus'; document.body.appendChild(_si); _si.focus();");
    ok('control: a focused input blocks a full repaint', ev('refreshBlocked()') === true);
    ev("document.getElementById('statusStrip').innerHTML = ''; rerenderActive();");
    ok('the strip still updates while an input has focus',
       ev("document.getElementById('statusStrip').innerHTML").length > 0);
    ev("document.getElementById('__stripfocus').blur(); document.getElementById('__stripfocus').remove();");

    // the dashboard
    ev("agState().proposals = []; S.invest = {flags:[], history:[], overrides:{}, lastAuto:{}};");
    ev("delete agState().brief;");
    ev('renderHome()');
    let home = ev("document.getElementById('home').innerHTML");
    ok('the dashboard renders', home.length > 400, 'len=' + home.length);
    ok('it shows recovery, today and streak',
       home.indexOf('Recovery') >= 0 && home.indexOf('Scheduled') >= 0 && home.indexOf('Streak') >= 0);
    // the brief is explicit that an empty day must read as finished, not as a hole
    ok('an empty day says so plainly rather than showing a gap',
       /Nothing needs a decision from you/.test(home), home.slice(home.indexOf('Waiting on you'), home.indexOf('Waiting on you') + 260));
    ok('and still offers a way into the rest of the app', home.indexOf('Jump to') >= 0);
    ok('LIVE is reachable from the dashboard', home.indexOf("setMode('live')") >= 0);

    // with something waiting, the same section shows it instead
    ev("agState().proposals = [{id:'px', agent:'delta', title:'Test proposal', reasoning:'because', fix:{type:'cal',payload:{delta:100}}, created:todayKey(), expires:mesoAddDays(todayKey(),7), status:'pending'}];");
    ev('renderHome()');
    home = ev("document.getElementById('home').innerHTML");
    ok('a pending proposal appears on the dashboard', home.indexOf('Test proposal') >= 0);
    ok('and the quiet copy is gone', /Nothing needs a decision from you/.test(home) === false);

    // notifications
    ok('the badge counts what is waiting', ev('notifCount()') >= 1, String(ev('notifCount()')));
    ev('notifOpen = false; notifToggle();');
    ok('the panel opens', ev("document.getElementById('notifPanel').className").indexOf('open') >= 0);
    ok('the pending proposal is listed', ev("document.getElementById('notifPanel').innerHTML").indexOf('Test proposal') >= 0);
    ev('notifToggle();');
    ok('the panel closes', ev("document.getElementById('notifPanel').className").indexOf('open') < 0);

    // model-supplied text must be escaped on the way into the panel
    ev("agState().proposals[0].title = '<img src=x onerror=alert(1)>';");
    ev('notifOpen = false; notifToggle();');
    const np = ev("document.getElementById('notifPanel').innerHTML");
    ok('notification text is escaped', np.indexOf('<img src=x') < 0 && np.indexOf('&lt;img') >= 0);
    ev('notifToggle();');

    ev("agState().proposals = []; S.readiness = " + savedRd + ";");
  } catch (e) {
    ok('dashboard section', false, e.message);
    ev("MODE = 'review'; notifOpen = false; agState().proposals = [];");
  }

  console.log('=== CLEAR NOTIFICATIONS ===');
  try {
    ev("delete S.notifCleared; agState().proposals = []; S.invest = {flags:[], history:[], overrides:{}, lastAuto:{}};");
    ev("agState().proposals = [{id:'pxa', agent:'delta', title:'Clear-test proposal', reasoning:'r', " +
       "fix:{type:'cal',payload:{delta:100}}, created:todayKey(), expires:mesoAddDays(todayKey(),7), status:'pending'}];");
    ok('starts with nothing cleared', ev('notifClearedIds()').length === 0);
    ok('the item is visible before any clear', ev("notifVisible().some(function(i){ return i.id === 'prop:pxa'; })"));
    ok('and counted', ev('notifCount()') >= 1, String(ev('notifCount()')));

    ev('notifOpen = false; notifToggle();');
    let panel = ev("document.getElementById('notifPanel').innerHTML");
    ok('a clear button is offered while something is showing', panel.indexOf('notifClear()') >= 0);

    // the actual clear
    ev('notifClear()');
    ok('clearing empties what is visible', ev('notifVisible().length') === 0, String(ev('notifVisible().length')));
    ok('and the badge follows it to zero', ev('notifCount()') === 0, String(ev('notifCount()')));
    panel = ev("document.getElementById('notifPanel').innerHTML");
    ok('the panel reflects the clear without a manual reopen', panel.indexOf('Clear-test proposal') < 0, panel.slice(0, 200));
    ok('and says something was cleared, not that nothing was ever there',
       /Cleared/.test(panel), panel.slice(0, 200));

    // clearing is a display filter, never a mutation of the thing being cleared -- Approve/
    // reject and Dismiss are still the only paths that touch a proposal or a flag
    ok('the underlying proposal is untouched by clearing it out of the panel',
       ev("agPending().some(function(p){ return p.id === 'pxa'; })") === true);
    ok('it still shows up on the dashboard, just not in the bell', (function(){
         const home = w.eval("renderHome(); document.getElementById('home').innerHTML");
         return home.indexOf('Clear-test proposal') >= 0;
       })());

    // a genuinely NEW item is not swallowed by an old clear
    ev("agState().proposals.push({id:'pxb', agent:'charlie', title:'Second proposal', reasoning:'r2', " +
       "fix:{type:'incBase',payload:{exercise:'Barbell Bench Press',delta:5}}, created:todayKey(), " +
       "expires:mesoAddDays(todayKey(),7), status:'pending'});");
    ok('a new proposal raised after a clear is not pre-cleared',
       ev("notifVisible().some(function(i){ return i.id === 'prop:pxb'; })"));
    ok('while the earlier, cleared one stays hidden',
       ev("notifVisible().some(function(i){ return i.id === 'prop:pxa'; })") === false);

    // clearing again is self-bounding: it replaces the list with exactly what is on screen,
    // it does not keep appending ids from every clear that has ever happened
    ev('notifClear()');
    ok('the cleared list is exactly the current item set, not an accumulation across clears',
       ev('notifClearedIds().length === notifItems().length'), JSON.stringify(ev('notifClearedIds()')));
    ok('and the id that was actually just cleared is in it',
       ev("notifClearedIds().indexOf('prop:pxb') >= 0"), JSON.stringify(ev('notifClearedIds()')));

    // resolving the flagged item removes it from notifItems() entirely -- its cleared id then
    // simply points at nothing and is never read again, rather than needing to be pruned
    ev("agState().proposals = agState().proposals.filter(function(p){ return p.id !== 'pxb'; });");
    ok('once approved/rejected, a cleared id has nothing left to match',
       ev("notifItems().some(function(i){ return i.id === 'prop:pxb'; })") === false);

    // clearing is a real user action and must sync like one, not vanish on the next pull
    ev("S.meta.changedAt = 0;");
    ev('notifClear()');
    ok('clearing touches the sync watermark like any other user action',
       ev('S.meta.changedAt') > 0, String(ev('S.meta.changedAt')));

    ev('notifToggle();');
    ev("agState().proposals = []; delete S.notifCleared;");
  } catch (e) {
    ok('clear notifications section', false, e.message);
    ev("MODE = 'review'; notifOpen = false; agState().proposals = []; delete S.notifCleared;");
  }

  console.log('=== EFFORT LEVER ===');
  try {
    // buckets fall out of the lever
    ok('0 is failure', ev('effBucketFromLever(0)') === 'fail');
    ok('15 is still failure', ev('effBucketFromLever(15)') === 'fail');
    ok('16 is a grind', ev('effBucketFromLever(16)') === 'grind');
    ok('40 is still a grind', ev('effBucketFromLever(40)') === 'grind');
    ok('41 is solid', ev('effBucketFromLever(41)') === 'solid');
    ok('75 is still solid', ev('effBucketFromLever(75)') === 'solid');
    ok('76 is easy', ev('effBucketFromLever(76)') === 'easy');
    ok('100 is easy', ev('effBucketFromLever(100)') === 'easy');
    ok('a non-number has no bucket', ev("effBucketFromLever('abc')") === null);

    // THE back-compat property: seven months of sets logged with the old tags keep working
    // untouched, with no migration pass over historical data.
    ok('an old easy tag still reads as easy', ev("effBucket({w:100,r:10,e:'easy'})") === 'easy');
    ok('an old grind tag still reads as grind', ev("effBucket({w:100,r:10,e:'grind'})") === 'grind');
    ok('an old fail tag still reads as fail', ev("effBucket({w:100,r:10,e:'fail'})") === 'fail');
    ok('an untagged set has no bucket', ev('effBucket({w:100,r:10})') === null);
    ok('an old tag yields its anchor value', ev("effLever({w:1,r:1,e:'grind'})") === 25);
    ok('an untagged set has no lever value', ev('effLever({w:1,r:1})') === null);

    // the lever wins when both are present, because it is the more precise of the two
    ok('the lever wins over a stale tag', ev("effBucket({w:1,r:1,e:'easy',ef:10})") === 'fail');
    ok('lever values are clamped', ev('effLever({w:1,r:1,ef:500})') === 100 && ev('effLever({w:1,r:1,ef:-9})') === 0);

    // the mean is what buys the extra precision
    ok('mean ignores untagged sets',
       ev('effMean([{ef:80},{w:1,r:1},{ef:100}])') === 90, String(ev('effMean([{ef:80},{w:1,r:1},{ef:100}])')));
    ok('mean of nothing is null', ev('effMean([{w:1,r:1}])') === null);
    ok('mean mixes old tags and new levers',
       ev("effMean([{e:'easy'},{ef:70}])") === 80, String(ev("effMean([{e:'easy'},{ef:70}])")));

    // and it changes a real decision: two sessions that used to look identical no longer do
    const savedL = ev('JSON.stringify(S.logs)');
    const mk = function(ef1, ef2){
      ev("S.logs = S.logs.filter(l=>l.id!==99401);");
      ev("S.logs.push({id:99401, date:mesoAddDays(todayKey(),-3), day:'D1', entries:[{exercise:'Barbell Bench Press'," +
         "sets:[{w:185,r:12,ef:" + ef1 + "},{w:185,r:12,ef:" + ef2 + "}]}]});");
      return ev("classifyDecision('Barbell Bench Press')");
    };
    const bothVeryEasy = mk(95, 95);
    const oneMuchHarder = mk(95, 40);
    ok('two genuinely easy sets earn the double jump', bothVeryEasy.code === 'double', JSON.stringify(bothVeryEasy));
    ok('a session with one hard set does NOT', oneMuchHarder.code === 'increase', JSON.stringify(oneMuchHarder));
    ok('the double jump is twice the single', bothVeryEasy.to - 185 === 2 * (oneMuchHarder.to - 185),
       bothVeryEasy.to + ' vs ' + oneMuchHarder.to);
    // THE case that separates the mean rule from the old bucket rule. 80 and 78 both bucket
    // as 'easy' (everything over 75 does), so the four-bucket rule would call this all-easy
    // and hand out a double jump. The mean is 79, which is not an easy session -- it is a
    // session he only just cleared. Without this fixture the whole change is untested: 95/95
    // and 95/40 behave identically under both rules.
    const barelyEasy = mk(80, 78);
    ok('barely-easy sets do NOT earn a double jump, though both bucket as easy',
       barelyEasy.code === 'increase', JSON.stringify(barelyEasy));
    ok('control: both of those sets really do bucket as easy',
       ev("effBucket({ef:80})") === 'easy' && ev("effBucket({ef:78})") === 'easy');
    // under the old four-bucket rule both of those were "easy" + "solid" -> no double either
    // way for the second, but the first needed EVERY set tagged easy; check the old path still
    // behaves as it always did for sets that carry only a tag
    ev("S.logs = S.logs.filter(l=>l.id!==99401);");
    ev("S.logs.push({id:99401, date:mesoAddDays(todayKey(),-3), day:'D1', entries:[{exercise:'Barbell Bench Press'," +
       "sets:[{w:185,r:12,e:'easy'},{w:185,r:12,e:'easy'}]}]});");
    ok('legacy all-easy sessions still double jump', ev("classifyDecision('Barbell Bench Press')").code === 'double');
    ev('S.logs = ' + savedL + ';');
    ok('effort fixture cleaned up', ev("S.logs.every(l=>l.id!==99401)"));

    // summ() is what every history readout and every agent prompt goes through
    ok('summ marks a lever-logged easy set', /\u1d49/.test(ev("summ([{w:100,r:10,ef:90}])")), ev("summ([{w:100,r:10,ef:90}])"));
    ok('summ marks a lever-logged failure', /\u02e3/.test(ev("summ([{w:100,r:10,ef:5}])")), ev("summ([{w:100,r:10,ef:5}])"));
    ok('summ still marks an old-tag set', /\u1d4d/.test(ev("summ([{w:100,r:10,e:'grind'}])")));

    // the dock writes both fields, so nothing downstream can disagree about a set
    ev("setEffLever(30);");
    ok('the slider sets the lever', ev('liveDockLever') === 30);
    ok('the slider derives the bucket', ev('liveDockEff') === 'grind', ev('liveDockEff'));
    ev("pickEff('easy');");
    ok('a preset sets both', ev('liveDockEff') === 'easy' && ev('liveDockLever') === 90);
    ev("pickEff('easy');");
    ok('deselecting a preset clears both, not just one',
       ev('liveDockEff') === '' && ev('liveDockLever') === null,
       ev('liveDockEff') + '/' + String(ev('liveDockLever')));

    // and the value has to actually reach the logged set, not just sit in dock state
    ev("live = {date:todayKey(), day:'D1', startedAt:Date.now(), exercises:[{name:'Barbell Bench Press'," +
       " sets:[], done:false, planned:3, lo:8, hi:12, targetW:135, advW:135, advLo:8, advHi:12}], curIdx:0};");
    ev('liveActiveIdx = 0; MODE = "live"; renderLive();');
    // Order matters: setEffLever() calls renderLive(), which regenerates the dock and would
    // wipe anything already typed into it. Set the lever first, then fill the inputs.
    ev('setEffLever(35);');
    ev("document.getElementById('dockW').value = '135'; document.getElementById('dockR').value = '10';");
    ev('logLiveSet(0)');
    const logged = ev('live.exercises[0].sets[0]');
    ok('a logged set carries the lever value', logged && logged.ef === 35, JSON.stringify(logged));
    ok('a logged set also carries the bucket for old readers', logged && logged.e === 'grind', JSON.stringify(logged));
    ok('the dock resets after logging', ev('liveDockLever') === null && ev('liveDockEff') === '');
    // editing that set must move BOTH fields, or effBucket (which prefers ef) ignores the tap
    ev("liveEditEff(0, 0, 'easy');");
    const edited = ev('live.exercises[0].sets[0]');
    ok('editing effort updates the lever too, not just the tag',
       edited.e === 'easy' && edited.ef === 90, JSON.stringify(edited));
    ok('and effBucket agrees with what was tapped', ev("effBucket(live.exercises[0].sets[0])") === 'easy');
    ev("live = null; MODE = 'review'; liveDockLever = null; liveDockEff = '';");
  } catch (e) {
    ok('effort lever section', false, e.message);
  }

  console.log('=== PAIN / INJURY FLAG ===');
  try {
    ev('S.pain = [];');
    ev("painAdd('Barbell Bench Press', 2, 'left shoulder front');");
    ok('a flag is recorded', ev('S.pain.length') === 1);
    ok('the flag carries the exercise', ev('S.pain[0].exercise') === 'Barbell Bench Press');
    ok('the flag carries the level', ev('S.pain[0].level') === 2);
    ok('the flag is dated today', ev('S.pain[0].date') === ev('todayKey()'));
    ok('level is clamped to the scale', ev("painAdd('X', 99, '').level") === 3 && ev("painAdd('Y', -4, '').level") === 1);
    ok('notes are length-capped', ev("painAdd('Z', 1, new Array(500).join('q')).note").length === 200);

    ev('S.pain = [];');
    ev("painAdd('Leg Press', 1, '');");
    ok('painFor finds a flag for that lift', ev("painFor('Leg Press', 30).length") === 1);
    ok('painFor does not match a different lift', ev("painFor('Barbell Bench Press', 30).length") === 0);

    // what the agents actually see
    const pc = ev('painContext()');
    ok('agents are told about the flag', pc.indexOf('Leg Press') >= 0, pc.slice(0, 120));
    ok('agents are told it is a report, not a diagnosis', /reported facts, not as a diagnosis/.test(pc));
    ok('agents are told not to give medical advice', /do NOT give medical advice/.test(pc));
    ok('agents are barred from loading a sharply-flagged lift', /Never propose adding load/.test(pc));
    ok('agents are told to point at a professional', /professional look/.test(pc));
    // NOT indexOf('Leg Press'): Leg Press is in the default split, so agContext() contains
    // that string whether or not the pain section is wired in at all.
    ok('the flag reaches the real agent context', ev('agContext()').indexOf('PAIN / INJURY FLAGS') >= 0);
    ok('and carries the flagged lift under that heading',
       /PAIN \/ INJURY FLAGS[\s\S]{0,300}Leg Press/.test(ev('agContext()')));

    // recurrence is the signal worth surfacing
    ev("painAdd('Leg Press', 3, 'knee');");
    ok('repeat flags are counted', /2 flags in 30 days/.test(ev('painContext()')), ev('painContext()').slice(0, 200));
    ok('the worst level is what is reported', /worst = sharp/.test(ev('painContext()')));

    // no flags at all must add nothing to the prompt, not an empty heading
    ev('S.pain = [];');
    ok('no flags means no prompt section', ev('painContext()') === '');
    ok('and no empty heading leaks into agent context', ev('agContext()').indexOf('PAIN / INJURY') < 0);

    // notes are model-visible text and user-supplied, so they must be escaped in the DOM
    ev("painAdd('Barbell Bench Press', 1, '<img src=x onerror=alert(1)>');");
    ev("live = {date:todayKey(), day:'D1', startedAt:Date.now(), exercises:[{name:'Barbell Bench Press', sets:[], done:false, planned:3, lo:8, hi:12, targetW:135, advW:135, advLo:8, advHi:12}], curIdx:0};");
    ev('liveActiveIdx = 0; MODE = "live";');
    const painMarkup = ev("painHTML(live.exercises[0], 0)");
    ok('a flag raised today is shown on the lift', painMarkup.indexOf('Flagged today') >= 0, painMarkup.slice(0, 120));
    ok('the note is escaped, not injected',
       painMarkup.indexOf('<img src=x') < 0 && painMarkup.indexOf('&lt;img') >= 0, painMarkup.slice(0, 200));
    ev("painOpenFor = 0; painDraftLevel = 0;");
    const panel = ev("painHTML({name:'Leg Press'}, 0)");
    ok('the panel offers all three levels', ['niggle','sore','sharp'].every(function(l){ return panel.indexOf(l) >= 0; }));
    ok('the panel says it is a log, not advice', /log, not advice/.test(panel));
    ev("painOpenFor = null; painDraftLevel = 0; S.pain = []; live = null; MODE = 'review';");
  } catch (e) {
    ok('pain flag section', false, e.message);
    ev("S.pain = []; live = null; MODE = 'review'; painOpenFor = null;");
  }

  console.log('=== SUBAGENT SPLIT: FOUR FOCUSED CALLS ===');
  try {
    ev("agState().lastRun=''; agState().proposals=[]; agState().log=[]; agState().status={}; delete agState().brief;");
    ev("S.settings.apiKey = 'sk-test';");
    ev("window.__sysSeen = {};");
    ev("window.__realData3 = callClaudeWithData;");
    ev(`callClaudeWithData = async function(msgs, sys){
          const who = /You are CHARLIE/.test(sys) ? 'charlie'
                    : /You are DELTA/.test(sys)   ? 'delta'
                    : /You are ECHO/.test(sys)    ? 'echo'
                    : 'zulu';
          window.__sysSeen[who] = sys;
          return {text: JSON.stringify({summary: who + ' reporting', brief:'Recovered fine. D1 today. Nothing waiting on you.', proposals:[]}), toolsUsed:0};
        };`);
    await ev('agRunAll(true)');
    const seen = ev('Object.keys(window.__sysSeen).sort().join(",")');
    ok('all four agents were called', seen === 'charlie,delta,echo,zulu', seen);

    // each specialist gets ONLY its own remit and its own fix menu -- the whole point of the
    // split is that CHARLIE is no longer reading DELTA's instructions
    const cSys = ev('window.__sysSeen.charlie'), dSys = ev('window.__sysSeen.delta'), eSys = ev('window.__sysSeen.echo');
    ok('CHARLIE is told it is CHARLIE', cSys.indexOf('You are CHARLIE') >= 0);
    ok('CHARLIE is not handed ECHO\u2019s calorie fix', cSys.indexOf('"type":"cal"') < 0);
    ok('CHARLIE is not handed DELTA\u2019s liftReset', cSys.indexOf('liftReset') < 0);
    ok('DELTA gets liftReset', dSys.indexOf('liftReset') >= 0);
    ok('DELTA is not handed the schedule map', dSys.indexOf('cycleSchedule') < 0);
    ok('ECHO gets the calorie and protein fixes', eSys.indexOf('"type":"cal"') >= 0 && eSys.indexOf('"type":"pro"') >= 0);
    ok('ECHO is not handed deload', eSys.indexOf('"type":"deload"') < 0);
    ok('every specialist is told the tools exist', [cSys, dSys, eSys].every(function(x){ return x.indexOf('get_lift_history') >= 0; }));
    ok('every specialist is told not to claim a change already happened',
       [cSys, dSys, eSys].every(function(x){ return /not.*already made|not.*already changed/i.test(x); }));

    // the lead reads the others rather than re-deriving
    const zSys = ev('window.__sysSeen.zulu');
    ok('ZULU is given what the specialists said', zSys.indexOf('WHAT THE SPECIALISTS REPORTED') >= 0);
    ok('ZULU actually sees their summaries', zSys.indexOf('charlie reporting') >= 0 && zSys.indexOf('echo reporting') >= 0);
    ok('ZULU is told what is already pending', zSys.indexOf('ALREADY WAITING ON HIS APPROVAL') >= 0);

    // all four summaries land
    ok('every agent has a status after the cycle',
       ev("['charlie','delta','echo','zulu'].every(k=>agState().status[k] && agState().status[k].summary)"),
       JSON.stringify(ev('Object.keys(agState().status)')));

    // The brief is NOT written here any more. At 9 PM the recovery score it opens on has not
    // been measured yet, so a night-written brief quotes the wrong day's recovery no matter
    // what morning it is delivered on. It is its own call the next morning -- see the
    // morning-brief section below.
    ok('the nightly cycle writes no brief', ev('agBrief()') === null, JSON.stringify(ev('agState().brief || null')));
    ok('and ZULU is told not to write one here', /Do NOT write a daily brief here/.test(zSys));
    ok('with the reason, so it does not smuggle one into the summary',
       /would be a day out of date/.test(zSys));
    ok('ZULU still knows which day it is reviewing', /THE DAY BEING REVIEWED/.test(zSys));

    ev("callClaudeWithData = window.__realData3;");
  } catch (e) {
    ok('subagent split section', false, e.message);
    ev("if(window.__realData3) callClaudeWithData = window.__realData3;");
  }

  console.log('=== A TRUNCATED REPLY IS A FAILURE, NOT A SUMMARY ===');
  try {
    ev("agState().lastRun=''; agState().proposals=[]; agState().log=[]; agState().status={}; delete agState().brief;");
    ev("S.settings.apiKey = 'sk-test';");
    ev("window.__realData4 = callClaudeWithData;");
    // Exactly what the API returns when adaptive thinking eats max_tokens: stop_reason
    // 'max_tokens' and a body cut off mid-string. parseLooseJSON's last-resort repair closes the
    // unterminated string and the open brace, so WITHOUT the stop_reason check this parses into
    // a perfectly valid object holding half a word -- which is how an 11-character CHARLIE
    // summary, "Today (Wed,", reached the activity log looking like a real report.
    ev(`callClaudeWithData = async function(msgs, sys){
          if(/You are CHARLIE/.test(sys)) return {text:'{"summary":"Today (Wed,', toolsUsed:0, stop:'max_tokens'};
          const who = /You are DELTA/.test(sys) ? 'delta' : /You are ECHO/.test(sys) ? 'echo' : 'zulu';
          return {text: JSON.stringify({summary: who+' reported in full', brief:'All good.', proposals:[]}),
                  toolsUsed:0, stop:'end_turn'};
        };`);
    await ev('agRunAll(true)');

    // the fragment itself must reach nothing
    ok('a truncated fragment never becomes a summary',
       ev("!(agState().status.charlie && agState().status.charlie.summary)"),
       JSON.stringify(ev('agState().status.charlie || null')));
    ok('and never reaches the log as CHARLIE\u2019s words',
       ev("agState().log.every(function(e){ return e.text.indexOf('Today (Wed,') < 0; })"),
       JSON.stringify(ev("agState().log.map(function(e){return e.agent+':'+e.text.slice(0,40);})")));
    // silence and failure must not look the same -- he has to be able to tell that CHARLIE
    // did not report, rather than reading a half sentence as a finding
    ok('CHARLIE is reported as having failed',
       ev("agState().log.some(function(e){ return e.agent==='charlie' && /could not complete/.test(e.text); })"));
    ok('and the reason names the token ceiling',
       ev("agState().log.some(function(e){ return e.agent==='charlie' && /token ceiling/.test(e.text); })"));
    // one agent running out of room must still not cost the other three their night
    ok('the agents that did finish still reported',
       ev("!!(agState().status.delta && agState().status.echo && agState().status.zulu)"),
       JSON.stringify(ev('Object.keys(agState().status)')));

    // the salvage path is still there for the thing it was actually written for
    ok('a merely sloppy reply is still repaired',
       ev(`(function(){ const o = parseLooseJSON('{"summary":"fine",}'); return !!o && o.summary === 'fine'; })()`));
    // and headroom, so the squeeze is rare rather than merely caught
    ok('the nightly ceiling leaves room for a long think', ev('AG_MAXTOK') >= 16000, String(ev('AG_MAXTOK')));
    ok('stop_reason actually survives the tool loop',
       /stop:\s*(data|finalData)\.stop_reason/.test(ev('String(callClaudeWithData)')) ||
       /stop_reason/.test(ev('String(window.__realData4)')));

    ev("callClaudeWithData = window.__realData4;");
    ev("agState().log=[]; agState().status={}; delete agState().brief;");
  } catch (e) {
    ok('truncated reply section', false, e.message);
    ev("if(window.__realData4) callClaudeWithData = window.__realData4;");
  }

  console.log('=== A DROPPED CONNECTION MUST NOT BURN THE NIGHT ===');
  try {
    // Aug 30: CHARLIE, DELTA and ECHO all logged "Failed to fetch" inside the same minute, the
    // finally stamped lastRun anyway, and the night was gone with no retry. A request that never
    // left the device is not a failed check -- it is no check at all, and it is the one failure
    // shape worth attempting again.
    ev("S.settings.apiKey = 'sk-test'; agState().autoRun = true;");
    ev("window.__realDataN = callClaudeWithData;");
    ev("window.__netFail = function(){ callClaudeWithData = async function(){ throw new TypeError('Failed to fetch'); }; };");
    const withHourN = function(h, fn){
      ev("Date.prototype.__realGH2 = Date.prototype.getHours;");
      ev("Date.prototype.getHours = function(){ return " + h + "; };");
      const out = fn();
      ev("Date.prototype.getHours = Date.prototype.__realGH2; delete Date.prototype.__realGH2;");
      return out;
    };
    const reset = "agState().lastRun=''; agState().log=[]; agState().status={}; delete agState().retry; delete agState().brief;";

    // --- classification: what came back vs what never went out ---
    ok('a bare fetch rejection reads as a dropped connection',
       ev("agIsNetworkErr(new TypeError('Failed to fetch'))") === true);
    ok('and so does the Safari/iOS wording for the same thing',
       ev("agIsNetworkErr(new TypeError('Load failed'))") === true);
    // An HTTP error REPLY arrived and will arrive again identically; retrying it only spends
    // money to be told the same thing. Only a request that never completed is worth repeating.
    ok('an API error reply does not', ev("agIsNetworkErr(new Error('API 429: rate limited'))") === false);
    ok('nor does a 500', ev("agIsNetworkErr(new Error('API 500: overloaded'))") === false);
    ok('nor does a truncated reply',
       ev("agIsNetworkErr(new Error('reply hit the 16000-token ceiling before it finished'))") === false);
    // The status prefix has to win over the wording, or an error body that merely mentions a
    // connection gets retried as though nothing had been sent. The API says things like this.
    ok('and an API error is not reclassified by wording inside its body',
       ev("agIsNetworkErr(new Error('API 502: upstream connection reset'))") === false);
    ok('nor by a body that names a network error',
       ev("agIsNetworkErr(new Error('API 503: network error talking to upstream'))") === false);

    // --- attempt 1: the daily gate must stay OPEN ---
    ev(reset); ev("window.__netFail();");
    await ev('agRunAll(false)');
    ok('a network wipeout does not stamp the day',
       ev("agState().lastRun") === '', JSON.stringify(ev('agState().lastRun')));
    ok('and it is counted as attempt 1',
       ev('(agState().retry||{}).n') === 1, JSON.stringify(ev('agState().retry || null')));
    ok('against today, so the budget resets on its own',
       ev("(agState().retry||{}).date === todayKey()"));
    ok('the log says the connection dropped rather than that the check ran',
       ev("agState().log.some(function(e){ return e.agent==='zulu' && /reach the API/.test(e.text); })"),
       JSON.stringify(ev("agState().log.map(function(e){return e.agent+':'+e.text.slice(0,45);})")));
    // The failure that started all this looked like silence. It must never read as an all-clear.
    ok('and never reports a total failure as nothing-to-report',
       ev("agState().log.every(function(e){ return !/nothing needed your attention/.test(e.text); })"));

    // An open gate is worth nothing unless the scheduler actually fires back through it, so
    // assert the real caller re-enters -- not merely that lastRun is falsy.
    ev("window.__ranAgain = 0; window.__realRunAll = agRunAll;");
    ev("agRunAll = function(){ window.__ranAgain++; };");
    withHourN(22, function(){ ev('agMaybeAutoRun()'); });
    ok('the 9 PM scheduler re-fires after a dropped connection', ev('window.__ranAgain') === 1,
       String(ev('window.__ranAgain')));
    ev("agRunAll = window.__realRunAll;");

    // --- the budget is bounded: a dead connection cannot spin all night ---
    ev("window.__netFail();");
    await ev('agRunAll(false)');
    ok('a second wipeout still leaves the day open', ev("agState().lastRun") === '');
    ok('and counts up', ev('(agState().retry||{}).n') === 2, String(ev('(agState().retry||{}).n')));
    ev("agState().log=[];");
    await ev('agRunAll(false)');
    ok('the third attempt is the last, and it closes the day',
       ev("agState().lastRun") === ev('todayKey()'), JSON.stringify(ev('agState().lastRun')));
    ok('the budget is spent, not overrun', ev('(agState().retry||{}).n') === 3, String(ev('(agState().retry||{}).n')));
    ok('and he is told retrying has stopped',
       ev("agState().log.some(function(e){ return /last automatic attempt today/.test(e.text); })"),
       JSON.stringify(ev("agState().log.map(function(e){return e.text.slice(0,45);})")));
    // and now the gate really is shut
    ev("window.__ranAgain = 0; window.__realRunAll = agRunAll; agRunAll = function(){ window.__ranAgain++; };");
    withHourN(22, function(){ ev('agMaybeAutoRun()'); });
    ok('the scheduler stops firing once the budget is spent', ev('window.__ranAgain') === 0);
    ev("agRunAll = window.__realRunAll;");

    // --- a genuine failure still burns the day, exactly as before ---
    ev(reset);
    ev("callClaudeWithData = async function(){ throw new Error('API 500: overloaded'); };");
    await ev('agRunAll(false)');
    ok('an API-error wipeout closes the day immediately',
       ev("agState().lastRun") === ev('todayKey()'), JSON.stringify(ev('agState().lastRun')));
    ok('and opens no retry budget', ev("!agState().retry"), JSON.stringify(ev('agState().retry || null')));
    ok('and keeps the original wording', ev("agState().log.some(function(e){ return /no retry today/.test(e.text); })"));

    // --- mixed causes are NOT retryable ---
    // If even one agent reached the API, the connection was up; the others failed for their own
    // reasons and a retry would just re-run them into the same wall.
    ev(reset);
    ev("callClaudeWithData = async function(msgs, sys){" +
       "  if(/You are CHARLIE/.test(sys)) throw new TypeError('Failed to fetch');" +
       "  throw new Error('API 500: overloaded');" +
       "};");
    await ev('agRunAll(false)');
    ok('a mixed wipeout is not treated as a dropped connection',
       ev("agState().lastRun") === ev('todayKey()'), JSON.stringify(ev('agState().lastRun')));
    ok('and opens no retry budget either', ev("!agState().retry"));

    // --- a partial success is untouched by any of this ---
    ev(reset);
    ev("callClaudeWithData = async function(msgs, sys){" +
       "  if(/You are CHARLIE/.test(sys)) throw new TypeError('Failed to fetch');" +
       "  const who = /You are DELTA/.test(sys) ? 'delta' : /You are ECHO/.test(sys) ? 'echo' : 'zulu';" +
       "  return {text: JSON.stringify({summary: who + ' reported', proposals: []}), toolsUsed: 0, stop: 'end_turn'};" +
       "};");
    await ev('agRunAll(false)');
    ok('one agent losing its connection does not reopen the day for the other two',
       ev("agState().lastRun") === ev('todayKey()'), JSON.stringify(ev('agState().lastRun')));
    ok('and the two that did report are kept',
       ev("!!(agState().status.delta && agState().status.echo)"),
       JSON.stringify(ev('Object.keys(agState().status)')));

    // --- the budget belongs to the day, not to the install ---
    ev("agState().retry = {date: mesoAddDays(todayKey(), -1), n: 3};");
    ok('yesterday’s spent budget does not block tonight',
       ev("agBumpRetry(agState())") === true && ev('(agState().retry||{}).n') === 1 &&
       ev("(agState().retry||{}).date === todayKey()"));
    ok('the retry ceiling is small enough to stay unattended', ev('AG_MAX_RETRIES') <= 5,
       String(ev('AG_MAX_RETRIES')));

    ev("callClaudeWithData = window.__realDataN;");
    ev(reset);
  } catch (e) {
    ok('dropped connection section', false, e.message);
    ev("if(window.__realRunAll) agRunAll = window.__realRunAll;");
    ev("if(window.__realDataN) callClaudeWithData = window.__realDataN;");
  }

  console.log('=== THE MORNING BRIEF IS ITS OWN CALL, AFTER WHOOP ===');
  try {
    ev("S.settings.apiKey = 'sk-test';");
    ev("agState().autoRun = true; agState().log = []; delete agState().brief;");
    ev("agState().status = {charlie:{summary:'schedule clean', at:new Date().toISOString()}," +
       "delta:{summary:'lat pulldown oscillating', at:new Date().toISOString()}," +
       "echo:{summary:'bodyweight flat at 158', at:new Date().toISOString()}};");
    ev("window.__realDataB = callClaudeWithData;");
    ev("window.__briefCalls = 0; window.__briefSys = '';");
    ev(`callClaudeWithData = async function(msgs, sys){
          window.__briefCalls++; window.__briefSys = sys;
          return {text: JSON.stringify({brief:'94% recovery this morning. D3 legs, go.'}),
                  toolsUsed:0, stop:'end_turn'};
        };`);
    const withHour = function(h, fn){
      ev("Date.prototype.__realGetHours = Date.prototype.getHours;");
      ev("Date.prototype.getHours = function(){ return " + h + "; };");
      const out = fn();
      ev("Date.prototype.getHours = Date.prototype.__realGetHours; delete Date.prototype.__realGetHours;");
      return out;
    };
    const noWhoop    = "delete S.whoop;";
    const whoopToday = "S.whoop = {recovery:{date:todayKey(), score:94, hrv:121, rhr:57}, sleep:{date:todayKey(), hours:7.9, performance:90}};";
    const staleWhoop = "S.whoop = {recovery:{date: mesoAddDays(todayKey(),-1), score:71, hrv:99, rhr:61}};";

    // --- the gate ---
    // The hour floor has to be tested with WHOOP ALREADY PRESENT, or the WHOOP gate below is
    // what stops the call and this assertion passes with the floor deleted (it did).
    ev(whoopToday); ev('window.__briefCalls = 0;');
    withHour(4, function(){ ev('agMaybeMorningBrief()'); });
    ok('nothing is written before the morning window opens, even with WHOOP in hand',
       ev('window.__briefCalls') === 0);

    // ...and the same with the LATE bound. Opening the app at 9 PM on a day he never opened it
    // must not spend a call writing "this morning" about a morning that is long gone.
    withHour(21, function(){ ev('agMaybeMorningBrief()'); });
    ok('and nothing is auto-written in the evening either', ev('window.__briefCalls') === 0);

    ev(noWhoop);
    withHour(7, function(){ ev('agMaybeMorningBrief()'); });
    ok('and nothing is written while WHOOP has not reported yet', ev('window.__briefCalls') === 0);

    ev(staleWhoop);
    withHour(7, function(){ ev('agMaybeMorningBrief()'); });
    ok('yesterday’s recovery does not count as WHOOP having reported', ev('window.__briefCalls') === 0);

    // past the cutoff a brief is written anyway -- a day WHOOP never reports still gets one
    // awaited: agMaybeMorningBrief() returns the write, and leaving it in flight would leave
    // _agBriefRunning set and make the NEXT gate assertion pass for the wrong reason
    await withHour(11, function(){ return ev('agMaybeMorningBrief()'); });
    ok('past the cutoff it stops waiting and writes one', ev('window.__briefCalls') === 1);
    ok('and with no recovery it is told not to invent one',
       /has not reported a recovery score for today/.test(ev('window.__briefSys')));
    ok('and not to pass off an older one as this morning’s',
       /not quote an older one/.test(ev('window.__briefSys')));

    // --- WHOOP lands AFTER a cutoff-forced write: the brief and the strip must reconcile ---
    // The brief above just went out with no recovery line because the cutoff forced it. If
    // WHOOP reports a few hours later, the status strip starts showing a number while the
    // brief he already read still says nothing landed -- the split Mark hit in practice
    // (recovery showing up around 1pm with an unrelated brief from earlier). One rewrite
    // should close that gap, and only once.
    ev(whoopToday); ev('window.__briefCalls = 0;');
    await withHour(13, function(){ return ev('agMaybeMorningBrief()'); });
    ok('once WHOOP lands later the same day, the WHOOP-less brief is rewritten',
       ev('window.__briefCalls') === 1);
    ok('and the rewrite carries this morning’s measured numbers',
       /WHOOP TODAY: recovery 94%/.test(ev('window.__briefSys')));
    ok('and the stored brief is now marked as having WHOOP',
       ev('agState().brief.hadWhoop') === true);

    ev('window.__briefCalls = 0;');
    await withHour(14, function(){ return ev('agMaybeMorningBrief()'); });
    ok('and it does not rewrite again once WHOOP is already reflected',
       ev('window.__briefCalls') === 0);

    // --- the normal path ---
    ev("delete agState().brief;"); ev(whoopToday); ev('window.__briefCalls = 0;');
    await withHour(7, function(){ return ev('agMaybeMorningBrief()'); });
    ok('once WHOOP has reported for today, the brief is written', ev('window.__briefCalls') === 1);
    ok('and it is handed this morning’s measured numbers',
       /WHOOP TODAY: recovery 94%/.test(ev('window.__briefSys')), ev('window.__briefSys').slice(0, 0));
    ok('and told they are today’s, not to be hedged as stale',
       /taken this morning/.test(ev('window.__briefSys')));
    ok('and given what the specialists found last night',
       /WHAT THE SPECIALISTS FOUND LAST NIGHT/.test(ev('window.__briefSys')) &&
       ev('window.__briefSys').indexOf('bodyweight flat at 158') >= 0);
    ok('and today’s schedule', /TODAY IS: /.test(ev('window.__briefSys')));
    ok('and what is waiting on him', /WAITING ON HIS APPROVAL/.test(ev('window.__briefSys')));

    await ev('agRunBrief(true)');
    ok('the brief is stored', ev('!!agBrief()'));
    ok('stamped for the morning it was written on', ev('agBrief().date') === ev('todayKey()'));
    ok('and is live on the dashboard immediately', ev('agBriefToday() && agBriefToday().text').indexOf('94% recovery') >= 0);
    ev('renderHome()');
    ok('the dashboard paints it', w.document.getElementById('home').innerHTML.indexOf('94% recovery this morning') >= 0);
    ok('and it fires the notification',
       ev("notifItems().some(function(i){ return i.title === 'Daily brief'; })") === true);

    // --- it runs once a day, and only when he wants it to ---
    ev('window.__briefCalls = 0;');
    withHour(8, function(){ ev('agMaybeMorningBrief()'); });
    ok('a brief already written this morning is not rewritten', ev('window.__briefCalls') === 0);

    ev("delete agState().brief; agState().autoRun = false;");
    withHour(8, function(){ ev('agMaybeMorningBrief()'); });
    ok('auto-run off suppresses the morning call too', ev('window.__briefCalls') === 0);
    ev("agState().autoRun = true;");

    // --- a squeezed reply must not land as a brief ---
    ev("delete agState().brief; agState().log = [];");
    ev(`callClaudeWithData = async function(){
          return {text:'{"brief":"94% recovery this morn', toolsUsed:0, stop:'max_tokens'};
        };`);
    await ev('agRunBrief(true)');
    ok('a truncated brief is discarded, not stored', ev('agBrief()') === null,
       JSON.stringify(ev('agState().brief || null')));
    ok('and the failure is logged against ZULU',
       ev("agState().log.some(function(e){ return e.agent==='zulu' && /token ceiling/.test(e.text); })"),
       JSON.stringify(ev("agState().log.map(function(e){return e.agent+':'+e.text.slice(0,60);})")));

    // the manual button is him asking on purpose, so it ignores every clock gate
    ev("delete agState().brief; agState().log = [];"); ev(whoopToday); ev('window.__briefCalls = 0;');
    ev(`callClaudeWithData = async function(){
          window.__briefCalls++;
          return {text: JSON.stringify({brief:'written on demand'}), toolsUsed:0, stop:'end_turn'};
        };`);
    await withHour(23, function(){ return ev('agRunBrief(true)'); });
    ok('the manual button writes one at any hour', ev('window.__briefCalls') === 1);
    ok('and it lands as today’s brief', ev('agBriefToday() && agBriefToday().text') === 'written on demand');

    // --- the leftover the OLD path left in his saved state ---
    // A 9 PM brief stamped for the next morning would otherwise sit there and BLOCK the first
    // real morning call, so he would read the stale one instead of the fix.
    // The shape that actually bites: written at 9 PM YESTERDAY, stamped for this morning. On
    // the morning it names it satisfies `b.date === todayKey()`, so unpruned it makes
    // agMaybeMorningBrief() decide the morning is already handled and he reads the stale one.
    const leftover = "S.agents.brief = {text:'written at 9pm last night', date: todayKey(), " +
      "at: (function(){ var d=new Date(); d.setDate(d.getDate()-1); d.setHours(21,0,0,0); return d.toISOString(); })()};";
    ev("delete agState().brief;"); ev(leftover);
    ok('a night-written brief is dropped on first touch', ev('agState().brief') === undefined,
       JSON.stringify(ev('S.agents.brief || null')));
    ev(whoopToday); ev('window.__briefCalls = 0;');
    ev(`callClaudeWithData = async function(){
          window.__briefCalls++;
          return {text: JSON.stringify({brief:'fresh morning brief'}), toolsUsed:0, stop:'end_turn'};
        };`);
    // put the leftover straight back on S, WITHOUT going through agState(), so the prune is the
    // only thing that can clear it -- deleting it here first would let this pass unpruned
    ev(leftover);
    await withHour(7, function(){ return ev('agMaybeMorningBrief()'); });
    ok('so the morning call is no longer blocked by it', ev('window.__briefCalls') === 1,
       'calls=' + ev('window.__briefCalls'));
    ok('and what he reads is the fresh one', ev('agBriefToday() && agBriefToday().text') === 'fresh morning brief');

    // ...and a brief written THIS morning survives, including when UTC has already rolled over
    // to the next day. `at` is UTC and `date` is local, so a raw string compare would bin it.
    ev("delete agState().brief;");
    ev("(function(){ var d=new Date(); d.setHours(23,30,0,0); S.agents.brief = {text:'late but todays', date: todayKey(), at: d.toISOString()}; })();");
    ok('a same-local-day brief survives even when UTC has rolled over',
       ev('agState().brief && agState().brief.text') === 'late but todays',
       JSON.stringify(ev('S.agents.brief || null')));

    ev("callClaudeWithData = window.__realDataB;");
    ev("delete agState().brief; agState().log = []; agState().status = {}; delete S.whoop;");
  } catch (e) {
    ok('morning brief section', false, e.message);
    ev("if(window.__realDataB) callClaudeWithData = window.__realDataB;");
    ev("if(Date.prototype.__realGetHours){ Date.prototype.getHours = Date.prototype.__realGetHours; delete Date.prototype.__realGetHours; }");
  }

  console.log('=== DAILY BRIEF + WEEKLY LETTER ===');
  try {
    // The letter is weekly, gated on the day of week, so this cannot be written against
    // "today" -- on six days out of seven that assertion would be vacuously true. Drive
    // agLetterDue() through a controlled clock instead.
    ev("window.__realDate = Date;");
    const withDay = function(dow, fn){
      // pin getDay() without disturbing anything else Date is used for
      ev("Date.prototype.__realGetDay = Date.prototype.getDay;");
      ev("Date.prototype.getDay = function(){ return " + dow + "; };");
      const out = fn();
      ev("Date.prototype.getDay = Date.prototype.__realGetDay; delete Date.prototype.__realGetDay;");
      return out;
    };
    ev("delete agState().letter;");
    ok('no letter is due midweek', withDay(3, function(){ return ev('agLetterDue()'); }) === false);
    ok('a letter IS due on Sunday', withDay(0, function(){ return ev('agLetterDue()'); }) === true);
    withDay(0, function(){ ev("agSetLetter('a letter about the week');"); });
    ok('the letter is stored with its week',
       ev('agLetter().week') === withDay(0, function(){ return ev('weekStartKey(todayKey())'); }),
       ev('agLetter().week'));
    ok('a second letter is not due the same week',
       withDay(0, function(){ return ev('agLetterDue()'); }) === false);

    // both surfaces render, and the brief renders as text he would actually read
    ev("agSetBrief('Recovered well. D3 today. Nothing waiting on you.');");
    ev('renderOps()');
    const opsHTML = w.document.getElementById('ops').innerHTML;
    ok('the daily brief is rendered', opsHTML.indexOf('DAILY BRIEF') >= 0);
    ok('the brief text is rendered', opsHTML.indexOf('Nothing waiting on you') >= 0);
    ok('the weekly letter is rendered', opsHTML.indexOf('a letter about the week') >= 0);
    ok('the letter is collapsible rather than dominating the tab',
       opsHTML.indexOf('Weekly letter') >= 0 && /class="sub"[\s\S]{0,400}Weekly letter/.test(opsHTML),
       opsHTML.slice(opsHTML.indexOf('Weekly letter') - 120, opsHTML.indexOf('Weekly letter') + 40));

    // a new brief must make the Ops tab actually repaint, or he would never see it arrive
    ev('_opsSig = opsSignature();');
    const sigBefore = ev('opsSignature()');
    ev("agSetBrief('a different brief');");
    ok('a new brief changes the ops signature', ev('opsSignature()') !== sigBefore);
    const sigMid = ev('opsSignature()');
    ev("agSetLetter('a different letter');");
    ok('a new letter changes the ops signature', ev('opsSignature()') !== sigMid);

    // model output is escaped on the way into the DOM
    ev("agSetBrief('<img src=x onerror=alert(1)>');");
    ev('renderOps()');
    const esc1 = w.document.getElementById('ops').innerHTML;
    ok('brief text is escaped, not injected', esc1.indexOf('<img src=x') < 0 && esc1.indexOf('&lt;img') >= 0);
    ev("agSetLetter('<script>bad()<\\/script>');");
    ev('renderOps()');
    const esc2 = w.document.getElementById('ops').innerHTML;
    ok('letter text is escaped, not injected', esc2.indexOf('<script>bad()') < 0);

    ev("delete agState().letter; delete agState().brief;");
  } catch (e) {
    ok('brief + letter section', false, e.message);
    ev("if(Date.prototype.__realGetDay){ Date.prototype.getDay = Date.prototype.__realGetDay; delete Date.prototype.__realGetDay; }");
  }

  console.log('=== AGENTS SEE EVERY SESSION, AND SEE IT STRAIGHT ===');
  try {
    const savedLogsD = ev('JSON.stringify(S.logs)');
    const savedWD    = ev('JSON.stringify(S.weights)');
    const savedND    = ev('JSON.stringify(S.nutrition)');
    const savedSpD   = ev('JSON.stringify(S.split)');
    const EXD = 'Barbell Bench Press';

    // Three normal sessions and then a DELOAD as the NEWEST one -- his actual shape on
    // 2026-08-27, where the two most recent training days were both inside a deload window.
    ev("S.logs = S.logs.concat([" +
       "{date: mesoAddDays(todayKey(),-9), day:'D1', entries:[{exercise:'" + EXD + "', sets:[{w:185,r:5},{w:185,r:5}]}]}," +
       "{date: mesoAddDays(todayKey(),-6), day:'D1', entries:[{exercise:'" + EXD + "', sets:[{w:190,r:5},{w:190,r:5}]}]}," +
       "{date: mesoAddDays(todayKey(),-3), day:'D1', entries:[{exercise:'" + EXD + "', sets:[{w:195,r:5},{w:195,r:5}]}]}," +
       "{date: mesoAddDays(todayKey(),-1), day:'D1', deload:true, entries:[{exercise:'" + EXD + "', sets:[{w:135,r:8}]}]}" +
       "]);");
    const dlDate = ev("mesoAddDays(todayKey(),-1)");

    // --- the tool must show it ---
    const histD = ev("agRunDataTool('get_lift_history',{exercise:'" + EXD + "'})");
    ok('get_lift_history returns the deload session it used to drop',
       histD.indexOf(dlDate) >= 0, histD.slice(0, 220));
    ok('and labels it so a light day does not read as a collapse',
       /DELOAD week/.test(histD), histD.slice(0, 220));
    ok('list_lifts reports the deload day as the last time he trained the lift',
       ev("agRunDataTool('list_lifts')").split('\n').filter(function(l){ return l.indexOf(EXD) === 0; })[0].indexOf('last ' + dlDate) >= 0,
       ev("agRunDataTool('list_lifts')").split('\n').filter(function(l){ return l.indexOf(EXD) === 0; })[0]);

    // --- but the recommendation engine must be untouched: a deload never sets the next target ---
    ok('historyFor() still hides deloads from the recommendation engine',
       ev("historyFor('" + EXD + "').some(function(h){ return h.date === '" + dlDate + "'; })") === false);
    ok('and includeDeload is what changes that, nothing else',
       ev("historyFor('" + EXD + "', {includeDeload:true}).length") ===
       ev("historyFor('" + EXD + "').length") + 1);

    // --- the e1RM trend still excludes them (every chart agrees), but SAYS so ---
    ok('e1rmSeries keeps deload points out of the strength trend',
       ev("e1rmSeries('" + EXD + "').some(function(pt){ return pt.date === '" + dlDate + "'; })") === false);
    const serD = ev("agRunDataTool('get_e1rm_series',{exercise:'" + EXD + "'})");
    ok('and the tool names the excluded dates instead of leaving a silent gap',
       serD.indexOf('Excluded from this trend') >= 0 && serD.indexOf(dlDate) >= 0, serD.slice(-200));

    // --- an estimate must not arrive looking like a measurement ---
    ev("S.nutrition = S.nutrition.concat([{date: mesoAddDays(todayKey(),-2), cals:3200, protein:150, est:true}]);");
    const nutD = ev("agRunDataTool('get_nutrition',{days:5})");
    ok('get_nutrition marks a tapped-range estimate as an estimate',
       /~3200 cal/.test(nutD) && /~150g/.test(nutD), nutD.slice(0, 240));
    ok('and says what the marker means', /bucket midpoint/.test(nutD));

    // --- the athlete profile is derived, not written down ---
    ev("S.weights = [{date: mesoAddDays(todayKey(),-1), lbs: 158.8}];");
    ev("S.split.D3.name = 'Legs + Abs (Leg Press)'; S.split.D6.name = 'Legs + Abs (Squat)';");
    const tcD = ev('trainingContext()');
    ok('the profile quotes his real weigh-in', /158\.8 lb \(weighed /.test(tcD),
       tcD.split('\n').filter(function(l){ return l.indexOf('Mark, 18') >= 0; })[0]);
    ok('the stale hardcoded bodyweight is gone', tcD.indexOf('~150 lb') < 0);
    ok('the split line follows the real split',
       tcD.indexOf('D3 Legs + Abs (Leg Press)') >= 0 && tcD.indexOf('D6 Legs + Abs (Squat)') >= 0,
       tcD.split('\n').filter(function(l){ return l.indexOf('Split:') >= 0; })[0]);
    ok('the inverted hardcoded split description is gone',
       tcD.indexOf('D3 Legs squat-focus') < 0 && tcD.indexOf('D6 Legs press-focus') < 0);
    ok('a finished deload is labelled in the recent-sessions block',
       /DELOAD \(intentionally light\)/.test(tcD), tcD.slice(tcD.indexOf('RECENT SESSIONS'), tcD.indexOf('RECENT SESSIONS') + 200));

    ev('S.logs = ' + savedLogsD + '; S.weights = ' + savedWD + '; S.nutrition = ' + savedND + '; S.split = ' + savedSpD + ';');
  } catch (e) {
    ok('agents see every session section', false, e.message);
  }

  console.log('=== DATA TOOLS ARE READ-ONLY ===');
  try {
    const defs = ev('agDataToolDefs()');
    ok('data tools are defined', Array.isArray(defs) && defs.length >= 6, 'n=' + (defs && defs.length));
    const dataNames = defs.map(function(d){ return d.name; });
    ok('every data tool name reads rather than writes',
       dataNames.every(function(n){ return /^(get_|list_)/.test(n); }), dataNames.join(','));
    // the mutating tool set is the coach's, and the two must not overlap
    const writeNames = ev('coachToolDefs()').map(function(d){ return d.name; });
    ok('no data tool shares a name with a mutating tool',
       dataNames.every(function(n){ return writeNames.indexOf(n) < 0; }), dataNames.join(','));

    // THE assertion: running every one of them changes nothing. agApplyFix() is the only
    // place a proposal may touch state, and these deliberately sit outside that path.
    const before = ev('JSON.stringify(S)');
    dataNames.forEach(function(n){
      ev("window.__tn = " + JSON.stringify(n) + ";");
      ev("agRunDataTool(window.__tn, {exercise:'Barbell Bench Press', days:9999, weeks:9999, limit:9999, weeksAgo:0})");
    });
    ok('no data tool mutated any state', ev('JSON.stringify(S)') === before);
    // and an unknown tool name is refused rather than ignored
    ok('an unknown tool name is refused',
       /Unknown tool/.test(ev("agRunDataTool('delete_everything', {})")));
    // a tool that throws must hand back an error string, not take the cycle down
    ok('a throwing tool returns an error string instead of propagating',
       typeof ev("agRunDataTool('get_weekly_volume', {weeksAgo:'nonsense'})") === 'string');

    // the loop has a hard ceiling -- unattended at 9pm, an unbounded loop is an unbounded bill
    ok('tool rounds are capped', ev('AI_TOOL_ROUNDS') > 0 && ev('AI_TOOL_ROUNDS') <= 10, String(ev('AI_TOOL_ROUNDS')));
    ok('tool results are size-capped', ev('AI_TOOL_MAXCHARS') > 0 && ev('AI_TOOL_MAXCHARS') <= 20000, String(ev('AI_TOOL_MAXCHARS')));

    ev("window.__reqs = 0; window.__realReq = aiRequest;");
    ev(`aiRequest = async function(){
          window.__reqs++;
          return {stop_reason:'tool_use', content:[{type:'tool_use', id:'t'+window.__reqs, name:'list_lifts', input:{}}]};
        };`);
    await ev("callClaudeWithData([{role:'user',content:'go'}], 'sys', 100, {})");
    ok('a model that never stops calling tools is cut off',
       ev('window.__reqs') === ev('AI_TOOL_ROUNDS') + 1,
       'requests=' + ev('window.__reqs') + ' cap=' + ev('AI_TOOL_ROUNDS'));
    ev("aiRequest = window.__realReq;");

    // a long result is truncated rather than flooding context
    ev("window.__realRun2b = agRunDataTool;");
    ev("agRunDataTool = function(){ return new Array(50000).join('x'); };");
    ev("window.__reqs2 = 0; window.__realReq2 = aiRequest; window.__lastMsgs = null;");
    ev(`aiRequest = async function(msgs){
          window.__reqs2++;
          window.__lastMsgs = msgs;
          if(window.__reqs2 === 1) return {stop_reason:'tool_use', content:[{type:'tool_use', id:'t1', name:'list_lifts', input:{}}]};
          return {stop_reason:'end_turn', content:[{type:'text', text:'done'}]};
        };`);
    await ev("callClaudeWithData([{role:'user',content:'go'}], 'sys', 100, {})");
    const passed = ev("window.__lastMsgs[window.__lastMsgs.length-1].content[0].content");
    ok('an oversized tool result is truncated before it reaches the model',
       passed.length <= ev('AI_TOOL_MAXCHARS') + 40, 'len=' + passed.length);
    ev("agRunDataTool = window.__realRun2b; aiRequest = window.__realReq2;");
  } catch (e) {
    ok('data tools section', false, e.message);
    ev("if(window.__realReq) aiRequest = window.__realReq;");
    ev("if(window.__realRun2b) agRunDataTool = window.__realRun2b;");
  }

  console.log('=== INTAKE BUCKETS: TAP A RANGE, TARGETS DRIVE THE VERDICT ===');
  try {
    const savedNut = ev('JSON.stringify(S.nutrition)');
    const savedFuel = ev('JSON.stringify(S.fuel)');
    const reset = () => ev("S.fuel = S.fuel||{}; S.fuel.calTarget = 3000; S.fuel.proTarget = 150;");
    reset();

    // --- tier classification: four tiers for calories, three for protein ---
    ok('calories far under target read way under', ev('nutTierCal(2450)') === 'way', ev('nutTierCal(2450)'));
    ok('calories just under target read under', ev('nutTierCal(2999)') === 'slight', ev('nutTierCal(2999)'));
    ok('calories at target read on target', ev('nutTierCal(3000)') === 'on', ev('nutTierCal(3000)'));
    ok('calories well over target read over', ev('nutTierCal(3400)') === 'over', ev('nutTierCal(3400)'));
    ok('protein far under target reads way under', ev('nutTierPro(105)') === 'way', ev('nutTierPro(105)'));
    ok('protein a little under target reads under', ev('nutTierPro(139)') === 'slight', ev('nutTierPro(139)'));
    ok('protein at target reads on target', ev('nutTierPro(140)') === 'on', ev('nutTierPro(140)'));
    // Protein has a floor, not a ceiling -- there is deliberately no 'over' tier to land in.
    ok('protein far above target still reads on target', ev('nutTierPro(300)') === 'on', ev('nutTierPro(300)'));

    // --- the bug this replaced: the verdict used to be a hardcoded 3000/130 that ignored
    //     whatever the Fuel tab was actually set to. 2700 cal / 115g protein is "below target"
    //     under the old constants and a hit under these targets. ---
    ev("S.fuel.calTarget = 2600; S.fuel.proTarget = 120;");
    ok('the calorie verdict follows the configured target, not a hardcoded 3000',
       ev('nutTierCal(2700)') === 'on', ev('nutTierCal(2700)'));
    ok('the protein verdict follows the configured target, not a hardcoded 130',
       ev('nutTierPro(115)') === 'on', ev('nutTierPro(115)'));
    ok('the ladder re-centres on the configured target', ev("nutBuckets('cal')[0].hi") === 2000,
       'lowEdge=' + ev("nutBuckets('cal')[0].hi"));
    reset();
    ok('and re-centres back when the target moves back', ev("nutBuckets('cal')[0].hi") === 2400,
       'lowEdge=' + ev("nutBuckets('cal')[0].hi"));

    // --- ladder shape ---
    ok('calorie ladder is seven buckets', ev("nutBuckets('cal').length") === 7, 'n=' + ev("nutBuckets('cal').length"));
    ok('protein ladder is eight buckets', ev("nutBuckets('pro').length") === 8, 'n=' + ev("nutBuckets('pro').length"));
    // The invariant that keeps a pill's colour and the history badge it produces in agreement:
    // both come from the same two classifiers, so a bucket must classify as its own tier.
    ok('every calorie bucket midpoint classifies as that bucket’s own tier',
       ev("nutBuckets('cal').every(b=>nutTierCal(b.mid)===b.tier)"));
    ok('every protein bucket midpoint classifies as that bucket’s own tier',
       ev("nutBuckets('pro').every(b=>nutTierPro(b.mid)===b.tier)"));
    ok('the target is a bucket boundary, so no bucket straddles the verdict line',
       ev("nutBuckets('cal').some(b=>b.lo===calTarget()) && nutBuckets('pro').some(b=>b.lo===proTarget())"));
    ok('the calorie ladder offers all four tiers',
       ev("[...new Set(nutBuckets('cal').map(b=>b.tier))].sort().join(',')") === 'on,over,slight,way',
       ev("[...new Set(nutBuckets('cal').map(b=>b.tier))].sort().join(',')"));
    ok('the protein ladder never offers an over bucket',
       ev("nutBuckets('pro').every(b=>b.tier!=='over')"));

    // --- round trip: tap a range, log it, read the badge back ---
    ev("S.nutrition = []; nutExact = false; nutPick = {cal:null, pro:null};");
    ev('renderBulk')();
    ok('the ladder renders as tappable pills',
       ev("document.querySelectorAll('#bulk .nut-pill').length") === 15,
       'n=' + ev("document.querySelectorAll('#bulk .nut-pill').length"));
    ev(`(function(){
          var g = document.querySelectorAll('#bulk .nut-grp');
          g[0].querySelectorAll('.nut-pill')[4].click();
          g[1].querySelectorAll('.nut-pill')[6].click();
        })()`);
    ok('tapping a range records its midpoint',
       ev('nutPick.cal') === 3100 && ev('nutPick.pro') === 155,
       'cal=' + ev('nutPick.cal') + ' pro=' + ev('nutPick.pro'));
    ok('only the tapped pill is marked selected in its row',
       ev("document.querySelectorAll('#bulk .nut-grp')[0].querySelectorAll('.nut-pill.sel').length") === 1);
    ev("document.getElementById('nDate').value = '2026-02-10';");
    ev('addNutrition')();
    const tapped = ev("S.nutrition.find(n=>n.date==='2026-02-10')");
    ok('logging stores the tapped midpoints', tapped && tapped.cals === 3100 && tapped.protein === 155,
       JSON.stringify(tapped));
    ok('a tapped entry is marked an estimate', tapped && tapped.est === true, JSON.stringify(tapped));
    ok('the selection clears after logging so the next day starts blank',
       ev('nutPick.cal') === null && ev('nutPick.pro') === null);

    // --- the exact-entry escape hatch ---
    ev("nutExact = true;");
    ev('renderBulk')();
    ok('exact mode swaps the ladder for number inputs',
       !!w.document.getElementById('nCals') && !w.document.querySelector('#bulk .nut-pill'));
    ev("document.getElementById('nDate').value='2026-02-11';" +
       "document.getElementById('nCals').value='3123'; document.getElementById('nProt').value='161';");
    ev('addNutrition')();
    const exact = ev("S.nutrition.find(n=>n.date==='2026-02-11')");
    ok('exact entry stores the typed number', exact && exact.cals === 3123 && exact.protein === 161,
       JSON.stringify(exact));
    ok('an exactly-typed entry is not marked an estimate', exact && exact.est === undefined,
       JSON.stringify(exact));
    ev("nutExact = false;");

    // --- history badges are per-macro and follow the configured target ---
    ev("S.fuel.calTarget = 2600; S.fuel.proTarget = 120;");
    ev("S.nutrition = [{date:'2026-01-05', cals:2700, protein:125}];");
    ev('renderBulk')();
    let out = w.document.getElementById('bulk').innerHTML;
    ok('a day clearing the configured target shows a hit badge on both macros',
       (out.match(/nut-badge[^>]*var\(--good\)[^>]*>✓/g) || []).length === 2,
       'hits=' + (out.match(/nut-badge[^>]*var\(--good\)[^>]*>✓/g) || []).length);
    ok('the old single below-target label is gone', out.indexOf('below target') === -1);
    // Same day, stricter targets: what read as a hit now reads as a miss on both macros.
    reset();
    ev('renderBulk')();
    out = w.document.getElementById('bulk').innerHTML;
    ok('tightening the target flips the same day from a hit to under on both macros',
       (out.match(/nut-badge[^>]*var\(--warn\)[^>]*>under/g) || []).length === 2,
       'under=' + (out.match(/nut-badge[^>]*var\(--warn\)[^>]*>under/g) || []).length);
    // The two macros must be able to disagree. The old AND-ed check-mark collapsed a day that
    // hit calories and badly missed protein into the same "below target" as missing both.
    ev("S.nutrition = [{date:'2026-01-06', cals:3100, protein:105}];");
    ev('renderBulk')();
    out = w.document.getElementById('bulk').innerHTML;
    ok('calories can read on target while protein reads way under, on the same row',
       /nut-badge[^>]*var\(--good\)[^>]*>✓/.test(out) &&
       /nut-badge[^>]*var\(--bad\)[^>]*>way under/.test(out));

    // --- weekly rollup ---
    const dk = n => ev("dateKeyOf(new Date(Date.now()-" + n + "*86400000))");
    ev("S.nutrition = [" +
       "{date:'" + dk(1) + "', cals:3100, protein:155}," +   // both on      -> hit
       "{date:'" + dk(2) + "', cals:3100, protein:120}," +   // protein under -> miss
       "{date:'" + dk(3) + "', cals:2500, protein:155}," +   // cal way under -> miss
       "{date:'" + dk(4) + "', cals:3500, protein:160}]");   // cal over, pro on -> hit
    const wk = ev('nutWeekCard')();
    ok('the weekly card counts only days clearing both macros', wk.indexOf('>2/4<') >= 0, wk.slice(0, 300));
    ok('the weekly card averages the week rather than quoting the last day',
       wk.indexOf('>148g<') >= 0, wk.slice(0, 300));
    ok('a day over the calorie target still counts as fed',
       ev("nutTierCal(3500)") === 'over' && wk.indexOf('>2/4<') >= 0);
    ev("S.nutrition = [{date:'" + dk(1) + "', cals:2400, protein:100}]");
    ok('a way-under week says so plainly rather than just failing a check',
       /surplus itself missing/.test(ev('nutWeekCard')()), ev('nutWeekCard')().slice(0, 300));
    ok('the weekly card stays silent with nothing logged',
       ev("(function(){var s=S.nutrition; S.nutrition=[]; var r=nutWeekCard(); S.nutrition=s; return r;})()") === '');

    // --- the agent context quotes the configured target, not the old constants ---
    ev("S.fuel.calTarget = 2800; S.fuel.proTarget = 165;");
    const tctx = ev('trainingContext')();
    ok('trainingContext quotes the configured nutrition target',
       tctx.indexOf('2800+ cal, 165g+ protein') >= 0,
       (tctx.match(/Nutrition target:[^\n]*/) || [''])[0]);
    ev("S.nutrition = [{date:'2026-03-01', cals:3100, protein:150, est:true}]");
    ok('an estimated entry reaches the model marked as an estimate',
       /~3100 cal \/ ~150g protein/.test(ev('trainingContext')()),
       (ev('trainingContext')().match(/NUTRITION LOG:[^\n]*/) || [''])[0]);

    // Fixtures must not leak into later sections.
    ev("S.nutrition = " + savedNut + "; S.fuel = " + savedFuel + "; nutExact = false; nutPick = {cal:null, pro:null};");
  } catch (e) {
    ok('intake buckets section', false, e.message);
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

  /* A snapshot can reach the gist long after it was built: a push fired as the tab is
     backgrounded gets frozen with the request in flight and lands when the app is next
     foregrounded. Observed in the wild once, at 808 minutes of delivery lag: it reverted the
     cloud copy to the previous night and destroyed that morning's weigh-in.
     Measuring this needs care. The WHOOP relay PATCHes whoop_data.json into the same gist, and
     that creates a revision in which ironhub_data.json is carried forward untouched -- so its
     exportedAt looks hours stale and the revision reads as a big lag that never happened. Lag
     alone is not the signal; only a revision where ironhub_data.json actually CHANGED counts.
     Whole-snapshot last-writer-wins cannot distinguish "the writer has not heard about this
     record yet" from "some device deleted this record"; the per-record write stamp can. */
  console.log('=== SYNC: A STALE SNAPSHOT CANNOT DELETE NEWER RECORDS ===');
  const syncSaved = ev('JSON.stringify(S)');
  try {
    const T_STALE = 1787900000000;              // the instant the incoming snapshot was exported
    const NEWER   = T_STALE + 60 * 60 * 1000;   // written an hour AFTER it - writer never saw this
    const OLDER   = T_STALE - 60 * 60 * 1000;   // written an hour BEFORE it - absence means deleted

    ev('S.weights = ' + JSON.stringify([
      { date: '2026-08-26', lbs: 158.6, t: OLDER },  // older than snapshot -> deliberately deleted
      { date: '2026-08-27', lbs: 158.8 },            // legacy, unstamped   -> treated as old
      { date: '2026-08-28', lbs: 159,   t: NEWER }   // the weigh-in that was lost for real
    ]) + ';');
    ev('S.logs = ' + JSON.stringify([
      { id: 111, date: '2026-08-28', day: 'D1', entries: [], t: NEWER }
    ]) + ';');
    // Pain is flagged mid-workout on the phone, which is exactly when this bug bites.
    ev('S.pain = ' + JSON.stringify([
      { id: 'pnNEW', date: '2026-08-28', exercise: 'Barbell Bench Press', level: 2, note: '', t: NEWER },
      { id: 'pnOLD', date: '2026-08-20', exercise: 'Barbell Back Squat',  level: 1, note: '', t: OLDER }
    ]) + ';');
    ev('S.meta = { changedAt: ' + (T_STALE - 1000) + ', lastSync: 0, pushedAt: ' + (T_STALE - 1000) + ' };');

    const stale = JSON.parse(ev('JSON.stringify(S)'));
    stale.weights = [{ date: '2026-08-25', lbs: 157, t: OLDER }];
    stale.logs = [];
    stale.pain = [];
    stale.meta = { changedAt: T_STALE - 5000, lastSync: 0, pushedAt: 0 };
    ev('window.__stale = ' + JSON.stringify(stale) + ';');
    ev('applyPulled(window.__stale, ' + T_STALE + ');');

    const wOut = JSON.parse(ev('JSON.stringify(S.weights)'));
    const dates = wOut.map(x => x.date);
    const painIds = JSON.parse(ev('JSON.stringify(S.pain)')).map(p => p.id);
    ok('newer-than-snapshot weigh-in survives the pull', dates.indexOf('2026-08-28') >= 0, dates.join(','));
    ok('...with its value intact', (wOut.find(x => x.date === '2026-08-28') || {}).lbs === 159);
    ok('newer-than-snapshot log survives the pull',
       JSON.parse(ev('JSON.stringify(S.logs)')).some(l => l.id === 111));
    ok('newer-than-snapshot pain flag survives the pull', painIds.indexOf('pnNEW') >= 0, painIds.join(','));
    ok('records from the snapshot itself still land', dates.indexOf('2026-08-25') >= 0, dates.join(','));
    ok('older-than-snapshot record stays deleted (no resurrection)',
       dates.indexOf('2026-08-26') === -1, dates.join(','));
    ok('unstamped legacy record stays deleted (no resurrection)',
       dates.indexOf('2026-08-27') === -1, dates.join(','));
    ok('older-than-snapshot pain flag stays deleted', painIds.indexOf('pnOLD') === -1, painIds.join(','));
    ok('merged weights stay chronological', dates.join(',') === [...dates].sort().join(','), dates.join(','));
    ok('recovery marks state unpushed so the union reaches the gist',
       ev('S.meta.pushedAt') < ev('S.meta.changedAt'),
       ev('S.meta.pushedAt') + ' vs ' + ev('S.meta.changedAt'));

    // A pull with nothing local to recover must NOT flag the state as unpushed, or every pull
    // would re-upload exactly what it just downloaded.
    ev('S.weights = []; S.logs = []; S.readiness = []; S.nutrition = []; S.pain = []; S.prHistory = [];');
    ev('window.__clean = ' + JSON.stringify(stale) + ';');
    ev('applyPulled(window.__clean, ' + (T_STALE + 5000) + ');');
    ok('clean pull leaves the push watermark alone',
       ev('S.meta.pushedAt') === ev('S.meta.changedAt'),
       ev('S.meta.pushedAt') + ' vs ' + ev('S.meta.changedAt'));

    // The merge is inert unless writes are actually stamped, so exercise the real entry points.
    ev('S.weights = [];');
    // The Bulk tab already owns #wDate / #wLbs. Appending copies would leave addWeight reading
    // the original empty pair and bailing out before it ever writes, so drive the real inputs.
    if (!w.document.getElementById('wDate')) {
      w.document.body.insertAdjacentHTML('beforeend', '<input id="wDate"><input id="wLbs">');
    }
    w.document.getElementById('wDate').value = '2026-08-28';
    w.document.getElementById('wLbs').value = '161';
    // renderBulk may need DOM the harness lacks; the push and stamp both happen before it,
    // which is what these assertions are about.
    try { ev('addWeight()'); } catch (e) {}
    const stamped = JSON.parse(ev('JSON.stringify(S.weights)'))[0] || {};
    ok('addWeight stamps the record with a write time', typeof stamped.t === 'number', JSON.stringify(stamped));
    ok('...stamped at roughly now', Math.abs(Date.now() - (stamped.t || 0)) < 60000);

    ev('S.pain = [];');
    try { call('painAdd', 'Barbell Bench Press', 2, 'twinge'); } catch (e) {}
    const painRec = JSON.parse(ev('JSON.stringify(S.pain)'))[0] || {};
    ok('painAdd stamps the record with a write time', typeof painRec.t === 'number', JSON.stringify(painRec));
  } catch (e) {
    ok('stale-snapshot section', false, e.message);
  }
  ev('S = ' + syncSaved + ';');
  ok('cleanup: real state restored after sync section', ev('JSON.stringify(S)') === syncSaved);

  console.log('\nRESULT: ' + pass + ' passed, ' + fail + ' failed');
  process.exit(fail ? 1 : 0);
}, 1200);
