import * as vscode from 'vscode';
import { makeNonce, buildCsp } from './webview';
import { type MeasuredView } from './panel';
import { type CacheMeasured } from './cache';
import { type ToolsMeasured } from './tools';
import { type PromptDetailView, type TopPromptsMeasured } from './prompts';
import { type GlobalTotals } from './global';

const CREDIT_USD = 0.01;

/** One scope's full payload (workspace or active session). */
export interface ScopePayload {
  measured: MeasuredView;
  cache: CacheMeasured | null;
  tools: ToolsMeasured | null;
  prompts: TopPromptsMeasured | null;
  /** Session title for the session hero (undefined for workspace). */
  sessionTitle?: string;
}

/** Setup/onboarding state when real measurement isn't available yet. */
export interface SetupPayload {
  canEnable: boolean;
  title: string;
  body: string;
  /** True for a hard block (no Copilot, or logging off): show the full-screen setup. When false
   * (logging on, just no data yet), the tabs are shown instead so the Global view stays reachable. */
  blocking: boolean;
}

/**
 * The unified Cost Lens dashboard: a single webview with three scope tabs (Global / Workspace /
 * Active session), each a bento grid of widgets, with collapsible Cache and Tools drill sections.
 * Replaces the former six separate panels. Data is pushed from the extension; the Global tab is
 * scanned on demand (it walks every workspace's logs).
 */
export class DashboardViewProvider implements vscode.WebviewViewProvider {
  public static readonly viewType = 'copilotControlPlane.dashboard';

  private view?: vscode.WebviewView;
  private workspace: ScopePayload | null = null;
  private session: ScopePayload | null = null;
  private setup: SetupPayload | null = null;
  private full = false;
  private globalOnly = false;

  constructor(
    private readonly extensionUri: vscode.Uri,
    private readonly onScanGlobal: () => Promise<GlobalTotals>,
    private readonly onPromptDetail: (id: string) => Promise<PromptDetailView | null>,
  ) {}

  resolveWebviewView(view: vscode.WebviewView): void {
    this.view = view;
    view.webview.options = { enableScripts: true, localResourceRoots: [this.extensionUri] };
    view.webview.html = this.html(view.webview);
    view.webview.onDidReceiveMessage((msg: { type?: string; id?: string }) => this.onMessage(msg));
    view.onDidChangeVisibility(() => {
      if (view.visible) {
        this.post();
        void vscode.commands.executeCommand('copilotControlPlane.refresh');
      }
    });
    this.post();
  }

  setCapability(full: boolean, setup: SetupPayload | null, globalOnly = false): void {
    this.full = full;
    this.setup = setup;
    this.globalOnly = globalOnly;
    this.post();
  }

  setScopes(workspace: ScopePayload | null, session: ScopePayload | null): void {
    this.workspace = workspace;
    this.session = session;
    this.post();
  }

  private async onMessage(msg: { type?: string; id?: string }): Promise<void> {
    switch (msg?.type) {
      case 'refresh':
        void vscode.commands.executeCommand('copilotControlPlane.refresh');
        return;
      case 'openSettings':
        void vscode.commands.executeCommand('workbench.action.openSettings', 'copilotCostLens');
        return;
      case 'enableLogging':
        void vscode.commands.executeCommand('copilotControlPlane.enableLogging');
        return;
      case 'scanGlobal': {
        const totals = await this.onScanGlobal();
        this.view?.webview.postMessage({ type: 'global', global: this.globalPayload(totals) });
        return;
      }
      case 'promptDetail': {
        if (!msg.id) {
          return;
        }
        const detail = await this.onPromptDetail(msg.id);
        this.view?.webview.postMessage({ type: 'promptDetail', id: msg.id, detail });
        return;
      }
      case 'ready':
        this.post();
        return;
    }
  }

  private globalPayload(t: GlobalTotals): unknown {
    const max = t.workspaces.reduce((m, w) => Math.max(m, w.credits), 0) || 1;
    return {
      totalCostFmt: fmtUSD(t.totalCredits * CREDIT_USD),
      totalCreditsFmt: fmtCredits(t.totalCredits),
      totalTokensFmt: fmtTokens(t.totalTokens),
      projectCount: t.workspaces.length,
      rows: t.workspaces.map((w) => ({
        name: w.name ?? w.hash.slice(0, 12),
        isHash: !w.name,
        costFmt: fmtUSD(w.credits * CREDIT_USD),
        creditsFmt: fmtCredits(w.credits),
        tokensFmt: fmtTokens(w.tokens),
        sessions: w.sessions,
        pct: (w.credits / max) * 100,
      })),
    };
  }

  private post(): void {
    if (!this.view) {
      return;
    }
    // The readable logs live wherever the VS Code server runs, so the Global tab only ever sees
    // that one environment. Tell the user what's out of view: a dev container sees only itself;
    // a local window can't see work done inside dev containers or WSL2 distros. Surface quietly.
    const envNote =
      vscode.env.remoteName === 'dev-container'
        ? 'Inside a dev container: figures cover this container only, not your whole machine.'
        : !vscode.env.remoteName
          ? 'Local view: work done inside dev containers or WSL2 instances is recorded separately and not shown here.'
          : null;
    this.view.webview.postMessage({
      type: 'state',
      full: this.full,
      setup: this.setup,
      globalOnly: this.globalOnly,
      envNote,
      workspace: this.workspace,
      session: this.session,
    });
  }

  private html(webview: vscode.Webview): string {
    const nonce = makeNonce();
    const csp = buildCsp(webview, nonce);
    return DASHBOARD_HTML(csp, nonce);
  }
}

