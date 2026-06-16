# Build State & Handoff - copilot-control-plane

> Continuation note so any agent/session can resume. Mirrors the design decisions
> and the exact build state. **Status: Level 1 code COMPLETE & type-checks clean; NOT yet built/run.**

## What this project is
A VS Code extension that estimates/optimizes GitHub Copilot usage cost. Headline UX is a
**"Cost Health" badge**: a status-bar score (0–100) + color (🟢 ≥80 / 🟡 ≥50 / 🔴 <50); click
for a drill-down naming each cost culprit. Passive (informs, does not intervene).

Specs: [level-1-investigation.md](level-1-investigation.md) (diagnosis/badge, being built now),
[level-2-remediation.md](level-2-remediation.md) (fixes, next).

## Direction (user-chosen)
- Audience: both, **start individual** (in-IDE).
- Accuracy: **good-enough estimate** (not reconciled-to-cent).
- Posture: **passive** visibility (no auto-intervention).
- L1 headline = "your setup is primed to overspend" (config + environment, ship-now honest);
  `@control` exact metering = opt-in deep mode (later).

## GitHub Copilot billing (as of June 1, 2026) - PER-TOKEN
- Premium-request model is now LEGACY (only leftover annual Pro/Pro+).
- Unit = GitHub AI Credits; **1 credit = $0.01 USD**.
- Cost = model rate × tokens. Token types: input, output, cached (Anthropic adds cache-write).
- Output tokens dominate cost; cached ~10× cheaper than input; long-context tier
  (>272K GPT / >200K Gemini) ~doubles the rate on ALL tokens.
- Code completions / NES NOT billed (unlimited paid). Billed: Chat, CLI, cloud agent, Spaces,
  Spark, 3rd-party agents.
- 10% discount with auto model selection.
- Plans (individual): Pro $10/1,500cr; Pro+ $39/7,000cr; Max $100/20,000cr (base+flex).
  Org: Business 1,900/user, Ent 3,900/user, pooled.
- Rates page: docs.github.com/en/copilot/reference/copilot-billing/models-and-pricing

## VS Code 1.120 API constraints (verified) - CRITICAL
- NO billing/usage/credit-balance/pricing API for extensions. None.
- `LanguageModelChat`: id, name, vendor, family, version, maxInputTokens + countTokens() +
  sendRequest(). NO cost field.
- `LanguageModelChatInformation` (provider-side) adds maxOutputTokens, capabilities. Still NO cost.
- Cannot observe Copilot Chat's NATIVE requests. `registerLanguageModelChatProvider` = provide
  BYOK models, not intercept.
- 1.120 "token usage % context" is built-in Chat UI, NOT an API.
- Feasible: pre-flight token×rate estimate (bundled rate table), own `@chat` participant exact
  metering, countTokens vs maxInputTokens, onDidChangeChatModels.
- Unstable/undocumented: `extensions.getExtension('github.copilot')?.exports`. Don't depend on it.
- Real actuals only via GitHub billing REST API (org-scoped, ~daily delay); later phase.

## Level 1 - files created & verified (get_errors = no errors on all src/)
- **package.json**: manifest. engines vscode ^1.120. main ./dist/extension.js. activation
  onStartupFinished. Commands: `copilotControlPlane.showDetails`, `.refresh`. Settings: plan,
  assumedModel, economyModels, rateOverrides, autoContextSettings. Scripts: compile/watch/package
  (esbuild), check-types (tsc --noEmit).
- **tsconfig.json**: Node16, ES2022, strict, rootDir src, outDir dist, noUnusedLocals/Parameters.
- **esbuild.js**: bundles src/extension.ts → dist/extension.js, external vscode, cjs, node
  platform. flags --production --watch.
