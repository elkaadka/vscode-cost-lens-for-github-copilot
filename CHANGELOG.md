# Changelog

All notable changes to the "Cost Lens for GitHub Copilot" extension are documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

## [0.2.0] - 2026-06-26

### Added

- Optimize tab: a dedicated, detailed view alongside Global / Workspace / Session that brings
  together cost-cutting tips, a worst-first breakdown of your detected prompting habits, and a
  short "How to do better" playbook of Copilot best practices. The optimization content now lives
  here instead of being a drill-down inside the Workspace and Session tabs.
- Full-screen dashboard: clicking the credits in the status bar now opens the dashboard as a
  full-screen webview panel in the editor area (no activity-bar menu), mirroring the same state and
  interactions as the sidebar view.
- Spend-over-time chart in the Global view: the "All workspaces" hero is now clickable and opens the
  same accumulated-cost / forecast consumption chart available on the Workspace and Session tabs,
  built from a per-day token rollup aggregated across every workspace.
- Anti-pattern detection: a new "Optimize Copilot" section on the Workspace and Session tabs that
  merges cost-saving recommendations with usage anti-patterns detected from Copilot's own logs, each
  with a concrete suggestion. Detectors cover vague one-line prompts, filler-only turns, runaway
  agent loops, oversized context, context creep within a session, premium models used for trivial
  prompts, rapid re-prompting, marathon sessions, and mid-session model hopping
  (`src/antipatterns.ts`, unit-tested in `test/antipatterns.test.cjs`). The former separate "Ways to
  save" cost tips now live inside this unified section.
- ESLint (flat config) with the TypeScript-ESLint recommended rules plus type-aware checks
  (`no-floating-promises`, `no-misused-promises`), wired into CI.
- `npm run lint` and `npm test` scripts; CI now lints, type-checks, compiles, tests, and packages.
- Stricter TypeScript compiler options (`noImplicitReturns`, `noFallthroughCasesInSwitch`,
  `noImplicitOverride`, `forceConsistentCasingInFileNames`).

### Changed

- Global view now shows a human-readable project name instead of the workspace-storage hash. The name
  comes from `workspace.json` when present, and otherwise is derived from the absolute file paths in
  the chat logs (picking the project root folder), which covers dev-container / remote workspaces that
  have no `workspace.json` (`src/global.ts`).
- Internal refactor toward the conventions used by the Microsoft VS Code extensions:
  - Shared mutable state is now centralised in a typed `ext` singleton (`src/extensionVariables.ts`)
    instead of scattered module-level variables.
  - Commands are registered through a `registerCommand` wrapper that logs and surfaces handler
    errors via a dedicated output channel (`src/log.ts`) rather than swallowing them.
  - Webview nonce and Content-Security-Policy generation is deduplicated into `src/webview.ts`,
    using a cryptographically-strong nonce.

### Fixed

- Global view totals now match the Workspace view. The global scan previously read only each
  session's `main.jsonl` and summed every `llm_request` line, which both missed billable usage
  recorded in title/categorization sub-logs and double-counted spans that Copilot rewrites as usage
  arrives. It now reads every session `.jsonl` and deduplicates spans by key — the same methodology
  as the live workspace reader (`src/global.ts`).
- Global view now deduplicates duplicate `llm_request` lines with the same last-wins policy as the
  live workspace reader. Copilot appends a rewritten line for a request as its token/credit usage
  streams in, and roughly three quarters of spans end up with different values across their copies;
  the global scan was keeping the first (partial) copy while the workspace reader keeps the final
  one, so the two views disagreed (e.g. 46M tokens / 4677 credits vs 49.6M tokens / 4592 credits for
  the same project). The global scan now keeps the final copy too (`src/global.ts`).

## [0.1.3]

- Baseline release prior to the changelog being introduced.
