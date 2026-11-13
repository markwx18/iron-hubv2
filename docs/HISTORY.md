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

`test_agents.js` is the only other file that matters to the app. It is a dev-time test
harness and is never loaded by the app.

`discord/` is a separate, read-only Cloudflare Worker that shows Iron Hub in Discord. It has its
own `package.json` and test suite (`node discord/test_worker.js`, must be 0 failed too), and the
app never loads anything from it. Its setup guide is `discord/README.md`.

`pantry/` is the family pantry check's drop box, a separate Cloudflare Pages project (its own `package.json`;
`node pantry/test_worker.js`, must be 0 failed). The app only ever fetches its URL (`FAM_DROP_URL`).
Its setup guide is `pantry/README.md`.

`clock/` is the alarm clock for the server runner, a Cloudflare Worker with one cron and one secret (its own
`package.json`; `node clock/test_worker.js`, must be 0 failed). It only ever dispatches `.github/workflows/agents.yml`.
`scripts/agents/run.js` is that workflow's runner: it loads `index.html` headless, so it is the app, not a copy of it.
The setup guide is `clock/README.md`.

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

Currently 4197 assertions. Must be `0 failed`. A red suite is never shipped.

Tests must not depend on what day the suite is run. `currentDayKey()` resolves
against the real calendar, so a test that assumes today is a training day is red
every rest day. Name a day key (`"D1"`) instead.

The clock has more traps than the day key, and four were found at once on 2026-10-10:
- A stubbed `todayKey()` beside the real clock (`Date.now() - 20 days`): the pantry test went red by
  itself from 2026-10-12.
- A time of day: a fixture "today at 6:16 AM" is newer than now before 6:16.
- The 25-hour day DST ends: "24 h 10 min ago" can still be today.
- An end date: an arc that is over says nothing.

The way to find them is to run the suite with the clock moved. A `-r` preload shifts the harness's
`Date`, and the same shift goes at the top of the app's first script in a copy passed as
`IRONHUB_HTML`. Run it at Nov 1 (both ends), New Year, the arc's start and end, and the early hours.

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

**A new `meta` field is a migration, because `load()` does not migrate `meta`.** It does
`Object.assign(DEFAULT_STATE, stored)`, which is a shallow merge — a stored `meta` object is
taken *wholesale*, so a field added to `DEFAULT_STATE.meta` comes back **absent** on any state
saved before that field existed, not at its default. On 2026-09-02 that erased two months of
training: `pushedAt` (added 2026-08-18) was absent on a laptop last opened 2026-07-12, so
`(S.meta.pushedAt||0)` was 0 while `changedAt` was a real July timestamp,
`pushUnconfirmedChanges()` read the pair as "unpushed work," and the boot catch-up uploaded
the stale snapshot with a fresh `exportedAt` *before* `autoPullOnLoad()` reached its pull.
Every other device then pulled it. `mergeUnseenHistory()` cannot soften this — it keeps only
records with `t > exportedAt`, and the bad `exportedAt` was "now".

Recovery is `scripts/gist_restore.js` (`list` / `show` / `restore`): a gist keeps every
revision, so an overwrite is undoable. `list` prints what each revision *contains*, because a
stale push carries a fresh timestamp and the stamp alone cannot identify the good one. The
restore must re-stamp `exportedAt` to now, or no device will accept it — they all advanced
`changedAt` when they swallowed the bad snapshot.

If you add a `meta` field, do not assume a default reaches an existing install: gate on
whether the field is genuinely present, the way `pushUnconfirmedChanges()` now requires
`pushedAt > 0` before treating a gap as a stranded push.

**A push must not overwrite what this device has not read.** It happened again on 2026-09-19,
from the other direction: a laptop last synced Sep 14 was opened at 2:08 PM, its boot pull
*failed* (the app showed "sync offline" and carried on, which is also why it wrote a second
morning brief), and the very next `save()` PATCHed its Sep-14 snapshot over four sessions,
four weigh-ins, five nutrition days and seven PRs. It then kept pushing it, because
`syncPush()` advances its own watermark, so no later pull could apply. The `pushedAt > 0`
guard above does not cover this: the device had a real watermark, and the push was an ordinary
debounced one, not the boot catch-up.

So `syncPush()` calls `syncReconcileBeforePush()` first — one GET, on every push, manual
included. If the gist holds a snapshot this device has not applied, it applies it and pushes
the union; if the gist cannot be READ, the push does not go out at all (the records stay local,
`changedAt` stays ahead of `pushedAt`, and `pushUnconfirmedChanges()` retries). Two things
that reconcile has to get right, and both are tested:

- **It runs a second merge, with `pushedAt` as the cutoff.** `applyPulled()`'s own
  `mergeUnseenHistory(localPrev, exportedAt)` keeps only records *newer than the snapshot* —
  correct for a pull, where an older record the snapshot lacks was deleted on purpose somewhere.
  Before a push there is a second class to save: anything written since this device's last
  *confirmed upload* provably never reached the gist, so its absence there cannot be a deletion.
  Without it, reconciling would drop a session logged offline at 6 PM because another device
  pushed at 6:30 — trading one data-loss bug for another.
- **The cutoff is `pushedAt`, not "keep everything local".** A record older than the last
  confirmed push that the gist no longer holds *was* deleted elsewhere, and must stay deleted.

This does not replace push-before-pull in `autoPullOnLoad()`; it makes the push itself safe,
so the two orders can no longer disagree.

**"Not applied" is asked of a seen watermark, never of `changedAt`** (found 2026-10-10). The
reconcile used to test `exportedAt > changedAt`, and `save()` moves `changedAt` to now *before* the
push it schedules, so every save-triggered push read any older snapshot as already seen and
PATCHed over it. That is the Sep-19 shape itself: the suite's case called `syncPush()` with a
week-old `changedAt` and no `save()`, the one shape that worked. A replay showed both real shapes
losing the other device's session from the gist and from this device: a stale device whose boot
pull failed, then any tap; and an open laptop that saves anything in the minute after the phone
pushes. Now:
- `syncSeenAt()` is the newest snapshot this device applied (`applyPulled()`) or wrote (a
  successful `syncPush()`), in its own `localStorage['ironhub:syncseen']`, never `S` (it is a fact
  about this device, and `S.meta` arrives from the other device on every pull). With no key yet,
  it falls back to `pushedAt`. `syncSeenSet()` compares with the stored key only: comparing with the
  fallback never wrote it, because both callers set `pushedAt` to the same value first.
- A restore (`importApply()`) marks the gist as seen, so it still replaces the cloud copy as it
  always has. `connectSync()` and `disconnectSync()` reset it.
- The cost, by design: when the reconcile applies a snapshot, this device's NON-history edits since
  its last push lose to it (top-level keys are replaced whole; only `SYNC_HISTORY` is unioned, and
  `S.agents` has its own merge, which does not include the per-agent chats). That window is the
  same one in which the other device's sessions used to be lost, so it is the right trade; a
  per-key three-way merge is the fix if it ever bites.

---

## Architecture map

