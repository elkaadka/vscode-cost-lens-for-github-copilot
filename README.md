<div align="center">

<img src="icon.png" alt="Cost Lens for GitHub Copilot" width="96" height="96" />

# Cost Lens for GitHub Copilot

**Find out what you're actually spending on GitHub Copilot.**

Cost Lens reads Copilot Chat's own request logs to show your *real* per‑token usage and
credit spend across every chat session, then points out concrete, data‑backed ways to spend less.

[Features](#-features) · [How it measures](#-how-it-measures) · [Install](#-install) · [Getting started](#-getting-started) · [Commands](#%EF%B8%8F-commands) · [Settings](#%EF%B8%8F-settings)

</div>

---

## Why

Copilot Cost Lens gives developers a clear, local view of how their own credits and tokens are
spent, per request, per session, per project. The goal is visibility at the developer level: see
which prompts, models, and habits use the most, and adjust how you work to get more out of your
budget.

## Features

### Status‑bar badge
A live badge in the status bar showing your measured Copilot credit usage for the current
workspace, updated as you chat. It's your at‑a‑glance running total, so you don't have to open the
dashboard to know where you stand. Hover it for a
breakdown of the number: total tokens, sessions, cost, requests, AI Units, and the model in use.
Click it to jump straight to the full dashboard.

<p align="center">
  <img src="media/screenshots/badge.png" alt="Status-bar badge showing measured Copilot credit usage" width="320" />
   
</p>

### The dashboard
A dedicated activity‑bar view with three scope tabs:

| Scope | What it shows |
| --- | --- |
| **Global** | Totals across every workspace on this machine, with a per‑project breakdown. |
| **Workspace** | Totals across every chat session in the current project. |
| **Session** | The active chat only, plus ranked cost‑saving tips. |

Each tab is a compact **bento grid** (headline spend, where your tokens go, where your *cost* goes,
cache hit rate, reasoning effort, average spend per prompt, top models, and a 7‑day chart) with
collapsible drill‑downs:

- **Priciest prompts**: your prompts ranked most‑expensive first; click any one for full detail.
- **Cache**: what's in the cached prefix re‑sent every turn (history + tool schemas + system
  prompt), the hit rate, and what the cache saved you.
- **Tools**: which available tools were actually used vs. sitting idle in every request's schema.
- **FAQ**: exactly how each number is derived.

### Priciest‑prompts leaderboard
In agent mode, one thing you type fans out into many billable model calls (each tool‑loop iteration
is its own call). A "prompt" here means a user message **plus every call it triggered**: the honest
"what did this cost me" unit. Ranking is by real billed credits, with a clearly‑labelled token‑price
estimate when the log carries no credits.

Click any prompt for a detail view with everything the logs hold for that turn:

- Headline cost (credits + USD), total tokens, model(s), and time.
- Input / Cached / Output / Reasoning token breakdown.
- The full **prompt text** and the assistant's full **visible reply**.
- The **tools** it invoked, with call counts.
- A **per‑call table**: every model call in the turn with its model, effort, token split, and cost.

> The model's private reasoning text is never logged, so only an estimated reasoning **token count**
> is derivable (billed output minus the visible reply). Prompt and reply text can be hidden with
> `copilotCostLens.redactPromptText`.

### Cost‑saving tips
The Session tab surfaces ranked, data‑backed tips when there's waste to trim (and a calm "no actions"
state when there isn't):

- **Long chat history** re‑sent on every turn → start a fresh chat.
- **Idle tool schemas** riding along in every request → turn off unused tools / MCP servers.
- **Still on high reasoning**: a time‑based nudge that escalates the longer high/x‑high reasoning
  stays selected (the failure mode is forgetting to switch back, not any single call).
- **Pricey model on light work**: a top/mid price‑tier model whose replies are consistently small.
- **Switch to a cheaper model**: an estimate of what you'd save by moving to the cheapest model one
  tier down, anchored to your real billed spend.

## How it measures

