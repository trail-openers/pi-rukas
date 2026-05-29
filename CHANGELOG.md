# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).
After v0.1.0, version bumps are driven automatically by
[release-please](https://github.com/googleapis/release-please) from
[Conventional Commits](https://www.conventionalcommits.org/).

## [0.12.1](https://github.com/randomm/pi-ensemble/compare/v0.12.0...v0.12.1) (2026-05-29)


### Bug Fixes

* **permissions:** /start step 4 PM-direct read-only gh pr/run; drop ops dispatch dependency ([#103](https://github.com/randomm/pi-ensemble/issues/103)) ([846dcd9](https://github.com/randomm/pi-ensemble/commit/846dcd95a31d0fedf524c5580b78e824c5f8e3fe)), closes [#102](https://github.com/randomm/pi-ensemble/issues/102)
* **permissions:** clean ghost issue/pr/ci grants, PM tickets via bare gh, /start $(pwd) injection ([#100](https://github.com/randomm/pi-ensemble/issues/100)) ([d99a93a](https://github.com/randomm/pi-ensemble/commit/d99a93a14c61e8e121e39f30571263019658500c)), closes [#99](https://github.com/randomm/pi-ensemble/issues/99)
* **permissions:** injection-vector check ignores content inside quoted args ([#109](https://github.com/randomm/pi-ensemble/issues/109)) ([b89f79c](https://github.com/randomm/pi-ensemble/commit/b89f79cd42633861fc626558ae365eb8a01a0598)), closes [#108](https://github.com/randomm/pi-ensemble/issues/108)
* **permissions:** PM allowed bare \`git diff\` — adversarial_loop needs raw diff as input ([#113](https://github.com/randomm/pi-ensemble/issues/113)) ([194c202](https://github.com/randomm/pi-ensemble/commit/194c2023f245190c507fd74f67ede05618e189ce)), closes [#112](https://github.com/randomm/pi-ensemble/issues/112)
* **prompts:** strengthen subagent output contract — never empty turn, ~300-line cap ([#107](https://github.com/randomm/pi-ensemble/issues/107)) ([b5ebf98](https://github.com/randomm/pi-ensemble/commit/b5ebf9887af07a4812ad01c70dfd226263a4c51c)), closes [#106](https://github.com/randomm/pi-ensemble/issues/106)
* **prompts:** tell agent Pi's bash captures stderr (no 2&gt;&1 needed) + `(no output)` ≠ failure ([#111](https://github.com/randomm/pi-ensemble/issues/111)) ([69399ca](https://github.com/randomm/pi-ensemble/commit/69399ca3ccde0e250bfa2caab999a1a055f19223)), closes [#110](https://github.com/randomm/pi-ensemble/issues/110)

## [0.12.0](https://github.com/randomm/pi-ensemble/compare/v0.11.0...v0.12.0) (2026-05-29)


### ⚠ BREAKING CHANGES

* **dispatch:** strip agent-controlled model override from dispatch tools ([#93](https://github.com/randomm/pi-ensemble/issues/93))

### Features

* **spawn:** auto-forward installed Pi extensions to subagents ([#89](https://github.com/randomm/pi-ensemble/issues/89)) ([db7d596](https://github.com/randomm/pi-ensemble/commit/db7d59633f10efe02f2def16e811a0790917dd14)), closes [#88](https://github.com/randomm/pi-ensemble/issues/88)


### Bug Fixes

* **ci:** bump feat: to PATCH instead of MINOR while pre-1.0 ([#95](https://github.com/randomm/pi-ensemble/issues/95)) ([3354d55](https://github.com/randomm/pi-ensemble/commit/3354d5506eb649d56375c1caa360047c8d88ca05)), closes [#94](https://github.com/randomm/pi-ensemble/issues/94)
* **dispatch:** strip agent-controlled model override from dispatch tools ([#93](https://github.com/randomm/pi-ensemble/issues/93)) ([4d646e5](https://github.com/randomm/pi-ensemble/commit/4d646e561389b9c5a5be6c8efa922ab0e95a9cd1)), closes [#92](https://github.com/randomm/pi-ensemble/issues/92)
* **permissions:** allow bare git reads for PM, drop redundant oo variants ([#97](https://github.com/randomm/pi-ensemble/issues/97)) ([ca77a15](https://github.com/randomm/pi-ensemble/commit/ca77a15fd68283d92b60bf1c2f155d45401c447f)), closes [#96](https://github.com/randomm/pi-ensemble/issues/96)

## [0.11.0](https://github.com/randomm/pi-ensemble/compare/v0.10.1...v0.11.0) (2026-05-28)


### ⚠ BREAKING CHANGES

* **work:** pair_watch tool removed. Workflows that called pair_watch directly must switch to dispatch_specialist (role: developer) followed by adversarial_loop on the resulting diff. The /work slash command already does this. Pre-1.0 alpha; no deprecation shim.

### Features

* **#24:** delegate /start context gathering to explore subagent ([#40](https://github.com/randomm/pi-ensemble/issues/40)) ([adf4ffc](https://github.com/randomm/pi-ensemble/commit/adf4ffc3981f5ebc99aa4ddfb0a170691386ac30))
* **#45-47:** per-host MCP server support ([#48](https://github.com/randomm/pi-ensemble/issues/48)) ([19e704b](https://github.com/randomm/pi-ensemble/commit/19e704b82731e7bcaf419c3e88b1a93db783b782))
* **#49:** unified layered permission system with interactive onboarding ([#53](https://github.com/randomm/pi-ensemble/issues/53)) ([ddda31b](https://github.com/randomm/pi-ensemble/commit/ddda31b75318b436330a39000843d19952a96bcf))
* **#54,#55:** pattern-based bash decision caching + AGENTS.md MEDIUM+ rule ([#56](https://github.com/randomm/pi-ensemble/issues/56)) ([faf0e18](https://github.com/randomm/pi-ensemble/commit/faf0e18c9a2f0636326d656e381f81da0524e730))
* async dispatch pivot + adapter architecture + PM safety + branch hygiene ([#20](https://github.com/randomm/pi-ensemble/issues/20)) ([0c6af0c](https://github.com/randomm/pi-ensemble/commit/0c6af0cf97fbf7a89957c1126a2fa12b868a60b9))
* **audit:** finalize docs and smoke coverage ([#57](https://github.com/randomm/pi-ensemble/issues/57)) ([85bbccf](https://github.com/randomm/pi-ensemble/commit/85bbccf54f38aa5d6ebad89dfe7cc691d96d3cb5))
* **deps:** switch context7 integration from MCP to ctx7 CLI ([58b7a6d](https://github.com/randomm/pi-ensemble/commit/58b7a6d7e6ca17ac68353719e257b05c92f06a1f))
* **epic#31:** add /audit slash command for standards-first repo inspection ([#42](https://github.com/randomm/pi-ensemble/issues/42)) ([f4c4db2](https://github.com/randomm/pi-ensemble/commit/f4c4db2794796729205aef812bb2c57f5d5215c8))
* **observability:** stream live subagent progress via onUpdate ([857be5c](https://github.com/randomm/pi-ensemble/commit/857be5c5b006b77f63fa50d99beab8419c3b52dc))
* **pair-watch:** live asymmetric pair-coding gate replaces developer + adversarial_loop ([#27](https://github.com/randomm/pi-ensemble/issues/27)) ([4add3a5](https://github.com/randomm/pi-ensemble/commit/4add3a551d2a27ed4c39dc94868c4bf875b901b0))
* **runs:** auto-prune to keep last N batches on disk ([7cdcba9](https://github.com/randomm/pi-ensemble/commit/7cdcba9e941904213cb8da228f8171290cad8c9d))
* **work:** remove pair_watch — restore developer + adversarial_loop gate ([#65](https://github.com/randomm/pi-ensemble/issues/65)) ([#70](https://github.com/randomm/pi-ensemble/issues/70)) ([84b5290](https://github.com/randomm/pi-ensemble/commit/84b529055a5458cd8d888c261c7c19ed9600482c))


### Bug Fixes

* **#63:** harden bash wildcard permission caching ([#64](https://github.com/randomm/pi-ensemble/issues/64)) ([ec4804b](https://github.com/randomm/pi-ensemble/commit/ec4804ba23b66067252bd899e3a60ba870ab58e4))
* **build:** use explicit arithmetic instead of post-increment ([44050d7](https://github.com/randomm/pi-ensemble/commit/44050d7fa694536936f0f3e91a67144cd4944089))
* **ci:** make test-runs tolerate missing ensemble-runs dir ([9859cc0](https://github.com/randomm/pi-ensemble/commit/9859cc074d14c46b86179b1e54f129d068ed45d9))
* **permissions:** correct agents.json path resolution — root cause of prompt fatigue ([#83](https://github.com/randomm/pi-ensemble/issues/83)) ([#84](https://github.com/randomm/pi-ensemble/issues/84)) ([467e3a0](https://github.com/randomm/pi-ensemble/commit/467e3a0b584469daefdb9a4e1f99e191b3155b03))
* **permissions:** grant pi-ensemble's own dispatch tools in agents.json ([#85](https://github.com/randomm/pi-ensemble/issues/85)) ([#86](https://github.com/randomm/pi-ensemble/issues/86)) ([9bd34b4](https://github.com/randomm/pi-ensemble/commit/9bd34b4a1da447d19d50b90b5a07031e96112bad))
* **permissions:** use nested allowlist, transparent quoted args, cache cleanup ([#75](https://github.com/randomm/pi-ensemble/issues/75)) ([#81](https://github.com/randomm/pi-ensemble/issues/81)) ([aa809a0](https://github.com/randomm/pi-ensemble/commit/aa809a01fb24520bcb28ae316d82d1464a88e145))
* **release:** use plain v0.x.y tag format instead of monorepo prefix ([8deaf3e](https://github.com/randomm/pi-ensemble/commit/8deaf3e3ce9a012ec158444291a1a19bb105df76))
* **runs:** paginate batch list so it fits the screen ([00d974a](https://github.com/randomm/pi-ensemble/commit/00d974a0d5182c3f512d8d9b93fd0b03860f0e15))
* **security:** enable Dependabot for npm + github-actions ([09c9c8c](https://github.com/randomm/pi-ensemble/commit/09c9c8c2eb8b119b9d309049bbcb3fb528ea24a2))
* **spawn:** cap child wall-clock and propagate Esc cancellation ([2d42a7d](https://github.com/randomm/pi-ensemble/commit/2d42a7d4fbd3f1fe04d4ca327cac33a8d4764f97))

## [0.10.1](https://github.com/randomm/pi-ensemble/compare/v0.10.0...v0.10.1) (2026-05-28)


### Bug Fixes

* **permissions:** correct agents.json path resolution — root cause of prompt fatigue ([#83](https://github.com/randomm/pi-ensemble/issues/83)) ([#84](https://github.com/randomm/pi-ensemble/issues/84)) ([467e3a0](https://github.com/randomm/pi-ensemble/commit/467e3a0b584469daefdb9a4e1f99e191b3155b03))

## [0.10.0](https://github.com/randomm/pi-ensemble/compare/v0.9.0...v0.10.0) (2026-05-28)


### ⚠ BREAKING CHANGES

* **work:** pair_watch tool removed. Workflows that called pair_watch directly must switch to dispatch_specialist (role: developer) followed by adversarial_loop on the resulting diff. The /work slash command already does this. Pre-1.0 alpha; no deprecation shim.

### Features

* **#24:** delegate /start context gathering to explore subagent ([#40](https://github.com/randomm/pi-ensemble/issues/40)) ([adf4ffc](https://github.com/randomm/pi-ensemble/commit/adf4ffc3981f5ebc99aa4ddfb0a170691386ac30))
* **#45-47:** per-host MCP server support ([#48](https://github.com/randomm/pi-ensemble/issues/48)) ([19e704b](https://github.com/randomm/pi-ensemble/commit/19e704b82731e7bcaf419c3e88b1a93db783b782))
* **#49:** unified layered permission system with interactive onboarding ([#53](https://github.com/randomm/pi-ensemble/issues/53)) ([ddda31b](https://github.com/randomm/pi-ensemble/commit/ddda31b75318b436330a39000843d19952a96bcf))
* **#54,#55:** pattern-based bash decision caching + AGENTS.md MEDIUM+ rule ([#56](https://github.com/randomm/pi-ensemble/issues/56)) ([faf0e18](https://github.com/randomm/pi-ensemble/commit/faf0e18c9a2f0636326d656e381f81da0524e730))
* async dispatch pivot + adapter architecture + PM safety + branch hygiene ([#20](https://github.com/randomm/pi-ensemble/issues/20)) ([0c6af0c](https://github.com/randomm/pi-ensemble/commit/0c6af0cf97fbf7a89957c1126a2fa12b868a60b9))
* **audit:** finalize docs and smoke coverage ([#57](https://github.com/randomm/pi-ensemble/issues/57)) ([85bbccf](https://github.com/randomm/pi-ensemble/commit/85bbccf54f38aa5d6ebad89dfe7cc691d96d3cb5))
* **deps:** switch context7 integration from MCP to ctx7 CLI ([58b7a6d](https://github.com/randomm/pi-ensemble/commit/58b7a6d7e6ca17ac68353719e257b05c92f06a1f))
* **epic#31:** add /audit slash command for standards-first repo inspection ([#42](https://github.com/randomm/pi-ensemble/issues/42)) ([f4c4db2](https://github.com/randomm/pi-ensemble/commit/f4c4db2794796729205aef812bb2c57f5d5215c8))
* **observability:** stream live subagent progress via onUpdate ([857be5c](https://github.com/randomm/pi-ensemble/commit/857be5c5b006b77f63fa50d99beab8419c3b52dc))
* **pair-watch:** live asymmetric pair-coding gate replaces developer + adversarial_loop ([#27](https://github.com/randomm/pi-ensemble/issues/27)) ([4add3a5](https://github.com/randomm/pi-ensemble/commit/4add3a551d2a27ed4c39dc94868c4bf875b901b0))
* **runs:** auto-prune to keep last N batches on disk ([7cdcba9](https://github.com/randomm/pi-ensemble/commit/7cdcba9e941904213cb8da228f8171290cad8c9d))
* **work:** remove pair_watch — restore developer + adversarial_loop gate ([#65](https://github.com/randomm/pi-ensemble/issues/65)) ([#70](https://github.com/randomm/pi-ensemble/issues/70)) ([84b5290](https://github.com/randomm/pi-ensemble/commit/84b529055a5458cd8d888c261c7c19ed9600482c))


### Bug Fixes

* **#63:** harden bash wildcard permission caching ([#64](https://github.com/randomm/pi-ensemble/issues/64)) ([ec4804b](https://github.com/randomm/pi-ensemble/commit/ec4804ba23b66067252bd899e3a60ba870ab58e4))
* **build:** use explicit arithmetic instead of post-increment ([44050d7](https://github.com/randomm/pi-ensemble/commit/44050d7fa694536936f0f3e91a67144cd4944089))
* **ci:** make test-runs tolerate missing ensemble-runs dir ([9859cc0](https://github.com/randomm/pi-ensemble/commit/9859cc074d14c46b86179b1e54f129d068ed45d9))
* **release:** use plain v0.x.y tag format instead of monorepo prefix ([8deaf3e](https://github.com/randomm/pi-ensemble/commit/8deaf3e3ce9a012ec158444291a1a19bb105df76))
* **runs:** paginate batch list so it fits the screen ([00d974a](https://github.com/randomm/pi-ensemble/commit/00d974a0d5182c3f512d8d9b93fd0b03860f0e15))
* **security:** enable Dependabot for npm + github-actions ([09c9c8c](https://github.com/randomm/pi-ensemble/commit/09c9c8c2eb8b119b9d309049bbcb3fb528ea24a2))
* **spawn:** cap child wall-clock and propagate Esc cancellation ([2d42a7d](https://github.com/randomm/pi-ensemble/commit/2d42a7d4fbd3f1fe04d4ca327cac33a8d4764f97))

## [0.9.0](https://github.com/randomm/pi-ensemble/compare/v0.8.0...v0.9.0) (2026-05-28)


### ⚠ BREAKING CHANGES

* **work:** pair_watch tool removed. Workflows that called pair_watch directly must switch to dispatch_specialist (role: developer) followed by adversarial_loop on the resulting diff. The /work slash command already does this. Pre-1.0 alpha; no deprecation shim.

### Features

* **work:** remove pair_watch — restore developer + adversarial_loop gate ([#65](https://github.com/randomm/pi-ensemble/issues/65)) ([#70](https://github.com/randomm/pi-ensemble/issues/70)) ([84b5290](https://github.com/randomm/pi-ensemble/commit/84b529055a5458cd8d888c261c7c19ed9600482c))


### Bug Fixes

* **#63:** harden bash wildcard permission caching ([#64](https://github.com/randomm/pi-ensemble/issues/64)) ([ec4804b](https://github.com/randomm/pi-ensemble/commit/ec4804ba23b66067252bd899e3a60ba870ab58e4))

## [0.8.0](https://github.com/randomm/pi-ensemble/compare/v0.7.0...v0.8.0) (2026-05-27)


### Features

* **audit:** finalize docs and smoke coverage ([#57](https://github.com/randomm/pi-ensemble/issues/57)) ([85bbccf](https://github.com/randomm/pi-ensemble/commit/85bbccf54f38aa5d6ebad89dfe7cc691d96d3cb5))

## [0.7.0](https://github.com/randomm/pi-ensemble/compare/v0.6.0...v0.7.0) (2026-05-27)


### Features

* **#45-47:** per-host MCP server support ([#48](https://github.com/randomm/pi-ensemble/issues/48)) ([19e704b](https://github.com/randomm/pi-ensemble/commit/19e704b82731e7bcaf419c3e88b1a93db783b782))
* **#49:** unified layered permission system with interactive onboarding ([#53](https://github.com/randomm/pi-ensemble/issues/53)) ([ddda31b](https://github.com/randomm/pi-ensemble/commit/ddda31b75318b436330a39000843d19952a96bcf))
* **#54,#55:** pattern-based bash decision caching + AGENTS.md MEDIUM+ rule ([#56](https://github.com/randomm/pi-ensemble/issues/56)) ([faf0e18](https://github.com/randomm/pi-ensemble/commit/faf0e18c9a2f0636326d656e381f81da0524e730))
* **epic#31:** add /audit slash command for standards-first repo inspection ([#42](https://github.com/randomm/pi-ensemble/issues/42)) ([f4c4db2](https://github.com/randomm/pi-ensemble/commit/f4c4db2794796729205aef812bb2c57f5d5215c8))

## [0.6.0](https://github.com/randomm/pi-ensemble/compare/v0.5.0...v0.6.0) (2026-05-26)


### Features

* **#24:** delegate /start context gathering to explore subagent ([#40](https://github.com/randomm/pi-ensemble/issues/40)) ([adf4ffc](https://github.com/randomm/pi-ensemble/commit/adf4ffc3981f5ebc99aa4ddfb0a170691386ac30))

## [0.5.0](https://github.com/randomm/pi-ensemble/compare/v0.4.0...v0.5.0) (2026-05-26)


### Features

* **pair-watch:** live asymmetric pair-coding gate replaces developer + adversarial_loop ([#27](https://github.com/randomm/pi-ensemble/issues/27)) ([4add3a5](https://github.com/randomm/pi-ensemble/commit/4add3a551d2a27ed4c39dc94868c4bf875b901b0))

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
