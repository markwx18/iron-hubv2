# Iron Hub

Personal fitness tracking PWA. Single-file HTML app, deployed via GitHub Pages,
installed to home screen on iPhone and desktop.

Owner: Mark (18, training ~7 months, lean bulk, 5–6 days/week).
This app is used daily and mid-workout. Breaking it has a real cost — he loses a
session's data or gets bad prescriptions at the rack. Bias toward caution.

## How to read this file

**This file is the rules. The stories behind them are in `docs/HISTORY.md`.** That file is the
full text this one was cut from on 2026-11-11: every incident, every measured number, the whole
function map (2,469 lines). It was moved out because it cost about 68,000 tokens on every turn.

- A **bold lead phrase** here is the same phrase that opens its entry in HISTORY.md. Before you
  change an area, grep for it and read the entry: `grep -n "The split in force" docs/HISTORY.md`.
- A rule here with no story is still a rule. A story there never loosens a rule here.
- When a stage ships, add its rules here (short) and its story to HISTORY.md (as long as it needs).
  Do not let this file grow back: if a paragraph explains *why*, it belongs in HISTORY.md.

---

## The single-file constraint

**`iron_hub.html` is the entire application.** All HTML, CSS and JavaScript live in that one file,
on purpose: it deploys as a static file with zero build step, can be opened from disk or emailed,
and has no bundler, transpiler or `node_modules` at runtime.

**Do not** split it into modules, add a build step, introduce a framework, or create `src/`
directories. If a change seems to require any of that, stop and ask.

Everything else is dev-time or separate, and the app never loads any of it:
- `test_agents.js`: the test harness. `scripts/clock_run.js`: the suite on a moved clock.
- `discord/`: a read-only Cloudflare Worker (`node discord/test_worker.js`, 0 failed). It goes live
  only after `npx wrangler deploy` from `discord/`.
- `pantry/`: the family pantry drop box, a Cloudflare Pages project (`node pantry/test_worker.js`).
  The app only fetches `FAM_DROP_URL`.
- `clock/`: the server runner's alarm clock, a Cloudflare Worker (`node clock/test_worker.js`). It
  only dispatches `.github/workflows/agents.yml`.
- `scripts/agents/run.js`: that workflow's runner. It loads `index.html` headless, so it is the
  app, not a copy of it. `scripts/whoop/`: the WHOOP relay. `scripts/gist_restore.js`: recovery.

## Deploy workflow

1. Edit `iron_hub.html`
2. **Bump the build marker**, line ~10: `<meta name="ironhub-build" content="YYYY-MM-DD-vX">`.
   The in-app update checker compares it. V5 builds use a `v5` suffix (`2026-11-11-v5a`).
3. Run the syntax check (below). Must pass.
4. Run the test suite (below). Must be fully green.
5. **Copy `iron_hub.html` over `index.html`.** They are byte-identical and both are committed.
   `index.html` is what GitHub Pages serves, so skipping this ships nothing.
6. Commit and push. GitHub Pages redeploys automatically.

There is **no service worker**, deliberately: every launch fetches the live file, so updates land
on the next open. Do not add one "for offline support"; it would break auto-updating.

## Checks before every commit

