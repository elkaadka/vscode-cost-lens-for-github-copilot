/**
 * Copilot usage anti-pattern detection. Pure (no `vscode` dependency, like `tokenizer.ts` and
 * `score.ts`) so it is unit-testable. Operates over the prompt turns already parsed from Copilot's
 * own logs and surfaces concrete, actionable suggestions for using Copilot more effectively.
 *
 * The point is coaching, not cost: each rule flags a recurring habit (vague prompts, runaway agent
 * loops, oversized context, premium model for trivial work, session thrash, model hopping) and
 * tells the developer how to fix it.
 */

export type APSeverity = 'info' | 'warn' | 'bad';

export type APCategory =
  | 'Prompt quality'
  | 'Context management'
  | 'Tool mastery'
  | 'Model selection'
  | 'Session hygiene';

/** One detected anti-pattern, ready to render. */
export interface AntiPattern {
  /** Stable rule id (e.g. `vague-prompt`). */
  id: string;
  title: string;
  category: APCategory;
  severity: APSeverity;
  /** How many turns/sessions triggered this rule. */
  count: number;
  /** One-line description of the problem. */
  detail: string;
  /** Actionable improvement. */
  suggestion: string;
  /** Up to a few short example prompt snippets that matched. */
  examples: string[];
}

/** The anti-pattern report for one scope. */
export interface AntiPatternReport {
  /** Detected anti-patterns, worst severity first. */
  patterns: AntiPattern[];
  /** Number of prompt turns analyzed. */
  analyzed: number;
}

/** The subset of a prompt turn the detectors reason over (`PromptTurn` is assignable to this). */
export interface AnalyzableTurn {
  sessionId: string;
  index: number;
  ts: number;
  text: string;
  models: string[];
  calls: number;
  inputTokens: number;
}

// --- Thresholds (tuned to flag habits, not one-offs) ----------------------
/** At/below this many characters a prompt is treated as too terse to be actionable. */
const VAGUE_MAX_CHARS = 18;
/** A single turn driving at least this many model calls is a runaway agent loop. */
const RUNAWAY_CALLS = 25;
/** A turn carrying at least this much input is an oversized-context turn. */
const MEGA_CONTEXT_TOKENS = 120_000;
/** Consecutive turns less than this apart count toward a thrash burst. */
const THRASH_GAP_MS = 45_000;
/** A thrash burst needs at least this many rapid-fire turns. */
const THRASH_MIN_BURST = 4;
/** A session touching at least this many distinct models is "model hopping". */
const HOP_MIN_MODELS = 3;
/** Minimum matches before a per-turn rule is worth surfacing (avoid nagging on a single case). */
const MIN_REPORTABLE = 2;
/** Cap on example snippets shown per pattern. */
const MAX_EXAMPLES = 3;

/** Model-name fragments that indicate a premium / top-tier model. Lowercased substring match. */
const PREMIUM_MODEL_HINTS = ['opus', 'gpt-5', 'gpt5', 'o1', 'o3', 'gpt-4.5', 'gpt-4.1'];

const SEVERITY_RANK: Record<APSeverity, number> = { bad: 0, warn: 1, info: 2 };

/** Run all detectors over a scope's prompt turns and return the report, worst severity first. */
export function detectAntiPatterns(turns: readonly AnalyzableTurn[]): AntiPatternReport {
  const analyzed = turns.length;
  if (analyzed === 0) {
    return { patterns: [], analyzed: 0 };
  }
  const patterns: AntiPattern[] = [];
  for (const rule of [
    detectVaguePrompts,
    detectRunawayTurns,
    detectMegaContext,
    detectPremiumForTrivial,
    detectSessionThrash,
    detectModelHopping,
  ]) {
    const p = rule(turns);
    if (p) {
      patterns.push(p);
    }
  }
  patterns.sort((a, b) => SEVERITY_RANK[a.severity] - SEVERITY_RANK[b.severity] || b.count - a.count);
  return { patterns, analyzed };
}

