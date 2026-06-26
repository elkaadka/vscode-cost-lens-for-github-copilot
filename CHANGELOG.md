# Changelog

All notable changes to the "Cost Lens for GitHub Copilot" extension are documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Changed

- Internal refactor toward the conventions used by the Microsoft VS Code extensions:
  - Shared mutable state is now centralised in a typed `ext` singleton (`src/extensionVariables.ts`)
    instead of scattered module-level variables.
  - Commands are registered through a `registerCommand` wrapper that logs and surfaces handler
    errors via a dedicated output channel (`src/log.ts`) rather than swallowing them.
  - Webview nonce and Content-Security-Policy generation is deduplicated into `src/webview.ts`,
    using a cryptographically-strong nonce.

### Added

- Anti-pattern detection: a new "Anti-patterns" section on the Workspace and Session tabs that
  analyses how you use Copilot (parsed from its own logs) and suggests concrete improvements.
  Detectors cover vague one-line prompts, runaway agent loops, oversized context, premium models
  used for trivial prompts, rapid re-prompting, and mid-session model hopping
  (`src/antipatterns.ts`, unit-tested in `test/antipatterns.test.cjs`).
- ESLint (flat config) with the TypeScript-ESLint recommended rules plus type-aware checks
  (`no-floating-promises`, `no-misused-promises`), wired into CI.
- `npm run lint` and `npm test` scripts; CI now lints, type-checks, compiles, tests, and packages.
- Stricter TypeScript compiler options (`noImplicitReturns`, `noFallthroughCasesInSwitch`,
  `noImplicitOverride`, `forceConsistentCasingInFileNames`).

## [0.1.3]

- Baseline release prior to the changelog being introduced.