**Syntax check** (both blocks must print OK; trust acorn's line and column, not a bracket counter):

```bash
node -e "
const acorn=require('acorn'), fs=require('fs');
const html=fs.readFileSync('iron_hub.html','utf8');
const scripts=[...html.matchAll(/<script>([\s\S]*?)<\/script>/g)].map(m=>m[1]);
scripts.forEach((s,i)=>{ try{ acorn.parse(s,{ecmaVersion:2022}); console.log('block '+i+': OK'); }
catch(e){ console.log('block '+i+' ERROR:', e.message, JSON.stringify(e.loc)); } });
"
```

**Test suite:** `node test_agents.js`. Currently 5087 assertions, about 2 minutes. Must be
`0 failed`. A red suite is never shipped.

**The suite on a moved clock:** `node scripts/clock_run.js` (the V5 dates, three at a time, about
5 minutes), or name instants: `node scripts/clock_run.js 2026-12-28T07:30`. It honours
`IRONHUB_HTML`, so a mutant can be run on a moved clock too.

Tests must not depend on the day the suite is run. Name a day key (`"D1"`), never assume today is
a training day. The clock traps found so far: a stubbed `todayKey()` beside the real clock; a time
of day (a fixture "today at 6:16 AM" is newer than now before 6:16); the 25-hour day DST ends; an
end date (an arc that is over says nothing).

Setup (once): `npm install acorn jsdom`. The checkout is CRLF (`core.autocrlf`); the Edit tool
keeps it, a hand-written patch script must normalise `\r\n` itself.

## Testing bar

The standard is higher than "the tests pass."

- **A test must fail without the fix.** Use a *mutant*: copy the app, undo one rule in the copy,
  run `IRONHUB_HTML=/tmp/mutant.html node test_agents.js`, and see the test go red. Two traps
  produce a mutant that wrongly passes: an anchor string that matched an earlier, unrelated
  occurrence (check the mutation landed exactly once), and a fixture too clean to tell the
  branches apart (a perfectly linear series has no variance). Fixtures need real messiness, from
  fixed offsets, never randomness.
- **Assert behavior, not absence of exceptions.** A composer that renders and a Send button that
  works are different claims.
- **jsdom cannot see layout** (`scrollHeight`, `offsetWidth` are 0). Assert which branch was taken
  and say so in a comment. Layout is checked in a real browser: serve the working copy on port
  8731, seed `localStorage['ironhub:v1']`, and measure narrow widths in an offscreen div of fixed
  width with `column-count:1`. Check 393px and 320px.
- His live data is at `https://markwx18.github.io/iron-hubv2/`. Reading `localStorage['ironhub:v1']`
  there is the fastest way to check a bug report against his state before changing anything.
- **Clean up synthetic data.** Tests that push into `S.logs` or `S.split` filter it back out.
- **A change to what the engine prescribes needs a replay** over his real sessions first, old build
  against new, with only the history before each session.

---

## The bug class that keeps recurring: stale references across `await`

`applyPulled()` replaces the global `S` **wholesale** when a sync lands. A reference captured
before an `await` is orphaned afterward, and writes through it are silently discarded.

```js
// WRONG                                  // RIGHT: re-resolve after every await
const a = agState();                      await callClaudeWithTools(...);
await callClaudeWithTools(...);           agState().lastRun = todayKey();
a.lastRun = todayKey();
```

Some writes surviving and others not is the fingerprint. Anything an agent call needs afterwards
(which lifts were asked about, whether a key was offered) is taken *before* the await, and the
result is written into the state that exists *after* it. The suite swaps `S` mid-reply to prove it.

## The other sync trap: `save(false)` and the `changedAt` watermark

- **A user action must `save()`** (touch and push). Anything saved with `save(false)` can be
  reverted by the next background pull. Boot-time work stays on `save(false)`: bumping `changedAt`
  at boot makes `autoPullOnLoad()` skip its pull and push stale state over newer data.
- **A new `meta` field is a migration, because `load()` does not migrate `meta`.** `load()` merges
  one level deep, so a stored nested object is taken whole and a field added later is *absent*,
  not at its default. Do not add fields to `meta`. Gate on a field being genuinely present.
  The same holds for any nested object: see `ovOn()`.
- **A push must not overwrite what this device has not read.** `syncPush()` runs
  `syncReconcileBeforePush()` first: one GET, a second merge with `pushedAt` as the cutoff, and no
  push at all if the gist cannot be read. "Not applied" is asked of `syncSeenAt()`, never of
  `changedAt`.
- History collections are `SYNC_HISTORY` (unioned by key, per collection). Everything else in `S`
  is replaced whole on a pull; `S.agents` has its own merge in `applyPulled()`. A record that must
  not be lost to a pull is a history row, immutable, with its verdict computed when read.
- Recovery is `scripts/gist_restore.js` (`list` / `show` / `restore`). A gist keeps every revision.

---

## Where things are

The full map, one row per feature with every function, is HISTORY.md's "Architecture map".

| Area | Start from |
|---|---|
| State and sync | `S`, `load()`, `save()`, `DEFAULT_STATE`, `SYNC_HISTORY`, `applyPulled()`, `syncPush()`, `REMOVED_STATE_KEYS` |
| V5 switches | `OV`, `ovOn()`, `ovDefault()`, `ovSet()`, `ovPaidWait()`, `ovCardHTML()` |
| Evidence | `EVIDENCE`, `evEntryOk()`, `evBuild()`, `evidenceFor()`, `evTagsFor()`, `agEvidenceBlock()`, `evCiteClean()`, `evCiteHTML()`, `evCheckHTML()` |
| Schedule | `currentDayKey()`, `scheduledDayFor()`, `scheduleMode()`, `activeSplitObj()`, `mesoRotationDayFor()` |
| Progression | `recommend()` and `classifyDecision()` (two trees, kept in step), `buildOneLiveExercise()`, `intraAdvice()` |
| Today's call | `dayCall()`, `callTier()`, `recoveryBaseline()`, `whoopResponse()`, `fatigueIndex()` |
| Live session | `renderLive()`, `liveSetToLog()`, `endLiveSession()`, `sessionMods()`, `liftLoad()` |
| Bodyweight and intake | `bulkRate()`, `bulkBand()`, `calTarget()`, `nutTierCal()`, `nutTierPro()` |
| Plateau watch | `plateauRisk()` (one row per lift), `pwIssue()`, `plateauCauses()`, `pwAsOf()`, `pwMainRows()` |
| Holds | `holdBlocks()`, `holdOn()`, `holdAdd()` / `holdCancel()`, `stdHeldBy()`, `holdContextLine()`, `holdCardHTML()`, `awayRun()`, `awayClean()` |
| Standards | `stdState()` (one row per pillar), `stdWalk()`, `stdHeldBy()`, `dayExcuse()`, `svJudgeable()`, `stdMotion()`, `stdCardHTML()`, `stdContextLine()` |
| Forecasts and records | `anFanProject()` / `anFanAt()`, `predTick()` / `predResolve()`, `fcRun()` / `fcResolve()` |
| Agents, nightly | `agRunAll()`, `agBaseContext()`, `intelSummary()`, `svSheet()`, `agIngest()`, `agLog()` |
| Agents, the queue | `agValidateFix()` = `agValidateFixShape()` then `agConflict()`, `agApprove()`, `agApplyFix()` |
| Agents, chat | `chatContext()`, `coachToolDefs()`, `coachValidateAction()`, `coachApplyProposal()` |
| Selector and swap trials | `selState()` (one row per lift), `selScore()`, `selCandidates()`, `swapTrialOn()`, `swtView()`, `baseSplitObj()`, `swtCheck()`, `swtStartMine()`, `swtTrials()`, `swtDecide()`, `agSwapNeeds()`, `selContextLine()` |
| Analysts and squads | `ANALYSTS`, `anlPass()` (the one read), `anlLeadStatus()`, `anlNums()`, `anlStrips()`, `anlSquadLine()`, `dosTargets()`, `hubSquadsHTML()` |
| Desk, watches, Plan of Record | `hubDeskHTML()`, `deskPlusTopHTML()`, `deskAnalystCards()`, `WATCH_SERIES`, `watchSpecOk()`, `watchList()`, `watchEval()`, `watchAdd()`, `watchOffers()`, `watchFiredLine()`, `PLAN_CHECKS`, `planRowOk()`, `planFor()`, `planCardHTML()` |
| Accountability | `planVerdict()`, `planScore()`, `planSuggest()`, `planSetMine()`, `planValidate()`, `wrOn()`, `wrPromptPart()`, `wrIngest()`, `planMemoryLine()`, `monthlyMaybe()`, `ordValidate()`, `ordNow()`, `ordContextLine()`, `MONTHLY_MODEL` |
| Agents, extras | roundtable `agRoundtable()`, Desk `agValidateDesk()`, questions `qaDue()`, diagnosis `pdTargets()`, letter `agWriteLetter()`, brief `agRunBrief()` |
| API | `aiSend()` (the one transport), `aiBody()`, `callClaudeWithData()`, `spendPreflight()`, `aiUsageNote()` |
| Server and schedulers | `agForegroundCheck()`, `runnerTick()`, `agMaybeAutoRun()`, `agMaybeMorningBrief()` |
| Screens | `renderHome()`, `renderOps()` (the Hub), `renderDesk()`, `renderSettings()`, `NAV_MODEL`, `NAV_LEGACY`, `showMainTab()` |
| Video letter | `VL_SCENES`, `vlNums()`, `vlLineOk()`, `vlSayClean()`, `vlScript()`, `vlPromptPart()`, `vlIngest()`, `vlLetters()`, `vlOpen()` / `vlPlayTap()` / `vlSpeak()`, `vlInboxItem()`, `vlLibHTML()` |
| Organization | `orgOn()`, `inboxItems()` / `inboxRaw()`, `inboxRowHTML()`, `inboxDo()`, `homeZonesHTML()`, `renderHubNow()` / `renderHubOut()` / `renderHubLib()`, `orgHubRepaint()`, `cbApply()`, `cbWatch()`, `uiDepth()` |
| Folds and prefs | `subSection()`, `rawFold()`, `uiPref()`, `notifItems()` |
| Charts | the chart kit: `ckText()`, `ckPath()`, `ckMarks()`, `ckW()`; `anFanChartSVG()`, `lineChart()` |

**Agent system:** four agents: ZULU (lead), CHARLIE (the supervisor: showing up, logging,
logistics, schedule), DELTA (training), ECHO (nutrition and bodyweight). Model `claude-sonnet-5`,
declared once as `AI_MODEL`. Nightly at 9 PM the three specialists run **in parallel**, each with
its own prompt and fix shapes, then ZULU runs on their output and writes the Daily Brief. Do not
add `cache_control` there: nothing could read the cache.

---

## Hard rules for the agent layer

**Agents never mutate state silently.** Every change a model suggests needs Mark to tap something.
The tap-to-apply paths are: the nightly queue (`agApprove()` re-runs `agValidateFix()`, then
`agApplyFix()`), every agent's chat cards (`coachValidateAction()` → `coachExecuteAction()`, each
agent only in its own lane), Investigation's Apply fix, the fatigue banner's Start deload, meso
split approval, and the Selector's two (starting a swap trial from its card, and Keep on a finished one). Do not add
another side path. If one is unavoidable, it gets the same checks.

