# Copilot Cost Health - Level 1: Investigation & Information

## Goal
A glanceable, near-live **Cost Health badge** (score + color) in the VS Code status bar.
Click → drill-down explaining *why* the current setup/chat is primed to overspend.
Passive: it informs, it does not intervene.

## Cost model
`cost = model_rate × tokens`. Three levers: **fewer tokens**, **cheaper rate**, **less waste**.

Where tokens go in one request: system prompt · tool schemas · **conversation history**
(re-sent every turn, grows ~quadratically) · **attached context** · prompt · **output**
(~5× input rate). The bold three are the leaks.

## Badge UX
```
●  Cost Health 41  ▾     ← color (🟢 80–100  🟡 50–79  🔴 0–49) + score, always visible

(click) ▼
🔴 Cost Health 41/100 - High risk
  ⚠ Model    Opus 4.8 - top price tier        −25
  ⚠ Cliff    181K tokens · 272K cliff close   −18
  ⚠ Tools    14 MCP tools = schema tax        −10
  ⚠ Context  3 large files open (47K)          −6
  ✓ Config   instructions present              +0
  → [Open settings]   (L2 adds one-click fixes)
```

## Score inputs by confidence
| Tier | Signal | Source |
|---|---|---|
| **Measured** ✅ | Selected model + rate; cliff proximity; enabled tool count; default-model / auto-context / instructions config; active editor / selection tokens | `selectChatModels`, `countTokens`, settings, bundled `rates.ts` |
| **Estimated** 🟡 | Likely $/turn; `#codebase` blow-up risk | token count × rate heuristics |
| **Not observable** 🔴 | Native chat history length; live chat-box attachments; native `% context full` | Sealed by API (1.120 indicator is built-in UI) |

## Proposed score formula
Start 100; subtract:
- Model top-tier for small task **−25** / mid **−10**
- Cliff within 90% **−18**, within 75% **−10**
- Tools >10 **−10**, 6–10 **−5**
- No instructions file **−5**
- Greedy auto-context **−5**
- Large attached context (scaled) **−**

Bands: 🟢 80+ · 🟡 50–79 · 🔴 <50.

## Feature tiers
- **S (build):** pre-flight context meter · long-context-cliff warning · model recommender / rate lens.
- **A:** `@control` participant (exact metering: `/cost`, `/analyze`, `/compare`) · tool/MCP budget lens.
- **B (later):** session/daily trend (own-participant exact; org via billing REST API) · cache hints.

## Honest limits
Extension **cannot read native Copilot chat** (history, input box, live context %).
"Live" = live w.r.t. **editor + model + config**, updating on model switch / selection /
file open / settings / tool toggle, **not** keystrokes in the chat box.
Exact live-chat numbers exist **only** for chats routed through `@control`.
VS Code-only (Copilot also runs in JetBrains, VS, Neovim, CLI, github.com).
