# pi-rukas

<img align="right" width="220" src="assets/pirukas.png" alt="pirukas">

[![CI](https://github.com/trail-openers/pi-rukas/actions/workflows/ci.yml/badge.svg)](https://github.com/trail-openers/pi-rukas/actions/workflows/ci.yml)
[![License](https://img.shields.io/badge/License-Apache_2.0-blue.svg)](LICENSE)

## Why pi-rukas?

pirukas is Estonian for pie — golden yeast dough wrapped around savory fillings, from a Slavic root meaning feast. Split it after pi and you get the agent it's built on plus the dish it's named after.
Is it a backronym? Technically, Pie Is Ready — Users Keep Adding Steps. But honestly, rukas isn't a word. Stop trying to expand it. The pie is the meaning.

A multi-specialist orchestrator extension for [Pi](https://pi.dev) — the terminal AI coding agent. Spawns role-specialised child Pi processes in parallel, isolates them in git worktrees, runs a mandatory adversarial gate before commit, and gates merge on a six-pass code review (security, error handling, type safety, performance, architecture, simplicity).

> **Status: alpha.** The interfaces work and the workflow runs end-to-end, but the API will change before `1.0`. Use on disposable repos until you've kicked the tires. Run whatever Pi version you like — [docs/pi-compatibility.md](docs/pi-compatibility.md) carries the single maintained "last verified against" line (the version to fall back to if you hit trouble on a newer Pi) and the full list of version-claim sites.

## What you get

Seven slash commands, an orchestrator-shaped system prompt, and nine tools that drive parallel specialist agents:

| Command | What it does |
|---|---|
| `/start` | Initialises a project session — searches memory, indexes the codebase, gathers git/PR/CI state, reports readiness. |
| `/research <topic>` | Runs the compiled research spine (`start_research_driver`): memory inventory → parallel angle retrieval → **deterministic verification** (URL liveness; codebase claims grounded against the pinned commit) → a **dated artifact + provenance sidecar** under `outputs/` → a typed vipune row superseding the prior run. Tiers: `quick` / `standard` / `deep` / `adoption` (OSS decision memo). Zero verified findings writes an honest abstention, never a confident fabrication. |
| `/plan <description>` | Drafts a GitHub issue from your input — auto-classifies as bug/feature/epic/chore/spike, applies the right template, asks before creating. Runs as a compiled pipeline (`start_plan_driver`): a **deterministic pre-triage** rejects a too-thin descriptor before any dispatch; typed context blocks and an "EXACTLY N sub-issues" pin thread into the epic decomposition; the drafted body passes **deterministic validation** before any LLM review; the adversarial gap gate runs for bug/feature/epic (validation is the chore/spike gate); bodies are budgeted to the forge's 65,536-char limit — compacted deterministically or halted with a per-section size breakdown. |
| `/work <issue#> [<issue#> ...] [--restart] [--merge]` | Runs an issue end-to-end through a **compiled state-machine driver** (`extension/src/work-driver.ts`): explore → plan → feature branch (always a worktree per workstream, provisioned via `.pi/worktree-setup` or by symlinking gitignored non-empty dependency dirs (discovered at `repoRoot` and in depth-1 package dirs)) → developer dispatch → **driver-side outcome verification** (executed evidence: real diff exists + project typecheck/test passes, verify command from `.pi/verify-cmd` else auto-detected, optional product smoke command runs from `.pi/smoke-cmd`, skip-marker ratchet checks for net additions of `#[ignore]`/`it.skip`/etc., no LLM judgment) → **per-workstream `adversarial_loop` gate** (parallel for N>1) → **driver-executed commit + PR** (mechanized consolidation of all worktrees, `git apply --index` + push + `gh pr create` run as code, LLM ops only as fallback) → **outcome verification again** (commits exist, PR resolves via `gh`) → **six-pass code review** → CI watch → **merge, but only when explicitly permitted** (an explicit grant in the project's `AGENTS.md`, or `--merge` for the run; with neither, the PR is opened and the cycle parks as `awaiting-human-merge`) **and only on executed evidence** (`gh pr checks` + `mergeStateStatus`, never an agent's claim; `skipped`/`neutral` required checks do not count as passing). Accepts multiple issue numbers (`/work 561 562 563`) to run a **deterministic grouping analysis** first (link markers, path-overlap Jaccard ≥ 0.5, subsystem-tag prefixes) — related issues share ONE PR, unrelated issues run as separate sequential cycles. Restores the old PM-driven `/work`'s "analyze first, decide the plan" shape but in pure code (see `docs/troubleshooting.md` for the rules). Halt-on-non-merged between groups: if a group's cycle handoffs / aborts, the queue stops and names the remaining groups so the operator can intervene. Pass `--restart` (order-independent) to wipe the prior state file and start a fresh cycle — useful after revising the issue body via `/plan` following a `step-back-revise-spec` handoff. Resumable state at `.pi/work-state/<primary>.json`; cap-hits surface as structured handoff comments with verbatim recovery commands. |
| `/do <description>` | Free-form orchestration counterpart to `/work` — no GitHub issue required. PM-driven (same dispatch toolkit as `/work` but no compiled driver / state file). Use when you want to act on lens-review findings, fix something small without filing an issue, or work on a community-submitted PR. |
| `/review [#PR \| path \| latest N]` | On-demand six-pass code review of a PR, file, directory, or the latest N PRs. Returns a deduplicated, precedence-merged verdict (APPROVED / ISSUES_FOUND / CRITICAL_ISSUES_FOUND). |
| `/audit [<path> \| "full"]` | Standards-first repo/path audit. Derives expectations from docs/config/CI/memory/examples, then reports misalignments across bugs, dead code, style drift, architecture drift, and quality-gate gaps. |

Plus utility commands: `/ensemble-model` (per-role subagent model picker), `/runs` (browse subagent transcripts), `/ensemble-debug` (show resolved configuration), `/work-status` (live `/work` cycle status; postmortem layout in a terminal state).

## When to use which command

- **`/start`** — beginning of a session: load context, check state. Reads only.
- **`/research <topic>`** — investigate a topic (web + codebase + memory); deterministic verification, dated artifact + provenance under `outputs/`.
- **`/plan <description>`** — draft a GitHub issue. No memory writes.
- **`/work <issue#>`** — execute an issue end-to-end (implement → review → merge) on a feature branch. Subagents may write to memory.
- **`/do <description>`** — free-form work without an issue. Subagents may write to memory.
- **`/review`** — evaluate code against the six universal quality lenses; does not write to memory.
- **`/audit`** — audit a repo or path against its own intended standards; sparse, durable stores only.

**Quick rule of thumb**: learn → `/research`; fix with an issue → `/work <issue#>`; fix free-form → `/do <description>`; check code quality → `/review`; assess overall health → `/audit`.

## Prerequisites

Required CLIs on `$PATH`. The role prompts assume all of these are installed — without them, the agents fail at runtime.

| Tool | Purpose |
|---|---|
| [Pi](https://pi.dev) | The terminal coding agent this extends. |
| [`bun`](https://bun.com) | Runtime for the extension (loads TS via `jiti`). |
| `git` ≥ 2.20 | Worktrees, branches, diffs. |
| Forge CLI (`gh` / `glab`) | Forge issue / PR / CI ops — `gh` for GitHub, `glab` for GitLab. Install at least one; both is fine. |
| [`vipune`](https://github.com/randomm/vipune) | Cross-session memory (fact + observation patterns). All agents call this. (Cargo from source.) |
| [`codebase-memory-mcp`](https://github.com/DeusData/codebase-memory-mcp) | Knowledge-graph code indexer exposed as MCP — powers `codebase_memory_search_code` / `trace_path` / `detect_changes` / `get_architecture`. (curl-to-bash install.) |
| [`oo`](https://github.com/randomm/oo) | Context-efficient wrapper for chatty CLIs (git, gh). (Cargo from source. Pinned to floor `0.5.0`.) |
| `jq` | Used by `build.sh` to assemble the capability matrix into the PM prompt. |
| [`parallel-cli`](https://docs.parallel.ai/cli/overview) | Web search / fetch / deep research for the `explore` role. (Homebrew tap.) |
| [`pi-mcp-adapter`](https://github.com/nicobailon/pi-mcp-adapter) | MCP bridge — **without the bridge no MCP server loads**. Sandbox users are unaffected: the image bakes it in. |
| [`ctx7`](https://context7.com) | Current third-party library documentation. `ctx7 library <name>` → `ctx7 docs <id> <query>`. Free tier works without login. |

### Supply-chain setup (recommended one-time before installing)

Recent supply-chain attacks (compromised maintainer publishes a malicious version, caught and yanked within hours) make a release-age embargo worth setting up **once, globally**:

```bash
# npm — applies to all `npm install -g …` from now on
npm config set min-release-age 4                                  # requires npm ≥ 11.10.0
# bun: project-local bunfig.toml already sets minimumReleaseAge = 345600 in THIS repo
```

With the embargo, the install commands below refuse any version published in the last 4 days — the most common attack window. We also recommend `--ignore-scripts` on every npm install (Pi's [own quickstart](https://pi.dev/docs/latest/quickstart) recommends it) to disable postinstall hooks — another common supply-chain vector.

### Install commands

Copy-pasteable. All installs use the latest version your package manager allows (with the embargo above, "latest" means ≥4 days old).

```bash
# Pi (per https://pi.dev/docs/latest/quickstart)
npm install -g --ignore-scripts @earendil-works/pi-coding-agent@0.84.4

# bun (≥ 1.2.20)
curl -fsSL https://bun.com/install | bash

# git, jq — your OS package manager; the forge CLI (gh and/or glab) the same way
brew install git jq gh                                                # macOS (gh)
# sudo apt install git jq gh                                          # Debian/Ubuntu (gh)
# glab — GitLab forge CLI: brew install --no-quarantine glab (macOS); see
# https://gitlab.com/gitlab-org/cli for the Linux one-liner.

# vipune, oo — cargo from source (Rust toolchain required)
cargo install vipune && cargo install double-o --version 0.5.0

# pi-mcp-adapter (REQUIRED — Pi core has no native MCP; without the bridge no MCP server loads)
pi install npm:pi-mcp-adapter

# codebase-memory-mcp (REQUIRED — pi-rukas's code-search doctrine depends on it)
curl -fsSL https://raw.githubusercontent.com/DeusData/codebase-memory-mcp/main/install.sh | bash
# Installs the C binary at ~/.local/bin/codebase-memory-mcp (~250 MB); pi-rukas's
# install.sh registers it with pi-mcp-adapter automatically (see "After install" below).

# parallel-cli
brew install parallel-web/tap/parallel-cli
parallel-cli login

# ctx7
npm install -g --ignore-scripts ctx7
```

After install:

- `vipune version` once to initialise `~/.vipune/`.
- Run pi-rukas's `./install.sh` from this repo. It detects `codebase-memory-mcp` on your `PATH` (or in `~/.local/bin/`) and wires a `codebase_memory` entry into `~/.config/mcp/mcp.json` (the bridge from the [Install commands](#install-commands) block; full walkthrough in [docs/mcp.md](docs/mcp.md)). **You should not have to hand-edit any MCP config** — re-running is safe (idempotent merge). Verify after `pi` restarts with `/mcp` — should list `codebase_memory` with its 7 direct tools (`search_code`, `search_graph`, `trace_path`, `detect_changes`, `get_code_snippet`, `get_architecture`, `query_graph`).
- One-shot index every project the first time pi opens there: `mcp({tool: "codebase_memory_index_repository", args: '{"repo_path": "."}'})` — `/start` does this on first use; the file watcher keeps it current. Indexed data lives in `~/.cache/codebase-memory-mcp/`.

**Platform.** Supported: macOS and Linux. Native Windows is unsupported (every entrypoint is a bash script, the install is symlink-based, and the sandbox bind-mounts the project at its host absolute path). WSL2 is **expected to work but untested**; sandbox mode additionally needs Docker. Bun ≥ 1.2.20 and Node ≥ 22 (Pi's own requirement) are assumed. You can also defer `ctx7` entirely — the `explore` role tries to call it but everything else works without it.

## Quickstart

```bash
git clone https://github.com/trail-openers/pi-rukas.git
cd pi-rukas
./install.sh
```

The installer builds the role prompts, symlinks the bundled skills into `~/.pi/agent/skills/`, installs the extension's deps, registers the extension with Pi, **pulls the sandbox Docker image from `ghcr.io/trail-openers/pi-rukas:latest`** (falls back to a local build if the pull fails), and symlinks the `pi-rukas` wrapper into `~/.local/bin/`. Pass `--build` to force a local build; `--pull-only` to hard-fail when the registry is unreachable.

Verify (sandbox mode, recommended): `pi-rukas` from any project, then run `/ensemble-debug` in the Pi prompt — it should list 9 slash commands, 9 tools, and the per-role model table, with zero permission prompts inside the container. Host mode (legacy): run `pi` the same way — 3-tier permission system, expect interactive prompts on novel commands.

## Sandboxed mode (recommended)

`pi-rukas` launches Pi inside a Docker container where the container fence IS the trust boundary — no per-call permission prompts. Host state that should survive across sessions is bind-mounted in; container-local caches use named volumes. This is the recommended mode; host-mode `pi` remains available without Docker.

Note: the container has unrestricted network egress for v1 — the sandbox protects your filesystem but not your network. Full detail — the bind-mount table, `pi-rukas` wrapper subcommands, cross-mode persistence, session resume, tailnet/host aliases, drag-and-drop images, and the docker-socket / SSH trade-off — lives in [docs/sandbox.md](docs/sandbox.md).

## How it works

The parent `pi` you launch becomes the **project manager (PM)** — when you fire a registered slash command, the extension injects PM doctrine into the system prompt for that turn (one-shot, no global bleed), and the PM runs the workflow body and dispatches specialists. Each **specialist** is a child `pi` process spawned with `pi --mode rpc --no-extensions --session <transcript> --append-system-prompt <role.md>`; `--mode rpc` keeps stdin open for JSON command injection — the initial prompt arrives as a `{ type: "prompt", message }` RPC command, and the same channel carries mid-flight `{ type: "steer", message }` injections from `dispatch_steer`. Six roles ship (`project-manager`, `developer`, `ops`, `explore`, `adversarial-developer`, `code-review-specialist`), each with its own system prompt assembled from `agents-base/`, `modules/`, and `manifests/` via `build.sh`.

Tools (all async via push-callback — tools return a `{ jobId }` immediately; the final report arrives later as an `[ensemble:async]` user message):

| Tool | Purpose |
|---|---|
| `dispatch_specialist` | Spawn exactly ONE specialist (developer / ops / explore / adversarial-developer / code-review-specialist). |
| `dispatch_parallel` | Fan out 2-10 specialists in parallel; ONE consolidated report arrives when all complete. |
| `adversarial_loop` | Encapsulated 3-round review-then-fix gate: takes the developer's diff, runs an adversarial review, spawns a fresh developer to address any findings, re-reviews (diff re-read before each round). The mandatory gate before any commit — only `CRITICAL_ISSUES_FOUND` blocks when the rounds run out; non-blocking findings are carried into the PR body and the six-pass review instead of killing the cycle. |
| `dispatch_lens_review` | Six-pass code review — six children, each pinned to its lens skill. Findings come back as schema-validated `report_finding` tool calls, deduped by `(path, line, title)`, precedence-merged into a verdict. |
| `dispatch_status` | List in-flight async jobs (jobId, role, elapsed). Metadata only — never transcript content. |
| `dispatch_kill <jobId>` | Abort a running subagent or batch. |
| `dispatch_peek <jobId>` | Bounded, read-only introspection of a running subagent — last assistant text + last tool call ([#21](https://github.com/trail-openers/pi-rukas/issues/21)). |
| `dispatch_steer <jobId> <message>` | Inject a mid-flight steer into a running subagent via Pi's `--mode rpc` stdin channel — for exceptional rescue only (long-elapsed, stuck-looking) ([#152](https://github.com/trail-openers/pi-rukas/issues/152)). |
| `start_work_driver <issues[]>` | Start the compiled `/work` driver — the same pipeline the slash command runs, with its state file, queue, handoff artifact and review-cap timer. Returns immediately; merge authority is operator-only and has no parameter here ([#408](https://github.com/trail-openers/pi-rukas/issues/408)). |
| `load_workflow_doctrine <name>` | Return a workflow command's full instructions (`research`, `plan`, `review`, `audit`, `start`, `do`) as tool output, so PM can run one without the user typing the slash command. `/work` is deliberately excluded — it is a compiled driver, not prose. |
| `check_review_cap <key>` | Wall-clock cap helper for the `/work` fix loop — ok/exceeded against a 90-min budget so the PM stops doom-loops ([#4](https://github.com/trail-openers/pi-rukas/issues/4)). |

Per-child transcripts are saved to `~/.pi/agent/ensemble-runs/<date>/<runId>-<role>[-<tag>].json` — replay with `pi --session <path>` or browse via `/runs`. The user inspects these; orchestrating agents do NOT read them (the dispatch tool's report is the bounded summary by design). The live dispatch deck renders one row per RUNNING subagent below the editor (updated every second); **roster mode (#834)** lets you navigate rows from an empty editor with `↓`/`↑`/`j`/`k` and steer with `Enter`. Opt out: `PI_ENSEMBLE_QUIET_STATUS=1`; row cap: `PI_ENSEMBLE_DECK_MAX_ROWS` (default 20). Full key reference: [docs/configuration.md](docs/configuration.md#environment-variables).

## Configuring subagent models

You probably want a smarter model for the PM and a faster one for the specialists. The main agent (the `pi` you launch) is configured via Pi's own `--model` flag or settings. Subagent model choice is **user-authority-only** — the orchestrating agent cannot route a dispatch to a different provider on its own (jurisdiction routing is a data-residency / compliance decision, not an agent concern; [#92](https://github.com/trail-openers/pi-rukas/issues/92)). Resolution order:

1. `/ensemble-model` per-role choice (saved to `~/.pi/agent/ensemble-models.json`)
2. `/ensemble-model` all-subagents default (same file)
3. `PI_ENSEMBLE_MODEL_<ROLE>` env var, optionally paired with `PI_ENSEMBLE_PROVIDER_<ROLE>` for custom OpenAI-compatible providers
4. `PI_ENSEMBLE_SUBAGENT_MODEL` env var (global fallback), optionally paired with `PI_ENSEMBLE_SUBAGENT_PROVIDER`
5. Pi default (lowest)

Run `/ensemble-model` inside Pi to pick interactively from your authenticated provider catalog; add new built-in providers via Pi's `/login` and `pi-rukas` picks them up automatically. A custom OpenAI-compatible provider (self-hosted vLLM, an internal endpoint, any OpenAI Chat-Completions-compatible API) is a one-time registration in `~/.pi/agent/models.json` — see [docs/custom-providers.md](docs/custom-providers.md).

MCP servers ride a bridge extension (Pi has no native MCP; install: `pi install npm:pi-mcp-adapter`) — pi-rukas forwards the bridge to subagents and gates access per role. **2.33.0 of the bridge fails on npm 12+ with `EALLOWREMOTE` upstream ([nicobailon/pi-mcp-adapter#547](https://github.com/nicobailon/pi-mcp-adapter/issues/547)); host-mode installs are left unpinned by design, and sandbox users are unaffected — the image pins 2.32.1.** Full walkthrough: [docs/mcp.md](docs/mcp.md). All configuration — file and path locations plus the full `PI_ENSEMBLE_*` environment variable reference (main, outcome-verification, and sandbox-mode tables) — lives in [docs/configuration.md](docs/configuration.md). All optional; defaults are reasonable for typical use.

## Customising the role prompts

The 28 modules under `modules/` (vipune memory patterns, output standards, async-task discipline, workflows, etc.) compose into per-role system prompts via `manifests/<role>.manifest`. To change behaviour for a role: edit the module (e.g. `modules/core/vipune-baseline.md`) or add a new one referenced in a manifest, run `bun run build` from the repo root, and re-launch Pi — children pick up the new prompts on next spawn. `pi-prompts/*.md` (slash-command bodies) are read at runtime — no rebuild needed.

## Caveats (alpha)

- **Three permission modes.** **Sandbox** (recommended): container fence IS the trust boundary; no per-call gating. **Interactive host**: also no per-call gating by default — the agent runs as your UID with the same FS / network / creds as you, so per-call prompts at runtime volumes are theatre. **Headless** (`pi -p`) or **`PI_ENSEMBLE_STRICT_PERMISSIONS=1`**: 3-tier allow/deny/ask policy applies (`agents.json` + per-host and per-project overlays); headless hard-denies on ask. Use sandbox for confined execution, interactive host when you trust the agent, headless or strict-opt-in for automation / paranoia.
- **Cost.** Six-pass review on a typical PR is roughly 6 × ~2K tokens output per child plus context — order of `$0.02–$0.10` per cycle on cheap Cerebras models, more on Anthropic.
- **Worktrees are git CLI calls.** Will be migrated to the safer [`pi-worktree`](https://github.com/randomm/pi-worktree) plugin when its programmatic API stabilises.
- **Smoke tests** live in `extension/smoke-tests/`; `*-live.ts` files spawn real Pi children (a few cents per run), CI runs the offline ones.

## Pi compatibility

See [docs/pi-compatibility.md](docs/pi-compatibility.md) — the single maintained "last verified against" line, the non-normative dev pins in `extension/package.json`, and the bump procedure.

## Security

How to report a vulnerability (GitHub's private vulnerability reporting), what's in and out of scope, the acknowledgement window, and the honest trust model: [SECURITY.md](SECURITY.md).

## Acknowledgements

- [Pi](https://pi.dev) (`@earendil-works/pi-coding-agent`) by Mario Zechner — the terminal coding agent this extends.
- The modular prompt architecture, vipune doctrine, and six-lens code-review pattern originated in an [opencode](https://opencode.ai) configuration project.
- Sibling Pi extensions [`pi-worktree`](https://github.com/randomm/pi-worktree) and [`pi-permissions`](https://github.com/randomm/pi-permissions) — planned integration points for safer worktrees and per-role tool allowlists.

## License

Apache 2.0. See [LICENSE](LICENSE).