**`agValidateFix()` is a security boundary.** It whitelists fix types, clamps ranges and rejects
anything malformed. Never loosen it to make a model's output "work": invalid output is discarded,
not coerced. New fix shapes extend `agValidateFixShape()` and `agConflict()`. What it enforces:
each agent raises only its own fix types (`AG_FIX_ALLOWED`); a `liftReset` has a ceiling
(`agResetCeiling()`); names are resolved (`exAcceptName()`); a rejected fix is not re-queued for
14 days; a well-formed fix can still collide (`agConflict()`: deloads, resets, flags, experiments,
sharp pain, **volume last** on a stalled grinding lift); a refusal names its reason.

- **Advisory-only proposals are not allowed in the queue.** No concrete `fix`, no request.
- **Prompt instructions are not enforcement.** Anything that must be true is validated in code.
- **Model-supplied exercise names must be resolved, never trusted** (`agResolveExName()`), and
  **a coaching note is not part of a name** (`exSplitNote()`).
- **Read-only agent output still needs a validator** (`olValidateReport()`, `agValidateDesk()`,
  `agValidateDiagnosis()`, `fcValidate()`, `planValidate()`, `ordValidate()`): a bad night costs commentary, never content.
- **There is no write tool and there must never be one.** Data tools only read. A chat call only
  stages a card (at most `CHAT_CARDS_MAX`), and his tap checks it again.
- **A chart or a check from a model is a spec, never numbers.** The app draws and measures from
  his data. A model never defines a measure outside the fixed set.
- **Schedule fixes are mode-gated in both directions**, and the cycle anchor date is never changed
  by a proposal.
- **The agents coach, and say how sure they are** (`agEvidenceRules()`, "HOW SURE TO SOUND"): no
  effect size or timeline the app has not computed; an observation is not a cause.
- **Each agent has its own voice** (`AG_VOICE`). No voice text says "You are <another agent>": the
  suite's stubs route on that phrase.
- **A section with nothing to say is absent**, so a quiet night's prompt is byte-identical. That is
  the cost guard, and the suite checks it. Every section is capped in characters.

**Sonnet 5 thinks adaptively, and thinking bills as output and counts against `max_tokens`.**
Never set `max_tokens` under 4000. Control spend with `output_config.effort`. `temperature`,
`top_p`, `top_k`, `budget_tokens` and assistant prefills return a 400; none are used.

**One transport, and it retries only what it can prove was never billed.** `aiSend()` is the only
place the app talks to the API. It has a timeout, streams (`stream:true` with
`thinking:{type:'adaptive', display:'summarized'}`: both are required, WebKit drops a silent
connection at 60 s), and retries only a `fetch()` that rejects before any response. Never widen
`agIsNetworkErr()`. Tool loops are bounded (`AI_TOOL_ROUNDS`).

- **Every reply's token usage is kept.** Pass a `route` in `opts` on any new call, or it lands
  under "Other".
- **There is a monthly cap, and it sees both devices** (`spendPreflight()`). Automatic routes pause
  at the cap; anything he started asks first (`spendManualOk()`).
- **Paid pieces go on one at a time, a week apart on the spend ledger** (his rule, 2026-10-04).
  Check the usage card before the next.
- **A paid call's pre-pull pushes first** (`agConfirmGateThenRun()`), and anything both a device
  and the server could start goes through that gate.
- **A repaint must never be able to strand an in-flight flag.** Flags are released in `finally`,
  and every repaint inside a runner is inside the `try`.
- **A gate that declines must leave evidence** (`briefNote()`, a log line). A silent `return` was a
  three-day bug.
- **A `setInterval` is not a scheduler on iOS.** `agForegroundCheck()` is the single entry point
  (boot, `visibilitychange`, `online`), after the pull. New "when he next looks" work goes there.
- **The agents run on a server now, and the server is the app.** The boot does not run there, so a
  new server duty goes in `runnerTick()`. The pull must succeed first. The Actions log is public:
  print what was done, nothing of his data.

---

## Invariants: things that will silently break if undone

Each has an entry in HISTORY.md under the same bold phrase.

