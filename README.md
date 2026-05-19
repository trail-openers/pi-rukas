# pi-ensemble

[![CI](https://github.com/randomm/pi-ensemble/actions/workflows/ci.yml/badge.svg)](https://github.com/randomm/pi-ensemble/actions/workflows/ci.yml)
[![License](https://img.shields.io/badge/License-Apache_2.0-blue.svg)](LICENSE)

A multi-specialist orchestrator extension for [Pi](https://pi.dev) — the terminal AI coding agent. Spawns role-specialised child Pi processes in parallel, isolates them in git worktrees, runs a mandatory adversarial gate before commit, and gates merge on a six-pass code review (security, error handling, type safety, performance, architecture, simplicity).

> **Status: alpha.** The interfaces work and the workflow runs end-to-end, but the API will change before `1.0`. Use on disposable repos until you've kicked the tires. Tested against pi `0.75.3`.

## What you get

Five slash commands, an orchestrator-shaped system prompt, and six tools that drive parallel specialist agents:

| Command | What it does |
|---|---|
| `/start` | Initialises a project session — searches memory, indexes the codebase, gathers git/PR/CI state, reports readiness. |
| `/research <topic>` | Fans out multiple `explore` specialists in parallel against web, codebase, and prior memory. Synthesises and saves. |
| `/plan <description>` | Drafts a GitHub issue from your input — auto-classifies as bug/feature/epic/chore/spike, applies the right template, asks before creating. |
| `/work <issue#>` | Runs an issue end-to-end: feature branch → optional parallel worktrees → developer dispatches → **mandatory adversarial gate** → ops commits → PR → **six-pass code review** → CI watch → merge per `AGENTS.md` policy. |
| `/review [#PR \| path \| latest N]` | On-demand six-pass code review of a PR, file, directory, or the latest N PRs. Returns a deduplicated, precedence-merged verdict (APPROVED / ISSUES_FOUND / CRITICAL_ISSUES_FOUND). |

Plus two utility commands:

| Command | What it does |
|---|---|
| `/ensemble-model` | Interactive picker for per-role subagent models. Saves to `~/.pi/agent/ensemble-models.json`. |
| `/runs` | Browse recent subagent runs — drills into per-child transcripts with tool calls and findings. |
| `/ensemble-debug` | Show current resolved configuration: prompts dir, registered commands and tools, per-role model resolution. |

## Prerequisites

Required CLIs on `$PATH`. The role prompts assume all of these are installed — without them, the agents fail at runtime.

| Tool | Purpose | Install |
|---|---|---|
| [Pi](https://pi.dev) | The terminal coding agent this extends. | `bun add -g @earendil-works/pi-coding-agent` |
| [`bun`](https://bun.sh) | Runtime for the extension (loads TS via `jiti`). | `curl -fsSL https://bun.sh/install \| bash` |
| `git` ≥ 2.20 | Worktrees, branches, diffs. | OS package manager |
| [`gh`](https://cli.github.com/) | GitHub issue/PR/CI operations from inside `/work` and `/review`. | `brew install gh` |
| [`vipune`](https://github.com/randomm/vipune) | Cross-session memory (fact + observation patterns). All agents call this. | `cargo install vipune` |
| [`colgrep`](https://github.com/lightonai/next-plaid) | Semantic **code** search. Used to find existing implementations. | `curl --proto '=https' --tlsv1.2 -LsSf https://github.com/lightonai/next-plaid/releases/latest/download/colgrep-installer.sh \| sh` |
| [`oo`](https://github.com/randomm/oo) | Context-efficient wrapper for chatty CLIs (git, gh) used throughout the role prompts. | `cargo install double-o` |
| `jq` | Used by `build.sh` to assemble the capability matrix into the PM prompt. | `brew install jq` |
| [`parallel-cli`](https://docs.parallel.ai/cli/overview) | Web search / fetch / deep research used by the `explore` role. Optional but `/research` dispatches and any cross-web investigation expect it. | `brew install parallel-web/tap/parallel-cli` then `parallel-cli login` |

Tested on macOS; should work on Linux. Bun ≥ 1.1 and Node ≥ 22 (Pi's own requirement) are assumed.

After install, run `vipune version` once to initialise `~/.vipune/`, and `colgrep init $(pwd)` inside any project you plan to work in (the `/start` command does this for you on first use).

## Quickstart

```bash
git clone https://github.com/randomm/pi-ensemble.git
cd pi-ensemble
./install.sh
```

The installer builds the role prompts, symlinks the bundled skills into `~/.pi/agent/skills/`, installs the extension's deps, and registers the extension with Pi.

Verify:

```bash
cd ~/some/git/repo
pi
# in the Pi prompt:
> /ensemble-debug
# should list 8 slash commands, 4 tools, and the per-role model table.
```

## How it works

The parent `pi` you launch becomes the **project manager (PM)**. When you fire a registered slash command, the extension injects PM doctrine into the system prompt for that turn (one-shot, no global bleed). The PM then runs through the workflow body and calls tools to dispatch specialists.

Each **specialist** is a child `pi` process spawned with `pi --mode json -p --no-extensions --no-session --append-system-prompt <role.md>`. Six roles ship: `project-manager`, `developer`, `ops`, `explore`, `adversarial-developer`, `code-review-specialist`. Each has its own system prompt assembled from `agents-base/`, `modules/`, and `manifests/` via `build.sh`.

Tools:

| Tool | Purpose |
|---|---|
| `dispatch_specialist` | Single child spawn. |
| `dispatch_parallel` | Up to 10 concurrent children via `Promise.all`. |
| `adversarial_loop` | Mandatory pre-commit gate — adversarial reviewer with up to 3 rounds of fixes. |
| `dispatch_lens_review` | The six-pass code review — fans out six children, each pinned to its lens skill. Findings come back as native `report_finding` tool calls (schema-validated by Pi inside the child), get deduped by `(path, line, title)`, precedence-merged, and turned into a verdict. |

Per-child transcripts are saved to `~/.pi/agent/ensemble-runs/<date>/<runId>-<role>[-<tag>].json` — replay with `pi --session <path>` or browse via `/runs`.

## Configuring subagent models

You probably want a smarter model for the PM and a faster one for the specialists. The main agent (the `pi` you launch) is configured via Pi's own `--model` flag or settings. Subagents have a 5-layer resolution:

1. Per-call `model` field on a dispatch spec (highest)
2. `/ensemble-model` per-role choice (saved to `~/.pi/agent/ensemble-models.json`)
3. `/ensemble-model` all-subagents default (same file)
4. `PI_ENSEMBLE_MODEL_<ROLE>` env var (e.g. `PI_ENSEMBLE_MODEL_DEVELOPER`)
5. `PI_ENSEMBLE_SUBAGENT_MODEL` env var (global fallback for subagents)
6. Pi default (lowest)

Run `/ensemble-model` inside Pi to pick interactively from your authenticated provider catalog. Add new providers (Anthropic, GitHub Copilot, OpenAI, etc.) via Pi's `/login` — `pi-ensemble` picks them up automatically.

## Configuration & paths

| | Path |
|---|---|
| Extension entry | `extension/index.ts` |
| Slash-command bodies | `pi-prompts/*.md` |
| Per-role system prompts (built) | `dist/prompts/standard/<role>.md` |
| Source modules feeding the build | `modules/`, `manifests/`, `agents-base/`, `skill/`, `agents.json` |
| Skills (auto-installed) | `~/.pi/agent/skills/` |
| Run transcripts | `~/.pi/agent/ensemble-runs/<date>/` |
| Saved model config | `~/.pi/agent/ensemble-models.json` |
| Debug trace | set `PI_ENSEMBLE_DEBUG=1` to enable extension stderr probes |

## Customising the role prompts

The 28 modules under `modules/` (vipune memory patterns, output standards, async-task discipline, workflows, etc.) compose into per-role system prompts via `manifests/<role>.manifest`. To change behaviour for a role:

1. Edit the module (e.g. `modules/core/vipune-baseline.md`) or add a new one referenced in a manifest.
2. Run `bun run build` from the repo root.
3. Re-launch Pi — children pick up the new prompts on next spawn.

`pi-prompts/*.md` (slash-command bodies) are read at runtime — no rebuild needed.

## Caveats (alpha)

- **No per-role permission enforcement yet.** Specialists inherit Pi's default permissions; the role system prompt is the only thing keeping each in its lane. Use a sandbox repo until you've seen how the model behaves.
- **Cost.** Six-pass review on a typical PR is roughly 6 × ~2K tokens output per child plus context — order of `$0.02–$0.10` per cycle on cheap Cerebras models, more on Anthropic.
- **Worktrees are git CLI calls.** Will be migrated to the safer [`pi-worktree`](https://github.com/randomm/pi-worktree) plugin when its programmatic API stabilises.
- **Smoke tests live in `extension/smoke-tests/`.** `*-live.ts` files actually spawn Pi children and cost a few cents per run; CI runs only the offline ones.

## Pi compatibility

pi-ensemble depends on Pi's CLI flags, JSON event stream shape, and `ExtensionAPI` surface. The current release is tested against pi `0.75.3` and pins `@earendil-works/pi-coding-agent` to `~0.75.3` in `extension/devDependencies` so a Pi minor bump is a deliberate update.

When updating Pi:
1. Check the [pi-mono releases](https://github.com/badlogic/pi-mono/releases).
2. Bump the pin in `extension/package.json` and the "Tested against" line in [CHANGELOG.md](CHANGELOG.md).
3. Run the live smoke tests under `extension/smoke-tests/test-*-live.ts` against the new version — they exercise real child-process spawn, JSON event parsing, and tool-call extraction. CI runs offline tests only.

See [CONTRIBUTING.md](CONTRIBUTING.md) → "Pi compatibility" for the specific fields and flags we depend on.

## Acknowledgements

- [Pi](https://pi.dev) (`@earendil-works/pi-coding-agent`) by Mario Zechner — the terminal coding agent this extends.
- The modular prompt architecture, vipune doctrine, and six-lens code-review pattern originated in an [opencode](https://opencode.ai) configuration project.
- Sibling Pi extensions [`pi-worktree`](https://github.com/randomm/pi-worktree) and [`pi-permissions`](https://github.com/randomm/pi-permissions) — planned integration points for safer worktrees and per-role tool allowlists.

## License

Apache 2.0. See [LICENSE](LICENSE).
