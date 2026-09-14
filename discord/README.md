# Iron Hub × Discord

A **read-only** Discord view of Iron Hub: `/ironhub` slash commands plus automatic posts.
Discord can look at your data. It can never change it. Approving proposals and every other
change still happens in the app.

| | |
|---|---|
| `/ironhub status` | Recovery, streak, today, the next 7 days, pending proposals, today's brief |
| `/ironhub chart exercise:` | e1RM trend chart as a PNG image (best set per week, last 26 weeks) |
| `/ironhub week` | Weekly volume by muscle group, this week vs last week |
| `/ironhub proposals` | Pending agent proposals (view only) |
| `/ironhub pr [count]` | Recent PRs |
| `/ironhub log agent: [count]` | Full, untrimmed agent reasoning |
| `/ironhub compare session: scope: [exercise:]` | A past session vs the most recent matching one |

**Cost:** $0. Nothing here calls Claude. Cloudflare's free tier, Discord and GitHub Actions
are all free at this usage.

---

## The channels

Five channels, each with one job. **Four of them get a webhook, and each webhook goes in exactly
one place.** This table is the part that's easiest to mix up, so come back to it while setting up.

| Channel | What lands there | Posted by | Webhook? | Where the webhook URL goes |
|---|---|---|---|---|
| `#commands` | Replies to your `/ironhub …` commands | Discord itself, as replies | **No** | Nowhere. Command replies appear in whatever channel you type in. |
| `#prs` | 🏆 New PRs | Worker, checked every 5 min | Yes | Worker secret **`WEBHOOK_PRS`** |
| `#alerts` | 🔎 New investigation flags · 📋 new agent proposals | Worker, checked every 5 min | Yes | Worker secret **`WEBHOOK_ALERTS`** |
| `#daily-brief` | ☀️ The morning brief | Worker, checked every 5 min | Yes | Worker secret **`WEBHOOK_BRIEF`** |
| `#releases` | 🚀 A note when a new app build ships | GitHub Action | Yes | GitHub repo secret **`DISCORD_RELEASES_WEBHOOK_URL`** |

Things that trip people up:
- **A webhook URL belongs to the channel it was created in.** If you paste the `#prs` URL into
  `WEBHOOK_ALERTS`, flags will show up in `#prs`. Create each webhook *inside* its own channel,
  and name it after the channel so you can tell them apart.
- **`#releases` is the odd one out.** Its webhook goes into **GitHub**, not Cloudflare. The Worker
  never posts releases, and GitHub never posts PRs.
- **`#commands` gets no webhook.** Command replies don't use one.
- **A channel with no webhook is simply off.** Nothing is posted there, and nothing piles up
  waiting. If you add the webhook later, it starts with the *next* new item, not with everything
  you missed.
- **Treat webhook URLs like passwords.** Anyone who has one can post into that channel. They live
  only in secrets, never in a file in this repo.

---

## How it fits together

```
iron_hub.html ── every sync ──► gist: ironhub_data.json  (your data, unchanged)
                             └► gist: discord_view.json  (numbers the app computed: readiness, volume, charts)

Cloudflare Worker (this folder)
  /interactions  ← /ironhub commands from #commands   (signature-verified, owner-only)
  every 5 min    → reads the gist → WEBHOOK_PRS → #prs
                                  → WEBHOOK_ALERTS → #alerts
                                  → WEBHOOK_BRIEF → #daily-brief

GitHub Action discord-release.yml → DISCORD_RELEASES_WEBHOOK_URL → #releases
                                    (only when the build marker changes)
```

The Discord side is only as fresh as the **last sync from any device**. `status` and `week`
show when the snapshot was taken, and flag it as stale after 12 hours.

Each alert channel keeps its own record of what it has already posted. If `#alerts` fails to post,
the next check retries `#alerts` only, so `#prs` never gets a duplicate.

---

## One-time setup (~25 minutes)

