import * as vscode from 'vscode';
import { findDebugLogsDir } from './usagelog';
import { logError } from './log';

/**
 * What level of cost reporting we can honestly offer right now.
 * - `none`     : Copilot Chat isn't available; we can measure nothing.
 * - `estimate` : Copilot works, but real usage logs aren't readable yet (logging off,
 *                no folder open, or no recorded turns). We can only estimate from the editor.
 * - `full`     : Real, measured per-request token usage is on disk and parseable.
 */
export type CapabilityLevel = 'none' | 'estimate' | 'full';

/** Copilot's setting that turns on the on-disk token logs we read in `full` mode. */
export const LOGGING_SETTING_ID = 'github.copilot.chat.agentDebugLog.fileLogging.enabled';

export interface Capabilities {
  level: CapabilityLevel;
  /** Whether Copilot's file-logging setting is currently enabled. */
  loggingSettingEnabled: boolean;
  /** Resolved `debug-logs` directory, when found. */
  debugLogsDir?: string;
  /** Short, user-facing explanation of the current level. */
  reason: string;
}

function loggingEnabled(): boolean {
  return vscode.workspace.getConfiguration().get<boolean>(LOGGING_SETTING_ID) === true;
}

/**
 * Decide what we can measure, by PROBING rather than assuming. We only claim `full` when we
 * actually parse a real usage span off disk, so if Copilot's preview log format ever changes,
 * we fall back to `estimate` instead of reporting wrong numbers.
 */
export async function detectCapabilities(
  context: vscode.ExtensionContext,
): Promise<Capabilities> {
  const settingEnabled = loggingEnabled();

  // 1. Is Copilot Chat present and signed in?
  let models: readonly vscode.LanguageModelChat[] = [];
  try {
    models = await vscode.lm.selectChatModels({ vendor: 'copilot' });
  } catch {
    models = [];
  }
  if (models.length === 0) {
    return {
      level: 'none',
      loggingSettingEnabled: settingEnabled,
      reason: 'GitHub Copilot Chat isn’t available. Install it and sign in to measure cost.',
    };
  }

  // 2. The on-disk token logs only exist while Copilot's file logging is enabled.
  if (!settingEnabled) {
    return {
      level: 'estimate',
      loggingSettingEnabled: false,
      reason: 'Turn on Copilot token logging to measure real cost instead of estimating.',
    };
  }

  // 3. Anchor to this workspace's logs directory (needs an open folder + the dir to exist).
  const debugLogsDir = await findDebugLogsDir(context);
  if (!debugLogsDir) {
    return {
      level: 'estimate',
      loggingSettingEnabled: true,
      reason: context.storageUri
        ? 'Token logging is on. Send a chat message, then Refresh to measure usage.'
        : 'Open a folder or workspace so cost can be measured for this project.',
    };
  }

  // 4. We can read this workspace's logs. The reader aggregates the actual totals across all
  //    sessions; an empty result just means "no usage recorded yet", surfaced by the panel.
  return {
    level: 'full',
    loggingSettingEnabled: true,
    debugLogsDir,
    reason: 'Measuring real token usage across all chat sessions in this workspace.',
  };
}

/**
 * Turn on Copilot's file logging on the user's behalf; only ever called from an explicit
 * "Enable" action, never silently. Writes the documented user setting at the global scope.
 */
export async function enableTokenLogging(): Promise<boolean> {
  try {
    await vscode.workspace
      .getConfiguration()
      .update(LOGGING_SETTING_ID, true, vscode.ConfigurationTarget.Global);
    return true;
  } catch (error) {
    logError('Failed to enable Copilot token logging', error);
    return false;
  }
}
