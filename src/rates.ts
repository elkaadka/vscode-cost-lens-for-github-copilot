/**
 * Per-model pricing.
 *
 * The live source of truth is Copilot's own `models.json` catalog (read from the debug logs),
 * which carries exact per-model `billing.token_prices`. Those are parsed by
 * {@link parseModelCatalog} and registered via {@link setModelCatalog}, after which
 * {@link resolveRate} returns live prices for every model GitHub currently ships.
 *
 * The hardcoded {@link RATES} table below is only a FALLBACK used before any `models.json` has
 * been read (e.g. first run, logging off, or an unreadable catalog). Prices and models change, so
 * we never rely on it when the live catalog is available.
 *
 * Rates last verified: 2026-06-08 (GitHub models-and-pricing page). Values are USD per 1M tokens.
 */

export type CostTier = 'economy' | 'mid' | 'top';

/** `models.json` output-price tier cutoffs, in credits per 1M tokens (1 credit = $0.01). */
const TOP_TIER_CREDITS = 2_500;
const MID_TIER_CREDITS = 1_000;

export interface ModelRate {
  /** USD per 1M input tokens (below the long-context threshold). */
  inputPerM: number;
  /** USD per 1M cached input tokens. */
  cachedPerM: number;
  /** USD per 1M output tokens. */
  outputPerM: number;
  /** Token count above which the long-context (premium) tier applies. */
  longCtxThreshold?: number;
  /** USD per 1M input tokens above the threshold. */
  longInputPerM?: number;
  /** USD per 1M cached tokens above the threshold. */
  longCachedPerM?: number;
  /** USD per 1M output tokens above the threshold. */
  longOutputPerM?: number;
  /** Coarse cost tier used by the score engine. */
  tier: CostTier;
}

/** Fallback snapshot, used only until a live `models.json` catalog is registered. */
export const RATES: Record<string, ModelRate> = {
  'gpt-5-mini': { inputPerM: 0.25, cachedPerM: 0.025, outputPerM: 2.0, tier: 'economy' },
  'gpt-5.4': {
    inputPerM: 2.5,
    cachedPerM: 0.25,
    outputPerM: 15.0,
    longCtxThreshold: 272_000,
    longInputPerM: 5.0,
    longCachedPerM: 0.5,
    longOutputPerM: 22.5,
    tier: 'mid',
  },
  'gpt-5.5': {
    inputPerM: 5.0,
    cachedPerM: 0.5,
    outputPerM: 30.0,
    longCtxThreshold: 272_000,
    longInputPerM: 10.0,
    longCachedPerM: 1.0,
    longOutputPerM: 45.0,
    tier: 'top',
  },
  'claude-sonnet-4.6': { inputPerM: 3.0, cachedPerM: 0.3, outputPerM: 15.0, tier: 'mid' },
  'claude-opus-4.8': { inputPerM: 5.0, cachedPerM: 0.5, outputPerM: 25.0, tier: 'top' },
  'gemini-3.1-pro': {
    inputPerM: 2.0,
    cachedPerM: 0.2,
    outputPerM: 12.0,
    longCtxThreshold: 200_000,
    longInputPerM: 4.0,
    longCachedPerM: 0.4,
    longOutputPerM: 24.0,
    tier: 'mid',
  },
};

/** Used when a model can't be matched to the table. */
export const DEFAULT_RATE: ModelRate = {
  inputPerM: 3.0,
  cachedPerM: 0.3,
  outputPerM: 15.0,
  tier: 'mid',
};

export interface ModelKey {
  id?: string;
  family?: string;
}

/** Live catalog parsed from `models.json`, or undefined until {@link setModelCatalog} runs. */
let liveRates: Record<string, ModelRate> | undefined;
/** Curated subset of {@link liveRates}: user-selectable, non-internal chat models. */
let liveSuggestable: Record<string, ModelRate> | undefined;

/** Coerce to a finite number, else undefined. */
function asNum(v: unknown): number | undefined {
  return typeof v === 'number' && Number.isFinite(v) ? v : undefined;
}

/** Tier a model from its output price in credits per 1M tokens. */
function tierOf(outputCredits: number): CostTier {
  return outputCredits >= TOP_TIER_CREDITS ? 'top' : outputCredits >= MID_TIER_CREDITS ? 'mid' : 'economy';
}

/**
 * Parse Copilot's `models.json` into rate tables. Returns two maps keyed by lowercased model id:
 * `all` (every model with billing, for cost lookups) and `suggestable` (picker-enabled, non-internal
 * chat models, for the "switch model" suggestion). Prices in `models.json` are credits per 1M tokens
 * (1 credit = $0.01), so USD/1M = credits / 100. The optional `long_context` tier is recorded only
 * when its prices exceed the default (i.e. there's a real cliff). Never throws.
 */