**Schedule, splits, deloads**
- **The split in force is not always `S.split`.** Resolve through `activeSplitObj()` (a strength block's split, or a
  swap trial's view); a writer asks `baseSplitObj()`; per-lift
  flags through `exSlotsFor()` (the split in force, else the permanent split).
- **Generating a split is not scheduling it.** Blocks reach the calendar only through
  `mesoRotationDayFor()`. There are no date overrides (removed in V4).
- **The deload in force is not always `S.deload`.** Ask `deloadWindow()` / `deloadActive()`.
- **A deload he ended early is over everywhere**: ask by date (`mesoDeloadOn()`, `mesoPhaseOn()`).
- **The fatigue norm is his usual training week**, so a deload week is not part of it.
- **Deload alerts can be off until a date** (`S.deloadQuiet`); `agDeloadBlock()` enforces it.
- A removed feature's keys go in `REMOVED_STATE_KEYS`. Check what else leaned on what you pull.

**The engine**
- `recommend()` and `classifyDecision()` are two trees kept in step. A caution only ever holds a
  weight: **a jump earned on grinders repeats once**, the spike guard, the two-set rule.
- **Today's call sets the plan automatically, inside hard bounds**: never heavier than the normal
  plan, never lighter than his last top weight minus one increment, never more than one set fewer.
  **Pre-workout strain sets a floor under the call.**
- **A reset holds `RESET_HOLD_SESSIONS` (2) sessions**, then hands back to the engine.
- **Strength mode off is stored as `'hyp'`,** never `null`.
- A prescription is never rounded to the gear: an unloadable weight is named with both neighbours.

**What a record is**
- **A session records what it was**, and **`sessionMods(log)` is the one reader of all of it**.
- **Effort reads go through `effBucket()`**; a writer writes both `ef` and `e`; `liveSetToLog()` is
  the one set copy. Sets use `ts`; on a record `t` is the sync stamp.
- **A session he never ended is saved, not dropped** (`liveRecoverStale()`).
- **Bench Practice is load, never strength**: its own collection `S.practice`, never `S.logs`.
- **A sleep log is not a check-in** (`rdComplete()`).
- **A weigh-in is checked before it is believed** (`addWeight()`).
- **A correction to logged history runs once, and only on a current state** (`DATA_FIXES`; a new
  entry with a new id, never an edited one).
- After-session answers live in `S.sessionMeta`, never on the log (it may already be pushed).
- **Photos never go in `S`.** State holds an index; the blobs are in their own gist.

**One source for each number**
- **One bodyweight rate, and one set of bands**: `bulkRate()` / `bulkBand()`. Do not add a fifth.
- **One intake target, and nothing hardcodes it**: `calTarget()` / `proTarget()`, judged only by
  `nutTierCal()` / `nutTierPro()`.
- **The plateau watch is on the device, free, never stored, and ONE result**: `plateauRisk()`.
  Colour follows confidence; a stall reads "holding", never "stalled".
- One grind-share measure (`liftHardShare()`), one "how hard did it feel" path (`feltVsPlan()`),
  one projection core (`anFanProject()`), one muscle-map source (`bmViewerData()`).

**Computed when read, never stored**
- Track records (`agOutcome()`), the prediction record (`predResolve()`), forecasts
  (`fcResolve()`), experiments' results, the recap, notifications, the plateau watch. A stored
  verdict would lose to an older snapshot.
- **The agents get a computed summary, not raw arithmetic to redo** (`intelSummary()`), and
  **the summary states facts, never a pick**.
- **Experiments are proposed by the agents and measured by the app**: fixed templates only.
- **Forecasts and insights are descriptive, and they say so.** Never "proven".
- **The Sunday check-in is notes only.** Nothing in it changes a future date.

**The outside world**
- **WHOOP comes in, never out.** Data not dated today is absent. **The WHOOP history is history,
  never today.** **Dated today is not the same as final** (`whoopProvisional()`).
- **The WHOOP relay's cron is not a schedule, it is a lottery**; the app dispatches. A classic
  token needs the full `repo` scope. Whether a token can dispatch is a per-device fact, kept in
  its own `localStorage` key, never in `S`.
- **The relay merges, it does not clobber.** A relay that cannot read its token store fails loudly.
- **Discord is a window, not a door.** The Worker only reads; `discordView()` builds its file from
  the app's own functions, and it must never cost a sync.
- **The schedule doc is a window too**, computed, with no model call. A 200 is not a success.
- **The Fuel Planner is on-device, and its food list is not state.** `FOOD_DB` ids are never
  renamed or reused. `S.fuel` holds preferences, not history.
- **The family pantry check**: everything in a link is untrusted (`famValid()`), the boot never
  runs on their page, and the drop box is on `pages.dev` because his home network blocks
  `workers.dev`.
- Per-device facts (usage log, relay verdict, UI prefs, chat undo, the brief trail) live in their
  own `localStorage` keys, never in `S`.

---

## UI conventions

Design language: **"Forge × Ember"**. Saira Condensed caps, industrial amber, big tabular numbers,
a warm brown-black ground, rounded cards separated by shade. Layout is the A × C "Ember HUD".

| Token | Value | Use |
|---|---|---|
| `--base` / `--panel` / `--panel2` | `#16110E` / `#201915` / `#2A211B` | ground, card, raised element |
| `--amber` | `#F28A3A` | the one accent, DELTA |
| `--cyan` | `#54C2A4` | CHARLIE, positive trend (same value as `--good`) |
| `--good` / `--warn` / `--bad` | `#54C2A4` / `#E9B44C` / `#D2476B` | status, always with a word or icon |
| `--violet` | `#B79BFF` | ECHO, strength mode |
| ZULU | `#dfae36` | lead agent |
| `--text` / `--muted` / `--dim` | `#F4EADF` / `#BCAB9B` / `#978779` | ink, three levels |

Type: `--disp` Saira Condensed, `--body` Figtree, `--mono` IBM Plex Mono only for tabular data.
`--r-card` 18px, `--r-ctl` 12px.

- Use CSS variables, never hardcoded hex, in new UI. Colour always comes with a word or icon.
- **`--bad` is deliberately not the old red.** Re-run the colour-blindness check before moving it
  or the accent. **The day colours were deliberately left alone.** The 3D muscle model keeps its
  colours (`BM_C`), and the 2D map matches it.
- **Never repaint under the user's hands.** No re-render while an input has focus or a LIVE session
  is active. A new LIVE text input goes in `LIVE_KEEP_INPUTS`.
- **Card open-state must not live on the DOM node.** The active tab is regenerated every 30 s.
  Open state, drafts and filters are module-scoped; a remembered fold is `subSection(…, {pref})`.
- **A fold must never hide a failure.** A failure state shows in the folded summary too.
- **Mobile is the primary target.** iPhone, one-handed, mid-set. Check 393px and 320px.
- **Charts go through the chart kit**, drawn at the width they are shown at (`ckW()`). Marks come
  only from real events (`ckEventMarks()`), never from a model.
- **Navigation is four groups plus Live.** Sections keep their ids. `NAV_LEGACY` maps every
  section to its group and view, a view can merge sections through `show[]`, and every repaint
  goes through `navRenderSub()`. The suite checks each section is reachable from exactly one group.
- Motion happens on navigation only, and respects `prefers-reduced-motion`.
- **Today only reads.** Rendering it leaves `S` byte-identical (`todayKeyLifts()`).
- Raw data goes last, in a fold (`rawFold()`).
- Wording: waiting proposals are **requests**, never ideas. Nothing is called a "Mission".
- **Muscle map: 2D on LIVE, 3D on Progress.** LIVE's front door never waits on a CDN or a GPU.
- A restyle keeps every element id and handler. LIVE's are listed in HISTORY.md ("V4 stage 4").

## Style notes

- Comments explain *why*, especially for non-obvious guards. Keep the ones that name a bug.
- **Anchor short keyword tokens in name-matching regexes** with `\b` (`/lat/` matched "P**lat**e").
- Match the surrounding code style. Prefer editing existing functions over adding parallel ones.
- `esc()` all user or model text going into HTML.
- A string inside an `onclick="f('...')"` goes through `jsq()`, never `esc()`. Better: pass it in a
  `data-` attribute.
- The file mixes `\u` escapes and raw UTF-8. Grep the exact line before matching on it.

---

## When to stop and ask

- The change seems to need a build step, framework, or extra runtime file
- The change would let an agent write state outside the tap-to-apply paths above
- The change would loosen `agValidateFix()`
- A test can't be made to fail without the fix (the test is wrong, or the fix isn't doing what you
  think)
- Anything touching health, injury, or nutrition guidance where being wrong could affect his
  actual training or wellbeing

## Cost and safety guardrails for autonomous decisions

Most unspecified details (component structure, styling, minor UX choices) don't need approval.
Use good judgment and proceed.

