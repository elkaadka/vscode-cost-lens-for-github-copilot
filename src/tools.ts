import * as vscode from 'vscode';
import { Capabilities } from './capabilities';

/** One tool row in the Tools section. */
export interface ToolRow {
  name: string;
  /** "(built-in)" or the MCP server id. */
  group: string;
  used: boolean;
  /** Invocation count, formatted (e.g. "3"); empty when unused. */
  callsFmt: string;
}

/** The measured Tools view: how many of the available tools were actually used, and which. */
export interface ToolsMeasured {
  /** e.g. "9 / 57": distinct tools used over tools available. */
  ratioFmt: string;
  /** Share of available tools that were used, 0–100 (bar width). */
  usedPct: number;
  /** Headline sentence summarising tool usage. */
  headline: string;
  /** Total tool invocations across all sessions, formatted. */
  totalCallsFmt: string;
  /** Every available tool, used ones first. */
  tools: ToolRow[];
  /** Tools invoked but not in the live schema (rare); empty when none. */
  unknownUsed: string[];
}

type ToolsState =
  | { kind: 'computing' }
  | { kind: 'waiting'; reason: string }
  | ({ kind: 'measured' } & ToolsMeasured);

/** Renders the "Tools" section: which of the available tools were actually used vs idle. */
export class ToolsViewProvider implements vscode.WebviewViewProvider {
  public static readonly viewType = 'copilotControlPlane.toolsView';

  private view?: vscode.WebviewView;
  private latest: ToolsState = { kind: 'computing' };
  private measured?: ToolsMeasured;
  private caps?: Capabilities;

  constructor(private readonly extensionUri: vscode.Uri) {}

  resolveWebviewView(view: vscode.WebviewView): void {
    this.view = view;
    view.webview.options = { enableScripts: true, localResourceRoots: [this.extensionUri] };
    view.webview.html = this.html(view.webview);
    view.webview.onDidReceiveMessage((msg: { type?: string }) => this.onMessage(msg));
    view.onDidChangeVisibility(() => {
      if (view.visible) {
        this.post();
        void vscode.commands.executeCommand('copilotControlPlane.refresh');
      }
    });
    this.post();
  }

  /** Gate on measurement: tool usage only makes sense once we can read real usage. */
  setCapabilities(caps: Capabilities): void {
    this.caps = caps;
    if (caps.level === 'full') {
      this.latest = this.measured ? { kind: 'measured', ...this.measured } : { kind: 'computing' };
    } else {
      this.latest = {
        kind: 'waiting',
        reason:
          'Tool usage appears once cost measurement is active. Open the Cost Explorer above to finish setup.',
      };
    }
    this.post();
  }

  /** Push a freshly computed tools breakdown. */
  update(view: ToolsMeasured): void {
    this.measured = view;
    if (this.caps?.level === 'full') {
      this.latest = { kind: 'measured', ...view };
      this.post();
    }
  }

  private onMessage(msg: { type?: string }): void {
    if (msg?.type === 'refresh') {
      void vscode.commands.executeCommand('copilotControlPlane.refresh');
    }
  }

  private post(): void {
    this.view?.webview.postMessage({ type: 'state', state: this.latest });
  }

