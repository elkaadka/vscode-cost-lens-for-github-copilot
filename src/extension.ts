import * as vscode from 'vscode';
import { Badge } from './badge';
import { assess, type Band, bandWord, fmtTokens, fmtUSD } from './score';
import { gatherSignals } from './signals';
import { type MeasuredView, type MixSeg, type ModelRow, type PanelTip, type WeekChart, type WeekDay, type WeekSegment, type BudgetView, type SpendChart, type SpendPoint } from './panel';
import { type CacheMeasured, type CacheRow, type SessionCacheView } from './cache';
import { DashboardViewProvider, type ScopePayload, type SetupPayload } from './dashboard';
import { scanGlobalTotals, workspaceStorageBase, type GlobalTotals } from './global';
import { type ToolRow, type ToolsMeasured } from './tools';
import { type PromptCallRow, type PromptDetailView, type PromptRow, type TopPromptsMeasured } from './prompts';
import { detectAntiPatterns } from './antipatterns';
import { chatContextBus, sessionMeter } from './meter';
import { type Capabilities, detectCapabilities, enableTokenLogging } from './capabilities';
import {
  type DayUsage,
  loadPromptDetail,
  type ModelUsage,
  type PromptTurn,
  type SessionCache,
  type ToolGroup,
  type UsageTotals,
  WorkspaceUsageReader,
} from './usagelog';
import { cachedCostUSD, inputCostUSD, type ModelRate, outputCostUSD, resolveRate, suggestableRates } from './rates';
import { ext } from './extensionVariables';
import { initOutputChannel, logInfo, registerCommand } from './log';
const SHOW_DETAILS_CMD = 'copilotControlPlane.showDetails';
const REFRESH_CMD = 'copilotControlPlane.refresh';
const RESET_SESSION_CMD = 'copilotControlPlane.resetSession';
const ENABLE_LOGGING_CMD = 'copilotControlPlane.enableLogging';
const DEBOUNCE_MS = 300;
/** GitHub AI Credit → USD. Fixed by GitHub: 1 credit = $0.01. */
const CREDIT_USD = 0.01;
/** Tip thresholds (tokens). Conversation history and idle tool schemas are the two biggest
 * controllable wastes; surface them only once they're large enough to be worth acting on. */
const HISTORY_WARN_TOKENS = 75_000;
const HISTORY_BAD_TOKENS = 250_000;
const IDLE_TOOL_MIN_TOKENS = 5_000;
/** Model price tiers by output price (credits per 1M tokens), from models.json.
 * top ≥ 2500 (Opus/GPT-5.5), mid ≥ 1000 (Sonnet/GPT-5.4/Gemini Pro), below = economy. */
const TOP_TIER_OUTPUT_PRICE = 2_500;
const MID_TIER_OUTPUT_PRICE = 1_000;

export function activate(context: vscode.ExtensionContext): void {
  ext.context = context;
  ext.output = initOutputChannel();
  logInfo('Cost Lens is starting');
  ext.badge = new Badge(SHOW_DETAILS_CMD);
  ext.dashboard = new DashboardViewProvider(
    context.extensionUri,
    async () => {
      const totals = await scanGlobalTotals(workspaceStorageBase(context));
      totals.spendChart = buildGlobalSpendChart(totals);
      return totals;
    },
    (id) => buildPromptDetailView(id),
  );

  context.subscriptions.push(
    ext.output,
    ext.badge,
    sessionMeter,
    chatContextBus,
    vscode.window.registerWebviewViewProvider(DashboardViewProvider.viewType, ext.dashboard, {
      webviewOptions: { retainContextWhenHidden: true },
    }),
    registerCommand(SHOW_DETAILS_CMD, showDetails),
    registerCommand(REFRESH_CMD, () => refreshAll()),
    registerCommand(RESET_SESSION_CMD, () => sessionMeter.reset()),
    registerCommand(ENABLE_LOGGING_CMD, () => enableLogging()),
    vscode.window.onDidChangeActiveTextEditor(schedule),
    vscode.window.onDidChangeTextEditorSelection(schedule),
    vscode.workspace.onDidChangeTextDocument((e) => {
      const uri = e.document.uri.toString();
      const shown =
        vscode.window.activeTextEditor?.document.uri.toString() === uri ||
        vscode.window.visibleTextEditors.some((ed) => ed.document.uri.toString() === uri);
      if (shown) {
        schedule();
      }
    }),
    vscode.lm.onDidChangeChatModels(() => {
      schedule();
      void refreshCapabilities();
    }),
    vscode.workspace.onDidChangeConfiguration((e) => {
      if (
        e.affectsConfiguration('copilotCostLens') ||
        e.affectsConfiguration('github.copilot')
      ) {
        schedule();
      }
      if (e.affectsConfiguration('github.copilot')) {
        void refreshCapabilities();
      }
    }),
  );

  void refreshAll();
}

export function deactivate(): void {
  if (ext.debounce) {
    clearTimeout(ext.debounce);
  }
  ext.usageReader?.dispose();
  ext.usageReader = undefined;
}

function schedule(): void {
  if (ext.debounce) {
    clearTimeout(ext.debounce);
  }
  ext.debounce = setTimeout(() => void refresh(), DEBOUNCE_MS);
}

async function refreshAll(): Promise<void> {
  await Promise.all([refresh(), refreshCapabilities()]);
  if (ext.usageReader) {
    await ext.usageReader.refresh();
  }
}

/** Editor-derived estimate → status-bar badge only. The panel shows measured cost. */
async function refresh(): Promise<void> {
  if (ext.refreshing) {
    ext.pendingRefresh = true;
    return;
  }
  ext.refreshing = true;
  try {
    const gathered = await gatherSignals();
    if (!gathered.available) {
      ext.lastResult = undefined;
      return;
    }
    ext.lastResult = assess(gathered.signals);
  } finally {
    ext.refreshing = false;
    if (ext.pendingRefresh) {
      ext.pendingRefresh = false;
      void refresh();
    }
  }
}

/** Build the dashboard's onboarding payload from the current capability level. */
function buildSetupPayload(caps: Capabilities): SetupPayload {
  if (caps.level === 'none') {
    return {
      canEnable: false,
      blocking: true,
      title: 'Connect Copilot to measure cost',
      body: 'GitHub Copilot Chat isn’t available. Install it and sign in, then reopen this panel.',
    };
  }
  if (!caps.loggingSettingEnabled) {
    return {
      canEnable: true,
      blocking: true,
      title: 'Turn on real cost measurement',
      body: 'Cost Lens reads Copilot’s own token logs to show exact cost. Enable token logging, then reload the window.',
    };
  }
  return {
    canEnable: false,
    blocking: false,
    title: 'Almost there',
    body: caps.reason,
  };
}