But never silently pick the more expensive or more permissive option for these. Stop and flag the
tradeoff in plain terms before writing code:
- Any change to which model powers the in-app agents, or whether they run as one combined call vs.
  separate calls (real, differing ongoing API cost)
- Any change to what tools/data the agents can access (e.g. web search, scope beyond
  fitness/training)
- Any change letting an agent write state outside the existing tap-to-apply paths
- Any new backend infrastructure where none existed before

---

## V5 (in progress, started 2026-11-11)

The spec is `Claude outputs/IRON_HUB_V5_PLAN.md`. The existing "V4" entries describe the previous
generation and stay as they are. His choices on 2026-11-11: build as fast as is safe; mockups
early; a red Standard is free (the card is computed, and ZULU leads the next brief with it; there
is no paid same-day call and no midday clock slot); strict mode has sick and exam holds, "plan in
motion", and a fast-gain amber.

**Every V5 stage sits behind a switch** (`OV`, `S.overhaul`).
- Ask `ovOn(key)`. Never read `S.overhaul`: it holds only what he changed, and the defaults live in
  code, because `load()` would hand back a stored object without any switch added later.
- A free part defaults on (unless its row has `hold:true`), a paid part off. An unknown key is off, so a typo cannot start a paid
  route. `ovSet()` is his tap and a `save()`; the server reads the same switches from the gist.
- Turning a paid part on asks first and names his week-apart rule when it is early
  (`ovPaidWait()`); turning anything off never asks. A stage registers its row in `OV` when it
  ships.

**Rules every stage follows**
- New history is a `SYNC_HISTORY` collection with immutable rows and its own key prefix. Taken:
  `w n r l p x b m q f v k $ g y h s a o j`.
- Anything an analyst shows is worked out when read, never stored and never posted to the Desk.
- A stage ends with: acorn, the suite at 0 failed, a mutant per new rule, `scripts/clock_run.js`,
  the build marker, the copy to `index.html`, this file and `UPDATE_LOG.md`, a commit and a
  `v5-stage-N` tag.

**Stage 1, Standards** (`ovOn('standards')`, free)
- **The Standards are computed when read, on the device, free, and ONE result**: `stdState()`. The card, the top-bar
  mark, the bell, the agents' line and the brief's lead all read it. Never stored, never model-written; a consequence
  line is arithmetic on his numbers.
- **A level is carried, not windowed** (`stdWalk()`): exit clears, an entry raises, anything else holds. Only its exit
  condition clears a red, and there is no dismiss.
- **No data is never red, and never a clean bill.** Thin data, or a pillar that throws, reads `nodata`.
- **Bulk pace is expressed through `bulkRate(2, sunday)` and `bulkBand()`, with no new band.** Completed weeks only.
- **A reason is his tap and an immutable row** (`S.dayReasons`, `stdReasonSet()`, a `save()`). For Showing up the day
  was not a miss; on any other pillar it is a note and never changes a level.
- `dayExcuse()` is the one answer to "was that a miss" for the Standards, `svSheet()` and the streak. **A day before
  the cycle's anchor cannot be a miss** (`svJudgeable()`). **A day trained on a rest day within two days was made up.**
- **Lifts reads the watch's main rows** (`pwMainRows()`, the chips' own list). **Plan in motion stops the escalation,
  not the red** (`stdMotion()`, `stdStrictRows()`).
- A quiet Standard adds nothing to any prompt (`stdContextLine()`, `stdStrictLine()`, `stdBriefLine()` are empty).
- **The brief records what was red when it was written** (`brief.std`, read before the await). Gate on the field.
- **Today reads the Standards once a repaint**; `_stdPass` never outlives `renderNotif()`.
- The thresholds are named constants (`STD_*`); `stdHeldBy()` is the hook holds fill.

**Stage 2, Holds** (`ovOn('holds')`, free; the trip plan is `ovOn('awayPlan')`, paid, off)
- **A hold block is read-only context.** `S.holds` (key `h|`): immutable rows, and removing one is a cancel row. What is
  in force is `holdBlocks()`, worked out when read; a row that fails `holdRowOk()` is ignored, never repaired.
  `scheduledDayFor()` does not know holds exist, and nothing here brings date overrides back.
- **A day in a block is not a miss**, through `dayExcuse()` (so `svSheet()`, the streak and Showing up agree), and it
  holds whatever the Standards switch says. A session trained inside a block still counts.
- **A hold freezes a Standard, it never clears one** (`stdHeldBy()`): the block's days plus `HOLD_AFTER_DAYS`. A trip
  holds Showing up and Bulk pace; sick and exams also Intake; Lifts and Recovery are never held. A miss in the days
  after a block is still a miss and shows when the hold lifts.
- A block far off adds nothing to any prompt (`holdContextLine()`, within `HOLD_SOON_DAYS`). His note is quoted as data.
- **The trip plan is one call per block, only by his tap** (`awayPlanSubmit()` → `awayRun()`, route `awayplan`, modelled
  on `wpRun()`): asked through `spendManualOk()`, input saved before the call, re-resolved after the await, closed by
  any reply that came back. Its changes are ordinary requests through `wpFilterProposals()` and `agValidateFix()`.
- **Nothing states what a break costs.** The prompt names the app's defaults as defaults, not research, and
  `awayClean()` drops any line that claims a loss or puts a percentage on it. Do not loosen `AWAY_CLAIM_RE` to keep a line.
- The limits are named constants (`HOLD_*`). The form's draft is module-scoped (`holdDraft`), read before any repaint.

**Stage 3, Evidence** (`ovOn('evidence')`, free but held off; in prompts `ovOn('evidencePrompts')`, paid, off)
- **`hold:true` on a free `OV` row means off until he turns it on** (`ovDefault()`), and turning it on asks. Use it
  for anything free that he must look at first. The Evidence Library is training and nutrition guidance: it stays off
  his screen and out of every prompt until he has spot-checked ten entries (`EVD_CHECK_FIRST`, listed in Settings).
- **`EVIDENCE` is a checked constant.** `evBuild()` keeps only rows that pass `evEntryOk()`; a failing row is dropped,
  never repaired. An entry is what ONE source reports (`finding`), its `strength`, and `means`, the app's inference.
- **The inference is always labelled as the app's, never the paper's claim**, in a prompt (`evLine()`) and on a card
  (`evEntryHTML()`). Every `means` opens with `EVD_MEANS_LEAD`, and the schema checks it.
- **A cite is a list of ids and nothing else.** `evCiteClean()` keeps exact ids that exist, at most `EVD_CITE_MAX`, and
  only with the library on; it is absent from a record otherwise. The chip, link and text are drawn from the constant
  (`evCiteHTML()`), never from a model. No cite reads "coach's judgement". A cite never helps a fix pass.
- **Evidence in the nightly prompts needs both switches** (`evPromptsOn()`, `agEvidenceBlock()`); with either off every
  prompt is byte-identical. Chat gets none. The trip plan gets the `break` shelf whenever the library is on.