/** Too-terse prompts that give the model little to work with. */
function detectVaguePrompts(turns: readonly AnalyzableTurn[]): AntiPattern | undefined {
  const matches = turns.filter((t) => isVague(t.text));
  if (matches.length < MIN_REPORTABLE) {
    return undefined;
  }
  return {
    id: 'vague-prompt',
    title: 'Vague, one-line prompts',
    category: 'Prompt quality',
    severity: 'warn',
    count: matches.length,
    detail: `${matches.length} prompts were very short, giving the model little to act on.`,
    suggestion:
      'State the goal, the files involved, expected output, and constraints. A few specific sentences beat a terse one-liner and cut back-and-forth.',
    examples: exampleTexts(matches),
  };
}

/** Single turns that spiral into a huge agent tool-loop. */
function detectRunawayTurns(turns: readonly AnalyzableTurn[]): AntiPattern | undefined {
  const matches = turns.filter((t) => t.calls >= RUNAWAY_CALLS);
  if (matches.length === 0) {
    return undefined;
  }
  const worst = matches.reduce((m, t) => Math.max(m, t.calls), 0);
  return {
    id: 'runaway-agent-turn',
    title: 'Runaway agent loops',
    category: 'Tool mastery',
    severity: worst >= RUNAWAY_CALLS * 2 ? 'bad' : 'warn',
    count: matches.length,
    detail: `${matches.length} turns drove ${RUNAWAY_CALLS}+ model calls (peak ${worst}) in a single prompt.`,
    suggestion:
      'Break large asks into smaller, well-scoped prompts and confirm intermediate results. Tight scope keeps the agent from looping and re-sending context every step.',
    examples: exampleTexts(matches),
  };
}

/** Turns that attach an oversized context. */
function detectMegaContext(turns: readonly AnalyzableTurn[]): AntiPattern | undefined {
  const matches = turns.filter((t) => t.inputTokens >= MEGA_CONTEXT_TOKENS);
  if (matches.length === 0) {
    return undefined;
  }
  return {
    id: 'mega-context',
    title: 'Oversized context',
    category: 'Context management',
    severity: 'warn',
    count: matches.length,
    detail: `${matches.length} turns sent ${Math.round(MEGA_CONTEXT_TOKENS / 1000)}K+ input tokens.`,
    suggestion:
      'Attach only the files and selections that matter, and start a fresh chat for a new task. Smaller context is cheaper, faster, and usually more accurate.',
    examples: exampleTexts(matches),
  };
}

/** A premium model used for tiny, trivial prompts. */
function detectPremiumForTrivial(turns: readonly AnalyzableTurn[]): AntiPattern | undefined {
  const matches = turns.filter(
    (t) => t.calls <= 2 && isShort(t.text) && t.models.some(isPremiumModel),
  );
  if (matches.length < MIN_REPORTABLE) {
    return undefined;
  }
  return {
    id: 'premium-for-trivial',
    title: 'Premium model for trivial prompts',
    category: 'Model selection',
    severity: 'info',
    count: matches.length,
    detail: `${matches.length} short, single-shot prompts used a top-tier model.`,
    suggestion:
      'Reserve top-tier models for hard reasoning. Route quick edits, renames, and lookups to a cheaper model to save credits with no quality loss.',
    examples: exampleTexts(matches),
  };
}