/** Detect what we can measure and (re)wire the live usage reader for `full` mode. */
async function refreshCapabilities(): Promise<void> {
  if (!ext.context || ext.capsBusy) {
    return;
  }
  ext.capsBusy = true;
  try {
    const caps = await detectCapabilities(ext.context);
    // No folder/workspace open: the Workspace and Session scopes need an open project, but the
    // Global tab scans every workspace's logs on disk and works regardless. Show the dashboard
    // with Global active and the other two tabs disabled, instead of a full-screen setup block.
    const noWorkspace = !vscode.workspace.workspaceFolders?.length;
    if (noWorkspace) {
      ext.dashboard.setCapability(false, null, true);
    } else {
      ext.dashboard.setCapability(
        caps.level === 'full',
        caps.level === 'full' ? null : buildSetupPayload(caps),
        false,
      );
    }
    if (caps.level === 'full' && caps.debugLogsDir) {
      if (!ext.usageReader || ext.usageReaderDir !== caps.debugLogsDir) {
        ext.usageReader?.dispose();
        ext.usageReaderDir = caps.debugLogsDir;
        const reader = new WorkspaceUsageReader(caps.debugLogsDir);
        ext.usageReader = reader;
        reader.onDidChange((totals) => {
          const measured = buildMeasured(totals, 'workspace');
          const wsScope: ScopePayload = {
            measured,
            cache: buildCache(totals) ?? null,
            tools: buildTools(totals) ?? null,
            prompts: buildTopPrompts(totals) ?? null,
            antiPatterns: detectAntiPatterns(totals.promptTurns ?? []),
          };
          const sessionTotals = reader.activeSessionTotals;
          const sessScope: ScopePayload = {
            measured: buildMeasured(sessionTotals, 'session'),
            cache: buildCache(sessionTotals) ?? null,
            tools: buildTools(sessionTotals) ?? null,
            prompts: buildTopPrompts(sessionTotals) ?? null,
            antiPatterns: detectAntiPatterns(sessionTotals.promptTurns ?? []),
          };
          ext.dashboard.setScopes(wsScope, sessScope);
          ext.badge.setMeasured(measured);
        });
        reader.start();
      }
    } else {
      ext.usageReader?.dispose();
      ext.usageReader = undefined;
      ext.usageReaderDir = undefined;
      ext.badge.setUnavailable('Enable Copilot logging to measure usage');
    }
  } finally {
    ext.capsBusy = false;
  }
}

/** Turn measured token totals (across all sessions) into the panel's tokens-first view.
 * Exported so headless tooling (test/report.cjs, test/render-html.cjs) renders the exact same
 * view the extension does, with no duplicated math. */
export function buildMeasured(t: UsageTotals, scope: 'workspace' | 'session' = 'workspace'): MeasuredView {
  const topModel = t.models[0] ?? 'unknown';
  const rate = resolveRate({ id: topModel, family: topModel });
  // cachedTokens are a subset of inputTokens; charge only the non-cached remainder at the
  // full input rate and the cached portion at the (much cheaper) cached rate.
  const freshInput = Math.max(0, t.inputTokens - t.cachedTokens);
  const visibleOutput = Math.max(0, t.outputTokens - t.reasoningTokens);
  // Cost split by destination. Cached input bills at its own (much lower) rate; output costs are
  // linear in token count at a fixed context size, so reply + reasoning sum to total output cost.
  const freshInputCost = inputCostUSD(rate, freshInput);
  const cachedCost = cachedCostUSD(rate, t.cachedTokens, t.inputTokens);
  const replyCost = outputCostUSD(rate, visibleOutput, t.inputTokens);
  const reasoningCost = outputCostUSD(rate, t.reasoningTokens, t.inputTokens);
  const cost = freshInputCost + cachedCost + replyCost + reasoningCost;
  // Headline + cost-mix dollars are anchored to the *billed* credit total (AIU × $0.01) whenever
  // the log records it: that's the metered figure GitHub actually charges and already bakes in
  // costs our token math can't see (Anthropic cache-write, the Auto-model discount). The
  // token-derived `cost` is kept only to shape the breakdown; each segment is scaled by `k` so
  // the four parts sum exactly to the billed total (Option A). With no AIU we fall back fully to
  // the token estimate.
  const billedCost = t.aiu > 0 ? t.aiu * CREDIT_USD : cost;
  const k = t.aiu > 0 && cost > 0 ? billedCost / cost : 1;
  const dFreshCost = freshInputCost * k;
  const dCachedCost = cachedCost * k;
  const dReplyCost = replyCost * k;
  const dReasoningCost = reasoningCost * k;
  const creditsFmt = t.aiu >= 100 ? Math.round(t.aiu).toLocaleString('en-US') : t.aiu.toFixed(1);
  const costNote = t.aiu > 0 ? `≈ ${creditsFmt} credits` : '≈ at list prices';
  const totalTokens = t.inputTokens + t.outputTokens;
  const band: Band = rate.tier === 'top' ? 'red' : rate.tier === 'mid' ? 'yellow' : 'green';

  const colorMap = buildColorMap(t.modelUsage);
  const topModels = buildTopModels(t, colorMap);
  const week = buildWeek(t.daily, colorMap);
  const costByModel = buildCostByModel(t, colorMap);
  const budget = buildBudget(t, billedCost, scope);
  const spendChart = buildSpendChart(t, billedCost);

  // Composition bars share four non-overlapping buckets that sum to the whole:
  //   Input (fresh) + Cached + Reply (visible output) + Reasoning.
  // These render whatever totals `t` carries: the workspace Cost Explorer passes workspace totals,
  // the session Cost Explorer passes the active session's totals. Same code, different scope.
  const sFresh = freshInput;
  const sCached = t.cachedTokens;
  const sVisible = visibleOutput;
  const sReasoning = t.reasoningTokens;
  const sdFreshCost = dFreshCost;
  const sdCachedCost = dCachedCost;
  const sdReplyCost = dReplyCost;
  const sdReasoningCost = dReasoningCost;
  const sBilled = billedCost;
  const grandTotal = t.inputTokens + t.outputTokens;
  const pctOf = (n: number, whole: number): number => (whole > 0 ? (n / whole) * 100 : 0);
  const adaptivePct = (n: number, whole: number): string => {
    const p = pctOf(n, whole);
    if (p <= 0) return '0%';
    if (p >= 10) return `${Math.round(p)}%`;
    if (p >= 1) return `${p.toFixed(1)}%`;
    return `${p.toFixed(2)}%`;
  };
  const INPUT_COLOR = 'var(--accent)'; // blue
  const CACHED_COLOR = 'var(--vscode-charts-yellow, #d7ba7d)'; // amber: distinct from input blue
  const REPLY_COLOR = 'var(--ok)'; // green
  const REASONING_COLOR = 'var(--purple)';
  const tokenMix: MixSeg[] = [
    {
      label: 'Input',
      color: INPUT_COLOR,
      pct: pctOf(sFresh, grandTotal),
      valueFmt: fmtTokens(sFresh),
      pctFmt: adaptivePct(sFresh, grandTotal),
    },
    {
      label: 'Cached',
      color: CACHED_COLOR,
      pct: pctOf(sCached, grandTotal),
      valueFmt: fmtTokens(sCached),
      pctFmt: adaptivePct(sCached, grandTotal),
    },
    {
      label: 'Reply',
      color: REPLY_COLOR,
      pct: pctOf(sVisible, grandTotal),
      valueFmt: fmtTokens(sVisible),
      pctFmt: adaptivePct(sVisible, grandTotal),
    },
    {
      label: 'Reasoning',
      color: REASONING_COLOR,
      pct: pctOf(sReasoning, grandTotal),
      valueFmt: fmtTokens(sReasoning),
      pctFmt: adaptivePct(sReasoning, grandTotal),
    },
  ];
  const costMix: MixSeg[] = [
    {
      label: 'Input',
      color: INPUT_COLOR,
      pct: pctOf(sdFreshCost, sBilled),
      valueFmt: fmtUSD(sdFreshCost),
      pctFmt: adaptivePct(sdFreshCost, sBilled),
    },
    {
      label: 'Cached',
      color: CACHED_COLOR,
      pct: pctOf(sdCachedCost, sBilled),
      valueFmt: fmtUSD(sdCachedCost),
      pctFmt: adaptivePct(sdCachedCost, sBilled),
    },
    {
      label: 'Reply',
      color: REPLY_COLOR,
      pct: pctOf(sdReplyCost, sBilled),
      valueFmt: fmtUSD(sdReplyCost),
      pctFmt: adaptivePct(sdReplyCost, sBilled),
    },
    {
      label: 'Reasoning',
      color: REASONING_COLOR,
      pct: pctOf(sdReasoningCost, sBilled),
      valueFmt: fmtUSD(sdReasoningCost),
      pctFmt: adaptivePct(sdReasoningCost, sBilled),
    },
  ];

  let conclusion: string;
  if (t.requests === 0) {
    conclusion = t.lastAnalyzed
      ? 'No token usage recorded yet in this workspace. Send a Copilot chat message, then Refresh.'
      : 'Analyzing Copilot’s request logs…';
  } else {
    const sessionWord = t.sessions === 1 ? 'session' : 'sessions';
    const modelNote =
      t.models.length > 1 ? `${t.models.length} models, mostly ${topModel}` : topModel;
    const costPhrase =
      t.aiu > 0
        ? `≈ ${fmtUSD(billedCost)} · ${creditsFmt} credits`
        : `≈ ${fmtUSD(billedCost)} at list prices`;
    conclusion =
      `Measured ${fmtTokens(totalTokens)} tokens over ${t.requests} request${t.requests === 1 ? '' : 's'} ` +
      `across ${t.sessions} chat ${sessionWord} (${modelNote}). ${costPhrase}.`;
  }

  // Unit economics: what an average user prompt costs. A "prompt" is one user message plus every
  // billable call its agent tool-loop triggered, so this is the honest per-action figure; the
  // caption also carries the per-request average (always smaller, since a prompt fans out to many).
  const promptCount = t.promptTurns?.length ?? 0;
  const fmtCredits = (n: number): string =>
    n >= 100 ? Math.round(n).toLocaleString('en-US') : n >= 10 ? n.toFixed(1) : n.toFixed(2);
  let avgPerPromptFmt = '-';
  let avgPerPromptCap = '';
  if (t.aiu > 0 && promptCount > 0) {
    const perPrompt = t.aiu / promptCount;
    const perRequest = t.requests > 0 ? t.aiu / t.requests : 0;
    avgPerPromptFmt = `${fmtCredits(perPrompt)} cr`;
    avgPerPromptCap = `≈ ${fmtUSD(perPrompt * CREDIT_USD)} · ${fmtCredits(perRequest)} cr/request`;
  } else if (promptCount > 0 && cost > 0) {
    const perPrompt = billedCost / promptCount;
    const perRequest = t.requests > 0 ? billedCost / t.requests : 0;
    avgPerPromptFmt = fmtUSD(perPrompt);
    avgPerPromptCap = `${fmtUSD(perRequest)}/request · at list prices`;
  }

  return {
    band,
    bandWord: bandWord(band),
    conclusion,
    totalTokensFmt: fmtTokens(totalTokens),
    inTokensFmt: fmtTokens(t.inputTokens),
    outTokensFmt: fmtTokens(t.outputTokens),
    cachedFmt: t.cachedTokens > 0 ? fmtTokens(t.cachedTokens) : '-',
    requests: t.requests,
    sessions: t.sessions,
    aiuFmt: t.aiu > 0 ? t.aiu.toFixed(1) : '-',
    creditsFmt: t.aiu > 0 ? creditsFmt : '-',
    costFmt: fmtUSD(billedCost),
    costNote,
    model: t.models.length > 1 ? `${topModel} +${t.models.length - 1}` : topModel,
    topModels,
    costByModel,
    budget,
    spendChart,
    week,
    tokenMix,
    costMix,
    avgPerPromptFmt,
    avgPerPromptCap,
    scopeLabel: scope === 'session' ? 'this session' : 'workspace',
    lastAnalyzedFmt: formatAgo(t.lastAnalyzed),
    // Tips are all about the current chat (reasoning streak, this session's history + tools), so
    // they only make sense on the Active session panel. The Workspace panel is a cumulative
    // billing view, not an action surface.
    tips: scope === 'session' ? buildTips(t, rate) : [],
    showTips: scope === 'session',
    // A 7-day trend is a workspace concept; on a single session it's noise, so hide it there.
    showWeek: scope !== 'session',
  };
}

