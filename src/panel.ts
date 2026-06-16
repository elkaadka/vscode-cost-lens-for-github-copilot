import * as vscode from 'vscode';
import { BadgeDisplay } from './badge';
import { Assessment, Band, bandWord, Factor, fmtTokens, fmtUSD, Severity } from './score';
import { SessionTotals } from './meter';
import { Capabilities, CapabilityLevel } from './capabilities';

interface ViewFactor {
  label: string;
  detail: string;
  severity: Severity;
}

interface SessionView {
  turns: number;
  tokensFmt: string;
  costFmt: string;
}

/** One row in the "top models" breakdown. */
export interface ModelRow {
  model: string;
  /** Swatch color (shared with the weekly chart legend). */
  color: string;
  totalTokensFmt: string;
  costFmt: string;
  requests: number;
  /** Share of total measured tokens, 0–100. */
  sharePct: number;
}

/** One model's slice within a single day's stacked bar. */
export interface WeekSegment {
  model: string;
  color: string;
  /** Share of that day's tokens, 0–100 (segment height within the bar). */
  pctOfDay: number;
}

/** One day column in the weekly stacked bar chart. */
export interface WeekDay {
  /** Short weekday label, e.g. "Mon". */
  label: string;
  /** Calendar date label, e.g. "Jun 9". */
  dateLabel: string;
  totalTokensFmt: string;
  /** Bar height relative to the busiest day in view, 0–100. */
  heightPct: number;
  segments: WeekSegment[];
}

/** Weekly (7-day) stacked-by-model token chart. */
export interface WeekChart {
  days: WeekDay[];
  legend: { model: string; color: string }[];
  /** Tokens on the busiest day in view (the 100%-height reference). */
  maxFmt: string;
  hasData: boolean;
}

/** One segment of a composition bar (token mix or cost mix). Segments sum to the bar's whole. */
export interface MixSeg {
  /** "Input" | "Reply" | "Reasoning". */
  label: string;
  /** Resolved CSS color for the bar segment + legend swatch. */
  color: string;
  /** Width as a percentage of the bar total (0–100). */
  pct: number;
  /** The segment's value, formatted (tokens like "1.7M" or cost like "$2.40"). */
  valueFmt: string;
  /** Share of the whole, formatted with adaptive precision (e.g. "99.8%" / "0.09%"). */
  pctFmt: string;
}

/** One actionable, data-backed cost tip shown in the Cost Explorer banner. */
export interface PanelTip {
  /** Visual weight: 'info' blue, 'warn' amber, 'bad' red, 'ok' green (the calm/no-waste state). */
  tone: 'info' | 'warn' | 'bad' | 'ok';
  /** Short headline, e.g. "Long chat: history rides on every turn". */
  title: string;
  /** One actionable sentence naming the fix. */
  detail: string;
  /** Headline impact figure, e.g. "≈$0.18/turn". */
  metric: string;
  /** Optional itemised choices (e.g. cheaper models, each with a cost and a saving badge). */
  options?: { label: string; value: string; badge?: string }[];
}

/** Real, measured usage aggregated across all chat sessions in the workspace, ready to render. */
export interface MeasuredView {
  band: Band;
  bandWord: string;
  conclusion: string;
  /** Headline: input + output tokens across everything measured. */
  totalTokensFmt: string;
  inTokensFmt: string;
  outTokensFmt: string;
  cachedFmt: string;
  /** Distinct billable model calls. */
  requests: number;
  /** Distinct chat sessions contributing usage. */
  sessions: number;
  /** Copilot-native AI Units (exact, from the log). */
  aiuFmt: string;
  /** AI credits consumed so far, formatted (e.g. "803"); "-" when the log has no credit data. */
  creditsFmt: string;
  /** Headline cost in USD. Billed credits (AIU × $0.01) when the log has them, else a list-price estimate. */
  costFmt: string;
  /** Caption under the cost naming the basis, e.g. "≈ 845 credits" or "≈ at list prices". */
  costNote: string;
  /** Top model, annotated with "+N" when several were used. */
  model: string;
  /** Up to the top 3 models by total tokens. */
  topModels: ModelRow[];
  /** Last-7-days token usage, stacked per model. */
  week: WeekChart;
  /** Token composition (Input / Cached / Reply / Reasoning), summing to total tokens. */
  tokenMix: MixSeg[];
  /** Cost composition (Input / Cached / Reply / Reasoning $), summing to total cost. */
  costMix: MixSeg[];
  /** Average spend per user prompt, e.g. "1.8" (credits) or "$0.18" (estimate); "-" when unknown. */
  avgPerPromptFmt: string;
  /** Caption under the average, e.g. "≈ $0.18 · 0.6/request". */
  avgPerPromptCap: string;
  /** Scope label shown on the composition sections, e.g. "this session" or "workspace". */
  scopeLabel: string;
  /** "just now" / "5 min ago": freshness of the last scan. */
  lastAnalyzedFmt: string;
  /** Actionable, data-backed cost tips, ranked by impact (largest first). Empty when none apply. */
  tips: PanelTip[];
  /** Whether to show the tips banner at all (false on the workspace panel, which has no tips). */
  showTips: boolean;
  /** Whether to show the weekly chart (false on the session panel, where a 7-day trend is moot). */
  showWeek: boolean;
}

type ViewState =
  | { kind: 'computing' }
  | { kind: 'unavailable'; reason: string }
  | {
      kind: 'setup';
      level: CapabilityLevel;
      canEnable: boolean;
      title: string;
      body: string;
      hint?: string;
    }
  | ({ kind: 'measured' } & MeasuredView)
  | {
      kind: 'ready';
      source: 'editor' | 'chat';
      band: Band;
      bandWord: string;
      conclusion: string;
      hasContext: boolean;
      modelName: string;
      contextTokensFmt: string;
      inputFmt: string;
      perTurnFmt: string;
      marginalFmt: string;
      fillPct: number;
      referenceLabel: string;
      factors: ViewFactor[];
    };

