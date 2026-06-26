import type * as vscode from 'vscode';
import { randomBytes } from 'node:crypto';

/**
 * Shared webview helpers. Every panel in this extension renders a self-contained HTML string with
 * an inline `<style>` block and a single nonce-gated `<script>`; the nonce and Content-Security-
 * Policy were previously copy-pasted into each `html()` method. Centralising them here keeps the
 * security policy consistent and in one place.
 */

/**
 * A cryptographically-strong nonce for a webview's CSP `script-src`. Uses `crypto.randomBytes`
 * rather than `Math.random` so the value can't be predicted, as recommended for webview CSPs.
 */
export function makeNonce(): string {
  return randomBytes(16).toString('hex');
}

/** Options for {@link buildCsp}. */
export interface CspOptions {
  /** Allow images from the webview origin, `https:` and `data:` URIs (off by default). */
  images?: boolean;
}

/**
 * Build the restrictive Content-Security-Policy used by every panel: nothing loads by default,
 * styles come from the webview origin (plus the inline `<style>` block), and scripts must carry
 * the supplied `nonce`. Pass `images: true` for panels that render `<img>` content.
 */
export function buildCsp(webview: vscode.Webview, nonce: string, options: CspOptions = {}): string {
  const directives = [
    `default-src 'none'`,
    `style-src ${webview.cspSource} 'unsafe-inline'`,
    `script-src 'nonce-${nonce}'`,
  ];
  if (options.images) {
    directives.push(`img-src ${webview.cspSource} https: data:`);
  }
  return directives.join('; ');
}
