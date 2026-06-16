import * as vscode from 'vscode';
import { Capabilities } from './capabilities';

/** One row in the cache prefix composition (System / Tools / History) or the tool-group list. */
export interface CacheRow {
  label: string;
  /** Resolved CSS color for the bar segment + swatch. */
  color: string;
  /** Share of the relevant whole, 0–100. */
  pct: number;
  /** Token count, formatted (e.g. "377K"). */
  tokensFmt: string;
  /** Share label, e.g. "95%" / "1.1%". */
  pctFmt: string;
  /** Optional sub-detail, e.g. "3 tools". */
  note?: string;
}

/** The measured cache view for one chat session: hit rate, prefix composition, and tool breakdown. */
export interface SessionCacheView {
  /** Short session id for display (first 8 chars). */
  id: string;
  /** Title, e.g. "Active session" for the current chat, else "Session 1a2b3c4d". */
  title: string;
  /** Sub-line, e.g. "4 requests · last active 2 min ago". */
  meta: string;
  /** True for the active (most-recently-used) session; expanded by default. */
  active: boolean;
  /** Cache hit rate across this session's requests, e.g. "92%". */
  hitRateFmt: string;
  /** Headline sentence describing this session's cached prefix. */
  headline: string;
  /** The live prefix size (most recent request input), formatted. */
  contextFmt: string;
  /** Composition of the prefix: System / Tools / History, summing to context. */
  composition: CacheRow[];
  /** Tool schema tokens grouped by built-in vs MCP server, largest first. */
  toolGroups: CacheRow[];
  /** Individual tools by schema size, largest first (capped for display). */
  topTools: CacheRow[];
  /** Estimated $ the cache saved vs paying full input rate for the cached tokens. */
  savedFmt: string;
}

/** The measured cache view: one collapsible breakdown per chat session, active session first. */
export interface CacheMeasured {
  /** Per-session breakdowns, active session first. */
  sessions: SessionCacheView[];
}

type CacheState =
  | { kind: 'computing' }
  | { kind: 'waiting'; reason: string }
  | ({ kind: 'measured' } & CacheMeasured);

/** Renders the "Cache" section: a full breakdown of the cached prompt prefix re-sent every turn. */
export class CacheViewProvider implements vscode.WebviewViewProvider {
  public static readonly viewType = 'copilotControlPlane.cacheView';

  private view?: vscode.WebviewView;
  private latest: CacheState = { kind: 'computing' };
  private measured?: CacheMeasured;
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

  /** Gate on measurement: cache details only make sense once we can read real usage. */
  setCapabilities(caps: Capabilities): void {
    this.caps = caps;
    if (caps.level === 'full') {
      this.latest = this.measured ? { kind: 'measured', ...this.measured } : { kind: 'computing' };
    } else {
      this.latest = {
        kind: 'waiting',
        reason:
          'Cache details appear once cost measurement is active. Open the Cost Explorer above to finish setup.',
      };
    }
    this.post();
  }

