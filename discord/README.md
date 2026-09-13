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

**Auto-posts** (checked every 5 min): new PRs, new investigation flags, new proposals, the
daily brief, and a version note whenever a new build ships.

**Cost:** $0. Nothing here calls Claude. Cloudflare's free tier, Discord and GitHub Actions
are all free at this usage.

---

## How it fits together

```
iron_hub.html ── every sync ──► gist: ironhub_data.json  (your data, unchanged)
                             └► gist: discord_view.json  (numbers the app computed: readiness, volume, charts)

Cloudflare Worker (this folder)
  /interactions  ← Discord slash commands   (signature-verified, owner-only)
  every 5 min    → reads the gist, posts anything new to the channel webhook

GitHub Action discord-release.yml → posts a version note when the build marker changes
```

The Discord side is only as fresh as the **last sync from any device**. `status` and `week`
show when the snapshot was taken, and flag it as stale after 12 hours.

---

## One-time setup (~20 minutes)

You need Node installed and a terminal open in this `discord/` folder. Run `npm install`
once first.

### 1. Discord server, channel and webhook
1. Create a **private** server, since anyone who can see the channel can see the auto-posts.
   Add an `#iron-hub` channel.
2. Channel → *Edit Channel* → *Integrations* → *Webhooks* → *New Webhook* → **Copy Webhook URL**.
   This is `DISCORD_WEBHOOK_URL`.
3. Discord *Settings* → *Advanced* → turn on **Developer Mode**.
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
Paste the printed `id` into `wrangler.toml` in place of `PASTE_KV_NAMESPACE_ID_HERE`. Then set
each secret; each command prompts you to paste the value:
```bash
npx wrangler secret put GIST_ID
npx wrangler secret put GIST_TOKEN
npx wrangler secret put DISCORD_APP_ID
npx wrangler secret put DISCORD_PUBLIC_KEY
npx wrangler secret put DISCORD_OWNER_ID
npx wrangler secret put DISCORD_WEBHOOK_URL
npx wrangler deploy
```
Deploy prints a URL like `https://ironhub-discord.<you>.workers.dev`.

### 5. Connect Discord to the Worker
1. In the Developer Portal → *General Information* → **Interactions Endpoint URL**, paste
   `https://ironhub-discord.<you>.workers.dev/interactions` and save. Discord sends a signed
   test request right away, so if the save fails, the public key secret is wrong.
2. Register the command (PowerShell syntax shown):
   ```powershell
   $env:DISCORD_APP_ID="..."; $env:DISCORD_BOT_TOKEN="..."; $env:DISCORD_GUILD_ID="..."; node register-commands.js
   ```

### 6. Version announcements
GitHub repo → *Settings* → *Secrets and variables* → *Actions* → add **`DISCORD_WEBHOOK_URL`**.

### 7. Try it
Open Iron Hub once so it pushes a `discord_view.json`, then run `/ironhub status` in your server.
The first alert check only records what already exists, so you won't get a flood of old PRs.
New posts start from the next change.

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
- **No AI calls.** If a command ever needs a freshly written AI answer, it costs the same as an
  in-app agent chat. Label it as paid, and keep using the deferred reply this handler already sends.
- **One source of truth.** Anything the app computes comes from `discord_view.json`, which the
  app builds with its own functions. Don't re-implement app math here.
