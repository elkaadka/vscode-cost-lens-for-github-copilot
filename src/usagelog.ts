import * as vscode from 'vscode';
import * as fsp from 'fs/promises';
import { type Dirent } from 'fs';
import * as path from 'path';
import { countTokens } from './tokenizer';
import { setModelCatalog } from './rates';

/**
 * Reader for GitHub Copilot Chat's on-disk usage logs: the only source of *real*,
 * measured per-request token counts an extension can reach.
 *
 * IMPORTANT: this parses an undocumented, preview-stage log format
 * (`…/GitHub.copilot-chat/debug-logs/<sessionId>/main.jsonl`). Microsoft can change
 * it without notice. Every function here is therefore defensive: it verifies at runtime,
 * skips anything it doesn't recognise, and degrades to "no data" rather than throwing or
 * inventing numbers. Callers must treat an empty result as "can't measure", never as zero cost.
 */

const COPILOT_CHAT_DIR = 'GitHub.copilot-chat';
const DEBUG_LOGS_DIR = 'debug-logs';
const MAIN_LOG = 'main.jsonl';
/** Model catalog written next to each session's `main.jsonl`; carries per-model effort capability. */
const MODELS_FILE = 'models.json';
/** Bytes read per catch-up iteration, so a large session file never balloons memory. */
const CHUNK_BYTES = 4 * 1024 * 1024;
/** Cap on catch-up iterations per tick (bounds work when a file is being written fast). */
const MAX_CATCHUP_STEPS = 64;
/** Most-recently-used sessions to compute a per-session cache breakdown for (bounds sidecar IO). */
const MAX_CACHE_SESSIONS = 10;

/** One billable model call, distilled from a `chat:` span. */
export interface UsageSpan {
  /** Dedup key: the span id, or a synthesized fallback when the log omits it. */
  key: string;
  sessionId: string;
  ts: number;
  model: string;
  inputTokens: number;
  outputTokens: number;
  cachedTokens: number;
  /** Copilot's native billing unit (AI Units), i.e. `copilotUsageNanoAiu / 1e9`. */
  aiu: number;
  /** Name of the `system_prompt_*.json` this request used (for cache prefix sizing). */
  systemPromptFile?: string;
  /** Name of the `tools_*.json` this request used (for tool-schema sizing). */
  toolsFile?: string;
  /**
   * Configured thinking/reasoning effort, if observable. Vendor-specific location:
   * OpenAI/MAI `reasoning.effort`, Anthropic Opus `output_config.effort`. Sonnet/Haiku (fixed
   * thinking budget) and Gemini (nothing) yield undefined. Lowercased, e.g. "high" / "xhigh".
   */
  effort?: string;
}

/** One user prompt and every billable model call it triggered (the whole agent tool-loop). */
export interface PromptTurn {
  /** Stable id `${sessionId}#${index}` (index = ordinal of the user message within its session). */
  id: string;
  sessionId: string;
  /** 0-based order of this prompt within its session. */
  index: number;
  /** Epoch ms of the user message (falls back to the first span's ts). */
  ts: number;
  /** Prompt text, truncated for the list (full text comes from {@link loadPromptDetail}). */
  text: string;
  /** Distinct models used across the turn's calls, most-used first. */
  models: string[];
  /** Billable model calls in this turn. */
  calls: number;
  inputTokens: number;
  cachedTokens: number;
  outputTokens: number;
  /** Estimated reasoning tokens (billed output − visible output), summed across calls. */
  reasoningTokens: number;
  /** Real billed credits summed across calls (0 when the log carried none). */
  aiu: number;
  /** True when no call carried billed credits, so any cost is token-estimated, not measured. */
  estimated: boolean;
}

/** One billable model call inside a {@link PromptDetail}. */
export interface PromptCall {
  ts: number;
  model: string;
  inputTokens: number;
  cachedTokens: number;
  outputTokens: number;
  /** Estimated reasoning tokens for this call (billed output − visible output). */
  reasoningTokens: number;
  aiu: number;
  /** Configured reasoning effort, when the vendor exposes it. */
  effort?: string;
}

/** Full, on-demand detail for one prompt turn: prompt text, reply text, and per-call usage. */
export interface PromptDetail {
  id: string;
  sessionId: string;
  index: number;
  ts: number;
  /** Full prompt text. */
  promptText: string;
  /** Assistant's visible reply text, concatenated across the turn's calls. */
  responseText: string;
  /** Names of tools invoked during the turn (chronological, with duplicates collapsed by count). */
  toolCalls: { name: string; count: number }[];
  models: string[];
  calls: PromptCall[];
  inputTokens: number;
  cachedTokens: number;
  outputTokens: number;
  reasoningTokens: number;
  aiu: number;
  estimated: boolean;
}

/** A group of tools (built-in or one MCP server) and the schema tokens it adds to every request. */
export interface ToolGroup {
  /** "(built-in)" or the MCP server id parsed from the tool-name prefix. */
  group: string;
  toolCount: number;
  /** Estimated schema tokens this group contributes to the cached prefix. */
  tokens: number;
}

/** A single tool and the schema tokens it contributes to the cached prefix. */
export interface ToolEntry {
  name: string;
  /** The tool's group: "(built-in)" or its MCP server id. */
  group: string;
  /** Estimated schema tokens for this one tool. */
  tokens: number;
}

/**
 * Breakdown of the cached prompt prefix ("what's in the cache") for the most recent request,
 * plus the workspace-wide cache hit rate. The prefix (system prompt + tool schemas + conversation
 * history) is re-sent every turn and served from cache when unchanged, so it's the single biggest
 * lever on input cost. Token sizes use the model's tiktoken tokenizer; hit rate is exact from the log.
 */
export interface CacheBreakdown {
  /** Cached ÷ input across all measured requests, 0–100 (exact). */
  hitRatePct: number;
  /** The most recent request's total input tokens (the live prefix size). */
  contextTokens: number;
  /** Estimated system-prompt tokens in the prefix. */
  systemPromptTokens: number;
  /** Estimated tool-schema tokens in the prefix. */
  toolsTokens: number;
  /** Number of tools defined in the prefix. */
  toolCount: number;
  /** Estimated conversation-history tokens (context − system − tools). */
  historyTokens: number;
  /** Tool schema tokens grouped by built-in vs each MCP server, largest first. */
  toolGroups: ToolGroup[];
  /** Individual tools by schema size, largest first (for the per-tool breakdown). */
  topTools: ToolEntry[];
  /** Model of the most recent request. */
  model: string;
}

/**
 * A {@link CacheBreakdown} for one chat session, tagged with which session it is and how recently
 * it was used. The cache prefix is inherently session-scoped (history, tools and system prompt all
 * belong to one conversation), so this is the honest unit: a brand-new chat shows its own small
 * prefix instead of the workspace average. Hit rate and savings are computed from that session's
 * own requests only.
 */
export interface SessionCache extends CacheBreakdown {
  /** Full session id (the `debug-logs` sub-directory name). */
  sessionId: string;
  /** Human-readable title (from the session's `title-*.jsonl`), or undefined if not available. */
  title?: string;
  /** Epoch ms of this session's most recent request (for sorting + a relative-time label). */
  lastTs: number;
  /** Billable requests recorded in this session. */
  requests: number;
  /** This session's total input tokens (for per-session savings). */
  sessionInputTokens: number;
  /** This session's total cached tokens (for per-session savings). */
  sessionCachedTokens: number;
  /** This session's total output tokens (for the session-scoped composition bars). */
  sessionOutputTokens: number;
  /** This session's estimated reasoning tokens (output − visible), for composition bars. */
  sessionReasoningTokens: number;
  /** This session's billed AI Units (for the session-scoped cost bar). */
  sessionAiu: number;
}

/** One tool from the live schema, flagged used/unused with its invocation count. */
export interface ToolUsage {
  /** Tool id, e.g. `read_file` or `mcp_fabric_…`. */
  name: string;
  /** "(built-in)" or the MCP server id parsed from the name prefix. */
  group: string;
  /** Whether this tool was actually invoked at least once. */
  used: boolean;
  /** Number of times it was invoked (0 when unused). */
  calls: number;
}

