import type * as vscode from 'vscode';
import type { Dirent } from 'node:fs';
import * as fsp from 'fs/promises';
import * as path from 'path';
import { parseSpanLine, collectSessionLogFiles, type DayUsage, type UsageSpan } from './usagelog';
import type { SpendChart } from './panel';

/**
 * "Cost Explorer · Global" view: an ON-DEMAND scan of EVERY workspace's Copilot logs on this
 * machine, summing total AI credits and tokens. Unlike the live workspace/session readers, this
 * does no polling: it scans only when the view is opened or Refresh is clicked, because walking
 * every workspace's (potentially large) logs is too heavy to run on a timer.
 *
 * Within each workspace, spans are deduplicated by the same key the live reader uses (`spanId`, or
 * a `sessionId:ts:responseId` fallback), because Copilot rewrites a request's `llm_request` line as
 * usage data arrives, so the same call appears on several lines. We keep the LAST occurrence per key
 * (the final, complete record) just as the live reader's `Map.set` ingest does, so the global total
 * agrees with the sum of each workspace's own measured total.
 */

const COPILOT_CHAT_DIR = 'GitHub.copilot-chat';
const DEBUG_LOGS_DIR = 'debug-logs';
const WORKSPACE_META = 'workspace.json';

/** Generic container directories whose basename would be a misleading project name; if the derived
 * name is one of these we fall back to the hash instead. */
const GENERIC_DIR_NAMES = new Set([
  'workspaces',
  'workspace',
  'home',
  'users',
  'user',
  'repos',
  'projects',
  'code',
  'src',
  'tmp',
  'var',
  'mnt',
  'root',
  'documents',
  'desktop',
]);

/** One workspace's rolled-up usage. */
export interface WorkspaceTotal {
  /** Workspace hash (the `workspaceStorage` sub-dir name). */
  hash: string;
  /** Human-readable name (folder/repo basename from `workspace.json` or the chat logs), or undefined if unknown. */
  name?: string;
  /** AI credits consumed (sum of copilotUsageNanoAiu / 1e9). */
  credits: number;
  /** input + output tokens. */
  tokens: number;
  /** Distinct chat sessions that contributed usage. */
  sessions: number;
}

/** The global rollup across all workspaces. */
export interface GlobalTotals {
  totalCredits: number;
  totalTokens: number;
  /** Per-workspace breakdown, highest credits first. Only workspaces with usage are included. */
  workspaces: WorkspaceTotal[];
  /** Per-day token rollup across every workspace (oldest first), for the spend-over-time chart. */
  daily: DayUsage[];
  /** Accumulated-spend chart for the current month, attached by the extension after scanning. */
  spendChart?: SpendChart;
  /** Number of workspace dirs scanned. */
  scanned: number;
  /** Epoch ms when this scan completed. */
  scannedAt: number;
}

/** Derive the `workspaceStorage` base from the extension's global storage path. */
export function workspaceStorageBase(context: vscode.ExtensionContext): string {
  // globalStorageUri = …/User/globalStorage/<publisher.ext> → …/User/workspaceStorage
  const userDir = path.dirname(path.dirname(context.globalStorageUri.fsPath));
  return path.join(userDir, 'workspaceStorage');
}

