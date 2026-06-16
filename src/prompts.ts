/** View-model for the "Priciest prompts" leaderboard and the per-prompt detail drawer. */

/** One ranked prompt row (a user message plus the model calls it triggered). */
export interface PromptRow {
  /** Stable id `${sessionId}#${index}`, used to request detail on click. */
  id: string;
  /** Rank position, 1-based. */
  rank: number;
  /** Prompt text, truncated and single-lined. */
  text: string;
  /** Cost, formatted (e.g. "$0.42"). */
  costFmt: string;
  /** Credits, formatted (e.g. "42"). */
  creditsFmt: string;
  /** Total tokens, formatted (e.g. "128K"). */
  tokensFmt: string;
  /** Billable model calls in this turn. */
  calls: number;
  /** Distinct models used, top first (e.g. "claude-opus"). */
  modelLabel: string;
  /** Relative time label (e.g. "2h ago"). */
  whenFmt: string;
  /** Share of the scope's total spend, 0-100 (bar width). */
  pct: number;
  /** True when cost is token-estimated (no billed credits in the log). */
  estimated: boolean;
}

/** The measured priciest-prompts view for one scope. */
export interface TopPromptsMeasured {
  /** Ranked prompts, most expensive first (capped to the top N). */
  rows: PromptRow[];
  /** Total prompts considered (before the top-N cap). */
  totalPrompts: number;
}

/** One model call row inside the detail drawer. */
export interface PromptCallRow {
  whenFmt: string;
  model: string;
  inputFmt: string;
  cachedFmt: string;
  outputFmt: string;
  reasoningFmt: string;
  costFmt: string;
  /** Reasoning effort label (e.g. "high"), or empty. */
  effort: string;
}

/** Full detail for one prompt, loaded on demand when a row is clicked. */
export interface PromptDetailView {
  id: string;
  /** Full prompt text. */
  promptText: string;
  /** Assistant's visible reply text (empty when none was logged). */
  responseText: string;
  /** Headline cost, formatted. */
  costFmt: string;
  creditsFmt: string;
  totalTokensFmt: string;
  inputFmt: string;
  cachedFmt: string;
  outputFmt: string;
  reasoningFmt: string;
  modelLabel: string;
  whenFmt: string;
  /** Per-call usage rows. */
  calls: PromptCallRow[];
  /** Tools invoked during the turn (name + count). */
  toolCalls: { name: string; countFmt: string }[];
  /** True when cost is token-estimated (no billed credits). */
  estimated: boolean;
}
