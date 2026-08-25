# Iron Hub

Personal fitness tracking PWA. Single-file HTML app, deployed via GitHub Pages,
installed to home screen on iPhone and desktop.

Owner: Mark (18, training ~7 months, lean bulk, 5–6 days/week).
This app is used daily and mid-workout. Breaking it has a real cost — he loses a
session's data or gets bad prescriptions at the rack. Bias toward caution.

---

## The single-file constraint

**`iron_hub.html` is the entire application.** All HTML, CSS, and JavaScript live
in that one file. This is deliberate, not technical debt:

- It deploys as a static file with zero build step
- It can be opened from disk, emailed, or backed up as one artifact
- There is no bundler, no transpiler, no `node_modules` at runtime

**Do not** split it into modules, add a build step, introduce a framework, or
create `src/` directories. If a change seems to require any of that, stop and ask.

`test_agents.js` is the only other file that matters. It is a dev-time test
harness and is never loaded by the app.

---

## Deploy workflow

1. Edit `iron_hub.html`
2. **Bump the build marker** — line ~10: `<meta name="ironhub-build" content="YYYY-MM-DD-vX">`
   The in-app update checker compares this value. If you don't bump it, the app
   will not know an update exists.
3. Run the syntax check (below) — must pass
4. Run the test suite (below) — must be fully green
5. **Copy `iron_hub.html` over `index.html`** — they are byte-identical and both
   are committed. `index.html` is what GitHub Pages actually serves, so skipping
   this ships nothing.
6. Commit and push. GitHub Pages redeploys automatically.

There is **no service worker**, deliberately. That means every app launch fetches
the live file from Pages — updates land on the next open, with no cache to bust.
Do not add a service worker "for offline support"; it would break auto-updating,
which matters more here.

---

## Checks before every commit

**Syntax check** (catches unclosed braces, which are easy to introduce in a
7,900-line file):

```bash
node -e "
const acorn=require('acorn'), fs=require('fs');
const html=fs.readFileSync('iron_hub.html','utf8');
const scripts=[...html.matchAll(/<script>([\s\S]*?)<\/script>/g)].map(m=>m[1]);
scripts.forEach((s,i)=>{ try{ acorn.parse(s,{ecmaVersion:2022}); console.log('block '+i+': OK'); }
catch(e){ console.log('block '+i+' ERROR:', e.message, JSON.stringify(e.loc)); } });
"
```

Both blocks must print OK. Trust acorn's reported line/column. Naive bracket
counters give false positives on this file because it contains template literals
with `${}` interpolation.

**Test suite:**

```bash
node test_agents.js
```

Currently 1150 assertions. Must be `0 failed`. A red suite is never shipped.

Tests must not depend on what day the suite is run. `currentDayKey()` resolves
against the real calendar, so a test that assumes today is a training day is red
every rest day. Name a day key (`"D1"`) instead.

Setup (once): `npm install acorn jsdom`

---

## Testing bar

This is the part most likely to be done badly. The standard here is higher than
"the tests pass."

**A test must fail without the fix.** After writing a test for a bug, revert the
fix, confirm the test goes red, then restore it. A test that passes both with and
without the fix proves nothing, and this has actually happened in this repo more
than once — a mock was written that the fixed code recovered from, so the test was
silently exercising the success path.

The cheap way to do this is a *mutant*: copy the app, undo one fix in the copy, and
point the suite at it — the harness honours `IRONHUB_HTML`.

```bash
IRONHUB_HTML=/tmp/mutant.html node test_agents.js
```

Two traps this caught, both of which produce a mutant that wrongly *passes*:
- A single-line anchor string can match an **earlier, unrelated** occurrence
  (`if(hist.length){` appears in `deloadExercise()` long before the chart code).
  Verify the mutation landed where you meant.
- A fixture too clean to distinguish the branches. A perfectly linear bodyweight
  series has zero residual variance, so the projection fan collapses and any spread
  bug passes; one weigh-in per week makes the weekly average equal the raw value, so
  an anchoring bug is invisible. Fixtures need the messiness real data has — but use
  fixed offsets, never randomness, so the suite stays deterministic.

**Assert behavior, not absence of exceptions.** `renderX() does not throw` is a
weak test. Assert what the function actually produced. A composer that *renders*
and a Send button that *works* are different claims — one was verified here while
the other was broken.