- `evidenceFor(tags, max, day)` is pure: situation tags first (`evTagsFor()`), one entry per tag in turn, capped at
  `EVD_MAX_CHARS`, rotated by the day. The names are `EVD_*` because `EV_*` belongs to the events.
- A refresh of the library is a Code session that opens each source; never add an entry from memory.

**Stage 4, Analysts** (`ovOn('analysts')`, free; `ovOn('squadPrompts')` and `ovOn('dossiers')`, paid, off)
- **An analyst is a pure function, not an agent** (`ANALYSTS`, eight; the callsigns are placeholders and nothing keys
  on `name`). No call, no prompt, no chat, no fix types: `agFixAllowedFor()` refuses an analyst's id. Only leads propose.
- **The readings are worked out when read, and ONE result**: `anlPass()` / `anlState()`. Never stored, never posted to
  the Desk.
- **A pillar analyst takes its level from `stdState()` and nowhere else** (`anlFromPillar()`), so a tile cannot
  disagree with the Standards card. FOXTROT has no pillar (amber at most, and only with `FOX_FLAGS`); INDIA reads the
  Selector (`anlIndia()`, stage 5; off, it lists and judges nothing); KILO only reports.
- **A broken analyst reads `nodata`**, and so does a level that does not exist. No data is never clear:
  `anlLeadStatus()` says clear only when an analyst could actually read.
- **A lead's status is the worst in its squad** (ZULU: across every squad, `ANL_ZULU_ROLLUP`).
- **A status is a colour, an icon and a short reason. It never names its level** (his pick, 2026-11-12:
  "Everywhere"). A new status word has to pass the suite's level-name check.
- **FOXTROT lists the moves and judges nothing** (`FOX_FLAGS` is false). On his history a volume flag read amber on
  46 to 67 of 88 days, so it has no level, no strip, and never reaches a prompt. Replay before turning it on.
- **FOXTROT reads one full rotation before the day** (`anlFoxDays()`; never today, whose session may not have happened
  yet) against his ordinary weeks: a deload week and held days are neither read nor part of his usual (`FOX_*`).
- **The 14-day strips are as-of and memoised** (`anlStrips()`, `anlStripKey()`). Anything new that can move a level
  goes in the key. Today's cell is the live reading and is never kept.
- **Squad readings in a prompt are a paid switch** (`anlSquadLine()`): the lead's own squad, flagged readings only,
  capped at `ANL_PROMPT_MAX`, nightly only. Off, or with nothing flagged, every prompt is byte-identical.
- **Lift dossiers are a paid key inside DELTA's existing call** (`dosTargets()`, `agValidateDossiers()`): main lifts
  only, at most `DOS_MAX` a night, one lift once in `DOS_QUIET_DAYS`, never a lift being diagnosed that night, asked
  before the await. `S.agents.dossiers` is merged per lift in `applyPulled()`. The diagnosis stays last in the prompt.
- **The Hub's Agents view is four lanes while the switch is on** (`hubSquadsHTML()`). Off, or if the lanes throw, the
  map is drawn (`hubMapHTML()`). Lane and tile open-state is module-scoped (`sqLaneOpen`, `sqTileOpen`), and a tile
  tap keeps a half-typed chat message (`sqRepaint()`). **A lane is a `<div>`, never a `<section>`**: the app hides
  every section that is not the active tab.
- Not built yet: the List and Week views, the Wire, tension markers, lit lines, the Plan of Record bar.

