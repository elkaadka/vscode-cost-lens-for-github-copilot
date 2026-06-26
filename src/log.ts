import * as vscode from 'vscode';
import { ext } from './extensionVariables';

/**
 * Logging and command-registration helpers. Mirrors the error-handling discipline used by the
 * Microsoft Azure extensions: every command runs inside a wrapper that logs and surfaces failures
 * instead of letting promise rejections vanish, and genuine errors go to a dedicated output
 * channel rather than a swallowed `catch {}`.
 */

/** Create the extension's output channel. Call once from `activate`; safe to push to subscriptions. */
export function initOutputChannel(): vscode.LogOutputChannel {
  ext.output = vscode.window.createOutputChannel('Cost Lens for GitHub Copilot', { log: true });
  return ext.output;
}

/** Log an expected, non-fatal fallback (e.g. a file that isn't there yet). No-ops before activate. */
export function logDebug(message: string, ...args: unknown[]): void {
  ext.output?.debug(args.length ? `${message} ${args.map(String).join(' ')}` : message);
}

/** Log an informational message about normal operation. No-ops before activate. */
export function logInfo(message: string, ...args: unknown[]): void {
  ext.output?.info(args.length ? `${message} ${args.map(String).join(' ')}` : message);
}

/** Log a genuine failure, with the error's message/stack when available. No-ops before activate. */
export function logError(message: string, error?: unknown): void {
  const detail = error instanceof Error ? (error.stack ?? error.message) : error !== undefined ? String(error) : '';
  ext.output?.error(detail ? `${message}: ${detail}` : message);
}

/**
 * Register a command whose handler is wrapped so rejected promises and thrown errors are logged to
 * the output channel and surfaced to the user, instead of being silently dropped by VS Code. Use
 * this in place of `vscode.commands.registerCommand` for first-party commands.
 */
export function registerCommand(
  command: string,
  callback: (...args: unknown[]) => unknown,
): vscode.Disposable {
  return vscode.commands.registerCommand(command, async (...args: unknown[]) => {
    try {
      return await callback(...args);
    } catch (error) {
      logError(`Command '${command}' failed`, error);
      void vscode.window.showErrorMessage(
        `Cost Lens: '${command}' failed. See the "Cost Lens for GitHub Copilot" output for details.`,
      );
      return undefined;
    }
  });
}
