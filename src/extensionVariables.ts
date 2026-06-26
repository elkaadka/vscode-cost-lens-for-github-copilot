import type * as vscode from 'vscode';
import type { Badge } from './badge';
import type { DashboardViewProvider } from './dashboard';
import type { Assessment } from './score';
import type { WorkspaceUsageReader } from './usagelog';

/**
 * The single, typed home for the extension's shared mutable state. Following the pattern used by
 * the Microsoft Azure extensions (`src/extensionVariables.ts`), everything that used to live as a
 * scattering of module-level `let`s in `extension.ts` is collected here behind one `ext` object.
 * Fields are assigned during {@link activate}; consumers read them through `ext.*`.
 */
export interface ExtensionVariables {
  context: vscode.ExtensionContext;
  /** Extension-owned output channel; created once in `activate`. */
  output: vscode.LogOutputChannel;
  badge: Badge;
  dashboard: DashboardViewProvider;

  /** Live reader for the active workspace's Copilot logs (`full` mode only). */
  usageReader?: WorkspaceUsageReader;
  /** Directory the current {@link usageReader} is bound to, so we can detect when it changes. */
  usageReaderDir?: string;

  /** Last editor-derived assessment, used to seed the badge before the first measured refresh. */
  lastResult?: Assessment;
  /** Pending debounce handle for editor-driven refreshes. */
  debounce?: ReturnType<typeof setTimeout>;

  /** Guards re-entrant `refresh()` calls. */
  refreshing: boolean;
  /** Set when a refresh is requested while one is already running. */
  pendingRefresh: boolean;
  /** Guards re-entrant capability detection. */
  capsBusy: boolean;
}

/**
 * The shared singleton. Required fields (`context`, `output`, `badge`, `dashboard`) are populated
 * synchronously at the top of `activate` before anything reads them; the booleans are initialised
 * here so re-entrancy guards behave from the first tick.
 */
export const ext: ExtensionVariables = {
  refreshing: false,
  pendingRefresh: false,
  capsBusy: false,
} as ExtensionVariables;
