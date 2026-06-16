# Copilot Cost Health - Level 2: Remediation

## Goal
Turn each Level-1 diagnosis into a **fix**. Level 1 finds the leak; Level 2 is the "Fix it" button.

## Automation dial
`Suggest` (one-click fix in drill-down) → `Profile` (preset flips many knobs) →
`Guard` (warn/block at threshold) → `Auto` (silent).

**Anchor at Suggest + Profile.** Guard = opt-in. Auto = opt-in only (fights API, annoys).

## Remediation catalog
| Leak | Fix | Lever | Feasibility |
|---|---|---|---|
| History bloat (#1) | Summarize-and-restart / reset nudge | Fewer tokens | `@control` auto ✅ · native nudge-only |
| Tool schema tax | **JIT-MCP**: profiles → gating meta-tool → usage-pruning | Fewer tokens/turn | Profiles ✅ · per-turn auto = verify API |
| Output bloat | **Output-optimizer skill/chatmode**: diff-only, terse | Fewer output tokens (5×) | Config ✅ · measure net |
| Tool-result re-pay | **Lean tool wrappers**: truncate/paginate/summarize | Fewer re-paid input | Own tools, full control ✅ |
| Oversized model | Economy profile / `@control` auto-route | Cheaper rate | Settings ✅ · live native switch = verify |
| Cliff crossing | "Trim to stay under" guard | Cheaper rate (avoid 2×) | Our flow ✅ · native advisory |
| Cache busting | Stable-prefix structuring | Cheaper rate (cache) | Advisory |
| Over-attach | Scope reducer · `.copilotignore` · cap auto-context | Fewer tokens | Settings/command ✅ · native ❌ |

## Headline fixes
- **JIT-MCP**: profiles (one bundle active) → gating meta-tool (one "toolbox" tool reveals
  categories) → prune unused. Biggest per-turn saver.
- **Lean tool wrappers (sleeper hit)**: your `registerTool` tools truncate/summarize outputs
  so agent loops don't re-pay 10K-token dumps every turn. No API fight; you own them.
- **Output-optimizer**: terseness pays (output is 5×), but instructions cost input +
  over-terse causes re-asks → tune for optimal, measure before/after.
- **Economy profile**: flips model + tool set + instructions together in one switch.

## Boundary
Strong where you **own the request** (`@control`, registered tools) or act **ambiently**
(instructions, settings, profiles, `.copilotignore`). Cannot do **native-chat surgery**:
no resetting its history, swapping its live model, or trimming its attachments mid-flight.
Best: nudge + "start a fresh optimized chat" command.

## Open API questions (verify before committing to "auto")
1. Dynamic **tool enable/disable** at runtime (decides JIT-MCP = button vs advice).
2. Programmatic **live model switch** for native chat (decides auto-route feasibility).
