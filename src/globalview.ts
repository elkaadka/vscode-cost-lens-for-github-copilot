import * as vscode from 'vscode';
import { GlobalTotals, scanGlobalTotals, workspaceStorageBase } from './global';

const CREDIT_USD = 0.01;

/** Format a token count compactly (e.g. 1.2M, 845K, 312). */
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

function fmtAgo(ts: number): string {
  const s = Math.max(0, Math.round((Date.now() - ts) / 1000));
  if (s < 5) return 'just now';
  if (s < 60) return `${s}s ago`;
  const m = Math.round(s / 60);
  if (m < 60) return `${m} min ago`;
  return `${Math.round(m / 60)}h ago`;
}

interface RowView {
  name: string;
  isHash: boolean;
  creditsFmt: string;
  costFmt: string;
  tokensFmt: string;
  sessions: number;
  pct: number;
}
interface GlobalView {
  totalCreditsFmt: string;
  totalCostFmt: string;
  totalTokensFmt: string;
  workspaceCount: number;
  scannedAt: string;
  rows: RowView[];
}

function buildView(t: GlobalTotals): GlobalView {
  const max = t.workspaces.reduce((m, w) => Math.max(m, w.credits), 0) || 1;
  return {
    totalCreditsFmt: fmtCredits(t.totalCredits),
    totalCostFmt: fmtUSD(t.totalCredits * CREDIT_USD),
    totalTokensFmt: fmtTokens(t.totalTokens),
    workspaceCount: t.workspaces.length,
    scannedAt: fmtAgo(t.scannedAt),
    rows: t.workspaces.map((w) => ({
      name: w.name ?? w.hash.slice(0, 12),
      isHash: !w.name,
      creditsFmt: fmtCredits(w.credits),
      costFmt: fmtUSD(w.credits * CREDIT_USD),
      tokensFmt: fmtTokens(w.tokens),
      sessions: w.sessions,
      pct: (w.credits / max) * 100,
    })),
  };
}

/**
 * "Cost Explorer · Global" webview: a machine-wide credit + token total with a per-workspace
 * breakdown. On-demand only it scans on open and on the Refresh button, never on a timer.
 */
export class GlobalViewProvider implements vscode.WebviewViewProvider {
  public static readonly viewType = 'copilotControlPlane.globalView';

  private view?: vscode.WebviewView;
  private busy = false;

  constructor(
    private readonly extensionUri: vscode.Uri,
    private readonly context: vscode.ExtensionContext,
  ) {}

  resolveWebviewView(view: vscode.WebviewView): void {
    this.view = view;
    view.webview.options = { enableScripts: true, localResourceRoots: [this.extensionUri] };
    view.webview.html = this.html(view.webview);
    view.webview.onDidReceiveMessage((msg: { type?: string }) => {
      if (msg?.type === 'refresh') {
        void this.scan();
      }
    });
    view.onDidChangeVisibility(() => {
      if (view.visible) {
        void this.scan();
      }
    });
    void this.scan();
  }

