# Iron Hub pantry drop box

A tiny Cloudflare Pages project, at `https://ironhub-pantry.pages.dev`, that lets the family pantry
check's **Submit** button reach the app directly. If it can't be reached, the family page falls back to
texting a reply link back, which is how it worked before.

- It holds **one pantry update per box** (a random id the app makes on the first share) for up to 30 days.
- The app checks the box when it is opened, while a share from the last 28 days is outstanding. An update
  shows as a bell notification and a Today card, and **nothing applies until you tap Apply**.
- It has no secrets and stores nothing else. It is separate from `discord/` on purpose, because that
  Worker must stay read-only.

## Why Pages and not a Worker

Mark's home Xfinity network blocks every `*.workers.dev` address: its security filter answers for the
name and serves an expired certificate. That is the network the family submits from. `*.pages.dev` is not
blocked, so the same code runs as a Pages Function instead. A Pages Function is a Worker underneath, so
nothing in `src/worker.js` changed.

- `src/worker.js`: all the behaviour (`handle()`), which the tests drive directly.
- `functions/box/[[path]].js`: the Pages entry point, which hands every `/box/*` request to `handle()`.
- `public/`: a placeholder page, because Pages needs an output folder.

## Deploying a change

```bash
cd pantry
npx wrangler pages deploy --branch main
```

The KV namespace (`DROPS`) and the project already exist. From scratch, you would run
`npx wrangler kv namespace create DROPS`, put its id in `wrangler.toml`, then
`npx wrangler pages project create ironhub-pantry --production-branch main`.

## Tests

```bash
node pantry/test_worker.js
```

Must be `0 failed`. `IRONHUB_PANTRY_SRC=/path/to/mutant/src` runs the suite against a mutant copy.