**jsdom cannot see layout.** It has no layout engine, so `scrollHeight`,
`clientHeight`, and `offsetWidth` are all 0. Scroll and CSS behavior cannot be
truly verified in the harness. Where a test touches layout, assert *which branch
was taken* rather than a pixel value, and say so in a comment. Visual and layout
verification has to happen in a real browser.

**Checking layout in a real browser.** `file://` is blocked by the Chrome extension,
so serve the working copy and drive that:

```bash
node -e "const h=require('http'),f=require('fs');h.createServer((q,s)=>{s.writeHead(200,{'Content-Type':'text/html'});s.end(f.readFileSync('iron_hub.html'))}).listen(8731)"
```

Seed `localStorage['ironhub:v1']` with a fixture and reload. To measure narrow widths
without resizing the window, render the component into an offscreen div of a fixed
width and compare `scrollWidth` to `clientWidth` — but set `column-count:1` on it
first, or the ≥1240px two-column rule halves the width and every row reads as
overflowing. That measurement caught a real bug: `text-overflow:ellipsis` silently
does nothing on an **inline** element, so a long lift name widened its row instead of
truncating. Row containers need `display:flex` + `min-width:0`.

His live data is at `https://markwx18.github.io/iron-hubv2/` — reading
`localStorage['ironhub:v1']` there is the fastest way to check a bug report against
what his state actually says before changing anything.

**Clean up synthetic data.** Tests that push into `S.logs` or `S.split` must
filter their fixtures back out, or they leak into later sections' assertions.

---

## The bug class that keeps recurring: stale references across `await`

`applyPulled()` replaces the global `S` **wholesale** when a gist sync lands. Any
reference captured before an `await` points at an orphaned object afterward, and
everything written through it is silently discarded by `save()`.

```js
// WRONG — `a` is orphaned if a sync lands during the await
const a = agState();
const res = await callClaudeWithTools(...);
a.lastRun = todayKey();          // written to a dead object, lost on save

// RIGHT — re-resolve after every await
await callClaudeWithTools(...);
agState().lastRun = todayKey();
```

This caused a multi-day bug where agents re-ran every launch: log entries persisted
(because `agLog()` re-resolves internally) while `lastRun` and `status` vanished
(captured reference), so the daily gate never closed. **The asymmetry — some writes
surviving and others not — is the fingerprint of this bug.**

Anywhere you add an `await` in code that touches `S`, re-resolve state after it.
This also bit the test harness itself.

---

## The other sync trap: `save(false)` and the `changedAt` watermark

`bgSyncTick()` pulls every 60s and applies the gist whenever
`exportedAt > S.meta.changedAt`. `save(false)` writes localStorage without
touching `changedAt`, so **anything saved with `save(false)` can be reverted by
the next background pull.** Two rules follow:

- **A user action must `save()` (touch+push).** `invRaise()` and `invArchive()`
  deliberately stay on `save(false)` — a boot-time `invAutoRun()` that bumped
  `changedAt` would make `autoPullOnLoad()` skip its pull and then push stale
  local state over the phone's newer data. The *entry points* touch instead:
  `invRunManual()`, `invDismiss()`, `invApplyFix()`, `invDeleteHistory()`.
- **Consuming or producing a snapshot advances the watermark.** `applyPulled()`
  takes the snapshot's `exportedAt`, and `syncPush()` takes its own upload's.
  Without this the gate never closes (a payload stamps `exportedAt` *after* the
  `changedAt` it carries), so the identical snapshot replays every minute.

---

## Architecture map

