import { type CostTier } from './rates';

/** Inputs the score engine reasons over. All measured/estimated client-side. */
export interface Signals {
  modelName: string;
  modelTier: CostTier;
  /** Token count of the active editor/selection (proxy for "what you'd attach"). */
  contextTokens: number;
  /** Long-context pricing threshold for the model, if any. */
  longCtxThreshold?: number;
  /** Number of language-model tools currently registered/enabled. */
  toolCount: number;
  /** Whether a copilot-instructions / instructions file exists in the workspace. */
  hasInstructions: boolean;
}

export type Severity = 'ok' | 'warn' | 'bad';
export type Band = 'green' | 'yellow' | 'red';

export interface Factor {
  label: string;
  detail: string;
  severity: Severity;
}

export interface Assessment {
  band: Band;
  /** One-sentence, plain-language takeaway. */
  conclusion: string;
  factors: Factor[];
}

/** Context at/above this materially adds per-turn cost even without a long-context cliff. */
const LARGE_CONTEXT_TOKENS = 60_000;

/**
 * Turn raw signals into a colour band + conclusion. No points: the band is the worst
 * severity among the real cost levers (model price tier, context size / long-context
 * cliff, tool schema tax, broad auto-context). Instructions are advisory only.
 */
export function assess(s: Signals): Assessment {
  const factors: Factor[] = [];

  // --- Model price tier: the biggest lever on $/token ---------------------
  const modelSeverity: Severity =
    s.modelTier === 'top' ? 'bad' : s.modelTier === 'mid' ? 'warn' : 'ok';
  factors.push({
    label: 'Model',
    detail:
      s.modelTier === 'top'
        ? `${s.modelName}: top price tier`
        : s.modelTier === 'mid'
          ? `${s.modelName}: mid price tier`
          : `${s.modelName}: economy tier`,
    severity: modelSeverity,
  });

  // --- Context size: the lever you control every turn. Bigger = more cost --
  const context = assessContext(s);
  factors.push({ label: 'Context', detail: context.detail, severity: context.severity });

  // --- Tool schema tax: re-sent every turn --------------------------------
  factors.push(
    s.toolCount > 10
      ? {
          label: 'Tools',
          detail: `${s.toolCount} tools enabled; schemas re-sent every turn`,
          severity: 'warn',
        }
      : { label: 'Tools', detail: `${s.toolCount} tools enabled`, severity: 'ok' },
  );

  // --- Instructions: advisory (constrains reply length), never reddens ----
  factors.push(
    s.hasInstructions
      ? { label: 'Instructions', detail: 'instructions file present', severity: 'ok' }
      : {
          label: 'Instructions',
          detail: 'no instructions file; optional, helps keep replies short',
          severity: 'ok',
        },
  );

  const band = worstBand(factors);
  return { band, conclusion: conclude(s, band, modelSeverity, context.severity), factors };
}

function assessContext(s: Signals): { severity: Severity; detail: string } {
  const tokens = fmtTokens(s.contextTokens);
  if (s.longCtxThreshold) {
    const ratio = s.contextTokens / s.longCtxThreshold;
    if (ratio >= 0.9) {
      return {
        severity: 'bad',
        detail: `${tokens}: past the long-context cliff; the rate ~doubles on every token`,
      };
    }
    if (ratio >= 0.75) {
      return {
        severity: 'warn',
        detail: `${tokens}: nearing the long-context cliff at ${fmtTokens(s.longCtxThreshold)}`,
      };
    }
  }
  if (s.contextTokens >= LARGE_CONTEXT_TOKENS) {
    return { severity: 'warn', detail: `${tokens}: large; every added token costs more` };
  }
  return { severity: 'ok', detail: `${tokens}: small; low cost per message` };
}

function worstBand(factors: Factor[]): Band {
  if (factors.some((f) => f.severity === 'bad')) {
    return 'red';
  }
  if (factors.some((f) => f.severity === 'warn')) {
    return 'yellow';
  }
  return 'green';
}

function conclude(s: Signals, band: Band, modelSev: Severity, contextSev: Severity): string {
  if (band === 'red') {
    if (contextSev === 'bad') {
      return `Past the long-context cliff on ${s.modelName}: each turn costs about double. Trim attached context or split the task.`;
    }
    return `${s.modelName} is a top-tier model; pricey per token. Use a cheaper model for routine work, or keep context small.`;
  }
  if (band === 'yellow') {
    if (contextSev === 'warn') {
      return `Context is getting large; cost climbs with every token you add. Attach only what the task needs.`;
    }
    if (modelSev === 'warn') {
      return `${s.modelName} is mid-priced, but watch how much context you attach.`;
    }
      return `A couple of settings are nudging cost up; see the factors below.`;
  }
  return `Lean setup; low cost per message. Nothing to change.`;
}

export function bandWord(band: Band): string {
  switch (band) {
    case 'green':
      return 'Lean';
    case 'yellow':
      return 'Watch';
    case 'red':
      return 'Costly';
  }
}

/** Compact, friendly USD formatting that never collapses small non-zero costs to $0.00. */
export function fmtUSD(n: number): string {
  if (n <= 0) {
    return '$0';
  }
  if (n < 0.01) {
    return '<$0.01';
  }
  if (n < 1) {
    return `$${n.toFixed(3)}`;
  }
  return `$${n.toFixed(2)}`;
}

export function fmtTokens(n: number): string {
  if (n >= 1_000_000) {
    return `${(n / 1_000_000).toFixed(1)}M`;
  }
  if (n >= 1000) {
    return `${Math.round(n / 1000)}K`;
  }
  return `${n}`;
}