You need Node installed and a terminal open in this `discord/` folder. Run `npm install`
once first.

Keep a scratch note open while you go. You'll collect values in steps 1–3 and paste them in
steps 4–6. Here's the full list, so you can tick them off:

```
DISCORD_OWNER_ID       step 1   (your user ID)
DISCORD_GUILD_ID       step 1   (server ID; only used by register-commands.js)
WEBHOOK_PRS            step 1   (#prs webhook URL)
WEBHOOK_ALERTS         step 1   (#alerts webhook URL)
WEBHOOK_BRIEF          step 1   (#daily-brief webhook URL)
DISCORD_RELEASES_WEBHOOK_URL  step 1   (#releases webhook URL; goes to GitHub, not Cloudflare)
DISCORD_APP_ID         step 2
DISCORD_PUBLIC_KEY     step 2
DISCORD_BOT_TOKEN      step 2   (only used by register-commands.js; never goes in the Worker)
GIST_ID                step 3
GIST_TOKEN             step 3
```

### 1. Discord server, channels and webhooks
1. Create a **private** server. Anyone who can see these channels can see your training data.
2. Create five text channels: `#commands`, `#prs`, `#alerts`, `#daily-brief`, `#releases`.
   A category such as "IRON HUB" keeps them together.
3. Make **four** webhooks, one per channel, created *inside* that channel. `#commands` doesn't get one.
   For each of `#prs`, `#alerts`, `#daily-brief` and `#releases`:
   - Hover the channel → ⚙️ *Edit Channel* → *Integrations* → *Webhooks* → **New Webhook**
   - Name the webhook after its channel (e.g. "prs"). The name is just a label, but it's how
     you'll tell the URLs apart later.
   - **Copy Webhook URL** → paste it into your note next to the matching name:

   | Webhook made in | Note it as |
   |---|---|
   | `#prs` | `WEBHOOK_PRS` |
   | `#alerts` | `WEBHOOK_ALERTS` |
   | `#daily-brief` | `WEBHOOK_BRIEF` |
   | `#releases` | `DISCORD_RELEASES_WEBHOOK_URL` |

4. Discord *Settings* → *Advanced* → turn on **Developer Mode**.
   - Right-click your own name → **Copy User ID**. This is `DISCORD_OWNER_ID`.
   - Right-click the server icon → **Copy Server ID**. This is `DISCORD_GUILD_ID`.

### 2. Discord application
1. Go to https://discord.com/developers/applications → **New Application** ("Iron Hub").
2. On *General Information*, copy the **Application ID** (`DISCORD_APP_ID`) and the
   **Public Key** (`DISCORD_PUBLIC_KEY`).
3. On *Bot*, click **Reset Token** and copy it (`DISCORD_BOT_TOKEN`). You only use it once, in
   step 5, on your own machine. Don't put it in the Worker.
4. On *Installation*, set Guild Install scopes to `applications.commands`. Open the install link
   and add the app to your server.

### 3. A GitHub token for the Worker
Create a **classic** token at https://github.com/settings/tokens with **only the `gist`
scope** and an expiry you'll remember. `GIST_ID` is the id of your existing Iron Hub sync
gist, the same value as the WHOOP relay's `IRONHUB_GIST_ID`.

> The `gist` scope technically allows writes. The Worker only ever sends GET requests to
> GitHub, and `test_worker.js` fails if any code path doesn't.

### 4. Cloudflare Worker
```bash
npx wrangler login
npx wrangler kv namespace create ALERTS
```
Paste the printed `id` into `wrangler.toml` in place of `PASTE_KV_NAMESPACE_ID_HERE`.