| Area | Key functions |
|---|---|
| State | `S`, `load()`, `save()`, `LS_KEY = 'ironhub:v1'` |
| Sync | `autoPullOnLoad()`, `applyPulled()`, `fetchGistData()`, `schedulePush()` |
| Schedule | `currentDayKey()`, `scheduledDayFor()`, `scheduleMode()` (`dow` \| `cycle`) |
| Week windows | `weekStartKey()`, `lastCompletedWeekRange()`, `weeklyVolumeByGroup()` |
| Progression | `classifyDecision()`, `buildOneLiveExercise()`, `intraAdvice()` |
| Effort lever | `effBucket()`, `effLever()`, `effMean()`, `EFF_ANCHOR` |
| Home / strip | `renderHome()`, `renderStatusStrip()`, `readinessNow()`, `renderNotif()` |
| Pain flags | `painAdd()`, `painFor()`, `painContext()` |
| WHOOP | `applyWhoop()`, `whoopFresh()`, `whoopContext()`, `.github/workflows/whoop-sync.js` |
| Photos | `photoState()`, `photoDownscale()`, `photoLoadAll()`, `photoSaveAll()` |
| Bulk rate | `bulkRate()`, `bulkBand()` — the ONE bodyweight rate; every lb/wk figure comes from here |
| Live session | `renderLive()`, the dock, `liveDeltaSend()` |
| Investigation | `investigateLift()`, `invActiveFlags()`, `invUpdateBadge()` |
| Agents | `agRunAll()`, `agValidateFix()`, `agApplyFix()`, `agSendChat()`, `renderOps()` |
| Analytics | `renderAnPred()`, `anEnsembleFor()`, `e1rmSeries()`, `linreg()` |
| Projections | `anFanProject()` (shared core), `anFanChartSVG()`, `anFanMilestones()`, `bwProjectFor()` |
| Overload status | `olSignals()`, `olBaselineVerdict()`, `olValidateReport()`, `renderAnOverload()` |
| Exercise swaps | `swapScore()`, `swapPattern()`, `swapEquip()`, `swapCandidates()`, `swapListHTML()` |
| PR history | `checkPRs()`, `prAppend()`, `prBackfill()`, `renderAnPRs()` |
| Readiness | `anReadinessOutcome()`, `anReadinessTrim()`, `renderAnReadiness()` |
| Bulk quality | `anBulkQuality()`, `anBqLifts()`, `anDualSpark()` |
| Fuel | `renderFuel()`, `fuelTimingHTML()`, `fuelClockFrom()` |
| Live refresh | `rerenderActive()`, `bgSyncTick()`, `opsSignature()`, `refreshBlocked()` |
| Muscle map data | `bmViewerData()`, `bmStatusFor()`, `bmWeeklyVol()`, `bmTrainedDays()` |
| 3D viewer | `bm3dInit()`, `bm3dBuild()`, `bm3dApply()`, `bm3dPick()`, `bm3dDispose()`, `bm3dFallback()` |

**Agent system:** four agents — ZULU (lead), CHARLIE (logistics/schedule/data health),
DELTA (training), ECHO (nutrition/bodyweight). Model: `claude-sonnet-5`, declared once as
`AI_MODEL`.

Nightly at 9 PM, CHARLIE/DELTA/ECHO run **in parallel**, each with its own prompt and its
own allowed fix shapes (`AG_ROLE_BRIEF`, `AG_FIX_MENU`), then ZULU runs on their output and
also writes the Daily Brief. One agent failing costs only that agent. Parallel is deliberate:
sequential would make "Run cycle now" a 2–3 minute wait, and the cost is that the three
cannot share a prompt cache — a cache entry is only readable once the response that wrote it
has begun streaming. Do not add `cache_control` here; it would charge the 1.25× write premium
for a cache nothing reads.

Agents have **read-only data tools** (`agDataToolDefs()`, executed by `agRunDataTool()`,
looped by `callClaudeWithData()`): `list_lifts`, `get_lift_history`, `get_e1rm_series`,
`get_bodyweight`, `get_nutrition`, `get_readiness`, `get_weekly_volume`. There is no write
tool and there must never be one — state still changes only through the proposal queue and
`agApplyFix()`. The loop is bounded by `AI_TOOL_ROUNDS` (6, or 2 for mid-workout DELTA) with
results capped at `AI_TOOL_MAXCHARS`, because it runs unattended and an unbounded loop is an
unbounded bill.

**Sonnet 5 thinks adaptively, and thinking tokens bill as output and count against
`max_tokens`.** Two consequences to keep in mind when touching any API call: never set a
`max_tokens` low enough for a long think to swallow the answer (nothing in the app is below
4000, and the suite asserts it), and control spend with `output_config.effort`
(`AI_EFFORT_DEFAULT` is `medium`; the nightly cycle raises it to `high`) rather than by
starving the cap. `temperature`, `top_p`, `top_k`, `budget_tokens` and assistant prefills all
return a 400 on this model — none are used, and the suite asserts that too.

---

## Hard rules for the agent layer

**Agents never mutate state silently.** Every change goes through the proposal
queue and requires the user to tap Approve. `agApplyFix()` is the *only* place a
proposal may touch state. Do not add side paths.