function fmtTokens(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(n >= 10_000_000 ? 0 : 1)}M`;
  if (n >= 1_000) return `${(n / 1_000).toFixed(n >= 10_000 ? 0 : 1)}K`;
  return `${n}`;
}
function fmtCredits(n: number): string {
  return n >= 100 ? Math.round(n).toLocaleString('en-US') : n.toFixed(1);
}
function fmtUSD(n: number): string {
  return n < 0.01 && n > 0 ? '<$0.01' : `$${n.toFixed(2)}`;
}

function DASHBOARD_HTML(csp: string, nonce: string): string {
  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8" />
<meta http-equiv="Content-Security-Policy" content="${csp}" />
<meta name="viewport" content="width=device-width, initial-scale=1.0" />
<style>
  :root {
    --fg: var(--vscode-foreground);
    --fg-dim: var(--vscode-descriptionForeground, #8a8a92);
    --card: var(--vscode-editorWidget-background, rgba(128,128,128,0.10));
    --card-2: var(--vscode-editorHoverWidget-background, rgba(128,128,128,0.16));
    --line: var(--vscode-editorWidget-border, rgba(128,128,128,0.25));
    --accent: var(--vscode-charts-blue, #4c9aff);
    --ok: var(--vscode-charts-green, #4ade80);
    --warn: var(--vscode-charts-yellow, #fbbf24);
    --bad: var(--vscode-charts-red, #f87171);
    --purple: var(--vscode-charts-purple, #c084fc);
    --amber: #e6c07b;
  }
  * { box-sizing: border-box; margin: 0; padding: 0; }
  body { font-family: var(--vscode-font-family); color: var(--fg); font-size: 13px; line-height: 1.45; padding: 0; }

  .tabs { display: flex; gap: 6px; padding: 10px 12px; position: sticky; top: 0; background: var(--vscode-sideBar-background, var(--vscode-editor-background)); z-index: 9; border-bottom: 1px solid var(--line); }
  .envbar { display: none; padding: 6px 12px; font-size: 10.5px; line-height: 1.4; color: var(--fg-dim); opacity: .8; background: var(--vscode-sideBar-background, var(--vscode-editor-background)); border-bottom: 1px solid var(--line); letter-spacing: .01em; }
  .envbar.show { display: flex; align-items: center; gap: 6px; }
  .envbar::before { content: '\u2139'; font-size: 12px; opacity: .85; }
  .tab { flex: 1; text-align: center; padding: 8px 4px; font-size: 11px; font-weight: 700; color: var(--fg-dim); cursor: pointer; user-select: none; border-radius: 8px; text-transform: uppercase; letter-spacing: .04em; background: var(--card); border: 1px solid var(--line); transition: background .12s ease, color .12s ease; }
  .tab.active { color: #fff; background: var(--accent); border-color: var(--accent); box-shadow: 0 1px 4px rgba(0,0,0,.25); }
  .tab:hover:not(.active) { color: var(--fg); background: var(--card-2); }

  .page { padding: 4px 12px 24px; }
  .page.hidden { display: none; }
  .hidden { display: none !important; }
  .grid { display: grid; grid-template-columns: 1fr 1fr; gap: 10px; }
  .cell { background: var(--card); border: 1px solid var(--line); border-radius: 14px; padding: 14px; position: relative; overflow: hidden; }
  .cell.wide { grid-column: 1 / -1; }
  .label { font-size: 9.5px; text-transform: uppercase; letter-spacing: .06em; color: var(--fg-dim); font-weight: 700; }

  .hero .big { font-size: 38px; font-weight: 800; letter-spacing: -.03em; line-height: 1; margin-top: 6px; }
  .hero .sub { font-size: 11px; color: var(--fg-dim); margin-top: 6px; }
  .hero .glow { position: absolute; right: -30px; top: -30px; width: 120px; height: 120px; border-radius: 50%; background: radial-gradient(circle, color-mix(in srgb, var(--accent) 22%, transparent), transparent 70%); }

  .stat .num { font-size: 23px; font-weight: 800; margin-top: 8px; }
  .stat .cap { font-size: 11px; color: var(--fg-dim); margin-top: 1px; }

  .donut-title { margin-bottom: 4px; }
  .donut-wrap { display: flex; flex-direction: column; align-items: center; gap: 10px; margin-top: 8px; }
  .ring { width: 78px; height: 78px; border-radius: 50%; flex: 0 0 auto; display: grid; place-items: center; position: relative; }
  .ring::after { content: ""; width: 52px; height: 52px; border-radius: 50%; background: var(--card); }
  .ring .center { position: absolute; z-index: 1; text-align: center; }
  .ring .center b { font-size: 13px; font-weight: 800; display: block; line-height: 1; }
  .ring .center small { font-size: 8px; color: var(--fg-dim); }
  .leg { width: 100%; display: flex; flex-direction: column; gap: 4px; }
  .leg span { display: flex; align-items: center; gap: 6px; font-size: 10.5px; }
  .sw { width: 8px; height: 8px; border-radius: 2px; flex: 0 0 auto; }
  .leg .v { color: var(--fg-dim); margin-left: auto; font-variant-numeric: tabular-nums; }

  .week-bars { display: flex; align-items: flex-end; gap: 5px; height: 56px; margin-top: 10px; }
  .week-col { flex: 1; display: flex; flex-direction: column; justify-content: flex-end; gap: 2px; height: 100%; }
  .week-col i { display: block; border-radius: 2px; }
  .week-x { display: flex; gap: 5px; margin-top: 5px; }
  .week-x span { flex: 1; text-align: center; font-size: 8.5px; color: var(--fg-dim); }
  .week-legend { display: flex; flex-wrap: wrap; gap: 5px 12px; margin-top: 10px; }
  .week-legend span { display: flex; align-items: center; gap: 5px; font-size: 10px; color: var(--fg-dim); }

  .mini { margin-top: 8px; }
  .mini-row { display: flex; justify-content: space-between; align-items: center; gap: 8px; padding: 8px 0; font-size: 12px; border-bottom: 1px solid var(--line); }
  .mini-row:last-child { border-bottom: none; }
  .mini-row b { font-weight: 700; white-space: nowrap; }
  .mini-row .m { color: var(--fg-dim); font-size: 10.5px; }
  .mrow-l { display: flex; flex-direction: column; min-width: 0; }
  .mrow-l .nm { white-space: nowrap; overflow: hidden; text-overflow: ellipsis; font-weight: 600; }
  .mrow-l .nm.hash { font-family: var(--vscode-editor-font-family); font-weight: 400; opacity: .7; font-size: 11.5px; }
  .mrow-l .sub2 { font-size: 10px; color: var(--fg-dim); }

  .gauge { height: 8px; background: var(--line); border-radius: 4px; overflow: hidden; margin-top: 10px; }
  .gauge > i { display: block; height: 100%; background: var(--ok); }

  /* Forecast cell caption. */
  .allow-note { font-size: 10.5px; margin-top: 8px; color: var(--fg-dim); }

  .alert { background: color-mix(in srgb, var(--warn) 12%, var(--card)); border-color: color-mix(in srgb, var(--warn) 35%, var(--line)); }
  .alert.crit { background: color-mix(in srgb, var(--bad) 13%, var(--card)); border-color: color-mix(in srgb, var(--bad) 35%, var(--line)); }
  .alert .a-t { font-weight: 700; font-size: 12.5px; margin-top: 6px; }
  .alert .a-d { font-size: 10.5px; color: var(--fg-dim); margin-top: 3px; }
  .alert .a-opts { margin-top: 10px; display: flex; flex-direction: column; gap: 6px; }
  .alert .a-opt { display: flex; justify-content: space-between; align-items: center; gap: 10px;
    font-size: 12px; padding: 8px 11px; border-radius: 9px;
    background: var(--card); border: 1px solid var(--line); transition: border-color .12s ease, background .12s ease; }
  .alert .a-opt:hover { border-color: color-mix(in srgb, var(--ok) 45%, var(--line)); background: var(--card-2); }
  .alert .a-opt-l { font-weight: 600; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
  .alert .a-opt-r { display: flex; align-items: center; gap: 8px; flex: 0 0 auto; }
  .alert .a-opt-v { font-weight: 700; font-variant-numeric: tabular-nums; white-space: nowrap; }
  .alert .a-opt-b { font-size: 10px; font-weight: 700; white-space: nowrap; padding: 2px 7px; border-radius: 20px;
    color: var(--ok); background: color-mix(in srgb, var(--ok) 16%, transparent);
    border: 1px solid color-mix(in srgb, var(--ok) 35%, transparent); }
  .alert .a-m { font-size: 17px; font-weight: 800; color: var(--warn); margin-top: 6px; }
  .alert.crit .a-m { color: var(--bad); }

  /* Tips collapsed into a single "Ways to save" drill at the top of the Session tab. */
  .drill.tips-span { grid-column: 1 / -1; }
  .drill.tip { background: color-mix(in srgb, var(--warn) 9%, var(--card)); border-color: color-mix(in srgb, var(--warn) 30%, var(--line)); }
  .drill.tip .drill-ico { background: color-mix(in srgb, var(--warn) 18%, transparent); }
  .alert.tip-item { background: var(--card); border: 1px solid var(--line); border-radius: 11px; padding: 12px 13px; }
  .alert.tip-item + .tip-item { margin-top: 10px; }
  .alert.tip-item.crit { border-color: color-mix(in srgb, var(--bad) 35%, var(--line)); }
  .tip-item .a-t { margin-top: 0; }

  .segbar { display: flex; height: 9px; border-radius: 5px; overflow: hidden; background: var(--line); margin-top: 10px; }
  .segbar > span { height: 100%; }

  .drill { background: var(--card); border: 1px solid var(--line); border-radius: 14px; overflow: hidden; }
  .drill + .drill { margin-top: 10px; }
  .drill-head { display: flex; align-items: center; gap: 12px; padding: 13px 14px; cursor: pointer; user-select: none; }
  .drill-head:hover { background: var(--card-2); }
  .drill-ico { width: 32px; height: 32px; border-radius: 9px; display: grid; place-items: center; font-size: 15px; flex: 0 0 auto; background: var(--card-2); }
  .drill-body { flex: 1 1 auto; min-width: 0; }
  .drill-t { font-weight: 600; font-size: 13px; }
  .drill-d { font-size: 11px; color: var(--fg-dim); }
  .drill-chev { color: var(--fg-dim); font-size: 13px; transition: transform .18s ease; flex: 0 0 auto; }
  .drill.open .drill-chev { transform: rotate(90deg); }
  .drill-panel { display: none; padding: 4px 14px 16px; border-top: 1px solid var(--line); }
  .drill.open .drill-panel { display: block; }
  .faq-q { font-weight: 600; font-size: 12px; margin: 12px 0 4px; }
  .faq-q:first-child { margin-top: 6px; }
  .faq-a { font-size: 11.5px; color: var(--fg-dim); line-height: 1.5; }
  .drow { display: flex; align-items: center; gap: 10px; padding: 9px 0; border-bottom: 1px solid var(--line); font-size: 12px; }
  .drow:last-child { border: none; }
  .drow .dot { width: 9px; height: 9px; border-radius: 3px; flex: 0 0 auto; }
  .drow .nm { flex: 1; font-weight: 600; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
  .drow .vl { font-weight: 700; white-space: nowrap; }
  .drow .mt { color: var(--fg-dim); font-weight: 400; font-size: 10.5px; }
  .drill .sec { font-size: 10px; text-transform: uppercase; letter-spacing: .05em; color: var(--fg-dim); margin: 14px 0 6px; font-weight: 700; }
  .drills { margin-top: 10px; }

  .prow { display: flex; align-items: center; gap: 11px; padding: 10px 8px; border-radius: 9px; cursor: pointer; border-bottom: 1px solid var(--line); }
  .prow:last-child { border-bottom: none; }
  .prow:hover { background: var(--card-2); }
  .prow .prank { font-weight: 700; font-size: 11px; color: var(--fg-dim); width: 22px; flex: 0 0 auto; text-align: right; }
  .prow .pbody { flex: 1 1 auto; min-width: 0; }
  .prow .ptext { font-size: 12px; font-weight: 600; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
  .prow .pmeta { font-size: 10px; color: var(--fg-dim); margin-top: 2px; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
  .prow .pbar { height: 4px; border-radius: 3px; background: var(--card-2); margin-top: 6px; overflow: hidden; }
  .prow .pbar > i { display: block; height: 100%; background: var(--accent); }
  .prow .pcost { flex: 0 0 auto; text-align: right; min-width: 64px; }
  .prow .pcost b { font-size: 13px; font-weight: 700; }
  .prow .pcost small { display: block; font-size: 9.5px; color: var(--fg-dim); }

  .overlay { display: none; position: fixed; inset: 0; z-index: 50; background: rgba(0,0,0,.55); }
  .overlay.show { display: block; }
  .overlay-card { position: absolute; inset: 0; display: flex; flex-direction: column; background: var(--vscode-sideBar-background, var(--vscode-editor-background)); }
  .overlay-bar { display: flex; align-items: center; justify-content: space-between; padding: 10px 12px; border-bottom: 1px solid var(--line); position: sticky; top: 0; background: var(--vscode-sideBar-background, var(--vscode-editor-background)); }
  .overlay-title { font-weight: 700; font-size: 12px; text-transform: uppercase; letter-spacing: .04em; }
  .ov-x { padding: 5px 10px; }
  .overlay-body { padding: 14px 14px 28px; overflow: auto; }
  .od-hero { padding: 4px 0 12px; }
  .od-hero .label { font-size: 10px; text-transform: uppercase; letter-spacing: .05em; color: var(--fg-dim); font-weight: 700; }
  .od-hero .big { font-size: 26px; font-weight: 800; margin-top: 2px; }
  .od-hero .sub { font-size: 11px; color: var(--fg-dim); margin-top: 4px; }
  .od-stats { display: grid; grid-template-columns: repeat(4, 1fr); gap: 8px; margin: 6px 0 4px; }
  .od-stat { background: var(--card); border: 1px solid var(--line); border-radius: 10px; padding: 8px; text-align: center; }
  .od-k { font-size: 9.5px; text-transform: uppercase; letter-spacing: .04em; color: var(--fg-dim); font-weight: 700; }
  .od-v { font-size: 14px; font-weight: 700; margin-top: 2px; }
  .od-text { white-space: pre-wrap; word-break: break-word; font-family: var(--vscode-editor-font-family, monospace); font-size: 11.5px; line-height: 1.5; background: var(--card); border: 1px solid var(--line); border-radius: 10px; padding: 10px 12px; max-height: 320px; overflow: auto; color: var(--fg); }
  .od-tools { display: flex; flex-wrap: wrap; gap: 6px; }
  .chip { font-size: 10.5px; background: var(--card-2); border: 1px solid var(--line); border-radius: 20px; padding: 3px 9px; color: var(--fg); }
  .od-calls { margin-top: 4px; }
  .od-call { display: flex; align-items: center; gap: 10px; padding: 9px 0; border-bottom: 1px solid var(--line); }
  .od-call:last-child { border-bottom: none; }
  .oc-l { flex: 0 0 auto; min-width: 0; }
  .oc-model { font-size: 11.5px; font-weight: 600; }
  .oc-when { font-size: 9.5px; color: var(--fg-dim); }
  .oc-tok { flex: 1 1 auto; font-size: 10px; color: var(--fg-dim); white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
  .od-call b { font-size: 12px; flex: 0 0 auto; }
  .od-note { font-size: 10.5px; color: var(--fg-dim); line-height: 1.5; margin-top: 14px; font-style: italic; }

  .cell.hero.clickable { cursor: pointer; }
  .cell.hero.clickable:hover { border-color: color-mix(in srgb, var(--accent) 45%, var(--line)); }
  .hero .hero-cta { display: inline-flex; align-items: center; gap: 5px; margin-top: 10px; font-size: 10.5px; font-weight: 600; color: var(--accent); }
  .od-cards { display: grid; grid-template-columns: repeat(2, 1fr); gap: 10px; margin: 2px 0 14px; }
  .od-card { background: var(--card); border: 1px solid var(--line); border-radius: 12px; padding: 12px 14px; }
  .od-card .k { font-size: 9.5px; text-transform: uppercase; letter-spacing: .05em; color: var(--fg-dim); font-weight: 700; display: flex; align-items: center; gap: 6px; }
  .od-card .k .sw { width: 9px; height: 9px; border-radius: 3px; }
  .od-card .v { font-size: 24px; font-weight: 800; letter-spacing: -.02em; margin-top: 3px; }
  .od-card .c { font-size: 10.5px; color: var(--fg-dim); margin-top: 3px; }
  .spend-chart { width: 100%; height: auto; display: block; }
  .spend-chart .grid-line { stroke: var(--line); stroke-width: 1; }
  .spend-chart .axis-label { fill: var(--fg-dim); font-size: 10px; }
  .spend-tip { position: fixed; z-index: 50; pointer-events: none; max-width: 240px;
    background: var(--vscode-editorHoverWidget-background, #252526);
    color: var(--vscode-editorHoverWidget-foreground, #cccccc);
    border: 1px solid var(--vscode-editorHoverWidget-border, #454545);
    border-radius: 4px; padding: 5px 8px; font-size: 11px; line-height: 1.45;
    box-shadow: 0 2px 8px rgba(0,0,0,0.4); white-space: nowrap; opacity: 0; transition: opacity .08s; }
  .spend-tip.show { opacity: 1; }
  .spend-tip .tt { font-weight: 600; }
  .spend-tip .td { color: var(--fg-dim); }
  .spend-legend { display: flex; gap: 18px; flex-wrap: wrap; margin-top: 12px; font-size: 11px; color: var(--fg-dim); }
  .spend-legend span { display: inline-flex; align-items: center; gap: 7px; }
  .spend-legend .sw { width: 12px; height: 12px; border-radius: 3px; flex: 0 0 auto; }
  .spend-legend .sw.dash { background: repeating-linear-gradient(90deg, var(--accent) 0 3px, transparent 3px 6px); }

  .state { text-align: center; padding: 40px 18px; }
  .state .big { font-size: 30px; margin-bottom: 12px; }
  .state .t { font-weight: 700; font-size: 15px; margin-bottom: 8px; }
  .state .b { font-size: 12px; color: var(--fg-dim); line-height: 1.5; margin-bottom: 16px; }
  .btn { cursor: pointer; border: none; border-radius: 6px; padding: 8px 14px; font-size: 12px; font-weight: 600; color: var(--vscode-button-foreground); background: var(--vscode-button-background); }
  .btn:hover { background: var(--vscode-button-hoverBackground); }
  .btn.ghost { background: transparent; border: 1px solid var(--line); color: var(--fg); }
  .empty { text-align: center; color: var(--fg-dim); font-size: 12px; padding: 30px 12px; }
  .note { font-size: 10.5px; color: var(--fg-dim); margin-top: 14px; line-height: 1.5; }
  .footer { display: flex; justify-content: flex-end; margin-top: 14px; }
</style>
</head>
<body>
  <div id="setup" class="state hidden">
    <div class="big">&#128274;</div>
    <div class="t" id="setup-title">Almost there</div>
    <div class="b" id="setup-body">-</div>
    <button id="setup-enable" class="btn hidden" data-action="enableLogging">Enable token logging</button>
    <button class="btn ghost" data-action="refresh">&#8635; Refresh</button>
  </div>

  <div id="main" class="hidden">
    <div id="envbar" class="envbar"></div>
    <div class="tabs">
      <div class="tab" data-tab="g">Global</div>
      <div class="tab active" data-tab="w">Workspace</div>
      <div class="tab" data-tab="s">Session</div>
    </div>
    <div class="page" id="page-w"></div>
    <div class="page hidden" id="page-s"></div>
    <div class="page hidden" id="page-g"></div>
  </div>

  <div id="overlay" class="overlay">
    <div class="overlay-card">
      <div class="overlay-bar">
        <div id="overlay-title" class="overlay-title">Prompt detail</div>
        <button id="overlay-close" class="btn ghost ov-x">\u2715 Close</button>
      </div>
      <div id="overlay-body" class="overlay-body"></div>
    </div>
  </div>

<script nonce="${nonce}">
${DASHBOARD_JS}
</script>
</body>
</html>`;
}

