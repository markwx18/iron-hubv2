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

Currently 721 assertions. Must be `0 failed`. A red suite is never shipped.

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
| Skins | `SKINS`, `DEFAULT_SKIN`, `currentSkin()`, `setSkin()`, `pickSkin()`, `SKIN_KEY` |
| Muscle map data | `bmViewerData()`, `bmStatusFor()`, `bmWeeklyVol()`, `bmTrainedDays()` |
| 3D viewer | `bm3dInit()`, `bm3dBuild()`, `bm3dApply()`, `bm3dPick()`, `bm3dDispose()`, `bm3dFallback()` |

**Agent system:** four agents — ZULU (lead), CHARLIE (logistics/schedule/data health),
DELTA (training), ECHO (nutrition/bodyweight). They run one combined API call nightly
at 9 PM. Model: `claude-sonnet-4-6`.

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

## UI conventions

### Skins

The app ships **two complete visual identities**, selected by `data-skin` on
`<html>`. **KINETIC is the default** — violet-biased black, borderless cards,
round geometry, Anton/Manrope/DM Mono. **BLUEPRINT** is the alternate — cold ink
navy, drafting grid, hairline rules, 2px corners, Archivo/Public Sans/JetBrains
Mono. Switch in Settings → Appearance.

The default skin lives in **bare `:root`** so a missing or unreadable attribute
still paints a complete app, and its fonts sit on the static `<link>` the preload
scanner sees. The alternate is `:root[data-skin="blueprint"]` and only overrides.

**To change which skin is the default, three things move together:** the
`DEFAULT_SKIN` constant, which token block is bare `:root`, and the `href`/test in
the `<head>` boot script. A test asserts all three agree.

The skin preference is stored in its own `ironhub:skin` localStorage key,
**never in `S`** — a purely visual per-device choice must not touch
`save()`/`changedAt`, where a boot-time write could make `autoPullOnLoad()` skip
its pull and push stale local state over the phone's newer data. Same reasoning as
`LIVE_KEY`.

### Tokens

`--c-primary` / `--c-review` / `--c-echo` / `--c-alert` are the source of truth.
`--amber` / `--cyan` / `--violet` / `--red` are **aliases**, kept because ~250 call
sites and two assertions reference them — that is what makes a skin swap a value
change rather than a 9,000-line find-replace. Write new UI against the role names.

- `--good` / `--warn` / `--bad` are **independent of the accent** on purpose: they
  encode readiness tier, fatigue and PR state, and must read as go/caution/stop
  even when the accent is violet.
- `--accent` is the **current day's colour**, rewritten at runtime by `setAccent()`.
  It is not the skin's primary — do not collapse the two.
- `--ag-zulu/charlie/delta/echo` are agent identity. ZULU is gold because it leads,
  not because anything is wrong.
- Washes/scrims (`--wash-*`, `--halo-*`, `--scrim-*`) exist so gradients don't carry
  the accent's RGB inline.
- Day colours are **data** (`S.split[dk].hex`, synced through the gist).
  `dayColor()` resolves `--d1..--d6` first and falls back to the stored hex, so a
  reskin colours them without touching saved state.

Use CSS variables, never hardcoded hex, in new UI. A test asserts every
`var(--x)` in the file resolves — it was added after `--bg` and `--card` were found
referenced but never defined, which left `.ag-card` with no fill.

**Per-skin structural rules and state overrides.** A skin block rewrites surfaces
at the same specificity as base `.x.on` state rules, so it wins on source order and
silently blanks selected fills. The `STATE OVERRIDES` block at the end of the
stylesheet restates those states one level deeper under `:root`. Add new active
states there, not just to the base sheet.

**Never repaint under the user's hands.** The live-refresh loop deliberately
refuses to re-render while an input has focus or while a LIVE session is active —
the dock can hold a typed weight/reps that isn't logged yet, and losing that
mid-workout is unacceptable. Preserve scroll position on chat repaints; only pin
to bottom if the user was already near the bottom.

**Mobile is the primary target.** Most use is on an iPhone, one-handed, mid-set.
Check at 393px and 320px widths.

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
