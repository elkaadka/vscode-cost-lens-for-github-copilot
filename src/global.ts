import type * as vscode from 'vscode';
import type { Dirent } from 'node:fs';
import * as fsp from 'fs/promises';
import * as path from 'path';
import { parseSpanLine } from './usagelog';

/**
 * "Cost Explorer · Global" view: an ON-DEMAND scan of EVERY workspace's Copilot logs on this
 * machine, summing total AI credits and tokens. Unlike the live workspace/session readers, this
 * does no polling: it scans only when the view is opened or Refresh is clicked, because walking
 * every workspace's (potentially large) logs is too heavy to run on a timer.
 *
 * Totals are computed by streaming each `main.jsonl` once and summing no span map, so the
 * per-session `spanId` collision that would affect a deduped cross-workspace aggregate simply
 * can't happen here (nothing is keyed; we only add up credits and tokens).
 */

const COPILOT_CHAT_DIR = 'GitHub.copilot-chat';
const DEBUG_LOGS_DIR = 'debug-logs';
const MAIN_LOG = 'main.jsonl';
const WORKSPACE_META = 'workspace.json';

/** One workspace's rolled-up usage. */
export interface WorkspaceTotal {
  /** Workspace hash (the `workspaceStorage` sub-dir name). */
  hash: string;
  /** Human-readable name (folder basename from `workspace.json`), or undefined if unknown. */
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
    // Decode `file:///…/<name>` (or a .code-workspace path) down to its basename.
    const decoded = decodeURIComponent(uri.replace(/^file:\/\//, ''));
    const base = path.basename(decoded.replace(/\.code-workspace$/, ''));
    return base || undefined;
  } catch {
    return undefined;
  }
}

/** Sum credits + tokens across every `main.jsonl` in one workspace's debug-logs. */
async function scanWorkspace(hashDir: string): Promise<{ credits: number; tokens: number; sessions: number }> {
  const debugLogs = path.join(hashDir, COPILOT_CHAT_DIR, DEBUG_LOGS_DIR);
  let sessionDirs: string[];
  try {
    const entries = await fsp.readdir(debugLogs, { withFileTypes: true });
    sessionDirs = entries.filter((e: Dirent) => e.isDirectory()).map((e: Dirent) => e.name);
  } catch {
    return { credits: 0, tokens: 0, sessions: 0 };
  }
  let credits = 0;
  let tokens = 0;
  let sessions = 0;
  for (const sid of sessionDirs) {
    let raw: string;
    try {
      raw = await fsp.readFile(path.join(debugLogs, sid, MAIN_LOG), 'utf8');
    } catch {
      continue;
    }
    let sessionHadUsage = false;
    for (const line of raw.split('\n')) {
      if (!line.includes('"llm_request"')) {
        continue;
      }
      const span = parseSpanLine(line);
      if (!span) {
        continue;
      }
      credits += span.aiu;
      tokens += span.inputTokens + span.outputTokens;
      sessionHadUsage = true;
    }
    if (sessionHadUsage) {
      sessions += 1;
    }
  }
  return { credits, tokens, sessions };
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
    return { totalCredits: 0, totalTokens: 0, workspaces: [], scanned: 0, scannedAt: Date.now() };
  }

  const workspaces: WorkspaceTotal[] = [];
  let totalCredits = 0;
  let totalTokens = 0;
  for (const hash of hashes) {
    const hashDir = path.join(base, hash);
    const { credits, tokens, sessions } = await scanWorkspace(hashDir);
    if (tokens === 0 && credits === 0) {
      continue; // skip workspaces with no Copilot usage logged
    }
    const name = await readWorkspaceName(hashDir);
    workspaces.push({ hash, name, credits, tokens, sessions });
    totalCredits += credits;
    totalTokens += tokens;
  }
  workspaces.sort((a, b) => b.credits - a.credits || b.tokens - a.tokens);
  return {
    totalCredits,
    totalTokens,
    workspaces,
    scanned: hashes.length,
    scannedAt: Date.now(),
  };
}
