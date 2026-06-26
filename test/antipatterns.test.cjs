// Unit test for the anti-pattern detection engine (src/antipatterns.ts).
// The module is pure (no `vscode` dependency), so we bundle it directly with esbuild and
// exercise each detector against synthetic prompt turns.
const path = require('path');
const os = require('os');
const esbuild = require('esbuild');

const OUT = path.join(os.tmpdir(), 'antipatterns.test.bundle.cjs');

async function build() {
  await esbuild.build({
    entryPoints: [path.join(__dirname, '..', 'src', 'antipatterns.ts')],
    bundle: true,
    platform: 'node',
    format: 'cjs',
    outfile: OUT,
    logLevel: 'silent',
  });
  return require(OUT);
}

let pass = 0;
let fail = 0;
function check(name, cond, extra) {
  if (cond) {
    pass++;
    console.log(`  ok   ${name}`);
  } else {
    fail++;
    console.log(`  FAIL ${name}${extra ? ' \u2014 ' + extra : ''}`);
  }
}

function turn(over) {
  return Object.assign(
    {
      sessionId: 's1',
      index: 0,
      ts: 1_000,
      text: 'Please refactor the authentication module to use async/await throughout.',
      models: ['gpt-4o'],
      calls: 3,
      inputTokens: 5_000,
    },
    over,
  );
}

function find(report, id) {
  return report.patterns.find((p) => p.id === id);
}

async function main() {
  const { detectAntiPatterns } = await build();

  // Empty input -> empty report.
  const empty = detectAntiPatterns([]);
  check('empty input yields no patterns', empty.patterns.length === 0 && empty.analyzed === 0);

  // Vague prompts: needs >= 2 to report.
  const vague = detectAntiPatterns([
    turn({ index: 0, text: 'fix it' }),
    turn({ index: 1, text: 'now?' }),
    turn({ index: 2, text: 'Add comprehensive unit tests for the parser, covering edge cases.' }),
  ]);
  const vp = find(vague, 'vague-prompt');
  check('detects vague prompts', !!vp && vp.count === 2, vp ? String(vp.count) : 'missing');
  check('vague has a suggestion', !!vp && vp.suggestion.length > 0);
  check('vague has examples', !!vp && vp.examples.length > 0);
  check('analyzed count is reported', vague.analyzed === 3, String(vague.analyzed));

  // A single vague prompt is below the reporting threshold.
  const oneVague = detectAntiPatterns([turn({ text: 'go' }), turn({ index: 1 })]);
  check('single vague prompt not reported', !find(oneVague, 'vague-prompt'));

  // Runaway agent loop: a single big turn is enough; doubles severity past 2x.
  const runaway = detectAntiPatterns([turn({ calls: 60 })]);
  const rw = find(runaway, 'runaway-agent-turn');
  check('detects runaway agent loop', !!rw && rw.count === 1);
  check('runaway severity escalates to bad', !!rw && rw.severity === 'bad', rw ? rw.severity : 'missing');

  // Oversized context.
  const mega = detectAntiPatterns([turn({ inputTokens: 200_000 })]);
  check('detects oversized context', !!find(mega, 'mega-context'));

  // Premium model for trivial prompts: short text, <=2 calls, premium model, >=2 occurrences.
  const premium = detectAntiPatterns([
    turn({ index: 0, text: 'rename foo', models: ['claude-opus-4'], calls: 1 }),
    turn({ index: 1, text: 'add a comment', models: ['gpt-5'], calls: 2 }),
  ]);
  const pm = find(premium, 'premium-for-trivial');
  check('detects premium model for trivial prompts', !!pm && pm.count === 2, pm ? String(pm.count) : 'missing');

  // Premium model on a substantial prompt should NOT flag.
  const premiumOk = detectAntiPatterns([
    turn({ text: 'Design and implement a caching layer with eviction and metrics, then add tests.', models: ['claude-opus-4'], calls: 1 }),
    turn({ index: 1, text: 'Now wire the cache into the request pipeline and document the config options.', models: ['claude-opus-4'], calls: 1 }),
  ]);
  check('substantial premium prompts not flagged', !find(premiumOk, 'premium-for-trivial'));

  // Session thrash: 4+ rapid turns in one session.
  const thrash = detectAntiPatterns([
    turn({ index: 0, ts: 0 }),
    turn({ index: 1, ts: 5_000 }),
    turn({ index: 2, ts: 10_000 }),
    turn({ index: 3, ts: 15_000 }),
  ]);
  check('detects rapid re-prompting', !!find(thrash, 'session-thrash'));

  // Spread-out turns are not thrash.
  const calm = detectAntiPatterns([
    turn({ index: 0, ts: 0 }),
    turn({ index: 1, ts: 5 * 60_000 }),
    turn({ index: 2, ts: 10 * 60_000 }),
    turn({ index: 3, ts: 15 * 60_000 }),
  ]);
  check('spread-out turns not flagged as thrash', !find(calm, 'session-thrash'));

  // Model hopping: 3+ distinct models in a session.
  const hop = detectAntiPatterns([
    turn({ index: 0, models: ['gpt-4o'] }),
    turn({ index: 1, models: ['claude-sonnet'] }),
    turn({ index: 2, models: ['gemini-2.5'] }),
  ]);
  check('detects model hopping', !!find(hop, 'model-hopping'));

  // Sorting: bad severity comes before info.
  const mixed = detectAntiPatterns([
    turn({ index: 0, calls: 60 }), // runaway -> bad
    turn({ index: 1, models: ['gpt-4o'] }),
    turn({ index: 2, models: ['claude-sonnet'] }),
    turn({ index: 3, models: ['gemini-2.5'] }), // hopping -> info
  ]);
  check('patterns sorted worst-first', mixed.patterns.length >= 2 && mixed.patterns[0].severity === 'bad', mixed.patterns.map((p) => p.severity).join(','));

  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail === 0 ? 0 : 1);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