/* The webview script. Kept as a plain string so esbuild doesn't try to bundle DOM globals. */
const DASHBOARD_JS = String.raw`
(function () {
  var vscode = acquireVsCodeApi();
  var state = { full: false, setup: null, globalOnly: false, envNote: null, workspace: null, session: null, global: null };
  var activeTab = 'w';
  var didGlobalRedirect = false;
  /** Open/closed state of each collapsible drill, keyed by title, kept across re-renders. */
  var drillOpen = {};

  function el(tag, cls, txt) { var e = document.createElement(tag); if (cls) e.className = cls; if (txt != null) e.textContent = txt; return e; }
  function ring(segs, centerB, centerS) {
    var stops = [], acc = 0;
    segs.forEach(function (s) { var from = acc; acc += s.pct; stops.push(s.color + ' ' + from + '% ' + acc + '%'); });
    var r = el('div', 'ring');
    r.style.background = 'conic-gradient(' + stops.join(',') + ')';
    var c = el('div', 'center'); var b = el('b', null, centerB); var sm = el('small', null, centerS);
    c.appendChild(b); c.appendChild(sm); r.appendChild(c); return r;
  }
  function legend(segs) {
    var l = el('div', 'leg');
    segs.forEach(function (s) {
      var row = el('span');
      var sw = el('span', 'sw'); sw.style.background = s.color;
      var name = el('span', null, s.label);
      var v = el('span', 'v', s.valueFmt + (s.note ? ' \u00B7 ' + s.note : ''));
      row.appendChild(sw); row.appendChild(name); row.appendChild(v); l.appendChild(row);
    });
    return l;
  }
  function donutCell(title, segs, centerB, centerS) {
    var cell = el('div', 'cell');
    cell.appendChild(el('div', 'label donut-title', title));
    var wrap = el('div', 'donut-wrap');
    wrap.appendChild(ring(segs, centerB, centerS));
    wrap.appendChild(legend(segs));
    cell.appendChild(wrap);
    return cell;
  }
  function segOf(mix, label) { for (var i=0;i<mix.length;i++){ if (mix[i].label===label) return mix[i]; } return null; }

  function drill(icon, title, desc, openByDefault, buildPanel) {
    var open = drillOpen.hasOwnProperty(title) ? drillOpen[title] : openByDefault;
    var d = el('div', 'drill' + (open ? ' open' : ''));
    var head = el('div', 'drill-head');
    var ico = el('div', 'drill-ico', icon);
    var body = el('div', 'drill-body');
    body.appendChild(el('div', 'drill-t', title));
    body.appendChild(el('div', 'drill-d', desc));
    var chev = el('div', 'drill-chev', '\u203A');
    head.appendChild(ico); head.appendChild(body); head.appendChild(chev);
    head.addEventListener('click', function () { d.classList.toggle('open'); drillOpen[title] = d.classList.contains('open'); });
    var panel = el('div', 'drill-panel');
    buildPanel(panel);
    d.appendChild(head); d.appendChild(panel);
    return d;
  }

  function promptsDrill(prompts, openByDefault) {
    if (!prompts || !prompts.rows || !prompts.rows.length) return null;
    var top = prompts.rows[0];
    var desc = prompts.totalPrompts + ' prompt' + (prompts.totalPrompts === 1 ? '' : 's') + ' \u00B7 priciest ' + top.costFmt;
    return drill('\uD83D\uDCB8', 'Priciest prompts', desc, openByDefault, function (panel) {
      panel.appendChild(secEl('Most expensive first \u00B7 click a prompt for full detail'));
      prompts.rows.forEach(function (r) {
        var row = el('div', 'prow');
        row.title = 'Click for full detail';
        row.appendChild(el('span', 'prank', '#' + r.rank));
        var body = el('div', 'pbody');
        body.appendChild(el('div', 'ptext', r.text));
        body.appendChild(el('div', 'pmeta', r.modelLabel + ' \u00B7 ' + r.calls + ' call' + (r.calls === 1 ? '' : 's') + ' \u00B7 ' + r.tokensFmt + ' tokens \u00B7 ' + r.whenFmt + (r.estimated ? ' \u00B7 ~est' : '')));
        var bar = el('div', 'pbar'); var bi = el('i'); bi.style.width = Math.max(2, r.pct) + '%'; bar.appendChild(bi); body.appendChild(bar);
        row.appendChild(body);
        var cost = el('div', 'pcost'); cost.appendChild(el('b', null, r.costFmt)); cost.appendChild(el('small', null, r.creditsFmt !== '-' ? r.creditsFmt + ' cr' : 'est')); row.appendChild(cost);
        row.addEventListener('click', function () { openPromptDetail(r.id); });
        panel.appendChild(row);
      });
    });
  }

  function openPromptDetail(id) {
    document.getElementById('overlay-title').textContent = 'Prompt detail';
    document.getElementById('overlay').classList.add('show');
    var b = document.getElementById('overlay-body'); b.textContent = '';
    b.appendChild(el('div', 'empty', 'Loading detail\u2026'));
    vscode.postMessage({ type: 'promptDetail', id: id });
  }
  function closeOverlay() { hideSpendTip(); document.getElementById('overlay').classList.remove('show'); }
  function renderPromptDetail(d) {
    var b = document.getElementById('overlay-body'); b.textContent = '';
    if (!d) { b.appendChild(el('div', 'empty', 'Detail unavailable for this prompt.')); return; }
    var h = el('div', 'od-hero');
    h.appendChild(el('div', 'label', 'Prompt cost'));
    h.appendChild(el('div', 'big', d.costFmt));
    h.appendChild(el('div', 'sub', (d.creditsFmt !== '-' ? d.creditsFmt + ' credits \u00B7 ' : '') + d.totalTokensFmt + ' tokens \u00B7 ' + d.modelLabel + ' \u00B7 ' + d.whenFmt + (d.estimated ? ' \u00B7 estimated' : '')));
    b.appendChild(h);
    var sg = el('div', 'od-stats');
    [['Input', d.inputFmt], ['Cached', d.cachedFmt], ['Output', d.outputFmt], ['Reasoning', d.reasoningFmt]].forEach(function (s) {
      var c = el('div', 'od-stat'); c.appendChild(el('div', 'od-k', s[0])); c.appendChild(el('div', 'od-v', s[1])); sg.appendChild(c);
    });
    b.appendChild(sg);
    b.appendChild(el('div', 'sec', 'Prompt'));
    b.appendChild(el('pre', 'od-text', d.promptText));
    b.appendChild(el('div', 'sec', 'Response'));
    b.appendChild(el('pre', 'od-text', d.responseText || '(no visible reply logged)'));
    if (d.toolCalls && d.toolCalls.length) {
      b.appendChild(el('div', 'sec', 'Tools used'));
      var tl = el('div', 'od-tools');
      d.toolCalls.forEach(function (t) { tl.appendChild(el('span', 'chip', t.name + ' ' + t.countFmt)); });
      b.appendChild(tl);
    }
    b.appendChild(el('div', 'sec', d.calls.length + ' model call' + (d.calls.length === 1 ? '' : 's')));
    var tbl = el('div', 'od-calls');
    d.calls.forEach(function (c) {
      var row = el('div', 'od-call');
      var l = el('div', 'oc-l'); l.appendChild(el('div', 'oc-model', c.model + (c.effort ? ' \u00B7 ' + c.effort : ''))); l.appendChild(el('div', 'oc-when', c.whenFmt));
      row.appendChild(l);
      row.appendChild(el('div', 'oc-tok', 'in ' + c.inputFmt + ' \u00B7 cache ' + c.cachedFmt + ' \u00B7 out ' + c.outputFmt + ' \u00B7 reason ' + c.reasoningFmt));
      row.appendChild(el('b', null, c.costFmt));
      tbl.appendChild(row);
    });
    b.appendChild(tbl);
    b.appendChild(el('div', 'od-note', 'Reasoning tokens are estimated (billed output minus visible reply). The model\u2019s private reasoning text is never logged, so it can\u2019t be shown.'));
  }

  function cacheDrill(cache, openByDefault) {
    if (!cache || !cache.sessions || !cache.sessions.length) return null;
    var s = cache.sessions[0];
    return drill('\uD83D\uDDC4\uFE0F', 'Cache', s.hitRateFmt + ' hit \u00B7 ' + s.contextFmt + ' prefix re-sent each turn', openByDefault, function (panel) {
      panel.appendChild(secEl("What's in the cached prefix \u00B7 " + s.contextFmt));
      var bar = el('div', 'segbar');
      s.composition.forEach(function (c) { var sp = el('span'); sp.style.width = Math.max(0, c.pct) + '%'; sp.style.background = c.color; bar.appendChild(sp); });
      panel.appendChild(bar);
      panel.appendChild(legendRows(s.composition));
      if (s.toolGroups && s.toolGroups.length) {
        panel.appendChild(secEl('Tool schemas by source'));
        s.toolGroups.forEach(function (g) { panel.appendChild(drowEl(g.color, g.label, g.note, g.tokensFmt)); });
      }
    });
  }
  function toolsDrill(tools, openByDefault) {
    if (!tools) return null;
    var idle = (tools.tools || []).filter(function (t) { return !t.used; }).length;
    return drill('\uD83D\uDD27', 'Tools', tools.ratioFmt + ' used \u00B7 ' + idle + ' idle', openByDefault, function (panel) {
      var g = el('div', 'gauge'); g.style.marginTop = '12px'; var gi = el('i'); gi.style.width = Math.max(0, tools.usedPct) + '%'; g.appendChild(gi); panel.appendChild(g);
      var used = (tools.tools || []).filter(function (t) { return t.used; });
      var notUsed = (tools.tools || []).filter(function (t) { return !t.used; });
      if (used.length) { panel.appendChild(secEl('Used')); used.slice(0, 12).forEach(function (t) { panel.appendChild(drowEl(null, t.name, null, t.callsFmt)); }); }
      if (notUsed.length) {
        panel.appendChild(secEl('Not used \u00B7 ' + notUsed.length + ' tools, still cost prefix tokens each turn'));
        notUsed.slice(0, 40).forEach(function (t) {
          var row = el('div', 'drow');
          var nm = el('span', 'nm mt', t.name); row.appendChild(nm);
          panel.appendChild(row);
        });
        if (notUsed.length > 40) { panel.appendChild(drowEl(null, '+' + (notUsed.length - 40) + ' more', null, null)); }
      }
    });
  }
  function secEl(t) { return el('div', 'sec', t); }
  function faqDrill() {
    var items = [
      ['Where do the numbers come from?', 'Measured from GitHub Copilot\u2019s own on-disk request logs, not guessed. Input, output, cached counts, credits and cache hit are read exactly from the logs. The prefix split (system / tools / history) and reasoning estimate are counted with the model\u2019s tiktoken tokenizer.'],
      ['Why three tabs (Global / Workspace / Session)?', 'Some numbers are cumulative across your whole project (or machine); others belong to a single chat. Keeping them on separate tabs avoids misreading cost. Global = all workspaces, Workspace = this project, Session = the active chat.'],
      ['Why does a brand-new chat already show thousands of tokens?', 'Your message is never sent alone. Every request carries a hidden prefix: Copilot\u2019s system prompt, the schema of every enabled tool, and your environment. So even \u201CHello\u201D costs the baseline prefix.'],
      ['Why is cached usage larger than the model\u2019s context window?', 'The context window is the most one single request can carry. The cached number is the sum across every request in the session, so a long chat re-sending the prefix each turn adds up well beyond one window.'],
      ['What counts as the \u201Cactive\u201D session?', 'VS Code doesn\u2019t expose which chat is focused, so it\u2019s the session with the most recent request. A new chat becomes active once you send the first message (within ~10s).'],
      ['Why fewer sessions than my chat sidebar?', 'The sidebar is VS Code\u2019s own history. This extension only measures chats that wrote request logs while logging was on. Chats from before logging was enabled, or before a dev-container rebuild, have no logs.'],
      ['How is reasoning cost worked out?', 'Reasoning tokens aren\u2019t logged separately, so they\u2019re estimated as billed output minus the visible reply. Effort detection is vendor-specific: GPT and Opus expose it; Gemini and Sonnet/Haiku don\u2019t.'],
      ['Where do the model prices come from?', 'Per-model prices are read live from Copilot\u2019s own model catalog (models.json) that ships beside the logs, so they track GitHub\u2019s current rates and any new models automatically. Headline cost is anchored to billed credits when the log records them; prices only shape the breakdown and the cheaper-model estimate.'],
    ];
    return drill('\u2754', 'FAQ', 'how the numbers work', false, function (panel) {
      items.forEach(function (it) {
        panel.appendChild(el('div', 'faq-q', it[0]));
        panel.appendChild(el('div', 'faq-a', it[1]));
      });
    });
  }

  function legendRows(rows) {
    var l = el('div', 'leg'); l.style.marginTop = '10px';
    rows.forEach(function (r) {
      var row = el('span'); var sw = el('span', 'sw'); sw.style.background = r.color;
      row.appendChild(sw); row.appendChild(el('span', null, r.label)); row.appendChild(el('span', 'v', r.tokensFmt)); l.appendChild(row);
    });
    return l;
  }
  function drowEl(color, name, meta, val) {
    var row = el('div', 'drow');
    if (color) { var dot = el('span', 'dot'); dot.style.background = color; row.appendChild(dot); }
    var nm = el('span', 'nm'); nm.textContent = name; if (meta) { var m = el('span', 'mt', ' ' + meta); nm.appendChild(m); } row.appendChild(nm);
    if (val != null) row.appendChild(el('span', 'vl', val));
    return row;
  }

  function heroCell(label, big, sub, onClick) {
    var cell = el('div', 'cell wide hero');
    cell.appendChild(el('div', 'glow'));
    cell.appendChild(el('div', 'label', label));
    cell.appendChild(el('div', 'big', big));
    cell.appendChild(el('div', 'sub', sub));
    if (onClick) {
      cell.classList.add('clickable');
      cell.title = 'View spend over time';
      var cta = el('div', 'hero-cta');
      cta.appendChild(document.createTextNode('\uD83D\uDCC8 View spend over time'));
      cta.appendChild(el('span', 'drill-chev', '\u203A'));
      cell.appendChild(cta);
      cell.addEventListener('click', onClick);
    }
    return cell;
  }
  function statCell(label, num, cap, color) {
    var cell = el('div', 'cell stat');
    cell.appendChild(el('div', 'label', label));
    var n = el('div', 'num', num); if (color) n.style.color = color; cell.appendChild(n);
    cell.appendChild(el('div', 'cap', cap));
    return cell;
  }

  // Tips collapsed into one "Ways to save" drill at the top of the Session tab. Collapsed by
  // default; the header carries the tip count and the best percentage saving so it still sells.
  function tipCard(tip) {
    var c = el('div', 'tip-item alert' + (tip.tone === 'bad' ? ' crit' : ''));
    c.appendChild(el('div', 'a-t', '\u26A0 ' + tip.title));
    c.appendChild(el('div', 'a-d', tip.detail));
    if (tip.options && tip.options.length) {
      var opts = el('div', 'a-opts');
      tip.options.forEach(function (o) {
        var row = el('div', 'a-opt');
        row.appendChild(el('span', 'a-opt-l', o.label));
        var right = el('span', 'a-opt-r');
        right.appendChild(el('span', 'a-opt-v', o.value));
        if (o.badge) right.appendChild(el('span', 'a-opt-b', o.badge));
        row.appendChild(right);
        opts.appendChild(row);
      });
      c.appendChild(opts);
    }
    if (tip.metric) c.appendChild(el('div', 'a-m', tip.metric));
    return c;
  }
  function tipsDrill(tips) {
    var open = drillOpen.hasOwnProperty('Ways to save') ? drillOpen['Ways to save'] : false;
    var d = el('div', 'drill tip tips-span' + (open ? ' open' : ''));
    var head = el('div', 'drill-head');
    head.appendChild(el('div', 'drill-ico', '\uD83D\uDCA1'));
    var body = el('div', 'drill-body');
    body.appendChild(el('div', 'drill-t', 'Ways to save'));
    body.appendChild(el('div', 'drill-d', tips.length + ' recommendation' + (tips.length === 1 ? '' : 's') + ' to optimize cost'));
    head.appendChild(body);
    head.appendChild(el('div', 'drill-chev', '\u203A'));
    head.addEventListener('click', function () { d.classList.toggle('open'); drillOpen['Ways to save'] = d.classList.contains('open'); });
    var panel = el('div', 'drill-panel');
    tips.forEach(function (tip) { panel.appendChild(tipCard(tip)); });
    d.appendChild(head); d.appendChild(panel);
    return d;
  }

  // ----- WORKSPACE -----
  function renderWorkspace(p) {
    var page = document.getElementById('page-w');
    page.textContent = '';
    if (!p) { page.appendChild(emptyEl('No workspace usage recorded yet. Send a Copilot message, then Refresh.')); return; }
    var m = p.measured, grid = el('div', 'grid');
    var sessWord = m.sessions === 1 ? 'session' : 'sessions';
    var onSpend = m.spendChart && m.spendChart.hasData ? function () { openSpendChart(m); } : null;
    grid.appendChild(heroCell('Workspace spend', m.costFmt, m.creditsFmt + ' credits \u00B7 ' + m.totalTokensFmt + ' tokens \u00B7 ' + m.sessions + ' ' + sessWord, onSpend));
    if (m.budget && m.budget.hasForecast) grid.appendChild(forecastCell(m.budget));
    grid.appendChild(donutCell('Token distribution', m.tokenMix, m.totalTokensFmt, ''));
    grid.appendChild(donutCell('Cost distribution', m.costMix, m.costFmt, ''));
    if (m.costByModel && m.costByModel.length) grid.appendChild(donutCell('Cost by model', m.costByModel, m.costFmt, ''));
    var hit = p.cache && p.cache.sessions && p.cache.sessions.length ? p.cache.sessions[0].hitRateFmt : '\u2014';
    grid.appendChild(statCell('Cache hit rate', hit, 'exact, from logs', 'var(--ok)'));
    var rseg = segOf(m.costMix, 'Reasoning');
    grid.appendChild(statCell('Reasoning', rseg ? rseg.valueFmt : '\u2014', rseg ? rseg.pctFmt + ' of spend' : '', 'var(--purple)'));
    if (m.avgPerPromptFmt && m.avgPerPromptFmt !== '-') grid.appendChild(statCell('Avg per prompt', m.avgPerPromptFmt, m.avgPerPromptCap, 'var(--accent)'));
    if (m.showWeek && m.week && m.week.hasData) grid.appendChild(weekCell(m.week));
    if (m.topModels && m.topModels.length) grid.appendChild(topModelsCell(m.topModels));
    page.appendChild(grid);

    var drills = el('div', 'drills');
    var pr = promptsDrill(p.prompts, false); if (pr) drills.appendChild(pr);
    var c = cacheDrill(p.cache, false); if (c) drills.appendChild(c);
    var t = toolsDrill(p.tools, false); if (t) drills.appendChild(t);
    drills.appendChild(faqDrill());
    page.appendChild(drills);
    page.appendChild(footer());
  }

  // ----- SESSION -----
  function renderSession(p) {
    var page = document.getElementById('page-s');
    page.textContent = '';
    if (!p) { page.appendChild(emptyEl('No active session yet. Send a Copilot message in this chat, then Refresh.')); return; }
    var m = p.measured, grid = el('div', 'grid');
    var title = p.sessionTitle || (p.cache && p.cache.sessions && p.cache.sessions[0] ? p.cache.sessions[0].title : 'Active session');
    var onSpend = m.spendChart && m.spendChart.hasData ? function () { openSpendChart(m); } : null;
    grid.appendChild(heroCell('Active session', m.costFmt, '\u201C' + title + '\u201D \u00B7 ' + m.creditsFmt + ' credits \u00B7 ' + m.totalTokensFmt + ' tokens', onSpend));

    if (m.tips && m.tips.length) grid.appendChild(tipsDrill(m.tips));

    grid.appendChild(donutCell('Token distribution', m.tokenMix, m.totalTokensFmt, ''));
    grid.appendChild(donutCell('Cost distribution', m.costMix, m.costFmt, ''));
    var hit = p.cache && p.cache.sessions && p.cache.sessions.length ? p.cache.sessions[0].hitRateFmt : '\u2014';
    grid.appendChild(statCell('Cache hit rate', hit, 'exact, this session', 'var(--ok)'));
    var rseg = segOf(m.costMix, 'Reasoning');
    grid.appendChild(statCell('Reasoning', rseg ? rseg.valueFmt : '\u2014', rseg ? rseg.pctFmt + ' of spend' : '', 'var(--purple)'));
    if (m.avgPerPromptFmt && m.avgPerPromptFmt !== '-') grid.appendChild(statCell('Avg per prompt', m.avgPerPromptFmt, m.avgPerPromptCap, 'var(--accent)'));
    if (m.costByModel && m.costByModel.length > 1) grid.appendChild(donutCell('Cost by model', m.costByModel, m.costFmt, ''));
    page.appendChild(grid);

    var drills = el('div', 'drills');
    var pr = promptsDrill(p.prompts, false); if (pr) drills.appendChild(pr);
    var c = cacheDrill(p.cache, false); if (c) drills.appendChild(c);
    var t = toolsDrill(p.tools, false); if (t) drills.appendChild(t);
    drills.appendChild(faqDrill());
    page.appendChild(drills);
    page.appendChild(footer());
  }

  // ----- GLOBAL -----
  function renderGlobal(g) {
    var page = document.getElementById('page-g');
    page.textContent = '';
    if (!g) {
      var s = el('div', 'empty', 'Scanning all workspaces\u2026');
      page.appendChild(s);
      if (activeTab === 'g') vscode.postMessage({ type: 'scanGlobal' });
      return;
    }
    var grid = el('div', 'grid');
    grid.appendChild(heroCell('All workspaces', g.totalCostFmt, g.totalCreditsFmt + ' credits \u00B7 ' + g.totalTokensFmt + ' tokens \u00B7 ' + g.projectCount + ' projects'));
    grid.appendChild(statCell('Projects', String(g.projectCount), 'with usage'));
    grid.appendChild(statCell('Total tokens', g.totalTokensFmt, 'all projects'));
    var cell = el('div', 'cell wide');
    cell.appendChild(el('div', 'label', 'By project'));
    var mini = el('div', 'mini');
    (g.rows || []).forEach(function (r) {
      var row = el('div', 'mini-row');
      var l = el('div', 'mrow-l');
      var nm = el('div', 'nm' + (r.isHash ? ' hash' : '')); nm.textContent = r.name; nm.title = r.name;
      var sub = el('div', 'sub2', r.tokensFmt + ' tokens \u00B7 ' + r.creditsFmt + ' credits');
      l.appendChild(nm); l.appendChild(sub);
      row.appendChild(l); row.appendChild(el('b', null, r.costFmt));
      mini.appendChild(row);
    });
    if (!(g.rows || []).length) mini.appendChild(el('div', 'empty', 'No Copilot usage found in any workspace yet.'));
    cell.appendChild(mini);
    grid.appendChild(cell);
    page.appendChild(grid);
    page.appendChild(footer(true));
  }

  function weekCell(w) {
    var cell = el('div', 'cell wide');
    cell.appendChild(el('div', 'label', 'This week \u00B7 tokens by model'));
    var bars = el('div', 'week-bars');
    w.days.forEach(function (d) {
      var col = el('div', 'week-col');
      d.segments.forEach(function (s) { var i = el('i'); i.style.height = Math.max(0, (s.pctOfDay * d.heightPct) / 100) + '%'; i.style.background = s.color; col.appendChild(i); });
      bars.appendChild(col);
    });
    cell.appendChild(bars);
    var x = el('div', 'week-x');
    w.days.forEach(function (d) { x.appendChild(el('span', null, d.label)); });
    cell.appendChild(x);
    var lg = el('div', 'week-legend');
    w.legend.forEach(function (m) { var s = el('span'); var sw = el('span', 'sw'); sw.style.background = m.color; s.appendChild(sw); s.appendChild(document.createTextNode(m.model)); lg.appendChild(s); });
    cell.appendChild(lg);
    return cell;
  }
  function topModelsCell(rows) {
    var cell = el('div', 'cell wide');
    cell.appendChild(el('div', 'label', 'Top models'));
    var mini = el('div', 'mini');
    rows.forEach(function (r) {
      var row = el('div', 'mini-row');
      var l = el('div', 'mrow-l');
      l.appendChild(el('div', 'nm', r.model));
      l.appendChild(el('div', 'sub2', r.totalTokensFmt + ' tokens \u00B7 ' + r.requests + ' calls'));
      row.appendChild(l); row.appendChild(el('b', null, r.costFmt));
      mini.appendChild(row);
    });
    cell.appendChild(mini);
    return cell;
  }
  // Forecast: projected month-end spend at the current pace.
  function forecastCell(b) {
    var cell = el('div', 'cell stat');
    cell.appendChild(el('div', 'label', 'Forecast \u00B7 ' + b.monthLabel));
    cell.appendChild(el('div', 'num', b.projectedSpendFmt));
    cell.appendChild(el('div', 'cap', b.projectedNote));
    if (b.paceNote) cell.appendChild(el('div', 'allow-note', b.paceNote));
    return cell;
  }

  // ----- SPEND-OVER-TIME CHART (opened from the Spend card) -----
  var SVGNS = 'http://www.w3.org/2000/svg';
  function svg(tag, attrs) {
    var e = document.createElementNS(SVGNS, tag);
    if (attrs) { for (var k in attrs) { if (attrs.hasOwnProperty(k)) e.setAttribute(k, attrs[k]); } }
    return e;
  }
  // Azure-style accumulated-cost area chart: solid filled area for actual spend (day 1 -> today),
  // a lighter filled area with a dashed line for the forecast (today -> month-end).
  function spendChartSvg(c) {
    var W = 720, H = 300, padL = 52, padR = 16, padT = 14, padB = 26;
    var plotW = W - padL - padR, plotH = H - padT - padB;
    var days = c.daysInMonth, axisMax = c.axisMax || 1;
    function xFor(day) { return padL + (days > 1 ? (day - 1) / (days - 1) : 0) * plotW; }
    function yFor(v) { return padT + plotH - (axisMax > 0 ? v / axisMax : 0) * plotH; }
    var base = yFor(0);
    var s = svg('svg', { viewBox: '0 0 ' + W + ' ' + H, 'class': 'spend-chart' });

    // Horizontal gridlines + y-axis ($) labels.
    c.yTicks.forEach(function (t) {
      var y = yFor(t.value);
      s.appendChild(svg('line', { 'class': 'grid-line', x1: padL, y1: y, x2: W - padR, y2: y }));
      var lbl = svg('text', { 'class': 'axis-label', x: padL - 8, y: y + 3, 'text-anchor': 'end' });
      lbl.textContent = t.label; s.appendChild(lbl);
    });

    // X-axis day marks (roughly every 4-5 days, plus the last day of the month).
    var step = days > 28 ? 5 : 4;
    var marks = [];
    for (var d = 1; d <= days; d += step) marks.push(d);
    if (marks[marks.length - 1] !== days) marks.push(days);
    marks.forEach(function (d) {
      var t = svg('text', { 'class': 'axis-label', x: xFor(d), y: H - 8, 'text-anchor': 'middle' });
      t.textContent = String(d); s.appendChild(t);
    });

    function areaPath(pts) {
      var d = 'M ' + xFor(pts[0].day) + ' ' + base;
      pts.forEach(function (p) { d += ' L ' + xFor(p.day) + ' ' + yFor(p.value); });
      d += ' L ' + xFor(pts[pts.length - 1].day) + ' ' + base + ' Z';
      return d;
    }
    function linePath(pts) {
      var d = '';
      pts.forEach(function (p, i) { d += (i ? ' L ' : 'M ') + xFor(p.day) + ' ' + yFor(p.value); });
      return d;
    }

    // Forecast first (drawn under the actual line where they meet).
    if (c.forecast && c.forecast.length > 1) {
      s.appendChild(svg('path', { d: areaPath(c.forecast), fill: 'var(--ok)', 'fill-opacity': '0.10' }));
      s.appendChild(svg('path', { d: linePath(c.forecast), fill: 'none', stroke: 'var(--accent)', 'stroke-width': '2', 'stroke-dasharray': '5 4' }));
    }
    if (c.actual && c.actual.length) {
      s.appendChild(svg('path', { d: areaPath(c.actual), fill: 'var(--ok)', 'fill-opacity': '0.28' }));
      s.appendChild(svg('path', { d: linePath(c.actual), fill: 'none', stroke: 'var(--ok)', 'stroke-width': '2' }));
    }

    // Per-day dots, each with a floating tooltip showing that day's cost on hover.
    function dot(p, color, isForecast) {
      var cx = xFor(p.day), cy = yFor(p.value);
      var grp = svg('g');
      var hit = svg('circle', { cx: cx, cy: cy, r: '9', fill: 'transparent', style: 'cursor:pointer' });
      var d = svg('circle', { cx: cx, cy: cy, r: '3', fill: color, stroke: 'var(--vscode-editor-background, #1e1e1e)', 'stroke-width': '1.2', 'pointer-events': 'none' });
      var head = isForecast ? (p.valueFmt + ' projected') : (p.valueFmt + ' total');
      var sub = isForecast
        ? (p.label + ' \u00B7 +' + p.dayValueFmt + '/day')
        : (p.label + ' \u00B7 ' + p.dayValueFmt + ' that day');
      var html = '<div class="tt">' + head + '</div><div class="td">' + sub + '</div>';
      hit.addEventListener('mousemove', function (e) { showSpendTip(e, html); });
      hit.addEventListener('mouseleave', hideSpendTip);
      grp.appendChild(hit); grp.appendChild(d);
      return grp;
    }
    if (c.forecast) { c.forecast.forEach(function (p, i) { if (i > 0) s.appendChild(dot(p, 'var(--accent)', true)); }); }
    if (c.actual) { c.actual.forEach(function (p) { s.appendChild(dot(p, 'var(--ok)', false)); }); }
    return s;
  }
  var _spendTipEl = null;
  function spendTipEl() {
    if (!_spendTipEl) { _spendTipEl = document.createElement('div'); _spendTipEl.className = 'spend-tip'; document.body.appendChild(_spendTipEl); }
    return _spendTipEl;
  }
  function showSpendTip(e, html) {
    var tip = spendTipEl();
    tip.innerHTML = html;
    tip.classList.add('show');
    var r = tip.getBoundingClientRect();
    var x = e.clientX + 14, y = e.clientY + 14;
    if (x + r.width > window.innerWidth - 8) x = e.clientX - r.width - 14;
    if (y + r.height > window.innerHeight - 8) y = e.clientY - r.height - 14;
    tip.style.left = x + 'px'; tip.style.top = y + 'px';
  }
  function hideSpendTip() {
    if (_spendTipEl) _spendTipEl.classList.remove('show');
  }
  function openSpendChart(m) {
    var c = m.spendChart;
    document.getElementById('overlay-title').textContent = 'Spend over time';
    document.getElementById('overlay').classList.add('show');
    var b = document.getElementById('overlay-body'); b.textContent = '';
    if (!c || !c.hasData) { b.appendChild(el('div', 'empty', 'Not enough month data yet to chart spend.')); return; }
    var cards = el('div', 'od-cards');
    var c1 = el('div', 'od-card');
    var k1 = el('div', 'k'); var sw1 = el('span', 'sw'); sw1.style.background = 'var(--ok)';
    k1.appendChild(sw1); k1.appendChild(document.createTextNode('Actual cost \u00B7 ' + c.monthLabel));
    c1.appendChild(k1); c1.appendChild(el('div', 'v', c.actualTotalFmt)); c1.appendChild(el('div', 'c', 'month to date'));
    var c2 = el('div', 'od-card');
    var k2 = el('div', 'k'); var sw2 = el('span', 'sw'); sw2.style.background = 'var(--accent)';
    k2.appendChild(sw2); k2.appendChild(document.createTextNode('Forecast'));
    c2.appendChild(k2); c2.appendChild(el('div', 'v', c.forecastTotalFmt)); c2.appendChild(el('div', 'c', c.paceNote || 'projected month-end'));
    cards.appendChild(c1); cards.appendChild(c2);
    b.appendChild(cards);
    b.appendChild(spendChartSvg(c));
    var lg = el('div', 'spend-legend');
    var a = el('span'); var asw = el('span', 'sw'); asw.style.background = 'var(--ok)';
    a.appendChild(asw); a.appendChild(document.createTextNode('Accumulated cost')); lg.appendChild(a);
    var f = el('span'); var fsw = el('span', 'sw dash'); f.appendChild(fsw);
    f.appendChild(document.createTextNode('Forecast cost')); lg.appendChild(f);
    b.appendChild(lg);
    b.appendChild(el('div', 'od-note', 'Each day\u2019s spend is the billed total apportioned by that day\u2019s token share. Hover a dot for that day\u2019s cost. The forecast is a straight line at the month\u2019s average daily pace, extended to month-end.'));
    if (m.costByModel && m.costByModel.length) {
      var cm = donutCell('Cost by model', m.costByModel, m.costFmt, '');
      cm.style.marginTop = '14px';
      b.appendChild(cm);
    }
  }
  function emptyEl(t) { return el('div', 'empty', t); }
  function footer(noRefresh) {
    var f = el('div', 'footer');
    if (!noRefresh) { var b = el('button', 'btn ghost', '\u21BB Refresh'); b.addEventListener('click', function () { vscode.postMessage({ type: 'refresh' }); }); f.appendChild(b); }
    else { var b2 = el('button', 'btn ghost', '\u21BB Rescan'); b2.addEventListener('click', function () { state.global = null; renderGlobal(null); }); f.appendChild(b2); }
    var s = el('button', 'btn ghost', '\u2699 Settings'); s.addEventListener('click', function () { vscode.postMessage({ type: 'openSettings' }); }); f.appendChild(s);
    return f;
  }

  function setTab(t) {
    activeTab = t;
    ['w', 's', 'g'].forEach(function (id) { document.getElementById('page-' + id).classList.toggle('hidden', id !== t); });
    document.querySelectorAll('.tab').forEach(function (el) { el.classList.toggle('active', el.getAttribute('data-tab') === t); });
    if (t === 'g' && !state.global) renderGlobal(null);
  }

  function renderAll() {
    var setup = document.getElementById('setup'), main = document.getElementById('main');
    // Full-screen setup only for a hard block (no Copilot, or logging off). A non-blocking setup
    // (logging on, just no data yet) still shows the tabs so the Global view stays reachable.
    if (!state.full && !state.globalOnly && state.setup && state.setup.blocking) {
      setup.classList.remove('hidden'); main.classList.add('hidden');
      document.getElementById('setup-title').textContent = state.setup.title;
      document.getElementById('setup-body').textContent = state.setup.body;
      document.getElementById('setup-enable').classList.toggle('hidden', !state.setup.canEnable);
      return;
    }
    setup.classList.add('hidden'); main.classList.remove('hidden');
    var envbar = document.getElementById('envbar');
    envbar.textContent = state.envNote || '';
    envbar.classList.toggle('show', !!state.envNote);
    var waiting = !state.full && !state.globalOnly && state.setup ? state.setup.body : null;
    if (state.globalOnly) {
      var pw = document.getElementById('page-w'); pw.textContent = '';
      pw.appendChild(emptyEl('Open a folder or workspace to measure cost for this project.'));
      var ps = document.getElementById('page-s'); ps.textContent = '';
      ps.appendChild(emptyEl('Open a folder or workspace to measure the active session.'));
      // First time in this no-folder state, land on the Global tab (the one with real data),
      // but leave Workspace/Session clickable so their message is reachable.
      if (!didGlobalRedirect) { didGlobalRedirect = true; setTab('g'); }
    } else if (waiting) {
      // Logging is on but no usage recorded for this workspace yet. Show the waiting note in the
      // Workspace/Session tabs and land on Global, which can still show other projects' data.
      var pw2 = document.getElementById('page-w'); pw2.textContent = ''; pw2.appendChild(emptyEl(waiting));
      var ps2 = document.getElementById('page-s'); ps2.textContent = ''; ps2.appendChild(emptyEl(waiting));
      if (!didGlobalRedirect) { didGlobalRedirect = true; setTab('g'); }
    } else {
      didGlobalRedirect = false;
      renderWorkspace(state.workspace);
      renderSession(state.session);
    }
    renderGlobal(state.global);
  }

  document.addEventListener('click', function (e) {
    var tab = e.target && e.target.closest ? e.target.closest('[data-tab]') : null;
    if (tab) { setTab(tab.getAttribute('data-tab')); return; }
    var act = e.target && e.target.closest ? e.target.closest('[data-action]') : null;
    if (act) { vscode.postMessage({ type: act.getAttribute('data-action') }); }
  });

  window.addEventListener('message', function (e) {
    var msg = e.data;
    if (!msg) return;
    if (msg.type === 'state') {
      state.full = msg.full; state.setup = msg.setup; state.globalOnly = msg.globalOnly; state.envNote = msg.envNote; state.workspace = msg.workspace; state.session = msg.session;
      // New usage just arrived (the poller only pushes on real change), so the cached Global
      // snapshot is now stale. Drop it: the Global tab rescans on demand when it's next viewed,
      // keeping it from showing a smaller, older total than the live Workspace tab.
      state.global = null;
      renderAll();
    } else if (msg.type === 'global') {
      state.global = msg.global; renderGlobal(state.global);
    } else if (msg.type === 'promptDetail') {
      renderPromptDetail(msg.detail);
    }
  });

  document.getElementById('overlay-close').addEventListener('click', closeOverlay);
  document.getElementById('overlay').addEventListener('click', function (e) {
    if (e.target && e.target.id === 'overlay') closeOverlay();
  });

  vscode.postMessage({ type: 'ready' });
}());
`;