| Area | Key functions |
|---|---|
| State | `S`, `load()`, `save()`, `LS_KEY = 'ironhub:v1'` |
| Sync | `autoPullOnLoad()`, `applyPulled()`, `fetchGistData()`, `schedulePush()`, `syncReconcileBeforePush()` (asks `syncSeenAt()`, `SYNC_SEEN_KEY`) |
| Schedule | `currentDayKey()`, `scheduledDayFor()`, `scheduleMode()` (`dow` \| `cycle`) |
| Week windows | `weekStartKey()`, `lastCompletedWeekRange()`, `weeklyVolumeByGroup()` |
| Progression | `recommend()`, `classifyDecision()` (the two trees, kept in step), `buildOneLiveExercise(nm, homeEquip, {call, sets})`, `intraAdvice()`; jump cautions `e1Spike()` (`SPIKE_PCT`), `atCeiling()` (`STR_CEIL_SETS`) |
| Per-lift flags | `exSlotsFor()` (split in force, else the permanent split), `isMaxed()`, `incForExercise()`, `slotInc()`, `isFormFocus()`, `isStrMode()`, `toggleRepMode()` |
| Forecasts & insights | `deloadForecast()`, `fuelVsResults()`, `recoveryEffectCardHTML()`, `anReadinessFactors()`, `sessionDensity()` / `densityByDay()`, `streakStats()`, `fatigueIndex(endKey)` |
| Train (A × C) | Plan `planHeroHTML()`, `planBlocks()`, `planLenStep()`, `planSetType()`; Log `logHeroHTML()`, `logChipsHTML()`, `logRowHTML()`, `logPRsOn()` (`logFilter`, `logOpen`); Library `libLifts()`, `libMatches()`, `libFilterRows()`, `libCardHTML()`, `libFlag()`, `libRename()`; `exRenameFlow()` (the one rename flow) |
| Body (A × C) | Weight `bwHeroHTML()`, the chart `bwChartCardHTML()` (range `bwView`, `bwViewPreset()` / `bwViewSet()`, `bwRangeSummary()`; hover and drag-to-zoom through the kit's `ckHovWrap()`), `bwWeeklyRows()`, `bwHeadingHTML()`, `bwWeeksHTML()`, `BW_BAND_CHIP`; Fuel `fuelHeroHTML()` / `fuelRingHTML()`, `nutLogHTML()`, `nutHistFold()`; Ready `rdHeroHTML()`, `rdBarsHTML()`, `rdCheckinsHTML()` |
| Settings (A × C) | `setGlance()` / `setGlanceHTML()` (`SET_TONE`), `setOpenGroup()`, `setGearHTML()`, `settingsSummaries()` |
| Winter Arc | `winterState()`, `waPhase()`, `waCardHTML()`; his dates `waEditHTML()` / `waReadDates()` / `waSaveTargets()`, `waStartTime()` / `waEndTime()`, `waWallMs()` / `waEndMs()`; the countdown `waGoLiveMs()`, `waSeasonRead()`, `waCountState()` / `waCountHTML()`, `waCountTick()` (`#waCount`), `waLaunchHTML()` |
| Recap | `recapSlides()`, `recapYear()` / `recapFinal()` / `recapTitle()`, `recapRender()` / `recapOpen()` / `recapGo()` / `recapClose()`, `recapCardHTML()` |
| Meal timing & radar | `liveAteHTML()` / `liveAteSet()`, `MT_BUCKETS`, `mtScore()`, `mealTimingRead()`, `mealTimingCardHTML()`; `radarData()`, `ckRadar()`, `strengthRadarHTML()`, `muscleResponse(weeks, {clean})` |
| Plateau watch | Strength hero `strHeroHTML()` / `strWhyHTML()` / `strRiskHTML()`, marks `ckMarks()` / `ckEventMarks()`; `plateauRisk()` (one row: `state`, `lvl`, `conf`, `rule`, `used`, `excluded`), `plateauWatch()`, `pwIssue()` / `pwFlagged()` / `pwCol()`, evidence `pwSeries()` / `pwExcludeWhy()` / `pwCleanHist()` / `pwRange()` / `pwCapped()` / `pwBwLift()`, resets `pwResetFor()` / `pwResetActive()`, `pwDropFor()`, his corrections `pwMark()` (`S.liftNotes`) / `pwMaxedOff()`, the program `pwApplyProgram()` / `pwProgramNotes()` / `pwProgramCheck()` / `pwProgramHTML()`, `pwReasonHTML()` / `pwDoText()`, `sessionDrops()` / `summaryDropsHTML()`, `pwOlVerdict()`, `pwSlopeFall()`, `invResetWeight()`; `plateauCauses()`, `pwCauseWindow()`, `liftDips()`, `pwRising()` / `pwAsOf()`, `pwNotifItems()`, `pwChipsHTML()`, `pwLineHTML()`, `calTargetOn()` |
| Agents' summary | `intelSummary()` (DELTA, ECHO and ZULU via `agBaseContext()`; not CHARLIE, which gets `svSheet()` / `svContextLine()` instead) |
| What the agents see | nightly `agCalendarContext()` (shares `agCalDayLine()` / `agCalPlanLine()` / `agCalNextDays()` with chat's `agTodayContext()`), `agSplitLiftText()`, `agFeelLine()`, chat `agLastNightLine()`; events `agEvents()` / `agEventsLine()` (`EV_FOR`, `EV_DAYS`), tools `get_events` / `get_recovery` |
| Cross-review & volume | `agVolumeLastBlock()` / `liftHardShare()` (`VOL_GRIND_PCT`); `agTonightRequests()`, `agHoldSpecLine()`, `agValidateHolds()`, `agApplyHolds()`, `agShowAnyway()`, `agHeld()` |
| Roundtable & voices | `AG_VOICE`, `S.agents.roundtable` (`agRoundtable()`, `RT_*`), `agPeersOffered()` / `agPeersSaid()`, `agValidatePeer()`, `agValidateReplies()`; the feed `agLog(agent, text, {to})` + `_agLogRun`, `hubFeedHTML()` / `hubActHTML()` |
| The Desk | `S.agents.desk` (`DESK_*`, `DESK_SERIES` / `DESK_SERIES_FOR`), `deskSpecLine()`, `agDeskLine(id)` (`{txt, ids}`), `agValidateDesk()`, `agDeskIngest()`, `deskSeriesPts()` / `deskSparkSVG()`; its Hub tab `#desk` / `renderDesk()` (`hubDeskHTML()` / `deskItemHTML()`), `deskHide()` / `deskToggleAll()` (`deskAll`) |
| Lift reference | `LIFT_FACTS`, `liftFactFor()`, `agLiftRefLine(id)` (DELTA and ZULU, nightly and chat); `musclesFor()` |
| Pattern engine | `effRpe()`, `rpeTargetFor()`, `feltVsPlan()`, `recoveryBaseline()`, `whoopOn()`, `whoopResponse()`, `dayCall()`, `callTier()`, `liftProfile()`, `muscleResponse()` |
| Today's call | `_startLiveNow()` (sets `live.call`), `liveCallHTML()`, `liveCallToggle()`, `dayCallCardHTML()`, `liveEffectiveCall()`; set counts: `exSlotSets()`, `cycleSets()`, `setCount` fix; pre-workout strain `whoopStrainNow()`, `strainTier()` (`STRAIN_HIGH` / `STRAIN_ALLOUT`), `strainPreWorkout()`, `strainDropIdx()` (`live.callDrop` → `logRec.callDrop`), `whoopStrainKick()` / `strainKickDue()` / `strainRefresh()` |
| Effort lever | `effBucket()`, `effLever()`, `effMean()`, `EFF_ANCHOR` |
| Home / strip | `renderHome()` (`todayKeyLifts()`, `todayPlanShape()`, `nextPrForecast()` = the soonest of `nextPrForecasts()`, stepped with `nextPrStep()` / `nextPrPick`, `agStripState()`, `homeWheelHTML()`), `renderStatusStrip()`, `readinessNow()`, `renderNotif()` (`notifDismiss()` one item, `notifClear()` all) |
| Pain flags | `painAdd()`, `painFor()`, `painContext()` |
| Bench Practice | `S.practice` (`BP_*`), `practiceState()` / `practiceRows()` / `practiceSetsFor()` / `practiceBestE1RM()` / `practiceVolInto()`, `bpSuggest()`, `bpAdvice()`, `bpPlan()`, `bpCardHTML(where)` (`bpOpen`, `bpDraft`), `bpStart()` / `bpAddSet()` / `bpSave()` / `bpDelete()`, `agPracticeLine()` |
| WHOOP | `applyWhoop()`, `whoopFresh()`, `whoopProvisional()`, `whoopContext()`, `whoopMaybeKick()` and `whoopStrainKick()` (one POST, `whoopDispatch()`), `briefWhoopDrift()`, `S.whoop.history`; a failed run: `S.whoop.relayError`, `whoopRelayFault()`, `whoopRunFailText()`; `scripts/whoop/whoop-sync.js` (`todaySections()`, `carryForward()`, `historyRows()`, `mergeHistory()`, `spendRefresh()`, `relayErrorRecord()`) |
| Photos | `photoState()`, `photoDownscale()`, `photoLoadAll()`, `photoSaveAll()` |
| Bulk rate | `bulkRate()`, `bulkBand()` — the ONE bodyweight rate; every lb/wk figure comes from here |
| Live session | `renderLive()`, the dock (`intraAdvice()` aim and why, `liveStep()`, `liveLogLabel()`, `livePrWatch()`, `liveFinishEstimate()`, `liveWakeApply()`, quick chips `liveShortOnTime()` / `liveRecoverRest()`), gear `liftLoad()` / `plateCalc()` / `gearLine()` / `plateChange()`, `liveDeltaSend()`, `liveSetToLog()` (the one set copy into `S.logs`); `liveKeepInputs()` / `liveRestoreInputs()` (typed values survive a repaint); `loadLiveDraft()` (`LIVE_DRAFT_MAX_H`, a session past midnight survives); `liveRecoverStale()` (a session never ended is saved at the next boot) |
| Data corrections | `DATA_FIXES`, `dataFixesRun(pulled)`, `dataFixApply()`, `S.dataFixes`; `autoPullOnLoad()` returns whether the pull worked |
| Backup | `exportPayload()` / `importApply()`, `DEVICE_SECRETS` (a backup file carries no credentials; import keeps this device's) |
| After a session | `sessionSummary()`, `showSummary()`, `sessionMetaSet()` / `sessionMetaFor()` (`S.sessionMeta`), DELTA's debrief: `agDebriefTarget()`, `agSessionDetail()`, `agValidateDebrief()`, `agDebriefRecent()` |
| Investigation | `investigateLift()`, `invActiveFlags()`, `invUpdateBadge()`, `invTipsFor()` (the WHAT TO DO bullets on a flag card, derived from the title at render, never stored); resets `invOverrideFor()`, `invOverrideState()`, `invResetRecord()`, `RESET_HOLD_SESSIONS` |
| Agent questions | `qaDue()`, `qaTurn()` / `qaOfferTo()` (`QA_ORDER`), `qaSpecLine()`, `agValidateQuestion()` / `qaSimilar()`, `qaIngest()`, `qaOpen()`, `qaAnswer()` / `qaSkip()` / `qaUndo()`, `qaContextLine()`, `qaCardHTML()`, `qaHubHTML()`, `S.agents.questions` |
| Track records & diagnosis | `agOutcome()`, `agTrack()` / `agTrackText()` / `agTrackLine()`, `hubTrackHTML()`; `pdTargets()`, `pdContextLine()` / `pdSpecLine()`, `agValidateDiagnosis()`, `pdReadHTML()`, `S.agents.diagnoses` |
| Server runner | `runnerTick(mode)` / `runnerFlush()` (driven by `scripts/agents/run.js`), `runnerHeadless()` (`IRONHUB_HEADLESS`), `runnerSeen()` / `runnerClockAlive()` / `runnerGraceLeft()` (`S.agents.runner`, `autoAt`, `RUNNER_GRACE_MIN`, `RUNNER_CLOCK_HOURS`), `runnerHealth()` / `runnerClockNote()`, GitHub's record `runnerClockCheck()` / `runnerClockJudge()` / `runnerClockFault()` / `runnerClockNotif()` (`_runnerClock`, `RUNNER_NIGHT_SLOTS` / `RUNNER_MORNING_SLOTS`, `runnerWatched()`), Reload `briefReload()` / `briefReloadState()` / `briefReloadNote()` (`_briefReload`, `RUNNER_WORKFLOW`); `clock/src/worker.js` (`plan()`, `easternSlot()`, `tick()`) |
| Agents | `agRunAll()`, `agValidateFix()` (`AG_FIX_ALLOWED`, `agResetCeiling()`; `agValidateFixShape()` then `agConflict()`), `agApplyFix()`, `agApprove()`, `agSendChat()`, `renderOps()` (the Hub: `hubFed()`, `hubStatus()`, `hubMapHTML()`, `hubAgentHTML()`, `hubSpendHTML()`), `coachValidateAction()` |
| Chat actions | `CHAT_LANES` / `CHAT_ALL` / `chatActionsFor()`, `coachToolDefs(agent)`, `coachValidateAction(name, inp, agent)`, `coachExecuteAction()`, `coachStageProposals()`, `coachFindProposal()`, `coachApplyProposal()`, undo `coachUndoProposal()` / `chatUndoStore()` / `CHAT_UNDO_KEYS`, `chatHistoryMsgs()`; every chat's context and loop `chatContext()`, `agTodayContext()`, `chatActionRules()`, `chatActionHandler()` (`refused`); today-only `S.todayAdjust`, `todayAdjFor()` / `todayAdjApply()`, `liveTodayAdjRebuild()`, `todaySessionNames()` / `liveSessionNames()` |
| Exercise names | `exSplitNote()`, `exResolveKnown()`, `exAcceptName()`, `agResolveExName()`, `exRenameEverywhere()` |
| API usage | `aiUsageNote()`, `aiUsageSummary()`, `aiUsageCardHTML()`, `AI_USAGE_KEY`, `AI_PRICE`; `aiReachNote()` for a blocked network; the cap: `spendLedgerSync()` (`S.spend`), `spendMonth()`, `spendBlock()`, `spendPreflight()`, `spendManualOk()`, `spendCap()` |
| Deload | `deloadWindow()`, `deloadActive()`, `lastDeloadEndKey()`, `deloadCheck()`, `startDeloadWeek()`; alerts off `S.deloadQuiet`, `deloadQuietUntil()` / `deloadQuietSet()` / `deloadQuietBtnHTML()`, `agFixMenu()`; the norm `fatigueIndex()` (`FI_NORM_*`) |
| Analytics | `renderAnPred()`, `anEnsembleFor()`, `e1rmSeries()`, `linreg()` |
| Forecasts | `FC_KINDS_FOR` / `FC_KIND`, `fcAskCheck()`, `fcContext()` / `fcEngine()` (`fcLine()`, `fcScan()`), `fcSystem()` (`FC_RULES`, `fcMemoryLines()`), `fcRun()` (`_fcRunning`), `fcValidate()` / `fcMakeRow()`, `fcResolve()` / `fcPlanHeld()` / `fcStatus()`, `fcRecord()`, `fcTrackLine()`; the tab `renderForecasts()` / `hubForecastsHTML()` (`fcDraft`, `fcAgent`), `fcRate()`, `fcRemove()`, `fcAgain()`, `fcPrefill()` / `fcFromGoal()`, `fcNotifItems()`; `S.forecasts`, `S.forecastRatings` |
| Projections | `anFanProject()` (shared core; one day of it is `anFanStartDay()` / `anFanPoint()`, one date `anFanAt()`), `anFanChartSVG()` (curves via `ckSmoothD()`, round ticks `ckNiceStep()`, drawn series `anFanDrawSeries()`, key `fanLegendHTML()`), `anFanMilestones()`, `bwProjectFor()`; the hero's marks `ckMarks(…, {rail})` (`ckRailMerge()`), `ckMarkKeyHTML()` |
| Sunday check-in | `wpWeekFor()`, `wpStage()`, `wpCardHTML()`, `wpSubmit()`, change: `wpEdit()` / `wpEditCancel()` / `wpEditableWeek()` / `wpFormWeek()`, `wpRun()` (route `weekplan`), `wpFilterProposals()`, `wpContextLine()`, `S.weekPlan` |
| Experiments | `EXP_TEMPLATES`, `expState()` (`S.experiments`), `expValidate()`, `expStart()`, `expSessions()`, `expScore()` / `expTrend()`, `expEvaluate()`, `expTick()`, `expStop()`, `expAnswer()`, `expMenuLine()`, `expCardHTML()` |
| Prediction record | `predTick()` (`S.predictions`), `predLifts()`, `predTopsets()`, `predResolve()`, `predRecord()`, `predRecordCardHTML()`, `predIntelLine()` |
| Overload status | `olSignals()`, `olBaselineVerdict()`, `olValidateReport()`, `renderAnOverload()` |
| Exercise swaps | `swapScore()`, `swapPattern()`, `swapEquip()`, `swapCandidates()`, `swapListHTML()` |
| PR history | `checkPRs()`, `prAppend()`, `prBackfill()`, `renderAnPRs()` |
| Readiness | `todayReadiness()`, `rdComplete()`, `readinessNow()`, `anReadinessOutcome()`, `anReadinessTrim()`, `renderAnReadiness()` |
| Bulk quality | `anBulkQuality()`, `anBqLifts()`, `anDualSpark()` |
| Fuel | `renderFuel()`, `fuelTimingHTML()`, `fuelClockFrom()`, `fuelFoodAllowed()`; targets change only through `fuelTargetSet()`, which logs `S.targetHist` (`fuelTargetHistory()`) |
| Family pantry check | `famShareLink()` / `famShare()` / `famOut()`, `famFamilyPage()` / `famTick()` / `famSend()`, `famValid()`, `famDiff()`, `famShowReview()` / `famApply()`, `famRoute()` / `famReviewFromHash()` / `famCopyPage()` / `famPaste()`; the drop box `FAM_DROP_URL`, `famBoxId()`, `famSubmit()`, `famInboxCheck()` / `famInboxOpen()` / `famInboxDone()` (`_famInbox`, `S.fuel.famDone`); the boot is `appBoot()` |
| Fuel planner | `FOOD_DB`, `fpFoods()`, `fpPool()`, `fpCombos()` / `fpBuild()`, `fpStockDue()`, `fpCheckFood()`, `fpSetStock()` / `fpSetPref()` / `fpTidy()`; ECHO: `fpToolDefs()`, `fpPlannerText()` (a new food from chat is the `add_food` card) |
| Live refresh | `rerenderActive()`, `bgSyncTick()`, `opsSignature()`, `refreshBlocked()` |
| Nav shell | `renderSidenav()`, `navDrawerSet()` (`navDrawerOpen`), `navCollapseToggle()`, `showMainTab()` (`_navEnter`, `navEnterAnim()`), `smoothScroll()` |
| Muscle map data | `bmViewerData()`, `bmStatusFor()`, `bmWeeklyVol()`, `bmTrainedDays()` |
| 3D viewer | `bm3dInit()`, `bm3dBuild()`, `bm3dApply()`, `bm3dPick()`, `bm3dDispose()`, `bm3dFallback()` |
| Discord view | `discordView()`, `discordViewFile()`, `syncFiles()`, `DISCORD_VIEW_FILE`; Worker in `discord/src/` |
| Schedule doc | `gdocWeekModel()`, `gdocDay()`, `gdocStatusFor()`, `gdocPush()`, `gdocCfg()`, `gdocCardHTML()`; Apps Script in `scripts/gdoc/workout-schedule.gs` |

**Agent system:** four agents — ZULU (lead), CHARLIE (the supervisor: showing up, logging, logistics,
schedule), DELTA (training), ECHO (nutrition/bodyweight). Model: `claude-sonnet-5`, declared once as
`AI_MODEL`.

**CHARLIE is the supervisor** (his ask, 2026-10-19: "make sure I am not slacking, falling behind logistically"). It
used to have the schedule alone, with one fix shape he almost never wants, so most nights it said the schedule was
fine. `svSheet(t)` is pure and computes what a supervisor checks; `svContextLine()` puts it in CHARLIE's nightly
prompt and its chat only ("SUPERVISOR'S SHEET"), so no other agent pays for it:
- the last `SV_DAYS` (14) against the plan, today never a miss; a day he trained is judged by its log's `scheduled`
  (what was planned then), a missed day by the schedule as it stands now; rest-day sessions; a day trained as another;
- a weekday missed at least twice and half the time over 4 weeks, the one finding a schedule fix answers;
- this week from Monday, the streak, start times against `S.fuel.workoutTime` (`SV_LATE_MIN`), and length against
  each day's own usual (the density rule);
- the books: last weigh-in, intake days, check-ins and effort taps on sessions, sessions never ended, WHOOP days;
- what waits on him (requests and the oldest, the question, the stock check, the Sunday check-in), the week he
  described against what happened, and the plumbing (the relay's note, this device's sync, the month's spend).

It changes no fix shape: CHARLIE still proposes only `schedule` / `cycleSchedule`. The brief says a day he tagged on
Sunday is not slacking, and a slip is raised once.

Nightly at 9 PM, CHARLIE/DELTA/ECHO run **in parallel**, each with its own prompt and its
own allowed fix shapes (`AG_ROLE_BRIEF`, `AG_FIX_MENU`), then ZULU runs on their output and
also writes the Daily Brief. One agent failing costs only that agent. Parallel is deliberate:
sequential would make "Run cycle now" a 2–3 minute wait, and the cost is that the three
cannot share a prompt cache — a cache entry is only readable once the response that wrote it
has begun streaming. Do not add `cache_control` here; it would charge the 1.25× write premium
for a cache nothing reads.

Agents have **read-only data tools** (`agDataToolDefs()`, executed by `agRunDataTool()`,
looped by `callClaudeWithData()`): `list_lifts`, `get_lift_history`, `get_e1rm_series`,
`get_bodyweight`, `get_nutrition`, `get_readiness`, `get_weekly_volume`, `get_events` and `get_recovery` (the last
two since 2026-10-16, his call). ECHO also gets
`get_fuel_planner` and `plan_fuel_combos` (`fpToolDefs()`, through `opts.fuelTools`), in its
nightly check and its chat, and so does ZULU's chat, which can change the pantry. Both are reads, and the second runs the tab's own `fpCombos()`.

**The agents review what happened** (his ask, 2026-10-16: deloads, high and low calorie stretches, dips, and
conclusions drawn from them).
- **`agEvents(days, kinds)` holds the events**, with the app's own before/after numbers. The events are:
  - the chart marks (`ckEventMarks()`);
  - dips on the main lifts (`liftDips()` over `predLifts()`);
  - PRs and finished experiments.

  The numbers are:
  - **deloads:** the median clean e1RM of the 3 sessions before against the first 2 after;
  - **target changes:** the bodyweight pace for the 3 weeks before against the weeks since, "too few to lean on"
    under `FVR_FIRM_WEEKS`;
  - **a shifted week:** what he ate against the two weeks before, and the weekly bodyweight around it;
  - **heavy weeks:** recovery and dips the week after;
  - **slumps:** recovery against his usual, read from before the slump;
  - **dips:** the top `plateauCauses(…, {asOf:true})` factor, and whether the next session got back.

  `agEvents()` only reads. HOW SURE TO SOUND forbids an effect size the app has not computed, so the app computes the
  ones worth asking about.
- **`agEventsLine(id)` puts 10 weeks in the prompt** (nightly and chat), capped at `EV_MAX_CHARS`, with one rule: draw
  a conclusion only when these numbers support it.
  - It is filtered by `EV_FOR`: DELTA training events, ECHO calories and deloads, ZULU everything, CHARLIE none.
  - An experiment goes only to its owner and ZULU.
  - With no events there is no section.
- **`get_events {weeks ≤52, kinds}` looks further back** through the same function.
- **`get_recovery {days ≤180}` is WHOOP history**, plus his usual. It never includes a row dated today: history is
  never today.
There is no write tool and there must never be one: a tool call never changes state by itself.
**The chats propose action cards** (Mark's call on 2026-10-06, replacing ECHO's queue-only
`propose_fuel_food` from 2026-09-28). He asked for all four agents to be able to act from chat,
with every card needing his tap:
- **Each agent proposes only in its own area** (`CHAT_LANES`; ZULU has `CHAT_ALL`, 23 actions; every lane also has
  `offer_forecast`, which only fills the Forecasts form, see Forecasts below).
  `coachToolDefs(agent)` offers only those, and `coachValidateAction(name, inp, agent)` refuses
  anything else first, so a tool another agent owns is not even a tool it has.
  - DELTA: the split, today's workout and today's session, deloads, a lift's next weight, sets, modes, experiments, notes.
  - ECHO: fuel targets, stock, likes, a new food, workout time, experiments, notes.
  - CHARLIE: the schedule or cycle order (never the anchor), the segment length, renames, home day,
    notes.
- **Every check is one that already exists.** A weight is a `liftReset` through `agValidateFix()`
  (so `agResetCeiling()`), sets are a `setCount` (a block day goes through `agConflict()`), a food is
  `fpCheckFood()`, the schedule keeps its mode gate, an experiment is `expValidate()`, a rename is
  `exRenameBlocker()`. A refusal is told to the agent ("Not proposed: …") and no card is shown.
- **A call only stages a card.** `callClaudeWithData()` hands `opts.actions.onCall` the call, never
  `agRunDataTool()`. At most `CHAT_CARDS_MAX` (3) a reply. The reply and its cards are written into
  the re-resolved `agState()` after the await (the suite swaps `S` mid-reply to prove it). Night
  routes carry no action tools.
- **His tap checks it again** (`coachApplyProposal()`). What a card stores must pass the same check
  a second time: the food cards once dropped the field the check reads, so every stock card failed
  at the tap. The suite loops every kind to keep that true.
- **Undo is same-day, this device** (`chatUndoStore()` in `localStorage['ironhub:chatundo']`, never
  in `S`). It snapshots the keys in `CHAT_UNDO_KEYS` and refuses once any of them has changed since,
  because putting an old copy back would erase that change too. A rename has no undo, and its card
  says so.
- Applied and undone cards leave a line in the agent's feed, and `chatHistoryMsgs()` tells the model
  what became of each card. Changes from chat are not proposals, so track records do not score them.

**Every chat knows today, and is not finicky** (his report and ask, 2026-10-10). In a real chat ZULU asked
him which day it was, did not know a deload already runs 2 sets, put three "for today's deload" changes into
his D3 for good, said "Hip Thrust Machine set to 2 sets now as well" above a refused card, and turned "all
five" into four cards with no word about the fifth. ZULU's chat had only his profile and logs, no lookups,
and wrote its reply in one round before any check ran.
- **One context for every chat** (`chatContext(id)`): memory, `trainingContext()`, `agContext()`, the
  computed summary (not CHARLIE, as at night), the track line, his answers, and **TODAY**
  (`agTodayContext(id)`). TODAY states the day key and name, the plan segment and its day, the deload and
  that LIVE already gives 2 light sets, the split in force, what LIVE will give lift by lift (through the
  same `buildOneLiveExercise()`), what is logged or running, the locks per lift, and the next 5 days. Each
  line is guarded and nothing in it writes. TODAY itself is chat-only; the night gets the CALENDAR below.

**The nightly agents see what he sees** (his report, 2026-10-16: the agents did not always know the schedule, today,
or data on his own screen). All of it is read-only context on calls that already run:
- **The night has a CALENDAR** (`agCalendarContext()`, all four agents, through `agBaseContext()`). It covers today's
  key and whether it is logged, a HOME day, the plan segment (with a deload ended early), the next 7 days and the
  plan's next two segments. Its day, plan and next-days lines are the ones chat's TODAY uses (`agCalDayLine()`,
  `agCalPlanLine()`, `agCalNextDays()`), so the two cannot disagree.
- **SPLIT carries the numbers** (`agSplitLiftText()`): "Bench Press 3x5-8", from the slot's sets and `exRepMode()`
  (Form Focus its own). DELTA used to propose a `setCount` without seeing the count.
- **`intelSummary()` carries the plateau watch** as Today and the Hub colour it, red then amber, at most 8 lifts.
- **His own read after sessions** (`agFeelLine()`, his last 5 notes within 21 days) goes to DELTA and ZULU, at night
  and in chat.
- **The chats know last night** (`agLastNightLine()`): each agent's own report, and for ZULU all four plus the
  morning brief.
- **A paid call's pre-pull pushes first.** `agConfirmGateThenRun()` and `agConfirmBriefThenWrite()` call
  `pushUnconfirmedChanges()` before asking `exportedAt > changedAt`, exactly as `bgSyncTick()` does. Before this, an
  unpushed local save hid an unseen snapshot, and the cycle or brief ran without the other device's session.
- **One loop and one handler** (`chatActionHandler()`): ZULU's chat now uses `callClaudeWithData()` like the
  others, with lookups and the pantry tools. A call only stages a card. A refusal is told to the model
  ("Not proposed: …", plus "adjust_today works on any lift" where that applies) and kept on the reply as
  `refused`, shown as a "Not changed:" line under it, escaped, and fed back by `chatHistoryMsgs()`. Past
  `CHAT_CARDS_MAX` the rest is refused out loud, never dropped. `chatActionRules(id)` is the shared wording.
- **`set_sets` is one card for every lift named**, and says **permanent** ("Every D3 from now on: …"),
  adding during a deload that the deload already runs 2 light sets. A lift that fails is listed on the card
  as left out, with its reason. A lift on two days with no day named takes the day the rest of the request
  names, else today's, else asks. One Undo covers the card.
- **`adjust_today` changes today only** (`S.todayAdjust {date, lifts:{name:{sets, w}}}`), DELTA and ZULU.
  It **overrides resets, Investigation flags and experiments** (his call): those protect the program, and
  this never touches it. Sets 1-5. Weight keeps the queue's ceiling (`agResetCeiling()`), and a lift with no
  logged weight takes none (a model's guess would go to the rack; the box in LIVE is the place). Lifts must
  be in today's session (`todaySessionNames()`), not started in LIVE, on a day that is not rest or already
  logged.
  - It reaches LIVE in one place: `buildOneLiveExercise()` wraps `buildOneLiveExerciseBase()` with
    `todayAdjApply()`, so the start, `liveTodayAdjRebuild()` mid-session (and on Undo), Today's key lifts
    and plan line, and TODAY all agree. A changed weight records decision `chat-today`.
  - The log carries `todayAdj` (lifts changed and trained), and `sessionMods().todayAdj` makes
    `sessionModLift()` read them as shaped, so predictions and experiments leave them out.
- **Permanent changes keep every rule.** A reset or an open Investigation flag still blocks a permanent
  set change (his call: keep it); the refusal points at `adjust_today` for today.

Do not add a tool that writes without his tap. The loop is bounded by
`AI_TOOL_ROUNDS` (6, or 2 for mid-workout DELTA) with results capped at `AI_TOOL_MAXCHARS`,
because it runs unattended and an unbounded loop is an unbounded bill.

**Sonnet 5 thinks adaptively, and thinking tokens bill as output and count against
`max_tokens`.** Two consequences to keep in mind when touching any API call: never set a
`max_tokens` low enough for a long think to swallow the answer (nothing in the app is below
4000, and the suite asserts it), and control spend with `output_config.effort`
(`AI_EFFORT_DEFAULT` is `medium`; the nightly cycle raises CHARLIE, ECHO and ZULU to `high`,
while DELTA runs at `medium` per `AG_NIGHT_EFFORT`, for the reason below) rather than by
starving the cap. `temperature`, `top_p`, `top_k`, `budget_tokens` and assistant prefills all
return a 400 on this model — none are used, and the suite asserts that too.

---

## Hard rules for the agent layer

**Agents never mutate state silently.** Every change a model suggests needs Mark to tap
something. The nightly queue applies only through `agApplyFix()`, after `agApprove()` has run
`agValidateFix()` on it a second time (a proposal can wait a week, and the split or a lift's weights
can change under it). This used to say `agApplyFix()` was the *only* write path, and it was not.
These are the others, all tap-to-apply:
- every agent's chat cards (since 2026-10-06; ZULU's before that), which go through
  `coachValidateAction()` → `coachExecuteAction()`, each agent only in its own lane
- Investigation's Apply fix (`invApplyFix()`)
- the fatigue banner's Start deload (`startDeloadWeek()`)
- meso split approval

The weekly audit (`maybeRunAudit()` / `acceptProposal()`) was one of these until it was retired on
2026-09-28: a paid call every training week whose card only rendered into the hidden V1 `#today`,
and whose Accept wrote the split without `exAcceptName()`. `audit` is in `REMOVED_STATE_KEYS`.

Since 2026-09-25 the chat path shares the queue's limits: calorie and protein bounds, and
resolved exercise names. Before that, `adjust_fuel` accepted any number at all. Do not add
another side path. If one is unavoidable, it gets the same checks.

**`agValidateFix()` is a security boundary.** It whitelists fix types, clamps
numeric ranges, and rejects anything malformed. Never loosen it to make a model's
output "work." If a model produces something invalid, the correct behavior is to
discard it, not to coerce it.

Five rules it enforces:
- **Each agent may only raise its own fix types** (`AG_FIX_ALLOWED`: CHARLIE schedule, DELTA
  lifts, ECHO intake and `fuelFood`; DELTA and ECHO `experiment`, each only its OWN templates; ZULU
  any). The menu in the prompt was the only thing
  stopping ECHO queueing a `liftReset`.
- **A `fuelFood` is judged by `fpCheckFood(p, true)`.** It must be a plain name with no notes or
  numbers in it, and nothing already on his list. Category and tags come from the fixed sets,
  ranges are tight, and 4P+4C+9F must be within 35% of the stated calories. Nothing on his
  exclusion list or near a food he said no to or hid, and no more than 60 of his own foods.
  Approving only adds it to his list. It is not liked or stocked, so no plate uses it until he
  says so.
- **A `liftReset` has a ceiling** (`agResetCeiling()`). It can be at most two increments over
  the last top set. A MAXED machine, or a lift flagged "sharp" in the last 14 days, gets
  nothing over its last weight. Those two rules used to exist only as prompt text.
- **`addEx`/`swapEx` names are resolved** (`exAcceptName()`). `swapEx.from` must be in the
  permanent split.
- **The refusal names its reason** in the activity log (`agRejectReason(fx, who)`).
- **A rejection is enforced, not just remembered.** `agIngest()` does not re-queue a byte-identical
  fix (`agFixKey`) he turned down within `AG_REJECT_QUIET_DAYS` (14), and logs that it did not.
  Different numbers are a different call and still come through.
- **A well-formed fix can still collide** (cross-review, the code half, 2026-10-03). `agValidateFix()`
  is `agValidateFixShape()` followed by `agConflict()`, which only ever refuses:
  - no `deload` while one is in force, or within `AG_DELOAD_NEAR_DAYS` (14) of a planned meso deload
    (`agDeloadBlock()`);
  - no `setCount` on a lift under a reset, with an open Investigation flag, or under a running
    experiment;
  - no `setCount` increase or `addEx` next to a "sharp" flag from the last 14 days on that lift or one
    sharing a primary muscle (`agSharpNear()`); taking sets off is still allowed;
  - no `liftReset` or `swapEx` on the experiment's lift;
  - **volume last** (`agVolumeLastBlock()`, his call, 2026-10-18): no `setCount` increase on a stalled lift
    (`liftProfile().stalled3`, or the plateau watch red or amber) whose last 6 sessions have `VOL_GRIND_PCT` (30)%+ of
    their tagged sets at grind or fail (`liftHardShare()`, the one grind-share measure, with at least
    `VOL_GRIND_MIN_TAGS` tags). DELTA had queued a 4th set on a stalled Cable Row whose sets were a third grinders,
    because the stall line listed "more sets" first. That line now orders the levers: effort and recovery, then the
    rep range or a smaller jump, then a variation, and more sets last. It covers the queue, approval, chat `set_sets`
    and the Sunday plan; `adjust_today` is exempt.

  A `setCount` is one target per lift and day (`agFixTarget()`). It used to be plain `setCount`, so a set change for
  one lift superseded a waiting one for another.

  These used to live only in the Sunday plan's filter or in prompt text. They apply at ingest and
  again at approval. ZULU's chat (`start_deload`, `add_exercise_permanent`,
  `swap_exercise_permanent`) shares them, and `agRejectReason()` names the rule that fired.

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

**A coaching note is not part of a name.** On 2026-09-12 ZULU's today-only plan stored
"Barbell Back Squat (reduce top set 15-20 lb, 3x10, RPE 7)" and three names like it as the exercise
names. Their sets were cut off from each lift's history, and the squat that day was "first time
logging this lift". `exSplitNote()` peels off a trailing parenthetical that reads like instructions
(numbers, lb, RPE, sets, reps, weight), and leaves a real variant like "(Wide Grip)" alone.
`exResolveKnown()` then maps the name to the app's spelling. `exAcceptName()` also admits a new
exercise that reads as a plain name, because suggesting one is part of DELTA's job. The note
itself travels in `S.coachDayPlan.notes` and shows as LIVE's advice line. The four Sep-12
entries are still in his logs. Merge them with the Library's rename (`exRenameEverywhere()`), not
a load-time migration. **But not the Lying Leg Curl one yet** (checked against his data, 2026-10-10): "Lying Leg Curl (reduce 10-15 lb,
RPE 6-7)" holds 25 x 12 per side, and the per-side correction (`DATA_FIXES`) matched only the exact name, while its
neighbours now read 70-90. Merged as it is, it would land a fake half-weight dip in that lift's history. It needs
its own doubling first (a new `DATA_FIXES` entry for that exact name, through 2026-09-12), which is his call.

**A screenshot import resolves its names too** (`shotExName()`, 2026-10-10): a known lift in its own spelling, a
coaching note stripped, anything else kept as read (a variant like "(Barbell)" stays), and two rows for one lift
merged into one entry. `confirmShot()` used to save whatever the model read off the image.

**Agents coach, and say how sure they are** (his report, 2026-10-14). Asked when he would bench 205 and 225,
ZULU wrote about "him", opened on a wall of stats, read the weekly intake-vs-results groups as daily
correlations, said five low days "alone could be costing him months", and built a 5-14 month timeline by
hand without asking whether 205 meant a single. Four small changes, all prompt text or summary labels:
- `agSharedBrief()` says lead with the call, back it with one or two numbers, and call him "you". It used to
  say "Be specific and numeric. Cite the actual figures", which is the readout voice by instruction.
- `agEvidenceRules()` ("HOW SURE TO SOUND"), in every agent prompt and ZULU's chat: an observation is not a
  cause; no effect size or timeline the app has not computed; 1RM or working weight first; under ~6 weeks is
  an early pattern; check the scale before blaming food; "research shows" only for settled principles.
- `chatVoiceRules()` ("HOW TO ANSWER"), in all four chats: call first, at most two numbers, one next step, and
  a method rather than a guessed weight for a lift with no history. ZULU no longer calls itself
  "evidence-based" or is told to "give specific weights, reps, set counts, and food amounts".
- The summary's intake line says WEEKS, the week count, "too few to lean on" under `FVR_FIRM_WEEKS` (6), and
  that it is not a cause. Effort reads `effScoreText()`: "a grind (40/100)", because a bare "effort 40" came
  back as "40% effort".

**The agents talk to each other, at no new cost** (his pick, 2026-10-16: "make the agents more unique, with
discussions"). It all rides the calls that already run.
- **Each agent has its own voice** (`AG_VOICE`, one line after the role brief in every prompt it writes in: nightly,
  chat, and ZULU's letter and brief). His pick of three drafts was "as drafted":
  - ZULU: a calm, decisive head coach;
  - CHARLIE: dry and exact;
  - DELTA: a blunt strength coach;
  - ECHO: practical about food.

  Every line ends with "Your voice never changes the facts". No voice text says "You are <another agent>", because
  the suite's stubs route on that phrase.
- **The roundtable** (`S.agents.roundtable {d, at, said, lines}`) is one object per cycle.
  - It is written into the re-resolved `agState()` after the specialists, then again after ZULU (the suite swaps `S`
    mid-reply to prove it), and merged newer-wins in `applyPulled()`.
  - A night where every specialist failed leaves the last one standing.
- **The specialists** read last night's roundtable (`agPeersSaid()`, within `RT_FRESH_DAYS`): the others' summaries
  and any line addressed to them.
  - They may answer ONE agent in an optional `"peer"` key, asked for only when there is a roundtable to answer, so a
    first night is byte-identical. It sits before `qaSpecLine`, so the plateau diagnosis stays last.
  - `agValidatePeer()` keeps only a string to an agent it was shown (never itself), clipped.
  - `agRecentSaid()` is still own-only; this is a separate section.
- **ZULU closes the night.** Its digest carries tonight's replies and each waiting request's reasoning. Its
  `"replies"` key is one line to each specialist that reported (`agValidateReplies()`); a line for an agent that did
  not report is never kept.
- **The feed shows a night as one exchange.** `agLog(agent, text, {to})` tags every line of a cycle with `run` and
  `n` (`_agLogRun`, module-scoped, cleared in `finally`), and `hubFeedHTML()` groups a run under "Nightly cycle" (or
  "Cycle you ran") in the order said. A reply is drawn as author glyph, then `→ E`. Lines outside a cycle render
  as before.
- **The roundtable is commentary.** It changes nothing, and anything to apply still goes through proposals.

**The Desk: the agents' board in the Hub** (his ask, 2026-10-21: "agents make their own summaries and create their own
graphs", then "the graphs can be smaller and more static... where agents note things, communicate directly with each
other, and more"). It rides the calls that already run, like the roundtable.
- **One optional `"desk"` key**, offered to all four every night (`deskSpecLine()`; in the specialists' spec before
  `qaSpecLine()`, so `pdSpecLine()` stays last, and in ZULU's beside `agHoldSpecLine()`). Up to `DESK_PER_NIGHT` (2)
  items: text, an optional title, `to` another agent, `re` an item it was shown, a `chart` spec and an `event`.
- **A chart is a spec, never numbers.** `{series, lift?, group?, weeks}`, the series only from the agent's own area
  (`DESK_SERIES_FOR`: DELTA e1rm / sets / recovery, ECHO bw / cals / protein / sleep, CHARLIE sessions / sleep / strain,
  ZULU any). `deskSeriesPts()` reads his data when it draws (weekly series stop at the last complete week, or the week
  in progress reads as a drop); `deskSparkSVG()` is small (280×70) and static: no hover, no axes. Under 2 points the
  chart is left out and the note still shows.
- **`agValidateDesk()` is the gate:** strings clipped (`rtClip`), a lift through `agResolveExName()`, a group from
  `MUSCLE_GROUPS`, weeks clamped 2-26, an event inside `EV_DAYS` and at most `DESK_EV_SPAN` (28) days, `to` never itself,
  `re` only an id it was shown (`agDeskLine(id).ids`, taken before the await like `_rtPeers`; a reply is to the item's
  author). A bad chart or event is dropped and named in the feed line; the note is kept.
- **A flagged event is the agent's read.** It is drawn only on its own item, never among the chart marks
  (`ckEventMarks()` never takes a model's input), and the other agents see it the next night as theirs.
- **What each agent is shown** (`agDeskLine(id)`, `DESK_DAYS` (14), at most `DESK_LINE_MAX`): items to it, events the
  others flagged, each other agent's newest observation (an item addressed to a third agent is not shown), and its own
  last post so it does not repeat it. Nothing on the Desk means no section, so a quiet Desk costs nothing.
- **Stored** in `S.agents.desk`, newest first, capped at `DESK_KEEP` (24), written into the re-resolved state after
  each await (`a2`, then `a3` for ZULU; the suite swaps `S` on every call), merged by id in `applyPulled()`. An item
  never changes except to be hidden: **Hide** is his tap (`save()`), and a hide wins on a pull.
- **It is its own Hub tab**, Desk, after Agents (his ask, 2026-10-21: "a new category inside the hub, like
  Agents and Flags"; Forecasts sits between it and Flags since 2026-11-03): section `#desk`, `renderDesk()` (`REVIEW_RENDER.desk`, `NAV_LEGACY.desk`), not on the Agents view.
  `hubDeskHTML()` opens on one line saying what it is, then last night's roundtable lines, then up to `DESK_SHOW` items
  with each reply under what it answers. A post or a hide is a `save()` or a pull, which moves `changedAt`, so
  `tabSignature()` already repaints it.
- **It is commentary.** It changes nothing in his program; anything to apply still goes through proposals.

**Forecasts: he asks an agent about the future, and the app keeps score** (his ask, 2026-11-03: "submit a forecast to
DELTA about my bench", "how jacked I will look in summer 2027", "track whether it came true and how off it was"). His
picks: the agent commits to its own number with the app's trend line beside it; all four agents; one call, medium
effort, no lookups; Ask again, a chat card and the Goal Roads link in v1 (photos were not picked).
- **Fixed kinds, because the app scores every one** (`FC_KINDS_FOR`): DELTA `liftDate` (when an estimated 1RM of W, or W
  for R reps, is first reached) and `liftAt` (best clean e1RM within `PRED_WINDOW` of a date); ECHO `bwDate` (7-day
  trailing average reaching W, `dir` stored) and `bwAt` (weigh-ins within `FC_BW_WIN` of a date); CHARLIE `sessionsBy`
  (days with a session from `from` through a date) and `streak` (where the run from `cur` ends, walked like
  `streakStats()`); ZULU `look` (his question, a `read`, and 2-`FC_MARKERS_MAX` `liftAt` / `bwAt` markers, plus his 1-5
  rating at the date in `S.forecastRatings`).
- **The trend line comes first** (`fcEngine()`, free, live in the form as he types). Lifts and bodyweight use the fan's
  own formula, now shared: `anFanStartDay()` / `anFanPoint()` inside `anFanProject()`, and `anFanAt(res, date)` for one
  date, so a forecast and the chart cannot disagree (the suite checks every point). A planned rate moves the bodyweight
  line; a planned frequency or calorie number does not, because the app has no computed effect for it: that part is the
  agent's judgement, labelled as such. Sessions are scheduled days × his 8-week show-up rate with a binomial spread; a
  streak is geometric from his miss rate. HOW SURE TO SOUND still holds: `FC_RULES` tells the agent to start from the
  line and move off it only for a reason in the data, named in `why`.
- **The question is his form's** (`fcAskCheck()`, shared by the form, the chat card and Ask again): lift through
  `agResolveExName()`, a target not already reached, a date `FC_MIN_DAYS`-`FC_MAX_DAYS` out (28+ for `look`), at most
  `FC_OPEN_MAX` open. Kind, subject, target, date and plan are taken before the await and never from the reply.
- **`fcValidate()` discards, never repairs**: p10 ≤ p50 ≤ p90 (or early ≤ mid ≤ late, late may be null = "or later"),
  within bounds (a lift 0.7-1.6× his best, bodyweight ±40 lb, sessions within the window), markers only from the offered
  subjects. A refused reply was billed and stores nothing; the form says why.
- **`fcRun()`**: `callClaudeWithData(..., 8000, {noTools:true, effort:'medium', route:'forecast:<agent>'})`, truncation
  checked, `_fcRunning` module-scoped and released in `finally`, the row pushed into the `S` that exists after the await.
  `forecast` is a user-started route, so `spendPreflight()` asks past the cap. About 4¢ a forecast.
- **Rows never change; how one turned out is `fcResolve()` at read time** (the `predResolve()` rule). Errors are signed,
  the outcome against the call's middle: days late (+) or early, % or lb above, sessions more. The trend line is scored on
  the same outcome (`engErr`). A date past `late` and not reached is `late` (a known miss, its error still growing, not
  final) and settles as `notReached` `FC_GIVEUP_DAYS` later. `fcPlanHeld()` checks the plan he gave (frequency,
  rate, calories) over the window; a plan not kept is shown and left out of the bias.
- **The agents remember their misses.** `fcMemoryLines(agent)` goes into every forecast prompt: the record by kind
  (`fcRecord()`: hits, median signed error, typical miss, how often the trend line was closer) and the biggest misses
  first, each with the agent's own reasoning at the time. Its `calibration` line says how it corrected, stored and shown
  as "Learning from past calls". `fcTrackLine(id)` puts the record and up to 3 open forecasts in the nightly context
  (`agBaseContext()`) and every chat, empty with no forecasts, so those prompts are byte-identical until the first one.
- **Storage:** `S.forecasts` (`'f|'`) and `S.forecastRatings` (`'v|'`), both `SYNC_HISTORY`, cap `FC_KEEP`. Remove is a
  typo fix, the day it was made only. His rating is replaced in place and can be changed the same day.
- **His side:** Hub › Forecasts (section `#forecasts`, between Desk and Flags; `renderForecasts()`,
  `REVIEW_RENDER.forecasts`, `NAV_LEGACY.forecasts`): the record ring and per-agent rows (`fcBoardHTML()`), the Ask card
  (`fcDraft`, `fcAgent`, `fcKindSel`, module-scoped; `fcSet()` patches the preview in place, `fcSetR()` repaints), the
  rating card, open and settled cards (`fcCardHTML()`, `fcStatus()` for ahead / behind). The bell has a settled
  forecast for `FC_NOTIFY_DAYS` and a big picture waiting on his rating (`fcNotifItems()`).
- **Extras:** Ask again (`fcAgain()`, `of`, YOUR EARLIER CALL in the prompt; both are scored). `offer_forecast` is in every
  chat lane and only fills the form (`fcPrefill()`); it writes nothing to `S` and has no Undo. A Goal Road's
  **Ask DELTA for a forecast** is `liftDate` for 1+ reps, the road's own rule (`fcFromGoal()`).

**The agents are told what each lift trains** (2026-10-21). DELTA told him a low-to-high cable fly works the lower chest,
then agreed it had it backwards. No prompt said what a lift trains. `LIFT_FACTS` is a fixed table of settled anatomy
(which head a joint angle biases, which plane a muscle moves the arm in), first match wins, short tokens anchored; the
rear-delt rule comes first because "Incline Prone Reverse Fly" otherwise reads as an incline chest fly (a mutant caught
it). `agLiftRefLine(id)` gives DELTA and ZULU one line per lift in the split in force and the permanent split, nightly
(`agBaseContext()`, before DELTA's tail), in chat (`chatContext()`) and mid-workout; a lift the table does not know gets
its broad group and is told not to name a region. `agEvidenceRules()` points at it. `musclesFor()` no longer counts a fly
as triceps work, and reads a reverse fly or face pull as rear delts.

These are prompts, so they are hints, not guarantees. The checks that would enforce them (a number in a reply
traced to data, a principles list with sources) are planned and not built.

**Read-only agent output still needs a validator.** The Overload Status tab is
informational, so it does not go through the proposal queue — but `olValidateReport()`
discards any row whose direction contradicts the computed trend, or whose verdict
inverts the computed one, and the tab renders live-computed signals underneath
regardless. A bad night costs the tab its commentary, never its content.

**V4 stage 6 adds the paid pieces one at a time, a week apart on the spend ledger** (Mark's plan,
2026-10-04). On the ledger, the baseline before it was about $9 a month. The order:
- week 1: track records (free) and plateau diagnosis (about $0.20 a month);
- week 2: cross-review, ZULU's half. A held request goes to the feed with **Show anyway** (his
  choice). **Built 2026-10-18.**
  - ZULU's nightly call is shown tonight's new specialist requests (`agTonightRequests()`, by the cycle's `run` tag,
    taken before its await), and `agHoldSpecLine()` adds an optional `"hold"` key only when there are any.
  - `agValidateHolds()` keeps only those ids. `agApplyHolds()` writes into the re-resolved state: status `held`,
    with `heldWhy`. A held request is out of `agPending()`.
  - It shows in the feed (`{hold:id}`) and under Pending as "Held by ZULU". The id travels in `data-prop`.
  - **Show anyway** (`agShowAnyway()`) re-runs `agValidateFix()`, then either queues the request or closes it,
    naming the rule.
  - `agIngest()` counts `held` as open for its de-duplication, and `agSweepExpired()` expires it.
- week 3: per-lift specialists, the only addition that is a new request.

Check the ledger before starting the next.
- **Track records are scored when read, never stored** (`agOutcome(p)`, the way `predResolve()` works;
  a stored verdict would lose to an older snapshot). Only approved proposals with a fix are scored.
  Each outcome can also be `pending` (too soon) or `nodata`.
  - `liftReset`: held or missed. He hit the reset weight for the bottom of the range in the next 2
    sessions.
  - `cal`: the 4-week pace moved toward the band, away from it, or not at all
    (`bulkRate(4, endKey)`).
  - `swapEx` / `addEx`: the new lift's first 4 sessions climbing, flat or down.
  - `setCount`: the trend after against before: better, worse or the same.
  - `deload`: back to level in the first 2 sessions after the week, or not yet.
  - `experiment`: its own result.
  - Anything else is just "applied". Retired kinds (`bpFreq`) are left out.

  `agTrackLine(id)` puts the agent's own record in its prompt; ZULU gets everyone's.
  `hubTrackHTML()` shows it on the Hub card, with how many requests he approved. Changes made from
  Chat cards (any agent's) never become proposals, so they are not scored, and ZULU's card says so.
- **Plateau diagnosis rides DELTA's existing nightly call**, like the debrief. No new request.
  - `pdTargets()` picks at most `PD_MAX` (2) lifts a night: a lift that just moved up a level
    (`pwRising()`) first, then the worst not read in `PD_QUIET_DAYS` (21). A lift that got worse
    since its last read is due again.
  - `pdContextLine()` and `pdSpecLine()` add the section and the `"diagnosis"` key only when there
    are targets, so a quiet night's prompt is byte-identical (the suite checks this; it is the cost
    guard).
  - The lifts asked about are taken before the await (`_pdFor`). `agValidateDiagnosis()` keeps only
    those, strings only and clipped, with factor keys from `PD_FACTORS`.
  - It is stored in `S.agents.diagnoses[lift]`, merged per lift newer-wins in `applyPulled()`, and
    capped at `PD_KEEP`.
  - Each read leaves a feed line ("Looked at …"). `pdReadHTML()` shows it under the factors on the
    Strength hero and on the Overload line for `PD_SHOW_DAYS`.
  - It changes nothing: a fix still goes through proposals.

**Week 3 (per-lift specialists) was dropped at Mark's request on 2026-10-05**: he judged it extra cost
for no reason. Its slot on the ledger went to the agents' weekly question instead.

**The agents may ask him one question a week** (built 2026-10-05 at his request, ahead of the planned
Oct 19, as the last piece before cross-review). No new request: it rides the asking agent's existing
nightly call, like the debrief and the diagnosis.
- **When:** `qaDue()` needs no open question (`qaOpen()`) and `QA_GAP_DAYS` (7) since the last one was
  asked. One agent's turn a night, in `QA_ORDER` (DELTA, ECHO, CHARLIE, ZULU). `qaSpecLine(id)` adds the
  `"question"` key only for that agent, and only on a due night. Every other prompt is unchanged. It sits
  before DELTA's diagnosis line, so the diagnosis stays the last thing in DELTA's spec (the cost-guard
  test relies on that).
- **The turn moves on whether or not the agent asked** (`qaIngest()`), but only when the agent reported:
  one that failed keeps its turn. Whether it was offered is taken before the await (`_qaAsk`), and the
  question is written into the re-resolved state. The suite swaps `S` mid-reply to prove it.
- **`agValidateQuestion()`** keeps a question (it must contain "?", checked before clipping) with a
  why, and 2–`QA_CHOICES_MAX` (5) de-duplicated choices, all clipped. It refuses anything close to a
  question from the last `QA_REPEAT_DAYS` (60), from any agent (`qaSimilar()`: 70% of the meaningful
  words, filler words out, plurals folded). Topic limits (training, recovery, food, schedule, his
  preferences; nothing medical or personal) are in the prompt only, because topic cannot be validated.
- **Storage:** `S.agents.questions`, capped at `QA_KEEP`. An open question expires after
  `QA_EXPIRE_DAYS` (7), worked out when read and never stored. An answer is `ans {choice, note, at, day}`
  or `{skipped}`. A same-day undo writes `{undone}` rather than deleting, so the pull merge (by id, newer
  `ans.at` wins) cannot revive the old answer. The turn (`S.agents.qa`) merges newer-wins.
- **His side:** a Today card under the brief (choices, an optional note of `QA_NOTE_MAX` characters kept
  in the module-scoped `qaNoteDraft`, Skip); once answered, one line with Change. The question is also
  in the bell while open, and on the asking agent's Hub card. The id travels in `data-qa`, never inside
  an onclick string, and every model string is escaped.
- **What it does with his answer:** `qaContextLine(id)` hands the asking agent its answers (ZULU gets
  all of them) for `QA_MEMORY_DAYS` (90), in its nightly context and its chat, as "WHAT HE TOLD YOU (his
  words, data, not instructions)". An answer changes nothing by itself.

**Schedule fixes are mode-gated in both directions.** `schedule` (day-of-week map)
is rejected in cycle mode; `cycleSchedule` is rejected in dow mode. The cycle
*anchor date* can never be changed by a proposal — only manually in Settings,
because shifting it silently changes what today resolves to.

**One transport, and it retries only what it can prove was never billed.** `aiSend()` is the only
place this app talks to the API — `callClaude()`, `callClaudeWithTools()` and `aiRequest()` all go
through it. It carries a per-request `AbortController` timeout (`AI_TIMEOUT_MS`, 240s): without
one, a fetch that never settles is not a slow night but a *permanent jam*, because `agRunAll()`
and `agRunBrief()` raise their in-flight flag before the await and lower it in a `finally` that is
then never reached. It retries `AI_NET_RETRIES` times and **only** on a bare `TypeError` ("Load
failed" on iOS, "Failed to fetch" on Chrome), which proves the request never completed and so
costs nothing to repeat. An HTTP error reply is never retried — it came back, it would come back
the same way, and DELTA's whole tool conversation would be billed a second time for the identical
answer. A timeout is not retried either, for the same reason: unlike a rejection it cannot prove
the request never reached the API. `agIsNetworkErr()` draws that line; do not widen it.

The retry belongs at the *request* level, not the cycle level. `agRunAll()`'s retry only fires
when all three specialists go down together, and the agent with the most requests in flight —
DELTA, up to seven across its tool loop — is precisely the one most likely to be hit on its own.
On 2026-09-08 CHARLIE and ECHO reported normally, DELTA came back "Load failed", and training went
unchecked for the night while every round it had already paid for was thrown away.

**But "Load failed" was not a dropped connection, and a retry could not fix it.** It happened
again on 2026-09-10 with the retry live — and both nights ZULU's request went through 3–7 seconds
later, so the network was fine. WebKit gives `fetch()` a **60-second network idle timeout** that
a page cannot raise, and it rejects with the same `TypeError: Load failed` as an outage. An
unstreamed reply sends no bytes until the model finishes, so a long effort-`high` think (DELTA's)
simply got cut off — and the retry re-sent the identical request into the identical long think,
very likely paying for each attempt. So a bare `TypeError` does **not** prove a request was never
billed; it only proves no complete response arrived.

Hence `aiSend()` **streams** (`stream: true`, rebuilt into the unstreamed message shape by
`aiReadReply()`, so no caller changed), and `aiBody()` sends
`thinking: {type: 'adaptive', display: 'summarized'}`. Both halves are required, and this was
measured, not assumed: with Sonnet 5's default `display: 'omitted'` a *stream* sends **nothing at
all** while the model thinks — a 21s think was 20.6s of dead air with no pings — while the same
prompt with `summarized` never went quiet for more than 4.6s. Billing is identical under both
settings (the full thinking bills as output either way; the summary is free). Do not remove
`display: 'summarized'` as an unused-output cleanup — nothing reads it, it is there for the bytes.

The retry line moved with it: only a `fetch()` that rejects *before any response* is retried. Once
the stream has started, the API is generating, so a mid-stream failure is billed work and is never
repeated. The thrown message now says which it was and how long in (`Load failed — the reply was
cut off 61s in` vs `no reply on any of 3 tries`), because a bare "Load failed" was exactly what made
this take two nights to see.

**And streaming did not end it.** On 2026-09-19 DELTA died again — `cut off 39s in`, while CHARLIE,
ECHO and ZULU all came back over the same seconds, ZULU four seconds later. So it was neither the
network nor the 60s idle rule: 39s of connection cannot contain a 60s silence. Something severed a
stream that was receiving bytes, and nothing recorded could say what. `aiStreamNote()` now appends
what had arrived — `[407 B in over 3 events, longest silence 12s, still thinking]` — to both a
mid-stream drop and a stream that just stops. A longest silence near 60s is WebKit giving up on a
quiet stream and wants more bytes on the wire; a short one with bytes still flowing is the
connection being taken away and wants something else entirely. The gap still *running* when it died
is folded in, or the number is always under-reported by exactly the silence that killed it. Mark
chose evidence over a retry here: a mid-stream drop is billed work and is still never re-sent.

**The evidence came in, and it was a quiet stream.** On 2026-09-24 DELTA died with
`cut off 52s in [4.2 KB in over 28 events, longest silence 46s, still thinking]`. CHARLIE, ECHO
and ZULU reported over the same seconds (ZULU 4s later), so the page was live and the network
was fine. That is DELTA's fourth failure in 17 nights (9/8, 9/10, 9/19, 9/24), and every one was
DELTA, the agent with the longest effort-`high` thinks and the most tool rounds. `summarized`
display shortens the silences but does not bound them, and 46s was enough. Mark chose to run
**DELTA's nightly check at `medium` effort** (`AG_NIGHT_EFFORT`) over a paid retry. It thinks
shorter, and costs less. `olValidateReport()` still checks its Overload report, so a thinner night
costs commentary, not correctness. If DELTA still dies, read the note first: a long silence
again means the thinks are still too long, and a short one means the connection is being taken
away, which effort will not fix.

**An instant failure on every try is the network, not the app.** On 2026-09-25 the brief's Rewrite
failed twice at 8:18 AM with `Failed to fetch — no reply on any of 3 tries (the last failed after
0s)`, and DELTA's chat failed the same way. He was on school Wi-Fi, which blocks
`api.anthropic.com`. GitHub still answered (the WHOOP relay kick had gone out at 7:16). That evening,
from the same browser with the same key and headers, a request got a 200 in 0.3s. So when no try
gets any reply, `aiSend()` now asks `aiReachNote()`: one opaque GET to GitHub, bounded at 4s, on
the failure path only. The error then says either "GitHub answered, so this network is blocking
api.anthropic.com" or "this device looks offline". The message still starts with the engine's
own `TypeError` text, so `agIsNetworkErr()` reads it as before. Chat failures now go to the
activity log too (`agSendChat()`, ZULU's `sendChat()`, mid-workout DELTA). Until this, they
were only on screen, and nobody could say afterwards what DELTA's chat error had been.

**Every reply's token usage is kept.** `aiBody()` hangs the calling feature on the body as a
non-enumerable `_route` (`night:delta`, `brief`, `chat:zulu`…), so it can never reach the
request JSON. `aiSend()` records `usage` with it through `aiUsageNote()`. The log lives in
`localStorage['ironhub:usage']`, per device and capped at `AI_USAGE_MAX`. It is not kept in `S`,
because each device pays for its own calls and `S` re-uploads on every sync. `aiUsageSummary()`
prices it at `AI_PRICE` (Sonnet 5: $2 in / $10 out per million, checked 2026-09-25), and Coach
shows 30 days by feature. That is the baseline to measure any prompt addition against. Pass a
`route` in `opts` on any new call site, or it lands under "Other".

A reply cut off after its stream began was billed but, until 2026-10-03, never logged. It is now
logged with `x:1`: the input is exact (from `message_start`) and the output is a floor taken from
what had streamed in. An API error reply, in a stream or not, is not logged. The morning brief
passes `noTools` to `callClaudeWithData()`, so it is exactly one request with no tool
definitions, as its comment always said. Before that, `maxRounds:1` still sent the tools.

**There is a monthly cap, and it sees both devices** (2026-10-03, $20 default, `S.settings.spendCap`).
- Each device rebuilds its own per-day records in `S.spend` (a `SYNC_HISTORY` collection) from its
  local usage log (`spendLedgerSync()`, on every note and every foreground check).
- It **never adds to a record**: the history merge keeps the snapshot's copy of a key both sides
  hold, so a running total could silently lose an update. A rebuild writes the right number again.
- `spendMonth()` reads this device from its own log and others from their records, so it is a pure
  read that never double-counts.
- `aiSend()` calls `spendPreflight()` before every request, counting the request about to go out.
- Automatic routes (`night`, `brief`, `letter`, `lift`) are stopped with a `Paused:` error. The
  9 PM gate and the brief gate pause up front and leave evidence: one log line a day, and a
  `briefNote`.
- Anything he started asks first: chat, `weekplan`, Run cycle now and Rewrite (`spendManualOk()`).
  A yes covers the next 10 minutes.
- A notification appears at 80% and again at the cap (different ids), and a reached cap is named in
  the spend card's folded line.

**A repaint must never be able to strand an in-flight flag.** Both runners used to call
`renderOps()` between raising their module-scoped guard and entering the `try`. A throw from a
pure-UI repaint left the flag `true` for the life of the page, and every later scheduler tick then
returned at the first gate — which is *before* anything is written to the log, so nothing on
screen could explain the silence. Every repaint inside those two functions is now within the `try`
and individually guarded.

**The nightly cycle stamps the night it started** (`runDay`, read before the await, 2026-10-10). Stamped with
`todayKey()` at the end, a cycle that started at 11:58 PM and finished after midnight closed the NEXT night's gate,
and that night's 9 PM check never ran.

---

## V4 invariants — things that will silently break if undone

**The deload in force is not always `S.deload`.** A meso block's deload week is a deload with no
`S.deload` behind it, and `S.deload` can still hold a finished manual window from weeks earlier.
Three readers took their dates straight from `S.deload.until`: the fatigue card, Settings and the
agents' `agContext()`. During his Oct 12 block deload they would have printed August's dates, or
thrown when `S.deload` was null, and the agents' prompt would have failed with it.
`deloadWindow()` returns `{start, until, source}` from whichever source is in force, and
`deloadActive()` is just `!!deloadWindow()`. `deloadCheck()` counts training weeks since
`lastDeloadEndKey()`, not every week ever logged. The old count passed 6 once and never reset.

**A deload he ended early is over everywhere, from the day he ended it** (2026-10-16). He ended his block deload a
day early. Only `deloadWindow()` read the flag, so:
- the next session was judged against the deload's RPE 5-6 (`rpeTargetFor()` reads the segment by date), which also
  marked the next same-day call down;
- Today's eyebrow and the Plan hero still said deload;
- every agent prompt was told "Deload week: loads ~60%" beside "no deload in force".

The fix has three parts:
- **The flag is a day now.** `endDeloadWeek()` stores `deloadEnded = todayKey()`. It is still truthy, so an older copy
  of the app reads "ended". It also ends the later segments of the same block, but never another block's deload.
- **One helper answers it.** `mesoDeloadEndedOn(w)` returns the day. A legacy `true` is inferred from his logs: the
  first non-deload session inside the segment, else the day after the last deload one, else its start, and never later
  than today.
- **Every reader asks by date.** `mesoDeloadOn(w, key)` and `mesoPhaseOn(w, key)` (null on the days after the end)
  are what anything reading a segment's type or rep/RPE range by date must ask:
  - `rpeTargetFor()`, `exRepMode()`, `pwBlockAt()`, the Sunday plan;
  - `mesoNextDeload()` skips an ended deload, which also frees `agDeloadBlock()`;
  - `lastDeloadEndKey()` takes the day before the end.

**The fatigue norm is his usual training week, so a deload week is not part of it** (2026-10-21). A week after his Oct
10-15 deload `fatigueIndex()` read 1.54× "overreached": its norm was the plain 28 days before this week, and those still
held the deload at half weight. The banner came back, and overreached alone (−2 = `DC_EASY`) made every day an easy one.
The norm is now the mean of the 4 most recent 7-day windows before the acute one with no deload session in them, looking
back `FI_NORM_LOOKBACK` (12) weeks; under `FI_NORM_MIN` (2) such weeks it says it is rebuilding rather than guess. The
HIGH LOAD marks and the plateau load factor read the same function, so they stopped flagging the weeks after a deload too.

**Deload alerts can be off until a date** (his call, 2026-10-21: "I do not need to deload for at least 8 more weeks").
`S.deloadQuiet = {until, from, at}`, set only by his tap ("Quiet for 8 weeks" on the LIVE banner, the Fatigue tab, the
Fatigue check and Settings › Training; `deloadQuietSet()`), saved with `save()` so both devices hold it. Never written at
boot: that is the stale-push trap. `deloadQuietUntil()` gates on a well-formed date, and the day after it is over by
itself. While it holds:
- his screens: no LIVE banner or "Deload suggested", `deloadForecast()` returns `{quiet}` with its text (the Today tile
  says Off, the bell has no "deload looks due"), the Fatigue check says Quiet, a high reading on the Fatigue tab is
  "information only", and the second-recover-day line does not suggest a deload;
- today's call leaves training load out (his pick); recovery, sleep, soreness and strain still make it;
- the agents: `trainingContext()`'s FATIGUE MODEL and `intelSummary()` say it is off and not to suggest one, the Sunday
  plan is told the same, `agEvents()` leaves out heavy weeks, `pdContextLine()` drops the load factor, and
  `agFixMenu('delta')` offers no deload;
- **enforced in code:** `agDeloadBlock()` refuses a deload (queue, approval, chat `start_deload`, the Sunday plan), and
  Investigation offers the light reset instead of a deload.

A planned meso deload still runs and is still counted down (it is his plan), and his own Start deload buttons work.

**Bench Practice is load, never strength** (his ask, 2026-11-01: a light extra bench on his fitness-for-life class days,
about every other day). The first version (2026-08-08 to 08-25) was home-only, counted for nothing, and had DELTA's
`bpFreq` fix; that fix stays gone, and `benchPractice` stays in `REMOVED_STATE_KEYS`.
- **It is its own collection, `S.practice`** (`{id, date, lift, sets:[{w,r}], t}`, in `SYNC_HISTORY`), **never `S.logs`.**
  Everything that judges strength reads `S.logs` (e1RM trends, `recommend()` / `classifyDecision()`, the prediction
  record, the plateau watch, Investigation, the streak, CHARLIE's sheet), so it is left out with no opt-out anywhere. A
  second log on a training day would also break readers that expect one session a day. Do not move it into `S.logs`.
- **It opts in where it is load:** `weeklyVolumeByGroup()`, `heatmapHTML()`, `bmWeeklyVol()` (through `practiceVolInto()`)
  and `anStrainBetween()`, so `fatigueIndex()` and today's call see it. A new volume or load reader must add it too.
- **Upside only (his rule):** the PR readers take their max over practice sets as well (`bestE1RM()`, `snapshotPRs()`,
  `prBestSetFor()`, `prBackfill()`, `actualPR()`). A max cannot fall, so a practice set counts only by beating the
  record, and a 145 x 6 never reads as a weaker bench. Such a PR row carries `practice:true` and the PR log labels it.
  No prescription jumps off it: `recommend()` reads `S.logs` only.
- **Light on purpose:** `bpSuggest()` is `BP_PCT` (60%, his pick) of the median of his last 3 clean e1RMs in
  `BP_RECENT_DAYS`, rounded down to 5 lb, else `BP_DEFAULT_W` (145). `BP_SETS_DEFAULT` (2) sets, `BP_SETS_MAX` (3) offered,
  and a 4th asks first (a soft cap, his plan's wording).
- **`bpAdvice()` says go lighter or skip, in one line:** a bench session yesterday or today, bench still to come today, a
  deload, an easy or recover call, or a beat-up check-in, and the weight drops 10% (`BP_LIGHTER`). A pain flag on a
  chest, shoulder or triceps lift within `BP_PAIN_DAYS` (14) stops LIVE offering it; the Log card still takes one, with
  the reason. Pain flags are per lift, not per joint, so "shoulder or elbow" is read through `musclesFor()`.
- **Where:** a card on LIVE's idle screen, under the brief and never during a session (his ask, the same day: it started
  on Today), and on Train › Log, with the last entries and a delete. Today has none. The open card and what is typed are
  module-scoped (`bpOpen`, `bpDraft`), so the repaint keeps them; `bpRepaint()` repaints LIVE when he is on it, and blurs
  first, because a tap on iOS can leave the input focused and `refreshBlocked()` would skip the repaint.
- **The agents:** `agPracticeLine()` gives DELTA and ZULU (nightly and chat) the last `BP_AGENT_DAYS` of it, as data, and
  is empty with none, so a prompt without practice is unchanged. No fix type touches it.
- **Next (planned, not built):** the PR window, a modest "conditions look favourable" day for a bench PR attempt (an e1RM
  rep PR or a true single, chosen when he taps it), at most once every 2 weeks, built on `prWatchAt()` /
  `pwNotifItems()`. An attempt counts by the same upside-only rule and moves no prescription.

**A sleep log is not a check-in.** `quickLogSleep()` writes a stub with `partial:true` and no
tier. Older stubs carry a made-up `tier:'ok'` with empty soreness and energy. `rdComplete()`
tells them apart, and `todayReadiness()`, the readiness analytics and the agents' readiness
lines all use it. Before, a logged sleep skipped the pre-session check-in for the day. The
check-in also stores what WHOOP pre-filled (`energyPre`, `sleepPre`). Energy comes straight from
recovery, so an unchanged answer is WHOOP's read, not his, and anything that weighs both must not
count it twice.

**The split in force is not always `S.split`.** During an approved meso strength block the day
keys are S1/S2/S3, which do not exist in `S.split` at all. Anything resolving an exercise
property at runtime must go through `activeSplitObj()`.
`incForExercise()`, `isFormFocus()`, `isStrMode()`, `isMaxed()` and `agTrainedExNames()` all
do. Missing one is invisible until a block is active — that was the `+15` increment turning
into `-5`.

**Generating a split is not scheduling it.** A meso block reaches the calendar through
`mesoRotationDayFor()`, anchored to the *calendar* and consulted ahead of the dow/cycle map in
`scheduledDayFor()`: day N of the block is always slot N of `['S1','S2','S3','REST','REST']`.
That is now the only way S1/S2/S3 land on a date. A segment can be resized in days from the week
editor (`mesoSetWeekDays()`, 1-60): a 4-day strength block runs S1, S2, S3, rest, and every later
date moves up. The blockId is kept, so an approved split survives the resize.

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

**A correction to logged history runs once, and only on a current state** (`DATA_FIXES`,
`dataFixesRun()`, first used 2026-10-05 for Lying Leg Curl, logged per side through that night).
- **It is marked in `S.dataFixes`.** The mark syncs with the data it changed, so a device that pulls the
  corrected data also pulls the mark and never applies it again.
- **It runs only after a boot pull that succeeded**, or on a device without sync. Run on a stale copy, a
  second device could double numbers the first had already doubled. `autoPullOnLoad()` now returns
  whether the pull worked, and the boot hands that to `dataFixesRun()`. A failed pull waits for the next
  open.
- **`dataFixApply()` scales only that lift's sets through the fix's `through` date.** It also scales each
  set's `p.w`, the log's `plan` and `decisions` from/to, and the PR log, stamps what it changed, and sets
  the slot `inc` on the permanent split and every block split. Sessions after the date are untouched.
- **Add a correction as a new `DATA_FIXES` entry with a new id.** Never reuse or edit an id: a device
  that already applied it will not run it again.
- **A rename inside a window is `kind:'rename'`** (`dataFixRename()`, first used 2026-10-28: D5's Incline Press
  Machine from Sep 19 through Oct 28 was really Plate Loaded Incline Press). It moves only that day's sessions in
  the window, with every name-keyed field on them, rebuilds both lifts' PR rows in the window from `prBackfill()`
  (a PR on the old machine is not one on the new), and renames the day's slot. It waits while LIVE is open. It is
  not `exRenameEverywhere()`, which merges a whole name's history.

**Card open-state must not live on the DOM node.** `rerenderActive()` regenerates the whole
active tab every 30 s and after every sync pull, so DOM-only state is wiped on a timer with
nothing to blame it on. `subOpen`, `sdOpen`, `sdHomeOpen` and `photoOpen` are module-scoped
for this reason.

**A weigh-in is checked before it is believed** (`addWeight()`, 2026-10-10). A fat-fingered "1715" for 171.5 put a
week's average near 400 lb, and every rate below took it as real, ECHO's nightly read included. Outside
`WEIGH_MIN_LB`-`WEIGH_MAX_LB` (80-400) it is refused; more than `WEIGH_JUMP_LB` (10) from the nearest earlier
weigh-in asks first, because a real one is possible.

**One bodyweight rate, and one set of bands.** `bulkRate()` / `bulkBand()`, over weekly averages. Every surface that
quotes a lb/wk figure goes through it: the Bulk tab, the projection card, `investigateBulk()`,
and `bulkScore()` (the Progress verdict). That last one was missed the first time and kept its
own raw first-vs-last-weigh-in math, so Progress read +0.35 lb/wk on the same day the Bulk tab
read 0.00 off the identical weigh-ins. The *bands* are shared too — a rate the Bulk tab calls
"under the pocket, add calories" must not read as "right in the lean-bulk range" two tabs over.
Do not add a fifth.
Since 2026-09-25 the bands are one set too. `investigateBulk()`, the flag auto-resolve (which
had its own 3-point regression and a 0.4–1.2 band), the Bulk-quality rate card and the
next-level advice all judge through `bulkBand()`. The one further line inside 'hot' is
`BULK_FAST` (1.6); nothing keeps its own copy. `projectionCardHTML()`'s 1.2 is a projection
clamp, not a verdict. The projection card's "measured pace" is the fan's all-history fit, on
purpose: a different window, judged by the same band.

**One intake target, and nothing hardcodes it.** `calTarget()` / `proTarget()` read
`S.fuel.calTarget` / `proTarget`; `nutTierCal()` / `nutTierPro()` are the only classifiers, and
`nutBuckets()` derives the tap ladder from them so the ranges re-centre when the target moves.
Every intake verdict goes through those two functions — the pill colours, the per-day history
badges, and the weekly rollup — which is what keeps a pill that says "on target" from producing
a row that says otherwise. The Bulk tab used to test a literal `cals>=3000 && protein>=130` and
ignore the Fuel tab entirely, so changing the target changed nothing the check-mark did. If you
add a surface that judges intake, call the classifiers; do not re-derive thresholds.

Calories carry four tiers (way under / under / on target / over), protein three — protein has a
floor, not a ceiling, so at-or-above target is one bucket and there is deliberately no `over`.
`est:true` on a `S.nutrition` row means the number is a bucket midpoint, not a measured total;
it is absent on everything logged before the ladder, and `trainingContext()` marks it `~` so the
model does not read an estimate as precise.

**The Fuel Planner is on-device, and its food list is not state.** It replaced the AI meal
generator on 2026-09-28, and it makes no API call. He is picky and short on time, so it plans
from what he has stocked and likes. Cal AI has no sync path, so it never reads live intake:
"already eaten" is an optional number, kept per day in the module-scoped `fpEaten`, never synced.
- **`FOOD_DB` is a constant in the file**, about 160 foods with approximate macros shown as ~.
  Its ids are what synced state keys off, so an id is never renamed or reused.
- **`S.fuel.foods` is sparse:** only foods he has touched (stock, Like/No/Hide, a corrected
  macro, pick and skip counts). `fpTidy()` deletes an entry that is back to its defaults. The suite
  checks the food list never reaches `syncPayload()`.
- **`S.fuel` holds preferences, not history.** A pull replaces it whole, and it is not in
  `SYNC_HISTORY`.
- **`fpFoods()` is the one list.** The pantry, the combiner and ECHO's tools all read it, and it
  is a pure read (it does not call `fuelInit()`), so ECHO's tools write nothing.
- **`fpCombos()` is pure and deterministic.** It is greedy, weights protein 1.2×, and allows five foods per
  plate. Pick and skip counts only break near-ties. Each later plate avoids the earlier foods and drops their anchor.
- **A plate reads like a meal he would eat** (his report, 2026-10-10: "1/2 rotisserie chicken, 800 cal, 90 g" and a
  double whey shake). After the first item, `fpBuild()` holds three hard limits:
  - a second serving only while the two together are one portion (`FP_ITEM_CAL` 450, `FP_ITEM_PRO` 45);
  - no more than 150 cal or 20 g over the plate;
  - one main per plate (category `meat` or `meal`).

  Each rule has its own test where the other two would let the plate through: in a realistic fixture they
  overlap, and a mutant of one survived until they did.
- **Snack options** (`fpSnackCombos()`, `res.snacks`): up to three, one or two `fpSnacky()` foods, one serving each,
  sized to `FP_SNACK_CAL` / `FP_SNACK_PRO` with a 50 cal / 10 g ceiling. ECHO's `fpCombosText()` lists them. The tab
  no longer shows `fpCombos()` itself; it shows the day plan below, built on the same `fpBuild()`.
- **The tab plans the whole day, one editable plate a slot** (his asks, 2026-10-17 and 10-18: "a few food options
  stacked on top of each other, and it only shows the same ones"; then "I don't see breakfast or pre-lunch snack,
  these are very high servings, a default serving and a drop-down to switch"). `fpDayPlan(gapCal, gapPro, opts,
  nowMin, workout, ateSome)` is pure; the clock, the workout and whether he has logged food are parameters.
  - **Slots** (`fpDaySlots()`): breakfast 8:00, a morning snack 10:30, lunch 12:30, a 3:30 snack, dinner 6:30, an
    evening snack 9:00, ALWAYS all of them, each marked `past` once `FP_SLOT_GRACE` (30 min) after it. On a training day
    with a workout time and nothing logged yet (`fpWorkoutToday()`): a pre-workout meal 2 h 45 m before, a top-up an
    hour before and a post-workout meal after; the usual slots go when within 2 h of those or inside the workout.
  - **What counts:** with nothing typed into Already eaten, the gap is the day's target and every slot shares it
    (earlier ones fold on screen but still have plates). Once he types food (`ateSome`), past slots are `eaten`
    (no plate, no share) and the rest share what is left; with every slot past, one "Before bed".
  - **Shares:** `FP_SLOT_W` (meal 1, snack 0.6, his "more snacks"), capped by `FP_SLOT_MAX` (meal 950, snack 550). A
    snack worth under ~120 cal is dropped; no snack food in the pantry means no snack slots.
  - **One serving of each food** (`lim.one`; snacks up to 3 foods). Breakfast draws only on `fpBreakfasty()` foods
    (the first plan put tacos at 8 AM). Meals skip sweets and keep a main when one exists, breakfast excepted.
  - **The plate** is the candidate nearest the slot, where protein under the slot costs 8 a gram and over it 2 (a
    bulk), plus 150 for each food an earlier plate uses, and before training 30 a gram of fat over 20 (snacks: 4 over 6).
    Candidates lose the earlier candidate's anchor but only rank its sides lower: barred from every side, the lean
    mains were left with grapes and lost to nuggets. The protein ceiling in `fpBuild()` applies only to foods with 10 g+
    (rice beside chicken is a side). Pre-workout builds `lim.lowFat`, post-workout weights protein 1.5.
  - **His changes** live in `localStorage['ironhub:fpday']` (`FP_DAY_KEY`, `{date, slots:{key:[{id,q}]}}`), today
    only and per device, never `S`. Each food is a drop-down of pantry foods in the same `fpRole()` (a main for a
    main), with a portion drop-down (`FP_QTYS`: ½, 1, 1½, 2), ✕ to take it off, + Add a food, and Back to the plan.
    Handlers read `data-slot`/`data-i`, never strings in an onclick. `fpDayShown` is what was drawn, so an edit
    changes what he saw; `fpDayOpen` (module-scoped) keeps an opened earlier slot open across the 30 s repaint.
  - `fpServingFor()` takes halves: "3 oz cooked", "1/2 sandwich", and "½ × 1/4 chicken" where the half cannot be
    written as an amount. `fpShown` is each slot's plate, so "I'll eat this" names one by index.
- **A plate row shows the amount its numbers are for** (`fpServingFor()`): "12 oz cooked", not
  "2× … 6 oz cooked" beside a two-serving total, which read as 106 g protein in 6 oz of chicken.
  A compound or bracketed serving becomes "2 × 1 can (5 oz)" rather than being rewritten. ECHO's
  `plan_fuel_combos` text uses the same amount.
- **The exclusion list wins over a like.** `fpUsable()` runs `fuelFoodAllowed()` with the
  category key added, and a plural in the list also catches the singular ("peanuts" catches
  "Peanut butter").
- **The Monday stock check** (`fpStockDue()`, Monday-anchored like Plan) shows on Fuel and on
  Today. Stock never resets. Confirming, or changing stock in the Pantry, closes it for the week;
  unticking a chip inside the prompt does not.

**The family pantry check: someone at home ticks what is in the house** (his choices, 2026-10-05). It is
stock only, sent back by a reply link, and he reviews it before it applies.
- **No server, no accounts.** The whole list travels in the link's `#fragment`, which a browser never
  sends to a server (`famEnc()` / `famDec()`, base64url JSON).
- **His side:** Fuel's card → `famShare()` → `famShareLink()`. It sends what he likes plus anything
  stocked; his own foods carry their name, since the family's page has no `S`. It goes to the share sheet,
  else the clipboard, else a link on screen (`famOut()`).
- **Their page:** `#family=` opens `famFamilyPage()`, a tick-list of its own. **The boot never runs there.**
  The boot block is `appBoot()`, and the dispatcher at the bottom of the file calls it only when the link
  is not a family link. So nothing on their phone syncs, runs an agent, loads a session or writes
  `ironhub:v1`, and the suite loads that link in a fresh jsdom to prove it. Their name is remembered in
  `FAM_NAME_KEY`. Send it back builds `#famreply=` (`famReplyLink()`).
- **Coming back:** `famRoute()` decides where a reply lands.
  - In a browser holding his app (`famHasState()`: saved state with logs), the app boots, then
    `famReviewFromHash()` opens the review and clears the hash.
  - Anywhere else, `famCopyPage()` offers the link to copy. This is the iPhone case: Safari keeps separate
    storage from the home-screen app. He then taps **Paste family update** on Fuel (`famPaste()` →
    `famFromText()`).
- **Everything in a link is untrusted.** `famValid()` keeps only well-formed ids (`FAM_ID`) with 0 or 1,
  once each, at most `FAM_MAX_ITEMS`; names are cleaned and clipped, and categories are from `FP_CAT_KEYS`.
  `famDiff()` compares against his list as it is now. It ignores foods he does not have, and never stocks
  one he said no to or hid, because `fpSetStock()` would clear that "no".
- **Apply** (`famApply()`) is his tap, and it `save()`s. It counts as this week's stock check, the same as
  changing stock in the Pantry. A reply `FAM_OLD_DAYS` (14) or more old says so.
- **The drop box: Submit instead of a reply link** (his choices, 2026-10-09). On an iPhone the reply link
  opened in Safari and had to be pasted, so `pantry/` holds one update per box until his app looks. It is
  **separate from `discord/` on purpose**: that Worker is a window and must stay read-only. Mark chose
  Cloudflare over the Apps Script, whose URL and secret are per device.
  - **It is a Pages project at `ironhub-pantry.pages.dev`, not a `workers.dev` Worker.** His home Xfinity
    network blocks every `*.workers.dev` name (its filter answers with a block page and an expired
    certificate, even through 1.1.1.1), and that is the network the family submits from. `pages.dev` is not
    blocked. The logic is `pantry/src/worker.js`; `functions/box/[[path]].js` only hands requests to it.
    Do not move it back to `workers.dev` without checking from his house.
  - **`FAM_DROP_URL` empty means off**, and every path is the link flow above, unchanged. It is `let` so
    the suite can point it at a fake.
  - **The box id is the only permission.** `famBoxId()` makes 128 random bits once, in `S.fuel.famBox`
    (synced, so both devices check the same box), reused by every share and re-dated by it. It travels in
    the `#family=` payload as `b`. Whoever holds the link can leave or clear an update, no more than a
    crafted reply link could always do, and the review still guards it. The Worker has no secrets, checks
    the shape, caps the body at 16 KB, and keeps each box for 30 days.
  - **The link is short: `?pantry=<box>`** (2026-10-18). The `#family=` link reached his mom's iPhone without
    its fragment and opened the main app: iOS can drop the part after a `#` from a shared URL
    (WebKit bug 250317). `famShare()` now opens the share sheet with `famShortLink()` inside his tap (iOS refuses a
    share opened after an await) and POSTs the list (`famShareObj()`) to `/box/<box>/list` beside it; a failed
    upload tells him to share again. `famRoute()` reads `?pantry=` (`famPantryParam()`, a well-formed box only),
    and `famFamilyPage()` fetches the list (`famFamilyFetch()`) before `famFamilyRender()`. The boot still never
    runs there. `famBase()` is origin + path, so a link built on that page carries no query. Without a drop URL
    the `#family=` link is unchanged, and old links still open.
  - **Their page:** with a box and a URL, the button is **Submit** (`famSubmit()`, one POST, 8 s timeout via
    `famFetch()`). Anything but a clear yes falls back to the reply link (`famOut()`), so a dead Worker costs
    them one step, never the update. A tick after sending re-enables it, and the newer update replaces the old one.
  - **His side:** `famInboxCheck()`, from `agForegroundCheck()` and its own minute tick (NOT `bgSyncTick()`,
    which needs gist sync). It sends one GET, only within `FAM_INBOX_DAYS` (28) of the last share. The
    result is the module-scoped `_famInbox`, never `S`, so nothing is written across the await. `S` is read
    only after it. A failed check keeps what it had. The update shows as a bell item and a Today card (also
    on Fuel), and Review opens the same sheet.
  - **Handled is in `S.fuel.famDone`** (the last `FAM_DONE_KEEP` ids). Apply, Ignore and Close all mark it
    (`famInboxDone()`), then ask the box to clear **by id**, so an update sent while he was reviewing
    survives. The clear is best-effort: `famDone` alone keeps a handled update from showing on either
    device. A pasted link has no box and marks nothing.

**Today's call sets the plan automatically, inside hard bounds.** `dayCall(date, dayKey)` returns
push / normal / easy / recover. WHOOP carries about half of it when today's data is in:
- recovery and HRV against *his* 30-day medians (`recoveryBaseline()`, never including the day
  judged);
- resting HR over his usual;
- sleep;
- yesterday's strain.

The rest is what WHOOP cannot see: soreness, stress, motivation, `fatigueIndex()`, and how the
last session of the same day felt (`feltVsPlan()`, the ONE "how hard did it feel" path).
`whoopResponse()` calibrates the recovery term from his own sessions: ×1.5 when his below-usual
days really do grind more, ×0.6 when they do not, and 1 until each side has `WR_MIN` sessions.
Mark chose automatic with a one-tap undo (2026-09-24).

What a call does, all in `buildOneLiveExercise()` through `opts.call`:
- **easy and recover** hold an earned jump, through `callTier()` → `recommend(ex,'low')`,
  exactly as a low check-in always has;
- **easy** takes one set off each accessory;
- **recover** also puts compounds one step under the *normal* plan (`recommend(nm,'ok')`) with
  one set fewer;
- **push** changes nothing but the words.

The bounds are the guarantee, and the suite loops every call over every lift type to check them:
never heavier than the normal plan, never lighter than his last top weight minus one increment, and
never more than one set fewer. (It used to say "one increment under the normal plan", which a held
double jump breaks: after an all-easy session the plan is +2 increments, and an easy day holds the
last weight. Held is the behaviour; the bound was restated on 2026-09-28, not the call loosened.)
An investigation override is left alone. `liveCallToggle()` rebuilds only lifts with no logged set,
so a logged set is never rewritten. `live.call` and `logRec.call` (with `off`) keep what the day
was called and whether he kept it.

**Pre-workout strain sets a floor under the call** (his ask, 2026-10-21). WHOOP day strain is a running total and can be
high before he trains. At WHOOP's own bands, `STRAIN_HIGH` (14, "High") makes today at least easy and `STRAIN_ALLOUT`
(18, "All out") at least recover; the floor lives in `dayCall()` (not points), so Today, the key lifts, Plan and LIVE
agree, and "strain N so far today" leads `why`.
- **Today only, and only before he trains** (`strainPreWorkout()`: nothing logged today, no session started today). After
  that the total holds the workout itself.
- **An old reading is still a floor**: strain only climbs through a day, so a reading is used whatever its age, and the
  age is shown. A strain dated another day never counts.
- **At 18+ the last accessory comes out** (`strainDropIdx()`: never a compound, a deload, a 1RM test or a swapped-in lift,
  and never a session cut below 3 lifts). It is a lift out, not a set, so it sits outside "never more than one set
  fewer"; he chose it. `live.callDrop` keeps it, `liveCallToggle()` puts it back at its place with the normal plan and
  drops it again on re-apply only while nothing is logged on it, and `logRec.callDrop` / `logRec.call.strain` record it
  (`sessionMods().callDrop`).
- **A fresh reading before the workout:** `whoopStrainKick()` from `agForegroundCheck()` asks the relay for a run from 2 h
  before `S.fuel.workoutTime` to 30 min after (`strainKickDue()`), on a training day not yet logged, when the reading is
  missing or over 30 min old; its own budget in `localStorage['ironhub:strainkick']` (3 a day, 20 min apart, per device,
  never `S`), the same POST as the morning kick (`whoopDispatch()`). LIVE's idle brief shows the strain, when it was read,
  and Refresh.
- The relay stamps `readAt` on strain; `applyWhoop()` keeps only strain's own stamp (never the file's `fetchedAt`), and
  `whoopContext()` calls it "strain so far today" (it said "yesterday's strain" until this change).
- The call's reasons carry the number ("strain 18.6 so far today"); LIVE's strain line says only when WHOOP read it and
  what came out, so the number is said once.

The call replaced the low-check-in "trim?" prompt (`rd3ShowTrimPrompt`, `liveTrimVol`,
removed). `live.trimmed` / `logRec.trimmed` now mean "the call took sets off", so the Readiness
tab's trimmed-vs-full comparison still reads the same field.

Energy counts only when it is his own read: on a WHOOP day, only if it differs from `energyPre`.
A check-in from before the pre-fill was recorded is left out on a WHOOP day, not guessed at.
`whoopOn(today)` reads ONLY today's dated sections, never the history, which keeps the rule in
the WHOOP section below.

Replayed over his real Aug 29 – Sep 24 sessions before shipping, against the engine that ran:
- the calls were 12 normal, 5 easy, 2 push and 1 recover (9/12: 19%, 4.7h sleep);
- none of 107 lift prescriptions came out heavier;
- 5 were a step lighter (earned jumps held);
- 16 accessories lost a set.

`scratchpad/replay.js` in that session did it: two jsdom copies (`git show HEAD` and the
working copy), `todayKey` stubbed per session, and only the state before that morning.

**Calibration measures how his low days actually go, and not the call's own effect.**
`whoopResponse()` counts a below-usual day as worse when he grinds more OR sets PRs less often:
`effect = grind gap + PR-rate gap / 3`. Grind share alone read his real data backwards on
2026-09-25. Under his usual he ground 9% of top sets against 8% at it, but set a PR in 29% of those
sessions against 71%, and grind share alone would have made recovery count for less. Two guards:
- **Sessions the call shaped are left out** (an easy or recover day he kept). The call holds jumps
  on those days, so they set fewer PRs because of it, and counting them would let the calibration
  feed on itself.
- **Under `WR_FULL` (10) sessions a side, the step is halved.** His data read ×1.25 that day.

**The agents get a computed summary, not raw arithmetic to redo.** `intelSummary()` covers:
- today's call;
- WHOOP against his usual, and how recovery affects him;
- the deload forecast;
- bodyweight against the band, intake against target, and fuel against results;
- per-lift patterns (bodyweight lifts left out), and a facts line for each stalled lift;
- per-muscle volume against trend (the basis for `setCount`);
- the last 7 days of engine decisions and calls.

It is about 600 tokens on his real data, and `agBaseContext()` adds it for DELTA, ECHO and ZULU
(the brief included). Every line is guarded on its own, so a failing line can never cost an agent
its prompt. Check the usage card before growing it.

**The summary states facts, never a pick** (2026-10-01). It used to print "Swap option for X
(stalled): Y, propose with swapEx", with Y drawn from every name he had ever logged. It offered
Rope Cable Curl for his Preacher Curl Machine, both on D2. DELTA cited the hint as its evidence and
tried the swap, and only a malformed payload stopped it reaching the queue. Three rules followed:
- **A stall is `liftProfile().stalled3`**: flat top weight AND no rep gain. The best set must gain
  a rep or the average set half a rep, so double progression is not a stall and a one-rep wobble
  is not progress.
- **Swap candidates skip everything already programmed**, as `invSuggestSwap()` always did. The
  stall line lists the options as equals: sets, a rep-range experiment, a smaller increment, a swap.
- **A swap may not put one lift on a day twice** (`agSwapClashDay()`), in `agValidateFix()` and in
  ZULU's `swap_exercise_permanent`, the same rule `addEx` already had. A lift on two different days
  is an ordinary split and still passes.

**The Sunday check-in is notes only** (Mark's choice, 2026-09-28). Nothing in it can change a future
date; V4's removal of date overrides stands.
- Sunday (for the week from Monday) and Monday (catch-up for the current week), a Today card:
  chips per day (Busy / Travel / No gym / Low energy) and a line of text. The taps live in the
  module-scoped `wpDraft`, so the 30-second repaint cannot wipe them. "Not this week" makes no call.
- **He can change it all week** (his ask, 2026-10-19; it used to be final once planned or skipped). **Change**
  (`wpEdit()`) is on the This week card from the Sunday before the week to its last day (`wpEditableWeek()`); a quiet
  day keeps a one-line card so it stays in reach, and a skipped week shows **Plan it now**. The form (`wpFormWeek()`,
  `wpEditing`, module-scoped) opens with what he said, offers only the days still ahead, and keeps what he said about
  the days gone. Plan my week replaces the week's plan whole and is one more call; Cancel changes nothing. A change
  whose call got no reply keeps its retry mid-week.
- His input is saved BEFORE the call. **One call per plan** (`wpRun()`, route `weekplan`, no tools,
  effort medium, about $0.03). A retry is allowed only when no reply ever arrived
  (`agIsNetworkErr`); a reply that came back unusable was billed and closes the week. `S` is
  re-resolved after the await, and `_wpRunning` is released in `finally`.
- The reply is a short plan and a note per flagged day. Today shows the day's note and, on a No gym
  day, the existing HOME toggle. `wpContextLine()` puts what he said into `agContext()` for that
  week only.
- A change is an ordinary proposal: at most one, only `deload` or `setCount`
  (`wpFilterProposals()`), not a deload inside a deload or a planned one, not a set count on a lift
  under a reset or an Investigation flag. It then goes through `agIngest()` and `agValidateFix()`.

**Experiments are proposed by the agents and measured by the app.** Daily intelligence item 2.
- **Fixed templates only** (`EXP_TEMPLATES`), because the app, not a model, has to measure every one:
  DELTA `restMain` (3+ min rest on one compound, adherence from set `ts`), `repRange` (an accessory at
  12-15 or 6-8, applied through `exRepMode()` so both engine trees see it), `sleep` (7.5 h+ by WHOOP);
  ECHO `mealTiming` and `preCarbs` (adherence is one tap, in the session summary or on the Coach
  card). An `accRest` template was considered and dropped: 90 s is already `smartRestSecs()`'s
  accessory default.
- **Proposal** is an `experiment` fix in the normal queue, checked by `expValidate()`: the agent's
  own template, a resolved lift of the right kind, a hypothesis, 3-4 sessions (clamped), and it is
  refused while one runs, inside the `EXP_COOLDOWN_DAYS` (7) cool-down, within `EXP_DECLINE_DAYS` (7)
  of him declining that template (`agReject()` records it), during a deload, or with fewer than
  `EXP_BASE_MIN` (3) clean sessions to measure against. The prompt line (`expMenuLine()`) is sent
  only when one could start. `agFixTarget` is `experiment`, so a newer proposal supersedes an older
  pending one: one at a time.
- **Running**, LIVE changes only its advice text and the rest timer's default. The agents are told
  what is running (`expContextLine()`) so nothing they propose confounds it.
- **Scoring**: every session, baseline and test, is value divided by where that lift's OWN trend
  before the test says he would be that day (`expTrend()`, clamped to +/-10% of his median). Not
  against his last few sessions, which would soon be the test sessions themselves and cancel the
  effect; not against a flat average, which would count four weeks of normal progress as an
  effect. Both of those were built as mutants and are caught.
- **Excluded** from both sides: deload, HOME, coach plan, a kept easy/recover call, a reset or swap
  on the lift, not followed, not answered. Sessions before 2026-09-28 cannot show a coach plan or a
  swap.
- **Result** (`expEvaluate()`): mean against baseline mean, n per side, pooled SD. `moderate` only
  with 3+ test and 4+ baseline sessions AND a difference at least the normal spread; else `low`,
  worded "no clear difference". Never "proven". After `EXP_MAX_DAYS` (28) without enough clean
  sessions it closes `inconclusive`. `S.experiments` is one object, replaced whole on a pull, so every
  write is `save()`.

**The prediction record scores the engine, and never stores a verdict.** Zero API cost; it extends
`anEnsembleFor()` and `bulkRate()` rather than adding a model (`projectMetric()` in
`projectionCardHTML()` is an older second model it deliberately does not use).
- **`topset`** ("did the prescription hold") is DERIVED from the logs: `logRec.plan`, or a legacy
  `decisions[].to` scored against today's rep range (and labelled so). Held = the prescribed weight
  for at least the bottom of the range. Bodyweight lifts are out. On his real data (2026-09-28) it
  read 74% held (183 of 246), and 54 of the 63 misses were sessions he lifted lighter than
  prescribed.
- **`e1rm28`** and **`bw7`** are STORED, one per kind, subject and Monday week (`predTick()`, run from
  `agForegroundCheck()` after the pull; it `save()`s only when it made something). Rows are
  immutable and live in `SYNC_HISTORY` (`'q|'+id`, capped at `PRED_MAX`), so neither a second device
  nor a pull can duplicate or lose one. Up to 6 main lifts (`predLifts()`, compounds first), about
  1.4 KB a week.
- **How a forecast turned out is computed at read time** (`predResolve()`), never written back: a
  stored verdict would lose to an older snapshot. A window with a deload (any lift), a reset or a
  reshaped session on that lift is `interrupted`, counted apart and never as a miss; no session
  near the due date is `nodata`.

**Forecasts and insights are descriptive, and they say so.**
- **`deloadForecast()`** answers in weeks, not days. It uses the fixed `deloadCheck()`, this
  week's load ratio against a week ago (`fatigueIndex(endKey)`), and felt trend, with a planned
  meso deload as the yardstick.
  - **Signals count only sessions since the last deload ended** (`lastDeloadEndKey()`, 2026-10-15):
    the bench/squat slip, the grind share and the felt trend. The day his Oct 10-15 deload ended it
    said "about 1-2 weeks" with his load ratio at 0.19, off a September bench slip, the slip the
    deload was for. Right after a deload they start empty.
  - **With no signal, time alone sets a horizon** in his usual span, `DELOAD_TYPICAL_WEEKS` (8-12,
    his call): "about 8-12 weeks out", less the weeks gone, and the Today tile shows "~8–12 wk". A
    signal or a planned meso deload wins over it. It describes; it never brings a deload nearer.
  - **`mesoWeeksUntil()` never goes below 0.** `mesoNextDeload()` returns the deload he is in, so
    five days into one the Plan card and the agents' PERIODIZATION line read "in -1 weeks".
- **`fuelVsResults()`** groups weeks by calories actually eaten, in fixed ranges around today's
  target and labelled in real numbers, because the target moved (3000 → 3700). It shows nothing
  until 3 weeks sit in each of two ranges.
- **Density** compares a day only with the same day (set `ts`, first set to last) and needs 4
  timed sessions.
- **`streakStats()`** has no 60-day cap, and keeps the longest run.

**Meal timing reads his own taps, scored like an experiment** (his choice, 2026-10-05).
- **The tap:** LIVE opens with a row of "Last ate" chips (`MT_BUCKETS`: under 1h, 1–2h, 2–3h, 3h+;
  `liveAteHTML()`). After a tap it folds to one chip that reopens. Nothing blocks on it.
  `live.ate` is saved with the draft and copied to `logRec.ate` as `{b, at}`.
- **The read:** `mtScore(l)` is each loaded lift's best e1RM over that lift's own line through its
  last `EXP_BASE_N` clean sessions before that day, clamped like `expTrend()`. Sessions the engine did
  not shape are left out (`sessionMods`).
- **When it speaks:** `mealTimingRead()` needs 2 buckets with `MT_MIN` (8) sessions each. It names
  the best bucket only when the gap is at least the normal spread (the `expEvaluate()` rule), and never
  calls it proven.
- **Where it shows:** the card is on Body › Fuel (`mealTimingCardHTML()`). The summary gets a line
  only once there is a result.
- **Experiments:** a running `mealTiming` experiment reads its adherence from the tap (2–3h counts as
  followed).

**The recap is built on demand and never stored** (his choice, 2026-10-05).
- **When:** "2026 so far" any time. From Dec 31 it becomes "Your 2026", which stays through Jan 14
  (`recapYear()`, `RECAP_JAN_GRACE`).
- **The slides** (`recapSlides()`), each one of the app's own helpers read for the year:
  - sessions, sets, pounds moved and the best streak (`streakStats()`), with training time "since late
    September" because set `ts` starts Sep 24;
  - strength gained (the most pounds first, the biggest jump by percent);
  - PRs from `S.prHistory`;
  - bodyweight from the year's first weigh-in to its last;
  - the radar;
  - the agents (`agTrackText()`);
  - habits: the most trained day, and the muscles with the most and fewest sets.
- **Where:** the card is first in Progress › Overview's year review (`recapCardHTML()`, titled
  "Recap" so it does not repeat the year card). The story is `#recapOverlay`: Next and Back, a swipe,
  Escape and the arrow keys.
- **The Dec 31 notice:** one notification, id `recap:<year>`, for `RECAP_NOTIFY_DAYS`.

**The Winter Arc countdown is a clock in the top bar, and it only reads** (his request, 2026-10-08).
- **Go-live is 5 PM Eastern on the start date** (`WA_GO_HOUR`, `WA_TZ`), worked out from the America/New_York wall
  clock by `waGoLiveMs()`. Oct 16 is daylight time, so that is 21:00 UTC; the suite checks a December date lands at 22:00, so
  the zone is read, not assumed, and a mutant run with the machine on UTC proves the device's own zone is not used.
- **He sets the start and end himself** (2026-10-09, his ask), date and time, from the card's **Edit dates & targets**.
  `S.winterArc` then carries `startTime` / `endTime` (`HH:MM`, Eastern wall clock, `waWallMs()`) and `custom:true`.
  - No `startTime` means 5 PM (`WA_GO_HOUR`); no `endTime` means the end of the end date, as before.
  - **`custom` turns the legacy-start migration off** (`winterState()`, `waSeasonRead()`). Without it, a start he picked
    on Oct 15 or Oct 24 would be silently moved to the default.
  - `waReadDates()` refuses an end at or before the start, or more than `WA_MAX_DAYS`, and a refusal saves nothing,
    targets included. Saving is `save()`.
  - `waPhase()` with no key goes by the instants, so Today does not show the arc as on before it goes live. With a
    key it still compares dates. `waCountState()` stops at `waEndMs()`.
- **It shows only in the last `WA_COUNT_DAYS` (30)**, then "Winter Arc · Day N" until the arc ends. For the first
  `WA_HYPE_DAYS` (3) Today opens on `waLaunchHTML()` (golf is over, his ask).
- **`waCountState()` never calls `winterState()`**, which creates and migrates `S.winterArc`; it reads through
  `waSeasonRead()`. The 1 s `waCountTick()` patches one button's markup and asks `rerenderActive()` (guarded) once,
  at the flip to live, so it never repaints under his hands.
- **A phone's top bar has about six characters of room.** More than a day out it reads "8d 07h" (`.wa-short`), and at 360px
  and under the IRON HUB wordmark gives way while the countdown shows (`:has()`). Measured at 393 and 320.
- **Pace counts the days that are over** (2026-10-10). `waProgress().expected` is the target times (elapsed − 1) / 7:
  counting today read "behind, ~1 by now" from the moment the arc went live, at 7:30 PM on day 1, a quarter of an hour
  before his workout. A session logged today still counts. On the start date before the start time the card says it
  starts "today", not "0 days out". **Start the next arc** after an arc he ended early (before Apr 1) starts next winter's,
  not the season still running.
- **The recap outlives the empty new year.** Progress › Overview used to return on "Nothing logged in 2027 yet" before
  the recap card and the radar, so from Jan 1 until the first session the "Your 2026" recap could not be reached.

**The strength radar is `muscleResponse(12, {clean:true})` times 12** (his choice: growth over 12 weeks).
- The `clean` option is opt-in, and the default the agents read is unchanged.
- `ckRadar()` draws on `CK_W` with a 0% ring. A group without data is drawn hollow and labelled
  "no data".
- `strengthRadarHTML()` names the groups that are flat or down, then the leader.
- It sits on Progress › Overview, under the year card.
- On his data (Oct 5), Glutes read +36%, because Hip Thrust Machine is a new lift still gaining fast.
  That is honest, but worth knowing before trusting the shape.

**The plateau watch is on the device, free, never stored, and ONE result** (V4 stage 5, 2026-10-04; made
context-aware and honest about how sure it is on 2026-11-08, his plan `iron_hub_stall_detection_plan.md`). His
export showed about 4 of 13 flags describing something real: a bench at its best e1RM called stalled, two resets he
chose judged against the old weight, a leg curl called "at the top" 15 lb under a weight he had lifted, an EZ curl at
the top of its range waiting on a 17% jump, a pushdown flagged off 4 clean sessions, Form Focus lifts adding reps at
one weight called falling; JM Press (-7%) and Dips (15 -> 12 reps) were missed.
- **One row per lift, read by everything:** `plateauRisk(nm, ctx)` returns `{state, word, lvl, col, conf, sig, rule,
  used, excluded, reset, drop, maxedStale, quiet, flag, program, doText}` plus the old fields. The Strength hero, the
  chips, the Library, Overload, `intelSummary()` (its pattern line, the "Lifts the watch calls holding" facts and the
  watch line, neutral rows included) and DELTA's diagnosis all read it.
- **States, first match wins:** `pain` (a level 2+ flag in `PW_PAIN_DAYS`) > `stale` (no session in max(21 d, 2x its
  usual gap)) > `reset` > `thin` (under `PW_MIN_CLEAN` (6) clean sessions or `PW_MIN_SPAN` (21) days) > `stale` (no
  clean session lately, the reasons named) > `top` (MAXED AND at the heaviest weight logged in 90 days) > the evidence:
  `falling` > `holding` (a stall) > `slowing` (gain halved, effort creeping, misses) > `holding` (three flat, or at the
  top of its range) > `ok`.
- **Colour follows confidence (his call):** red only for falling on firm evidence (`PW_FIRM` (8)+ clean sessions, a
  21-day window, no deload ended in the last week); amber for a firm stall or slowdown; everything else is `lvl:'calm'`
  (neutral). `pwIssue(r)` (red/amber) is what feeds DELTA's diagnosis, the bell and the Overload verdict; `pwFlagged(r)`
  (any state but on track, or `lvl` for a row without a state) is what gets a word on a chip. A stall reads **holding**,
  never "stalled" (his word).
- **Clean sessions:** `pwExcludeWhy()` is the one list (deload, home, coach plan, a kept easy/recover call, swap, reset
  weight, recover step-down, lift deload, 1RM test, today's change, and "short on time", which is watch-only so
  `sessionModLift()` and predictions do not move). Bench Practice lives in `S.practice` and never reaches it. The first
  clean session after a deload is `post`: data, never a reference.
- **The rules:** falling is the last 3 clean sessions' median e1RM under the 4 before by 4% on a compound
  (`mesoIsCompound`), or max(6%, one increment's share) on an isolation lift, with EVERY one of the 3 under (one good
  day says it did not fall: his leg press 540 x 13), and not when it sits at the top of its range at the same weight.
  A recent best is a new high in the last 2 sessions, strictly above the 6 before (a lift that never moves ties its
  best every session, and that is a stall). Capped (`pwCapped()`) is the best set at the top and the mean within a
  rep, judged by the range the session was LOGGED under (`logRec.plan`), not today's.
- **Bodyweight lifts** (0.5-lb marker) are watched on their reps, with his weigh-in added to the e1RM.
- **Resets (`pwResetFor()`, read only):** an override in force under his top set going in, an `inv-override` decision
  with to under from (it outlives the 2-session hold), or his "Intentional reset" tap. In progress `PW_RESET_DAYS` (42)
  or until a clean session regains the level before; then judged as usual ACROSS it. Slipping under its own first
  session is amber. It binds the agents only (his call): `agConflict()` refuses a heavier `liftReset` or added sets on a
  lift in a reset; the engine is untouched.
- **His corrections (`liftNotes`, a `SYNC_HISTORY` collection `'k|'`, immutable rows, `pwMark()` with `save()`):**
  `reset` / `badday` answer the drop question (`pwDropFor()`: a clean session at least max(1 increment, 8%) under the 3
  before, still lower since, not explained by the plan or a reset, asked once, in the session summary and on the row);
  `intended` and `wrong` quiet a row `PW_QUIET_DAYS` (14), and `wrong` also archives the lift's open Investigation flag
  (the existing 14-day suppression), and stops counting once the row gets worse. The buttons show only where an answer
  changes something. A MAXED lift under its heaviest logged weight offers **Turn MAXED off** (confirmed, `applyExFlag()`).
- **An open Investigation flag is a line on the card, not a floor (his call).** On Overload a red/orange flag still means
  "needs attention", as Investigation's own verdict.
- **Program before exercise (`pwApplyProgram()`):** 2+ flagged lifts sharing a group whose own `plateauCauses()` show
  that group's sets up 30%+ become one note (it carries their red; the rows go neutral with `lvlWas`), shown first in the
  risk list, Overload, a chip on Today, the summary and `pdContextLine()`, with `pwProgramCheck()` (volume, the bulk band,
  a recovery slump, weeks since the last deload). DELTA is still asked about the rows; the bell reads `lvlWas`.
- **Overload (`olSignals()`):** for a watched lift the verdict is the watch's (`pwOlVerdict()`, floor and ceiling); a lift
  nobody trained in `PW_STALE_DAYS` is `stale` ("No recent data"), sorted last and kept out of `olAgentContext()`.
- **DELTA's read is shown only while it applies:** `agValidateDiagnosis()` stores the asked row's `state`, and `pdRead(nm,
  row)` hides a read once the lift's state has changed (a legacy read only while flagged).
- **The volume rule never loosened:** `agVolumeLastBlock()` is the old watch's reading rebuilt test by test (stalled3 on
  4+ clean sessions, `pwSlopeFall()`, `slowRaw`, effort and misses signs, a red/orange flag) plus a flagged row or a reset.
- **Investigation's reset weight is on the lift's ladder** (`invResetWeight()`, `agSnapWeight()` from his last top set):
  90% of 200 on his 15-lb leg machines is 185, not 180. Agent weights were already snapped.
- **Sessions, not weeks:** he trains most lifts once an 8-day cycle. Split lifts trained in `PW_LIST_DAYS` (90) are listed.
- **On his real data (2026-11-08):** Bench on track; Cable Row, Preacher Curl and Leg Extension resets in progress; Leg Curl
  and Reverse EZ holding at the top of their range; Single Arm Pushdown not enough data; Squat slowing; Hanging Leg Raise
  holding; Dips and JM Press falling, grouped as one triceps note (triceps sets +72%).

Around it:
- **Likely factors:** `plateauCauses(nm, endKey, days)` returns at most 3: recovery, food, volume,
  load, consistency, and "stale stimulus" only by elimination. Each has High / Medium / Low, and all are
  worded "likely, not proven". It never invents one.
  - Food leads with the scale (`bulkRate(weeks, endKey)`). It counts days under target only where the
    target that day is known (`calTargetOn()`, from `S.targetHist`, which starts 2026-10-03), so
    September is not judged against today's higher target.
  - A stall is read from a week before it began (`pwCauseWindow()`, 21-56 days).
- **Dips:** `liftDips()` mirrors `e1Spike()`: a clean session `DIP_PCT` (6%) under the median of the
  3 before it.
- **"Rising":** `pwRising()` compares each lift with itself before its newest session, by
  `pwAsOf()`, which shortens `S.logs` synchronously and restores it in `finally`. That is what stops
  a lift stalled since August re-announcing itself.
- **Notifications** (`pwNotifItems()`, worked out when read; each id carries the lift or the day):
  - plateau rising;
  - PR in reach today (`prWatchAt()`, shared with LIVE's PR watch, within the range);
  - PR likely this week;
  - deload due now, or planned within 2 days;
  - last night's cycle never ran (it names the cap if that paused it). It runs nothing itself.
- **Where it shows:**
  - Today's and the Hub's chips (`pwChipsHTML()`): his main lifts, then one chip for the rest. The
    name travels in `data-lift`, never in an onclick string.
  - On Overload, a line under each row that is not on track, opening its factors (flagged rows) and how it was read
    (`pwReasonHTML()`: the rule, the sessions read, the ones left out and why, one "What to do" from `pwDoText()`, and
    his corrections). The hero's why section shows the same view. The open state is module-scoped (`pwOpen`).

**A jump earned on grinders repeats once** (`grind-hold`, in both `recommend()` and
`classifyDecision()`). At the ceiling with grind or fail top sets, the weight repeats. It goes up
anyway if the session before was already that repeat (same weight, also at the ceiling), or a lift
that always grinds at the top would never climb. In-session, `intraAdvice()` reads two sets:
two easy sets at the top of the range ask for another rep, never more load; two grinders under
mid-range step back one increment, but never on a strength lift.

**The jump has two more cautions** (Mark's choice, 2026-09-28, after the engine prescribed 335 lb on
his squat off a real-but-one-off 325x10). Both are in both trees, and both only ever hold a weight:
- **The spike guard** (every lift, `e1Spike()`): a session whose best e1RM sits more than
  `SPIKE_PCT` (8%) over the median of the lift's previous three cannot earn a jump (`spike-hold`).
  The session before reaching within `SPIKE_CONFIRM` (3%) of it counts as backed up, so a real new
  level releases itself after one repeat. It needs `SPIKE_MIN_PRIOR` (2) earlier sessions.
- **The two-set rule** (strength-mode lifts, `atCeiling()`): the ceiling needs `STR_CEIL_SETS` (2)
  sets AT the top weight with the top of the range, not one great set. LIVE prescribes the first two
  sets at the top weight to match, and `intraAdvice()` moves to the back-off load only after them.
  Grind-hold's "the session before was already that repeat" uses the same `atCeiling()`.

Replayed over his 80 real sessions (433 prescriptions, HEAD vs the change, history before each
session only): 32 changed, **none heavier**. The squat's one-set jumps held, and five spike-holds
landed nearer what he actually lifted.

**Form Focus obeys MAXED and the day's call** (`form-maxed`, `form-defer`). Its branch used to return
before either was read. And Form Focus wins over strength mode on the same lift: LIVE runs it
`repMode 'hyp'`, with no back-off and no strength rules.

**A reset holds `RESET_HOLD_SESSIONS` (2) sessions, then hands back to the engine.** It used to pin the
weight for its whole 10-30 day window, blocking an earned jump and repeating an agent target he had
failed. New resets carry `at` and `sessions`; `invOverrideState()` counts the sessions from the logs
(deloads excluded), never writes, and is what LIVE, Investigation and `agContext()` all read. A reset
without `at` (written before 2026-09-28) keeps the old pin until its date.

**Per-lift flags read the split in force, else the permanent split** (`exSlotsFor()`). A lift trained
during a meso block but not in it (a LIVE swap, a coach plan) used to find no slot and lose MAXED, its
increment, Form Focus and strength mode. It is a fallback, not a union: a lift in the block reads only
the block, because a block sets its own rep modes. **Increments are inherited** (`slotInc()`): every
writer that adds or converts a slot uses the lift's existing increment, and when slots already
disagree `incForExercise()` prefers the one that is not the default (setting it goes through
`applyExFlag()`, so a non-default is one he chose). His leg curl read 5 instead of its 15-lb stack.

**Strength mode off is stored as `'hyp'`,** and `load()` seeds bench and squat only when the field is
absent. The toggle used to store `null`, which the migration read as absent and turned back on at
every boot. The toggle also writes every slot of the lift on the permanent split.

**A session records what it was** (`endLiveSession()`): `plan` (per lift `{w, lo, hi, n}`, the real
prescription), `coachPlan`, `swapped`, and `scheduled`. Decisions record the weight LIVE actually
prescribed (`call-recover`, overrides, deloads, home rounding). Sessions before 2026-09-28 have none
of these.

**A session he never ended is saved, not dropped** (`liveRecoverStale()`, 2026-10-10). `loadLiveDraft()`
resumes a draft only from today or the last `LIVE_DRAFT_MAX_H` (6) hours. An older one used to be ignored
without a word, and the next session's draft overwrote it. He trains at 7:45 PM, so one forgotten End lost
the whole session by about 1:45 AM. At boot, after the pull, a stale draft with logged sets goes through
`endLiveSession({recovered:true})`:
- it is dated the day it started, and its `endedAt` is its last set;
- the record carries `recovered:true`;
- it is a deload session only by its own lifts' `_deload`, never because a deload is in force today;
- the summary and a CHARLIE line say it was never ended.

One with no sets, or one already in the log (same `startedAt`), is only cleared. `sessionNote()` now
compares a session with the one before its own date. "Not today" compared a session dated yesterday
with itself.

Since 2026-10-03 it also records how it was modified. Each set carries `p:{w,lo,hi}`, the call it
was given, so a lighter weight he chose can be told from one he was prescribed. A 1RM-test set
carries `rm:1`. The log carries:
- `swapFrom` (new name → the planned lift it replaced; `swapped` still lists swaps and adds
  together, as old readers expect);
- `removed` (planned lifts he dropped);
- `call.toggledAt`;
- `skippedCheckIn`.

**`sessionMods(log)` is the one reader of all of it**, and `sessionModLift(m, name)` asks "was this
lift's number shaped by something other than the engine?". Since 2026-10-10 that includes a lift the chat
changed for today (`todayAdj`). `predInterrupted()` and `expExcluded()`
are written on it (no change for existing logs). Investigation's trend and its auto-resolve use
`e1rmSeries(nm, {excludeHome, excludeMod})`, so kept recover days, resets, coach plans, swaps and
1RM tests no longer read as a decline. `recommend()` / `classifyDecision()` do NOT read it yet:
changing what counts as the "last session" changes prescriptions, which needs a replay first.

**Effort reads go through `effBucket()`.** It prefers the 0–100 lever (`s.ef`) and falls back
to the legacy tag (`s.e`), which is what lets months of already-logged sessions keep working
with no migration pass. Anything writing effort must write both fields.

**And anything *copying* a set must carry both fields.** `endLiveSession()` used to rebuild each
set as `{w,r,e}`, so from 2026-08-24 to 2026-09-24 every set carried the lever for the whole
session and then lost it at save; only the bucket reached `S.logs`. The only test looked at the
in-progress set, so it stayed green the entire time. `liveSetToLog()` is the one copy now, and
it also carries `ts` (ms, when the set was logged). The log record gets `startedAt`/`endedAt`
(ms). Sets use `ts`, not `t`, on purpose: on a *record*, `t` is the sync write stamp
`mergeUnseenHistory()` reads. Measure training time from the first to the last set's `ts`,
not `endedAt`, which is only when End was tapped. Sessions from before 2026-09-24 have none of
these fields.

**After a session: an instant summary, one optional tap, and a debrief the next morning.** None of
it is a new API call.
- `sessionSummary(log)` is pure: sets against `logRec.plan` (a lift he skipped counts), RPE against
  target from `feltVsPlan()`, and **at most one flag** in a fixed order: pain flagged that session,
  two sets under the floor at the prescribed weight (a heavier single on a strength lift is not a
  miss), felt a full RPE over target, two or more planned sets skipped.
- The feel capture is 1-5 (`FEEL_LABELS`) plus a note of up to 140 characters. **Optional, and never
  blocking**: the session is saved before the overlay opens, Done with no answer writes nothing, a
  second tap clears a mis-tap. It is stored in **`S.sessionMeta`, its own `SYNC_HISTORY`
  collection** (`'m|'+logId`), never on the log: the log may already be pushed, and
  `mergeUnseenHistory()` only adds rows a snapshot lacks, so a field written onto it would lose to
  the snapshot. `feel` is his subjective read; `feltVsPlan()` is RPE from his effort taps. They are
  shown to DELTA separately and never averaged.
- DELTA's debrief is a `debrief:{well, change, next}` key in its **existing** nightly JSON (like
  `overload`), asked for only when `agDebriefTarget()` finds an undebriefed session from today or
  yesterday, so a rest night costs nothing and a session logged after the 9 PM cycle is caught the
  next night. The session id is taken before the await; `agValidateDebrief()` keeps strings only,
  clipped to 160, tied to a real session. It lives in `S.agents.debrief`, merged newer-wins in
  `applyPulled()` like the brief. The morning brief is told about it and told not to repeat it,
  because Today shows it right under the brief. Anything to apply still goes through DELTA's
  `proposals`. Cost: about $0.004 a night on nights he trained.

**The status strip never renders during LIVE**, and is painted *before* the
`refreshBlocked()` gate. That gate stops a repaint eating half-typed input; a read-only bar
cannot do that, and behind the gate it would go stale exactly when the app is in use.

**The WHOOP relay's cron is not a schedule, it is a lottery.** The workflow asks for every 15
minutes (96/day). Measured over its first 88 runs, GitHub delivered **3-9 a day** - median gap
between runs **3.2 hours**, p90 **6.8h**, worst **12.6h**, and on 2026-08-30 no run at all between
06:00 and 10:00 local. Scheduled workflows on public repos are best-effort and a high-frequency
cron is throttled hardest, so *raising* the frequency makes it worse, not better. Nor is this
top-of-hour congestion a different minute would dodge: the surviving runs land on 45 different
minutes-of-the-hour, i.e. GitHub both drops and arbitrarily delays them.

That matters because the brief's usable window - from WHOOP scoring a recovery to
`AG_BRIEF_WHOOP_CUTOFF` - is only about three hours, which is a coin flip against a 3.2h median
gap. So `whoopMaybeKick()` **POSTs a `workflow_dispatch`** when today's recovery is still missing
in the morning; a dispatch is not rationed the way a schedule is and starts within seconds. Three
consequences to keep in mind:

- **A classic token needs the FULL `repo` scope. Not `workflow`, and not `public_repo`.** This
  has been wrong twice and cost a morning each time, so take it from the docs rather than from
  intuition: *"OAuth tokens and personal access tokens (classic) need the `repo` scope to use
  this endpoint."* `workflow` only governs editing workflow *files*. And `public_repo` is **not**
  a sufficient subset even though this repo is public - GitHub refuses it with
  `403 Must have admin rights to Repository.`, which is verbatim what his phone reported on
  2026-09-08 after he had followed the app's own instructions exactly. A fine-grained token
  limited to this repo with *Actions: Read and write* plus *Gists: Read and write* is far
  tighter than `repo` and worth trying first, but this endpoint is inconsistent about honouring
  fine-grained tokens, so it is offered as an option rather than the recommendation. **Test
  relay** settles it either way in seconds.

  Getting this wrong is cheap to do and expensive to notice, so it is asserted: the suite checks
  the CHARLIE log entry, the Settings verdict and the first-run instructions all name `repo` and
  say plainly that `public_repo` is refused. Do not soften those assertions - they exist because
  the copy, not the code, is what failed here.

- **Do not diagnose a token by guessing. Ask GitHub.** Two guesses were wrong before this rule
  existed. `ghTokenScopes()` reads `X-OAuth-Scopes` (a classic token's granted scopes; the header
  is *absent entirely* on a fine-grained one, which is how the two are told apart) and `GET /user`
  for the account the token authenticates as, and `ghTokenDiagnosis()` turns that into one
  sentence. Both `X-OAuth-Scopes` and `X-Accepted-OAuth-Scopes` are on GitHub's
  `Access-Control-Expose-Headers`, so a browser can genuinely read them - most response headers it
  cannot, so check that list before relying on a header here.

  The **account** is checked before the scopes and reported first, because it outranks them:
  `Must have admin rights to Repository.` is exactly what a token belonging to anyone without
  write access to this repo receives, however many scopes it carries. Only `whoopTestRelay()` and
  `replaceToken()` pay for the extra request - the 6 AM path stays as cheap as it was.
- **The throttle state is in its own `localStorage` key, not in `S`.** In `S` it would sync, so
  one device's dispatches would spend another's budget - and a new `S.meta` field would not
  survive `load()` on an existing install anyway (see the migration note above).
- **The cron stays underneath.** The dispatch is a nudge on the mornings it matters, not a
  replacement, and the app must still work when it fails.
- **Whether the token can dispatch is a PER-DEVICE fact, and has to be shown per device.**
  `syncPayload()` strips `ghToken` and `applyPulled()` keeps the local one, so the phone and the
  laptop routinely hold different tokens - replacing it on one does nothing for the other. On
  2026-09-08 that is exactly what a "fixed" token looked like from the outside: one device
  working, the other still 403ing at 6 AM behind a green **Connected** dot, because Connected
  only ever meant *gists* work. `whoopRelayNote()` / `whoopRelaySet()` record the last outcome in
  their own `localStorage` key (same reasoning as the throttle above), Settings renders the
  verdict under the Connected line, and **Test relay** re-checks it on demand rather than making
  him find out at 6 AM. And read the body: `ghErrMsg()` surfaces GitHub's own `message`, because
  "cannot trigger Actions" is a guess at the cause and "Resource not accessible by personal
  access token" is the answer.

**The agents run on a server now, and the server is the app** (his ask, 2026-11-01). On Oct 31 no device was open
until 11:30 PM, so the 9 PM cycle started then, and on school Wi-Fi the brief cannot be written from his phone at all.
Mark chose the API key as a repo secret (`ANTHROPIC_API_KEY`), a Cloudflare clock over GitHub's cron, and Reload plus
an automatic rewrite at 10.
- **The pieces.** `clock/` fires every 30 minutes and dispatches `.github/workflows/agents.yml` on the Eastern slots:
  9:00, 9:30 and 10:00 PM, and every half hour from 6:00 to 10:30 AM with a WHOOP re-read first (a job in the relay's
  own `whoop-sync` concurrency group, so two relays never spend one refresh token). `scripts/agents/run.js` loads
  `index.html` in jsdom with `IRONHUB_HEADLESS`, so `appBoot()` never runs, and calls `runnerTick()` then
  `runnerFlush()`.
- **Nothing is re-implemented.** The gates are `agMaybeAutoRun()` and `agMaybeMorningBrief(true)`, the cycle is
  `agRunAll()`, and the push is `syncPush()` with its reconcile. The suite runs the real script end to end, including a
  phone session landing mid-cycle that must survive the push. A new boot-time duty does NOT run on the server, because
  the boot does not; anything the server must do goes in `runnerTick()`.
- **Fresh state each run, and the pull must succeed first.** Run on blank state, the 9 PM gate reads open and the push
  would carry an empty history. `runnerTick()` returns at a failed pull. Only `ironhub:usage` and `ironhub:device`
  carry over, in the state gist's `runner_local.json`. `spendLedgerSync()` rebuilds a day from the log, so a run
  starting with an empty log would shrink the morning's spend; a state gist it cannot read is fatal for that reason.
- **The device yields 9 PM for `RUNNER_GRACE_MIN` (45) only while the clock is alive** (`runnerClockAlive()`:
  `S.agents.runner.autoAt`, stamped only by an AUTOMATIC run that did something, within `RUNNER_CLOCK_HOURS` (30)), and
  asks again after its pre-pull. From 9:45 it runs the night itself if the server did not.
  - **A Reload is not the clock** (found 2026-11-05). From Nov 3 the Cloudflare clock dispatched nothing, but his
    morning Reloads kept stamping `S.agents.runner`, so `runnerSeen()` stayed true and every device waited for a
    server nothing was starting: the cycle ran at 9:45 at best, or whenever a device was next opened, and no brief was
    written without a tap. Reload keeps the previous `autoAt`; `runnerSeen()` still answers "is the server set up"
    for Reload itself.
  - **A dead clock leaves evidence.** A device that runs the night because the clock did not logs one CHARLIE line
    (`runnerClockNote()`), Settings' glance has a **Server** row (`runnerHealth()`), and a stopped clock is named in the
    folded Connections summary.
  - **GitHub is asked too, within minutes** (`runnerClockCheck()`, his ask, 2026-11-03; merged 2026-11-09). `autoAt` takes
    up to 30 hours to say the clock stopped, and a morning slot with nothing to write never stamps it. So the device
    sends one public GET of `agents.yml`'s dispatched runs over the last 26 hours (at most every 10 minutes, from
    `agForegroundCheck()`, this device's token only if refused anonymously) and matches them to the clock's own slots on
    the Eastern clock (`RUNNER_NIGHT_SLOTS` / `RUNNER_MORNING_SLOTS`, checked against `clock/src/worker.js`).
    `runnerClockJudge()`: two slots missed in a row is `missed`, the newest slot's run failing is `failed`, and a Reload is
    no slot's run. The result is module-scoped (`_runnerClock`), never `S`, and only asked once the server has run in
    `RUNNER_WATCH_DAYS` (14); the server itself never asks.
  - **One Server row and one warning, never two** (his pick, 2026-11-09): GitHub's `missed` / `failed` (`runnerClockFault()`)
    outranks `runnerHealth()`'s line, in the glance row and the Connections summary; the bell carries `runnerClockNotif()`.
    `runnerHealth()` / `runnerClockAlive()` alone still decide whether a device takes over at 9 PM.
  - **The clock keeps its logs** (`[observability]` in `clock/wrangler.toml`): `wrangler tail` cannot connect from his
    home network, which blocks `*.workers.dev`, so read them in the dashboard (Workers › ironhub-clock › Logs).
- **Reload** (`briefReload()`, every brief button) dispatches `mode: reload` after `spendManualOk()`, with `over:'1'` when
  he said yes past the cap. It writes on the device instead when there is no sync, when the server has never run
  (`runnerSeen()`; a job with no key would leave him waiting for nothing), or when GitHub refuses, naming GitHub's
  reason in the feed. `_briefReload` is module-scoped; past `RUNNER_RELOAD_WAIT_MS` it says the run may have failed.
- **The Actions log is public.** The runner prints what it did and nothing of his data, and the suite checks that.

**A `setInterval` is not a scheduler on iOS.** Everything agent-side - the 9 PM cycle, the morning
brief, the relay kick - is checked at boot and then on a 15-minute `setInterval`. That interval is
frozen for as long as the app is backgrounded, which is most of the day on a phone, so in practice
it only fires when he happens to leave the app open and foregrounded for a quarter of an hour.
`bgSyncTick()` and the update checker were already wired to `visibilitychange` for exactly this
reason; the agent schedulers were not, and on 2026-09-08 that cost him the brief. The page booted
at 6:38 AM with no recovery yet (correct - the relay's previous run was 6:01 and WHOOP had not
scored), was backgrounded, and the next relay run landed today's recovery in the gist at 10:35,
35 minutes past `AG_BRIEF_WHOOP_CUTOFF`. He opened the app that afternoon, `bgSyncTick()` pulled
the recovery in and put a HIGH on screen, and nothing re-asked whether the brief could now be
written. Because `agMaybeMorningBrief()` returns before it spends a call, there was not even a log
line to explain the silence; he wrote it by hand at 7:09 PM.

`agForegroundCheck()` is the single entry point now - boot, `visibilitychange` and `online` all go
through it, in one order, throttled to once a minute so switching in and out cannot spend a call
per switch. It runs **after** the pull resolves rather than alongside it: the pull is what brings
today's recovery in, and checking the brief against pre-pull state skips for precisely the reason
the check exists. Anything else that must happen "when he next looks at the app" belongs in that
helper, not in a new interval.

**A gate that declines must leave evidence.** `agMaybeMorningBrief()` returns *before* it spends a
call - correct, and it means every decline used to leave nothing behind at all. That silence has
been the entire problem twice: 2026-09-08 (never ran, nothing logged) and 2026-09-09 (still no
brief on a morning the relay demonstrably succeeded at 6:37 and 7:55 AM). Guessing which gate
closed was wrong every single time. Each gate now calls `briefNote()`, and `renderHome()` prints
the reason where the brief would have been instead of rendering nothing - with `briefWhoopDetail()`
saying what WHOOP data the device actually holds, which is the fact that separates "the relay never
delivered", "it delivered yesterday's" and "it is here and something else is wrong". Repeats
collapse into a count so the record cannot grow without bound. Kept per-device in
`BRIEF_TRAIL_KEY` for the same two reasons as the relay note.

If you add a gate to that function, give it a `briefNote()`. A silent `return` there is how this
became a three-day bug.

**A relay that cannot READ its token store must fail loudly, not fall back.** WHOOP rotates the
refresh token on every use, so the seeded `WHOOP_REFRESH_TOKEN` secret was spent on the very first
run this relay ever made; the live one lives in the state gist. `readStoredToken()` used to catch a
gist read failure and fall back to that seed, which could not possibly work - and reported a
**GitHub** auth failure as `token refresh failed (400)`, pointing at WHOOP. That is what
2026-09-09 looked like from 3:27 PM: a step dying in 1000ms, too fast to have reached anything but
the first call, after succeeding all morning. A read failure is fatal now and names
`IRONHUB_GIST_TOKEN` (a classic PAT expires on a fixed date). An unreadable *file* inside a gist we
could read is still the genuine first-run case and still falls back to the seed. Nothing is lost
either way - the rotated token stays in the state gist and resumes as soon as the secret works.

**WHOOP can kill the relay's sign-in, and then the relay has to say so.** From 5:49 PM on
2026-10-03 every run failed with `token refresh failed (400): invalid_request`. The first one took
12 seconds and every later one about a second, which matches a known WHOOP fault (community thread,
Jul-Aug 2026). Its refresh endpoint rotates the token and *then* returns a 502, so the new token
never arrives and the old one is spent. Nothing on our side can get that token back; the fix is
`node scripts/whoop/whoop-auth.js` and a new `WHOOP_REFRESH_TOKEN` secret. Three things made it
worse, and all three are fixed:
- **Re-authorizing could not work.** The stored token always won over the secret, so a fresh
  secret was never read. `spendRefresh()` now falls back to the secret when WHOOP *refuses* (400/401)
  the stored token, but only to a secret value never sent before (`seedTried`, a 12-character hash
  in the state gist). It never falls back on a 5xx, because the stored token may still be alive and
  sending an older token from the same authorization is what a reuse check punishes.
- **The useful part of WHOOP's error was cut off.** `error_hint` came after the 200 characters kept.
  `whoopErrText()` leads with it, and `redact()` keeps tokens out of the log, which any signed-in
  GitHub user can read on a public repo.
- **The app blamed the wrong credential.** It cannot read Actions logs, so CHARLIE and Test relay
  said every failed run was `IRONHUB_GIST_TOKEN`, which was working. A failed run now leaves
  `relayError` `{at, kind, message, reauth}` in `whoop_data.json`, beside the last good data, and
  any run that signs in clears it. `whoopRunFailText()` reads it. **No note is evidence too:** a
  relay that cannot read the gist cannot write one either, which is the gist-secret case, and only
  then is that secret named. A note older than the failed run is ignored. Settings shows the note
  and the Connections summary says "WHOOP needs re-authorizing". A failed run is stored as
  `kind:'run'`, never as "this device's token cannot trigger a run" (it just did).

The suite runs the real script end to end (`spawnSync` with a `-r` preload that fakes `fetch`), and
`IRONHUB_RELAY=...` points it at a mutant of the relay the way `IRONHUB_HTML` does for the app.

**The relay merges, it does not clobber.** WHOOP creates a recovery record *before* it scores it
and omits the `score` object entirely while a cycle is `PENDING_SCORE`, so a run landing in that
window returns sleep and strain but no recovery. Because the job PATCHes `whoop_data.json`
wholesale, that used to *erase* a recovery an earlier run had already written for today. It now
carries forward any section this run did not get. Safe only because the app gates every section
on `date === todayKey()` independently - if you add a consumer that does not, this becomes a
stale-data bug.

**WHOOP comes in, never out.** `syncPayload()` deletes `d.whoop`. The Action owns
`whoop_data.json`; the app owns `ironhub_data.json`. Data not dated today is treated as
absent — a stale recovery score is worse than none because it looks current.

**Dated today is not the same as final.** WHOOP scores the night when it thinks he woke, and a
brief wake at 3 AM gets scored as the whole night; when he falls back asleep it rescores the same
record. On 2026-09-25 the 3:33 AM relay run read 28% / 4.55h, the brief went out at 6:41 quoting
it, and at 7:16 WHOOP said 50% / 7.03h. So the relay stamps `readAt` on recovery and sleep (a
carried-forward section keeps its own stamp, in `carryForward()`), and `whoopProvisional()` marks
a reading taken before `AG_BRIEF_HOUR`: `whoopMaybeKick()` asks for a re-read and the brief waits
for it, up to the same 10 AM cutoff. The brief records the `whoopScore` / `whoopSleep` it was
written with, and `briefWhoopDrift()` rewrites it **once a morning** (`rescored` flag) if WHOOP
later moves the score ≥10 points, across a band, or sleep by ≥1h. An unstamped reading or a
brief with no recorded score is never treated as drifted — no guessing.

**The WHOOP history is history, never today.** `whoop_data.json` also carries `history`: one row
per day, `{date, recovery, hrv, rhr, sleepHours, sleepPerf, strain}`, a rolling 180 days. The
relay backfills the whole window when it finds none, then re-reads the last 30 days on every run
(so missed runs heal), and merges field by field with the same carry-forward rule as today's
sections. Each field is dated exactly the way its today-section is, and naps are skipped.
History is best-effort: it can never cost today's sections, and a failed fetch keeps the
previous rows. `applyWhoop()` validates it row by row and stores `S.whoop.history`, capped at
`WHOOP_HIST_MAX`. **Nothing that asks "what is today" may read it.** `whoopFresh()`,
`whoopContext()` and `readinessNow()` read the dated sections only, and the suite checks that a
history row dated today is neither fresh nor in the prompt. The relay's pure helpers
(`historyRows()`, `mergeHistory()`, `serializeWhoop()`) are `require()`d by the suite, which is
why the relay runs `main()` only under `require.main === module`.

**Discord is a window, not a door.** `discord/` reads the gist and nothing else. GitHub only ever
gets GETs from it, and the suite checks this two ways: by scanning the source, and by recording
every request made across every command. No command may ever change Iron Hub state, including
proposals, which are view-only there. The Worker does **not** re-derive app math. Every push also
writes `discord_view.json`, built by `discordView()` from the app's own functions
(`readinessNow()`, `bmViewerData()`, `weeklyVolumeByGroup()`, `e1rmSeries()`), so Discord
cannot disagree with the app. Three rules:
- **It must never cost a sync.** `syncFiles()` always includes the data file. The view is
  best-effort, and if `discordView()` throws, the view is simply left out (tested).
- **Nothing reads it back.** `fetchGistData()` ignores it, so it cannot affect state on any
  device. Keep it that way.
- **It rides along on every push and every 60 s pull**, so `DISCORD_VIEW_MAX` caps its size.
  When it's too big, the least recently trained lifts are dropped first.

Nothing in the Worker calls Claude. A future command that does must be labeled as paid. Version
notes come from `.github/workflows/discord-release.yml`, which fires only when the build marker in
`index.html` changes, so skipping the bump also skips the announcement.

**The schedule doc is a window too, and a computed one.** CHARLIE writes the weekly schedule into
the Google Doc Mark has kept by hand since January (`gdocPush()`, nightly-free: it fires from
`agForegroundCheck()` and after a session is saved). **No model call is involved and none should
be** — the doc restates what `scheduledDayFor()` says and what `S.logs` holds, which a pure
function produces exactly and Sonnet would only produce expensively and sometimes wrongly. The
arrow points one way: nothing reads the doc back, and `gdocPush()` touches `S` only through
`agLog()` on a failure. Four things that removal or extension here must keep:

- **Sunday–Saturday, not `weekStartKey()`.** The doc has run on calendar weeks since the first
  entry; `weekStartKey()` is the *training* week (the day after the last scheduled rest day, and
  in cycle mode not 7 days at all). `gdocWeekStart()` is deliberately separate.
- **Today is never marked red.** `gdocStatusFor()` uses a strict `<` against `todayKey()`. A red
  mark on a day he may still be about to train would sit there all afternoon telling him he
  failed.
- **The URL and secret are a credential pair for a live document-editing endpoint**, so
  `syncPayload()` strips them next to `ghToken`/`apiKey`, which makes "is the doc being written?"
  a per-device question with a per-device answer — the exact shape of the 2026-09-08 WHOOP relay
  confusion. The card says so on the connected view, not only inside the edit form.
- **A 200 is not a success.** Apps Script answers `200 {ok:false}` for a bad secret, so
  `res.ok` alone would record a write that never happened, close the signature gate, and stop
  retrying. Check the body.

The Apps Script half is idempotent by label: a week already in the doc is rewritten in place, a
new one is inserted at the top, and weeks nobody sends are never touched — which is what keeps a
year of hand-written history safe. Editing `workout-schedule.gs` does nothing until it is
re-deployed as a **New version**; the `/exec` URL otherwise keeps running the old code.

**Photos never go in `S`.** State holds an index; the blobs live in their own gist, fetched
on demand. Everything in `S` is re-serialized on every save and re-uploaded on every sync. The index and the photo
gist's id are written after the upload's await, into the `S` that exists then (2026-10-10): written through
a reference taken before it, a pull landing mid-upload lost them.

## UI conventions

Design language: **"Forge × Ember"** (V3, chosen 2026-09-24). Forge keeps the identity: Saira
Condensed caps, industrial amber, big tabular numbers, dense rows with thin dividers. Ember brings
the warm brown-black ground, cream text, and rounded cards that are separated by shade rather than
outline. The mockups are the "Forge × Ember" page of the V3 Looks canvas (private artifact
`XVRZXGjKLeYeokfD4dpY5n`). The reskin ships in slices: 1 tokens/type/components (done),
2 chart kit and 3 navigation (done together), 4 screen layouts and 5 LIVE visual pass (done together), 6 off-CSS
colours (done). **The 3D muscle model keeps its colours** (`BM_C`/`bm3dColors()`); Mark asked
for it to be left as it is, and the flat 2D map stays too, because the two must match.

**The day colours (`S.split[*].hex`, `--d1`–`--d6`) were deliberately left alone.** As a
six-way categorical palette they fail the colour-blindness check: D1 red against D4 green is
ΔE 5.8, and D5/D6 are near-greys. But three re-stepped candidates that kept each day's colour
family all failed too. Red, green and gold cannot be made colour-blind-distinct while staying
red, green and gold. Every day colour always sits beside its label (`D1 · Chest + Triceps`), and
changing them would mean a migration of saved state for a marginal gain. If they are ever
changed, migrate only values still equal to the old defaults, so a colour he picked himself
survives.

**Discord's colours follow the app** (`discord/src/core.js` `COLORS`, `discord/src/chart.js`
`C`). Pushing does not deploy the Worker: it goes live only after `npx wrangler deploy` from
`discord/`.

**Charts go through the chart kit** (`CK_W`, `ckText()`, `ckPath()`, `ckArea()`, `ckDot()`,
`ckGrid()`): a recessive grid, 2px round lines, a wash under a single series, the latest point
ringed in the card colour, and direct labels in ink, never in the series colour. The kit only
decides how things are drawn; each chart keeps its own scale, so a restyle cannot move a point.
**Real events are marked through `ckMarks()`** (V4 stage 5), fed by `ckEventMarks(from, kinds)`.
None of them come from a model:
- deloads: logged deload sessions, a week apart or less joined into one band;
- calorie changes: `S.targetHist` changes (a one-day dashed line), plus weeks eating `MK_CAL_SHIFT`
  (250)+ away from the two before, drawn as a faint band from that Monday to Sunday (his choice,
  2026-10-04; only weeks with 4+ logged days);
- high-load weeks: `fatigueIndex()` over `PC_LOAD`;
- recovery slumps: `MK_REC_RUN` (3)+ days running 15+ under his usual;
- dips: `liftDips()`.

How they draw:
- Bands go under the lines and rings over them. A label that would land on another in its row is
  dropped by priority, and its line is still drawn.
- `anFanChartSVG()` takes `opts.histDays`, `opts.marks`, `opts.modDates` (a reshaped session is a
  hollow dot) and `opts.noMeter`. `lineChart()` takes `opts.marks`; the bodyweight chart uses deloads
  and calorie changes. Called without opts, both draw exactly as before.
**A chart can be read point by point** (the bodyweight chart, 2026-10-20). `lineChart(…, {hover:key})` keeps what it drew in
`_ckHov[key]`, and `ckHovWrap()` moves a crosshair and tooltip in place, with no repaint. A sideways drag of at least
`CK_BRUSH_MIN` hands two dates to the function named in `data-brush`; `touch-action:pan-y` keeps a vertical swipe scrolling.
Positions go back to dates in UTC (`ckUtcKey()`), because the axis is `new Date('YYYY-MM-DD')`. Without `hover` a chart draws
as before. Fan lines are monotone curves through the model's own points (`ckSmoothD()`), so a restyle cannot add a peak.
**The Strength hero draws the fan clean** (his note on its screenshot, 2026-10-21: "still looks sloppy"). The forecast's
numbers never change; only the drawing does, and only where the hero asks:
- `opts.fromFit` (`anFanDrawSeries()`): the fan starts at the fitted trend today, at the model's own spread that day.
  `anFanProject()` pins day 0 to `res.cur`, his BEST for a lift, so on a lift below its peak every line fell ~25 lb in the
  first sample. The dashed trend now runs into the forecast's ringed start, in ink (`var(--dim)`), not the confidence
  colour.
- `opts.bandOnly`: the range is the band alone, with no dashed p10/p90 lines (the hero says the range in words).
- `opts.rail` (`ckMarks(…, {rail:true})`): week-long marks are bars on a lane over the plot, food and training on lanes of
  their own, back-to-back heavy weeks one bar (`ckRailMerge()`), labels as wide as their text, and a key under the chart
  (`ckMarkKeyHTML()`) so a bar whose label made way still says what it is. Only deload bands sit behind the data.
- `opts.shortDates`; every fan chart's axis snaps to a round step (`ckNiceStep()`), and the expected value has a halo.
- **Any band that began before the chart's first day is drawn from the edge** (every chart). It used to vanish whole,
  which is how a merged run of heavy weeks disappeared.
Full-width charts draw on a 380-wide viewBox (`CK_W`). They used to draw on 700, which a phone card
shrinks to about half, so their 10-unit axis text rendered near 5px. The fan chart scales its
type with the width it is given. Each `ckArea()` takes its own gradient id; a shared id would
make two charts on one page paint with the same gradient. All of this is asserted.

**Navigation is four groups plus Live.** The bottom bar is `NAV_BOTTOM`: Today (`home`), Train,
Live (raised), Progress, Body. The Hub (`ops`, so the agent layer's id did not change; it was
called Coach until V4 stage 3) and Settings are round buttons in the top bar, and the LIVE/REVIEW
switch is gone. Sections kept
their ids; only their group moved. So `NAV_LEGACY` lists every section's current group, and
`navResolve()` routes by the section first: `showMainTab('analytics','an_recovery')` lands in
Body, where Readiness lives now. It then falls back to the group, then `NAV_MAIN_ALIAS` for
groups that no longer exist. A remembered section is only reopened if it still belongs to the
group. The suite checks every section is reachable from exactly one group. The exceptions are
`#today` (the hidden V1 render target) and `#coach` (the empty container left when Coach
folded into Operations).

**A view can merge sections** (slice 4). A view entry lists them in `show[]`, in reading order.
Progress is four views over eight sections: Overview = `progress` + `an_over` + `pg_more` (the year review sits under the
squat, above the Fatigue check, his ask 2026-10-20; `pg_more` is drawn by `renderProgressMore()` from `renderProgressV2()`, because
the photo handlers repaint through it); Strength =
`an_pred` + `an_strength` + `road` (the hero lives in `an_pred`, so it reads first since V4 stage 5);
Overload; Fatigue. Each section keeps its id and its
renderer. `showMainTab()` lights every part, orders them with CSS `order`, and sets the later
parts apart with a hairline (no second heading, since each part's first card already titles
it). **Every repaint goes through `navRenderSub()`**, so the refresh tick paints all parts, not
just the first. `NAV_LEGACY` maps a section to the view that shows it, so
`showReviewTab('an_pred')` opens Strength, and an old-style call naming a lower part scrolls to it.
A group with four views or fewer renders its sub-nav as a segmented control (`.seg`). Body's labels
are short on purpose (Weight · Fuel · Quality · Ready, his pick, 2026-10-05). The longer ones only
fit at 320px with the tightened track in the ≤360px rule, so re-measure if you lengthen a label.

**V4 stage 3: the A × C "Ember HUD" layout.** Mark chose it on 2026-10-03 (canvas artifact
`2FeybZrjfHfTuYCXzeLMGN`, page "A × C"). It keeps the Forge × Ember tokens and fonts; what changed is
layout. Two of his wording rules apply everywhere: nothing is called a "Mission", and waiting
proposals are counted as **requests** ("1 request"), never ideas.
- **One `#sidenav`, two forms.** At ≥900px it is the rail, and it collapses to 64px icons
  (`navCollapseToggle()`, kept per device in `uiPref('nav.collapsed')`). Collapsing changes the main
  column's width without a `resize`, so it calls `rerenderActive(true)`, or charts keep the old
  width. Below 900px it is a drawer opened by `#topMenu`. Its open state is the module flag
  `navDrawerOpen`, never the node, and any navigation, the scrim or Escape closes it. The bottom bar
  did not change. `.top-btn.top-menu` takes two classes because `.top-btn`'s `display:flex` comes
  later in the file; with one class the menu button showed on desktop with nothing to open.
- **Motion happens on navigation only.** `showMainTab()` raises `_navEnter` for that one render and
  adds a one-shot `enter` class to the sections it shows. The readiness ring draws in under the
  same flag. `rerenderActive()` and pulls never add either, so the 30-second repaint cannot replay
  an entrance. Under `prefers-reduced-motion`, `smoothScroll()` jumps (`'auto'`), `navEnterAnim()`
  does nothing, and the glow tokens are `none`. Every smooth scroll goes through `smoothScroll()`.
- **Today is a command centre** (`renderHome()`). From top to bottom:
  - the day, as eyebrow and title (on a rest day the eyebrow is the date, not "Rest day" twice);
  - the wheel: readiness ring, Start, and five tiles;
  - key lifts, then what to expect, the agents strip, plateau watch and the brief;
  - the time-sensitive cards;
  - "Details & raw data", folded and remembered (`home.details`).

  Start calls `liveStartSession()` directly on a training day, opens Live only on a rest day, and
  says "Logged" once today is in.
- **Today only reads.** Key lifts come from `todayKeyLifts()`, which calls `buildOneLiveExercise()`
  with the day's call exactly as `_startLiveNow` does. They never come from `buildLiveExercises()`,
  which consumes the coach plan and saves. The suite renders Today and checks `S` is byte-identical.
  `nextPrForecast()` is a window, from where p90 first passes his best to where p50 does, and is
  shown only when p50 gets there within `NEXT_PR_DAYS`. Minutes in the plan line appear only with
  `DENSITY_MIN` timed sessions (the median). `agStripState()` says "missed last night" only when
  the agent's newest log line is a could-not-complete newer than its last report.
- **The Hub is a map and one card** (`renderOps()`). ZULU sits in the middle with the three
  specialists around it. A line is lit only when that agent's report fed the last cycle
  (`hubFed()`: its `status.at` within `HUB_FED_MS` before `lastRunAt`, which the cycle stamps when it
  ends). Tapping a node selects it (`agSelectChat`). The selected agent's card shows:
  - waiting requests;
  - data reads (`status.consulted`, in words);
  - whether it fed the cycle;
  - its chat, directly beneath.

  Below that: the plateau watch row ("DELTA is watching", `pwChipsHTML()`), run bar, brief, pending,
  experiments, this week, the feed (agent glyphs), the folded
  letter, then the spend ring (`hubSpendHTML()`, `spendMonth()` against `spendCap()`) above the spend
  card. `opsSignature()` includes the month's spend. **Set cap** opens the spend card's fold before
  focusing its input, or the focus lands on a hidden input and does nothing. `SPEND_WARN_FRAC` is the
  one 80% line for the ring, the card's bar and the notification.
- **Restyled, every id kept:**
  - the summary overlay: `#sumHero` holds "Saved · D1", the big sets-against-plan numeral and the
    minutes (`summaryHeroHTML()`), so `#sumFacts` no longer repeats it;
  - the experiment card and Today's chip (`expProgHTML()`, with an interim effect that says "too
    early to call");
  - the Sunday card's week strip (`wpStripHTML()`, read-only; the chips stay the way to tag, because
    a day can carry two tags);
  - the prediction record's ring. `#an_pred` must still hold exactly three `class="card"`, so no
    extra class goes on that card's root.
- **Progress › Strength is a hero** (V4 stage 5, the A × C Progress artboard): `strHeroHTML()`,
  one `class="card"` in a `.str-span` wrapper. The wrapper spans both ≥1240px columns, and
  `#an_pred` still holds exactly three cards, because it replaced the intro card. From top to bottom:
  - ‹ lift › (`strStep()`; it shares `anEnsembleEx` with the ensemble card, so both show one lift);
  - the best e1RM, big, and a status chip (`strStatus()`: the plateau word, or the pace);
  - the fan chart with 12 weeks of history and the marks;
  - one line: "Four weeks out, a session most likely reads N". It is a session, not his best: an
    outlier best sits above the line. On a lift the watch calls slowing or stalled it adds "read it
    as the high side", because the line is fitted through older gains.
  - why it stalled or slowed (`strWhyHTML()`), or why the newest dip happened. A dip ring or its
    chip picks another (`strDip()`; a past dip uses `plateauCauses(…, {asOf:true})`, which leaves
    out consistency and stale because those describe the lift now);
  - plateau risk rows (8, then "Show all"; `strPick()`);
  - the two record numbers.

  `pwShow(nm)` opens a lift the hero covers (`strLifts()` = `anBigLifts(5)`) there, and any other
  on Overload. Density gets a weekly line (`densityWeekly()`): each session against its own day's
  median pace, shown from `DENSITY_WEEKS_MIN` (3) weeks.
- **Raw data last.** `rawFold(view, …)` wraps Best Sets (Overview), the PR log rows (Strength; the
  header card stays up), the 14 days of intake (Fuel) and every weigh-in (Bodyweight) in a fold remembered as
  `open.raw.<view>`. The V2 wrappers append cards after the base renderer, so they finish with
  `rawFoldsLast(sec)`, or the "last" fold ends up mid-page.

**Train in A × C** (his pick from the canvas page "A × C · Train, Body, Settings", 2026-10-05). Every
section id, element id and handler was kept; the old detail moved into folds, it did not go.
- **Plan** (`renderMeso()`) opens on `planHeroHTML()`:
  - the segment he is in, "2 of 5 days", with its rep range;
  - a timeline of the block before, this one and the two after (`planBlocks()` groups segments by
    `blockId`), each sized by its days. It has a legend rather than a label under each segment,
    because a 5-day block beside a 6-week one has no room for its name;
  - the strength split's approval warning, which stays in the hero and is never folded;
  - the next `PLAN_TILE_DAYS` (5) days from `scheduledDayFor()`, so a block's S1/S2/S3 and then the
    normal schedule;
  - today's lifts from `todayKeyLifts()` (reads only), with Start, Resume or Logged. The set count is the built
    exercise's (`l.n`, LIVE's `planned`), never the split's: on 2026-10-10 it printed "3 x 8-12" beside deload weights
    while LIVE gave 2, and ZULU was right;
  - Edit this segment. The Length stepper (`planLenStep()`) and the type chips (`planSetType()`,
    which asks first) call the week editor's own `mesoSetWeekDays()` / `mesoSetWeekType()`.

  The old "now" card folds under it (`plan.now`).
- **Log** (`renderLog()`): this week against the days planned, the streak (`streakStats()`), the
  year's count, and an 8-week Monday-to-Sunday strip (trained, today, missed, rest, ahead). Then
  filter chips (All, PRs, each day) and at most `LOG_ROWS` (30) rows. A row is lifts, sets,
  minutes from set `ts` (`sessionDensity()`), its PRs and his feel. A PR counts only for a lift that
  session trained (`logPRsOn()`). A row opens to its sets, Edit, Delete and the engine log. `logFilter`
  and `logOpen` are module-scoped, so the 30-second repaint keeps them. Screenshot import and manual
  entry fold into "Log a past session" with their ids (`shot`, `mDate`, `mDay`, `mForm`).
- **Library** (`renderLibrary()`): a search box and muscle chips (`LIB_GROUPS`), then a row per lift
  in the split and the block in force (`libLifts()`), with its plateau word, best e1RM, days and
  flags. **Typing filters rows in place** (`libFilterRows()`) and never repaints, so the box keeps
  focus. The query is module-scoped and survives the repaint. Tapping a row opens its card right under
  it:
  - why it is flagged, and the lift's step;
  - the Strength mode, Form focus and MAXED switches (`libFlag()` → `applyExFlag()` and `save()`;
    strength off is `'hyp'`);
  - Rename everywhere;
  - the old trend and cues in a fold.

  **Rename has one flow** (`exRenameFlow()`), shared with Settings › Exercise names: the same
  refusals, confirmation and save.

**Body in A × C** (the same canvas page, 2026-10-05). Ids and handlers kept, with one deliberate move:
**intake logging moved from Bodyweight to Fuel**, with the rest of intake. The ids (`nDate`, `nCals`,
`nProt`, `nMsg`), the tap ladder and `addNutrition()` are unchanged. `toggleNutExact()` and
`addNutrition()` now repaint Fuel.
- **Weight** (`renderBulk()`), from top to bottom:
  - the latest weigh-in, big, with a pace chip from `bulkRate(4)` / `bulkBand()` (`BW_BAND_CHIP`);
  - the weigh-in box (`wLbs`, `wDate`, `addWeight()`). `addWeight()` repaints through
    `REVIEW_RENDER.bulk`, or the sleep fold vanished until the next repaint;
  - the chart with its marks, then the verdict;
  - "Where it's heading": the fan's 8-week p10–p90 (`bwProjectFor(56)`), and the `bw7` record from
    `predRecord()`;
  - the last 4 weekly averages (`bwWeeklyRows()`, the same weeks `bulkRate()` fits);
  - the projection card in a fold, and every weigh-in as the raw fold.
- **Fuel** (`renderFuel()`): today's calorie and protein rings (`fuelRingHTML()`), from today's
  `S.nutrition` row only, judged by `nutTierCal()` / `nutTierPro()`. A tapped range shows as `~`. Then:
  - the ladder (`nutLogHTML()`) and the week card. Fuel's `#fuel .nut-pill` rule must never set a
    background: an id selector outranks `.nut-pill.sel.t-*`, and the selected pill's dark text then sat
    on the dark card (2026-10-05);
  - Close Today's Gap and meal timing;
  - the Pantry as a fold, open while nothing is stocked because "Start here" points at it.
    `fpOpenPantry()` opens it before scrolling;
  - timing, targets, and the 14 days of intake last (`nutHistFold()`).
- **Ready** (`renderAnReadiness()`) opens on `rdHeroHTML()`:
  - the ring is `readinessNow()`, with a line against his usual (`recoveryBaseline()`; within 8 points
    is "right around", the band `dayCall()` starts at) and today's call, which is left out on a rest day;
  - tiles for HRV, resting HR and sleep from `whoopOn(today)`. Today's numbers never come from the
    history;
  - `rdBarsHTML()`: 14 days, earlier days from the history and today from the dated section. Each bar
    is coloured against that day's own baseline, and a day with no reading is an empty slot, not a zero;
  - the recovery card, which now leads with the PR rate on below-usual days against usual;
  - `rdCheckinsHTML()`: five days. Energy is "from WHOOP" when he left the pre-fill, a sleep stub is
    "only", and today with no check-in is "not yet", never a skip.

  The analysis cards follow.

**Settings in A × C** (the same canvas page, 2026-10-05). The four groups and everything inside them are
unchanged, and the suite still checks they are the only `#settings > .sub.grp`. Around them:
- **"Connections at a glance" comes first** (`setGlance()` / `setGlanceHTML()`). It has four rows: sync,
  the WHOOP relay, the API key with this month's spend against the cap, and the schedule doc. Each is a
  dot and a plain line, from the same sources `settingsSummaries()` reads:
  - the relay's own note (`whoopRelayFault()`) outranks this device's verdict;
  - a triggered run that failed is "Runs are failing", never blamed on this device;
  - spend turns amber at `SPEND_WARN_FRAC`;
  - a doc that is not writing says why.

  A failure is red while every group is still folded: the same rule as the folded summaries, one level
  higher. A row opens the Connections group (`setOpenGroup()`, which never closes an open one).
- **The summaries say a little more.** Training names a strength block in force (a deload outranks it).
  Exercises counts MAXED lifts, not slots. App & data says when this device last exported, kept in
  `uiPref('app.lastExport')`, never in `S`.
- **Training states his gear** (`setGearHTML()`, from `GEAR_PLATES` / `GEAR_BAR` / `GEAR_DB_*`). In
  cycle mode it says, beside the anchor date, that moving it moves what today is.
- **Export backup and Check for update** sit at the bottom (`.set-foot`).

**A folded card can remember that it is folded.** `subSection(title, body, open, opts)` takes
`opts.pref` to store the open/closed choice per device in `localStorage['ironhub:ui']`
(`uiPref()` / `uiPrefSet()`). Without it, `subOpen` is session-only, as before. It isn't kept in
`S`, because it is a choice about this screen and would sync one device's layout onto the other.
`opts.summary` is the line a folded card keeps. Today's fuel timing uses it (`fuelNextLine()`, the
next window that has not started, taking `nowMin` so tests don't depend on the clock). So does
Settings, which is four folded groups: Training, Exercises, Connections and App & data. **A fold
must never hide a failure.** `settingsSummaries()` names a relay that cannot run from this device
and a schedule doc that is not updating in the Connections summary, visible while folded, for the
same reason the relay verdict sits under the Connected dot. If you add a failure state to a
Settings card, add it to that summary too.

**Charts are drawn at the width they are shown at** (`ckW()`, `ckH()`, `ckSparkW()`). Phones use
`CK_W` (380), the size he called perfect. On desktop a chart is drawn at its card's measured
width (the main column less the card padding, capped at 1000, halved for the ≥1240px two-column
sections via `ckW(true)`), and `ckH()` makes it proportionally shallower. Two earlier fixes were
wrong: stretching a 380-wide drawing across a 1000px card gave ~29px type, and capping it at
480px left the chart filling half the card. Only drawing at the real width fixes both. That is
also why the fan chart's type is fixed units rather than scaled with `w`. A desktop resize of
60px or more redraws the active tab. Width only, because the iOS toolbar changes the height on
every scroll. Every kit chart root still carries `class="ck"`.

**Status chips tint from their own colour.** `.pill`, `.ol-verdict` and the other tag classes
take `color-mix(currentColor)` for their ground, because chips set their colour inline. The small
title tick stays as the colour cue; every card that has one already states its status in words.

**LIVE was restyled without moving anything in V3** (slice 5). **V4 stage 4 moved things on purpose,
at his request** (the A × C LIVE artboard). `renderLive()` now runs in this order:
1. The header: day, call, finish time, clock. It is one line on a phone; the stage word, readiness
   and lift count go on the line under the segments.
2. A segment per planned set (`liveProgHTML()`).
3. The call card, then warm-ups.
4. The lifts already done, as rows.
5. The current lift (`.lv4`):
   - the eyebrow "Exercise 2 of 5 · set 2 of 3";
   - a big weight × aim, with chips for the range and plates;
   - the call line. It is the app's own call, so it is NOT drawn as DELTA: DELTA is the paid agent.
6. The dock: steppers inside one box per number, the reps box outlined because the call filled it,
   Log on the left and Done on the right as before.
7. Rest, then the quick chips.
8. "Muscles so far" (`liveMusclesHTML()`).
9. "Up next".

Every id and handler is unchanged (`dockW`, `dockR`, `dockEff`, `liveLogBtn`, `restSlot`, `sbClock`,
`sbProg`, `sbFin`, `liveex-N`). `liveStage()` gives the header's word and is read on the 1 s tick.
The idle screen opens with `liveBriefHTML()`, built from Today's own helpers and only reading. It
shows nothing on a rest day or once today is logged, and claims a call only when the call has data.
`.lv3-in` still needs `!important` because its old size is set with `!important`.
**The tool row (ⓘ, 1RM, ✎) sits above the weight numeral** (`.lv4-tools`, `z-index:2`), with 44px
buttons. At 124px the numeral's glyphs spill up over that row, and browsers hit-test the spill. Until
2026-10-05 a press on ⓘ landed on the weight and only the release on the button, so the tap never fired.
jsdom cannot hit-test; the suite checks the rule exists, and the fix was checked with real clicks.

| Token | Value | Use |
|---|---|---|
| `--base` / `--panel` / `--panel2` | `#16110E` / `#201915` / `#2A211B` | ground, card, raised element |
| `--amber` | `#F28A3A` | the one accent, DELTA |
| `--cyan` | `#54C2A4` | CHARLIE, positive trend (same value as `--good`) |
| `--good` / `--warn` / `--bad` | `#54C2A4` / `#E9B44C` / `#D2476B` | status, always with a word or icon |
| `--violet` | `#B79BFF` | ECHO, strength mode |
| ZULU | `#dfae36` | lead agent |
| `--text` / `--muted` / `--dim` | `#F4EADF` / `#BCAB9B` / `#978779` | ink, three levels |

Type: `--disp` Saira Condensed (caps, numbers, labels), `--body` Figtree, `--mono` IBM Plex Mono
only for genuinely tabular data. `--r-card` 18px and `--r-ctl` 12px are the radii.

**`--bad` is deliberately not the old red.** `#E15842` sat within a few ΔE of the amber accent for
a deuteranope, so "back off" and "your next set" read as the same colour. `#D2476B` was chosen with
the dataviz palette validator (CVD and normal-vision separation against the accent, on the warm
card surface). Re-run that check before moving either colour.

**A coloured `border-left` on a card is now a marker, not a rail.** 25 cards set it inline, and
on many it is the only status colour. The slice-1 layer draws it as a short straight tick beside
the title and inherits the inline colour, so render code did not change. Don't add new ones;
use a status chip.

Use CSS variables, never hardcoded hex, in new UI.

**Never repaint under the user's hands.** The live-refresh loop deliberately
refuses to re-render while an input has focus or while a LIVE session is active —
the dock can hold a typed weight/reps that isn't logged yet, and losing that
mid-workout is unacceptable. Preserve scroll position on chat repaints; only pin
to bottom if the user was already near the bottom.

LIVE's own taps repaint too: an effort preset, the pain panel, a DELTA reply. Until 2026-10-03
each of those wiped the typed reps and reset the weight, so effort had to be tapped first. Now
`renderLive()` carries every input in `LIVE_KEEP_INPUTS` across the repaint
(`liveKeepInputs()` / `liveRestoreInputs()`). It carries a value only while the context it was
typed in still holds (same lift, set number, set under edit, pain panel), so a logged set or the
next lift still starts clean. A new LIVE text input goes in that list. Dragging the effort slider
patches the readout in place (`effLeverPatch()`) and repaints only on release, because a repaint
replaces the slider under his finger.

**V4 stage 4, the numbers in LIVE** (his answers, 2026-10-04):
- **His gear is modelled by `liftLoad(nm)`, not `gearFor()`.** `gearFor()` is the older wraps, belt
  and sleeves helper. A second function with the same name silently replaced the first, so
  everything here goes through `liftLoad()`. It knows:
  - bar lifts on a 45 (Barbell…, Smith…, Trap Bar…);
  - plate machines with no bar (Leg Press, Plate-Loaded…, Hip Thrust Machine, Lying Leg Curl: he logs
    the plates alone, both sides together). Lying Leg Curl was added on 2026-10-05, after he found he
    had logged it per side all along. Machine Leg Curl is a pin stack and stays `other`;
  - fixed EZ bars;
  - dumbbells 5-120 in 5s.

  His plates are 2.5/5/10/25/35/45 pairs, with no 1.25s. `plateCalc(total, bar)`, `gearLine()` and
  `plateChange()` ("pull the 10 and the 2.5, add a 5 each side") read it.
- **A prescription is never rounded to the gear.** A weight his plates cannot make (162.5 on a bar)
  is named with both neighbours ("nearest 160 or 165") and left for him to pick. Rounding it down
  would trap a lift whose increment the plates cannot load: the engine would ask for the same jump
  every session.
- **The per-set call.** `intraAdvice()` keeps every weight rule and adds an `aim` (reps) and a
  `why` with the numbers ("Set 1: 160 × 5, effort 72. Hold 160, aim for 6.").
  - The aim is the same reps, one more, the top, one past the top after two easy sets, or the floor.
    A test loops over a thousand generated set sequences: never heavier than the plan or his own
    last set, and the aim stays in the range.
  - The effort number is quoted only when `s.ef` exists (a preset stores its anchor).
- **Reps are pre-filled with the aim** (his choice). This replaces Stage 0's "the next set starts
  clean". The Log button reads "Log 160 × 6", and `liveLogLabel()` patches it as he types or steps,
  with no repaint. −/+ steppers step 5 on a plate-loaded lift and the lift's increment otherwise.
  A typed value still beats the pre-fill through `liveKeepInputs()`. At 360px and under, weight and
  reps take a row each.
- **PR watch** (`livePrWatch()`): the fewest reps at the called weight that beat `bestE1RM()`,
  within one of the top of the range.
- **Finish time** (`liveFinishEstimate()`): sets left times his median gap between sets on this day
  type (set `ts`; gaps over 15 minutes are breaks and are dropped). It needs `DENSITY_MIN` timed
  sessions, and otherwise uses rest + 40 s a set. It is worked out once per repaint, because the 1 s
  tick only moves it along the clock.
- **Rest** adds 20 s on a recover day and 15 s on a low check-in. The rest card previews the next
  set with the plate swap (`restPreviewText()`).
- **Screen on** is `navigator.wakeLock`, a per-device `uiPref('live.wake')`, off by default.
  - `liveWakeApply()` lets only one request run at a time. The switch and the repaint it triggers
    both used to take a lock, and one leaked.
  - The idle branch of `renderLive()` releases the lock, or it stayed held after End.
- **Quick adjustments** (`live.quick` → `logRec.quick`, read by `sessionMods().quick`):
  - **Short on time** takes a set off lifts not started (never below 2), and one tap undoes it. It
    is not `live.trimmed`, which means the call trimmed and is what Readiness compares.
  - **Equipment taken** is the swap sheet.
  - **Something feels off** opens the pain entry. Once a flag is saved, it offers **Switch the rest
    to recover** (`liveRecoverRest()`), which rebuilds only lifts with no logged set, the way
    `liveCallToggle()` does. Compounds that step down record `call-recover`.

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
- **A string inside an `onclick="f('...')"` goes through `jsq()`, never `esc(x).replace(...)`.** `esc()` turns ' into `&#39;`,
  which the HTML parser turns straight back into ' before the JS runs, so six handlers broke on any name with an
  apostrophe ("Farmer's Walk") until 2026-10-10. Better still, pass it in a `data-` attribute.
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

---

## V5

### V5 stage 1: Standards (2026-11-12, `v5b`)

**The Standards are computed when read, on the device, free, and ONE result.** `stdState(endKey)` returns one row per pillar
(`{pillar, lvl, since, why, consequence, clearsWhen}`), and the card on Today, the top-bar mark, the bell, every agent's
context line, the strict voice line and the brief's lead all read that one function. Nothing is stored. The numbers below
come from a day-by-day replay over his live state (the sync gist, read without a token, 2026-08-17 to 2026-11-12, 88 days):
one jsdom, the clock moved to 9 PM of each day, the state cut to that day.

**A level is carried, not windowed.** The first draft counted inside a sliding window, so a red could clear by ageing out.
His plan says only the exit condition clears a red. `stdWalk()` walks forward 42 days and applies exit, then red, then
amber, else HOLD. The test that proves it is intake: seven days under target, then he stops logging. It stays red and says
the level holds; without the hold it would read "no data", and a red could be escaped by not logging.

**Bulk pace is expressed through `bulkRate(2, sunday)` and `bulkBand()`, with no new band.** `BULK_LO` (0.5) already equals
his clear line. Completed weeks only (Monday to Sunday, `weekKeyOf()`), and a week is judged only when it AND the week before
each have `STD_BW_MIN_WEIGHS` (3) weigh-ins, because a week-over-week rate against one odd morning is noise. Red is a second
losing week before the spell has cleared, back to back or not (`STD_BW_RED_IN_A_ROW` false). The replay is why: his weeks of
Oct 12 (-1.4 lb), Oct 19 (+0.6), Oct 26 (-0.3) and Nov 2 (+1.0) leave the weekly average where it was a month earlier
(161.8 to 161.7). Back-to-back-only reads that as amber for 25 days and never red. As built it is amber on Oct 19 and red on
Nov 2, with one clearing week of two in. Known limit: `bulkBand()` calls any rate under 0 "losing", and -0.3 between two
7-day averages is inside scale noise. The 1.5 lb/week goal (`STD_BULK_GOAL`) is only ever a consequence line, never a
level. The consequence is arithmetic on the one rate, (1.5 - rate) x 4 weeks, and the bodyweight fan
(`anFanAt(bwProjectFor())`) adds where his longer trend puts the scale that day. The fan alone would have contradicted the
rate named in the same sentence.

**A day before the cycle's anchor cannot be a miss** (`svJudgeable()`). The first replay had Showing up red for 57 of 88
days. His cycle's anchor moved on Oct 15, and `cyclePosition()` wraps the pattern backwards, so every empty day before it
was judged against a rotation he never had. `svSheet()` had the same blind spot and now asks the same function. A plan's own
rotation is dated, so it still counts. **A day trained on a rest day within two days was made up** (`dayMadeUp()`): on
Oct 17 he skipped D3 and trained it on Oct 18, a rest day, and a week of amber for a session he did is wrong. Same day key,
and only on a day the plan had as rest, so a session that was itself scheduled can never cover for another. With both, the
replay has no unexplained miss since the anchor: 88 days ok. `dayExcuse()` is the one answer for the Standards, the
supervisor's sheet and the streak, so the streak no longer breaks on a day with a reason or a made-up day (his read 18, now 20).

**A reason is his tap and an immutable row** (`S.dayReasons`, key `y|`; the plan's `r|` was already readiness). The newest
row for a pillar and a day wins and an empty `why` is his undo. For Showing up the date is the missed day and the day was
not a miss. On any other pillar it is a note beside the row and in the agents' line: it never changes a level, which is what
"he can add a reason but cannot dismiss a red" means.

**Lifts reads the watch's main rows** (`pwMainRows()`, `predLifts()`: the list the plateau chips already lead with). On
Nov 12 the six are Bench, Incline Dumbbell Press, Back Squat, Plate Loaded Overhead Press, JM Press and Lat Pulldown. Dips
reads falling and red on the watch but is not one of the six, so it does not count; JM Press does. **Plan in motion stops the
escalation, not the red** (`stdMotion()`): an approved request on that lift (or an approved deload) until its read date, 28
days (14 for a deload), or the running experiment on it. JM Press has the reset he approved on Nov 8, so Lifts opens red with
"Plan in motion ... read again Dec 6", and with no mark, no strict line and a bell item he can dismiss. A program note's
lifts are neutral rows on the watch, and the Standards read the row as the watch shows it. The row's `since` is the session
the level began at (the watch re-read before each of its newest clean sessions, at most 6, kept per lift). That is a
session date, and the watch can also turn on a date rule alone (a deload ending 7 days ago makes a read firm), which is why
the brief does not ask `since`.

**The brief records what was red when it was written** (`brief.std`, `brief.stdLed`, taken before the await and written
after it, like `hadWhoop`). "Turned red since the last brief" is red now and not in the last brief's list; a rewrite the same
morning leads with what that morning's led with; a brief from before this build has no list, and then the day the level
began decides (gate on the field being present). `agState()` drops a brief whose stamp is not on its day, which the first
test fixture ran into.

**Intake and Recovery ship his plan's proposed thresholds, and the replay says Intake needs his eye.** Under target (any
amount: `nutTierCal()` "slight" or "way") on 3 of 7 logged days is amber and 5 is red. Against his 3,900 then 4,200 target
that was red on 76 of 88 days, amber on 8 and ok on 4, while the scale was mostly in the band. `STD_INTAKE_UNDER` is the one
place to change which tiers count. Recovery: 15 or more points under his usual (`PC_REC_UNDER`, the number the plateau
causes already use) on 3 days of 7 is amber, 5 is red, two days in a row back clears, and under days are counted only since
the last two good days in a row, so a slump he has come back from is not counted again. Amber for 5 days in the replay
(early September and Nov 10 to 11), never red. Today's reading counts only once it is final (`whoopProvisional()`).

**No data is never red, and never a clean bill.** A pillar that cannot be judged (thin weigh-ins, under 4 logged days, no
WHOOP, no main lift with history) or that throws reads `nodata`.

**Today reads the Standards once a repaint.** `stdState()` costs about 16 ms in node on his data (12 of it the watch).
`renderHome()` reads it once for the card and the mark, and `renderNotif()` hands its one read down the repaint through
`_stdPass`, cleared in `finally`. It is not a cache: nothing outlives the synchronous repaint.

**On a phone the countdown gives way to the mark.** At 393px the Winter Arc countdown was squeezed to a sliver beside the
mark, so under 480px it is hidden while the mark shows (it is still on Today). Checked in a real browser at 393 and 320:
the card, the top bar and the V5 switches card (the first registered switch) with no overflow; reason buttons are 38px tall.
Turning the switch off in Settings left the mark up until the next repaint, so `ovToggle()` now repaints the bell.

Not built in this stage: the plan's "the Hub focuses on that pillar" (the Hub is reorganised in stage 8).

### V5 stage 2: Holds and the trip plan (2026-11-12, `v5c`)

**A hold block is read-only context.** One block type for trips, sickness and exams:
`{id, from, to, kind:'trip'|'sick'|'exams', gym:'none'|'hotel'|'home', note, at, t}` in `S.holds`, a `SYNC_HISTORY`
collection (key `h|`). Rows are immutable; removing a block writes `{id, cancel:<block id>, from, at, t}`, the way
`liftNotes` and `dayReasons` take corrections, so a pull can neither lose a block nor bring a removed one back (the suite
reverses the rows to prove the order does not matter). `holdBlocks()` is every valid row no cancel row names, and
`holdRowOk()` is asked of stored rows too: a row from another build that is too long, has an unreal date (Nov 31) or an
unknown kind is ignored, never repaired. V4 removed date overrides on purpose, so `scheduledDayFor()` is untouched and
the suite checks the block's days resolve exactly as before it existed.

Limits, each a named constant: the longest block is 21 days for a trip, 14 for exams, 10 for sick (`HOLD_MAX_DAYS`); a
block may start up to 14 days back (`HOLD_BACK_DAYS`: he was sick from Monday and says so on Thursday) and a year ahead;
two blocks may not overlap (the form says which one is in the way). A block that is not a trip never carries a gym.

**A day in a block is not a miss.** `dayExcuse()` asks `holdOn(d)` first, before the Standards switch, so `svSheet()`,
the streak and Showing up agree and the Standards switch being off does not turn a trip into five misses. CHARLIE's
sheet lists the days as "not counted as missed (away)". A session trained inside a block still counts as trained.

**A hold freezes a Standard, it never clears one.** Stage 1 left `stdHeldBy(pillar, day)` returning null; it now returns
`{until, why, id}` for the block's days plus `HOLD_AFTER_DAYS` (7: weigh-ins take a week to settle after travel). A trip
holds Showing up and Bulk pace. Sick and exams hold Intake as well. Lifts and Recovery are never held. `stdWalk()` skips
a held day (it neither raises nor clears), `stdBulk()` skips a week with a held day in it, and `stdState()` shows the
row as Held with "Until Fri, Jan 8 (away Dec 28 to Jan 1)". The seven days after are held, but they are not excused: a
scheduled day skipped on Jan 4 is recorded as a miss and reads amber on Jan 9 when the hold lifts.

**The agents' line.** `holdContextLine()` is one line in the nightly CALENDAR and in chat's TODAY: a block in force
("day 2 of 5"), one starting within `HOLD_SOON_DAYS` (21), or one that ended inside its hold. Further off it is empty,
and the suite checks the nightly and chat prompts are byte-identical to before the block was entered. His note is quoted
with `JSON.stringify` and labelled as his words, not instructions. Capped at `HOLD_CTX_MAX`.

**Today.** On a held day a banner under the Standards card reads "Away, day 2 of 5" (or Sick, Exams), says what is held
and until when, and carries the existing HOME toggle when the block's gym is hotel or home. A "Time away" card after the
Sunday check-in lists every block that is coming, running or still holding a Standard, each with Remove (it asks first),
and the form to add one. The form's draft and its open state are module-scoped (`holdDraft`); a tap on a chip reads the
typed dates before it repaints. Checked in a real browser at 393 and 320 with a seeded state: no overflow in the banner,
the card or the form (the two date fields stack at 320).

**The trip plan.** "Plan my trip" is one call per block, modelled on `wpRun()`: route `awayplan` (its own row on the
usage card, "Trip plan"), no tools, medium effort, 4000 tokens, started only by his tap, asked through
`spendManualOk()`, what he asked saved in `S.awayPlans[blockId]` before the call, the plan re-resolved after the await
(the suite swaps `S` mid-reply), the in-flight flag released in `finally`. A reply that came back closes the plan even
when it was unreadable, because it was billed; only a request that never got a reply may be tried again. The reply is a
lead-in note, a note per away day and a re-entry note; `awayValidateReply()` keeps only notes dated inside the block,
one a day. Any change is an ordinary request through `wpFilterProposals()` (deload or setCount, at most one) and
`agIngest()` → `agValidateFix()`. Removing a block removes its plan.

It sits behind its own paid switch, `awayPlan`, off, because the pipeline's rule is that a new call is a paid switch
even when only a tap can start it. With it off the card says where to turn it on, and neither the tap nor `awayRun()`
can send anything. Estimated cost: about 3 cents a plan (the spec's figure; no real call has been made).

**Nothing states what a break costs.** The plan's default advice (no taper, the week before normal, first session back at
normal weights and the low end of the set range, no catch-up sets, `dayCall()` judges it) is given to the model as "the
app's defaults, NOT research findings", and the prompt forbids any amount, percentage or timeline for losing or
regaining strength or muscle, and any claim that a taper or deload before a trip helps. A prompt is not enforcement, so
`awayClean()` drops any line matching `AWAY_CLAIM_RE` (a number with a percent sign, "detrain", "atrophy", or lose/loss
near strength/muscle/size/gains/progress in either order) and the app's own default line stands in
(`AWAY_LEAD_DEFAULT`, `AWAY_BACK_DEFAULT`). `awayEvidence()` is the hook stage 3 fills with the cited "break" entries.

**Tests.** 88 assertions with `todayKey()` stubbed to named days: Nov 12 (entering Dec 28 to Jan 1), Dec 14, Dec 27,
Dec 28, Jan 1, Jan 2, Jan 6, Jan 9, Jan 11, a block across Nov 1 2026 (the 25-hour day) and one across Mar 14 2027 (the
23-hour day). 38 mutants, each red. Two traps met on the way: a request created under a stubbed future `todayKey()`
gets its expiry from the real clock, so the test does not assert its status; and a fixture trip entered 15 days back was
refused by the very limit under test.

### V5 stage 3: the Evidence Library, in code (2026-11-12, `v5d`)

**`EVIDENCE` is a checked constant.** The research was done on 2026-11-11 (`Claude outputs/evidence_draft.json`, 60
entries; `evidence_sources.md` says how each source was opened and read). This stage puts it in the file as
`EVIDENCE_RAW`, one row a line, beside `LIFT_FACTS`: no fetch, no tool, no backend, about 52 KB. `evBuild()` keeps a row
only if `evEntryOk()` passes it and its id has not been seen: an id like `E12`; tags from the fixed nineteen
(`EVD_TAGS`); a `finding` of 40 to 450 characters; a `strength` of strong, moderate or limited; a `means` that opens
with "For a lifter like him this suggests" (`EVD_MEANS_LEAD`); a source with a title, an https link on one of three
known hosts (`EVD_HOSTS`) and a whole-number year from 1950 to 2026; a checked date; `read` of full or abstract; and no
angle bracket anywhere. A row that fails is left out, never repaired. All 60 drafted rows pass: strong 4, moderate 25,
limited 31; 28 were read as abstract only, and the card says "abstract only" on those.

**`hold:true`: free, but off until he turns it on.** The entries are training and nutrition guidance, and the plan says
he spot-checks ten before it ships. A paid switch already defaults off, but this part is free, and a free switch
defaulted on. So an `OV` row may now carry `hold:true`, and `ovDefault()` is `!paid && !hold`. Everything else follows
from that one line: `ovSet()` stays sparse (on is stored, off is the default and stores nothing), no paid date is
recorded, and the week-apart rule does not apply. Turning a held part on asks first (`ovToggle()`), turning it off never
asks, and the row in Settings reads "free · waiting on you" until it is on. `OV.evidence` is the first such row. Under
the switches a card (`evCheckHTML()`) says what the library is and offers "Show the ten to check first"
(`EVD_CHECK_FIRST`: E45, E47, E48 for the trip; E22, E23 for the bulk rate; E27 protein; E34 sleep; E04 volume; E12
effort; E19 deloads), each with its finding, its labelled inference and an "Open the source" link. Nothing shows any
entry until he opens that list or turns the switch on.

**Off means off.** With `evidence` off `evOn()` is false and: `evCiteClean()` keeps nothing, so a request or Desk post
that arrived with a cite is stored without one; `evCiteHTML()` draws nothing, so every card is exactly as it was;
`agEvidenceBlock()` and `awayEvidence()` are empty.

**Evidence in the nightly prompts is a second, paid switch** (`evidencePrompts`, off), because it adds input tokens to
four paid calls every night. It needs the library on as well (`evPromptsOn()`). The suite takes all four nightly
prompts and all four chat prompts with both off, the library alone on, and the prompts switch alone on, and checks they
are byte-identical; with both on each nightly prompt gains exactly one `PRINCIPLES (cited ...)` block, placed before
DELTA's tail (`pdContextLine()` stays last, which the cost guard relies on), and chat is untouched. Estimated cost: the
block is at most 1,500 characters plus about 480 of framing, roughly 500 tokens, times four agents a night, about 60,000
input tokens a month: 12 cents at one request per agent, and up to about 40 cents when the agents use their tool
rounds, since each round sends the system prompt again. No real call has been made with it on.

**`evidenceFor(tags, max, day)` picks by role and situation.** `evTagsFor(id)` puts what is going on first (a hold
block near: `break`; a main lift amber or red on the watch, for DELTA and ZULU: `plateau`, `variation`; a deload in
force: `deload`) and then the agent's own shelves (`EVD_ROLE`). `evidenceFor()` takes one entry per tag in turn, so the
first tags are served first and no tag fills the cap alone; inside a tag the strongest evidence leads, and the starting
point moves on by one each day so a prompt sees the whole shelf over time instead of the same three lines every night.
It is pure, with the day an argument, and stops at `EVD_MAX_CHARS` (1,500, the same figure as `EV_MAX_CHARS`). The
constants are `EVD_*` because `EV_*` already belongs to the events.

**A cite is a list of ids and nothing else.** Requests and Desk posts may carry `cite:['E12']`, and so may a trip-plan
reply. `evCiteClean()` keeps exact ids that exist in the library, each once, at most `EVD_CITE_MAX` (3). A string
instead of an array, `e12`, ` E13`, `constructor`: discarded, not tidied. The field is absent when nothing survives, so
a request without a cite is the record it always was. The card draws everything from the constant (`evCiteHTML()`): a
chip per id ("E19 · limited ↗") that opens the source in a new tab with `rel="noopener noreferrer"`, and "What it says",
which opens the finding and then "What it means for you (the app's inference, not the paper's claim)". The open state is
module-scoped (`evOpen`). With the library on, a request or post with no cite reads "Source: coach's judgement"; it is
not rejected. A stored id that has since left the library is treated as no cite. A cite never helps a fix through
`agValidateFix()`: the suite queues a bad fix with a good cite and it is still refused.

**The trip plan** gets the `break` shelf (`awayEvidence()`) whenever the library is on, whatever the prompts switch
says, since that call is already his own paid tap. The stage 2 ban is unchanged: the plan may cite a line, but
`awayClean()` still drops any sentence that restates what a break costs.

**One thing the browser found.** The first `evCiteToggle()` repainted Today, the Hub and the Desk. Painting the Desk
while it is hidden marks its posts as read, so it now repaints only what is showing (`rerenderActive(true)`). The chip
and the "What it says" button were 27 and 21 px tall; they are now 37 and 33.

**Tests.** 72 assertions and 55 mutants, each red. Checked in a real browser at 393 and 320: the request card with
three chips, closed and open, and the V5 switches card with the ten open, with no overflow; the tap on "What it says"
opened the three findings.

Not built: evidence in chat prompts, a browsable view of all 60 entries, and the technique cards (stage 10). The
agents' prompts do not mention `cite` at all unless both switches are on.

### V5 stage 4: analysts, squads and the Hub in four lanes (2026-11-12, `v5e`)

**An analyst is a pure function, not an agent.** The spec's twelve-agent roster is four coaches that make paid calls
and eight analysts that make none. `ANALYSTS` holds the eight (KILO under ZULU; HOTEL and GOLF under CHARLIE; ALPHA,
FOXTROT and INDIA under DELTA; BRAVO and JULIET under ECHO). The callsigns are the spec's placeholders and nothing keys
on `name`. An analyst has no prompt, no chat and no fix types. Nothing ever handed the validator an analyst's id, but
`agFixAllowedFor()` answered "allowed" for any id it did not know (that is how ZULU may use every shape), so it now
refuses an id that is in `ANALYSTS`: the guarantee, not the hint.

**The readings are worked out when read, and ONE result** (`anlPass()`, `anlState()`). Nothing is stored and nothing
is posted to `S.agents.desk`: a stored verdict would lose to an older snapshot, exactly as a stored Standard would.

**A pillar analyst takes its level from `stdState()` and nowhere else.** The first sketch gave each analyst its own
thresholds. That would have put two verdicts on the same data on two screens, and the first time they disagreed
neither could be trusted. So BRAVO is the Bulk pace row, HOTEL Showing up, ALPHA Lifts, JULIET Intake and GOLF
Recovery: same level, the Standard's own sentence, and its exit condition as "what would change it". What a tile adds
is the numbers behind the level (`anlNums()`), worked out only for an open tile or, behind a paid switch, a prompt.

**A broken analyst reads `nodata`.** One that throws, or answers with a level that does not exist, is neither a flag
nor a clean bill. `anlLeadStatus()` follows the same rule one level up: a coach reads clear only when at least one of
its analysts could actually read; all-nodata is "No reading yet".

**A status is a colour, an icon and a short reason. It never names its level.** His pick on the mockups, 2026-11-12,
answered "Everywhere": "just leave it as the color and accompanied reason". So a tile says "✖ Losing weight" or
"▲ 1 day missed", a coach says "✖ BRAVO: Not cleared yet", and the suite runs every status word through a check for
red, amber, green, ok, watch, "off standard" and "slipping". (The top bar's "4 RED" mark and the Standards card are
stage 1's and are left for the reskin.)

**FOXTROT lists the moves and judges nothing, because the replay said a flag would be noise.** It was written to flag a
muscle 35% under or 40% over its usual sets. Replayed over his real 88 days to 2026-11-12, that read amber on 67 days
of 88. His schedule is an 8-day rotation (D1 D2 D3 REST D4 D5 D6 REST), so a 7-day window holds a different mix of
days every time; comparing one full rotation (`anlFoxDays()`) is plainly right and is kept, but it still read amber on
46 days, and on 28 at 50% and 60%. The swings are real (floating rest days, the strength block in October, the deload
week), and they are not problems. So `FOX_FLAGS` is false: FOXTROT has no level ("Listed, not judged"), no strip, and
never reaches a prompt; it names the largest moves and lists every muscle against its usual. The flagging path is
still there and every rule of it is tested with the constant on (today is not counted, a deload week and held days
are neither read nor part of his usual, a muscle whose usual is under 6 sets is ignored, amber at most), so turning
it on is one constant and a replay.

**INDIA and KILO cannot flag.** INDIA is the Selector's analyst and the Selector is stage 5, so `anlIndia()` lists the
hard-set share of each main lift (`liftHardShare()`, the one grind-share measure) and has no level. KILO reports what
the library would hand each coach today; with the library off it reads "Library off", not clear.

**The 14-day strips are as-of and memoised.** `anlStrips()` re-reads `stdState(d)` for each of the 13 days before today
and keeps the answer under `anlStripKey()` (the day, `changedAt`, and how many logs, weigh-ins, intake rows, WHOOP
rows, reasons, holds and requests there are, plus the switches). Today's cell is the live reading and is never kept.
Measured on his real state in jsdom: a rebuild takes about 230 ms (thirteen as-of plateau watches are most of it), a
repaint that reuses it about 60 ms against about 40 for the old map. In Chrome on a seeded state of 59 sessions the
rebuild was 44 ms and a warm repaint 11 ms. The rebuild happens once per change to his data, not on the 30-second
repaint.

**Both additions to a prompt are paid switches, off.** `anlSquadLine()` hands a coach its own squad's flagged readings
with their numbers, capped at `ANL_PROMPT_MAX` (600) characters, in the nightly prompt only, straight after the
Standards block. On his state today that is 725 characters for DELTA and 737 for ECHO with the heading. Lift dossiers
are the diagnosis pattern widened from flagged lifts to the main lifts: `dosTargets()` picks at most `DOS_MAX` (2) main
lifts a night, never one being diagnosed that night and never one written about in the last `DOS_QUIET_DAYS` (7);
DELTA is handed the app's numbers for them and returns a "dossiers" key; `agValidateDossiers()` keeps only lifts that
were asked about before the await, one note each, clipped to 220 characters; `S.agents.dossiers` is merged per lift in
`applyPulled()`. The diagnosis context and spec stay last. With either switch off, or with nothing to say, every
nightly prompt, chat prompt and reply spec is byte-identical, and the suite checks all twelve.

**The Hub's Agents view is four lanes.** `hubSquadsHTML()` draws one light per Standard, then ZULU, CHARLIE, DELTA and
ECHO as lanes: the coach's card (status reason, what is waiting on him, a chevron) and, when open, its analysts as
tiles (callsign, job, reason, the reading, a 14-day strip with its count in words, a sparkline through `ckPath()`). A
lane he has not touched is open when it is the selected coach or when something in it is flagged. A tap on a tile
opens its numbers under it, with "what would change it", the strip in words, and source chips when the library is on.
Every id and handler the old layout had is kept (`hubAgent`, `agChatBox`, `agChatIn`, `.hub-p-<id> .hub-s`), the
selected coach's report and chat sit under the lanes as before, and with the switch off, or if the lanes throw, the
old map is drawn.

**Two things only a real browser found.** The lanes were `<section>` elements, and the app hides every section that is
not the active tab: three of four lanes had `display:none` and jsdom, which has no layout, passed every test. They are
`<div>`s now. And the first cut put an open tile's numbers after the last tile of the lane; on a 320 px screen, where
tiles stack, that was two tiles away from the one tapped. It now follows its tile, with `grid-auto-flow:dense` so the
neighbour still sits beside it at 393 px. A tap on a tile repaints the Hub, which regenerates the chat box, so
`sqRepaint()` carries a half-typed message across.

**Measured.** The suite is 4582 assertions (96 new), 0 failed; 60 mutants, each red; `scripts/clock_run.js` green.
The lanes, an open tile and the lights were checked in Chrome at 393 px and 320 px with a seeded state: no element
past the edge, tiles 167 px wide in two columns at 393 and 268 px in one at 320, lane headers 62 px tall. Read-only
replay on his state of 2026-11-12: BRAVO "Not cleared yet", JULIET "Under on 4 of 7 days", ALPHA "Barbell Back Squat
slowing", HOTEL "No misses", GOLF "Too few WHOOP readings", so ECHO and ZULU read BRAVO's reason and DELTA ALPHA's.

Not built: the List and Week views, the Wire, tension markers, a lit line from an analyst to its lead, the Plan of
Record in a ZULU bar (stages 6 to 8), and analyst cards on the Desk (stage 6).

### V5 stage 5: the Selector and swap trials (2026-11-12, `v5f`)

**The fit score is worked out when read, on the device, free, and ONE result.** `selState()` returns a row per lift in
the split in force: `{lift, verdict, word, fit, rows, caps, cands}`. Fit is 100 less a penalty for each thing the app
can see against the lift, and each penalty is a row with its text and its points (`SEL_W`): a stall on the plateau
watch (30, read from `plateauWatch()`'s own row, so the Selector and the watch cannot disagree about what a stall is),
noise (20, the spread of the clean e1RM around the lift's own line over its last 8 clean sessions, `selNoise()`), hard
sets (15, `liftHardShare()`), pain flags (25), sets left out (10, `selSkips()`), a same-day duplicate (10, `selDup()`),
and 10 more when the lift has stalled while the other lifts for its muscles are moving. Nothing is stored and nothing
is posted to the Desk. INDIA (`anlIndia()`) reads it: amber when a lift is marked, never red, "too few sessions" when
nothing could be scored. With the switch off INDIA is exactly stage 4's reading (`anlIndiaOff()`).

**The cut-offs came from a replay over his real sessions.** Day by day over the 88 days to 2026-11-12 (the state cut to
each day, the clock moved to it; 2,269 lift-days scored, including nine lifts he has since dropped):
- Noise first. At the first guess (no penalty under 2.5%, all of it at 6%) seven of his 23 scored lifts took the whole
  noise penalty: Hip Thrust Machine 12.1%, Incline Prone Reverse Fly 8.5%, Leg Press 8.0%, Incline Dumbbell Curl 7.9%,
  Calve Raises 7.6%, Chest Fly Machine 7.5%, Machine Leg Extension 7.3%. Those are mostly high-rep and Form Focus lifts,
  where the e1RM estimate itself swings with a rep or two. His median is 3.7%. The line moved to 5% and 10%
  (`SEL_NOISE_LO`, `SEL_NOISE_HI`), so only a lift well outside his usual pays, and none pays in full for being a
  high-rep lift.
- Then the verdicts. Median fit 92, a quarter under 82, 5% under 67: `SEL_KEEP` 70 puts about the bottom 5% of
  lift-days at watch. For a trial: under 45 marked nothing at all in 88 days; under 50 marked one lift, Leg Press for
  16 days from Sep 24, the stretch that ended in a reset; under 55 also marked the Plate Loaded Overhead Press for 8 days
  in September, which recovered by itself; under 60 added the Rear Delt Machine (the one of the three he later dropped)
  and put a mark on 42 days of 88. `SEL_TRIAL` is 50: it fires on the one episode where something did have to be tried,
  and is quiet on 80 days of 88. FOXTROT's lesson again: a flag that is lit half the time is noise.
- On his state today: 27 lifts scored, 26 keep, 1 watch (Hanging Leg Raise, 64: reps not climbing, left out of 3 of its
  last 6 sessions), none marked. Cable Row, Machine Lateral Raises and Single Arm Tricep Pushdown have too few clean
  sessions to score.

**Old build against new, with no trial running: nothing changed.** Every one of his 110 sessions was replayed with the
clock at that day and only the logs before it: 587 prescriptions (532 with a target weight) through
`buildOneLiveExercise()` on `git show HEAD` and on the working tree, plus the day's lift list, slot sets and per-lift
flags. Zero differences. With no trial `activeSplitObj()` returns the very object it always returned.
And with one running, on his state of 2026-11-12, in memory: a trial was started on each of the 24 lifts that can take
one, in turn, with its first candidate. Each time only that lift's slot changed, every other lift on every day was
prescribed exactly as before, `S.split` was byte-identical, the agents' SPLIT text named the trial, and ending it put
every list and prescription back.

**A swap trial is a third split in force.** The first two are the permanent split and a strength block's own. The spec
put the overlay "where `buildOneLiveExerciseBase()` is already wrapped", but a trial has to change WHO is on the day,
not what one lift is prescribed, and everything that asks who is on the day already asks `activeSplitObj()`: LIVE
(`liveSessionNames()`), Today's key lifts, the plan's shape, per-lift flags (`exSlotsFor()`), the watch's lift list,
the experiment checks. So the overlay is there: while `swapTrialOn()`, `activeSplitObj()` returns `swtView()`, a view
built on each read in which the stand-in holds the old lift's slot on every day that had it. An untouched day is the
same object as in `S.split`; a day that already holds the stand-in is left alone. The stand-in's slot keeps the slot's
set count and nothing else: MAXED, strength mode, Form Focus and a custom increment belong to the lift that left, which
still answers for them through `exSlotsFor()`'s fall-back to the permanent split. **`S.split` is never edited by a
trial**, so ending one is the view no longer being built, and turning the Selector off mid-trial puts the permanent
split back at once.

**The view is a copy, so a writer must not ask for it.** Three places compared `activeSplitObj()` with `S.split` to
mean "a strength block is running", and one wrote a set count through it (`set_sets` on a block day). During a trial
those would have told chat a strength block was running and written a set count into a copy that is thrown away. They
ask `baseSplitObj()` now, which is what `activeSplitObj()` was before this stage.

**The overlay's truth is the running experiment, not `S.swapTrials`.** The pipeline note called the trial "an overlay
(`S.swapTrials`)". Two records of "is a trial running" could disagree after a pull, and every rule a trial must keep
(one at a time, the cool-down, no start in a deload, 28 days at most, Stop) already lives on `S.experiments.active`.
So the running trial is the experiment record and nothing else, and `S.swapTrials` is what must survive a pull: one
immutable row when a trial ends (`swtRecord()`, in the same `save()`), and one for his answer. The verdict is not on
the row. `swtTrials()` rebuilds it from the logs through `expEvaluate()`, bounded by the row's start and end.

**Two different lifts cannot be compared in pounds; their progress can.** A trial's baseline is the old lift over its
own line, as every experiment scores a baseline. A trial session is how far the stand-in has moved from its first
clean trial session, over how far the old lift's line would have moved in the same days (`swtScore()`). That first
session is the starting point: it counts toward the four, and it has no score. So a four-session trial scores three,
which is the fewest `expEvaluate()` will call anything but "unclear"; that is why a trial runs 4 to 6 sessions
(`SWT_MIN`, `SWT_MAX`) and not the spec's 3 to 6.

**A trial leans toward the new lift, and the card says so.** A lift he has not trained lately climbs fast while he
finds its working weight, so "the stand-in moved more than the old line" is the likely result of most trials. The
running card, the finished card and the result all carry `SWT_LEAN`: it shows the new lift is moving; it cannot show
it builds more muscle. Nothing says "proven".

**When a trial ends the old lift is back, and a card asks.** Keep, or go back, on Today and in the Hub, for
`SWT_DECIDE_DAYS` (14). Until he answers the permanent split is in force, which is what going back means, so a card he
never answers costs nothing. Keep replaces the lift on every day the trial covered, through `agValidateFixShape()` (names
resolved, never one lift twice on a day); it is his choice even when the result was unclear. His answer is a row, given
once.

**A trial starts only by his tap, and `swtCheck()` is the one check.** From the Selector card (`swtStartMine()`) on any
lift that is not a clean keep, or by approving DELTA's request. Both need the Selector on, a lift in the permanent split,
no strength block, not bench or squat, not a bodyweight lift, and a stand-in from `selCandidates()`:
`swapCandidates()`'s own ranking, nothing already programmed, nothing under tier B, no name carrying a coaching note.
From an agent it also needs the paid switch, and a lift INDIA marks today. The app has no list of what his gym owns, so
a candidate he has never logged says "check your gym has it" on its row.

**A permanent swap from an agent needs grounds.** `agConflict()` refuses a `swapEx` unless `agSwapNeeds()` finds a
finished trial that favoured that lift and that he did not turn down (within `SWT_GROUND_DAYS`), a pain flag at sore or
worse on the old lift, or the old lift left out or swapped out in 3 of its last 4 sessions on its day. That last one is
the app's stand-in for "unavailable equipment", which it cannot see directly. A trial's own sessions are not "left
out" (`swtDuring()`), or going back from a trial would itself become grounds. The rule is off with the Selector switch,
so the validator is then exactly as it was. Four older tests that fed a bare `swapEx` to `agValidateFix()` to test
name resolution and the same-day clash now call `agValidateFixShape()`, which is where those rules live.

**Found in the browser on his real data: a sore flag raised a lift's fit.** While a pain flag is fresh the plateau
watch stops judging the lift's progress (state "pain"), so its stall row reads nothing. Two sore flags on his JM Press
(in a preview copy) took its fit from 74 to 79 and the row read "Keep". A lift flagged sore or worse is now never a
clean keep. And the row offered "Try a replacement" on Hanging Leg Raise, a bodyweight lift `swtCheck()` would refuse:
the row now says why instead of offering.

**DELTA's swap key is a paid switch, off.** With it on, and only on a night a trial could start and INDIA marks a lift
that has candidates, DELTA's context gains a SELECTOR block (the fit, the penalty rows, the candidates; at most
`SEL_PROMPT_MAX` characters for at most two lifts) and its reply spec gains the `swapTrial` line. No other agent gets
either, chat gets neither, and the chat tool's template enum never lists the trial. On his state tonight the block is
empty, because nothing is marked.

**Measured.** The suite is 4715 assertions (133 new), 0 failed; 97 mutants, each red; `scripts/clock_run.js` green.
On his state in jsdom: `selState()` about 18 ms; a Hub repaint that reuses the strips 60 ms with the Selector off and 78
on (it is read once a repaint, `_selPass`); rebuilding the 14-day strips 213 ms off and 409 on, once per change to his
data. Checked in a real browser at 393 px and 320 px on his real state (a local copy with the sync and API keys
stripped): the Selector card, an open row, the candidate list (49 px rows), a running trial and the finished-trial card
(buttons 161 by 58 at 393, stacked 256 by 44 at 320), no element past the edge.

Not built: nothing new for cites (a trial request carries the ordinary `cite`), no chat tool for trials, and the
technique cards the spec mentions beside a swap are stage 10's.

### V5 stage 6: the Desk, expanded (2026-11-13, `v5g`)

**An analyst's card on the Desk is derived when the Desk is drawn.** The spec said each analyst "posts a code-written
card when its state changes". Posting would have meant writing to `S.agents.desk`, and stage 4's rule is that a reading is
never stored: a stored card would lose to an older snapshot and could disagree with the Hub's tile. So
`deskAnalystCards(anlPass(), anlStrips())` works the cards out each time: an analyst whose reading is flagged, or whose
level changed inside the 14-day strip, gets a card with the day it changed; the rest are named in one line. KILO has no
strip, so it has no "changed". The cards sit in their own part, "From the analysts, worked out by the app", above the
coaches' board, "their read". The classes are `desk-anl` and `desk-an`, not `desk` and `desk-i`: six older tests count
the coaches' items by those names, and they were right to.

**Watches.** His ask was constant plateau monitoring with the app doing the measuring. A watch is
`{series, lift?, op, thr, within}`: seven series the app can measure (`WATCH_SERIES`), below or above, a threshold
inside the series' range, and how many readings in a row. `S.watches` is a history collection (`a|`) of immutable rows:
a watch, a cancel row, and a row that turns a coach's offer down. Whether a watch fired is `watchEval()`, every time it
is read: the first time `within` readings in a row sat on the wrong side, counting only readings dated on or after the
day the watch was made. Without that last rule a watch made today on "bench under 210 for two sessions" would fire at
once on two sessions from September. A reading is a session for e1RM (deload and HOME sessions are left out, as
`e1rmSeries()` does), a completed Monday-to-Sunday week for bodyweight (3 weigh-ins, the Standards' own minimum) and
sessions, a logged day before today for intake, a day of WHOOP history for recovery and sleep. A fired watch is pinned
on the Desk and in the bell for 14 days, then it is done; it is one-shot. An open one that never fires ends after 90
days. At most five are open. One that throws reads "broken" with a mark and a bell item: a watch that silently stopped
would be the worst kind.

**A watch exists only by his tap.** He makes one in a small form on the Desk, or accepts a coach's. A coach's offer is
an ordinary Desk post carrying `watch`, validated at ingest by the same check (its own lane only, the lift resolved,
out of range refused and never clamped) and re-checked by the tap. The offer is derived: a post with a spec that no
row names as accepted (`src`) or turned down (`no`), for 14 days. A watch is not a fix: it changes nothing in his plan
and never reaches `agValidateFix()`.

**The paid switch.** The coaches' side adds words to calls that already run, so it is `watchKey`, paid, off: the watch
part of the Desk spec line (480 to 557 characters per coach on his state), two more chart series (the fatigue index
week by week, and hard sets a week summed over muscles), and one line to the owning coach for three nights after a
watch fires. With it off the suite checks that every nightly prompt, reply spec and chat prompt is byte-identical, with
and without a fired watch and a stored plan, and separately that no spec mentions a watch at all: the first comparison
alone passed a mutant, because both sides of it carried the same mutation.

**The Plan of Record, stored and shown.** `S.planRecord` (`o|`; the spec's `p|` was taken by PR history). A row is one
write of one week's plan: at most three priorities, each `{standard, check, byDate}` with the check from the fixed
`PLAN_CHECKS` (eight, each filed under one pillar) and the day inside the plan's Monday-to-Sunday week. The card words
each check itself (`say`), so no number on it comes from a model; the coach's line is shown beside it as its words.
Stage 7 writes and scores it.

**Interventions were not built**, by his choice on 2026-11-11: a red Standard is free, and the brief leads with it.

**Measured.** 117 new assertions; 98 mutants, each red (a 99th, the pillar check in `planPriOk()`, is implied by the
check's own pillar and cannot be told apart). On his state in jsdom the Desk draws in about 50 ms and leaves `S`
byte-identical; it shows three analyst cards (BRAVO not cleared yet, ALPHA squat slowing, JULIET under on 4 of 7 days),
no watches, no plan, and his ten Desk posts. Checked in a real browser at 393 px and 320 px, on a seeded state with
every part filled and on his real state with the keys stripped: nothing past the edge.

Not built: the Wire, tension markers, a chat tool for watches, and a watch on anything outside the seven series.

### V5 stage 7: accountability (2026-11-13, `v5h`)

**A verdict is worked out when read.** `planVerdict(p, row, asOf)` answers for one priority: met, partly, missed, open,
held or not judged, with what was counted. Nothing is written back: a stored verdict would lose to an older snapshot,
the same reason the prediction record and the Standards are computed. A priority is judged over the plan's Monday to
its own `byDate`. Before that day has passed it is open unless it is already met; a count at half or more of what was
asked (`PLAN_PARTLY`) reads partly once the day has passed.

**What each check reads, and what it refuses to call a miss.**
- Sessions, weigh-ins and check-ins count days, not rows, so two logs on one day are one session. A sleep-only stub is
  not a check-in (`rdComplete()`).
- Intake days are judged against the target in force that day (`calTargetOn()`), through `nutTierCal()` and
  `nutTierPro()` and nothing else. Today's log is not counted while the week is open: at 9 AM it is not finished.
- "Every scheduled day trained" asks `dayExcuse()` and `svJudgeable()`, so a day with a reason, a made-up day, a held
  day and a day before the cycle's anchor are not misses. Today is not a miss until it is over.
- Bodyweight on the week is `bulkRate(2, sunday)`, the expression the Bulk pace Standard uses, so the plan and the
  Standard cannot disagree about a week. It is judged only once the week is over and only with three weigh-ins in the
  week and in the week before; otherwise it is not judged.
- A set at the called weight reads the call each logged set carries (`s.p`, since October). A deload session does not
  count. Sets with no call, a lift on a swap trial, and a lift whose day never came up in the window
  (`planLiftScheduled()`) are not judged. That last one came from the replay: JM Press read "missed, not trained" on
  three September weeks, from a rotation wrapped backwards past the Oct 15 anchor, a schedule he never had. The same
  rule covers his 8-day rotation, where one day falls out of every calendar week.
- A hold on the priority's pillar anywhere in the window reads held. A measure that throws reads not judged.

**The replay.** Over his real state, on each of the ten Mondays to Nov 2: what `planSuggest()` would have suggested
that day, then how the week came out. Thirty priorities: 12 met, 5 partly, 7 missed, 6 not judged. Calories at target
on 5 days was never met (partly 5, missed 5), which is the Intake Standard's own story. Bodyweight up 0.5 lb was met 7
weeks of 9 (missed the weeks of Sep 14, +0.00, and Oct 26, −0.30). The top-set check was met all 4 weeks it was
suggested. The six not judged are "every scheduled day" on the weeks before the Oct 15 anchor. Before the schedule rule
above went in, the same replay read 8 met, 9 missed and 8 not judged. The suggestion's Standards were read as of each
Monday from the state as it is now, so it is a close picture, not an exact one.

**Two ways to set a plan.** The pipeline said the plan is "written in Stage 7" by ZULU, behind a paid switch. With that
switch off there would never be a plan and the free scoring would score nothing. So the app also suggests one
(`planSuggest()`): the flagged Standards first, worst first, then Showing up, Bulk pace and Intake, at most three, each
a check from the fixed set due Sunday. A pillar held today gets none; Recovery gets none (more check-ins do not fix
recovery); gaining fast is answered with weigh-ins, never "gain more"; a lift that is not on the schedule this week is
not suggested. His tap stores it (`planSetMine()`, a `save()`); Withdraw is a cancel row.

**A missed priority does not move a Standard.** The spec said misses "feed the Showing up and Lifts Standards". A level
is carried by its own entry and exit conditions; a second way in would let a plan a model wrote raise a red. So a miss
is shown beside its pillar on the card and told to ZULU, and `PLAN_FEEDS_STANDARDS` is false.

**The Weekly Review rides the letter call.** The letter was already weekly: Sunday night, with a Monday catch-up, keyed
on the Sunday it covers. With `weeklyReview` on, `agWriteLetter()` appends `wrPromptPart()`: reply as
`{"letter", "plan"}`, the fixed menu of checks, the week the plan is for (the Monday after that Sunday), and ZULU's own
record as the app scored it (`planMemoryLine()`, the last four weeks with a plan, at most 900 characters; on a Sunday
night the week ending that day is read as finished). On his state that adds 1,333 characters to a 34,890-character
prompt. The reply's two keys stand alone: the letter is kept whatever the plan is, and `planValidate()` drops any
priority that fails and keeps the rest. Prose with no JSON is still a letter. JSON with no letter, or a reply that
starts like JSON and does not parse, is a failure, not a letter made of braces. `wrIngest()` runs after the letter is
kept and writes into the `S` that exists then; the suite replaces `S` during the call to prove it. With the switch off
the prompt is byte-identical and a reply is returned exactly as it came.

**The Monthly Review.** `monthlyMaybe()`, called from `runnerTick()`'s evening branch after the night's cycle, so only
the server starts it. One call, no tools (`callClaude()`), route `monthly`, which is an automatic route and pauses at
the cap with one line in the feed a day. The prompt is ZULU's nightly context plus its plan record, and the evidence
shelf when the library is on: 34,377 characters on his state, about 9,500 to 11,500 input tokens, and at most 8,000
out. The reply is `{"orders": {coach: [lines]}}`; `ordValidate()` keeps strings only, clipped to 140 characters, five a
coach, and ignores a key that is not one of the four. Any reply that came back closes the month, good or bad, so a
reply that fails the check is not paid for again at the next slot; a call that never got through closes nothing.
`S.agents.orders` is one object, merged newer-wins in `applyPulled()`. The coaches read their own lines as data for 35
days, in the nightly prompt only and only with the switch on. The card on the Desk stays his to read after that.

**The model.** The spec wanted a larger model for the monthly call. That is a cost decision CLAUDE.md reserves for him,
so `MONTHLY_MODEL` is `AI_MODEL` and `aiBody()` honours a model only when it is that one constant. The report gives him
the tokens a run reads and writes.

**Measured.** The suite's stage 7 section, the mutants and the clock run are in the stage report. Checked in a real
browser at 393 px and 320 px on a seeded state: the plan with verdicts, last week's result, Withdraw, the app's
suggestion with its button (183 by 37 at 320), the standing orders card, and Today's card. Nothing past the edge.

Not built: a plan he writes by hand (he sets the app's suggestion or ZULU's), a manual "run the monthly review now"
button, and the Stage 9 video scene spec, which will be a third key on the same reply.