**`agValidateFix()` is a security boundary.** It whitelists fix types, clamps
numeric ranges, and rejects anything malformed. Never loosen it to make a model's
output "work." If a model produces something invalid, the correct behavior is to
discard it, not to coerce it.

**Advisory-only proposals are not allowed in the queue.** A proposal with no
concrete `fix` has nothing to apply, so approving it is a no-op. These are folded
into the activity log instead. Enforced at ingestion, not just requested in the
prompt — models don't reliably follow "don't do X."

**Prompt instructions are not enforcement.** Anything that must be true should be
validated in code. The prompt is a hint; the validator is the guarantee.

**Model-supplied exercise names must be resolved, never trusted.** An override is
stored *and looked up* by exercise name, so a name that matches nothing real writes a
key that can never fire — an "applied" fix that silently does nothing. DELTA has
already proposed a `liftReset` for `Trap Bar Deadlift`, which is not in the split at
all. `agValidateFix()` now resolves the name through `agResolveExName()` and stores
the canonical spelling; `invOverrideFor()` additionally matches on a normalised form
as a second line of defence.

**Read-only agent output still needs a validator.** The Overload Status tab is
informational, so it does not go through the proposal queue — but `olValidateReport()`
discards any row whose direction contradicts the computed trend, or whose verdict
inverts the computed one, and the tab renders live-computed signals underneath
regardless. A bad night costs the tab its commentary, never its content.

**Schedule fixes are mode-gated in both directions.** `schedule` (day-of-week map)
is rejected in cycle mode; `cycleSchedule` is rejected in dow mode. The cycle
*anchor date* can never be changed by a proposal — only manually in Settings,
because shifting it silently changes what today resolves to.

---

## V4 invariants — things that will silently break if undone

**The split in force is not always `S.split`.** During an approved meso strength block the day
keys are S1/S2/S3, which do not exist in `S.split` at all. Anything resolving an exercise
property at runtime must go through `activeSplitObj()`.
`incForExercise()`, `isFormFocus()`, `isStrMode()`, `isMaxed()` and `agTrainedExNames()` all
do. Missing one is invisible until a block is active — that was the `+15` increment turning
into `-5`.

**Generating a split is not scheduling it.** A meso block reaches the calendar through
`mesoRotationDayFor()`, anchored to the *calendar* and consulted ahead of the dow/cycle map in
`scheduledDayFor()`: day N of the block is always slot N of `['S1','S2','S3','REST','REST']`.
That is now the only way S1/S2/S3 land on a date.

There used to be a second way — a **standalone strength window** (`S.tempStrengthSplit` +
`S.tempStrengthWindow`), generated from a Settings card and sequenced by what he had *logged*
rather than by the calendar. Removed 2026-08-25 at his request: it was a one-off, and a meso
strength block already expresses the same thing as part of a plan. Two things that removal
had to get right, and that any future removal here should copy:

- **The card was the only entry point _and_ the only exit.** A window already sitting in his
  saved state would have gone on overriding the calendar with no UI left that could clear it.
  Hence `REMOVED_STATE_KEYS` / `pruneRemovedKeys()`, which now drops `tempStrengthSplit` and
  `tempStrengthWindow` alongside V4's `dateOverrides` on first touch.
- **Check what else was leaning on the mechanism you are pulling.** V4 removed exact-date
  overrides (`S.dateOverrides`) — the only thing that could put the *standalone* days on a
  date — but kept `generateTempStrengthDays()`. For four days the Settings card built S1/S2/S3
  and scheduled them nowhere; the calendar announced D-days straight through a strength block
  and the only way to reach one was the manual day picker.

**Card open-state must not live on the DOM node.** `rerenderActive()` regenerates the whole
active tab every 30 s and after every sync pull, so DOM-only state is wiped on a timer with
nothing to blame it on. `subOpen`, `sdOpen`, `sdHomeOpen` and `photoOpen` are module-scoped
for this reason.

**One bodyweight rate.** `bulkRate()` / `bulkBand()`, over weekly averages. Every surface that
quotes a lb/wk figure goes through it: the Bulk tab, the projection card, `investigateBulk()`,
and `bulkScore()` (the Progress verdict). That last one was missed the first time and kept its
own raw first-vs-last-weigh-in math, so Progress read +0.35 lb/wk on the same day the Bulk tab
read 0.00 off the identical weigh-ins. The *bands* are shared too — a rate the Bulk tab calls
"under the pocket, add calories" must not read as "right in the lean-bulk range" two tabs over.
Do not add a fifth.