/**
 * Compute actionable, data-backed cost tips from the measured breakdown. Pure; no extra log
 * passes. Each tip states an objective figure and a concrete action; none make subjective "too
 * expensive" judgements. Tips are ranked by severity (bad → warn → info) then by estimated saving,
 * so the most pressing nudge sits on top. Empty when nothing applies (the panel shows a calm "no
 * actions" state).
 *
 * The reasoning-effort tip is TIME-based, not cost-based: the failure mode is forgetting to switch
 * back to standard reasoning after a hard problem, which is a function of duration, not dollars. It
 * escalates info → warn → bad as the high-effort streak passes the configured windows.
 */
function buildTips(t: UsageTotals, rate: ModelRate): PanelTip[] {
  const cfg = vscode.workspace.getConfiguration('copilotCostLens');
  const nudgeMin = cfg.get<number>('reasoningNudgeMinutes', 10);
  const urgentMin = cfg.get<number>('reasoningUrgentMinutes', 30);
  const candidates: { rank: number; saving: number; tip: PanelTip }[] = [];
  const rankOf = (tone: PanelTip['tone']): number =>
    tone === 'bad' ? 3 : tone === 'warn' ? 2 : tone === 'info' ? 1 : 0;
  const push = (saving: number, tip: PanelTip): void => {
    candidates.push({ rank: rankOf(tip.tone), saving, tip });
  };

  // High reasoning left on; escalates with how long it's been continuously selected. A single
  // deliberate high call (minutes ≈ 0) stays at the calm "info" tier and never nags; switching down
  // breaks the streak and clears the tip. Only GPT-family + Opus expose effort, so this is silent
  // for Gemini/Sonnet/Haiku. The metric shows estimated reasoning tokens and their cost (≈).
  const streak = t.reasoningStreak;
  if (streak) {
    const mins = Math.round(streak.minutes);
    const reasoningCost = outputCostUSD(rate, streak.reasoningTokens, t.inputTokens);
    const metric = `≈${fmtTokens(streak.reasoningTokens)} · ${fmtUSD(reasoningCost)}`;
    // Label + basis differ for an inferred streak: an adaptive model (e.g. Opus) that doesn't
    // downgrade its effort runs high reasoning by default, vs an explicitly selected high/xhigh.
    const lvl = streak.inferred ? 'high reasoning (default)' : `${streak.effort} reasoning`;
    const basis = streak.inferred
      ? `${streak.model} runs high reasoning by default and the logs show no downgrade.`
      : `${streak.effort} reasoning has been on across ${streak.calls} calls.`;
    if (streak.minutes >= urgentMin) {
      push(reasoningCost, {
        tone: 'bad',
        title: `Still on ${lvl}: ~${mins} min`,
        detail: `${basis} If you're past the hard part, switch to a lighter model or lower reasoning to stop paying the reasoning premium on every turn.`,
        metric,
      });
    } else if (streak.minutes >= nudgeMin) {
      push(reasoningCost, {
        tone: 'warn',
        title: `On ${lvl} for ~${mins} min`,
        detail: `${basis} Worth switching to standard reasoning unless you still need the depth; GitHub suggests higher reasoning only for complex tasks.`,
        metric,
      });
    } else {
      push(reasoningCost, {
        tone: 'info',
        title: `Currently on ${lvl}`,
        detail: `${basis} Fine for hard problems; consider a lighter model or lower reasoning for routine turns.`,
        metric,
      });
    }
  }

  const cb = t.cacheBreakdown;
  if (cb && cb.contextTokens > 0) {
    // Large conversation history re-sent every turn → start a fresh chat. The history rides along
    // on every request (served from cache), so a long-lived chat keeps paying the cached rate for
    // it each turn; a fresh chat drops it.
    if (cb.historyTokens >= HISTORY_WARN_TOKENS) {
      const perTurn = cachedCostUSD(rate, cb.historyTokens, cb.contextTokens);
      push(perTurn, {
        tone: cb.historyTokens >= HISTORY_BAD_TOKENS ? 'bad' : 'warn',
        title: 'Long chat: history rides on every turn',
        detail: `≈${fmtTokens(cb.historyTokens)} of conversation history is re-sent on every request. Start a fresh chat to reset the context and shrink each turn.`,
        metric: `≈${fmtUSD(perTurn)}/turn`,
      });
    }

    // Idle tool schemas → disable unused tools. Every defined tool's JSON schema sits in the
    // cached prefix on every turn, even tools that are never called.
    if (t.toolsBreakdown) {
      const tb = t.toolsBreakdown;
      const idle = new Set(tb.tools.filter((x) => !x.used).map((x) => x.name));
      let idleTokens = 0;
      for (const e of cb.topTools) {
        if (idle.has(e.name)) {
          idleTokens += e.tokens;
        }
      }
      const idleCount = tb.totalCount - tb.usedCount;
      if (idleTokens >= IDLE_TOOL_MIN_TOKENS && idleCount > 0) {
        const perTurn = cachedCostUSD(rate, idleTokens, cb.contextTokens);
        push(perTurn, {
          tone: 'warn',
          title: `${idleCount} unused tools in every request`,
          detail: `Their schemas (~${fmtTokens(idleTokens)}) ride on every turn but are never called. Turn off unused tools or MCP servers to trim the prompt.`,
          metric: `≈${fmtUSD(perTurn)}/turn`,
        });
      }
    }
  }

  // Pricey model on lightweight work. Tier each used model by its output price (from models.json):
  // top (≥2500 credits/1M, Opus/GPT-5.5) and mid (≥1000). Fire when spend on a tier crosses a floor
  // AND the average reply on that tier is small the honest signal of "expensive model for quick
  // answers". A few big-output calls (real deep work) won't trip it. Both gates are configurable.
  const prices = t.modelPrices;
  if (prices && t.modelUsage.length > 0) {
    const minCredits = cfg.get<number>('modelTipMinCredits', 5);
    const lightOutput = cfg.get<number>('lightOutputTokens', 300);
    const tierAgg = (floor: number, ceil: number) => {
      let credits = 0;
      let out = 0;
      let calls = 0;
      const names = new Set<string>();
      for (const mu of t.modelUsage) {
        const price = prices[mu.model.toLowerCase()];
        if (price === undefined || price < floor || price >= ceil) {
          continue;
        }
        credits += mu.aiu;
        out += mu.outputTokens;
        calls += mu.requests;
        names.add(mu.model);
      }
      const avgOut = calls > 0 ? out / calls : 0;
      return { credits, calls, avgOut, names: [...names] };
    };

    const top = tierAgg(TOP_TIER_OUTPUT_PRICE, Infinity);
    const mid = tierAgg(MID_TIER_OUTPUT_PRICE, TOP_TIER_OUTPUT_PRICE);
    // Only one model tip at a time, top tier taking priority.
    if (top.credits >= minCredits && top.calls > 0 && top.avgOut > 0 && top.avgOut < lightOutput) {
      const modelLabel = top.names.length === 1 ? top.names[0] : `${top.names[0]} +${top.names.length - 1}`;
      push(top.credits * CREDIT_USD, {
        tone: 'warn',
        title: 'Top-tier model on light work',
        detail: `${modelLabel} is the priciest tier, but replies here average ≈${Math.round(top.avgOut)} output tokens. For quick edits or questions, a mid or economy model (or Auto) costs much less.`,
        metric: `${fmtUSD(top.credits * CREDIT_USD)} on top tier`,
      });
    } else if (mid.credits >= minCredits && mid.calls > 0 && mid.avgOut > 0 && mid.avgOut < lightOutput) {
      const modelLabel = mid.names.length === 1 ? mid.names[0] : `${mid.names[0]} +${mid.names.length - 1}`;
      push(mid.credits * CREDIT_USD, {
        tone: 'info',
        title: 'Mid-tier model on light work',
        detail: `${modelLabel} replies here average ≈${Math.round(mid.avgOut)} output tokens. Consider an economy model or Auto for routine turns to spend less.`,
        metric: `${fmtUSD(mid.credits * CREDIT_USD)} on mid tier`,
      });
    }
  }

  // Cheaper-model suggestion. Models sit in three tiers (top / mid / economy); when the model
  // you're CURRENTLY on (the most recent request, not the most-used across the session) isn't
  // already economy, estimate what the same work would cost on the models in lower tiers and
  // surface the best few. Keying off the current model means the tip updates the moment you switch,
  // instead of lagging until the new model overtakes the old one by cumulative tokens. The
  // comparison is list-price-on-list-price (every model priced on the identical token mix), then
  // applied as a ratio to the real billed spend, so it stays anchored to actual dollars while being
  // honest that the swap is an estimate.
  const currentModel = t.cacheBreakdown?.model ?? t.models[0];
  const currentRate = currentModel ? resolveRate({ id: currentModel, family: currentModel }) : rate;
  if (currentRate.tier !== 'economy' && t.requests > 0) {
    const freshInput = Math.max(0, t.inputTokens - t.cachedTokens);
    const visibleOutput = Math.max(0, t.outputTokens - t.reasoningTokens);
    const listCost = (r: ModelRate): number =>
      inputCostUSD(r, freshInput) +
      cachedCostUSD(r, t.cachedTokens, t.inputTokens) +
      outputCostUSD(r, visibleOutput, t.inputTokens) +
      outputCostUSD(r, t.reasoningTokens, t.inputTokens);

    const curList = listCost(currentRate);
    const billed = t.aiu > 0 ? t.aiu * CREDIT_USD : curList;
    // Every model in a strictly-lower tier, with its estimated cost + percent saving on this work.
    const tierRank = (tier: ModelRate['tier']): number =>
      tier === 'top' ? 3 : tier === 'mid' ? 2 : 1;
    const alternatives = Object.entries(suggestableRates())
      .filter(([, r]) => tierRank(r.tier) < tierRank(currentRate.tier))
      .map(([name, r]) => {
        const ratio = listCost(r) / (curList || 1);
        return { name, projected: billed * ratio, saving: billed * (1 - ratio), pct: Math.round((1 - ratio) * 100) };
      })
      .filter((a) => a.saving > 0)
      .sort((a, b) => b.saving - a.saving)
      .slice(0, 3);

    if (curList > 0 && alternatives.length > 0) {
      const best = alternatives[0];
      const currentLabel = prettyModel(currentModel ?? 'this model');
      push(best.saving, {
        tone: 'info',
        title: `Switch to a lower‑tier model to save up to ${best.pct}%`,
        detail: `Your ${currentLabel} usage cost ≈${fmtUSD(billed)}. Each model below shows what the same work would cost there instead pick one for routine turns to spend less.`,
        metric: `≈${fmtUSD(best.projected)} on ${prettyModel(best.name)} · ${best.pct}% less`,
        options: alternatives.map((a) => ({
          label: prettyModel(a.name),
          value: `≈${fmtUSD(a.projected)}`,
          badge: `${a.pct}% less`,
        })),
      });
    }
  }

  return candidates.sort((a, b) => b.rank - a.rank || b.saving - a.saving).map((c) => c.tip);
}

