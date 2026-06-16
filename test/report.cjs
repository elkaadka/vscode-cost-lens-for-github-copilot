// Headless "what the panel would show" report (Option A).
//
// Runs the REAL workspace usage reader against the Copilot logs on disk and prints
// the same numbers the Cost Health panel renders; no VS Code window required.
// This mirrors buildMeasured()/formatAgo() in src/extension.ts, but pulls the actual
// math (reader, rates, formatting) from the compiled source so it can't drift.
//
//   node test/report.cjs
//
// Exit 2 if no Copilot debug-logs dir is found on this machine.
const path = require('path');
const fsp = require('fs/promises');
const os = require('os');
const esbuild = require('esbuild');

const STUB = path.join(__dirname, 'vscode-stub.js');
const OUT = path.join(os.tmpdir(), 'costlens.report.bundle.cjs');

// Bundle just the pure modules we need, with `vscode` aliased to the stub.
async function build() {
  await esbuild.build({
    stdin: {
      contents: [
        "export { WorkspaceUsageReader } from '../src/usagelog';",
      "export { resolveRate, inputCostUSD, outputCostUSD, cachedCostUSD } from '../src/rates';",
        "export { fmtTokens, fmtUSD, bandWord } from '../src/score';",
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

// Same home-dir scan the real-data test uses, since there's no ExtensionContext here.
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

// Mirror of src/extension.ts formatAgo().
function formatAgo(ts) {
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

// Mirror of src/extension.ts buildMeasured() (no VS Code config → no rate overrides).
function buildMeasured(mod, t) {
  const topModel = t.models[0] ?? 'unknown';
  const rate = mod.resolveRate({ id: topModel, family: topModel }, {});
  const freshInput = Math.max(0, t.inputTokens - t.cachedTokens);
  const cost =
    mod.inputCostUSD(rate, freshInput) +
    mod.cachedCostUSD(rate, t.cachedTokens, t.inputTokens) +
    mod.outputCostUSD(rate, t.outputTokens, t.inputTokens);
  // Headline cost follows the billed credit total (AIU × $0.01) when logged; token math is fallback.
  const billedCost = t.aiu > 0 ? t.aiu * 0.01 : cost;
  const creditsFmt = t.aiu >= 100 ? Math.round(t.aiu).toLocaleString('en-US') : t.aiu.toFixed(1);
  const totalTokens = t.inputTokens + t.outputTokens;
  const band = rate.tier === 'top' ? 'red' : rate.tier === 'mid' ? 'yellow' : 'green';

  let conclusion;
  if (t.requests === 0) {
    conclusion = t.lastAnalyzed
      ? 'No token usage recorded yet in this workspace. Send a Copilot chat message, then Refresh.'
      : 'Analyzing Copilot\u2019s request logs\u2026';
  } else {
    const sessionWord = t.sessions === 1 ? 'session' : 'sessions';
    const modelNote =
      t.models.length > 1 ? `${t.models.length} models, mostly ${topModel}` : topModel;
    const costPhrase =
      t.aiu > 0
        ? `\u2248 ${mod.fmtUSD(billedCost)} \u00b7 ${creditsFmt} credits`
        : `\u2248 ${mod.fmtUSD(billedCost)} at list prices`;
    conclusion =
      `Measured ${mod.fmtTokens(totalTokens)} tokens over ${t.requests} request${t.requests === 1 ? '' : 's'} ` +
      `across ${t.sessions} chat ${sessionWord} (${modelNote}). ${costPhrase}.`;
  }

  return {
    band,
    bandWord: mod.bandWord(band),
    conclusion,
    totalTokensFmt: mod.fmtTokens(totalTokens),
    inTokensFmt: mod.fmtTokens(t.inputTokens),
    outTokensFmt: mod.fmtTokens(t.outputTokens),
    cachedFmt: t.cachedTokens > 0 ? mod.fmtTokens(t.cachedTokens) : '\u2014',
    requests: t.requests,
    sessions: t.sessions,
    aiuFmt: t.aiu > 0 ? t.aiu.toFixed(1) : '\u2014',
    costFmt: mod.fmtUSD(billedCost),
    model: t.models.length > 1 ? `${topModel} +${t.models.length - 1}` : topModel,
    lastAnalyzedFmt: formatAgo(t.lastAnalyzed),
  };
}

const n = (x) => x.toLocaleString('en-US');

async function main() {
  const mod = await build();
  const dir = await findDebugLogsDir();
  if (!dir) {
    console.log('No GitHub.copilot-chat/debug-logs dir found; nothing to report.');
    process.exit(2);
  }

  const reader = new mod.WorkspaceUsageReader(dir, 999999);
  await reader.refresh();
  const t = reader.totals;
  reader.dispose();

  const v = buildMeasured(mod, t);

  const line = '\u2500'.repeat(64);
  console.log('\n' + line);
  console.log('  COST HEALTH \u2014 measured (what the panel would show)');
  console.log(line);
  console.log(`  Logs dir      : ${dir}`);
  console.log('');
  console.log(`  ${v.bandWord.toUpperCase()}  ${v.conclusion}`);
  console.log('');
  console.log(`  TOTAL TOKENS  : ${v.totalTokensFmt}   (${n(t.inputTokens + t.outputTokens)} raw)`);
  console.log(`  \u2248 cost        : ${v.costFmt}  (billed via credits when logged)`);
  console.log('');
  console.log(`  Input         : ${v.inTokensFmt}   (${n(t.inputTokens)})`);
  console.log(`  Output        : ${v.outTokensFmt}   (${n(t.outputTokens)})`);
  console.log(`  Cached        : ${v.cachedFmt}`);
  console.log('');
  console.log(`  Requests      : ${n(v.requests)}`);
  console.log(`  Sessions      : ${v.sessions}`);
  console.log(`  AI units      : ${v.aiuFmt}`);
  console.log(`  Model         : ${v.model}`);
  console.log('');
  console.log(`  Files scanned : ${t.filesScanned}`);
  console.log(`  Analyzed      : ${v.lastAnalyzedFmt}`);
  console.log(line);

  // Top 3 models by total tokens.
  console.log('  TOP MODELS');
  const grand = t.inputTokens + t.outputTokens;
  (t.modelUsage || []).slice(0, 3).forEach((m, i) => {
    const share = grand > 0 ? Math.round((m.totalTokens / grand) * 100) : 0;
    console.log(
      `    ${i + 1}. ${m.model.padEnd(20)} ${mod.fmtTokens(m.totalTokens).padStart(7)}  ` +
        `${String(share).padStart(3)}%  ${m.requests} req`,
    );
  });

  // Weekly token bars (last 7 days), ASCII sparkline stacked total.
  console.log('');
  console.log('  THIS WEEK (tokens/day)');
  const days = t.daily || [];
  const maxDay = days.reduce((mx, d) => Math.max(mx, d.totalTokens), 0);
  for (const d of days) {
    const w = maxDay > 0 ? Math.round((d.totalTokens / maxDay) * 40) : 0;
    const top = Object.entries(d.byModel).sort((a, b) => b[1] - a[1])[0];
    const topNote = top ? `  ${top[0]}` : '';
    console.log(`    ${d.day}  ${'\u2588'.repeat(w).padEnd(40)} ${mod.fmtTokens(d.totalTokens).padStart(7)}${topNote}`);
  }
  if (days.length === 0) {
    console.log('    (no dated usage)');
  }
  console.log('');
  const rPct = t.outputTokens > 0 ? Math.round((t.reasoningTokens / t.outputTokens) * 100) : 0;
  const level = rPct >= 50 ? 'HIGH (red)' : rPct >= 30 ? 'MED (orange)' : 'LOW (green)';
  console.log('  REASONING (estimated)');
  console.log(`    ${mod.fmtTokens(t.reasoningTokens)} tokens  ${rPct}% of output  [${level}]`);
  console.log(line + '\n');
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