**Stage 5, Selector** (`ovOn('selector')`, free; DELTA's swap key is `ovOn('swapKey')`, paid, off)
- **The fit score is worked out when read, on the device, free, and ONE result**: `selState()`, a row per lift in the
  split in force. Fit is 100 less a penalty row for each thing the app can see (`SEL_W`: a stall on the watch, noise,
  hard sets, pain, sets left out, a same-day duplicate), and every penalty is a row on screen. Never stored, never
  model-written. A score that throws reads "too few sessions": never a mark, never a clean bill.
- **The Hub reads the Selector once a repaint** (`_selPass` never outlives `renderOps()`), and **a past day is never
  read from the pass** (`selCompute()`, through `pwAsOf()`).
- **The cut-offs came from a replay** (`SEL_KEEP`, `SEL_TRIAL`, `SEL_NOISE_*`). Replay before moving one. INDIA is
  amber at most, only for a marked lift, and takes its level from `selState().lvl` and nowhere else.
- **Bench and squat are never swapped by an agent and never put on trial** (`selProtected()`): watch only, in the score,
  in `swtCheck()` and in `agSwapNeeds()`.
- **A marked lift can be held at watch**, and the row says why: a reset in progress, something already being tried
  (`stdMotion()`), its muscle group flat too, a bodyweight lift, a strength block, no candidate. **A lift flagged sore
  or worse is never a clean keep**; a sharp flag reads swap allowed, and is offered no trial.
- **A swap trial is a third split in force.** While `swapTrialOn()`, `activeSplitObj()` returns a view (`swtView()`):
  the stand-in takes the slot on every day that holds the lift and keeps only the slot's set count. **`S.split` is never
  edited by a trial**; ending one is the view no longer being built. A strength block's own split is never overlaid.
- **A writer, and "is a block running?", ask `baseSplitObj()`**, never `activeSplitObj()`: the view is a copy, and a
  write into a copy is lost.
- **A trial is the experiment template `swapTrial`**, so every experiment rule holds. `sel:true` keeps it out of the
  chat tool's enum and the ordinary menu line. The first session is the starting point (counted, never scored); the
  rest are progress against the old lift's line (`swtScore()`), never pounds against pounds.
- **A trial starts only by his tap**: the Selector card (`swtStartMine()`), or approving DELTA's request. `swtCheck()`
  is the one check for both; from an agent it also needs the paid switch, a lift INDIA marks, and one of the app's own
  candidates (`selCandidates()`). Never offer a button `swtCheck()` would refuse: the row says why instead.
- **`S.swapTrials` (key `s|`) holds a finished trial and his answer as immutable rows**; the result is worked out
  from the logs when read (`swtTrials()`), and a row that fails `swtRowOk()` is ignored. The card asks keep or go
  back for `SWT_DECIDE_DAYS`; the old lift is back on its day meanwhile. Keep goes through `agValidateFixShape()`.
- **A permanent swap from an agent needs grounds** (`agConflict()` → `agSwapNeeds()`): a finished trial that favoured
  that lift and that he did not turn down, a pain flag (sore or worse), or the lift left out of 3 of its last 4
  sessions. Off with the Selector switch. Chat's own swap card and his edits to the split are untouched.
- **DELTA's block and template line are a paid switch** (`selContextLine()`, `selMenuLine()`): DELTA only, only when a
  trial could start tonight and INDIA marks a lift that has candidates, capped at `SEL_PROMPT_MAX`. Otherwise every
  prompt is byte-identical.
- **A trial result leans toward the new lift, and says so** (`SWT_LEAN`). Never "proven".

**Stage 6, Desk** (`ovOn('deskPlus')` and `ovOn('planRecord')`, free; the coaches' watch key is `ovOn('watchKey')`, paid, off)
- **An analyst's card on the Desk is derived when the Desk is drawn** (`deskAnalystCards()`, from `anlPass()` and the
  strips): a flagged reading, or a level that changed inside the strip. Never stored, never posted to `S.agents.desk`.
- **A watch is a spec the app measures, and whether it fired is worked out when read** (`watchEval()`, `watchList()`).
  `S.watches` (key `a|`) holds immutable rows: a watch, `{cancel}` removing one, `{no}` turning an offer down. A row that
  fails `watchRowOk()` is ignored, never repaired. Nothing about a firing is stored.
- **`watchSpecOk()` is the one shape check**, for a stored row, his form and a coach's offer: a series from
  `WATCH_SERIES`, `below` or `above`, a threshold inside the series' range, a whole `within` from 1 to
  `WATCH_WITHIN_MAX`. Out of range is refused, never clamped. A model's lift is resolved first (`watchSpecFrom()`).
- **A watch never fires on history**: only readings dated on or after the day it was made count. A week is a completed
  Monday-to-Sunday week, today's intake log is not a reading, a deload session is not a reading, WHOOP is its history.
- **A watch exists only by his tap**: his form, or Accept on a coach's offer. An offer is a Desk post carrying a
  validated spec, and the tap checks it again (`watchAdd()`). At most `WATCH_MAX_OPEN` open. A fired watch is one-shot.
- **A watch changes nothing in his plan.** It is not a fix and never reaches `agValidateFix()`.
- **A watch that cannot be read says so** (`broken`: a mark on the Desk and a bell item). Never quiet, never "fired".
- **The coaches' side is one paid switch** (`watchKeyOn()`): the watch part of the Desk spec line, two more chart series
  (`DESK_SERIES_MORE`), and the owner's line on the nights after a firing (`watchFiredLine()`, capped). Off, or with
  nothing fired, every prompt and reply spec is byte-identical. Chat gets none of it.
- **The Plan of Record is stored and shown; a verdict is never stored.** `S.planRecord` (key `o|`): immutable rows, the
  newest valid row for a week stands, `{cancel}` withdraws one, and a row that fails `planRowOk()` is ignored. A
  priority is `{standard, check, byDate}` with `check` from the fixed `PLAN_CHECKS`, filed under that check's own pillar.
- **The Desk with the switch off is the coaches' board as it was** (`deskBoardHTML()`). On, if the top part throws, the
  failure is said on screen and the board is still drawn. Filters and the watch form's draft are module-scoped.
- Interventions are not a call (his choice): the brief already leads with a new red.

**Stage 7, Accountability** (plan scoring is under `ovOn('planRecord')`, free; `ovOn('weeklyReview')` and `ovOn('monthlyReview')`, paid, off)
- **A verdict on a priority is worked out when read and never stored** (`planVerdict()`, `planScore()`): met, partly,
  missed, open, held, or not judged. Too little data, a lift that was not on the schedule that week, sets that carried
  no call, or a measure that throws reads "not judged": never a miss and never a pass.
- **Bodyweight on the week is `bulkRate(2, sunday)`**, the Standards' own expression, judged only once the week is over
  and only with `STD_BW_MIN_WEIGHS` weigh-ins in both weeks. Today's intake log does not count until the day is over. A
  day with a reason is not a missed scheduled day (`dayExcuse()`). A hold on the pillar that week reads held.
- **`planValidate()` is the gate for a plan a model wrote**: each priority through `planPriOk()` with its lift
  resolved; a check outside `PLAN_CHECKS`, filed under the wrong pillar, out of range or dated outside the week drops
  that priority and keeps the rest. Nothing is coerced.
- **A plan is set two ways**: his tap on the app's own suggestion (`planSuggest()` → `planSetMine()`, a `save()`), or
  ZULU inside the weekly letter call behind the paid switch. Withdrawing one is a cancel row. A plan changes nothing in
  his program, and a missed priority never moves a Standard's level (`PLAN_FEEDS_STANDARDS`).
- **The Weekly Review rides the letter call** (`wrOn()`, `wrPromptPart()`): one call, one reply with `letter` and
  `plan`, each kept or dropped on its own. The plan's week is taken before the await (`wrPlanWeek()`) and `wrIngest()`
  writes into the `S` that exists after it. Off, the letter prompt is byte-identical and a reply is only ever a letter.
  ZULU's own record (`planMemoryLine()`, capped) is in that call and nowhere else.
- **The Monthly Review is server-only, once a month, behind its own paid switch** (`monthlyMaybe()`, from
  `runnerTick()`'s evening branch; route `monthly`, an automatic route, no tools). Any reply that came back closes the
  month; a call that never got through does not. A decline at the cap leaves a line in the feed, once a day.
- **`MONTHLY_MODEL` is `AI_MODEL`.** Changing it is his decision (the cost guardrail). `aiBody()` honours a model only
  when it is that constant.
- **Standing orders are data** (`ordValidate()`, `S.agents.orders`, newer wins in `applyPulled()`): at most
  `ORD_MAX_LINES` lines per coach, in force for `ORD_DAYS`, in a coach's nightly prompt only with the switch on
  (`ordContextLine()`, capped), never in chat. They change nothing. With the switch off, or with none in force, every
  prompt is byte-identical.

**Stage 8, Organization** (`ovOn('organize')`, free; read it through `orgOn()`)
- **The Inbox is worked out when read, and has no store** (`inboxItems()`): the bell's items (`notifItems()`) plus the
  few things that only had a card (held requests, a finished trial, an experiment answer, the stock check, the plan
  suggestion), each source in its own `try`. Clearing is the bell's own `S.notifCleared`; `inboxItems()` reads it and
  never initialises it, because Today only reads. A new "waiting on you" thing is a source here, never a new card.
- **Priority and the type chip come from the item's id prefix** (`INBOX_TYPES`, `INBOX_PRI`): a red Standard first,
  then requests and failures, then routine. **A request cannot be cleared** (`INBOX_ASK`); it leaves when answered.
- **An Inbox action is the source's own** (`agApprove()`, `agReject()`, the source's `go`, `notifDismiss()`). The Inbox
  adds no write path. A source's `go` is inserted as the bell inserts it: it is already escaped.
- **The bell is the Inbox's badge**: one count (`notifCount()`), one list, most urgent first.
- **Today is five zones** (`homeZonesHTML()`): orders, the session with Start, the Inbox's top three (skipping what has
  its own zone, `INBOX_ON_TODAY`), the agents and the brief, one fold. A card with an input (the question) is drawn in
  one place only, on Now. **A new feature names its zone and its fold before it ships.**
