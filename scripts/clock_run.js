#!/usr/bin/env node
/* Iron Hub: run the suite with the clock moved.
 *
 * CLAUDE.md, "The clock has more traps than the day key": a test that only passes on the day it was written is
 * found by running the whole suite on another day. Both clocks move by the same amount. A -r preload shifts the
 * harness's Date, and the same shift goes at the top of the app's first script in a copy handed to the suite as
 * IRONHUB_HTML. Time still runs; only "now" moves.
 *
 *   node scripts/clock_run.js                          the V5 dates (below)
 *   node scripts/clock_run.js 2026-12-28T07:30 ...     any instants, local time
 *   IRONHUB_HTML=/tmp/mutant.html node scripts/clock_run.js    a mutant, on a moved clock
 *   CLOCK_JOBS=2 node scripts/clock_run.js             how many suites run at once (default 3)
 *
 * Exits 1 if any run has a failure. Dev-time only: the app never loads this.
 */
const fs = require('fs'), os = require('os'), path = require('path'), cp = require('child_process');

const ROOT = path.join(__dirname, '..');
const SRC = process.env.IRONHUB_HTML || path.join(ROOT, 'iron_hub.html');
/* V5's dates: the model deadline, the away-block deadline, the day before the trip, its first and last day, and the
   day after. New Year's Day also runs in the early hours, where "today at 6 AM" is still in the future. */
const DEFAULTS = ['2026-11-16T12:00', '2026-12-14T12:00', '2026-12-27T12:00', '2026-12-28T12:00',
                  '2027-01-01T00:30', '2027-01-01T12:00', '2027-01-02T12:00'];
const instants = process.argv.slice(2).length ? process.argv.slice(2) : DEFAULTS;
const JOBS = Math.max(1, +process.env.CLOCK_JOBS || 3);

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'ihclock-'));
process.on('exit', function(){ try{ fs.rmSync(tmp, {recursive: true, force: true}); }catch(e){} });

// One Date for both sides. `new D()` and D.now() are shifted; a Date built from parts or a string is not.
const SHIM = "var R = Date; function D(a,b,c,d,e,f,g){ if(!(this instanceof D)) return new R(R.now()+off).toString();" +
  " var n = arguments.length; return n===0 ? new R(R.now()+off) : n===1 ? new R(a) : new R(a,b,n>2?c:1,n>3?d:0,n>4?e:0,n>5?f:0,n>6?g:0); }" +
  " D.prototype = R.prototype; D.now = function(){ return R.now()+off; }; D.UTC = R.UTC; D.parse = R.parse;";

const preload = path.join(tmp, 'preload.js');
fs.writeFileSync(preload, "(function(){ var off = +process.env.IRONHUB_CLOCK_OFF || 0; " + SHIM + " global.Date = D; })();\n");

const html = fs.readFileSync(SRC, 'utf8');
const at = html.indexOf('<script>');
if(at < 0){ console.error('No <script> in ' + SRC); process.exit(1); }

function run(iso){
  return new Promise(function(resolve){
    const target = new Date(iso).getTime();
    if(!isFinite(target)){ resolve({iso: iso, pass: 0, fail: 1, fails: ['not a date: ' + iso], secs: 0}); return; }
    const off = target - Date.now();
    // In a try: the suite's runner test pins window.Date non-writable in its own copies, and that pin must win.
    const shim = "\n;(function(){ try{ var off = " + off + "; " + SHIM + " window.Date = D; }catch(e){} })();\n";
    const copy = path.join(tmp, 'app-' + iso.replace(/\W/g, '') + '.html');
    fs.writeFileSync(copy, html.slice(0, at + 8) + shim + html.slice(at + 8));
    const t0 = Date.now();
    const env = Object.assign({}, process.env, {IRONHUB_HTML: copy, IRONHUB_CLOCK_OFF: String(off)});
    const child = cp.spawn(process.execPath, ['-r', preload, path.join(ROOT, 'test_agents.js')], {cwd: ROOT, env: env});
    let out = '';
    child.stdout.on('data', function(d){ out += d; });
    child.stderr.on('data', function(d){ out += d; });
    child.on('close', function(code){
      const m = /RESULT: (\d+) passed, (\d+) failed/.exec(out);
      const fails = out.split(/\r?\n/).filter(function(l){ return /^\s*FAIL: /.test(l); }).map(function(l){ return l.trim(); });
      if(!m) fails.push('the suite did not finish (exit ' + code + '): ' + out.slice(-300).replace(/\s+/g, ' '));
      resolve({iso: iso, pass: m ? +m[1] : 0, fail: m ? +m[2] : 1, fails: fails, secs: Math.round((Date.now() - t0) / 1000)});
    });
  });
}

(async function(){
  console.log('Suite on a moved clock: ' + instants.length + ' instant(s), ' + JOBS + ' at a time, app: ' + path.relative(ROOT, SRC));
  const results = [], queue = instants.slice();
  await Promise.all(Array.from({length: Math.min(JOBS, queue.length)}, async function(){
    while(queue.length){
      const r = await run(queue.shift());
      results.push(r);
      console.log((r.fail ? 'RED   ' : 'green ') + r.iso + '  ' + r.pass + ' passed, ' + r.fail + ' failed  (' + r.secs + 's)');
      r.fails.slice(0, 12).forEach(function(l){ console.log('        ' + l.slice(0, 260)); });
      if(r.fails.length > 12) console.log('        ... and ' + (r.fails.length - 12) + ' more');
    }
  }));
  const red = results.filter(function(r){ return r.fail; }).length;
  console.log(red ? '\n' + red + ' of ' + results.length + ' instants are red.' : '\nAll ' + results.length + ' instants are green.');
  process.exit(red ? 1 : 0);
})();