/** Prettify a model id for display, e.g. "claude-opus-4.8" → "Claude Opus 4.8", "gpt-5.4" → "GPT-5.4". */
function prettyModel(id: string): string {
  return id
    .split('-')
    .map((w) => (/^gpt$/i.test(w) ? 'GPT' : w.charAt(0).toUpperCase() + w.slice(1)))
    .join(' ')
    .replace('GPT ', 'GPT-');
}

/** Turn the cache prefix breakdown into the Cache section's view (composition + tool/MCP rows). */
function buildCache(t: UsageTotals): CacheMeasured | undefined {
  const list = t.cacheSessions;
  if (!list || list.length === 0) {
    return undefined;
  }
  const sessions = list
    .filter((s) => s.contextTokens > 0)
    .map((s, i) => buildSessionCache(s, i === 0));
  if (sessions.length === 0) {
    return undefined;
  }
  return { sessions };
}

/** Build one session's cache view (composition, tool breakdown, savings) from its {@link SessionCache}. */
function buildSessionCache(
  cb: SessionCache,
  active: boolean,
): SessionCacheView {
  const rate = resolveRate({ id: cb.model, family: cb.model });

  const ctx = cb.contextTokens;
  const pct = (n: number): number => (ctx > 0 ? (n / ctx) * 100 : 0);
  const pctFmt = (n: number): string => {
    const p = pct(n);
    if (p <= 0) return '0%';
    if (p >= 10) return `${Math.round(p)}%`;
    if (p >= 1) return `${p.toFixed(1)}%`;
    return `${p.toFixed(2)}%`;
  };
  const SYSTEM_COLOR = 'var(--yellow)';
  const TOOLS_COLOR = 'var(--purple)';
  const HISTORY_COLOR = 'var(--accent)';
  const composition: CacheRow[] = [
    {
      label: 'History',
      color: HISTORY_COLOR,
      pct: pct(cb.historyTokens),
      tokensFmt: fmtTokens(cb.historyTokens),
      pctFmt: pctFmt(cb.historyTokens),
    },
    {
      label: 'Tool schemas',
      color: TOOLS_COLOR,
      pct: pct(cb.toolsTokens),
      tokensFmt: fmtTokens(cb.toolsTokens),
      pctFmt: pctFmt(cb.toolsTokens),
      note: `${cb.toolCount} tools`,
    },
    {
      label: 'System prompt',
      color: SYSTEM_COLOR,
      pct: pct(cb.systemPromptTokens),
      tokensFmt: fmtTokens(cb.systemPromptTokens),
      pctFmt: pctFmt(cb.systemPromptTokens),
    },
  ];

  // Tool groups colored by share of the tool-schema total (purple shades aren't distinguishable,
  // so reuse the chart palette by rank).
  const toolPalette = [
    'var(--purple)',
    'var(--accent)',
    'var(--yellow)',
    'var(--ok)',
    'var(--bad)',
  ];
  const toolGroups: CacheRow[] = cb.toolGroups.map((g: ToolGroup, i: number) => ({
    label: g.group,
    color: toolPalette[i % toolPalette.length],
    pct: cb.toolsTokens > 0 ? (g.tokens / cb.toolsTokens) * 100 : 0,
    tokensFmt: fmtTokens(g.tokens),
    pctFmt: pctFmt(g.tokens),
    note: `${g.toolCount} tool${g.toolCount === 1 ? '' : 's'}`,
  }));

  // Per-tool breakdown (top 10 by schema size), colored by their group so they read consistently.
  const groupColor = new Map<string, string>();
  cb.toolGroups.forEach((g, i) => groupColor.set(g.group, toolPalette[i % toolPalette.length]));
  const topTools: CacheRow[] = cb.topTools.slice(0, 10).map((tool) => ({
    label: tool.name,
    color: groupColor.get(tool.group) ?? toolPalette[0],
    pct: cb.toolsTokens > 0 ? (tool.tokens / cb.toolsTokens) * 100 : 0,
    tokensFmt: fmtTokens(tool.tokens),
    pctFmt: pctFmt(tool.tokens),
    note: tool.group === '(built-in)' ? undefined : tool.group,
  }));

  // Savings: this session's cached tokens billed at the cheap cache rate vs the full input rate.
  const fullRate = inputCostUSD(rate, cb.sessionCachedTokens);
  const cachedRate = cachedCostUSD(rate, cb.sessionCachedTokens, cb.sessionInputTokens);
  const saved = Math.max(0, fullRate - cachedRate);

  const biggest = composition.reduce((a, b) => (b.pct > a.pct ? b : a));
  const headline =
    `Every turn re-sends a ${fmtTokens(ctx)}-token prefix (${cb.model}); ` +
    `${biggest.label.toLowerCase()} is the largest part at ${biggest.pctFmt}.`;

  const reqWord = cb.requests === 1 ? 'request' : 'requests';
  const shortId = cb.sessionId.slice(0, 8);
  // Prefer the session's human-readable title; fall back to the short id.
  const label = cb.title ?? `Session ${shortId}`;
  return {
    id: shortId,
    title: active ? `${label} · active` : label,
    meta: `${cb.requests} ${reqWord} · last active ${formatAgo(cb.lastTs)}`,
    active,
    hitRateFmt: `${Math.round(cb.hitRatePct)}%`,
    headline,
    contextFmt: fmtTokens(ctx),
    composition,
    toolGroups,
    topTools,
    savedFmt: fmtUSD(saved),
  };
}

