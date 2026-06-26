// Standalone test for the usage-log reader, run against the REAL Copilot logs on disk.
// Bundles src/usagelog.ts with `vscode` aliased to our stub, then verifies:
//   1. parseSpanLine extracts real spans
//   2. dedup-by-spanId totals match an independent line-by-line count
//   3. SessionUsageReader picks the newest session and emits totals
const path = require('path');
const fsp = require('fs/promises');
const os = require('os');
const esbuild = require('esbuild');

const STUB = path.join(__dirname, 'vscode-stub.js');
const OUT = path.join(os.tmpdir(), 'usagelog.test.bundle.cjs');

async function build() {
  await esbuild.build({
    entryPoints: [path.join(__dirname, '..', 'src', 'usagelog.ts')],
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
  const base = path.join(
    os.homedir(),
    '.vscode-server',
    'data',
    'User',
    'workspaceStorage',
  );
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

// Collect every .jsonl file across all session dirs (mirrors collectSessionLogFiles).
async function collectAll(debugLogsDir) {
  const out = [];
  const sessions = await fsp.readdir(debugLogsDir, { withFileTypes: true }).catch(() => []);
  for (const s of sessions) {
    if (!s.isDirectory()) continue;
    const sdir = path.join(debugLogsDir, s.name);
    const entries = await fsp.readdir(sdir, { withFileTypes: true }).catch(() => []);
    for (const e of entries) {
      if (e.isFile() && e.name.endsWith('.jsonl')) out.push(path.join(sdir, e.name));
    }
  }
  return out;
}

// Independent reference: dedup distinct spanIds across ALL files; sessions = top-level dirs.
async function referenceTotals(files) {
  const byKey = new Map();
  for (const file of files) {
    const sid = path.basename(path.dirname(file));
    const text = await fsp.readFile(file, 'utf8').catch(() => '');
    for (const line of text.split('\n')) {
      const t = line.trim();
      if (!t) continue;
      let o;
      try {
        o = JSON.parse(t);
      } catch {
        continue;
      }
      if (o.type !== 'llm_request') continue;
      if (typeof o.name !== 'string' || !o.name.startsWith('chat:')) continue;
      const a = o.attrs || {};
      if (typeof a.inputTokens !== 'number' || typeof a.outputTokens !== 'number') continue;
      const key = o.spanId || `${o.sid}:${o.ts}:${a.responseId || ''}`;
      byKey.set(key, {
        sid,
        inputTokens: a.inputTokens,
        outputTokens: a.outputTokens,
        aiu: typeof a.copilotUsageNanoAiu === 'number' ? a.copilotUsageNanoAiu / 1e9 : 0,
      });
    }
  }
  let inp = 0,
    out = 0,
    aiu = 0;
  const sids = new Set();
  for (const v of byKey.values()) {
    inp += v.inputTokens;
    out += v.outputTokens;
    aiu += v.aiu;
    sids.add(v.sid);
  }
  return { requests: byKey.size, inputTokens: inp, outputTokens: out, aiu, sessions: sids.size };
}

let pass = 0;
let fail = 0;
function check(name, cond, detail = '') {
  if (cond) {
    pass++;
    console.log(`  PASS  ${name}`);
  } else {
    fail++;
    console.log(`  FAIL  ${name}  ${detail}`);
  }
}

async function main() {
  const mod = await build();
  const dir = await findDebugLogsDir();
  if (!dir) {
    console.log('No debug-logs dir found; skipping real-data test.');
    process.exit(0);
  }
  console.log('debug-logs dir:', dir, '\n');

  // --- 1. parseSpanLine on a real line ---------------------------------
  const active = await mod.findActiveSessionLog(dir);
  console.log('newest session log:', active, '\n');
  check('findActiveSessionLog returns a file', !!active);

  const head = (await fsp.readFile(active, 'utf8')).split('\n');
  let firstSpan;
  for (const line of head) {
    const s = mod.parseSpanLine(line);
    if (s) {
      firstSpan = s;
      break;
    }
  }
  check('parseSpanLine extracts a span', !!firstSpan, JSON.stringify(firstSpan));
  if (firstSpan) {
    check('span has positive inputTokens', firstSpan.inputTokens > 0, String(firstSpan.inputTokens));
    check('span has a dedup key', typeof firstSpan.key === 'string' && firstSpan.key.length > 0);
    check('span has a model', !!firstSpan.model);
  }

  // --- 2. parseSpanLine rejects junk -----------------------------------
  check('rejects empty line', mod.parseSpanLine('') === undefined);
  check('rejects non-JSON', mod.parseSpanLine('not json') === undefined);
  check('rejects non-chat span', mod.parseSpanLine('{"type":"llm_request","name":"embed:x","attrs":{}}') === undefined);
  check(
    'rejects span missing tokens',
    mod.parseSpanLine('{"type":"llm_request","name":"chat:m","attrs":{"inputTokens":5}}') === undefined,
  );

  // --- 3. Reader totals (ALL sessions + files) match independent reference ---
  const allFiles = await collectAll(dir);
  console.log('  files in all sessions:', allFiles.length);
  const ref = await referenceTotals(allFiles);
  console.log('  reference:', JSON.stringify(ref));

  const reader = new mod.WorkspaceUsageReader(dir, 999999);
  await reader.refresh();
  const got = reader.totals;
  console.log('  reader   :', JSON.stringify({
    requests: got.requests,
    inputTokens: got.inputTokens,
    outputTokens: got.outputTokens,
    aiu: Number(got.aiu.toFixed(3)),
    sessions: got.sessions,
    filesScanned: got.filesScanned,
  }), '\n');

  check('reader scanned every jsonl file', got.filesScanned === allFiles.length, `${got.filesScanned} vs ${allFiles.length}`);
  check('reader request count matches reference', got.requests === ref.requests, `${got.requests} vs ${ref.requests}`);
  check('reader inputTokens matches reference', got.inputTokens === ref.inputTokens, `${got.inputTokens} vs ${ref.inputTokens}`);
  check('reader outputTokens matches reference', got.outputTokens === ref.outputTokens, `${got.outputTokens} vs ${ref.outputTokens}`);
  check('reader aiu ~matches reference', Math.abs(got.aiu - ref.aiu) < 0.01, `${got.aiu} vs ${ref.aiu}`);
  check('reader session count matches reference', got.sessions === ref.sessions, `${got.sessions} vs ${ref.sessions}`);
  check('reader picked a model', got.models.length > 0, got.models.join(','));
  check('reader recorded lastAnalyzed', got.lastAnalyzed > 0, String(got.lastAnalyzed));

  // --- 4. Incremental read is idempotent (second refresh = no change) --
  const before = reader.totals.requests;
  await reader.refresh();
  check('second refresh keeps totals stable', reader.totals.requests === before, `${reader.totals.requests} vs ${before}`);

  // --- 5. Per-model + per-day aggregates are self-consistent -----------
  const agg = reader.totals;
  const grand = agg.inputTokens + agg.outputTokens;
  check('modelUsage is non-empty', agg.modelUsage.length > 0, String(agg.modelUsage.length));
  const muSorted = agg.modelUsage.every(
    (m, i) => i === 0 || agg.modelUsage[i - 1].totalTokens >= m.totalTokens,
  );
  check('modelUsage sorted by totalTokens desc', muSorted);
  const muTokenSum = agg.modelUsage.reduce((s, m) => s + m.totalTokens, 0);
  check('modelUsage tokens sum to grand total', muTokenSum === grand, `${muTokenSum} vs ${grand}`);
  const muReqSum = agg.modelUsage.reduce((s, m) => s + m.requests, 0);
  check('modelUsage requests sum to total', muReqSum === agg.requests, `${muReqSum} vs ${agg.requests}`);
  check('models[] equals modelUsage order', JSON.stringify(agg.models) === JSON.stringify(agg.modelUsage.map((m) => m.model)));

  const daySorted = agg.daily.every((d, i) => i === 0 || agg.daily[i - 1].day.localeCompare(d.day) <= 0);
  check('daily sorted by day asc', daySorted);
  const dayTokenSum = agg.daily.reduce((s, d) => s + d.totalTokens, 0);
  // All real spans carry a timestamp, so every token lands in a day bucket.
  check('daily tokens sum to grand total', dayTokenSum === grand, `${dayTokenSum} vs ${grand}`);
  const everyDayByModelSums = agg.daily.every((d) => {
    const sum = Object.values(d.byModel).reduce((s, n) => s + n, 0);
    return sum === d.totalTokens;
  });
  check('each day byModel sums to its total', everyDayByModelSums);
  console.log('  top models:', agg.modelUsage.slice(0, 3).map((m) => `${m.model}=${m.totalTokens}`).join(', '));
  console.log('  days:', agg.daily.map((d) => `${d.day}=${d.totalTokens}`).join(', '), '\n');

  // Reasoning estimate: a non-negative subset of output tokens.
  check('reasoningTokens is a number', typeof agg.reasoningTokens === 'number', String(agg.reasoningTokens));
  check('reasoningTokens >= 0', agg.reasoningTokens >= 0, String(agg.reasoningTokens));
  check('reasoningTokens <= outputTokens', agg.reasoningTokens <= agg.outputTokens, `${agg.reasoningTokens} vs ${agg.outputTokens}`);
  check('parseAgentResponse extracts visible tokens', (() => {
    const vr = mod.parseAgentResponse('{"type":"agent_response","spanId":"agent-msg-00aa","attrs":{"response":"[{\\"role\\":\\"assistant\\",\\"parts\\":[{\\"type\\":\\"text\\",\\"content\\":\\"hello there\\"}]}]"}}');
    return vr && vr.spanId === '00aa' && vr.visibleTokens > 0;
  })());
  check('parseAgentResponse rejects non-response', mod.parseAgentResponse('{"type":"llm_request"}') === undefined);
  const rPct = agg.outputTokens > 0 ? (100 * agg.reasoningTokens / agg.outputTokens).toFixed(1) : '0';
  console.log(`  reasoning: ${agg.reasoningTokens} tokens (${rPct}% of output)\n`);

  reader.dispose();

  // --- 6. findDebugLogsDir derives the dir from OUR storageUri ---------
  // This is the publish-safety-critical path: on any install, our extension's
  // storageUri is a sibling of GitHub.copilot-chat under workspaceStorage/<hash>.
  const hashDir = path.dirname(path.dirname(dir)); // …/workspaceStorage/<hash>
  const fakeStorage = path.join(hashDir, 'undefined_publisher.copilot-control-plane');
  const ctx = { storageUri: { fsPath: fakeStorage } };
  const derived = await mod.findDebugLogsDir(ctx);
  check('findDebugLogsDir derives dir from storageUri sibling', derived === dir, `${derived} vs ${dir}`);

  const noFolder = await mod.findDebugLogsDir({ storageUri: undefined });
  check('findDebugLogsDir returns undefined with no workspace', noFolder === undefined, String(noFolder));

  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail === 0 ? 0 : 1);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
