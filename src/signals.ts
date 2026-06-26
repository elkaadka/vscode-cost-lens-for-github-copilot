import * as vscode from 'vscode';
import { inputCostUSD, outputCostUSD, resolveRate } from './rates';
import { type Signals } from './score';

export interface GatheredSignals {
  available: boolean;
  /** Reason the badge can't be computed (e.g. no Copilot model). */
  reason?: string;
  signals: Signals;
  modelName: string;
  /** Cost to send the current context as input. */
  inputCostUSD: number;
  /** Input + a projected reply: the headline "per turn" estimate. */
  perTurnUSD: number;
  /** Extra input cost for the next 10K tokens at the current tier (captures the cliff jump). */
  marginalPer10kUSD: number;
  /** Long-context pricing threshold for the model, if any. */
  longCtxThreshold?: number;
}

const CONFIG_NS = 'copilotCostLens';
/** Guard against pathological documents when counting tokens. */
const MAX_COUNT_CHARS = 2_000_000;
/** Fallback reply size if the user hasn't set one. */
const DEFAULT_REPLY_TOKENS = 2_000;
/** Step size for the marginal "+$ per +10K tokens" figure. */
const MARGINAL_STEP = 10_000;

export async function gatherSignals(): Promise<GatheredSignals> {
  const cfg = vscode.workspace.getConfiguration(CONFIG_NS);
  const { economyModels, replyTokens } = readConfig(cfg);

  const model = await pickModel();

  // --- Context tokens from the active editor (selection if any) -----------
  const text = activeContextText();
  const contextTokens = await countTokens(model, text);

  return assemble(model, contextTokens, economyModels, replyTokens);
}

function readConfig(cfg: vscode.WorkspaceConfiguration): {
  economyModels: string[];
  replyTokens: number;
} {
  return {
    economyModels: cfg.get<string[]>('economyModels', []).map((m) => m.toLowerCase()),
    replyTokens: DEFAULT_REPLY_TOKENS,
  };
}

/** Shared core: turn a model + measured context size into signals and per-turn costs. */
async function assemble(
  model: vscode.LanguageModelChat | undefined,
  contextTokens: number,
  economyModels: string[],
  replyTokens: number,
): Promise<GatheredSignals> {
  const rate = resolveRate(model);
  // Economy override: a model the user marked cheap is treated as economy tier.
  const tier =
    model && economyModels.some((m) => matches(model, m)) ? 'economy' : rate.tier;

  const toolCount = vscode.lm.tools.length;
  const hasInstructions = await detectInstructions();

  const modelName = model?.name ?? model?.family ?? 'unknown';

  const signals: Signals = {
    modelName,
    modelTier: tier,
    contextTokens,
    longCtxThreshold: rate.longCtxThreshold,
    toolCount,
    hasInstructions,
  };

  const inputUSD = inputCostUSD(rate, contextTokens);
  const perTurnUSD = inputUSD + outputCostUSD(rate, replyTokens, contextTokens);
  const marginalPer10kUSD = inputCostUSD(rate, contextTokens + MARGINAL_STEP) - inputUSD;

  if (!model) {
    return {
      available: false,
      reason: 'No Copilot chat model available (sign in / enable Copilot).',
      signals,
      modelName,
      inputCostUSD: inputUSD,
      perTurnUSD,
      marginalPer10kUSD,
      longCtxThreshold: rate.longCtxThreshold,
    };
  }

  return {
    available: true,
    signals,
    modelName,
    inputCostUSD: inputUSD,
    perTurnUSD,
    marginalPer10kUSD,
    longCtxThreshold: rate.longCtxThreshold,
  };
}

async function pickModel(): Promise<vscode.LanguageModelChat | undefined> {
  let models: readonly vscode.LanguageModelChat[] = [];
  try {
    models = await vscode.lm.selectChatModels({ vendor: 'copilot' });
  } catch {
    return undefined;
  }
  return models[0];
}

function matches(model: vscode.LanguageModelChat, key: string): boolean {
  const id = model.id?.toLowerCase() ?? '';
  const family = model.family?.toLowerCase() ?? '';
  return id === key || family === key || id.includes(key) || family.includes(key);
}

function activeContextText(): string {
  const editor = vscode.window.activeTextEditor ?? pickVisibleTextEditor();
  if (!editor) {
    return '';
  }
  const sel = editor.selection;
  const text = sel && !sel.isEmpty ? editor.document.getText(sel) : editor.document.getText();
  return text.length > MAX_COUNT_CHARS ? text.slice(0, MAX_COUNT_CHARS) : text;
}

/**
 * When focus is on a webview/panel (e.g. the Cost Health view), there is no active text
 * editor; fall back to a visible file editor so the token count still reflects your work.
 */
function pickVisibleTextEditor(): vscode.TextEditor | undefined {
  const visible = vscode.window.visibleTextEditors;
  return visible.find((e) => e.document.uri.scheme === 'file') ?? visible[0];
}

async function countTokens(
  model: vscode.LanguageModelChat | undefined,
  text: string,
): Promise<number> {
  if (!text) {
    return 0;
  }
  if (model) {
    try {
      return await model.countTokens(text);
    } catch {
      // fall through to estimate
    }
  }
  // Rough fallback: ~4 chars per token.
  return Math.ceil(text.length / 4);
}

async function detectInstructions(): Promise<boolean> {
  if (!vscode.workspace.workspaceFolders?.length) {
    return false;
  }
  const patterns = ['**/.github/copilot-instructions.md', '**/.github/instructions/*.instructions.md'];
  for (const pattern of patterns) {
    const found = await vscode.workspace.findFiles(pattern, '**/node_modules/**', 1);
    if (found.length > 0) {
      return true;
    }
  }
  return false;
}