/** Turn the tool usage breakdown into the Tools section's view (used vs available). */
function buildTools(t: UsageTotals): ToolsMeasured | undefined {
  const tb = t.toolsBreakdown;
  if (!tb || tb.totalCount === 0) {
    return undefined;
  }
  const usedPct = (tb.usedCount / tb.totalCount) * 100;
  const callWord = tb.totalCalls === 1 ? 'call' : 'calls';
  const headline =
    tb.usedCount === 0
      ? `None of the ${tb.totalCount} available tools have been used yet.`
      : `${tb.usedCount} of ${tb.totalCount} available tools used · ${tb.totalCalls.toLocaleString('en-US')} ${callWord}.`;
  const tools: ToolRow[] = tb.tools.map((tool) => ({
    name: tool.name,
    group: tool.group,
    used: tool.used,
    callsFmt: tool.calls > 0 ? String(tool.calls) : '',
  }));
  return {
    ratioFmt: `${tb.usedCount} / ${tb.totalCount}`,
    usedPct,
    headline,
    totalCallsFmt: tb.totalCalls.toLocaleString('en-US'),
    tools,
    unknownUsed: tb.unknownUsed,
  };
}

/** Shared color palette for the top-models list and the weekly chart legend. The top models by
 * total tokens get a distinct color; everything else is grouped under "other". Values resolve to
 * VS Code chart theme colors with a hard fallback so the webview renders even without the var. */
const CHART_PALETTE = [
  'var(--vscode-charts-blue, #3794ff)',
  'var(--vscode-charts-green, #3fb950)',
  'var(--vscode-charts-orange, #d18616)',
  'var(--vscode-charts-purple, #b180d7)',
  'var(--vscode-charts-red, #f85149)',
];
const OTHER_COLOR = 'rgba(128,128,128,0.6)';
const OTHER_KEY = 'other';

const WEEKDAY = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
const MONTH = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

/** Assign a stable color to each of the top models (by total tokens). Models beyond the palette
 * size aren't mapped here; the chart groups them under "other". */
function buildColorMap(modelUsage: ModelUsage[]): Map<string, string> {
  const map = new Map<string, string>();
  modelUsage.forEach((mu, i) => {
    if (i < CHART_PALETTE.length) {
      map.set(mu.model, CHART_PALETTE[i]);
    }
  });
  return map;
}

/** Per-model cost. Prefer the billed credit figure (AIU × $0.01), ground truth that sidesteps
 * stale or missing rates (e.g. a model absent from the table). Fall back to the cached-aware token
 * estimate only when the log carries no AIU for that model. */
