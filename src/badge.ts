import * as vscode from 'vscode';
import type { MeasuredView } from './panel';

export interface BadgeDisplay {
  modelName: string;
  contextTokens: number;
  inputCostUSD: number;
  perTurnUSD: number;
  marginalPer10kUSD: number;
  longCtxThreshold?: number;
}

export class Badge implements vscode.Disposable {
  private readonly item: vscode.StatusBarItem;

  constructor(private readonly showDetailsCmd: string) {
    this.item = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Right, 100);
    this.item.command = showDetailsCmd;
    this.item.name = 'Cost Lens for GitHub Copilot';
    this.setUnavailable('Computing…');
    this.item.show();
  }

  setUnavailable(reason: string): void {
    this.item.text = '$(circle-slash) Copilot Usage';
    this.item.backgroundColor = undefined;
    const md = new vscode.MarkdownString(undefined, true);
    md.appendMarkdown(`**Cost Lens for GitHub Copilot**\n\n$(info) ${reason}`);
    this.item.tooltip = md;
  }

  /** Show measured AI credit usage across every chat session in the workspace. */
  setMeasured(view: MeasuredView): void {
    const credits = view.creditsFmt && view.creditsFmt !== '-' ? view.creditsFmt : null;
    this.item.text = credits ? `$(graph) ${credits} credits` : `$(graph) ${view.costFmt}`;
    this.item.backgroundColor = undefined;
    this.item.tooltip = this.buildTooltip(view);
  }

  private buildTooltip(view: MeasuredView): vscode.MarkdownString {
    const md = new vscode.MarkdownString(undefined, true);
    md.isTrusted = true;
    md.supportThemeIcons = true;

    md.appendMarkdown(`**Cost Lens for GitHub Copilot**\n\n`);
    md.appendMarkdown('---\n\n');
    md.appendMarkdown(
      `$(database) ${view.totalTokensFmt} tokens across ${view.sessions} session${view.sessions === 1 ? '' : 's'} · ${view.costFmt} ${view.costNote}\n\n` +
        `$(comment-discussion) ${view.requests} request${view.requests === 1 ? '' : 's'} · ${view.aiuFmt} AI units\n\n` +
        `$(symbol-misc) ${view.model}\n\n`,
    );
    md.appendMarkdown(`\n[$(list-unordered) Details](command:${this.showDetailsCmd})`);
    return md;
  }

  dispose(): void {
    this.item.dispose();
  }
}