/** Reference context size (tokens) for the bar when a model has no long-context cliff. */
const REFERENCE_LARGE = 60_000;

/** Renders the cost drill-down as a rich webview panel (Activity Bar view). */
export class HealthViewProvider implements vscode.WebviewViewProvider {
  /** Default (workspace) view id; the session panel passes its own id to the constructor. */
  public static readonly viewType = 'copilotControlPlane.healthView';

  private view?: vscode.WebviewView;
  private latest: ViewState = { kind: 'computing' };
  private editorState: ViewState = { kind: 'computing' };
  private pinned = false;
  private session: SessionView = emptySession();
  private caps?: Capabilities;
  private measured?: { kind: 'measured' } & MeasuredView;

  constructor(
    private readonly extensionUri: vscode.Uri,
    /** This provider's contributed view id (so workspace + session panels can coexist). */
    public readonly viewType: string = HealthViewProvider.viewType,
  ) {}

  resolveWebviewView(view: vscode.WebviewView): void {
    this.view = view;
    view.webview.options = {
      enableScripts: true,
      localResourceRoots: [this.extensionUri],
    };
    view.webview.html = this.html(view.webview);
    view.webview.onDidReceiveMessage((msg: { type?: string }) => this.onMessage(msg));
    view.onDidChangeVisibility(() => {
      if (view.visible) {
        this.post();
        void vscode.commands.executeCommand('copilotControlPlane.refresh');
      }
    });
    this.post();
    void vscode.commands.executeCommand('copilotControlPlane.refresh');
  }

  /** Capability gate: drives whether we show real measured cost or the setup onboarding. */
  setCapabilities(caps: Capabilities): void {
    this.caps = caps;
    if (caps.level === 'full') {
      // Keep any measured data we already have; otherwise show "measuring" until it arrives.
      this.latest = this.measured ?? { kind: 'computing' };
    } else {
      this.latest = buildSetup(caps);
    }
    this.post();
  }

  /** Push the real, measured cost of the active chat session (only shown in `full` mode). */
  updateMeasured(view: MeasuredView): void {
    const state: { kind: 'measured' } & MeasuredView = { kind: 'measured', ...view };
    this.measured = state;
    if (this.caps?.level === 'full') {
      this.latest = state;
      this.post();
    }
  }

  update(a: Assessment, display: BadgeDisplay): void {
    this.setEditorState(this.buildReady(a, display, 'editor'));
  }

  /** `@costlens update` pushed a measured chat reading; pin it as the headline until Refresh. */
  updateChat(a: Assessment, display: BadgeDisplay): void {
    this.pinned = true;
    this.latest = this.buildReady(a, display, 'chat');
    this.post();
  }

  private buildReady(a: Assessment, display: BadgeDisplay, source: 'editor' | 'chat'): ViewState {
    const ref = display.longCtxThreshold ?? REFERENCE_LARGE;
    const fillPct = ref > 0 ? Math.min(100, (display.contextTokens / ref) * 100) : 0;
    return {
      kind: 'ready',
      source,
      band: a.band,
      bandWord: bandWord(a.band),
      conclusion: a.conclusion,
      hasContext: display.contextTokens > 0,
      modelName: display.modelName,
      contextTokensFmt: fmtTokens(display.contextTokens),
      inputFmt: fmtUSD(display.inputCostUSD),
      perTurnFmt: fmtUSD(display.perTurnUSD),
      marginalFmt: fmtUSD(display.marginalPer10kUSD),
      fillPct,
      referenceLabel: display.longCtxThreshold
        ? `cliff at ${fmtTokens(display.longCtxThreshold)}`
        : `large at ${fmtTokens(REFERENCE_LARGE)}`,
      factors: a.factors.map((f: Factor) => ({
        label: f.label,
        detail: f.detail,
        severity: f.severity,
      })),
    };
  }

  /** Editor-sourced state. While a chat reading is pinned, store it but keep the pin visible. */
  private setEditorState(state: ViewState): void {
    this.editorState = state;
    if (!this.pinned) {
      this.latest = state;
      this.post();
    }
  }

  private unpin(): void {
    if (!this.pinned) {
      return;
    }
    this.pinned = false;
    this.latest = this.editorState;
    this.post();
  }

  updateSession(totals: SessionTotals): void {
    this.session = {
      turns: totals.turns,
      tokensFmt: fmtTokens(totals.inputTokens + totals.outputTokens),
      costFmt: fmtUSD(totals.costUSD),
    };
    this.post();
  }

  setUnavailable(reason: string): void {
    this.setEditorState({ kind: 'unavailable', reason });
  }

  setComputing(): void {
    this.setEditorState({ kind: 'computing' });
  }

  private onMessage(msg: { type?: string }): void {
    switch (msg?.type) {
      case 'refresh':
        this.unpin();
        void vscode.commands.executeCommand('copilotControlPlane.refresh');
        break;
      case 'enableLogging':
        void vscode.commands.executeCommand('copilotControlPlane.enableLogging');
        break;
      case 'openExtensions':
        void vscode.commands.executeCommand('workbench.extensions.search', 'GitHub.copilot-chat');
        break;
      case 'resetSession':
        void vscode.commands.executeCommand('copilotControlPlane.resetSession');
        break;
      case 'openRates':
        void vscode.commands.executeCommand('workbench.action.openSettings', 'copilotCostLens');
        break;
      case 'openSettings':
        void vscode.commands.executeCommand('workbench.action.openSettings', 'github.copilot');
        break;
    }
  }