function modelCostUSD(mu: ModelUsage): number {
  if (mu.aiu > 0) {
    return mu.aiu * CREDIT_USD;
  }
  const rate = resolveRate({ id: mu.model, family: mu.model });
  const fresh = Math.max(0, mu.inputTokens - mu.cachedTokens);
  return (
    inputCostUSD(rate, fresh) +
    cachedCostUSD(rate, mu.cachedTokens, mu.inputTokens) +
    outputCostUSD(rate, mu.outputTokens, mu.inputTokens)
  );
}

/** The top 3 models by total tokens, with cost and share of the grand total. */
function buildTopModels(
  t: UsageTotals,
  colorMap: Map<string, string>,
): ModelRow[] {
  const grand = t.inputTokens + t.outputTokens;
  return t.modelUsage.slice(0, 3).map((mu) => ({
    model: mu.model,
    color: colorMap.get(mu.model) ?? OTHER_COLOR,
    totalTokensFmt: fmtTokens(mu.totalTokens),
    costFmt: fmtUSD(modelCostUSD(mu)),
    requests: mu.requests,
    sharePct: grand > 0 ? Math.round((mu.totalTokens / grand) * 100) : 0,
  }));
}

function localDayKey(d: Date): string {
  const y = d.getFullYear();
  const m = `${d.getMonth() + 1}`.padStart(2, '0');
  const day = `${d.getDate()}`.padStart(2, '0');
  return `${y}-${m}-${day}`;
}

/** Cost split per model (top 5 by tokens + an aggregated "other"), as donut-ready segments that
 * sum to the workspace total cost. Each model is priced with the same billed-credit-first logic as
 * the top-models list, so the donut and the list agree. */
function buildCostByModel(t: UsageTotals, colorMap: Map<string, string>): MixSeg[] {
  if (!t.modelUsage.length) {
    return [];
  }
  const priced = t.modelUsage.map((mu) => ({ mu, cost: modelCostUSD(mu) }));
  const total = priced.reduce((s, p) => s + p.cost, 0);
  const pct = (n: number): number => (total > 0 ? (n / total) * 100 : 0);
  const adaptivePct = (n: number): string => {
    const p = pct(n);
    if (p <= 0) return '0%';
    if (p >= 10) return `${Math.round(p)}%`;
    if (p >= 1) return `${p.toFixed(1)}%`;
    return `${p.toFixed(2)}%`;
  };
  const segs: MixSeg[] = priced.slice(0, 5).map(({ mu, cost }) => ({
    label: mu.model,
    color: colorMap.get(mu.model) ?? OTHER_COLOR,
    pct: pct(cost),
    valueFmt: fmtUSD(cost),
    pctFmt: adaptivePct(cost),
    note: `${mu.requests.toLocaleString('en-US')}\u00D7`,
  }));
  const otherCost = priced.slice(5).reduce((s, p) => s + p.cost, 0);
  if (otherCost > 0) {
    const otherReq = priced.slice(5).reduce((s, p) => s + p.mu.requests, 0);
    segs.push({
      label: 'other',
      color: OTHER_COLOR,
      pct: pct(otherCost),
      valueFmt: fmtUSD(otherCost),
      pctFmt: adaptivePct(otherCost),
      note: `${otherReq.toLocaleString('en-US')}\u00D7`,
    });
  }
  return segs;
}

/** Format a credit count with thousands separators (e.g. "1,287"); "-" when there's no credit data. */
function fmtCreditsFull(n: number): string {
  return n > 0 ? Math.round(n).toLocaleString('en-US') : '-';
}

/** A disabled budget stub for scopes (session) where a month-level forecast is meaningless. */
function emptyBudget(): BudgetView {
  return {
    hasForecast: false,
    monthLabel: '',
    monthSpendFmt: '$0.00',
    monthCreditsFmt: '-',
    projectedSpendFmt: '$0.00',
    projectedNote: '',
    paceNote: '',
  };
}

/**
 * Shared month-to-date pace, used by both the Forecast cell and the Spend-over-time chart so they
 * never disagree. Apportions the all-time billed total to each day of the current calendar month by
 * that day's token share, then derives a linear daily rate (month-to-date ÷ calendar days elapsed),
 * so the forecast is a straight line from $0 on the 1st through today, extended to month-end.
 */
interface MonthPace {
  monthLabel: string;
  daysInMonth: number;
  dayOfMonth: number;
  monthSpend: number;
  monthCredits: number;
  /** Linear daily spend used to project the rest of the month. */
  spendPerDay: number;
  creditsPerDay: number;
  /** Per-day spend keyed by day-of-month, for the chart's actual series. */
  spendByDom: Map<number, number>;
  firstActiveDay: number | null;
}

/** The minimal slice of usage the spend chart and month-pace need (UsageTotals satisfies it, as
 * does the global rollup, so both scopes can share one builder). */
interface SpendInput {
  daily: DayUsage[];
  inputTokens: number;
  outputTokens: number;
  aiu: number;
}
function computeMonthPace(t: SpendInput, billedCost: number): MonthPace {
  const now = new Date();
  const monthStart = new Date(now.getFullYear(), now.getMonth(), 1);
  const daysInMonth = new Date(now.getFullYear(), now.getMonth() + 1, 0).getDate();
  const dayOfMonth = now.getDate();
  const monthLabel = `${MONTH[now.getMonth()]} ${now.getFullYear()}`;

  const grandTokens = t.inputTokens + t.outputTokens;
  const spendByDom = new Map<number, number>();
  let firstActiveDay: number | null = null;
  let monthSpend = 0;
  let monthCredits = 0;
  if (grandTokens > 0) {
    for (const d of t.daily) {
      const dd = new Date(`${d.day}T00:00:00`);
      if (dd >= monthStart && dd <= now) {
        const dom = dd.getDate();
        const frac = d.totalTokens / grandTokens;
        const s = billedCost * frac;
        const c = t.aiu * frac;
        spendByDom.set(dom, (spendByDom.get(dom) ?? 0) + s);
        monthSpend += s;
        monthCredits += c;
        if (firstActiveDay === null || dom < firstActiveDay) {
          firstActiveDay = dom;
        }
      }
    }
  }

  // Linear pace: average daily spend over the calendar days elapsed this month (from the 1st
  // through today), so the forecast is a straight line drawn from $0 on the 1st through today
  // and extended to month-end.
  const spendPerDay = dayOfMonth > 0 ? monthSpend / dayOfMonth : 0;
  const creditsPerDay = dayOfMonth > 0 ? monthCredits / dayOfMonth : 0;

  return {
    monthLabel,
    daysInMonth,
    dayOfMonth,
    monthSpend,
    monthCredits,
    spendPerDay,
    creditsPerDay,
    spendByDom,
    firstActiveDay,
  };
}

/**
 * Month-to-date spend forecast. Apportions the workspace's billed total to the current calendar
 * month by the per-day token share, then projects the pace (month-to-date ÷ calendar days elapsed)
 * across the whole month. Month-scope only; the session scope gets a disabled stub.
 */