Then set the **8** Worker secrets. Each command prompts you to paste a value. Paste the one
the command names, and double-check the three webhook ones against your note:
```bash
npx wrangler secret put GIST_ID
npx wrangler secret put GIST_TOKEN
npx wrangler secret put DISCORD_APP_ID
npx wrangler secret put DISCORD_PUBLIC_KEY
npx wrangler secret put DISCORD_OWNER_ID
npx wrangler secret put WEBHOOK_PRS
npx wrangler secret put WEBHOOK_ALERTS
npx wrangler secret put WEBHOOK_BRIEF
```
Check the list before deploying. It should show exactly those 8 names, and
`DISCORD_RELEASES_WEBHOOK_URL` should **not** be among them:
```bash
npx wrangler secret list
npx wrangler deploy
```
Deploy prints a URL like `https://ironhub-discord.<you>.workers.dev`. If you mistyped a
secret, `npx wrangler secret put` the same name again to overwrite it. A secret change takes
effect without redeploying.

### 5. Connect Discord to the Worker
1. In the Developer Portal → *General Information* → **Interactions Endpoint URL**, paste
   `https://ironhub-discord.<you>.workers.dev/interactions` and save. Discord sends a signed
   test request right away, so if the save fails, the public key secret is wrong.
2. Register the command (PowerShell syntax shown):
   ```powershell
   $env:DISCORD_APP_ID="..."; $env:DISCORD_BOT_TOKEN="..."; $env:DISCORD_GUILD_ID="..."; node register-commands.js
   ```
3. Optional, to keep commands in `#commands`: *Server Settings* → *Integrations* → *Iron Hub* →
   under **Channels**, turn off *All Channels* and add `#commands`. This only tidies things up.
   Replies always land in the channel you typed in, and Discord may still let a server owner run
   the command elsewhere.

### 6. Release announcements (GitHub, not Cloudflare)
GitHub → the `iron-hubv2` repo → *Settings* → *Secrets and variables* → *Actions* →
**New repository secret** → name **`DISCORD_RELEASES_WEBHOOK_URL`**, value = the `#releases`
webhook URL.

### 7. Check each channel is wired to the right place
1. Open Iron Hub once so it pushes a `discord_view.json`.
2. In `#commands`, run `/ironhub status`. The reply should appear in `#commands`.
3. The first alert check (within 5 minutes of deploying) only *records* what already exists, and
   posts nothing. So old PRs won't flood `#prs`.
4. From then on, each new item goes to its channel. You'll see the next PR in `#prs`, the next
   flag or proposal in `#alerts`, tomorrow's brief in `#daily-brief`, and the next build note in
   `#releases`.
5. **If something lands in the wrong channel**, the webhook URL in that secret was made in the
   wrong channel. Re-copy it from the right channel and run `npx wrangler secret put` again (or
   update the GitHub secret, for releases).
6. **If a channel stays silent when it shouldn't**, run `npx wrangler tail` and wait for the
   next 5-minute check. A failed post logs `alert post failed for <channel>: …` with Discord's
   reason. A webhook deleted in Discord shows up as a 404.

---

## Development

```bash
node test_worker.js        # must be 0 failed
npx wrangler dev           # local endpoint (use a tunnel if Discord needs to reach it)
npx wrangler tail          # live logs from the deployed Worker
```

To test a mutant, copy `src/` somewhere, break one thing, and point the suite at the copy:
`IRONHUB_DISCORD_SRC=/path/to/copy node test_worker.js`. The suite must go red.

**Rules that must stay true:**
- **Read-only.** No request to GitHub other than GET. No command changes Iron Hub state, ever.
- **Owner-only.** Every interaction is signature-verified, then checked against `DISCORD_OWNER_ID`.
- **One channel, one job.** Routing is `CHANNEL_ENV` in `src/app.js` together with
  `ALERT_CHANNELS` in `src/core.js`. Each channel advances only its own part of the record of
  what's been posted.
- **No AI calls.** If a command ever needs a freshly written AI answer, it costs the same as an
  in-app agent chat. Label it as paid, and keep using the deferred reply this handler already sends.
- **One source of truth.** Anything the app computes comes from `discord_view.json`, which the
  app builds with its own functions. Don't re-implement app math here.