  private post(): void {
    this.view?.webview.postMessage({ type: 'state', state: this.latest, session: this.session });
  }

  private html(webview: vscode.Webview): string {
    const nonce = makeNonce();
    const csp = [
      `default-src 'none'`,
      `style-src ${webview.cspSource} 'unsafe-inline'`,
      `script-src 'nonce-${nonce}'`,
      `img-src ${webview.cspSource} https: data:`,
    ].join('; ');

    return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8" />
<meta http-equiv="Content-Security-Policy" content="${csp}" />
<meta name="viewport" content="width=device-width, initial-scale=1.0" />
<style>
  :root {
    --ok: var(--vscode-charts-green, #3fb950);
    --warn: var(--vscode-charts-yellow, #d29922);
    --bad: var(--vscode-charts-red, #f85149);
    --accent: var(--vscode-charts-blue, #3794ff);
    --purple: var(--vscode-charts-purple, #b180d7);
    --card: var(--vscode-editorWidget-background, rgba(128,128,128,0.08));
    --line: var(--vscode-editorWidget-border, rgba(128,128,128,0.25));
  }
  * { box-sizing: border-box; }
  body {
    font-family: var(--vscode-font-family);
    color: var(--vscode-foreground);
    font-size: 13px;
    padding: 12px 12px 20px;
    margin: 0;
  }
  .hidden { display: none !important; }

  .verdict { display: flex; align-items: center; gap: 8px; margin-bottom: 6px; }
  .dot { width: 12px; height: 12px; border-radius: 50%; background: var(--line); flex: 0 0 auto; }
  .bandword { font-size: 18px; font-weight: 700; }
  .conclusion { font-size: 12.5px; line-height: 1.5; opacity: .92; margin-bottom: 16px; }
  .ctx-note {
    font-size: 11.5px; line-height: 1.45; opacity: .85; margin: -8px 0 16px;
    padding: 8px 10px; border-radius: 6px;
    background: var(--card); border: 1px dashed var(--line);
  }
  .ctx-note code {
    font-family: var(--vscode-editor-font-family, monospace);
    background: rgba(128,128,128,0.18); padding: 0 4px; border-radius: 3px;
  }

  .headline {
    display: flex; flex-wrap: wrap; align-items: baseline; justify-content: space-between;
    gap: 6px 12px;
    padding: 12px 14px; border-radius: 8px; background: var(--card); border: 1px solid var(--line);
    margin-bottom: 12px;
  }
  .hl-tokens, .hl-cost { display: flex; flex-direction: column; min-width: 0; }
  .hl-cost { text-align: right; margin-left: auto; }
  #tokens, #m-tokens { font-size: clamp(22px, 9vw, 28px); font-weight: 700; line-height: 1; }
  #perturn, #m-cost { font-size: clamp(17px, 7.5vw, 22px); font-weight: 700; line-height: 1; }
  .hl-unit { font-size: 10px; text-transform: uppercase; letter-spacing: .04em; opacity: .65; margin-top: 4px; }
  .m-meta { display: flex; justify-content: space-between; align-items: baseline; gap: 8px; font-size: 11px; opacity: .72; margin: -4px 0 14px; }
  .m-model { font-weight: 600; opacity: 1; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; max-width: 62%; }
  .m-analyzed { white-space: nowrap; }

  /* Tips banner: the most actionable thing, sits right under the headline and is built to pop. */
  .tips-banner { display: flex; flex-direction: column; gap: 8px; margin: 4px 0 16px; }
  .tip-card {
    display: flex; flex-direction: column;
    padding: 11px 13px; border-radius: 8px;
    background: var(--card); border: 1px solid var(--line); border-left: 4px solid var(--accent);
    box-shadow: 0 1px 3px rgba(0,0,0,0.18);
  }
  /* Tone tints: a wash of the tone colour over the card so it reads at a glance, not just a stripe. */
  .tip-card.info { border-left-color: var(--accent); background: color-mix(in srgb, var(--accent) 12%, var(--card)); }
  .tip-card.warn { border-left-color: var(--warn); background: color-mix(in srgb, var(--warn) 14%, var(--card)); }
  .tip-card.bad  { border-left-color: var(--bad);  background: color-mix(in srgb, var(--bad) 16%, var(--card)); }
  .tip-card.ok   { border-left-color: var(--ok);   background: color-mix(in srgb, var(--ok) 10%, var(--card)); }
  /* warn/bad gently pulse once-ish to catch the eye; respects reduced-motion. */
  .tip-card.warn, .tip-card.bad { animation: tip-attention 2.4s ease-in-out 3; }
  @keyframes tip-attention {
    0%, 100% { box-shadow: 0 1px 3px rgba(0,0,0,0.18); }
    50% { box-shadow: 0 0 0 3px color-mix(in srgb, var(--bad) 30%, transparent), 0 1px 3px rgba(0,0,0,0.18); }
  }
  .tip-card.warn { animation-name: tip-attention-warn; }
  @keyframes tip-attention-warn {
    0%, 100% { box-shadow: 0 1px 3px rgba(0,0,0,0.18); }
    50% { box-shadow: 0 0 0 3px color-mix(in srgb, var(--warn) 30%, transparent), 0 1px 3px rgba(0,0,0,0.18); }
  }
  @media (prefers-reduced-motion: reduce) { .tip-card { animation: none !important; } }
  .tip-icon { flex: 0 0 auto; font-size: 14px; line-height: 1.35; }
  .tip-card.info .tip-icon { color: var(--accent); }
  .tip-card.warn .tip-icon { color: var(--warn); }
  .tip-card.bad  .tip-icon { color: var(--bad); }
  .tip-card.ok   .tip-icon { color: var(--ok); }
  /* Header row spans the full card width: icon, title, metric, then a chevron pinned far right. */
  .tip-head { display: flex; align-items: center; gap: 8px; cursor: pointer; user-select: none; }
  .tip-title { font-weight: 600; font-size: 12.5px; flex: 1 1 auto; min-width: 0; }
  .tip-chevron { flex: 0 0 auto; font-size: 9px; opacity: .55; transition: transform .15s ease; margin-left: 2px; }
  .tip-card.open .tip-chevron { transform: rotate(180deg); }
  /* Detail is collapsed by default; revealed when the card carries .open. Indented to clear the icon. */
  .tip-detail { font-size: 11.5px; opacity: .82; line-height: 1.45; margin: 6px 0 0 22px; display: none; }
  .tip-card.open .tip-detail { display: block; }
  .tip-card.ok .tip-detail { display: block; }
  .tip-card.ok .tip-chevron { display: none; }
  .tip-card.ok .tip-head { cursor: default; }
  .tip-metric { flex: 0 0 auto; font-weight: 700; font-size: 13px; white-space: nowrap; opacity: .95; }
  .tip-card.info .tip-metric { color: var(--accent); }
  .tip-card.warn .tip-metric { color: var(--warn); }
  .tip-card.bad .tip-metric { color: var(--bad); }
  .tip-card.ok .tip-metric { color: var(--ok); }

  /* Token composition bar (Input / Reply / Reasoning) */
  .token-bar { display: flex; height: 14px; border-radius: 7px; overflow: hidden; background: var(--line); margin: 2px 0 8px; }
  .token-seg { height: 100%; }
  .token-legend { display: flex; flex-wrap: wrap; gap: 5px 14px; margin-bottom: 16px; }
  .tl-item { display: flex; align-items: baseline; gap: 6px; font-size: 11px; }
  .tl-swatch { width: 10px; height: 10px; border-radius: 2px; flex: 0 0 auto; align-self: center; }
  .tl-name { opacity: .82; }
  .tl-val { font-weight: 600; }
  .tl-pct { opacity: .58; }

  /* Top-models breakdown */
  .top-models { display: flex; flex-direction: column; gap: 6px; margin-bottom: 18px; }
  .tm-row { display: flex; align-items: center; gap: 8px; font-size: 12px; }
  .tm-swatch { width: 10px; height: 10px; border-radius: 2px; flex: 0 0 auto; }
  .tm-name { font-weight: 600; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; flex: 1 1 auto; min-width: 0; }
  .tm-tokens { white-space: nowrap; opacity: .92; }
  .tm-meta { white-space: nowrap; opacity: .58; font-size: 10.5px; flex: 0 0 auto; }

  /* Weekly stacked-by-model chart */
  .legend { display: flex; flex-wrap: wrap; gap: 6px 12px; margin: 0 0 8px; }
  .legend-item { display: flex; align-items: center; gap: 5px; font-size: 10.5px; opacity: .82; min-width: 0; }
  .legend-swatch { width: 9px; height: 9px; border-radius: 2px; flex: 0 0 auto; }
  .legend-name { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; max-width: 120px; }
  .chart { display: flex; align-items: flex-end; gap: 5px; height: 96px; margin: 2px 0 4px; }
  .chart-col { flex: 1 1 0; min-width: 0; height: 100%; display: flex; flex-direction: column; justify-content: flex-end; align-items: center; }
  .chart-bar { width: 100%; max-width: 28px; display: flex; flex-direction: column-reverse; border-radius: 3px 3px 0 0; overflow: hidden; }
  .chart-seg { width: 100%; }
  .chart-x { display: flex; gap: 5px; margin-bottom: 6px; }
  .chart-xcol { flex: 1 1 0; min-width: 0; text-align: center; font-size: 9.5px; line-height: 1.3; opacity: .6; }
  .chart-cap { font-size: 10.5px; opacity: .6; margin-bottom: 10px; }
  .chart-empty-note { font-size: 11.5px; opacity: .7; margin: 4px 0 14px; line-height: 1.45; }

  .bar-wrap { margin-bottom: 16px; }
  .bar { height: 8px; border-radius: 4px; background: var(--line); overflow: hidden; }
  .bar-fill { height: 100%; width: 0; background: var(--accent); transition: width .5s ease, background .3s ease; }
  .bar-sub { display: flex; justify-content: space-between; font-size: 10px; opacity: .6; margin-top: 4px; }

  .section-title { font-size: 11px; text-transform: uppercase; letter-spacing: .04em; opacity: .7; margin: 0 0 8px; }
  .scope-tag { font-size: 9px; font-weight: 600; letter-spacing: .03em; opacity: .9; padding: 1px 6px; border-radius: 8px; background: color-mix(in srgb, var(--ok) 22%, transparent); color: var(--ok); margin-left: 6px; vertical-align: middle; }
  .lines { display: flex; flex-direction: column; gap: 6px; }
  .line {
    display: flex; gap: 9px; align-items: flex-start; padding: 8px 10px;
    background: var(--card); border-left: 3px solid transparent; border-radius: 4px;
  }
  .sev {
    flex: 0 0 auto; width: 16px; height: 16px; border-radius: 50%;
    color: #1b1b1b; font-size: 11px; font-weight: 700; line-height: 16px; text-align: center; margin-top: 1px;
  }
  .line-body { min-width: 0; flex: 1; }
  .line-label { font-weight: 600; font-size: 12px; }
  .line-detail { font-size: 11px; opacity: .82; margin-top: 2px; line-height: 1.4; }

  .session {
    margin-top: 18px; padding: 10px 12px; border-radius: 6px;
    background: var(--card); border: 1px solid var(--line);
  }
  .session-head { display: flex; align-items: center; justify-content: space-between; margin-bottom: 4px; }
  .session-title { font-size: 10px; text-transform: uppercase; letter-spacing: .04em; opacity: .7; }
  .session-body { font-size: 12.5px; font-weight: 600; line-height: 1.4; }
  .link {
    cursor: pointer; border: none; background: none; padding: 0;
    color: var(--vscode-textLink-foreground); font-size: 11px; font-weight: 600;
  }
  .link:hover { text-decoration: underline; }

  .actions { display: flex; gap: 8px; margin-top: 16px; }
  .btn {
    flex: 1; cursor: pointer; border: none; border-radius: 5px; padding: 7px 10px;
    font-size: 12px; font-weight: 600;
    color: var(--vscode-button-foreground); background: var(--vscode-button-background);
  }
  .btn:hover { background: var(--vscode-button-hoverBackground); }
  .btn.ghost { color: var(--vscode-button-secondaryForeground); background: var(--vscode-button-secondaryBackground); }
  .btn.ghost:hover { background: var(--vscode-button-secondaryHoverBackground); }

  .state { text-align: center; padding: 34px 12px; }
  .state .big { font-size: 34px; margin-bottom: 12px; }
  .state .muted { opacity: .7; font-size: 12px; margin-bottom: 16px; line-height: 1.5; }
  .setup-title { font-size: 15px; font-weight: 700; margin-bottom: 8px; }
  .setup-hint { font-size: 11.5px; opacity: .72; margin: 0 0 16px; line-height: 1.5; }
  .state .btn { display: inline-block; flex: none; margin: 6px 4px 0; min-width: 160px; max-width: 260px; }

  /* Narrow Activity Bar widths: stack rows so values never truncate. */
  @media (max-width: 300px) {
    .headline { flex-direction: column; align-items: stretch; gap: 8px; }
    .hl-cost { text-align: left; margin-left: 0; }
  }
  @media (max-width: 240px) {
    body { padding: 10px 8px 18px; }
    .actions { flex-direction: column; }
  }
</style>
</head>
<body>
  <div id="computing" class="state">
    <div class="big">&#9203;</div>
    <div class="muted">Measuring current context…</div>
  </div>

  <div id="unavailable" class="state hidden">
    <div class="big">&#128683;</div>
    <div class="muted" id="unavailable-reason"></div>
    <button class="btn" data-action="refresh">Refresh</button>
  </div>

  <div id="setup" class="state hidden">
    <div class="big">&#128274;</div>
    <div id="setup-title" class="setup-title">-</div>
    <div id="setup-body" class="muted">-</div>
    <div id="setup-hint" class="setup-hint hidden"></div>
    <button id="setup-enable" class="btn hidden" data-action="enableLogging">Enable token logging</button>
    <button id="setup-install" class="btn hidden" data-action="openExtensions">Find Copilot Chat</button>
    <button class="btn ghost" data-action="refresh">&#8635; Refresh</button>
  </div>

  <div id="measured" class="hidden">
    <div class="headline">
      <div class="hl-tokens">
        <span id="m-tokens">-</span>
        <span id="m-tokens-unit" class="hl-unit">tokens</span>
      </div>
      <div class="hl-cost">
        <span id="m-cost">-</span>
        <span id="m-cost-note" class="hl-unit">&approx; at list prices</span>
      </div>
    </div>

    <div class="m-meta">
      <span><span id="m-req">-</span> &middot; Model: <span id="m-model" class="m-model">-</span></span>
      <span id="m-analyzed" class="m-analyzed">-</span>
    </div>

    <div id="m-tips" class="tips-banner"></div>

    <div class="section-title">Where your tokens go <span id="m-scope-tok" class="scope-tag"></span></div>
    <div id="m-token-bar" class="token-bar"></div>
    <div id="m-token-legend" class="token-legend"></div>

    <div class="section-title">Where your cost goes <span id="m-scope-cost" class="scope-tag"></span></div>
    <div id="m-cost-bar" class="token-bar"></div>
    <div id="m-cost-legend" class="token-legend"></div>

    <div id="m-top-title" class="section-title">Top models</div>
    <div id="m-top" class="top-models"></div>

    <div id="m-week-section">
      <div class="section-title">This week &middot; tokens by model</div>
      <div id="m-legend" class="legend"></div>
      <div id="m-chart" class="chart"></div>
      <div id="m-chart-x" class="chart-x"></div>
      <div id="m-chart-cap" class="chart-cap">&nbsp;</div>
      <div id="m-chart-empty" class="chart-empty-note hidden">No usage recorded in the last 7 days.</div>
    </div>

    <div id="m-note" class="ctx-note">
      Measured from Copilot&rsquo;s own request logs across <strong>every chat session</strong> in
      this workspace, updated as you use Copilot (or on Refresh). Cost is billed credits
      (1&nbsp;credit = $0.01) when Copilot logs them, otherwise estimated from bundled list rates;
      override under <code>Rates</code>.
    </div>

    <div class="actions">
      <button class="btn" data-action="refresh">&#8635; Refresh</button>
      <button class="btn ghost" data-action="openRates">&#9881; Rates</button>
    </div>
  </div>

  <div id="ready" class="hidden">
    <div class="verdict">
      <span id="dot" class="dot"></span>
      <span id="bandword" class="bandword">-</span>
    </div>
    <div id="conclusion" class="conclusion">-</div>

    <div class="headline">
      <div class="hl-tokens">
        <span id="tokens">-</span>
        <span id="hl-unit" class="hl-unit">in active editor</span>
      </div>
      <div class="hl-cost">
        <span id="perturn">-</span>
        <span class="hl-unit">est. per message</span>
      </div>
    </div>

    <div id="ctx-note" class="ctx-note hidden">
      No file open. This is the reply-only floor. Open or select code to price what
      you'd attach. Live <strong>chat</strong> tokens can't be read from the native
      panel; send a turn through <code>@costlens</code> to measure one (tracked below).
    </div>

    <div id="chat-note" class="ctx-note hidden">
      Synced from your <code>@costlens</code> chat context. Click <strong>Refresh</strong>
      to return to the active-editor estimate.
    </div>

    <div class="bar-wrap">
      <div class="bar"><div id="bar-fill" class="bar-fill"></div></div>
      <div class="bar-sub"><span>context size</span><span id="bar-ref">-</span></div>
    </div>

    <div class="stats">
      <div class="stat"><div class="stat-label">Model</div><div id="model" class="stat-value">-</div></div>
      <div class="stat"><div class="stat-label">To send</div><div id="input" class="stat-value">-</div></div>
      <div class="stat"><div class="stat-label">Per +10K</div><div id="marginal" class="stat-value">-</div></div>
    </div>

    <div class="section-title">What drives the cost</div>
    <div id="lines" class="lines"></div>

    <div class="session">
      <div class="session-head">
        <span class="session-title">This chat &middot; measured via @costlens</span>
        <button class="link" data-action="resetSession">Reset</button>
      </div>
      <div id="session-body" class="session-body">No @costlens turns yet. Type <code>@costlens</code> in chat to measure one</div>
    </div>

    <div class="actions">
      <button class="btn" data-action="refresh">&#8635; Refresh</button>
      <button class="btn ghost" data-action="openSettings">&#9881; Copilot settings</button>
    </div>
  </div>

<script nonce="${nonce}">
(function () {
  var vscode = acquireVsCodeApi();

  function show(id) {
    ['computing', 'unavailable', 'setup', 'measured', 'ready'].forEach(function (s) {
      var el = document.getElementById(s);
      if (el) { el.classList.toggle('hidden', s !== id); }
    });
  }
  function bandColor(band) {
    return band === 'green' ? 'var(--ok)' : band === 'yellow' ? 'var(--warn)' : 'var(--bad)';
  }
  function sevColor(sev) {
    return sev === 'ok' ? 'var(--ok)' : sev === 'warn' ? 'var(--warn)' : 'var(--bad)';
  }
  function sevGlyph(sev) {
    return sev === 'ok' ? '\u2713' : sev === 'warn' ? '!' : '\u2715';
  }

  function renderReady(s) {
    show('ready');
    var col = bandColor(s.band);

    document.getElementById('dot').style.background = col;
    var bw = document.getElementById('bandword');
    bw.textContent = s.bandWord;
    bw.style.color = col;
    document.getElementById('conclusion').textContent = s.conclusion;

    var isChat = s.source === 'chat';
    var unit = document.getElementById('hl-unit');
    if (unit) { unit.textContent = isChat ? 'from @costlens chat' : 'in active editor'; }
    var note = document.getElementById('ctx-note');
    if (note) { note.classList.toggle('hidden', isChat || s.hasContext); }
    var chatNote = document.getElementById('chat-note');
    if (chatNote) { chatNote.classList.toggle('hidden', !isChat); }

    document.getElementById('tokens').textContent = s.contextTokensFmt;
    var pt = document.getElementById('perturn');
    pt.textContent = s.perTurnFmt;
    pt.style.color = col;

    var fill = document.getElementById('bar-fill');
    fill.style.width = Math.max(2, s.fillPct) + '%';
    fill.style.background = col;
    document.getElementById('bar-ref').textContent = s.referenceLabel;

    document.getElementById('model').textContent = s.modelName;
    document.getElementById('model').title = s.modelName;
    document.getElementById('input').textContent = s.inputFmt;
    document.getElementById('marginal').textContent = '+' + s.marginalFmt;

    var box = document.getElementById('lines');
    box.textContent = '';
    s.factors.forEach(function (l) {
      var row = document.createElement('div');
      row.className = 'line';
      row.style.borderLeftColor = sevColor(l.severity);

      var badge = document.createElement('div');
      badge.className = 'sev';
      badge.style.background = sevColor(l.severity);
      badge.textContent = sevGlyph(l.severity);

      var body = document.createElement('div');
      body.className = 'line-body';

      var label = document.createElement('div');
      label.className = 'line-label';
      label.textContent = l.label;

      var det = document.createElement('div');
      det.className = 'line-detail';
      det.textContent = l.detail;

      body.appendChild(label);
      body.appendChild(det);
      row.appendChild(badge);
      row.appendChild(body);
      box.appendChild(row);
    });
  }

  function renderSession(sn) {
    var el = document.getElementById('session-body');
    if (!el) { return; }
    if (!sn || !sn.turns) {
      el.innerHTML = 'No @costlens turns yet. Type <code>@costlens</code> in chat to measure one';
      return;
    }
    var word = sn.turns === 1 ? 'turn' : 'turns';
    el.textContent = sn.turns + ' ' + word + ' \u00b7 ' + sn.tokensFmt + ' tokens \u00b7 ' + sn.costFmt;
  }

  function renderUnavailable(s) {
    show('unavailable');
    document.getElementById('unavailable-reason').textContent = s.reason;
  }

  function renderSetup(s) {
    show('setup');
    document.getElementById('setup-title').textContent = s.title;
    document.getElementById('setup-body').textContent = s.body;
    var hint = document.getElementById('setup-hint');
    if (s.hint) { hint.textContent = s.hint; hint.classList.remove('hidden'); }
    else { hint.classList.add('hidden'); }
    document.getElementById('setup-enable').classList.toggle('hidden', !s.canEnable);
    document.getElementById('setup-install').classList.toggle('hidden', s.level !== 'none');
  }

  function renderTips(tips) {
    var box = document.getElementById('m-tips');
    box.textContent = '';
    var icons = { info: '\u24D8', warn: '\u26A0', bad: '\u26A0', ok: '\u2713' };
    if (!tips || !tips.length) {
      var ok = document.createElement('div'); ok.className = 'tip-card ok';
      var okh = document.createElement('div'); okh.className = 'tip-head';
      var oki = document.createElement('span'); oki.className = 'tip-icon'; oki.textContent = icons.ok;
      var okt = document.createElement('div'); okt.className = 'tip-title'; okt.textContent = 'No cost-saving actions right now';
      okh.appendChild(oki); okh.appendChild(okt);
      var okd = document.createElement('div'); okd.className = 'tip-detail';
      okd.textContent = 'Cache reuse and tool usage look lean; tips appear here when there\u2019s waste to trim.';
      ok.appendChild(okh); ok.appendChild(okd); box.appendChild(ok);
      return;
    }
    tips.forEach(function (t) {
      var card = document.createElement('div'); card.className = 'tip-card ' + (t.tone || 'info');
      // One full-width header row: icon, title, metric, chevron (pinned right). Click to expand.
      var head = document.createElement('div'); head.className = 'tip-head';
      var icon = document.createElement('span'); icon.className = 'tip-icon'; icon.textContent = icons[t.tone] || icons.info;
      var title = document.createElement('div'); title.className = 'tip-title'; title.textContent = t.title;
      var metric = document.createElement('span'); metric.className = 'tip-metric'; metric.textContent = t.metric;
      var chevron = document.createElement('span'); chevron.className = 'tip-chevron'; chevron.textContent = '\u25BC';
      head.appendChild(icon); head.appendChild(title); head.appendChild(metric); head.appendChild(chevron);
      var detail = document.createElement('div'); detail.className = 'tip-detail'; detail.textContent = t.detail;
      head.addEventListener('click', function () { card.classList.toggle('open'); });
      card.appendChild(head); card.appendChild(detail);
      box.appendChild(card);
    });
  }

  function renderMeasured(s) {
    show('measured');
    var tipsBox = document.getElementById('m-tips');
    if (s.showTips) {
      tipsBox.classList.remove('hidden');
      renderTips(s.tips);
    } else {
      tipsBox.classList.add('hidden');
      tipsBox.textContent = '';
    }
    document.getElementById('m-tokens').textContent = s.totalTokensFmt;
    var sessWord = s.sessions === 1 ? 'session' : 'sessions';
    document.getElementById('m-tokens-unit').textContent = 'tokens across ' + s.sessions + ' ' + sessWord;
    document.getElementById('m-cost').textContent = s.costFmt;
    document.getElementById('m-cost-note').textContent = s.costNote;
    var reqWord = s.requests === 1 ? 'request' : 'requests';
    document.getElementById('m-req').textContent = s.requests + ' ' + reqWord;
    var model = document.getElementById('m-model');
    model.textContent = s.model; model.title = s.model;
    document.getElementById('m-analyzed').textContent = 'analyzed ' + s.lastAnalyzedFmt;
    var scope = s.scopeLabel || '';
    document.getElementById('m-scope-tok').textContent = scope;
    document.getElementById('m-scope-cost').textContent = scope;
    var weekSection = document.getElementById('m-week-section');
    if (s.showWeek) {
      weekSection.classList.remove('hidden');
      renderMix('m-token-bar', 'm-token-legend', s.tokenMix, 'of total tokens');
      renderMix('m-cost-bar', 'm-cost-legend', s.costMix, 'of total cost');
      renderTopModels(s.topModels);
      renderWeek(s.week);
    } else {
      weekSection.classList.add('hidden');
      renderMix('m-token-bar', 'm-token-legend', s.tokenMix, 'of total tokens');
      renderMix('m-cost-bar', 'm-cost-legend', s.costMix, 'of total cost');
      renderTopModels(s.topModels);
    }
  }

  function renderMix(barId, legendId, mix, ofWhat) {
    var bar = document.getElementById(barId);
    var leg = document.getElementById(legendId);
    bar.textContent = ''; leg.textContent = '';
    (mix || []).forEach(function (seg) {
      var d = document.createElement('div');
      d.className = 'token-seg';
      d.style.width = Math.max(0, seg.pct) + '%';
      if (seg.pct > 0) { d.style.minWidth = '3px'; }
      d.style.background = seg.color;
      d.title = seg.label + ' ' + seg.valueFmt + ' (' + seg.pctFmt + ' ' + ofWhat + ')';
      bar.appendChild(d);

      var item = document.createElement('span'); item.className = 'tl-item';
      var sw = document.createElement('span'); sw.className = 'tl-swatch'; sw.style.background = seg.color;
      var nm = document.createElement('span'); nm.className = 'tl-name'; nm.textContent = seg.label;
      var val = document.createElement('span'); val.className = 'tl-val'; val.textContent = seg.valueFmt;
      var pct = document.createElement('span'); pct.className = 'tl-pct'; pct.textContent = seg.pctFmt;
      item.appendChild(sw); item.appendChild(nm); item.appendChild(val); item.appendChild(pct);
      leg.appendChild(item);
    });
  }

  function modelLabel(m) { return m === 'other' ? 'Other' : m; }

  function renderTopModels(rows) {
    var title = document.getElementById('m-top-title');
    var box = document.getElementById('m-top');
    box.textContent = '';
    if (!rows || !rows.length) {
      title.classList.add('hidden'); box.classList.add('hidden'); return;
    }
    title.classList.remove('hidden'); box.classList.remove('hidden');
    rows.forEach(function (r) {
      var row = document.createElement('div'); row.className = 'tm-row';
      var sw = document.createElement('span'); sw.className = 'tm-swatch'; sw.style.background = r.color;
      var name = document.createElement('span'); name.className = 'tm-name';
      name.textContent = modelLabel(r.model); name.title = modelLabel(r.model);
      var tok = document.createElement('span'); tok.className = 'tm-tokens'; tok.textContent = r.totalTokensFmt;
      var meta = document.createElement('span'); meta.className = 'tm-meta';
      meta.textContent = r.costFmt + ' \u00b7 ' + r.sharePct + '%';
      row.appendChild(sw); row.appendChild(name); row.appendChild(tok); row.appendChild(meta);
      box.appendChild(row);
    });
  }

  function renderWeek(w) {
    var legend = document.getElementById('m-legend');
    var chart = document.getElementById('m-chart');
    var xrow = document.getElementById('m-chart-x');
    var cap = document.getElementById('m-chart-cap');
    var empty = document.getElementById('m-chart-empty');
    legend.textContent = ''; chart.textContent = ''; xrow.textContent = '';
    if (!w || !w.hasData) {
      legend.classList.add('hidden'); chart.classList.add('hidden'); xrow.classList.add('hidden');
      cap.classList.add('hidden'); empty.classList.remove('hidden');
      return;
    }
    legend.classList.remove('hidden'); chart.classList.remove('hidden'); xrow.classList.remove('hidden');
    cap.classList.remove('hidden'); empty.classList.add('hidden');

    (w.legend || []).forEach(function (l) {
      var item = document.createElement('span'); item.className = 'legend-item';
      var sw = document.createElement('span'); sw.className = 'legend-swatch'; sw.style.background = l.color;
      var nm = document.createElement('span'); nm.className = 'legend-name';
      nm.textContent = modelLabel(l.model); nm.title = modelLabel(l.model);
      item.appendChild(sw); item.appendChild(nm); legend.appendChild(item);
    });

    (w.days || []).forEach(function (d) {
      var col = document.createElement('div'); col.className = 'chart-col';
      col.title = d.dateLabel + ' \u00b7 ' + d.totalTokensFmt + ' tokens';
      var bar = document.createElement('div'); bar.className = 'chart-bar';
      if (d.segments && d.segments.length) {
        bar.style.height = Math.max(2, d.heightPct) + '%';
        d.segments.forEach(function (seg) {
          var s = document.createElement('div'); s.className = 'chart-seg';
          s.style.height = seg.pctOfDay + '%';
          s.style.background = seg.color;
          s.title = modelLabel(seg.model);
          bar.appendChild(s);
        });
      } else {
        bar.style.height = '2px';
        bar.style.background = 'var(--line)';
      }
      col.appendChild(bar);
      chart.appendChild(col);

      var xc = document.createElement('div'); xc.className = 'chart-xcol';
      xc.textContent = d.label;
      xrow.appendChild(xc);
    });

    cap.textContent = 'Busiest day ' + w.maxFmt + ' tokens \u00b7 last 7 days';
  }

  window.addEventListener('message', function (e) {
    var msg = e.data;
    if (!msg || msg.type !== 'state') { return; }
    renderSession(msg.session);
    var s = msg.state;
    if (!s) { return; }
    if (s.kind === 'measured') { renderMeasured(s); }
    else if (s.kind === 'setup') { renderSetup(s); }
    else if (s.kind === 'ready') { renderReady(s); }
    else if (s.kind === 'unavailable') { renderUnavailable(s); }
    else { show('computing'); }
  });

  document.addEventListener('click', function (e) {
    var t = e.target && e.target.closest ? e.target.closest('[data-action]') : null;
    if (!t) { return; }
    vscode.postMessage({ type: t.getAttribute('data-action') });
  });
}());
</script>
</body>
</html>`;
  }
}

/** Build the onboarding/setup state from the detected capabilities. */
function buildSetup(caps: Capabilities): ViewState {
  if (caps.level === 'none') {
    return {
      kind: 'setup',
      level: 'none',
      canEnable: false,
      title: 'Connect Copilot to measure cost',
      body: 'GitHub Copilot Chat isn’t available. Install it and sign in, then reopen this panel.',
    };
  }
  if (!caps.loggingSettingEnabled) {
    return {
      kind: 'setup',
      level: 'estimate',
      canEnable: true,
      title: 'Turn on real cost measurement',
      body:
        'CostLens reads Copilot’s own token logs to show the exact cost of this chat, ' +
        'no guessing. Enable token logging to switch it on.',
      hint: 'After enabling, send one chat message to start measuring.',
    };
  }
  return {
    kind: 'setup',
    level: 'estimate',
    canEnable: false,
    title: 'Almost there',
    body: 'Token logging is on, but no usage is recorded yet. Send a chat message, then refresh.',
    hint: caps.reason,
  };
}

function makeNonce(): string {
  const chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
  let s = '';
  for (let i = 0; i < 24; i++) {
    s += chars.charAt(Math.floor(Math.random() * chars.length));
  }
  return s;
}

function emptySession(): SessionView {
  return { turns: 0, tokensFmt: '0', costFmt: '$0' };
}