- **.vscodeignore**, **.gitignore** (node_modules/dist/*.vsix), **.vscode/launch.json**
  (Run Extension, preLaunchTask compile), **.vscode/tasks.json** (compile default build + watch).
- **src/rates.ts**: `ModelRate{inputPerM,cachedPerM,outputPerM,longCtxThreshold?,longInputPerM?,
  longCachedPerM?,longOutputPerM?,tier}`. RATES table (gpt-5-mini / gpt-5.4 / gpt-5.5 /
  claude-sonnet-4.6 / claude-opus-4.8 / gemini-3.1-pro). DEFAULT_RATE. `resolveRate(model,overrides)`
  exact+substring match. `inputCostUSD(rate,tokens)` threshold-aware.
- **src/score.ts**: `Signals` iface, `computeScore(s)→{score,band,lines}`. Start 100; model top
  −25(small)/−10, mid −10(small)/0; cliff ≥0.9 −18, ≥0.75 −10; tools >10 −10, ≥6 −5; no
  instructions −5; greedyAutoContext −5. Bands green≥80 yellow≥50 red<50. bandLabel, fmtTokens
  helpers. SMALL_TASK_TOKENS=20_000.
- **src/signals.ts**: `gatherSignals()`: selectChatModels({vendor:'copilot'}) (assumedModel pin
  or first), activeContextText (selection or whole doc, cap 2M chars), countTokens
  (model.countTokens, fallback len/4), vscode.lm.tools.length, detectInstructions (findFiles
  .github/copilot-instructions.md + .github/instructions/*.instructions.md), detectAutoContext
  (reads autoContextSettings ids == true). Returns available/reason/signals/modelName/
  maxInputTokens/inputCostUSD.
- **src/badge.ts**: Badge class, StatusBarItem right@100, cmd=showDetails. setUnavailable(reason),
  update(result,display). Tooltip MarkdownString (trusted, theme icons): score/band,
  model+tokens+$, per-line sevIcon+label+detail+delta. sevIcon/deltaTag helpers.
- **src/extension.ts**: activate: Badge + 2 commands + listeners (onDidChangeActiveTextEditor,
  onDidChangeTextEditorSelection, lm.onDidChangeChatModels, onDidChangeConfiguration for
  copilotControlPlane|github.copilot). 300ms debounce. refresh() guarded by refreshing flag.
  showDetails() = QuickPick of score lines + "Open Copilot settings". deactivate clears timer.
- **README.md**: overview, honest-limits, run steps, settings table.
- **.devcontainer/devcontainer.json**: image mcr.microsoft.com/devcontainers/typescript-node:20,
  extensions GitHub.copilot + GitHub.copilot-chat, postCreateCommand npm install, remoteUser node.

## Blocker + resolution
- Host has NO Node.js, NO npm, NO winget/choco/scoop. Cannot build on host.
- Docker Desktop IS running (server 29.5.2, WSL2 Ubuntu-24.04). Dev Containers ext installed
  (ms-vscode-remote.remote-containers 0.459.x). ⇒ **Use the dev container to build.**

## NEXT STEPS (resume here)
1. If not in the container yet: **Dev Containers: Reopen in Container**. First build pulls the
   node:20 image and auto-runs `npm install` (postCreateCommand). If it didn't run: `npm install`.
2. Build: `npm run compile` (esbuild → dist/extension.js). Verify no errors. Optional `npm run check-types`.
3. Test: press **F5** (Run Extension, preLaunchTask compile) → Extension Dev Host. Look for the
   status-bar badge `$(pass-filled) Cost Health 82` (or yellow/red).
4. **AUTH WILDCARD**: Copilot Chat must be signed in INSIDE the container for selectChatModels to
   return models → real score. If not signed in, badge shows the graceful
   `$(circle-slash) Cost Health` unavailable state (by design). Sign in once if prompted.
5. **HYBRID ALT** (if container auth fails): build the bundle in the container, then F5 on the host
   where Copilot is already signed in.
6. First-run things to watch: `vscode.lm.tools` may be empty (toolCount 0 = fine); assumedModel
   empty → uses first copilot model; if `@types/vscode` 1.120 lacks `vscode.lm.tools`, guard/fallback.
   countTokens is async + rate-limited; already wrapped in try/catch.

## After L1 verified - next work
- Level 2 remediation. FIRST verify 2 open APIs: (1) runtime tool enable/disable,
  (2) programmatic live model switch for native chat. See [level-2-remediation.md](level-2-remediation.md).