/** Rapid-fire bursts of prompts in one session — a sign of correcting/thrashing. */
function detectSessionThrash(turns: readonly AnalyzableTurn[]): AntiPattern | undefined {
  const bySession = groupBy(turns, (t) => t.sessionId);
  let burstSessions = 0;
  const examples: string[] = [];
  for (const sessionTurns of bySession.values()) {
    const ordered = [...sessionTurns].sort((a, b) => a.ts - b.ts);
    let run = 1;
    let bursty = false;
    for (let i = 1; i < ordered.length; i++) {
      const gap = ordered[i].ts - ordered[i - 1].ts;
      if (gap > 0 && gap < THRASH_GAP_MS) {
        run++;
        if (run >= THRASH_MIN_BURST) {
          bursty = true;
        }
      } else {
        run = 1;
      }
    }
    if (bursty) {
      burstSessions++;
      const snippet = snippetOf(ordered[0]?.text);
      if (snippet && examples.length < MAX_EXAMPLES) {
        examples.push(snippet);
      }
    }
  }
  if (burstSessions === 0) {
    return undefined;
  }
  return {
    id: 'session-thrash',
    title: 'Rapid re-prompting',
    category: 'Session hygiene',
    severity: 'warn',
    count: burstSessions,
    detail: `${burstSessions} sessions had bursts of ${THRASH_MIN_BURST}+ prompts under ${Math.round(
      THRASH_GAP_MS / 1000,
    )}s apart.`,
    suggestion:
      'Rapid corrections usually mean the first prompt was underspecified. Spend a moment writing one fuller instruction (with acceptance criteria) instead of nudging repeatedly.',
    examples,
  };
}

/** Many distinct models within a single session. */
function detectModelHopping(turns: readonly AnalyzableTurn[]): AntiPattern | undefined {
  const bySession = groupBy(turns, (t) => t.sessionId);
  let hoppingSessions = 0;
  for (const sessionTurns of bySession.values()) {
    const models = new Set<string>();
    for (const t of sessionTurns) {
      for (const m of t.models) {
        models.add(m);
      }
    }
    if (models.size >= HOP_MIN_MODELS) {
      hoppingSessions++;
    }
  }
  if (hoppingSessions === 0) {
    return undefined;
  }
  return {
    id: 'model-hopping',
    title: 'Model hopping mid-session',
    category: 'Session hygiene',
    severity: 'info',
    count: hoppingSessions,
    detail: `${hoppingSessions} sessions switched between ${HOP_MIN_MODELS}+ models.`,
    suggestion:
      'Pick a model that fits the task and stay with it. Frequent switching loses the cached prefix and makes results harder to compare.',
    examples: [],
  };
}

// --- helpers --------------------------------------------------------------

function isVague(text: string): boolean {
  const trimmed = text.trim();
  if (!trimmed || trimmed === '(prompt text unavailable)') {
    return false;
  }
  if (trimmed.length <= VAGUE_MAX_CHARS) {
    return true;
  }
  return trimmed.split(/\s+/).length <= 3;
}

function isShort(text: string): boolean {
  const trimmed = text.trim();
  return trimmed.length > 0 && trimmed.length <= 40 && trimmed !== '(prompt text unavailable)';
}

function isPremiumModel(model: string): boolean {
  const m = model.toLowerCase();
  return PREMIUM_MODEL_HINTS.some((hint) => m.includes(hint));
}

function exampleTexts(turns: readonly AnalyzableTurn[]): string[] {
  const out: string[] = [];
  for (const t of turns) {
    const s = snippetOf(t.text);
    if (s) {
      out.push(s);
    }
    if (out.length >= MAX_EXAMPLES) {
      break;
    }
  }
  return out;
}

function snippetOf(text: string | undefined): string {
  const trimmed = (text ?? '').replace(/\s+/g, ' ').trim();
  if (!trimmed || trimmed === '(prompt text unavailable)') {
    return '';
  }
  return trimmed.length > 80 ? `${trimmed.slice(0, 79)}\u2026` : trimmed;
}

function groupBy<T, K>(items: readonly T[], key: (item: T) => K): Map<K, T[]> {
  const map = new Map<K, T[]>();
  for (const item of items) {
    const k = key(item);
    const arr = map.get(k) ?? [];
    arr.push(item);
    map.set(k, arr);
  }
  return map;
}