**Effort reads go through `effBucket()`.** It prefers the 0–100 lever (`s.ef`) and falls back
to the legacy tag (`s.e`), which is what lets months of already-logged sessions keep working
with no migration pass. Anything writing effort must write both fields.

**The status strip never renders during LIVE**, and is painted *before* the
`refreshBlocked()` gate. That gate stops a repaint eating half-typed input; a read-only bar
cannot do that, and behind the gate it would go stale exactly when the app is in use.

**WHOOP comes in, never out.** `syncPayload()` deletes `d.whoop`. The Action owns
`whoop_data.json`; the app owns `ironhub_data.json`. Data not dated today is treated as
absent — a stale recovery score is worse than none because it looks current.

**Photos never go in `S`.** State holds an index; the blobs live in their own gist, fetched
on demand. Everything in `S` is re-serialized on every save and re-uploaded on every sync.

## UI conventions

Design language: "forge on steel" — near-black background, industrial/mono accents.

| Token | Value | Use |
|---|---|---|
| `--amber` | `#F6862F` | primary accent, DELTA |
| `--cyan` | `#46CDBA` | CHARLIE, positive trend |
| `--violet` | `#B79BFF` | ECHO |
| ZULU | `#dfae36` | lead agent |

Use CSS variables, never hardcoded hex, in new UI.

**Never repaint under the user's hands.** The live-refresh loop deliberately
refuses to re-render while an input has focus or while a LIVE session is active —
the dock can hold a typed weight/reps that isn't logged yet, and losing that
mid-workout is unacceptable. Preserve scroll position on chat repaints; only pin
to bottom if the user was already near the bottom.

**Mobile is the primary target.** Most use is on an iPhone, one-handed, mid-set.
Check at 393px and 320px widths.

**Muscle map: 2D on LIVE, 3D on Progress.** The Progress tab's muscle map is a
rotatable three.js viewer; the LIVE idle screen keeps the flat SVG, on purpose —
it's the front door on a training day and must not wait on a CDN fetch or a GPU
context before it paints. `bmViewerData(mode)` is the single source of truth both
renderers draw from, so they can never disagree about a muscle's status; the
volume math is tested in `test_agents.js` (jsdom has no WebGL, so the 3D render
itself isn't). three.js is pinned and lazily `import()`ed on first view of the
card — no build step, no bundler. Every failure path (no WebGL, no network, CDN
down) falls back to the flat bodies; the tab degrades, it never breaks. Colours
in `bm3dColors()` are hardcoded to match `BM_C` exactly, so the 2D and 3D pictures
read as the same picture from a different angle — there is one theme, so nothing
here reads from a CSS custom property.

---

## Style notes

- Comments should explain *why*, especially for non-obvious guards. Several
  functions carry comments explaining a specific bug they prevent — keep those.
- **Anchor short keyword tokens in name-matching regexes.** `musclesFor()` classified
  "Plate Loaded Chest Press" as Back because unanchored `/lat/` matches inside
  "**Plat**e", and `/ab/` matches inside "c**ab**le" and "**Ab**ductor". `mesoPattern()`
  carries the same warning about `chin` inside "ma**chin**e". Use `\b`.
- Match surrounding code style rather than imposing a new one.
- `esc()` all user/model-supplied text going into HTML.
- Prefer editing existing functions over adding parallel ones.

---

## When to stop and ask

- The change seems to need a build step, framework, or extra runtime file
- The change would let an agent write state outside `agApplyFix()`
- The change would loosen `agValidateFix()`
- A test can't be made to fail without the fix (means the test is wrong, or the
  fix isn't doing what you think)
- Anything touching health, injury, or nutrition guidance where being wrong could
  affect his actual training or wellbeing

---

## Cost and safety guardrails for autonomous decisions

Most unspecified details (component structure, styling, minor UX choices) don't
need approval — use good judgment and proceed.

But never silently pick the more expensive or more permissive option for these —
stop and flag the tradeoff in plain terms before writing code:
- Any change to which model powers the in-app agents, or whether they run as one
  combined call vs. separate calls (real, differing ongoing API cost)
- Any change to what tools/data the agents can access (e.g. web search, scope
  beyond fitness/training)
- Any change letting an agent write state outside the existing agApplyFix path
- Any new backend infrastructure where none existed before
