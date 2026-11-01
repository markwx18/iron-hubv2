# Iron Hub clock

The agents run on a server now, so the 9 PM cycle and the morning brief happen whether or not a device is open,
and the brief's **Reload** works on school Wi-Fi. There are three parts:

- **`.github/workflows/agents.yml`** runs `scripts/agents/run.js`. That script loads `index.html` headless and calls
  the app's own `runnerTick()`. The cycle, the brief and their gates are the app's, and the push goes through the
  app's `syncPush()`, which reconciles with the gist first.
- **This Worker** is the alarm clock. GitHub's own cron is too unreliable for this (the WHOOP relay measured a
  3.2-hour median gap), so a Cloudflare cron fires every 30 minutes and dispatches the workflow on the Eastern slots:
  - 9:00, 9:30 and 10:00 PM for the cycle;
  - every half hour from 6:00 to 10:30 AM for the brief, each re-reading WHOOP first.
- **The app** leaves 9 PM to the server for 45 minutes once it has seen the server run (`RUNNER_GRACE_MIN`), then
  steps in itself if nothing ran. Reload dispatches the same workflow in `reload` mode.

A slot with nothing to do (the cycle already ran, the brief is written) costs no API call. The runner exits after one
pull.

## Setup, once

1. **Add the API key to GitHub.** Go to Settings → Secrets and variables → Actions → New repository secret, name it
   `ANTHROPIC_API_KEY`, and paste the same key the app uses. The other secrets it needs (`IRONHUB_GIST_ID`,
   `IRONHUB_GIST_TOKEN`, `IRONHUB_STATE_GIST_ID`, `WHOOP_*`) are the relay's and are already there.
2. **Test the workflow by hand.** Go to Actions → Agents → Run workflow, keep `mode` at `auto`, and run it. The log's
   last line says what it did, for example `mode auto: no brief: waiting for WHOOP…` or
   `tonight's cycle had already run`.
3. **Make a token for the clock.** The clock needs a token that can dispatch workflows on `markwx18/iron-hubv2`:
   - Try a fine-grained token first: only this repository, with **Actions: Read and write**.
   - If GitHub refuses it (the clock's log says `FAILED 403`), use a classic token with the full **`repo`**
     scope. `public_repo` is refused for dispatch, and `workflow` is the wrong scope (see CLAUDE.md, the WHOOP
     relay).
4. **Deploy the clock.**
   ```
   cd clock
   npm install
   npx wrangler secret put GH_TOKEN      # paste the token from step 3
   npx wrangler deploy
   ```
   You can check it in the Cloudflare dashboard: Workers → ironhub-clock → Logs, at the next :00 or :30 that is a
   slot. A dispatched run reads `clock: 21:00 -> dispatched`.

## What it costs

- **Cloudflare:** 48 Worker runs a day, on the free tier.
- **GitHub Actions:** free on a public repo. Each slot is about a minute of a runner.
- **API:** the same cycle and brief the app already paid for, plus a cycle on nights no device was opened. A Reload
  is one brief call. The runner's spend counts toward the monthly cap as its own device. Its usage log is kept in
  the state gist as `runner_local.json`, because the cap rebuilds each device's day from its log.

## Tests

```
node clock/test_worker.js
```

The suite covers the slots across both clock changes, the one request the Worker can make, and the 404 it gives
every HTTP request. `IRONHUB_CLOCK_SRC=/path/to/mutant/src` points it at a mutant copy.
