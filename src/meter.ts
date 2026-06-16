import * as vscode from 'vscode';
import { BadgeDisplay } from './badge';
import { Assessment } from './score';

/** Running totals for the current session, accumulated from real `@costlens` turns only. */
export interface SessionTotals {
  turns: number;
  inputTokens: number;
  outputTokens: number;
  costUSD: number;
}

export interface SessionEntry {
  inputTokens: number;
  outputTokens: number;
  costUSD: number;
}

const EMPTY: SessionTotals = { turns: 0, inputTokens: 0, outputTokens: 0, costUSD: 0 };

/**
 * In-memory meter for the honest "what passed through us" total. We cannot read native
 * Copilot chat usage, so this only ever counts turns the user explicitly routed through
 * `@costlens`. Input tokens are measured; reply tokens are the configured projection.
 */
class SessionMeter implements vscode.Disposable {
  private totals: SessionTotals = { ...EMPTY };
  private readonly emitter = new vscode.EventEmitter<SessionTotals>();
  readonly onDidChange = this.emitter.event;

  get current(): SessionTotals {
    return { ...this.totals };
  }

  record(entry: SessionEntry): void {
    this.totals = {
      turns: this.totals.turns + 1,
      inputTokens: this.totals.inputTokens + Math.max(0, entry.inputTokens),
      outputTokens: this.totals.outputTokens + Math.max(0, entry.outputTokens),
      costUSD: this.totals.costUSD + Math.max(0, entry.costUSD),
    };
    this.emitter.fire(this.current);
  }

  reset(): void {
    this.totals = { ...EMPTY };
    this.emitter.fire(this.current);
  }

  dispose(): void {
    this.emitter.dispose();
  }
}

/** Shared singleton meter for the session. */
export const sessionMeter = new SessionMeter();

/** A measured reading of the live `@costlens` chat context, ready to drive the panel. */
export interface ChatReading {
  assessment: Assessment;
  display: BadgeDisplay;
}

/**
 * One-way bus from the `@costlens` participant to the panel. When the user runs
 * `@costlens update`, the measured chat context is pushed here and pins the panel headline
 * (the closest we can get to "the chat's token count", since the native panel is unreadable).
 */
class ChatContextBus implements vscode.Disposable {
  private readonly emitter = new vscode.EventEmitter<ChatReading>();
  readonly onDidUpdate = this.emitter.event;

  push(reading: ChatReading): void {
    this.emitter.fire(reading);
  }

  dispose(): void {
    this.emitter.dispose();
  }
}

/** Shared singleton bus for pushing the live chat reading to the panel. */
export const chatContextBus = new ChatContextBus();