/**
 * "Tools" breakdown: every tool defined in the most recent request's schema, flagged used or
 * unused, joined with the tool invocations seen across all sessions. The total comes from the
 * live `tools_*.json` schema; usage comes from `tool_call` spans. Undefined until a request with a
 * tools schema has been measured.
 */
export interface ToolsBreakdown {
  /** Tools defined in the live schema. */
  totalCount: number;
  /** Distinct schema tools that were invoked at least once. */
  usedCount: number;
  /** Total tool invocations across all sessions. */
  totalCalls: number;
  /** Every defined tool, used ones first (then by call count, then name). */
  tools: ToolUsage[];
  /** Tools invoked but absent from the live schema (schema drift); names only. */
  unknownUsed: string[];
}


/** Per-model usage rollup, used for the "top models" breakdown. */
export interface ModelUsage {
  model: string;
  /** Distinct billable calls attributed to this model. */
  requests: number;
  inputTokens: number;
  outputTokens: number;
  cachedTokens: number;
  aiu: number;
  /** input + output, the figure the UI ranks models by. */
  totalTokens: number;
}

/** Per-day, per-model token usage, used for the weekly stacked bar chart. */
export interface DayUsage {
  /** Local calendar day as `YYYY-MM-DD`. */
  day: string;
  /** input + output tokens that day, summed across all models. */
  totalTokens: number;
  /** Tokens per model that day (input + output), keyed by model id. */
  byModel: Record<string, number>;
}

/**
 * The current run of high-tier reasoning ending at the most recent call, the signal behind the
 * "still on high reasoning" tip. Fires only when the newest call overall classifies as high-tier:
 * an explicit high/xhigh/max literal, OR, on an adaptive-thinking model (Anthropic Opus family,
 * per `models.json`), an absent effort, since those models omit the effort parameter at their high
 * default and never serialize the top levels (xhigh/max). Walking back, calls with no usable signal
 * (Gemini, Sonnet/Haiku, or any non-adaptive model with absent effort) are skipped without breaking
 * the run; an explicit non-high literal (none/minimal/low/medium) ends it. Undefined when the latest
 * activity doesn't classify as high.
 */
export interface ReasoningStreak {
  /** The current level: a literal ("high"/"xhigh") or "high" when inferred from an adaptive model. */
  effort: string;
  /** Model of the latest high-tier call. */
  model: string;
  /** Consecutive high-tier calls in the run. */
  calls: number;
  /** Minutes spanned by the run (latest − earliest call); 0 for a single call. */
  minutes: number;
  /** Estimated reasoning tokens summed across the run (output − visible). */
  reasoningTokens: number;
  /** True when high-tier was inferred from an adaptive model's absent effort, not a literal level. */
  inferred: boolean;
}

/** Aggregated usage across a set of distinct billable calls. */
export interface UsageTotals {
  /** Distinct billable model calls (NOT user turns; one turn fans out to many calls). */
  requests: number;
  inputTokens: number;
  outputTokens: number;
  cachedTokens: number;
  aiu: number;
  /** Distinct models seen, most-used first (by total tokens). */
  models: string[];
  /** Per-model rollup, ranked by total tokens descending. */
  modelUsage: ModelUsage[];
  /** Per-day rollup (oldest first), each with a per-model token breakdown. */
  daily: DayUsage[];
  /** Distinct chat sessions that contributed usage. */
  sessions: number;
  /**
   * Estimated tokens the model spent on private reasoning, summed across requests we could pair
   * with their visible response. Derived (not logged): `outputTokens - visibleOutputTokens`,
   * where visible output is approximated from the assistant text + tool-call arguments. Always an
   * estimate; present it as "≈".
   */
  reasoningTokens: number;
  /** Number of `.jsonl` log files included in the last scan. */
  filesScanned: number;
  /** Epoch ms when the last full scan completed (0 = never scanned). */
  lastAnalyzed: number;
  /** Cache prefix breakdown for the most recent request (undefined until computed). */
  cacheBreakdown?: CacheBreakdown;
  /**
   * Per-session cache breakdowns, most-recently-used first. The first entry is the active session.
   * Undefined until computed. Each is scoped to its own conversation, so composition and hit rate
   * reflect that chat alone rather than the workspace aggregate.
   */
  cacheSessions?: SessionCache[];
  /** Tool usage breakdown (used vs defined), undefined until a tools schema is measured. */
  toolsBreakdown?: ToolsBreakdown;
  /** Current high-reasoning streak, undefined when the latest effort-bearing call isn't high-tier. */
  reasoningStreak?: ReasoningStreak;
  /** Output price (credits per 1M tokens) per model id, from models.json. Tiers each model. */
  modelPrices?: Record<string, number>;
  /** Per-prompt turns (one user message + its tool-loop calls), unranked. Undefined until built. */
  promptTurns?: PromptTurn[];
}

export function emptyTotals(): UsageTotals {
  return {
    requests: 0,
    inputTokens: 0,
    outputTokens: 0,
    cachedTokens: 0,
    aiu: 0,
    models: [],
    modelUsage: [],
    daily: [],
    sessions: 0,
    reasoningTokens: 0,
    filesScanned: 0,
    lastAnalyzed: 0,
  };
}

/** Local-time `YYYY-MM-DD` for an epoch-ms timestamp (buckets the weekly chart by calendar day). */
function dayKey(ts: number): string {
  const d = new Date(ts);
  const y = d.getFullYear();
  const m = `${d.getMonth() + 1}`.padStart(2, '0');
  const day = `${d.getDate()}`.padStart(2, '0');
  return `${y}-${m}-${day}`;
}

/** A finite, non-negative number, or undefined. */
function num(v: unknown): number | undefined {
  return typeof v === 'number' && Number.isFinite(v) && v >= 0 ? v : undefined;
}

function str(v: unknown): string | undefined {
  return typeof v === 'string' && v.length > 0 ? v : undefined;
}

/**
 * Parse a `tool_call` span into its dedup id + tool name, or undefined if the line isn't one.
 * Each tool invocation is logged as its own span (`type: "tool_call"`, `name: "<tool>"`); we use
 * these to tell which schema tools were actually used. Never throws.
 */
export function parseToolCallLine(line: string): { spanId: string; name: string } | undefined {
  const trimmed = line.trim();
  if (!trimmed || !trimmed.includes('"tool_call"')) {
    return undefined;
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(trimmed);
  } catch {
    return undefined;
  }
  if (!parsed || typeof parsed !== 'object') {
    return undefined;
  }
  const o = parsed as Record<string, unknown>;
  if (o.type !== 'tool_call') {
    return undefined;
  }
  const name = str(o.name);
  if (!name) {
    return undefined;
  }
  const spanId = str(o.spanId) ?? `${num(o.ts) ?? Math.random()}`;
  return { spanId, name };
}

/**
 * Extract the configured reasoning/thinking effort from a request's `requestOptions` (a JSON
 * string). Location is vendor-specific: OpenAI/MAI `reasoning.effort`, Anthropic Opus
 * `output_config.effort`. Sonnet/Haiku (fixed thinking budget) and Gemini (nothing) yield
 * undefined. Returns a lowercased level (e.g. "high") or undefined. Never throws.
 */
function parseEffort(raw: unknown): string | undefined {
  if (typeof raw !== 'string') {
    return undefined;
  }
  let ro: unknown;
  try {
    ro = JSON.parse(raw);
  } catch {
    return undefined;
  }
  if (!ro || typeof ro !== 'object') {
    return undefined;
  }
  const o = ro as Record<string, unknown>;
  const reasoning = o.reasoning as Record<string, unknown> | undefined;
  const outputConfig = o.output_config as Record<string, unknown> | undefined;
  const eff = str(reasoning?.effort) ?? str(outputConfig?.effort);
  return eff ? eff.toLowerCase() : undefined;
}