When you enable Copilot's token logging, the extension parses
`…/GitHub.copilot-chat/debug-logs/<session>/main.jsonl` (and its sidecar files) to aggregate real
per‑request tokens, cached‑token reuse, GitHub AI Units (AIU), and reasoning effort across **every**
chat session.

- **Cost is anchored to what GitHub bills.** When the log records AI Units, the headline cost is
  `AIU × $0.01` (1 credit = $0.01, fixed by GitHub), which already bakes in cache‑write and the
  auto‑model discount that token math can't see. Per‑segment breakdowns are scaled to sum exactly to
  that billed total. With no AIU recorded, it falls back to a list‑price estimate.
- **Prices come from Copilot's own catalog.** Per‑model rates are read live from the `models.json`
  that ships beside the logs, so they track GitHub's current prices and new models automatically (a
  small bundled table is used only until that catalog is read).
- **Defensive by design.** The log format is an undocumented preview format, so every parser skips
  anything unrecognised and degrades to "can't measure" rather than inventing numbers.
- **Polling, not watching.** Logs are re‑scanned incrementally for reliability across containers,
  remote, and Codespaces, so it stays cheap.

### Environment scope
Logs live wherever the VS Code server runs, so the **Global** tab only ever sees one environment. A
banner makes the boundary clear: inside a dev container the figures cover that container only; in a
local window, work done inside dev containers or WSL2 is recorded separately and isn't shown. With
no folder open, the dashboard opens on Global (Workspace and Session stay reachable and explain they
need an open project).

## Privacy

Everything runs locally. The extension only reads logs Copilot itself writes on your machine and
sends nothing anywhere. Prompt and reply text shown in the leaderboard can be redacted with a single
setting.

## Install

> Requires VS Code `^1.120.0` and GitHub Copilot Chat (signed in).

**From source:**

```sh
npm install
npm run compile
```

Press **F5** to launch an Extension Development Host with the extension loaded.

**As a VSIX:**

```sh
npm run package:vsix
```

…then install the generated `.vsix` via **Extensions: Install from VSIX…**.

## Getting started

1. Open the **Copilot Cost Lens** view from the activity bar.
2. Click **Enable token logging** (or set `github.copilot.chat.agentDebugLog.fileLogging.enabled`)
   and reload the window.
3. Send a Copilot chat message: the dashboard and status‑bar badge populate with measured cost.

## Commands

| Command | Purpose |
| --- | --- |
| **Copilot Cost Lens: Show Cost Details** | Focus the dashboard |
| **Copilot Cost Lens: Refresh** | Re‑scan logs and recompute |
| **Copilot Cost Lens: Enable Copilot Token Logging** | Turn on the logs needed to measure cost |
| **Copilot Cost Lens: Reset Session Meter** | Clear the current session's running meter |

## ⚙️ Settings

| Setting | Default | Purpose |
| --- | --- | --- |
| `copilotCostLens.economyModels` | `gpt-5-mini`, `gpt-4o-mini`, `o4-mini` | Model ids/families treated as low‑cost |
| `copilotCostLens.reasoningNudgeMinutes` | `10` | Minutes on high reasoning before the tip turns amber |
| `copilotCostLens.reasoningUrgentMinutes` | `30` | Minutes on high reasoning before the tip turns red |
| `copilotCostLens.modelTipMinCredits` | `5` | Minimum credits on a price tier before the pricey‑model tip appears |
| `copilotCostLens.lightOutputTokens` | `300` | Average reply size below which work counts as "lightweight" |
| `copilotCostLens.redactPromptText` | `false` | Hide prompt/reply text in the leaderboard and detail view |

## 🧰 Development

```sh
npm run watch        # rebuild on change
npm run check-types  # type-check without emitting
npm run package      # production build
```

## 📄 License

MIT

## Disclaimer

Not affiliated with, endorsed by, or sponsored by GitHub or Microsoft. "GitHub" and "Copilot" are
trademarks of their respective owners. This is an independent tool that reads logs GitHub Copilot
writes locally on your machine.