- **The Hub is five views** (`NAV_HUB_V5`, a getter on `NAV_MODEL`; the moved routes are getters on `NAV_LEGACY`).
  Off, the three new sections (`hub_now`, `hub_out`, `hub_lib`) are the only unrouted ones. A Hub action ends in
  `orgHubRepaint()`, which repaints Now or Outlook only when on screen and never with focus inside.
- **The card budget is applied to the DOM after a section is drawn, never by a renderer** (`cbApply()`, from
  `navRenderSub()` and a `MutationObserver` on each section). At most `CB_BUDGET` open cards (Today
  `CB_BUDGET_HOME`); the rest move into one fold. Moving keeps every node, so ids and handlers survive. A fold is never
  counted or moved (raw data stays last). **A failure is never folded**: a failure card carries `data-fail`. **A focused
  input is never moved.** `cbApply()` is idempotent (`cbUnwrap()` first).
- **Depth is a per-device pref** (`uiDepth()`, `uiPref('depth')`, never in `S`): Basic is the budget, Intermediate
  `CB_BUDGET_MID`, Advanced none. A card tagged `data-depth` folds below its depth; stage 10 does the tagging.
- **A merged view's later part gets a divider, and the divider is a `::before`.** In a section laid out as a grid it is
  a grid item, so it needs `grid-column:1 / -1` (Flags on Now, `#invest.on.stacked::before`). A section that is a
  grid and moves into a merged view gets the same rule.
- A test of the layout with the switch off calls `orgOff()` / `orgBack()` (a stub on `orgOn()`, which survives `S`
  being replaced).

**Stage 9, Video letter** (`ovOn('videoLetter')`, free; ZULU's lines are `ovOn('videoScript')`, paid, off)
- **The video is six fixed scenes, each a picture the app draws from his data** (`VL_SCENES`, `VL_VISUAL`; the model
  never picks a picture). What a scene shows or says is worked out when it is played, as of that week (`vlNums()`),
  never stored. With no lines from ZULU every scene speaks the app's own line (`VL_TPL`), so the free switch needs no call.
- **Numbers never come from the model.** A line may carry a number only as a token in `VL_TOKENS`, filled by the app
  (`vlFill()`). `vlLineOk()` refuses a digit, a percent, a number word (`VL_NUM_RE`; "one" is allowed), an unknown
  token, a stray brace, or more than `VL_SAY_WORDS` words, and a refused line is replaced by the app's line, never
  repaired. A token the week cannot fill also falls back. A stored line is checked again when read (`vlScript()`).
- **The strength scene is the plateau watch as of that Sunday** (`vlLiftRows()`: `pwAsOf()` plus the watch's clock on
  that day, put back in `finally`). Never a measure of its own. A lift the watch could not read is listed, not counted.
- **ZULU's lines ride the letter call** (`vlPromptPart()`): one call, a `scenes` key beside `letter` (and `plan` with
  the Weekly Review on). With `videoScript` off the letter prompt is byte-identical, whatever the Weekly Review says.
  The lines are checked before the await's result is used (`vlSayClean()`), handed over in `_vlLast` (never a reference
  into `S`), and written after it.
- **`S.letters` (key `j|`) holds one immutable row per letter week**: `{id:<Sunday>, week, at, text, say?}`, text only,
  never media, capped at `VL_KEEP`. `vlIngest()` runs after `wrIngest()` in `agRunAll()`, into the `S` after the await;
  a week that has a row keeps it. A row that fails `vlRowOk()` is ignored. A letter older than the build (only in
  `S.agents.letter`) is still listed and playable (`vlLetters()`).
- **The player is a layer on `<body>`, outside every section** (`#vlPlayer`), so no repaint and no card budget touch
  it. Its state is module-scoped (`vlP`). **Speech starts only from his tap**: the first line is spoken inside the tap
  (iOS). Each scene moves on when its line ends and it has been up `VL_SCENE_MIN_MS`, with a backstop timer, and a stale
  callback (an older `gen`) does nothing. No voice means captions and a timer. Captions are always on.
- Where it lives: a Play row in the Inbox (`vl:`, routine) from the letter's Sunday to `VL_INBOX_DAYS` after, the
  Library's letters with past ones in a fold, and a Play button on the old Agents view's letter. Today gets no card.

**Stage 11, Discord** (no switch of its own: each section follows its stage's switch)
- **Discord is still a window, not a door.** `/ironhub standards`, `desk`, `plan` and `away` read only `discord_view.json`;
  the Worker works none of it out, and `core.js` never reads the raw data file for them. No webhook, no alert, no write.
- **`discordView()` builds each section from the app's own reader** (`dvStandards()` from `stdState()`, `dvDesk()` from
  `deskAnalystCards()`, `watchList()` and `agDeskItems()`, `dvPlan()` from `planScore()` and `planSuggest()`, `dvAway()`
  from `holdBlocks()`), flattened to words: a status travels as the app's word and icon, never a colour's name.
- **A section whose switch is off is `null`**, and the Worker says it is off rather than drawing an empty card. Each is in
  its own `try`, each line is capped (`dvClip()`), and **the size cap runs last**, over the whole file, so it sheds
  charts, never a section, and never the whole file (`DISCORD_VIEW_MAX`).
- The Worker goes live only after `npx wrangler deploy` and `node register-commands.js` from `discord/` (Mark's step).

| Stage | Status |
|---|---|
| 0 Safety rails: switches, moved-clock script, this file trimmed | built 2026-11-11 (`v5a`) |
| 1 Standards: five computed pillars, reasons, plan in motion | built 2026-11-12 (`v5b`) |
| 2 Holds: one block type for trips, sickness and exams, and the trip plan | built 2026-11-12 (`v5c`) |
| 3 Evidence: the cited library, source chips, held off until he checks ten | built 2026-11-12 (`v5d`) |
| 4 Analysts: eight computed analysts, squads, the Hub in four lanes | built 2026-11-12 (`v5e`) |
| 5 Selector: a computed fit score for every lift, swap trials as a third split in force, grounds for a permanent swap | built 2026-11-12 (`v5f`) |
| 6 Desk: analyst cards derived at render, watches measured when read, the Plan of Record stored and shown | built 2026-11-13 (`v5g`) |
| 7 Accountability: a plan scored by the app, the Weekly Review inside the letter call, the Monthly Review behind its own switch | built 2026-11-13 (`v5h`) |
| 8 Organization: one Inbox worked out when read, a card budget per section, Today in five zones, the Hub in five views, a per-device depth | built 2026-11-13 (`v5i`) |
| 9 Video letter: six scenes drawn from his data, numbers only through tokens, played in the app with the phone's voice | built 2026-11-13 (`v5j`) |
| 11 Discord: /ironhub standards, desk, plan and away, read-only from the app's own snapshot | built 2026-11-13 (`v5k`) |
| 10 Reskin | not started |