function buildBudget(t: UsageTotals, billedCost: number, scope: 'workspace' | 'session'): BudgetView {
  if (scope === 'session') {
    return emptyBudget();
  }
  const pace = computeMonthPace(t, billedCost);
  const { monthLabel, daysInMonth, dayOfMonth, monthSpend, monthCredits, spendPerDay, creditsPerDay } = pace;

  // Project month-end as spend-so-far plus the linear pace applied to the days left (the same
  // basis as the Spend-over-time chart's forecast line, so the two figures always agree).
  const daysLeftInMonth = Math.max(0, daysInMonth - dayOfMonth);
  const projectedSpend = monthSpend + spendPerDay * daysLeftInMonth;
  const projectedCredits = monthCredits + creditsPerDay * daysLeftInMonth;
  const hasForecast = monthSpend > 0;

  const projectedNote =
    monthCredits > 0
      ? `${fmtCreditsFull(projectedCredits)} credits at average daily pace`
      : 'at average daily pace · list-price estimate';
  const paceNote = `${monthSpendFmt(monthSpend)} so far · over ${dayOfMonth} day${dayOfMonth === 1 ? '' : 's'} this month`;

  return {
    hasForecast,
    monthLabel,
    monthSpendFmt: monthSpendFmt(monthSpend),
    monthCreditsFmt: fmtCreditsFull(monthCredits),
    projectedSpendFmt: monthSpendFmt(projectedSpend),
    projectedNote,
    paceNote,
  };
}

/** USD with a real "$0.00" zero (the shared fmtUSD renders sub-cent values as "<$0.01"). */
function monthSpendFmt(n: number): string {
  return `$${n.toFixed(2)}`;
}

/** Round a value up to a "nice" axis ceiling (1, 2, 2.5 or 5 × a power of ten) so the y-axis lands
 * on readable round numbers regardless of the spend magnitude. */
function niceCeil(n: number): number {
  if (n <= 0) return 1;
  const pow = Math.pow(10, Math.floor(Math.log10(n)));
  const f = n / pow;
  const nice = f <= 1 ? 1 : f <= 2 ? 2 : f <= 2.5 ? 2.5 : f <= 5 ? 5 : 10;
  return nice * pow;
}

/** Compact USD for axis ticks: "$2.5K" / "$1.2K" past a thousand, else "$12.50"/"$0". */
function fmtUSDAxis(n: number): string {
  if (n <= 0) return '$0';
  if (n >= 1000) {
    const k = n / 1000;
    return `$${k >= 10 ? Math.round(k) : k.toFixed(1)}K`;
  }
  if (n >= 100) return `$${Math.round(n)}`;
  return `$${n.toFixed(2)}`;
}

/**
 * Cumulative spend across the current calendar month plus a forecast to month-end, for the
 * Azure-style area chart on the Spend card. Each day's spend is the billed total apportioned by
 * that day's share of all-time tokens (the same basis as the budget forecast), accumulated from
 * day 1 to today. The forecast continues from today to month-end at the linear month-to-date
 * pace, with its first point pinned to the last actual point so the two lines join cleanly.
 */
function buildSpendChart(t: SpendInput, billedCost: number): SpendChart {
  const pace = computeMonthPace(t, billedCost);
  const { monthLabel, daysInMonth, dayOfMonth, monthSpend, spendPerDay, firstActiveDay, spendByDom } = pace;
  const monShort = monthLabel.split(' ')[0];

  const empty: SpendChart = {
    hasData: false,
    monthLabel,
    actual: [],
    forecast: [],
    axisMax: 1,
    yTicks: [],
    daysInMonth,
    actualTotalFmt: '$0.00',
    forecastTotalFmt: '$0.00',
    paceNote: '',
  };
  if (monthSpend <= 0 || firstActiveDay === null) {
    return empty;
  }

  // Cumulative actual, day 1 → today; each point also carries that day's own spend for the dot tip.
  const actual: SpendPoint[] = [];
  let cum = 0;
  for (let dom = 1; dom <= dayOfMonth; dom++) {
    const day = spendByDom.get(dom) ?? 0;
    cum += day;
    actual.push({
      day: dom,
      label: `${monShort} ${dom}`,
      value: cum,
      valueFmt: monthSpendFmt(cum),
      dayValue: day,
      dayValueFmt: monthSpendFmt(day),
    });
  }

  // Forecast continues from today to month-end at the linear pace; pin the first point to
  // today's actual total so the dashed line joins the solid one.
  const forecast: SpendPoint[] = [
    {
      day: dayOfMonth,
      label: `${monShort} ${dayOfMonth}`,
      value: monthSpend,
      valueFmt: monthSpendFmt(monthSpend),
      dayValue: 0,
      dayValueFmt: monthSpendFmt(0),
    },
  ];
  let fcum = monthSpend;
  for (let dom = dayOfMonth + 1; dom <= daysInMonth; dom++) {
    fcum += spendPerDay;
    forecast.push({
      day: dom,
      label: `${monShort} ${dom}`,
      value: fcum,
      valueFmt: monthSpendFmt(fcum),
      dayValue: spendPerDay,
      dayValueFmt: monthSpendFmt(spendPerDay),
    });
  }
  const projectedSpend = fcum;

  const axisMax = niceCeil(Math.max(projectedSpend, monthSpend));
  const yTicks = [0, 0.25, 0.5, 0.75, 1].map((f) => ({
    value: axisMax * f,
    label: fmtUSDAxis(axisMax * f),
  }));

  return {
    hasData: true,
    monthLabel,
    actual,
    forecast,
    axisMax,
    yTicks,
    daysInMonth,
    actualTotalFmt: monthSpendFmt(monthSpend),
    forecastTotalFmt: monthSpendFmt(projectedSpend),
    paceNote: `over ${pace.dayOfMonth} day${pace.dayOfMonth === 1 ? '' : 's'} this month`,
  };
}

/** Spend-over-time chart for the Global view, built from the cross-workspace per-day token rollup.
 * Apportions the all-workspaces billed total to each day by that day's token share, matching how
 * the per-workspace chart is derived. */
function buildGlobalSpendChart(t: GlobalTotals): SpendChart {
  return buildSpendChart(
    { daily: t.daily, inputTokens: t.totalTokens, outputTokens: 0, aiu: t.totalCredits },
    t.totalCredits * CREDIT_USD,
  );
}

/** Build a 7-day (today and the prior six) stacked-by-model token chart. Days with no usage are
 * kept as empty columns so the week always reads as a continuous timeline. */
function buildWeek(daily: DayUsage[], colorMap: Map<string, string>): WeekChart {
  const byDay = new Map(daily.map((d) => [d.day, d]));
  const today = new Date();
  const windowed: { date: Date; usage?: DayUsage; total: number }[] = [];
  let maxTokens = 0;
  for (let i = 6; i >= 0; i--) {
    const date = new Date(today);
    date.setDate(today.getDate() - i);
    const usage = byDay.get(localDayKey(date));
    const total = usage?.totalTokens ?? 0;
    maxTokens = Math.max(maxTokens, total);
    windowed.push({ date, usage, total });
  }

  let usedOther = false;
  const days: WeekDay[] = windowed.map(({ date, usage, total }) => {
    const segments: WeekSegment[] = [];
    if (usage && total > 0) {
      // Group each day's per-model tokens into the mapped colors, lumping the rest into "other".
      const grouped = new Map<string, { tokens: number; color: string }>();
      for (const [model, tokens] of Object.entries(usage.byModel)) {
        const mapped = colorMap.get(model);
        const key = mapped ? model : OTHER_KEY;
        const color = mapped ?? OTHER_COLOR;
        if (!mapped) {
          usedOther = true;
        }
        const g = grouped.get(key) ?? { tokens: 0, color };
        g.tokens += tokens;
        grouped.set(key, g);
      }
      // Stable order: mapped models in palette/rank order, then "other" last.
      const order = [...colorMap.keys(), OTHER_KEY];
      for (const key of order) {
        const g = grouped.get(key);
        if (g && g.tokens > 0) {
          segments.push({
            model: key,
            color: g.color,
            pctOfDay: (g.tokens / total) * 100,
          });
        }
      }
    }
    return {
      label: WEEKDAY[date.getDay()],
      dateLabel: `${MONTH[date.getMonth()]} ${date.getDate()}`,
      totalTokensFmt: total > 0 ? fmtTokens(total) : '-',
      heightPct: maxTokens > 0 ? (total / maxTokens) * 100 : 0,
      segments,
    };
  });

  const legend = [...colorMap.entries()].map(([model, color]) => ({ model, color }));
  if (usedOther) {
    legend.push({ model: OTHER_KEY, color: OTHER_COLOR });
  }
  return { days, legend, maxFmt: fmtTokens(maxTokens), hasData: maxTokens > 0 };
}