export function parseModelCatalog(raw: string): {
  all: Record<string, ModelRate>;
  suggestable: Record<string, ModelRate>;
} {
  const all: Record<string, ModelRate> = {};
  const suggestable: Record<string, ModelRate> = {};
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return { all, suggestable };
  }
  if (!Array.isArray(parsed)) {
    return { all, suggestable };
  }
  for (const entry of parsed) {
    const m = entry as Record<string, unknown>;
    const id = typeof m.id === 'string' ? m.id.toLowerCase() : undefined;
    if (!id) {
      continue;
    }
    const tp = (m.billing as Record<string, unknown> | undefined)?.token_prices as
      | Record<string, unknown>
      | undefined;
    const def = tp?.default as Record<string, unknown> | undefined;
    const input = asNum(def?.input_price);
    const cached = asNum(def?.cache_price);
    const output = asNum(def?.output_price);
    if (input === undefined || cached === undefined || output === undefined) {
      continue; // No billing (embeddings, etc.) → not a costable model.
    }
    const rate: ModelRate = {
      inputPerM: input / 100,
      cachedPerM: cached / 100,
      outputPerM: output / 100,
      tier: tierOf(output),
    };
    // Long-context premium tier, only when it actually costs more than the default tier.
    const long = tp?.long_context as Record<string, unknown> | undefined;
    const threshold = asNum(def?.context_max);
    const lInput = asNum(long?.input_price);
    const lOutput = asNum(long?.output_price);
    if (long && threshold !== undefined && lInput !== undefined && lOutput !== undefined &&
      (lInput > input || lOutput > output)) {
      rate.longCtxThreshold = threshold;
      rate.longInputPerM = lInput / 100;
      rate.longCachedPerM = (asNum(long?.cache_price) ?? cached) / 100;
      rate.longOutputPerM = lOutput / 100;
    }
    all[id] = rate;

    const caps = m.capabilities as Record<string, unknown> | undefined;
    const pickerEnabled = m.model_picker_enabled === true && caps?.type === 'chat';
    if (pickerEnabled && !id.includes('internal')) {
      suggestable[id] = rate;
    }
  }
  return { all, suggestable };
}

/** Register a live `models.json` catalog so {@link resolveRate} returns current prices. Ignores empty parses. */
export function setModelCatalog(raw: string): void {
  const { all, suggestable } = parseModelCatalog(raw);
  if (Object.keys(all).length > 0) {
    liveRates = all;
    liveSuggestable = suggestable;
  }
}

/** The active rate table: the live `models.json` catalog when available, else the bundled fallback. */
function activeRates(): Record<string, ModelRate> {
  return liveRates ?? RATES;
}

/** Models worth suggesting as a cheaper switch: live picker-enabled set, else the bundled fallback. */
export function suggestableRates(): Record<string, ModelRate> {
  return liveSuggestable ?? RATES;
}

function resolveBase(model: ModelKey | undefined): ModelRate {
  if (!model) {
    return DEFAULT_RATE;
  }
  const table = activeRates();
  const keys = [model.id, model.family]
    .filter((k): k is string => !!k)
    .map((k) => k.toLowerCase());

  // Exact match first.
  for (const k of keys) {
    if (table[k]) {
      return table[k];
    }
  }
  // Then a forgiving substring match (e.g. "copilot/gpt-5.4" -> "gpt-5.4").
  for (const k of keys) {
    const hit = Object.keys(table).find((rk) => k.includes(rk) || rk.includes(k));
    if (hit) {
      return table[hit];
    }
  }
  return DEFAULT_RATE;
}

/**
 * Resolve a model to its rate.
 */
export function resolveRate(model: ModelKey | undefined): ModelRate {
  return resolveBase(model);
}

/** Threshold-aware input cost in USD for a given token count. */
export function inputCostUSD(rate: ModelRate, tokens: number): number {
  const overCliff = rate.longCtxThreshold !== undefined && tokens > rate.longCtxThreshold;
  const perM = overCliff && rate.longInputPerM !== undefined ? rate.longInputPerM : rate.inputPerM;
  return (tokens / 1_000_000) * perM;
}

/**
 * Threshold-aware output cost in USD. The long-context (premium) tier is keyed off the
 * size of the *input/context*; past the cliff the higher rate applies to output too.
 */
export function outputCostUSD(rate: ModelRate, outputTokens: number, contextTokens = 0): number {
  const overCliff = rate.longCtxThreshold !== undefined && contextTokens > rate.longCtxThreshold;
  const perM =
    overCliff && rate.longOutputPerM !== undefined ? rate.longOutputPerM : rate.outputPerM;
  return (outputTokens / 1_000_000) * perM;
}

/**
 * Threshold-aware cost in USD for prompt tokens served from cache. Cached tokens are a
 * *subset* of the reported input tokens and bill at the (much cheaper) cached rate, so
 * callers must charge only the non-cached remainder at the full input rate. The cliff is
 * keyed off total context size, mirroring {@link outputCostUSD}.
 */
export function cachedCostUSD(rate: ModelRate, cachedTokens: number, contextTokens = 0): number {
  const overCliff = rate.longCtxThreshold !== undefined && contextTokens > rate.longCtxThreshold;
  const perM =
    overCliff && rate.longCachedPerM !== undefined ? rate.longCachedPerM : rate.cachedPerM;
  return (cachedTokens / 1_000_000) * perM;
}

/** The output USD-per-1M rate that applies given the current context size (for display). */
export function outputRatePerM(rate: ModelRate, contextTokens = 0): number {
  const overCliff = rate.longCtxThreshold !== undefined && contextTokens > rate.longCtxThreshold;
  return overCliff && rate.longOutputPerM !== undefined ? rate.longOutputPerM : rate.outputPerM;
}
