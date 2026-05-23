# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).
After v0.1.0, version bumps are driven automatically by
[release-please](https://github.com/googleapis/release-please) from
[Conventional Commits](https://www.conventionalcommits.org/).

## [0.4.0](https://github.com/randomm/pi-ensemble/compare/v0.3.0...v0.4.0) (2026-05-21)


### Features

* async dispatch pivot + adapter architecture + PM safety + branch hygiene ([#20](https://github.com/randomm/pi-ensemble/issues/20)) ([0c6af0c](https://github.com/randomm/pi-ensemble/commit/0c6af0cf97fbf7a89957c1126a2fa12b868a60b9))
* **runs:** auto-prune to keep last N batches on disk ([7cdcba9](https://github.com/randomm/pi-ensemble/commit/7cdcba9e941904213cb8da228f8171290cad8c9d))


### Bug Fixes

* **runs:** paginate batch list so it fits the screen ([00d974a](https://github.com/randomm/pi-ensemble/commit/00d974a0d5182c3f512d8d9b93fd0b03860f0e15))

## [0.3.0](https://github.com/randomm/pi-ensemble/compare/v0.2.0...v0.3.0) (2026-05-20)


### Features

* **observability:** stream live subagent progress via onUpdate ([857be5c](https://github.com/randomm/pi-ensemble/commit/857be5c5b006b77f63fa50d99beab8419c3b52dc))

## [0.2.0](https://github.com/randomm/pi-ensemble/compare/v0.1.2...v0.2.0) (2026-05-20)


### Features

* **deps:** switch context7 integration from MCP to ctx7 CLI ([58b7a6d](https://github.com/randomm/pi-ensemble/commit/58b7a6d7e6ca17ac68353719e257b05c92f06a1f))

## [0.1.2](https://github.com/randomm/pi-ensemble/compare/v0.1.1...v0.1.2) (2026-05-20)


### Bug Fixes

* **release:** use plain v0.x.y tag format instead of monorepo prefix ([8deaf3e](https://github.com/randomm/pi-ensemble/commit/8deaf3e3ce9a012ec158444291a1a19bb105df76))
* **security:** enable Dependabot for npm + github-actions ([09c9c8c](https://github.com/randomm/pi-ensemble/commit/09c9c8c2eb8b119b9d309049bbcb3fb528ea24a2))

## [0.1.1](https://github.com/randomm/pi-ensemble/compare/v0.1.0...v0.1.1) (2026-05-20)

### Bug Fixes

* **ci:** make test-runs tolerate missing ensemble-runs dir ([9859cc0](https://github.com/randomm/pi-ensemble/commit/9859cc074d14c46b86179b1e54f129d068ed45d9))
* **spawn:** cap child wall-clock and propagate Esc cancellation ([2d42a7d](https://github.com/randomm/pi-ensemble/commit/2d42a7d4fbd3f1fe04d4ca327cac33a8d4764f97))

## [0.1.0] — 2026-05-19

Initial alpha release.

Tested against `pi` (`@earendil-works/pi-coding-agent`) **0.75.3**.

### Added

- **Five slash commands** for the project-manager workflow:
  `/start`, `/research`, `/plan`, `/work`, `/review`.
- **Three utility commands**: `/ensemble-debug` (config introspection),
  `/ensemble-model` (interactive per-role model picker, persisted to
  `~/.pi/agent/ensemble-models.json`), `/runs` (browse subagent transcripts).
- **Six specialist roles** with separate system prompts assembled from
  `agents-base/` + `modules/` + `manifests/`: project-manager, developer,
  ops, explore, adversarial-developer, code-review-specialist.
- **Parallel dispatch** — `dispatch_specialist` and `dispatch_parallel` tools
  spawn role-pinned child Pi processes via `Promise.all`. Up to 10 concurrent.
- **Adversarial gate** — mandatory `adversarial_loop` tool runs up to 3 rounds
  of adversarial review + developer fix before code can be committed.
- **Six-pass code review** — `dispatch_lens_review` tool fans out one
  `code-review-specialist` per lens (SECURITY, ERROR_HANDLING, TYPE_SAFETY,
  PERFORMANCE, ARCHITECTURE, SIMPLICITY), each pinned to its lens-specific
  skill via `--skill <path>`. Findings come back as schema-validated
  `report_finding` tool calls; the parent deduplicates by `(path, line, title)`,
  applies precedence (SECURITY > ERROR_HANDLING > TYPE_SAFETY > PERFORMANCE >
  ARCHITECTURE > SIMPLICITY), and computes a verdict
  (APPROVED / ISSUES_FOUND / CRITICAL_ISSUES_FOUND).
- **Per-child transcripts** persisted to
  `~/.pi/agent/ensemble-runs/<date>/<runId>-<role>[-<tag>].json`. Replay with
  `pi --session <path>` or browse via `/runs`.
- **Model resolution** with five-layer priority: per-call override → saved
  per-role config → saved all-subagents config → `PI_ENSEMBLE_MODEL_<ROLE>`
  env var → `PI_ENSEMBLE_SUBAGENT_MODEL` env var → Pi default.
- **19 bundled skills** under `skill/` covering Python, Rust, Rails,
  React/React-Native, Go, shell, Postgres, devops, doc-maturity, the six
  code-review lenses, and more. Symlinked into `~/.pi/agent/skills/` at
  install time.
- **Modular prompt build** via `build.sh` — 28 reusable modules under
  `modules/` compose into six per-role system prompts. Single source of
  truth for vipune doctrine, output standards, async-task discipline,
  worktree workflow, quality gates, etc.

### Known limitations

- No per-role tool allowlists yet — specialists inherit Pi's default
  permissions. Use a sandbox repo until comfortable with how the model
  behaves. Tracked as a post-launch issue (planned integration:
  `@randomm/pi-permissions`).
- Worktree management uses raw `git worktree …` calls. Migration to the
  safer `@randomm/pi-worktree` programmatic API is planned.
- Six-pass review has no per-lens retry. If a lens fails to spawn or
  returns non-zero, that lens contributes zero findings but does not block
  the verdict.

[0.1.0]: https://github.com/randomm/pi-ensemble/releases/tag/v0.1.0