  /** Push a freshly computed cache breakdown. */
  update(view: CacheMeasured): void {
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
    --bad: var(--vscode-charts-red, #f85149);
    --accent: var(--vscode-charts-blue, #3794ff);
    --purple: var(--vscode-charts-purple, #b180d7);
    --yellow: var(--vscode-charts-yellow, #d7ba7d);
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
  #c-hit { font-size: 28px; font-weight: 700; line-height: 1; }
  .hero-unit { font-size: 10px; text-transform: uppercase; letter-spacing: .04em; opacity: .65; }
  .headline { font-size: 12px; line-height: 1.5; opacity: .9; margin-bottom: 16px; }

  /* Per-session collapsible cards: each chat's own cache prefix. Active session open by default. */
  .sess { border: 1px solid var(--line); border-radius: 8px; margin-bottom: 10px; overflow: hidden; }
  .sess.active { border-left: 3px solid var(--accent); }
  .sess-head { display: flex; align-items: center; gap: 9px; padding: 9px 11px; cursor: pointer; user-select: none; }
  .sess-head:hover { background: var(--card); }
  .sess-hit { font-size: 16px; font-weight: 700; line-height: 1; flex: 0 0 auto; min-width: 38px; }
  .sess-id { font-weight: 600; font-size: 12.5px; flex: 1 1 auto; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .sess-meta { font-size: 10.5px; opacity: .6; font-weight: 400; }
  .sess-chevron { flex: 0 0 auto; font-size: 9px; opacity: .55; transition: transform .15s ease; }
  .sess.open .sess-chevron { transform: rotate(180deg); }
  .sess-body { padding: 2px 11px 12px; display: none; }
  .sess.open .sess-body { display: block; }

  .section-title { font-size: 11px; text-transform: uppercase; letter-spacing: .04em; opacity: .7; margin: 0 0 8px; }
  .bar { display: flex; height: 14px; border-radius: 7px; overflow: hidden; background: var(--line); margin: 2px 0 10px; }
  .seg { height: 100%; }

  .rows { display: flex; flex-direction: column; gap: 6px; margin-bottom: 18px; }
  .row { display: flex; align-items: center; gap: 8px; font-size: 12px; }
  .swatch { width: 10px; height: 10px; border-radius: 2px; flex: 0 0 auto; }
  .r-name { font-weight: 600; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; flex: 1 1 auto; min-width: 0; }
  .r-tok { white-space: nowrap; opacity: .92; }
  .r-meta { white-space: nowrap; opacity: .58; font-size: 10.5px; flex: 0 0 auto; }

  .saved { font-size: 12px; opacity: .9; padding: 9px 11px; border-radius: 6px; background: var(--card); border: 1px solid var(--line); margin-bottom: 14px; }
  .saved b { color: var(--ok); }

  .note { font-size: 11px; line-height: 1.45; opacity: .62; margin: 0 0 14px; }
  .actions { display: flex; gap: 8px; }
  .btn { flex: 1; cursor: pointer; border: none; border-radius: 5px; padding: 7px 10px; font-size: 12px; font-weight: 600; color: var(--vscode-button-foreground); background: var(--vscode-button-background); }
  .btn:hover { background: var(--vscode-button-hoverBackground); }
</style>
</head>
<body>
  <div id="computing" class="state"><div class="muted">Analyzing cache&hellip;</div></div>

  <div id="waiting" class="state hidden">
    <div class="big">&#128274;</div>
    <div id="waiting-reason" class="muted">-</div>
  </div>

  <div id="measured" class="hidden">
    <div class="section-title">Cache by session &middot; newest first</div>
    <div id="c-sessions"></div>

    <div class="note">
      The prefix (system prompt + tool schemas + conversation history) is re-sent every turn and
      served from cache when unchanged. Each session has its own prefix, so a fresh chat starts
      small. Token sizes use the model&rsquo;s tiktoken tokenizer; hit rate is exact. Trim tools or start a fresh
      chat to shrink it.
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
  function rowsEl(rows) {
    var box = document.createElement('div'); box.className = 'rows';
    (rows || []).forEach(function (r) {
      var row = document.createElement('div'); row.className = 'row';
      var sw = document.createElement('span'); sw.className = 'swatch'; sw.style.background = r.color;
      var nm = document.createElement('span'); nm.className = 'r-name'; nm.textContent = r.label; nm.title = r.label;
      var tok = document.createElement('span'); tok.className = 'r-tok'; tok.textContent = r.tokensFmt;
      var meta = document.createElement('span'); meta.className = 'r-meta';
      meta.textContent = r.note ? (r.pctFmt + ' \u00b7 ' + r.note) : r.pctFmt;
      row.appendChild(sw); row.appendChild(nm); row.appendChild(tok); row.appendChild(meta);
      box.appendChild(row);
    });
    return box;
  }
  function barEl(rows) {
    var bar = document.createElement('div'); bar.className = 'bar';
    (rows || []).forEach(function (r) {
      var d = document.createElement('div'); d.className = 'seg';
      d.style.width = Math.max(0, r.pct) + '%';
      if (r.pct > 0) { d.style.minWidth = '3px'; }
      d.style.background = r.color;
      d.title = r.label + ' ' + r.tokensFmt + ' (' + r.pctFmt + ')';
      bar.appendChild(d);
    });
    return bar;
  }
  function sectionTitle(text) {
    var el = document.createElement('div'); el.className = 'section-title'; el.textContent = text;
    return el;
  }
  function buildSession(sn) {
    var card = document.createElement('div'); card.className = 'sess' + (sn.active ? ' active' : '') + (sn.active ? ' open' : '');
    var head = document.createElement('div'); head.className = 'sess-head';
    var hit = document.createElement('span'); hit.className = 'sess-hit'; hit.textContent = sn.hitRateFmt;
    var idwrap = document.createElement('span'); idwrap.className = 'sess-id';
    idwrap.textContent = sn.title;
    var meta = document.createElement('span'); meta.className = 'sess-meta'; meta.textContent = '  ' + sn.meta;
    idwrap.appendChild(meta);
    var chevron = document.createElement('span'); chevron.className = 'sess-chevron'; chevron.textContent = '\u25BC';
    head.appendChild(hit); head.appendChild(idwrap); head.appendChild(chevron);
    head.addEventListener('click', function () { card.classList.toggle('open'); });

    var body = document.createElement('div'); body.className = 'sess-body';
    var headline = document.createElement('div'); headline.className = 'headline'; headline.textContent = sn.headline;
    body.appendChild(headline);
    body.appendChild(sectionTitle('What\u2019s in the cached prefix \u00b7 ' + sn.contextFmt));
    body.appendChild(barEl(sn.composition));
    body.appendChild(rowsEl(sn.composition));
    if (sn.toolGroups && sn.toolGroups.length) {
      body.appendChild(sectionTitle('Tool schemas by source'));
      body.appendChild(rowsEl(sn.toolGroups));
    }
    if (sn.topTools && sn.topTools.length) {
      body.appendChild(sectionTitle('Biggest tools'));
      body.appendChild(rowsEl(sn.topTools));
    }
    var saved = document.createElement('div'); saved.className = 'saved';
    saved.innerHTML = 'Cache saved \u2248 <b>' + sn.savedFmt + '</b> vs paying full input rate.';
    body.appendChild(saved);

    card.appendChild(head); card.appendChild(body);
    return card;
  }
  function renderMeasured(s) {
    show('measured');
    var box = document.getElementById('c-sessions');
    box.textContent = '';
    (s.sessions || []).forEach(function (sn) { box.appendChild(buildSession(sn)); });
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
