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

  console.log('=== DATE OVERRIDES (CALENDAR EXCEPTIONS) ===');
  try {
    ok('dateOverridesEditorHTML exists', ev('typeof dateOverridesEditorHTML') === 'function');
    ok('generateTempStrengthDays exists', ev('typeof generateTempStrengthDays') === 'function');
    ok('clearTempStrengthDays exists', ev('typeof clearTempStrengthDays') === 'function');

    // --- exact-date override beats the dow map, for its date only ---
    ev("S.scheduleMode='dow'; S.schedule={0:'REST',1:'D1',2:'D2',3:'D3',4:'D4',5:'D5',6:'D6'}; S.dateOverrides={};");
    // 2026-08-21 is a Friday -> dow map gives D5 with no override present
    ok('control: dow map gives D5 with no override', ev("scheduledDayFor('2026-08-21')") === 'D5', ev("scheduledDayFor('2026-08-21')"));
    ev("S.dateOverrides['2026-08-21'] = 'S1';");
    ok('dateOverrides beats the dow map on its exact date', ev("scheduledDayFor('2026-08-21')") === 'S1');
    ok('dateOverrides does not leak to the day before', ev("scheduledDayFor('2026-08-20')") === 'D4', ev("scheduledDayFor('2026-08-20')"));
    ok('dateOverrides does not leak to the day after', ev("scheduledDayFor('2026-08-22')") === 'D6', ev("scheduledDayFor('2026-08-22')"));

    // --- exact-date override beats the rotating cycle pattern too ---
    ev("S.scheduleMode='cycle'; S.cycleSchedule={anchor:'2026-08-20', pattern:['D1','D2','D3','D4','D5','D6','REST']};");
    ev("delete S.dateOverrides['2026-08-21'];");
    ok('control: cycle pattern gives D2 once the override is removed', ev("scheduledDayFor('2026-08-21')") === 'D2', ev("scheduledDayFor('2026-08-21')"));
    ev("S.dateOverrides['2026-08-21'] = 'S1';");
    ok('dateOverrides beats the cycle pattern on its exact date', ev("scheduledDayFor('2026-08-21')") === 'S1');
    ev("S.scheduleMode='dow'; S.dateOverrides={};");

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
    ev("S.dateOverrides[" + JSON.stringify(start2) + "] = 'D3';"); // deliberately conflicts with the active rotation
    ok('an active meso rotation still outranks a conflicting dateOverrides entry',
       ev('scheduledDayFor(' + JSON.stringify(start2) + ')') === 'S1', ev('scheduledDayFor(' + JSON.stringify(start2) + ')'));
    ev('mesoStop(); S.dateOverrides={};');
    ok('cleanup: schedule restored after the meso/dateOverrides conflict check',
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
    ev('S.deload = null;');

    // startDeloadWeek must accept explicit overrides without breaking its no-arg default use
    ev("startDeloadWeek('2026-08-27','2026-08-25')");
    ok('startDeloadWeek honors explicit start/until overrides',
       ev('S.deload.startedAt') === '2026-08-25' && ev('S.deload.until') === '2026-08-27', JSON.stringify(ev('S.deload')));
    ev('S.deload = null;');

    // --- S1/S2/S3 generation must never pollute the permanent split ---
    ev('S.tempStrengthSplit = null;');
    const splitBefore = ev('JSON.stringify(S.split)');
    const gen = ev('generateTempStrengthDays()');
    ok('generateTempStrengthDays returns exactly S1/S2/S3',
       JSON.stringify(Object.keys(gen.split).sort()) === JSON.stringify(['S1', 'S2', 'S3']), JSON.stringify(Object.keys(gen.split)));
    ok('every generated day has exercises', Object.keys(gen.split).every(k => gen.split[k].exercises && gen.split[k].exercises.length > 0));
    ok('S.split is byte-for-byte unchanged by generation', ev('JSON.stringify(S.split)') === splitBefore);
    ok('S.tempStrengthSplit is populated after generation', !!ev('S.tempStrengthSplit'));

    // dayMeta/activeDayKeys are the documented single choke point for day-key resolution
    ok('dayMeta resolves a temp strength day', !!ev('dayMeta("S1")'));
    ok('activeDayKeys includes the temp strength days', ev('activeDayKeys().indexOf("S1")') >= 0);
    ev('clearTempStrengthDays();');
    ok('dayMeta no longer resolves S1 once cleared', ev('dayMeta("S1")') === null);
    ok('activeDayKeys drops S1 once cleared', ev('activeDayKeys().indexOf("S1")') === -1);

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

    ev("S.dateOverrides = {}; S.tempStrengthSplit = null; S.deload = null; S.scheduleMode='dow';");
  } catch (e) {
    ok('date overrides / temp strength days / deload window', false, e.message);
    ev("S.dateOverrides = {}; S.tempStrengthSplit = null; S.deload = null; S.scheduleMode='dow'; mesoStop(); live=null;");
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
    const runSrc = ev('agRunAll.toString()');
    ok('the daily cycle asks for an overload block', runSrc.indexOf('"overload"') >= 0);
    ok('the daily cycle validates it before storing', /olValidateReport/.test(runSrc));
    ok('the daily cycle feeds the agents the computed signals', /olAgentContext/.test(runSrc));
    ok('a rejected report keeps the previous one', /kept the previous read|previous read kept/.test(runSrc));

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