  private html(webview: vscode.Webview): string {
    const nonce = makeNonce();
    const csp = [
      `default-src 'none'`,
      `style-src ${webview.cspSource} 'unsafe-inline'`,
      `script-src 'nonce-${nonce}'`,
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
    --accent: var(--vscode-charts-blue, #3794ff);
    --card: var(--vscode-editorWidget-background, rgba(128,128,128,0.08));
    --line: var(--vscode-editorWidget-border, rgba(128,128,128,0.25));
  }
  * { box-sizing: border-box; }
  body { font-family: var(--vscode-font-family); color: var(--vscode-foreground); font-size: 13px; padding: 12px 12px 18px; margin: 0; }
  .hidden { display: none !important; }

  .state { text-align: center; padding: 26px 12px; }
  .state .big { font-size: 30px; margin-bottom: 10px; }
  .muted { opacity: .72; font-size: 12px; line-height: 1.5; }

  .hero { display: flex; align-items: baseline; gap: 8px; margin-bottom: 4px; }
  #t-ratio { font-size: 28px; font-weight: 700; line-height: 1; }
  .hero-unit { font-size: 10px; text-transform: uppercase; letter-spacing: .04em; opacity: .65; }
  .headline { font-size: 12px; line-height: 1.5; opacity: .9; margin-bottom: 12px; }

  .bar { display: flex; height: 14px; border-radius: 7px; overflow: hidden; background: var(--line); margin: 2px 0 16px; }
  .seg { height: 100%; background: var(--accent); }

  .section-title { font-size: 11px; text-transform: uppercase; letter-spacing: .04em; opacity: .7; margin: 0 0 8px; }
  .rows { display: flex; flex-direction: column; gap: 5px; margin-bottom: 18px; }
  .row { display: flex; align-items: center; gap: 8px; font-size: 12px; }
  .dot { width: 8px; height: 8px; border-radius: 50%; flex: 0 0 auto; }
  .r-name { font-weight: 600; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; flex: 1 1 auto; min-width: 0; font-family: var(--vscode-editor-font-family, monospace); font-size: 11.5px; }
  .row.idle .r-name { font-weight: 400; opacity: .55; }
  .r-grp { white-space: nowrap; opacity: .5; font-size: 10.5px; }
  .r-calls { white-space: nowrap; opacity: .9; min-width: 28px; text-align: right; }

  .note { font-size: 11px; line-height: 1.45; opacity: .62; margin: 0 0 14px; }
  .actions { display: flex; gap: 8px; }
  .btn { flex: 1; cursor: pointer; border: none; border-radius: 5px; padding: 7px 10px; font-size: 12px; font-weight: 600; color: var(--vscode-button-foreground); background: var(--vscode-button-background); }
  .btn:hover { background: var(--vscode-button-hoverBackground); }
</style>
</head>
<body>
  <div id="computing" class="state"><div class="muted">Analyzing tools&hellip;</div></div>

  <div id="waiting" class="state hidden">
    <div class="big">&#128274;</div>
    <div id="waiting-reason" class="muted">-</div>
  </div>

  <div id="measured" class="hidden">
    <div class="hero"><span id="t-ratio">-</span><span class="hero-unit">tools used</span></div>
    <div id="t-headline" class="headline">-</div>
    <div class="bar"><div id="t-bar-seg" class="seg" style="width:0%"></div></div>

    <div class="section-title">Used</div>
    <div id="t-used" class="rows"></div>

    <div class="section-title">Not used</div>
    <div id="t-idle" class="rows"></div>

    <div class="note">
      Tools used are counted from tool-call spans; the total is the tool schema sent with the most
      recent request. Every available tool&rsquo;s JSON schema is part of the cached prefix, so
      unused tools still cost input tokens each turn; disabling ones you never use trims that.
    </div>
    <div class="actions"><button class="btn" data-action="refresh">&#8635; Refresh</button></div>
  </div>

<script nonce="${nonce}">
(function () {
  var vscode = acquireVsCodeApi();
  function show(id) {
    ['computing', 'waiting', 'measured'].forEach(function (s) {
      var el = document.getElementById(s);
      if (el) { el.classList.toggle('hidden', s !== id); }
    });
  }
  function renderRows(boxId, rows, idle) {
    var box = document.getElementById(boxId);
    box.textContent = '';
    (rows || []).forEach(function (r) {
      var row = document.createElement('div'); row.className = idle ? 'row idle' : 'row';
      var dot = document.createElement('span'); dot.className = 'dot';
      dot.style.background = idle ? 'var(--line)' : 'var(--ok)';
      var nm = document.createElement('span'); nm.className = 'r-name'; nm.textContent = r.name; nm.title = r.name;
      var grp = document.createElement('span'); grp.className = 'r-grp'; grp.textContent = r.group;
      row.appendChild(dot); row.appendChild(nm); row.appendChild(grp);
      if (!idle) {
        var calls = document.createElement('span'); calls.className = 'r-calls'; calls.textContent = r.callsFmt;
        row.appendChild(calls);
      }
      box.appendChild(row);
    });
  }
  function renderMeasured(s) {
    show('measured');
    document.getElementById('t-ratio').textContent = s.ratioFmt;
    document.getElementById('t-headline').textContent = s.headline;
    document.getElementById('t-bar-seg').style.width = Math.max(0, Math.min(100, s.usedPct)) + '%';
    var tools = s.tools || [];
    renderRows('t-used', tools.filter(function (t) { return t.used; }), false);
    renderRows('t-idle', tools.filter(function (t) { return !t.used; }), true);
  }
  window.addEventListener('message', function (e) {
    var msg = e.data;
    if (!msg || msg.type !== 'state') { return; }
    var s = msg.state;
    if (!s) { return; }
    if (s.kind === 'measured') { renderMeasured(s); }
    else if (s.kind === 'waiting') { show('waiting'); document.getElementById('waiting-reason').textContent = s.reason; }
    else { show('computing'); }
  });
  document.addEventListener('click', function (e) {
    var t = e.target && e.target.closest ? e.target.closest('[data-action]') : null;
    if (t) { vscode.postMessage({ type: t.getAttribute('data-action') }); }
  });
}());
</script>
</body>
</html>`;
  }
}

function makeNonce(): string {
  const chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
  let out = '';
  for (let i = 0; i < 32; i++) {
    out += chars.charAt(Math.floor(Math.random() * chars.length));
  }
  return out;
}