/** Per-model reasoning-effort capability, distilled from `models.json`. */
export interface ModelEffortCaps {
  /** Effort levels the model accepts (capabilities.supports.reasoning_effort); empty = no knob. */
  effortLevels: string[];
  /**
   * True for Anthropic adaptive-thinking models (capabilities.supports.adaptive_thinking). These
   * omit the effort parameter at their high default and never serialize the top levels (xhigh/max),
   * so an absent effort means "high or above", not "unknown". For every other model an absent
   * effort is uninformative (a knob that never serializes, e.g. Gemini, or no knob at all).
   */
  adaptiveThinking: boolean;
  /** The model's tokenizer name (capabilities.tokenizer), e.g. "o200k_base". Used for exact counts. */
  tokenizer?: string;
  /** Output price in credits per 1M tokens (billing.token_prices.default.output_price). Tiers the model. */
  outputPricePer1M?: number;
}

/**
 * Parse Copilot's `models.json` catalog into a map of model id → reasoning-effort capability. Each
 * entry's `capabilities.supports.reasoning_effort` lists its valid levels and `adaptive_thinking`
 * flags the Anthropic adaptive family. Keys are lowercased. Empty map on any parse failure. Never throws.
 */
export function parseModelsFile(raw: string): Map<string, ModelEffortCaps> {
  const out = new Map<string, ModelEffortCaps>();
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return out;
  }
  if (!Array.isArray(parsed)) {
    return out;
  }
  for (const entry of parsed) {
    const m = entry as Record<string, unknown>;
    const id = str(m.id);
    if (!id) {
      continue;
    }
    const caps = m.capabilities as Record<string, unknown> | undefined;
    const supports = caps?.supports as Record<string, unknown> | undefined;
    if (!supports) {
      continue;
    }
    const levels = Array.isArray(supports.reasoning_effort)
      ? (supports.reasoning_effort as unknown[])
          .filter((x): x is string => typeof x === 'string')
          .map((x) => x.toLowerCase())
      : [];
    const billing = m.billing as Record<string, unknown> | undefined;
    const prices = (billing?.token_prices as Record<string, unknown> | undefined)?.default as
      | Record<string, unknown>
      | undefined;
    out.set(id.toLowerCase(), {
      effortLevels: levels,
      adaptiveThinking: supports.adaptive_thinking === true,
      tokenizer: str(caps?.tokenizer),
      outputPricePer1M: num(prices?.output_price),
    });
  }
  return out;
}

/** Read and parse `models.json`; empty map if unreadable. Never throws. Also feeds the live price
 * catalog so model rates come from GitHub's own data rather than a hardcoded snapshot. */
async function loadModelCaps(file: string): Promise<Map<string, ModelEffortCaps>> {
  try {
    const raw = await fsp.readFile(file, 'utf8');
    setModelCatalog(raw);
    return parseModelsFile(raw);
  } catch {
    return new Map();
  }
}

/**
 * A session's human-readable title. Copilot writes a `title-*.jsonl` sub-log per session: a tiny
 * model call that generates the chat title shown in the sidebar. We read that title from its
 * `agent_response`; if it's missing or empty we fall back to the first user message (which the same
 * file embeds in the title prompt). Returns undefined when nothing usable is found. Never throws.
 */