/** Number of prompts to rank in the priciest-prompts leaderboard. */
const TOP_PROMPTS_LIMIT = 10;

/** Format AI credits like the headline does (whole number with separators, or one decimal). */
function fmtCredits(aiu: number): string {
  return aiu >= 100 ? Math.round(aiu).toLocaleString('en-US') : aiu.toFixed(1);
}

/** Cost in USD for one prompt turn: real billed credits when present, else a token-rate estimate. */
function promptTurnCostUSD(turn: PromptTurn): number {
  if (turn.aiu > 0) {
    return turn.aiu * CREDIT_USD;
  }
  const model = turn.models[0] ?? 'unknown';
  const rate = resolveRate({ id: model, family: model });
  const fresh = Math.max(0, turn.inputTokens - turn.cachedTokens);
  return (
    inputCostUSD(rate, fresh) +
    cachedCostUSD(rate, turn.cachedTokens, turn.inputTokens) +
    outputCostUSD(rate, turn.outputTokens, turn.inputTokens)
  );
}

/** Rank a scope's prompt turns by cost (most expensive first) into the priciest-prompts view. */
function buildTopPrompts(t: UsageTotals): TopPromptsMeasured | undefined {
  const turns = t.promptTurns;
  if (!turns || turns.length === 0) {
    return undefined;
  }
  const redact = vscode.workspace.getConfiguration('copilotCostLens').get<boolean>('redactPromptText', false);
  const scored = turns
    .map((turn) => ({ turn, cost: promptTurnCostUSD(turn) }))
    .sort((a, b) => b.cost - a.cost);
  const max = scored[0]?.cost || 1;
  const rows: PromptRow[] = scored.slice(0, TOP_PROMPTS_LIMIT).map((s, i) => {
    const tokens = s.turn.inputTokens + s.turn.outputTokens;
    return {
      id: s.turn.id,
      rank: i + 1,
      text: redact ? `Prompt ${i + 1}` : s.turn.text,
      costFmt: fmtUSD(s.cost),
      creditsFmt: s.turn.aiu > 0 ? fmtCredits(s.turn.aiu) : '-',
      tokensFmt: fmtTokens(tokens),
      calls: s.turn.calls,
      modelLabel: modelLabelOf(s.turn.models),
      whenFmt: formatAgo(s.turn.ts),
      pct: (s.cost / max) * 100,
      estimated: s.turn.estimated,
    };
  });
  return { rows, totalPrompts: turns.length };
}

/** Short label for a turn's models: the top one, plus "+N" when several were used. */
function modelLabelOf(models: string[]): string {
  if (models.length === 0) {
    return 'unknown';
  }
  return models.length === 1 ? models[0] : `${models[0]} +${models.length - 1}`;
}

/** Map an on-demand prompt detail into the detail-drawer view-model. Returns null when unavailable. */
async function buildPromptDetailView(id: string): Promise<PromptDetailView | null> {
  if (!ext.usageReaderDir) {
    return null;
  }
  const hash = id.lastIndexOf('#');
  if (hash < 0) {
    return null;
  }
  const sessionId = id.slice(0, hash);
  const index = Number(id.slice(hash + 1));
  if (!Number.isInteger(index) || index < 0) {
    return null;
  }
  const detail = await loadPromptDetail(ext.usageReaderDir, sessionId, index);
  if (!detail) {
    return null;
  }
  const redact = vscode.workspace.getConfiguration('copilotCostLens').get<boolean>('redactPromptText', false);
  const model = detail.models[0] ?? 'unknown';
  const rate = resolveRate({ id: model, family: model });
  const callCostUSD = (aiu: number, input: number, cached: number, output: number): number => {
    if (aiu > 0) {
      return aiu * CREDIT_USD;
    }
    const fresh = Math.max(0, input - cached);
    return inputCostUSD(rate, fresh) + cachedCostUSD(rate, cached, input) + outputCostUSD(rate, output, input);
  };
  const totalCost =
    detail.aiu > 0
      ? detail.aiu * CREDIT_USD
      : callCostUSD(0, detail.inputTokens, detail.cachedTokens, detail.outputTokens);
  const calls: PromptCallRow[] = detail.calls.map((c) => ({
    whenFmt: formatAgo(c.ts),
    model: c.model,
    inputFmt: fmtTokens(c.inputTokens),
    cachedFmt: fmtTokens(c.cachedTokens),
    outputFmt: fmtTokens(c.outputTokens),
    reasoningFmt: c.reasoningTokens > 0 ? `\u2248${fmtTokens(c.reasoningTokens)}` : '-',
    costFmt: fmtUSD(callCostUSD(c.aiu, c.inputTokens, c.cachedTokens, c.outputTokens)),
    effort: c.effort ?? '',
  }));
  const hidden = '(hidden by the redact-prompt-text setting)';
  return {
    id: detail.id,
    promptText: redact ? hidden : detail.promptText,
    responseText: redact ? hidden : detail.responseText,
    costFmt: fmtUSD(totalCost),
    creditsFmt: detail.aiu > 0 ? fmtCredits(detail.aiu) : '-',
    totalTokensFmt: fmtTokens(detail.inputTokens + detail.outputTokens),
    inputFmt: fmtTokens(detail.inputTokens),
    cachedFmt: fmtTokens(detail.cachedTokens),
    outputFmt: fmtTokens(detail.outputTokens),
    reasoningFmt: detail.reasoningTokens > 0 ? `\u2248${fmtTokens(detail.reasoningTokens)}` : '-',
    modelLabel: modelLabelOf(detail.models),
    whenFmt: formatAgo(detail.ts),
    calls,
    toolCalls: detail.toolCalls.map((tc) => ({ name: tc.name, countFmt: `${tc.count}\u00D7` })),
    estimated: detail.estimated,
  };
}

/** Compact "time since" label for the last completed scan. */
function formatAgo(ts: number): string {
  if (!ts) {
    return 'never';
  }
  const sec = Math.max(0, Math.round((Date.now() - ts) / 1000));
  if (sec < 10) {
    return 'just now';
  }
  if (sec < 60) {
    return `${sec}s ago`;
  }
  const min = Math.round(sec / 60);
  if (min < 60) {
    return `${min} min ago`;
  }
  return `${Math.round(min / 60)}h ago`;
}

/** Explicit, user-triggered: enable Copilot's token logging, then re-detect. */
async function enableLogging(): Promise<void> {
  const ok = await enableTokenLogging();
  if (ok) {
    void vscode.window.showInformationMessage(
      'Copilot token logging enabled. Send a chat message to start measuring real cost.',
    );
  } else {
    void vscode.window.showWarningMessage(
      'Could not change the setting automatically. Enable “github.copilot.chat.agentDebugLog.fileLogging.enabled” in Settings.',
    );
  }
  await refreshCapabilities();
}

async function showDetails(): Promise<void> {
  // Clicking the status-bar credits opens the dashboard full-screen in the editor area (no
  // activity-bar menu), rather than focusing the narrow sidebar view.
  ext.dashboard.openPanel();
  if (!ext.lastResult) {
    await refresh();
  }
}
