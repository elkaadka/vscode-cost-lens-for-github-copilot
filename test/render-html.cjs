// Headless HTML preview of the Cost Health panel.
//
// Renders the REAL panel markup (captured from HealthViewProvider) fed with the REAL
// buildMeasured() output against the Copilot logs on disk, so the webview can be eyeballed
// without launching an Extension Development Host (where no folder = no storageUri = no data).
//
//   node test/render-html.cjs
//
// Writes a standalone HTML file (path printed on stdout); exits 2 if no logs are found.
const path = require('path');
const fs = require('fs');
const fsp = require('fs/promises');
const os = require('os');
const esbuild = require('esbuild');

// A slightly richer `vscode` stub than the unit-test one: it honors config defaults and provides
// the no-op command / EventEmitter / Uri surface the panel provider touches while we capture its
// HTML. Written to tmp so the repo stays clean.
const STUB = path.join(os.tmpdir(), 'costlens.vscode-stub.render.js');
fs.writeFileSync(
  STUB,
  `
class EventEmitter {
  constructor(){ this._l=[]; this.event=(fn)=>{ this._l.push(fn); return {dispose(){}}; }; }
  fire(v){ for (const l of this._l) l(v); }
  dispose(){ this._l=[]; }
}
const Uri = {
  file:(p)=>({fsPath:p, path:p, scheme:'file', toString:()=>p}),
  parse:(s)=>({toString:()=>s}),
  joinPath:(b,...p)=>({fsPath:[(b&&b.fsPath)||'', ...p].join('/'), toString:()=>''}),
};
module.exports = {
  EventEmitter, Uri,
  ConfigurationTarget:{Global:1,Workspace:2,WorkspaceFolder:3},
  ViewColumn:{One:1},
  workspace:{ getConfiguration:()=>({ get:(k,def)=>def, update:async()=>{} }), workspaceFolders:[] },
  window:{ showInformationMessage:async()=>undefined, showErrorMessage:async()=>undefined },
  commands:{ executeCommand:async()=>undefined, registerCommand:()=>({dispose(){}}) },
  lm:{ selectChatModels:async()=>[] },
};
`,
);

const OUT = path.join(os.tmpdir(), 'costlens.render.bundle.cjs');
const HTML_OUT = path.join(os.tmpdir(), 'costlens.preview.html');

// Bundle the real source (vscode aliased to the stub) so the preview can't drift from the build.
async function build() {
  await esbuild.build({
    stdin: {
      contents: [
        "export { WorkspaceUsageReader } from '../src/usagelog';",
        "export { buildMeasured } from '../src/extension';",
        "export { HealthViewProvider } from '../src/panel';",
      ].join('\n'),
      resolveDir: __dirname,
      loader: 'ts',
    },
    bundle: true,
    platform: 'node',
    format: 'cjs',
    outfile: OUT,
    alias: { vscode: STUB },
    logLevel: 'silent',
  });
  return require(OUT);
}

async function findDebugLogsDir() {
  const base = path.join(os.homedir(), '.vscode-server', 'data', 'User', 'workspaceStorage');
  const hashes = await fsp.readdir(base).catch(() => []);
  for (const h of hashes) {
    const dir = path.join(base, h, 'GitHub.copilot-chat', 'debug-logs');
    try {
      if ((await fsp.stat(dir)).isDirectory()) {
        return dir;
      }
    } catch {
      /* keep looking */
    }
  }
  return undefined;
}

// Capture the provider's real webview HTML by driving resolveWebviewView() with a fake view.
function capturePanelHtml(mod) {
  const provider = new mod.HealthViewProvider({ fsPath: '/preview', toString: () => '/preview' });
  let captured = '';
  const webview = {
    options: undefined,
    cspSource: 'vscode-resource:',
    set html(v) {
      captured = v;
    },
    get html() {
      return captured;
    },
    onDidReceiveMessage() {
      return { dispose() {} };
    },
    postMessage() {
      return Promise.resolve(true);
    },
    asWebviewUri: (u) => u,
  };
  const view = {
    webview,
    visible: true,
    onDidChangeVisibility() {
      return { dispose() {} };
    },
  };
  provider.resolveWebviewView(view);
  return captured;
}

// Approximate the VS Code dark theme so the standalone file reads like the real side panel.
const THEME = `
  html, body { background: #1e1e1e; }
  :root {
    --vscode-font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", system-ui, sans-serif;
    --vscode-editor-font-family: "SF Mono", Menlo, Consolas, "Courier New", monospace;
    --vscode-foreground: #cccccc;
    --vscode-button-foreground: #ffffff;
    --vscode-button-background: #0e639c;
    --vscode-button-hoverBackground: #1177bb;
    --vscode-button-secondaryForeground: #ffffff;
    --vscode-button-secondaryBackground: #3a3d41;
    --vscode-button-secondaryHoverBackground: #45494e;
    --vscode-textLink-foreground: #4daafc;
    --vscode-editorWidget-background: #252526;
    --vscode-editorWidget-border: #3c3c3c;
    --vscode-charts-blue: #4daafc;
    --vscode-charts-green: #89d185;
    --vscode-charts-yellow: #d7ba7d;
    --vscode-charts-orange: #d18616;
    --vscode-charts-purple: #b180d7;
    --vscode-charts-red: #f14c4c;
  }
`;

function standalone(html, state) {
  // Drop the webview CSP so our preview scripts (acquireVsCodeApi shim + state post) can run.
  let out = html.replace(/<meta http-equiv="Content-Security-Policy"[^>]*>/, '');
  const headInject =
    '<style>' +
    THEME +
    '</style>' +
    '<script>window.acquireVsCodeApi=function(){return {postMessage:function(){},getState:function(){},setState:function(){}};};</script>';
  out = out.replace('<head>', '<head>' + headInject);
  // Embed the real measured state; escape "<" so no string can break out of the script tag.
  const json = JSON.stringify(state).replace(/</g, '\\u003c');
  const post =
    '<script>window.addEventListener("DOMContentLoaded",function(){' +
    'window.postMessage({type:"state",state:Object.assign({kind:"measured"},' +
    json +
    '),session:null},"*");' +
    '});</script>';
  out = out.replace('</body>', post + '</body>');
  return out;
}

async function main() {
  const mod = await build();
  const dir = await findDebugLogsDir();
  if (!dir) {
    console.log('No GitHub.copilot-chat/debug-logs dir found; nothing to render.');
    process.exit(2);
  }

  const reader = new mod.WorkspaceUsageReader(dir, 999999);
  await reader.refresh();
  const state = mod.buildMeasured(reader.totals);
  reader.dispose();

  const html = capturePanelHtml(mod);
  fs.writeFileSync(HTML_OUT, standalone(html, state));

  console.log('Rendered preview written to:\n  ' + HTML_OUT);
  console.log(
    '\nTop models: ' +
      state.topModels.map((m) => `${m.model} ${m.totalTokensFmt} (${m.sharePct}%)`).join(', '),
  );
  console.log('Week days : ' + state.week.days.map((d) => `${d.label}=${d.totalTokensFmt}`).join(', '));
  console.log('\nOpen with : file://' + HTML_OUT);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
