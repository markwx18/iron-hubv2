# Getting Claude Code running on Iron Hub

One-time setup. After this, the loop is: describe the change → it edits, tests,
and pushes → GitHub Pages redeploys → the app updates on next open.

---

## 1. Install Claude Code

**Windows (PowerShell):**
```powershell
irm https://claude.ai/install.ps1 | iex
```

**macOS / Linux:**
```bash
curl -fsSL https://claude.ai/install.sh | bash
```

The native installer needs no Node.js and auto-updates. WinGet
(`winget install Anthropic.ClaudeCode`) and Homebrew
(`brew install --cask claude-code`) also work if you prefer a package manager.

On first run it opens a browser to log in — use your normal Claude account. That
connects your Pro plan. Claude Code usage shares the same limits as Claude.ai
chat, so there's no separate billing.

Verify:
```bash
claude doctor
```

---

## 2. Get the repo locally

If it isn't cloned yet:
```bash
git clone <your-iron-hub-repo-url>
cd <repo-folder>
```

Confirm `iron_hub.html` is at the root and `git remote -v` points at the repo
GitHub Pages serves from.

---

## 3. Add the project files

Copy into the repo root:

- **`CLAUDE.md`** — read automatically at the start of every session. This is the
  important one; it carries the conventions, the architecture map, and the bug
  patterns worth knowing.
- **`test_agents.js`** — the regression suite (266 assertions).

Install the two dev dependencies the suite needs:
```bash
npm install acorn jsdom
```

That creates `node_modules/` and `package.json`. Add a `.gitignore` with:
```
node_modules/
```
`node_modules` is dev-only — the app itself has no runtime dependencies and must
stay that way.

Confirm it works:
```bash
node test_agents.js
```
Expect `RESULT: 266 passed, 0 failed`.

---

## 4. Start

```bash
claude
```

Then just describe what you want. It reads `CLAUDE.md` automatically.

---

## Useful commands inside Claude Code

| Command | What it does |
|---|---|
| `/init` | Scans the project and drafts a CLAUDE.md (already written — skip) |
| `/login` / `/logout` | Switch accounts |
| `/clear` | Reset context in a long session |
| `claude update` | Update the CLI |

---

## Working notes

**It asks before editing.** You'll see a diff and approve or deny each change.
Read them — especially early on, while you're calibrating how much to trust it.

**Make it run the checks.** Say "run the syntax check and full test suite before
committing." It's in `CLAUDE.md`, but saying it explicitly for the first few
sessions is worth it.

**Watch for the single-file rule.** The strongest instinct a coding agent has on a
7,900-line HTML file is to split it into modules. `CLAUDE.md` says not to, but if
you ever see it proposing new `.js` files or a build step, deny and redirect.

**Keep CLAUDE.md current.** When you land on a new convention — a percentage that
should be tunable, a pattern that caused a bug — add it. It's the memory that
carries between sessions; this chat history doesn't travel with it.

**Deploy is just a push.** No build, no CI. Commit and push to the Pages branch
and the app updates on next launch. Make sure the build marker got bumped.

---

## Split of work

- **Claude.ai chat** — brainstorming, scoping a feature before it's defined,
  fitness/nutrition questions, "should I even build this"
- **Claude Code** — implementing, testing, and shipping something already scoped

Hashing out the design in chat first and handing Code a clear spec generally
works better than trying to think out loud in a terminal.