async function loadSessionTitle(sessionDir: string): Promise<string | undefined> {
  let titleFile: string | undefined;
  try {
    for (const name of await fsp.readdir(sessionDir)) {
      if (name.startsWith('title-') && name.endsWith('.jsonl')) {
        titleFile = path.join(sessionDir, name);
        break;
      }
    }
  } catch {
    return undefined;
  }
  if (!titleFile) {
    return undefined;
  }
  let raw: string;
  try {
    raw = await fsp.readFile(titleFile, 'utf8');
  } catch {
    return undefined;
  }
  let title: string | undefined;
  let firstMessage: string | undefined;
  for (const line of raw.split('\n')) {
    if (!line.trim()) {
      continue;
    }
    let o: Record<string, unknown>;
    try {
      o = JSON.parse(line) as Record<string, unknown>;
    } catch {
      continue;
    }
    const attrs = o.attrs as Record<string, unknown> | undefined;
    if (o.type === 'agent_response' && attrs?.response != null) {
      const text = visibleTextFromResponse(attrs.response);
      if (text) {
        title = text;
      }
    } else if (o.type === 'llm_request' && typeof attrs?.userRequest === 'string') {
      // The title prompt is "Please write a brief title for the following request:\n\n<MSG>".
      const m = attrs.userRequest.split(/\n\n/).slice(1).join('\n\n').trim();
      if (m) {
        firstMessage = m;
      }
    }
  }
  const clean = (s: string): string => s.replace(/\s+/g, ' ').replace(/^["']|["']$/g, '').trim();
  const pick = title ?? firstMessage;
  if (!pick) {
    return undefined;
  }
  return clean(pick);
}

/** Normalize + cap a title for display. */
function truncateTitle(s: string): string {
  const out = s.replace(/\s+/g, ' ').replace(/^["']|["']$/g, '').trim();
  return out.length > 48 ? out.slice(0, 47) + '\u2026' : out;
}

/** Extract a `user_message` line's text plus its timestamp, for grouping calls into prompt turns. */
function parseUserMessageLine(line: string): { ts: number; text: string } | undefined {
  if (!line.includes('"user_message"')) {
    return undefined;
  }
  let o: Record<string, unknown>;
  try {
    o = JSON.parse(line) as Record<string, unknown>;
  } catch {
    return undefined;
  }
  if (o.type !== 'user_message') {
    return undefined;
  }
  const attrs = o.attrs as Record<string, unknown> | undefined;
  const content = attrs?.content;
  if (typeof content !== 'string' || !content.trim()) {
    return undefined;
  }
  return { ts: num(o.ts) ?? 0, text: content.trim() };
}

/** Extract plain assistant text from an `agent_response.response` payload (string or array). */
function visibleTextFromResponse(resp: unknown): string {
  let parsed: unknown = resp;
  if (typeof resp === 'string') {
    try {
      parsed = JSON.parse(resp);
    } catch {
      return resp.trim();
    }
  }
  if (!Array.isArray(parsed)) {
    return '';
  }
  let text = '';
  for (const msg of parsed) {
    const parts = (msg as Record<string, unknown>)?.parts;
    if (!Array.isArray(parts)) {
      continue;
    }
    for (const part of parts) {
      const p = part as Record<string, unknown>;
      if (p?.type === 'text' && typeof p.content === 'string') {
        text += p.content;
      }
    }
  }
  return text.trim();
}

/**
 * Parse a single JSONL line into a {@link UsageSpan}, or undefined if it isn't a usable
 * `chat:` request span. Never throws. A schema drift that drops `inputTokens`/`outputTokens`
 * simply yields undefined here, which bubbles up as "no measurable data".
 */
export function parseSpanLine(line: string): UsageSpan | undefined {
  const trimmed = line.trim();
  if (!trimmed) {
    return undefined;
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(trimmed);
  } catch {
    return undefined;
  }
  if (!parsed || typeof parsed !== 'object') {
    return undefined;
  }
  const o = parsed as Record<string, unknown>;
  if (o.type !== 'llm_request') {
    return undefined;
  }
  const name = o.name;
  if (typeof name !== 'string' || !name.startsWith('chat:')) {
    return undefined;
  }
  const attrs = o.attrs;
  if (!attrs || typeof attrs !== 'object') {
    return undefined;
  }
  const a = attrs as Record<string, unknown>;
  const inputTokens = num(a.inputTokens);
  const outputTokens = num(a.outputTokens);
  // Without both token counts we can't honestly measure this call; drop it.
  if (inputTokens === undefined || outputTokens === undefined) {
    return undefined;
  }
  const sessionId = str(o.sid) ?? '';
  const ts = num(o.ts) ?? 0;
  const spanId = str(o.spanId);
  const responseId = str(a.responseId) ?? '';
  const key = spanId ?? `${sessionId}:${ts}:${responseId}`;
  const model = str(a.model) ?? name.slice('chat:'.length);
  const cachedTokens = num(a.cachedTokens) ?? 0;
  const nano = num(a.copilotUsageNanoAiu);
  const aiu = nano !== undefined ? nano / 1e9 : 0;
  const systemPromptFile = str(a.systemPromptFile);
  const toolsFile = str(a.toolsFile);
  const effort = parseEffort(a.requestOptions);
  return {
    key,
    sessionId,
    ts,
    model,
    inputTokens,
    outputTokens,
    cachedTokens,
    aiu,
    systemPromptFile,
    toolsFile,
    effort,
  };
}

/** A chat request's visible output, paired back to its `chat:` span by id. */
export interface VisibleResponse {
  /** The `chat:` span id this response belongs to (agent-msg- prefix stripped). */
  spanId: string;
  /** Estimated tokens of *visible* output: assistant text + tool-call arguments. */
  visibleTokens: number;
}

/** Count visible tokens in an `agent_response.response` payload (assistant text + tool-call args). */
function visibleTokensFromResponse(respStr: string): number {
  let parsed: unknown;
  try {
    parsed = JSON.parse(respStr);
  } catch {
    return countTokens(respStr);
  }
  if (!Array.isArray(parsed)) {
    return countTokens(respStr);
  }
  let text = '';
  for (const msg of parsed) {
    const parts = (msg as Record<string, unknown>)?.parts;
    if (!Array.isArray(parts)) {
      continue;
    }
    for (const part of parts) {
      const p = part as Record<string, unknown>;
      if (p?.type === 'text' && typeof p.content === 'string') {
        text += p.content;
      } else if (p?.type === 'tool_call' && p.arguments != null) {
        text += String(p.arguments);
      }
    }
  }
  // The model/tokenizer isn't known at ingest time; o200k_base (the current-gen default) is used.
  return countTokens(text);
}

/**
 * Parse an `agent_response` line into the visible-output size for its `chat:` request, or
 * undefined if it isn't one. The model's *billed* output (`outputTokens`) includes private
 * reasoning; subtracting this visible estimate yields an approximate reasoning-token count.
 * Never throws.
 */
export function parseAgentResponse(line: string): VisibleResponse | undefined {
  const trimmed = line.trim();
  if (!trimmed) {
    return undefined;
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(trimmed);
  } catch {
    return undefined;
  }
  if (!parsed || typeof parsed !== 'object') {
    return undefined;
  }
  const o = parsed as Record<string, unknown>;
  if (o.type !== 'agent_response') {
    return undefined;
  }
  const rawSpanId = str(o.spanId);
  if (!rawSpanId) {
    return undefined;
  }
  const spanId = rawSpanId.replace(/^agent-msg-/, '');
  const attrs = o.attrs as Record<string, unknown> | undefined;
  const resp = attrs?.response;
  const visibleTokens = typeof resp === 'string' ? visibleTokensFromResponse(resp) : 0;
  return { spanId, visibleTokens };
}

/** Like {@link parseAgentResponse} but also returns the visible reply *text*, for prompt detail. */
function parseAgentResponseText(
  line: string,
): { spanId: string; text: string; visibleTokens: number } | undefined {
  if (!line.includes('"agent_response"')) {
    return undefined;
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(line.trim());
  } catch {
    return undefined;
  }
  if (!parsed || typeof parsed !== 'object') {
    return undefined;
  }
  const o = parsed as Record<string, unknown>;
  if (o.type !== 'agent_response') {
    return undefined;
  }
  const rawSpanId = str(o.spanId);
  if (!rawSpanId) {
    return undefined;
  }
  const spanId = rawSpanId.replace(/^agent-msg-/, '');
  const attrs = o.attrs as Record<string, unknown> | undefined;
  const resp = attrs?.response;
  const text = typeof resp === 'string' ? visibleTextFromResponse(resp) : '';
  const visibleTokens = typeof resp === 'string' ? visibleTokensFromResponse(resp) : 0;
  return { spanId, text, visibleTokens };
}

/** Parse a `tool_call` line into its timestamp + tool name (for the per-turn tool list). */
function parseToolCallWithTs(line: string): { ts: number; name: string } | undefined {
  if (!line.includes('"tool_call"')) {
    return undefined;
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(line.trim());
  } catch {
    return undefined;
  }
  if (!parsed || typeof parsed !== 'object') {
    return undefined;
  }
  const o = parsed as Record<string, unknown>;
  if (o.type !== 'tool_call') {
    return undefined;
  }
  const name = str(o.name);
  if (!name) {
    return undefined;
  }
  return { ts: num(o.ts) ?? 0, name };
}

/** Which prompt bucket a span/tool-call belongs to: the latest user message with ts ≤ the event's
 * ts (events before the first message attach to it). Shared by the leaderboard and detail loader so
 * both group identically. */
function bucketIndexForTs(msgs: { ts: number }[], ts: number): number {
  if (msgs.length === 0) {
    return 0;
  }
  let idx = 0;
  for (let i = 0; i < msgs.length; i++) {
    if (msgs[i].ts <= ts) {
      idx = i;
    } else {
      break;
    }
  }
  return idx;
}

/** Truncate + single-line a prompt for the leaderboard list. */
function truncatePrompt(s: string, max: number): string {
  const out = s.replace(/\s+/g, ' ').trim();
  return out.length > max ? out.slice(0, max - 1) + '\u2026' : out;
}

/**
 * Group billable spans into prompt turns: each user message opens a turn that owns every later span
 * until the next user message (same session, by timestamp). One thing you type fans out into many
 * `chat:` calls in agent mode, so this is the honest "what one prompt cost" unit. Cost is the sum of
 * each call's real billed credits; turns with no credits in the log are flagged `estimated`. Pure;
 * never throws.
 */
export function buildPromptTurns(
  spans: Iterable<UsageSpan>,
  visible: Map<string, number>,
  userMessages: Map<string, { ts: number; text: string }[]>,
): PromptTurn[] {
  const bySession = new Map<string, UsageSpan[]>();
  for (const s of spans) {
    if (!s.sessionId) {
      continue;
    }
    const arr = bySession.get(s.sessionId) ?? [];
    arr.push(s);
    bySession.set(s.sessionId, arr);
  }
  const turns: PromptTurn[] = [];
  for (const [sessionId, sessionSpans] of bySession) {
    sessionSpans.sort((a, b) => a.ts - b.ts);
    const msgs = (userMessages.get(sessionId) ?? []).slice().sort((a, b) => a.ts - b.ts);
    const buckets = new Map<number, UsageSpan[]>();
    for (const s of sessionSpans) {
      const i = bucketIndexForTs(msgs, s.ts);
      const arr = buckets.get(i) ?? [];
      arr.push(s);
      buckets.set(i, arr);
    }
    for (const [i, group] of buckets) {
      if (group.length === 0) {
        continue;
      }
      const text = msgs[i]?.text ?? '(prompt text unavailable)';
      const ts = msgs[i]?.ts || group[0]?.ts || 0;
      turns.push(makePromptTurn(sessionId, i, ts, text, group, visible));
    }
  }
  return turns;
}

function makePromptTurn(
  sessionId: string,
  index: number,
  ts: number,
  text: string,
  spans: UsageSpan[],
  visible: Map<string, number>,
): PromptTurn {
  let inputTokens = 0;
  let cachedTokens = 0;
  let outputTokens = 0;
  let reasoningTokens = 0;
  let aiu = 0;
  const byModel = new Map<string, number>();
  for (const s of spans) {
    inputTokens += s.inputTokens;
    cachedTokens += s.cachedTokens;
    outputTokens += s.outputTokens;
    aiu += s.aiu;
    const vis = visible.get(`${sessionId}:${s.key}`);
    reasoningTokens += vis !== undefined ? Math.max(0, s.outputTokens - vis) : 0;
    byModel.set(s.model, (byModel.get(s.model) ?? 0) + s.inputTokens + s.outputTokens);
  }
  const models = [...byModel.entries()].sort((a, b) => b[1] - a[1]).map((e) => e[0]);
  return {
    id: `${sessionId}#${index}`,
    sessionId,
    index,
    ts,
    text: truncatePrompt(text, 200),
    models,
    calls: spans.length,
    inputTokens,
    cachedTokens,
    outputTokens,
    reasoningTokens,
    aiu,
    estimated: aiu <= 0,
  };
}

/**
 * Re-read one session's `main.jsonl` and assemble full detail for a single prompt turn (selected by
 * its 0-based `index`): the prompt text, the assistant's visible reply, the tools it invoked, and a
 * per-call usage table. Done on demand (one file, click-time) rather than held in memory. Note the
 * model's *private reasoning text* is never logged; only an estimated reasoning-token count is
 * derivable. Returns undefined if the session or turn can't be found. Never throws.
 */
export async function loadPromptDetail(
  debugLogsDir: string,
  sessionId: string,
  index: number,
): Promise<PromptDetail | undefined> {
  const file = path.join(debugLogsDir, sessionId, MAIN_LOG);
  let raw: string;
  try {
    raw = await fsp.readFile(file, 'utf8');
  } catch {
    return undefined;
  }
  const msgs: { ts: number; text: string }[] = [];
  const spans: UsageSpan[] = [];
  const respText = new Map<string, string>();
  const visTok = new Map<string, number>();
  const tools: { ts: number; name: string }[] = [];
  for (const line of raw.split('\n')) {
    if (!line.trim()) {
      continue;
    }
    const um = parseUserMessageLine(line);
    if (um) {
      msgs.push(um);
      continue;
    }
    const span = parseSpanLine(line);
    if (span) {
      span.sessionId = sessionId;
      spans.push(span);
      continue;
    }
    if (line.includes('"agent_response"')) {
      const r = parseAgentResponseText(line);
      if (r) {
        if (r.text) {
          respText.set(r.spanId, r.text);
        }
        visTok.set(r.spanId, r.visibleTokens);
      }
      continue;
    }
    const tc = parseToolCallWithTs(line);
    if (tc) {
      tools.push(tc);
    }
  }
  msgs.sort((a, b) => a.ts - b.ts);
  if (msgs.length > 0 && (index < 0 || index >= msgs.length)) {
    return undefined;
  }
  const turnSpans = spans
    .filter((s) => bucketIndexForTs(msgs, s.ts) === index)
    .sort((a, b) => a.ts - b.ts);
  if (turnSpans.length === 0) {
    return undefined;
  }
  const calls: PromptCall[] = turnSpans.map((s) => {
    const vis = visTok.get(s.key);
    return {
      ts: s.ts,
      model: s.model,
      inputTokens: s.inputTokens,
      cachedTokens: s.cachedTokens,
      outputTokens: s.outputTokens,
      reasoningTokens: vis !== undefined ? Math.max(0, s.outputTokens - vis) : 0,
      aiu: s.aiu,
      effort: s.effort,
    };
  });
  const responseText = turnSpans
    .map((s) => respText.get(s.key))
    .filter((t): t is string => !!t)
    .join('\n\n')
    .trim();
  const turnTools = tools.filter((t) => bucketIndexForTs(msgs, t.ts) === index);
  const toolCounts = new Map<string, number>();
  for (const t of turnTools) {
    toolCounts.set(t.name, (toolCounts.get(t.name) ?? 0) + 1);
  }
  const toolCalls = [...toolCounts.entries()]
    .sort((a, b) => b[1] - a[1])
    .map(([name, count]) => ({ name, count }));
  const byModel = new Map<string, number>();
  let inputTokens = 0;
  let cachedTokens = 0;
  let outputTokens = 0;
  let reasoningTokens = 0;
  let aiu = 0;
  for (const c of calls) {
    inputTokens += c.inputTokens;
    cachedTokens += c.cachedTokens;
    outputTokens += c.outputTokens;
    reasoningTokens += c.reasoningTokens;
    aiu += c.aiu;
    byModel.set(c.model, (byModel.get(c.model) ?? 0) + c.inputTokens + c.outputTokens);
  }
  const models = [...byModel.entries()].sort((a, b) => b[1] - a[1]).map((e) => e[0]);
  return {
    id: `${sessionId}#${index}`,
    sessionId,
    index,
    ts: msgs[index]?.ts || turnSpans[0]?.ts || 0,
    promptText: msgs[index]?.text ?? '(prompt text unavailable)',
    responseText,
    toolCalls,
    models,
    calls,
    inputTokens,
    cachedTokens,
    outputTokens,
    reasoningTokens,
    aiu,
    estimated: aiu <= 0,
  };
}

/** Map a tool name to its group: "(built-in)" or an MCP server id (`mcp_<server>` prefix). */
function toolGroupOf(name: string): string {
  if (!name.startsWith('mcp_')) {
    return '(built-in)';
  }
  // Convention is `mcp_<server…>_<tool>`; keep the first few segments as the server id.
  const parts = name.split('_');
  return parts.slice(0, Math.min(3, parts.length - 1)).join('_') || '(mcp)';
}

/**
 * Size a `tools_*.json` file: total schema tokens, tool count, and a per-group breakdown
 * (built-in vs each MCP server). The file stores the tool array as a JSON string under `content`.
 * Returns undefined if the file can't be read or parsed. Never throws.
 */
async function analyzeToolsFile(
  file: string,
  tokenizer?: string,
): Promise<{ tokens: number; toolCount: number; groups: ToolGroup[]; tools: ToolEntry[] } | undefined> {
  let raw: string;
  try {
    raw = await fsp.readFile(file, 'utf8');
  } catch {
    return undefined;
  }
  let tools: unknown;
  try {
    const outer = JSON.parse(raw) as Record<string, unknown>;
    const content = typeof outer.content === 'string' ? outer.content : raw;
    tools = JSON.parse(content);
  } catch {
    return undefined;
  }
  if (!Array.isArray(tools)) {
    return undefined;
  }
  const byGroup = new Map<string, { count: number; tokens: number }>();
  const entries: ToolEntry[] = [];
  let totalTokens = 0;
  for (const tool of tools) {
    const name = str((tool as Record<string, unknown>)?.name) ?? '?';
    const tokens = countTokens(JSON.stringify(tool), tokenizer);
    totalTokens += tokens;
    const g = toolGroupOf(name);
    const prev = byGroup.get(g) ?? { count: 0, tokens: 0 };
    prev.count += 1;
    prev.tokens += tokens;
    byGroup.set(g, prev);
    entries.push({ name, group: g, tokens });
  }
  const groups: ToolGroup[] = [...byGroup.entries()]
    .map(([group, v]) => ({ group, toolCount: v.count, tokens: v.tokens }))
    .sort((a, b) => b.tokens - a.tokens);
  entries.sort((a, b) => b.tokens - a.tokens);
  return {
    tokens: totalTokens,
    toolCount: tools.length,
    groups,
    tools: entries,
  };
}

/** Count tokens of a JSON sidecar file (e.g. `system_prompt_*.json`). 0 if unreadable. */
async function fileTokens(file: string, tokenizer?: string): Promise<number> {
  try {
    const raw = await fsp.readFile(file, 'utf8');
    return countTokens(raw, tokenizer);
  } catch {
    return 0;
  }
}

/** Effort levels that count as "high-tier" for the reasoning streak (vendor union). */
const HIGH_TIER_EFFORTS = new Set(['high', 'xhigh', 'max']);

/** A chronological call used to compute the current high-reasoning streak (effort may be absent). */
interface EffortSpan {
  ts: number;
  effort?: string;
  model: string;
  reasoningTokens: number;
}

/**
 * Classify a call's reasoning effort relative to the high tier:
 *  - 'high': an explicit high/xhigh/max literal, OR an absent effort on an adaptive-thinking model
 *    (Anthropic Opus family), where omitting the param means the high default or a non-serializing
 *    top level (xhigh/max).
 *  - 'other': an explicit non-high literal (none/minimal/low/medium); ends a streak.
 *  - 'none': no usable signal (no effort knob, or a knob that never serializes like Gemini):
 *    neither extends nor breaks a streak.
 */
type EffortClass = 'high' | 'other' | 'none';
function classifyEffort(effort: string | undefined, caps: ModelEffortCaps | undefined): EffortClass {
  if (effort) {
    return HIGH_TIER_EFFORTS.has(effort) ? 'high' : 'other';
  }
  return caps?.adaptiveThinking ? 'high' : 'none';
}

/**
 * Find the current run of high-tier reasoning, ending at the most recent call. "Currently on high"
 * requires the newest call overall to classify as high-tier (see {@link classifyEffort}); otherwise
 * we can't honestly claim the level is still in effect. Walking back, calls with no usable signal
 * (Gemini, Sonnet/Haiku, non-adaptive absent) are skipped without breaking the run; an explicit
 * non-high literal ends it. The per-model capability map disambiguates an absent effort: high-tier
 * on adaptive models (Opus), uninformative everywhere else.
 */
function computeReasoningStreak(
  spans: EffortSpan[],
  caps: Map<string, ModelEffortCaps>,
): ReasoningStreak | undefined {
  if (spans.length === 0) {
    return undefined;
  }
  const ordered = [...spans].sort((a, b) => a.ts - b.ts);
  const newest = ordered[ordered.length - 1];
  if (classifyEffort(newest.effort, caps.get(newest.model.toLowerCase())) !== 'high') {
    return undefined;
  }
  // Absent effort that still classified high (adaptive model) is inferred, not a literal level.
  const inferred = !newest.effort;
  let calls = 0;
  let reasoningTokens = 0;
  let earliestTs = newest.ts;
  for (let i = ordered.length - 1; i >= 0; i -= 1) {
    const cls = classifyEffort(ordered[i].effort, caps.get(ordered[i].model.toLowerCase()));
    if (cls === 'high') {
      calls += 1;
      reasoningTokens += ordered[i].reasoningTokens;
      earliestTs = ordered[i].ts;
    } else if (cls === 'other') {
      // An explicit non-high effort call (none/minimal/low/medium) ends the streak.
      break;
    }
    // 'none' → no usable signal; skip without breaking the run.
  }
  return {
    effort: newest.effort ?? 'high',
    model: newest.model,
    calls,
    minutes: Math.max(0, (newest.ts - earliestTs) / 60000),
    reasoningTokens,
    inferred,
  };
}

function aggregate(
  spans: Iterable<UsageSpan>,
  visible: Map<string, number>,
  modelCaps: Map<string, ModelEffortCaps>,
): UsageTotals {
  const totals = emptyTotals();
  const byModel = new Map<string, ModelUsage>();
  const byDay = new Map<string, DayUsage>();
  const sessions = new Set<string>();
  const effortSpans: EffortSpan[] = [];
  let reasoning = 0;
  for (const s of spans) {
    totals.requests += 1;
    totals.inputTokens += s.inputTokens;
    totals.outputTokens += s.outputTokens;
    totals.cachedTokens += s.cachedTokens;
    totals.aiu += s.aiu;
    if (s.sessionId) {
      sessions.add(s.sessionId);
    }

    // Reasoning estimate: billed output minus visible output, for requests we could pair.
    const visTok = visible.get(`${s.sessionId}:${s.key}`);
    const spanReasoning = visTok !== undefined ? Math.max(0, s.outputTokens - visTok) : 0;
    reasoning += spanReasoning;
    // Track every timestamped call (with its effort, if any) for the high-reasoning streak.
    if (s.ts > 0) {
      effortSpans.push({ ts: s.ts, effort: s.effort, model: s.model, reasoningTokens: spanReasoning });
    }

    const spanTokens = s.inputTokens + s.outputTokens;

    let mu = byModel.get(s.model);
    if (!mu) {
      mu = {
        model: s.model,
        requests: 0,
        inputTokens: 0,
        outputTokens: 0,
        cachedTokens: 0,
        aiu: 0,
        totalTokens: 0,
      };
      byModel.set(s.model, mu);
    }
    mu.requests += 1;
    mu.inputTokens += s.inputTokens;
    mu.outputTokens += s.outputTokens;
    mu.cachedTokens += s.cachedTokens;
    mu.aiu += s.aiu;
    mu.totalTokens += spanTokens;

    // Spans with no usable timestamp can't be placed on the calendar; skip the daily bucket
    // for those (they still count in the totals and per-model rollup above).
    if (s.ts > 0) {
      const key = dayKey(s.ts);
      let du = byDay.get(key);
      if (!du) {
        du = { day: key, totalTokens: 0, byModel: {} };
        byDay.set(key, du);
      }
      du.totalTokens += spanTokens;
      du.byModel[s.model] = (du.byModel[s.model] ?? 0) + spanTokens;
    }
  }

  totals.modelUsage = [...byModel.values()].sort((a, b) => b.totalTokens - a.totalTokens);
  totals.models = totals.modelUsage.map((m) => m.model);
  totals.daily = [...byDay.values()].sort((a, b) => a.day.localeCompare(b.day));
  totals.sessions = sessions.size;
  totals.reasoningTokens = reasoning;
  totals.reasoningStreak = computeReasoningStreak(effortSpans, modelCaps);
  // Expose per-model output prices (from models.json) so the cost UI can tier models.
  const prices: Record<string, number> = {};
  for (const [id, caps] of modelCaps) {
    if (caps.outputPricePer1M !== undefined) {
      prices[id] = caps.outputPricePer1M;
    }
  }
  totals.modelPrices = prices;
  return totals;
}

async function isDir(p: string): Promise<boolean> {
  try {
    return (await fsp.stat(p)).isDirectory();
  } catch {
    return false;
  }
}

/**
 * Locate Copilot Chat's `debug-logs` directory for the current workspace, derived entirely
 * from our OWN storage path (never a hardcoded home dir), so it works on Windows/macOS/Linux,
 * remote, devcontainers and Codespaces alike. Returns undefined when no folder is open or the
 * directory isn't present (e.g. logging never enabled).
 */
export async function findDebugLogsDir(
  context: vscode.ExtensionContext,
): Promise<string | undefined> {
  const storage = context.storageUri?.fsPath;
  if (!storage) {
    return undefined; // No workspace folder → no per-workspace storage to anchor to.
  }
  const base = path.dirname(storage); // …/workspaceStorage/<hash>
  const exact = path.join(base, COPILOT_CHAT_DIR, DEBUG_LOGS_DIR);
  if (await isDir(exact)) {
    return exact;
  }
  // Fallback: tolerate publisher-id casing/variant differences across distributions.
  try {
    const entries = await fsp.readdir(base, { withFileTypes: true });
    for (const e of entries) {
      if (e.isDirectory() && /copilot-chat$/i.test(e.name)) {
        const candidate = path.join(base, e.name, DEBUG_LOGS_DIR);
        if (await isDir(candidate)) {
          return candidate;
        }
      }
    }
  } catch {
    // ignore; treated as "not found"
  }
  return undefined;
}

/**
 * The most-recently-written session log under `debug-logs`, our best proxy for the
 * "current chat window", since VS Code exposes no API for the focused chat session.
 */
export async function findActiveSessionLog(debugLogsDir: string): Promise<string | undefined> {
  let best: string | undefined;
  let bestMtime = -1;
  try {
    const entries = await fsp.readdir(debugLogsDir, { withFileTypes: true });
    for (const e of entries) {
      if (!e.isDirectory()) {
        continue;
      }
      const file = path.join(debugLogsDir, e.name, MAIN_LOG);
      try {
        const st = await fsp.stat(file);
        if (st.isFile() && st.mtimeMs > bestMtime) {
          bestMtime = st.mtimeMs;
          best = file;
        }
      } catch {
        // skip unreadable session
      }
    }
  } catch {
    return undefined;
  }
  return best;
}

/** True if the head of a log file contains at least one parseable usage span. Cheap probe. */
export async function fileHasUsage(file: string, scanBytes = 1024 * 1024): Promise<boolean> {
  try {
    const fh = await fsp.open(file, 'r');
    try {
      const size = (await fh.stat()).size;
      const want = Math.min(scanBytes, size);
      if (want <= 0) {
        return false;
      }
      const buf = Buffer.alloc(want);
      const { bytesRead } = await fh.read(buf, 0, want, 0);
      const text = buf.subarray(0, bytesRead).toString('utf8');
      const lastNl = text.lastIndexOf('\n');
      const body = lastNl >= 0 ? text.slice(0, lastNl) : text;
      for (const line of body.split('\n')) {
        if (parseSpanLine(line)) {
          return true;
        }
      }
    } finally {
      await fh.close();
    }
  } catch {
    // ignore
  }
  return false;
}

interface FileState {
  /** Byte offset already parsed. */
  offset: number;
  /** Partial trailing line carried to the next read. */
  remainder: string;
}

/**
 * Every `.jsonl` log file across all sessions under `debugLogsDir`. That's each session's
 * `main.jsonl` plus its `categorization-*.jsonl` / `title-*.jsonl` sub-logs; those also record
 * real `chat:` token usage (the small model calls Copilot makes to title and categorise chats),
 * so counting them gives an honest project-wide total rather than a single session's slice.
 */
export async function collectSessionLogFiles(debugLogsDir: string): Promise<string[]> {
  const out: string[] = [];
  let sessions: Dirent[];
  try {
    sessions = await fsp.readdir(debugLogsDir, { withFileTypes: true });
  } catch {
    return out;
  }
  for (const s of sessions) {
    if (!s.isDirectory()) {
      continue;
    }
    const dir = path.join(debugLogsDir, s.name);
    try {
      const entries = await fsp.readdir(dir, { withFileTypes: true });
      for (const e of entries) {
        if (e.isFile() && e.name.endsWith('.jsonl')) {
          out.push(path.join(dir, e.name));
        }
      }
    } catch {
      // Unreadable session dir → skip; never let one bad folder abort the whole scan.
    }
  }
  return out;
}

/**
 * Scans EVERY chat session under a workspace's `debug-logs` directory and aggregates total token
 * usage across all of them. Copilot exposes no API for "the currently focused session", so rather
 * than guess we measure the whole project. Re-scans are incremental: each file is tailed from the
 * byte offset we last stopped at, and spans are de-duplicated by id across all files, so a large
 * `main.jsonl` is parsed in full once and later passes only read newly-appended bytes. A full pass
 * runs on a timer (default every 10s) and on demand via {@link refresh}. Idle ticks, where no log
 * grew and none were added or removed, are nearly free: they skip the cache recompute and the
 * webview re-render entirely, since Copilot logs only change when the user interacts with it.
 *
 * Polling (not `fs.watch`) is deliberate: it is far more reliable across containers, remote and
 * network file systems where native watching is flaky.
 */
export class WorkspaceUsageReader implements vscode.Disposable {
  /** All distinct billable spans ever seen, keyed by dedup id, across every file. */
  private readonly spans = new Map<string, UsageSpan>();
  /** Visible output tokens per request, keyed `${sessionId}:${spanId}`, for reasoning estimates. */
  private readonly visible = new Map<string, number>();
  /** Tool invocations, keyed `${sessionId}:${spanId}` (dedup), value = tool name. */
  private readonly toolCalls = new Map<string, string>();
  /** First user message seen per session (title fallback when no `title-*.jsonl` exists yet). */
  private readonly firstUserMsg = new Map<string, string>();
  /** All user messages per session (ts + text), for grouping calls into prompt turns. */
  private readonly userMessages = new Map<string, { ts: number; text: string }[]>();
  /** Per-file tail state, so unchanged files are skipped and changed ones read only the delta. */
  private readonly files = new Map<string, FileState>();
  private timer?: ReturnType<typeof setInterval>;
  private busy = false;
  private lastAnalyzed = 0;
  private filesScanned = 0;
  /** Cache prefix breakdown for the newest request, recomputed each pass. */
  private cacheBreakdown?: CacheBreakdown;
  /** Per-session cache breakdowns (most-recent first), recomputed each pass. */
  private cacheSessions?: SessionCache[];
  /** Tool usage breakdown (used vs defined), recomputed each pass. */
  private toolsBreakdown?: ToolsBreakdown;
  /** Per-model reasoning-effort capability from `models.json`, refreshed when the catalog is read. */
  private modelCaps = new Map<string, ModelEffortCaps>();
  private readonly emitter = new vscode.EventEmitter<UsageTotals>();
  readonly onDidChange = this.emitter.event;

  constructor(
    private readonly debugLogsDir: string,
    private readonly pollMs = 10 * 1000,
  ) {}

  get totals(): UsageTotals {
    const t = aggregate(this.spans.values(), this.visible, this.modelCaps);
    t.filesScanned = this.filesScanned;
    t.lastAnalyzed = this.lastAnalyzed;
    t.cacheBreakdown = this.cacheBreakdown;
    t.cacheSessions = this.cacheSessions;
    t.toolsBreakdown = this.toolsBreakdown;
    t.promptTurns = buildPromptTurns(this.spans.values(), this.visible, this.userMessages);
    return t;
  }

  /**
   * Totals scoped to the active session only (the most-recently-used chat). Same shape as
   * {@link totals} but aggregated over that one session's spans, so the session Cost Explorer shows
   * its own headline, models, week, bars and tips. The active session is the first entry of the
   * per-session cache breakdown (newest by last request). Undefined fields fall back to empty.
   */
  get activeSessionTotals(): UsageTotals {
    const activeId = this.cacheSessions?.[0]?.sessionId;
    if (!activeId) {
      const empty = emptyTotals();
      empty.filesScanned = this.filesScanned;
      empty.lastAnalyzed = this.lastAnalyzed;
      return empty;
    }
    const sessionSpans = [...this.spans.values()].filter((s) => s.sessionId === activeId);
    const t = aggregate(sessionSpans, this.visible, this.modelCaps);
    t.filesScanned = this.filesScanned;
    t.lastAnalyzed = this.lastAnalyzed;
    // The active session's own cache breakdown is the first computed entry; expose it as both the
    // single breakdown and the one-element sessions list so downstream code is unchanged.
    const active = this.cacheSessions?.[0];
    t.cacheBreakdown = active;
    t.cacheSessions = active ? [active] : undefined;
    t.toolsBreakdown = this.toolsBreakdown;
    t.promptTurns = buildPromptTurns(sessionSpans, this.visible, this.userMessages);
    return t;
  }

  start(): void {
    void this.tick(true);
    this.timer = setInterval(() => void this.tick(), this.pollMs);
  }

  /** Force an immediate full pass; used on activation and when the user hits Refresh. */
  async refresh(): Promise<void> {
    await this.tick(true);
  }

  private async tick(force = false): Promise<void> {
    if (this.busy) {
      return;
    }
    this.busy = true;
    try {
      const files = await collectSessionLogFiles(this.debugLogsDir);
      const live = new Set(files);
      let changed = false;
      for (const known of [...this.files.keys()]) {
        if (!live.has(known)) {
          this.files.delete(known);
          changed = true;
        }
      }
      for (const file of files) {
        if (await this.ingest(file)) {
          changed = true;
        }
      }
      this.filesScanned = files.length;
      // Idle ticks (nothing grew, nothing added/removed) skip the cache recompute AND the
      // re-render, so polling can run often and stay nearly free. Logs only change when the user
      // interacts with Copilot, so there's nothing new to show between interactions. The initial
      // pass and a manual Refresh (force) always run so the panel renders its current state.
      if (changed || force) {
        await this.computeCacheBreakdown();
        this.lastAnalyzed = Date.now();
        this.emitter.fire(this.totals);
      }
    } finally {
      this.busy = false;
    }
  }

  /**
   * Recompute "what's in the cache", grouped per chat session. Each session's cache prefix
   * (system prompt + tool schemas + conversation history) is sized from that session's most recent
   * request, and its hit rate from that session's own requests, so a brand-new chat shows its own
   * small prefix rather than the workspace average. Sidecar files live next to each session's
   * `main.jsonl`. Capped at the most-recently-used sessions to bound IO. The active session (newest
   * overall) feeds the single `cacheBreakdown` + the workspace tools breakdown for backward compat.
   */
  private async computeCacheBreakdown(): Promise<void> {
    // Group every span by its session, tracking that session's newest request and cache ratio.
    interface Agg {
      newest: UsageSpan;
      totalIn: number;
      totalCached: number;
      totalOut: number;
      totalAiu: number;
      reasoning: number;
      requests: number;
    }
    const bySession = new Map<string, Agg>();
    for (const s of this.spans.values()) {
      const visTok = this.visible.get(`${s.sessionId}:${s.key}`);
      const spanReasoning = visTok !== undefined ? Math.max(0, s.outputTokens - visTok) : 0;
      const a = bySession.get(s.sessionId);
      if (!a) {
        bySession.set(s.sessionId, {
          newest: s,
          totalIn: s.inputTokens,
          totalCached: s.cachedTokens,
          totalOut: s.outputTokens,
          totalAiu: s.aiu,
          reasoning: spanReasoning,
          requests: 1,
        });
      } else {
        a.totalIn += s.inputTokens;
        a.totalCached += s.cachedTokens;
        a.totalOut += s.outputTokens;
        a.totalAiu += s.aiu;
        a.reasoning += spanReasoning;
        a.requests += 1;
        if (s.ts > a.newest.ts) {
          a.newest = s;
        }
      }
    }
    if (bySession.size === 0) {
      this.cacheBreakdown = undefined;
      this.cacheSessions = undefined;
      this.toolsBreakdown = undefined;
      return;
    }

    // Most-recently-used sessions first; cap to bound per-tick sidecar reads.
    const ranked = [...bySession.entries()]
      .sort((a, b) => b[1].newest.ts - a[1].newest.ts)
      .slice(0, MAX_CACHE_SESSIONS);

    // Refresh the per-model effort capability catalog from the active session (newest overall).
    // Keep the previous map on a transient miss so a read failure doesn't blank classification.
    const activeDir = path.join(this.debugLogsDir, ranked[0][0]);
    const caps = await loadModelCaps(path.join(activeDir, MODELS_FILE));
    if (caps.size > 0) {
      this.modelCaps = caps;
    }

    const sessions: SessionCache[] = [];
    this.toolsBreakdown = undefined;
    for (let i = 0; i < ranked.length; i += 1) {
      const [sessionId, agg] = ranked[i];
      const newest = agg.newest;
      const sessionDir = path.join(this.debugLogsDir, sessionId);
      const hitRatePct = agg.totalIn > 0 ? (agg.totalCached / agg.totalIn) * 100 : 0;
      // The model's tokenizer (from models.json) gives exact prefix sizing; falls back internally.
      const tokenizer = this.modelCaps.get(newest.model.toLowerCase())?.tokenizer;

      let systemPromptTokens = 0;
      if (newest.systemPromptFile) {
        systemPromptTokens = await fileTokens(path.join(sessionDir, newest.systemPromptFile), tokenizer);
      }
      let toolsTokens = 0;
      let toolCount = 0;
      let toolGroups: ToolGroup[] = [];
      let topTools: ToolEntry[] = [];
      let analyzedTools: ToolEntry[] | undefined;
      if (newest.toolsFile) {
        const analyzed = await analyzeToolsFile(path.join(sessionDir, newest.toolsFile), tokenizer);
        if (analyzed) {
          toolsTokens = analyzed.tokens;
          toolCount = analyzed.toolCount;
          toolGroups = analyzed.groups;
          topTools = analyzed.tools;
          analyzedTools = analyzed.tools;
        }
      }
      // The active session (first) seeds the workspace tools breakdown, as before.
      if (i === 0 && analyzedTools) {
        this.toolsBreakdown = this.buildToolsBreakdown(analyzedTools);
      }
      const historyTokens = Math.max(0, newest.inputTokens - systemPromptTokens - toolsTokens);
      const title = (await loadSessionTitle(sessionDir)) ?? this.firstUserMsg.get(sessionId);
      sessions.push({
        sessionId,
        title: title ? truncateTitle(title) : undefined,
        lastTs: newest.ts,
        requests: agg.requests,
        sessionInputTokens: agg.totalIn,
        sessionCachedTokens: agg.totalCached,
        sessionOutputTokens: agg.totalOut,
        sessionReasoningTokens: agg.reasoning,
        sessionAiu: agg.totalAiu,
        hitRatePct,
        contextTokens: newest.inputTokens,
        systemPromptTokens,
        toolsTokens,
        toolCount,
        historyTokens,
        toolGroups,
        topTools,
        model: newest.model,
      });
    }

    this.cacheSessions = sessions;
    this.cacheBreakdown = sessions[0];
  }

  /**
   * Join the live tool schema with captured `tool_call` invocations: flag each defined tool as
   * used or unused, count invocations, and surface any tools invoked but absent from the schema.
   * Pure (no IO) so it's cheap to recompute every pass.
   */
  private buildToolsBreakdown(defined: ToolEntry[]): ToolsBreakdown {
    const counts = new Map<string, number>();
    for (const name of this.toolCalls.values()) {
      counts.set(name, (counts.get(name) ?? 0) + 1);
    }
    const definedNames = new Set(defined.map((d) => d.name));
    const tools: ToolUsage[] = defined.map((d) => {
      const calls = counts.get(d.name) ?? 0;
      return { name: d.name, group: d.group, used: calls > 0, calls };
    });
    // Used first, then by call count (desc), then alphabetically.
    tools.sort((a, b) => {
      if (a.used !== b.used) {
        return a.used ? -1 : 1;
      }
      return b.calls - a.calls || a.name.localeCompare(b.name);
    });
    let totalCalls = 0;
    for (const c of counts.values()) {
      totalCalls += c;
    }
    const unknownUsed = [...counts.keys()].filter((n) => !definedNames.has(n)).sort();
    return {
      totalCount: defined.length,
      usedCount: tools.filter((t) => t.used).length,
      totalCalls,
      tools,
      unknownUsed,
    };
  }

  /** Tail a file from the last byte offset. Returns true if it read new content (or the file
   * vanished), i.e. something changed, so the caller can skip work on idle ticks. */
  private async ingest(file: string): Promise<boolean> {
    const state = this.files.get(file) ?? { offset: 0, remainder: '' };
    let progressed = false;
    // Attribute every span in this file to its TOP-LEVEL session dir, so sub-logs
    // (categorization/title) count toward the parent chat rather than as extra "sessions".
    const sessionId = path.basename(path.dirname(file));
    for (let step = 0; step < MAX_CATCHUP_STEPS; step++) {
      let size: number;
      try {
        const st = await fsp.stat(file);
        if (!st.isFile()) {
          this.files.delete(file);
          return true;
        }
        size = st.size;
      } catch {
        this.files.delete(file);
        return true;
      }
      if (size < state.offset) {
        // Truncated / rotated → restart this file from the top (dedup keeps totals correct).
        state.offset = 0;
        state.remainder = '';
      }
      if (size <= state.offset) {
        break;
      }
      const want = Math.min(CHUNK_BYTES, size - state.offset);
      const buf = Buffer.alloc(want);
      let read = 0;
      try {
        const fh = await fsp.open(file, 'r');
        try {
          ({ bytesRead: read } = await fh.read(buf, 0, want, state.offset));
        } finally {
          await fh.close();
        }
      } catch {
        break;
      }
      if (read <= 0) {
        break;
      }
      state.offset += read;
      progressed = true;
      const text = state.remainder + buf.subarray(0, read).toString('utf8');
      const lastNl = text.lastIndexOf('\n');
      if (lastNl < 0) {
        state.remainder = text;
        continue;
      }
      state.remainder = text.slice(lastNl + 1);
      for (const line of text.slice(0, lastNl).split('\n')) {
        const span = parseSpanLine(line);
        if (span) {
          span.sessionId = sessionId;
          this.spans.set(span.key, span);
          continue;
        }
        // Pair visible output back to its request (same top-level session) for reasoning estimates.
        if (line.includes('"agent_response"')) {
          const vr = parseAgentResponse(line);
          if (vr) {
            this.visible.set(`${sessionId}:${vr.spanId}`, vr.visibleTokens);
          }
          continue;
        }
        // Capture tool invocations (dedup by session:spanId) for the Tools breakdown.
        const tc = parseToolCallLine(line);
        if (tc) {
          this.toolCalls.set(`${sessionId}:${tc.spanId}`, tc.name);
          continue;
        }
        // Capture the first user message per session (title fallback when no title file exists).
        if (line.includes('"user_message"')) {
          const um = parseUserMessageLine(line);
          if (um) {
            if (!this.firstUserMsg.has(sessionId)) {
              this.firstUserMsg.set(sessionId, um.text);
            }
            const arr = this.userMessages.get(sessionId) ?? [];
            arr.push(um);
            this.userMessages.set(sessionId, arr);
          }
        }
      }
    }
    this.files.set(file, state);
    return progressed;
  }

  dispose(): void {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = undefined;
    }
    this.emitter.dispose();
  }
}