  private async scan(): Promise<void> {
    if (this.busy || !this.view) {
      return;
    }
    this.busy = true;
    this.view.webview.postMessage({ type: 'state', state: { kind: 'scanning' } });
    try {
      const base = workspaceStorageBase(this.context);
      const totals = await scanGlobalTotals(base);
      this.view.webview.postMessage({ type: 'state', state: { kind: 'ready', ...buildView(totals) } });
    } catch {
      this.view.webview.postMessage({ type: 'state', state: { kind: 'error' } });
    } finally {
      this.busy = false;
    }
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
    --accent: var(--vscode-charts-blue, #3794ff);
    --ok: var(--vscode-charts-green, #3fb950);
    --card: var(--vscode-editorWidget-background, rgba(128,128,128,0.08));
    --line: var(--vscode-editorWidget-border, rgba(128,128,128,0.25));
  }
  * { box-sizing: border-box; }
  body { font-family: var(--vscode-font-family); color: var(--vscode-foreground); font-size: 13px; padding: 12px 12px 18px; margin: 0; }
  .hidden { display: none !important; }
  .muted { opacity: .68; font-size: 12px; line-height: 1.5; }
  .state { text-align: center; padding: 24px 12px; }

  /* Hero: dollar cost is the headline, credits + tokens as supporting stats. */
  .hero { margin-bottom: 14px; }
  .hero-cost { font-size: 30px; font-weight: 700; line-height: 1.05; }
  .hero-label { font-size: 10px; text-transform: uppercase; letter-spacing: .05em; opacity: .6; margin-top: 2px; }
  .hero-stats { display: flex; gap: 18px; margin-top: 12px; }
  .stat { display: flex; flex-direction: column; gap: 1px; }
  .stat-val { font-size: 15px; font-weight: 600; }
  .stat-cap { font-size: 9.5px; text-transform: uppercase; letter-spacing: .04em; opacity: .55; }
  .scanline { font-size: 10.5px; opacity: .45; margin-top: 10px; }

  .section-title { font-size: 11px; text-transform: uppercase; letter-spacing: .04em; opacity: .7; margin: 18px 0 8px; }
  .rows { display: flex; flex-direction: column; gap: 8px; }
  .row { position: relative; padding: 9px 11px; border: 1px solid var(--line); border-radius: 8px; background: var(--card); overflow: hidden; }
  .row-bar { position: absolute; left: 0; top: 0; bottom: 0; background: color-mix(in srgb, var(--accent) 14%, transparent); z-index: 0; }
  .row-top { position: relative; z-index: 1; display: flex; align-items: baseline; justify-content: space-between; gap: 10px; }
  .row-name { font-weight: 600; font-size: 13px; flex: 1 1 auto; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .row-name.hash { font-family: var(--vscode-editor-font-family); font-weight: 400; opacity: .65; font-size: 11.5px; }
  .row-cost { font-weight: 700; font-size: 14px; white-space: nowrap; flex: 0 0 auto; }
  .row-sub { position: relative; z-index: 1; font-size: 11px; opacity: .6; margin-top: 3px; }

  .actions { display: flex; gap: 8px; margin-top: 18px; }
  .btn { flex: 1; cursor: pointer; border: none; border-radius: 5px; padding: 8px 10px; font-size: 12px; font-weight: 600; color: var(--vscode-button-foreground); background: var(--vscode-button-background); }
  .btn:hover { background: var(--vscode-button-hoverBackground); }
  .note { font-size: 11px; line-height: 1.45; opacity: .55; margin: 14px 0 0; }
</style>
</head>
<body>
  <div id="scanning" class="state"><div class="muted">Scanning all workspaces&hellip;</div></div>
  <div id="error" class="state hidden"><div class="muted">Couldn&rsquo;t read workspace storage on this machine.</div></div>
  <div id="empty" class="state hidden"><div class="muted">No Copilot usage found in any workspace yet.</div></div>

  <div id="ready" class="hidden">
    <div class="hero">
      <div class="hero-cost" id="g-cost">-</div>
      <div class="hero-label">total Copilot spend, all workspaces</div>
      <div class="hero-stats">
        <div class="stat"><span class="stat-val" id="g-credits">-</span><span class="stat-cap">AI credits</span></div>
        <div class="stat"><span class="stat-val" id="g-tokens">-</span><span class="stat-cap">tokens</span></div>
        <div class="stat"><span class="stat-val" id="g-count">-</span><span class="stat-cap">workspaces</span></div>
      </div>
      <div class="scanline">scanned <span id="g-scanned">-</span></div>
    </div>

    <div class="section-title">By workspace</div>
    <div id="g-rows" class="rows"></div>

    <div class="actions"><button class="btn" data-action="refresh">&#8635; Rescan</button></div>
    <div class="note">
      Totals are summed across every workspace&rsquo;s Copilot request logs on this machine. Credits
      are exact (1 credit = $0.01). Workspaces show their folder name where available, otherwise the
      storage id. Scanned on demand, not continuously.
    </div>
  </div>

<script nonce="${nonce}">
(function () {
  var vscode = acquireVsCodeApi();
  function show(id) {
    ['scanning','error','empty','ready'].forEach(function (s) {
      var el = document.getElementById(s);
      if (el) { el.classList.toggle('hidden', s !== id); }
    });
  }
  function renderReady(s) {
    if (!s.rows || !s.rows.length) { show('empty'); return; }
    show('ready');
    document.getElementById('g-credits').textContent = s.totalCreditsFmt;
    document.getElementById('g-cost').textContent = s.totalCostFmt;
    document.getElementById('g-tokens').textContent = s.totalTokensFmt;
    document.getElementById('g-count').textContent = s.workspaceCount;
    document.getElementById('g-scanned').textContent = s.scannedAt;
    var box = document.getElementById('g-rows');
    box.textContent = '';
    s.rows.forEach(function (r) {
      var row = document.createElement('div'); row.className = 'row';
      var bar = document.createElement('div'); bar.className = 'row-bar'; bar.style.width = Math.max(0, r.pct) + '%';
      var top = document.createElement('div'); top.className = 'row-top';
      var name = document.createElement('span'); name.className = 'row-name' + (r.isHash ? ' hash' : ''); name.textContent = r.name; name.title = r.name;
      var cost = document.createElement('span'); cost.className = 'row-cost'; cost.textContent = r.costFmt;
      top.appendChild(name); top.appendChild(cost);
      var sub = document.createElement('div'); sub.className = 'row-sub';
      var sessWord = r.sessions === 1 ? 'session' : 'sessions';
      sub.textContent = r.creditsFmt + ' credits \u00b7 ' + r.tokensFmt + ' tokens \u00b7 ' + r.sessions + ' ' + sessWord;
      row.appendChild(bar); row.appendChild(top); row.appendChild(sub);
      box.appendChild(row);
    });
  }
  window.addEventListener('message', function (e) {
    var msg = e.data;
    if (!msg || msg.type !== 'state' || !msg.state) { return; }
    var s = msg.state;
    if (s.kind === 'ready') { renderReady(s); }
    else if (s.kind === 'error') { show('error'); }
    else { show('scanning'); }
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