/** Read a workspace's display name from its `workspace.json` folder URI, or undefined. */
async function readWorkspaceName(hashDir: string): Promise<string | undefined> {
  try {
    const raw = await fsp.readFile(path.join(hashDir, WORKSPACE_META), 'utf8');
    const meta = JSON.parse(raw) as { folder?: string; workspace?: string };
    const uri = meta.folder ?? meta.workspace;
    if (!uri) {
      return undefined;
    }
    // Decode `file:///…/<name>` (or a .code-workspace path) down to its basename. Strip any URI
    // scheme + authority (file://, vscode-remote://dev-container+…/) so remote folders resolve too.
    let decoded = uri.replace(/^[a-z][a-z0-9+.-]*:\/\/[^/]*/i, '');
    try {
      decoded = decodeURIComponent(decoded);
    } catch {
      // Keep the raw (still-encoded) path; basename below is usually fine without decoding.
    }
    const base = path.basename(decoded.replace(/[?#].*$/, '').replace(/\.code-workspace$/, '').replace(/\/+$/, ''));
    return base || undefined;
  } catch {
    return undefined;
  }
}

/** Local-time `YYYY-MM-DD` for an epoch-ms timestamp, matching the workspace reader's bucketing. */
function dayKey(ts: number): string {
  const d = new Date(ts);
  const y = d.getFullYear();
  const m = `${d.getMonth() + 1}`.padStart(2, '0');
  const day = `${d.getDate()}`.padStart(2, '0');
  return `${y}-${m}-${day}`;
}

/** Sum credits + tokens across every session log in one workspace's debug-logs. Reads ALL `.jsonl`
 * files per session (not just `main.jsonl`): the `title-*` / `categorization-*` sub-logs also record
 * real billable `chat:` calls, so including them makes this total match the live workspace reader. */
async function scanWorkspace(
  hashDir: string,
  daily: Map<string, number>,
): Promise<{ credits: number; tokens: number; sessions: number }> {
  const debugLogs = path.join(hashDir, COPILOT_CHAT_DIR, DEBUG_LOGS_DIR);
  const files = await collectSessionLogFiles(debugLogs);
  // Dedup by the same span key the live workspace reader uses, so a request logged on more than one
  // line (Copilot rewrites the `llm_request` entry as usage arrives) is counted once. We keep the
  // LAST occurrence per key, exactly like the live reader's `Map.set` ingest: the final rewritten
  // line carries the complete usage record, and ~75% of spans get rewritten with different token
  // and credit values. Keeping the first (partial) line instead made the global total disagree with
  // each workspace's own measured total.
  const spans = new Map<string, UsageSpan>();
  const sessionsWithUsage = new Set<string>();
  for (const file of files) {
    let raw: string;
    try {
      raw = await fsp.readFile(file, 'utf8');
    } catch {
      continue;
    }
    if (!raw.includes('"llm_request"')) {
      continue;
    }
    for (const line of raw.split('\n')) {
      if (!line.includes('"llm_request"')) {
        continue;
      }
      const span = parseSpanLine(line);
      if (!span) {
        continue;
      }
      spans.set(span.key, span);
      sessionsWithUsage.add(path.dirname(file));
    }
  }
  let credits = 0;
  let tokens = 0;
  for (const span of spans.values()) {
    credits += span.aiu;
    const spanTokens = span.inputTokens + span.outputTokens;
    tokens += spanTokens;
    const key = dayKey(span.ts);
    daily.set(key, (daily.get(key) ?? 0) + spanTokens);
  }
  return { credits, tokens, sessions: sessionsWithUsage.size };
}

/** Best-effort project name from a workspace's chat logs, used when `workspace.json` is missing
 * (the norm in dev containers / remotes). Copilot logs reference files by absolute path; the
 * workspace root is the directory that the most referenced files sit under, so we pick the path
 * that is an ancestor of the most (frequency-weighted) referenced paths and return its basename. */
async function deriveNameFromLogs(hashDir: string): Promise<string | undefined> {
  const debugLogs = path.join(hashDir, COPILOT_CHAT_DIR, DEBUG_LOGS_DIR);
  let files: string[];
  try {
    files = await collectSessionLogFiles(debugLogs);
  } catch {
    return undefined;
  }
  // The main.jsonl files carry the file references; read those first.
  const ordered = files.sort((a, b) => {
    const am = a.endsWith('main.jsonl') ? 0 : 1;
    const bm = b.endsWith('main.jsonl') ? 0 : 1;
    return am - bm;
  });
  // Matches `file://` URIs and bare POSIX/Windows absolute paths inside the JSON log lines.
  const PATH_RE = /(?:file:\/\/)?(?:[A-Za-z]:)?(?:\/[A-Za-z0-9._+%-]+){2,}/g;
  const MAX_FILES = 8;
  const MAX_BYTES = 1024 * 1024;
  const MAX_DIRS = 2000;
  const freq = new Map<string, number>();
  for (const file of ordered.slice(0, MAX_FILES)) {
    if (freq.size >= MAX_DIRS) {
      break;
    }
    let raw: string;
    try {
      raw = await fsp.readFile(file, 'utf8');
    } catch {
      continue;
    }
    const sample = raw.length > MAX_BYTES ? raw.slice(0, MAX_BYTES) : raw;
    const matches = sample.match(PATH_RE);
    if (!matches) {
      continue;
    }
    for (const match of matches) {
      let p = match.replace(/^file:\/\//, '');
      try {
        p = decodeURIComponent(p);
      } catch {
        // Keep the raw path on a malformed escape.
      }
      p = p.replace(/\/+$/, '');
      // Treat a trailing segment with a file extension as a file: use its directory.
      const lastSlash = p.lastIndexOf('/');
      const lastSeg = p.slice(lastSlash + 1);
      const dir = /\.[A-Za-z0-9]{1,8}$/.test(lastSeg) ? p.slice(0, lastSlash) : p;
      if (dir.length > 1 && dir.startsWith('/')) {
        freq.set(dir, (freq.get(dir) ?? 0) + 1);
      }
    }
  }
  return projectNameFromDirs(freq);
}

/** From the referenced directories, pick the project root: the shallowest broad-coverage ancestor
 * whose basename is a real project name (not a container like `/workspaces` or a `home/<user>` dir).
 * Returns its basename, or undefined if nothing usable was found. */
function projectNameFromDirs(freq: Map<string, number>): string | undefined {
  const entries = [...freq.entries()];
  if (entries.length === 0) {
    return undefined;
  }
  const coverage = (cand: string): number => {
    let s = 0;
    for (const [p, n] of entries) {
      if (p === cand || p.startsWith(cand + '/')) {
        s += n;
      }
    }
    return s;
  };
  let max = 0;
  for (const [cand] of entries) {
    const c = coverage(cand);
    if (c > max) {
      max = c;
    }
  }
  if (max <= 0) {
    return undefined;
  }
  // Only directories that nearly every referenced file sits under are candidate roots; this keeps us
  // from drilling into a busy subfolder like `.../src`.
  const threshold = max * 0.9;
  // A bare home directory (`/home/<user>`, `/Users/<user>`, `C:/Users/<user>`) is a container, not a
  // project, so step past it to the folder beneath.
  const isHomeDir = (p: string): boolean => /(?:^|\/)(?:home|users)\/[^/]+$/i.test(p);
  let best: string | undefined;
  let bestDepth = Infinity;
  let bestCoverage = -1;
  for (const [cand] of entries) {
    if (coverage(cand) < threshold) {
      continue;
    }
    const segs = cand.split('/').filter(Boolean);
    const name = segs[segs.length - 1];
    if (!name || GENERIC_DIR_NAMES.has(name.toLowerCase()) || isHomeDir(cand)) {
      continue;
    }
    // Prefer the shallowest qualifying folder (the project root, not a nested package).
    const cov = coverage(cand);
    if (segs.length < bestDepth || (segs.length === bestDepth && cov > bestCoverage)) {
      bestDepth = segs.length;
      bestCoverage = cov;
      best = name;
    }
  }
  return best;
}

/**
 * Scan every workspace under `workspaceStorage` and roll up total credits + tokens, with a
 * per-workspace breakdown (named where possible). On-demand: callers invoke this from the view's
 * open/refresh, never on a timer. Never throws.
 */
export async function scanGlobalTotals(base: string): Promise<GlobalTotals> {
  let hashes: string[] = [];
  try {
    const entries = await fsp.readdir(base, { withFileTypes: true });
    hashes = entries.filter((e: Dirent) => e.isDirectory()).map((e: Dirent) => e.name);
  } catch {
    return { totalCredits: 0, totalTokens: 0, workspaces: [], daily: [], scanned: 0, scannedAt: Date.now() };
  }

  const workspaces: WorkspaceTotal[] = [];
  const dailyTokens = new Map<string, number>();
  let totalCredits = 0;
  let totalTokens = 0;
  for (const hash of hashes) {
    const hashDir = path.join(base, hash);
    const { credits, tokens, sessions } = await scanWorkspace(hashDir, dailyTokens);
    if (tokens === 0 && credits === 0) {
      continue; // skip workspaces with no Copilot usage logged
    }
    // Prefer the folder name from workspace.json; in dev containers/remotes that file is absent, so
    // fall back to deriving the project folder from the chat logs' file:// references.
    const name = (await readWorkspaceName(hashDir)) ?? (await deriveNameFromLogs(hashDir));
    workspaces.push({ hash, name, credits, tokens, sessions });
    totalCredits += credits;
    totalTokens += tokens;
  }
  workspaces.sort((a, b) => b.credits - a.credits || b.tokens - a.tokens);
  const daily: DayUsage[] = Array.from(dailyTokens.entries())
    .map(([day, t]) => ({ day, totalTokens: t, byModel: {} }))
    .sort((a, b) => (a.day < b.day ? -1 : a.day > b.day ? 1 : 0));
  return {
    totalCredits,
    totalTokens,
    workspaces,
    daily,
    scanned: hashes.length,
    scannedAt: Date.now(),
  };
}
