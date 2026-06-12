# pi-ensemble

[![CI](https://github.com/randomm/pi-ensemble/actions/workflows/ci.yml/badge.svg)](https://github.com/randomm/pi-ensemble/actions/workflows/ci.yml)
[![License](https://img.shields.io/badge/License-Apache_2.0-blue.svg)](LICENSE)

A multi-specialist orchestrator extension for [Pi](https://pi.dev) — the terminal AI coding agent. Spawns role-specialised child Pi processes in parallel, isolates them in git worktrees, runs a mandatory adversarial gate before commit, and gates merge on a six-pass code review (security, error handling, type safety, performance, architecture, simplicity).

> **Status: alpha.** The interfaces work and the workflow runs end-to-end, but the API will change before `1.0`. Use on disposable repos until you've kicked the tires. Tested against pi `0.75.3`.

## What you get

Five slash commands, an orchestrator-shaped system prompt, and nine tools that drive parallel specialist agents:

| Command | What it does |
|---|---|
| `/start` | Initialises a project session — searches memory, indexes the codebase, gathers git/PR/CI state, reports readiness. |
| `/research <topic>` | Fans out multiple `explore` specialists in parallel against web, codebase, and prior memory. Synthesises and saves. |
| `/plan <description>` | Drafts a GitHub issue from your input — auto-classifies as bug/feature/epic/chore/spike, applies the right template, asks before creating. |
| `/work <issue#>` | Runs an issue end-to-end: feature branch → optional parallel worktrees → developer (via `dispatch_specialist`) → `adversarial_loop` gate → ops commits → PR → **six-pass code review** → CI watch → merge per project policy. |
| `/review [#PR \| path \| latest N]` | On-demand six-pass code review of a PR, file, directory, or the latest N PRs. Returns a deduplicated, precedence-merged verdict (APPROVED / ISSUES_FOUND / CRITICAL_ISSUES_FOUND). |
| `/audit [<path> \| "full"]` | Standards-first repo/path audit. Derives expectations from docs/config/CI/memory/examples, then reports misalignments across bugs, dead code, style drift, architecture drift, and quality-gate gaps. |

Plus two utility commands:

| Command | What it does |
|---|---|
| `/ensemble-model` | Interactive picker for per-role subagent models. Saves to `~/.pi/agent/ensemble-models.json`. |
| `/runs` | Browse recent subagent runs — drills into per-child transcripts with tool calls and findings. |
| `/ensemble-debug` | Show current resolved configuration: prompts dir, registered commands and tools, per-role model resolution. |

## When to use which command

| Command | When to use | Scope | Standard source | Memory behavior |
|---|---|---|---|---|
| `/start` | Beginning of a session: load context, check state | Project repo | N/A (informational) | Reads only (no writes) |
| `/research <topic>` | Investigate a topic: web + codebase + memory | Any topic | N/A (informational) | Saves results as fact/observation |
| `/plan <description>` | Draft a GitHub issue | N/A (creates issue) | N/A | No memory writes |
| `/work <issue#>` | Execute an issue: implement → review → merge | Feature branch | Universal quality lenses (via `/review`) | Subagents may write to memory |
| `/review [#PR \| path \| latest]` | Evaluate code against universal quality lenses | PR, file, dir, or codebase | Six review lenses (SECURITY/ERROR/TYPES/PERF/ARCH/SIMPLICITY) | Does not write to memory |
| `/audit [<path> \| "full"]` | Audit repo/path against its own intended standards | Repo or scoped path | Derived from docs, config, CI, memory, examples | Sparse, durable stores only (critical/high findings, conventions, architecture, aggregated drift) |

**Quick rule of thumb**:
- Need to learn about something? Use `/research`.
- Need to fix something? Use `/work`.
- Need to check code quality before merging? Use `/review`.
- Need to assess overall repo health and standards alignment? Use `/audit`.

## Prerequisites

Required CLIs on `$PATH`. The role prompts assume all of these are installed — without them, the agents fail at runtime.

| Tool | Purpose |
|---|---|
| [Pi](https://pi.dev) | The terminal coding agent this extends. |
| [`bun`](https://bun.com) | Runtime for the extension (loads TS via `jiti`). |
| `git` ≥ 2.20 | Worktrees, branches, diffs. |
| [`gh`](https://cli.github.com/) | GitHub issue / PR / CI ops from inside `/work` and `/review`. |
| [`vipune`](https://github.com/randomm/vipune) | Cross-session memory (fact + observation patterns). All agents call this. |
| [`codebase-memory-mcp`](https://github.com/DeusData/codebase-memory-mcp) | Persistent knowledge-graph code indexer exposed as MCP. Powers `codebase_memory_search_code` / `trace_path` / `detect_changes` / `get_architecture` — pre-approved on the read-heavy roles. |
| [`oo`](https://github.com/randomm/oo) | Context-efficient wrapper for chatty CLIs (git, gh). |
| `jq` | Used by `build.sh` to assemble the capability matrix into the PM prompt. |
| [`parallel-cli`](https://docs.parallel.ai/cli/overview) | Web search / fetch / deep research used by the `explore` role. `/research` and cross-web investigation depend on it. |
| [`ctx7`](https://context7.com) | Current third-party library documentation. Specialists run `ctx7 library <name>` → `ctx7 docs <id> <query>` to verify API shape. Free tier works without login. |

### Supply-chain setup (recommended one-time before installing)

Most prerequisites below install from npm or other public registries. Recent supply-chain attacks (compromised maintainer publishes a malicious version, caught and yanked within hours) make a release-age embargo worth setting up **once, globally**:

```bash
# npm — applies to all `npm install -g …` from now on
npm config set min-release-age 4d                                 # requires npm ≥ 11.10.0

# bun — applies to project-local `bun add` (global ~/.bunfig.toml is currently
# silently ignored by `bun add`, see oven-sh/bun#30748; project-local works)
# extension/bunfig.toml in THIS repo already sets minimumReleaseAge = 345600
```

This means the install commands below will refuse to fetch any version published in the last 4 days — protecting against the most common attack window. Skip this step if you accept the risk; the install instructions still work without it.

We also recommend `--ignore-scripts` on every npm install (Pi's [own quickstart](https://pi.dev/docs/latest/quickstart) recommends it) to disable postinstall hooks — another common supply-chain vector.

### Install commands

Copy-pasteable. All installs use the latest version your package manager allows (with the embargo above, "latest" means ≥4 days old).

```bash
# Pi (per https://pi.dev/docs/latest/quickstart)
npm install -g --ignore-scripts @earendil-works/pi-coding-agent

# bun (≥ 1.2.20)
curl -fsSL https://bun.com/install | bash

# git, gh, jq — your OS package manager
brew install git gh jq                                                # macOS
# sudo apt install git gh jq                                          # Debian/Ubuntu

# vipune, oo — cargo from source (Rust toolchain required)
cargo install vipune
cargo install double-o

# codebase-memory-mcp (REQUIRED — pi-ensemble's code-search doctrine depends on it)
curl -fsSL https://raw.githubusercontent.com/DeusData/codebase-memory-mcp/main/install.sh | bash
# Installs the C binary at ~/.local/bin/codebase-memory-mcp (~250 MB; ships
# embedded Nomic embeddings — no API keys needed). pi-ensemble's install.sh
# will register it with pi-mcp-adapter automatically (see step "After install"
# below — no manual MCP config edits required).

# parallel-cli
brew install parallel-web/tap/parallel-cli
parallel-cli login

# ctx7
npm install -g --ignore-scripts ctx7
```

After install:

- `vipune version` once to initialise `~/.vipune/`.
- Run pi-ensemble's `./install.sh` from this repo. That script detects `codebase-memory-mcp` on your `PATH` (or in `~/.local/bin/`) and writes a `codebase_memory` entry to `~/.config/mcp/mcp.json` for pi-mcp-adapter to pick up. **You should not have to hand-edit any MCP config.** Re-running `./install.sh` is safe (idempotent merge — other MCP servers you configured by hand are preserved). Verify after `pi` restarts with `/mcp` — should list `codebase_memory` with 7 direct tools (`search_code`, `search_graph`, `trace_path`, `detect_changes`, `get_code_snippet`, `get_architecture`, `query_graph`).
- One-shot index every project the first time pi opens there:
  ```
  mcp({tool: "codebase_memory_index_repository", args: '{"repo_path": "."}'})
  ```
  The `/start` command does this for you on first use. The file watcher keeps it current after that. Indexed data lives in `~/.cache/codebase-memory-mcp/`.

Tested on macOS; should work on Linux. Bun ≥ 1.2.20 and Node ≥ 22 (Pi's own requirement) are assumed.

If you're security-conscious, you can also defer `ctx7` entirely; the `explore` role tries to call it but the rest of pi-ensemble works without it. The `developer` and `code-review-specialist` roles also benefit from current library docs.

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
# should list 9 slash commands, 9 tools, and the per-role model table.
```

## How it works

The parent `pi` you launch becomes the **project manager (PM)**. When you fire a registered slash command, the extension injects PM doctrine into the system prompt for that turn (one-shot, no global bleed). The PM then runs through the workflow body and calls tools to dispatch specialists.

Each **specialist** is a child `pi` process spawned with `pi --mode rpc --no-extensions --session <transcript> --append-system-prompt <role.md>`. `--mode rpc` keeps stdin open for JSON command injection — the initial prompt is sent as a `{ type: "prompt", message }` RPC command, and the same channel carries mid-flight `{ type: "steer", message }` injections from `dispatch_steer`. Six roles ship: `project-manager`, `developer`, `ops`, `explore`, `adversarial-developer`, `code-review-specialist`. Each has its own system prompt assembled from `agents-base/`, `modules/`, and `manifests/` via `build.sh`.

Tools (all async via push-callback — tools return a `{ jobId }` immediately; the final report arrives later as an `[ensemble:async]` user message):

| Tool | Purpose |
|---|---|
| `dispatch_specialist` | Spawn exactly ONE specialist (developer / ops / explore / adversarial-developer / code-review-specialist). |
| `dispatch_parallel` | Fan out 2-10 specialists in parallel; ONE consolidated report arrives when all complete. |
| `adversarial_loop` | Encapsulated 3-round review-then-fix gate. Takes the developer's diff, runs an adversarial review, spawns a fresh developer to address any findings, re-reviews; up to 3 rounds. The mandatory adversarial gate before any commit. |
| `dispatch_lens_review` | Six-pass code review — fans out six children, each pinned to its lens skill. Findings come back as native `report_finding` tool calls (schema-validated by Pi inside the child), deduped by `(path, line, title)`, precedence-merged, turned into a verdict. |
| `dispatch_status` | List in-flight async jobs (jobId, role, elapsed). Metadata only — never transcript content. |
| `dispatch_kill <jobId>` | Abort a running subagent or batch. |
| `dispatch_peek <jobId>` | Bounded, read-only introspection of a running subagent — last assistant text + last tool call ([#21](https://github.com/randomm/pi-ensemble/issues/21)). |
| `dispatch_steer <jobId> <message>` | Inject a mid-flight steer into a running subagent via Pi's `--mode rpc` stdin channel — for exceptional rescue only (long-elapsed, stuck-looking) ([#152](https://github.com/randomm/pi-ensemble/issues/152)). |
| `check_review_cap <key>` | Wall-clock cap helper for `/work` Step 7 fix loop — returns ok/exceeded against a 90-min budget so the PM stops doom-loops ([#4](https://github.com/randomm/pi-ensemble/issues/4)). |

Per-child transcripts are saved to `~/.pi/agent/ensemble-runs/<date>/<runId>-<role>[-<tag>].json` — replay with `pi --session <path>` or browse via `/runs`. The user inspects these; orchestrating agents do NOT read them (the dispatch tool's report is the bounded summary by design).

## Configuring subagent models

You probably want a smarter model for the PM and a faster one for the specialists. The main agent (the `pi` you launch) is configured via Pi's own `--model` flag or settings. Subagent model choice is **user-authority-only** — the orchestrating agent cannot route a dispatch to a different provider on its own (see [#92](https://github.com/randomm/pi-ensemble/issues/92): jurisdiction routing is a data-residency / compliance decision, not an agent concern). Resolution order:

1. `/ensemble-model` per-role choice (saved to `~/.pi/agent/ensemble-models.json`)
2. `/ensemble-model` all-subagents default (same file)
3. `PI_ENSEMBLE_MODEL_<ROLE>` env var (e.g. `PI_ENSEMBLE_MODEL_DEVELOPER`), optionally paired with `PI_ENSEMBLE_PROVIDER_<ROLE>` for custom OpenAI-compatible providers
4. `PI_ENSEMBLE_SUBAGENT_MODEL` env var (global fallback for subagents), optionally paired with `PI_ENSEMBLE_SUBAGENT_PROVIDER`
5. Pi default (lowest)

Run `/ensemble-model` inside Pi to pick interactively from your authenticated provider catalog. Add new built-in providers (Anthropic, GitHub Copilot, OpenAI, etc.) via Pi's `/login` — `pi-ensemble` picks them up automatically.

### Adding a custom OpenAI-compatible provider

For self-hosted vLLM, an internal LLM endpoint, or any third-party OpenAI Chat-Completions–compatible API, register it once in Pi's own config and `pi-ensemble` will route subagents through it like any other provider.

**Step 1 — register the provider in `~/.pi/agent/models.json`** (create the file if it doesn't exist; merge with existing `providers` block if it does):

```jsonc
{
  "providers": {
    "my-vllm": {
      "api": "openai-completions",
      "baseUrl": "https://llm.example.com/v1",
      "apiKey": "$MY_LLM_KEY",
      "models": [
        {
          "id": "vendor/model-name",
          "name": "Friendly Display Name",
          "reasoning": true,
          "input": ["text"],
          "cost": { "input": 0, "output": 0, "cacheRead": 0, "cacheWrite": 0 },
          "contextWindow": 262144,
          "maxTokens": 32768,
          "compat": {
            "thinkingFormat": "qwen-chat-template",
            "supportsReasoningEffort": false,
            "maxTokensField": "max_tokens"
          }
        }
      ]
    }
  }
}
```

Compat flags worth knowing:
- `thinkingFormat: "qwen-chat-template"` — for vLLM servers running `--reasoning-parser qwen3`; Pi sends `chat_template_kwargs.enable_thinking` instead of the OpenAI-style `reasoning_effort` field. Omit if your endpoint is non-reasoning.
- `supportsReasoningEffort: false` — most open-weight reasoning models are binary on/off, not tiered.
- `maxTokensField: "max_tokens"` — classic OpenAI naming; vLLM expects this rather than the newer `max_completion_tokens`.
- `cost: { zeros }` — internal/free endpoints; Pi's usage reporter still tracks tokens but won't multiply by a per-token rate.

**Step 2 — store the API key.** Pick whichever option fits your security posture:

- **1Password CLI** — store the credential in 1Password, then in `models.json`: `"apiKey": "!op read 'op://Private/<vault-item>/credential'"` (Pi re-executes the reference on each request)
- **Env var** — `export MY_LLM_KEY="..."` in your shell rc, then `"apiKey": "$MY_LLM_KEY"`
- **Plaintext** — paste the key directly into the `apiKey` field. Pi creates `models.json` with `0600` perms; fine for personal machines, not for shared hosts

**Step 3 — use it.** Three ways depending on how broadly you want it applied:

- *Main agent only*: `pi --provider my-vllm --model "vendor/model-name"` — or set it as the default in `~/.pi/agent/settings.json`:
  ```json
  { "defaultProvider": "my-vllm", "defaultModel": "vendor/model-name" }
  ```
- *Main agent for one specific project*: drop the same `defaultProvider`/`defaultModel` snippet into `./.pi/settings.json` at the project root. Pi reads project-local config and overrides the user-global default when invoked from there.
- *Subagents*: run `/ensemble-model` inside Pi — the custom provider appears under its own section in the picker. Pick a role + model and the choice persists as `{provider, model}` in `~/.pi/agent/ensemble-models.json`. Alternatively set `PI_ENSEMBLE_PROVIDER_<ROLE>=my-vllm` + `PI_ENSEMBLE_MODEL_<ROLE>=vendor/model-name` per role, or the `PI_ENSEMBLE_SUBAGENT_*` pair for all subagents.

`pi-ensemble` passes `--provider <name>` ahead of `--model <id>` to each spawned subagent when a provider is configured, so Pi disambiguates the model ID against your registered providers rather than only its built-in catalog.

## Using MCP servers (per-host or per-project)

Pi has no built-in Model Context Protocol support — MCP is provided by a bridge extension. pi-ensemble's job is to forward that bridge to subagents and to gate access per role. Two independent layers are at play:

1. **Which MCP servers exist** — owned by the bridge (e.g. [`pi-mcp-adapter`](https://github.com/nicobailon/pi-mcp-adapter)). The bridge merges its own 4-tier config; project-local files override host-global ones.
2. **Which pi-ensemble role may reach them** — owned by pi-ensemble's permission overlay. 3-tier merge; project-local files override host-global ones.

### Step 1 — Install the bridge

```bash
pi install npm:pi-mcp-adapter
```

`pi install` drops the bridge into `~/.pi/agent/extensions/`, where pi-ensemble's auto-forward picks it up for subagents automatically. Bridges installed outside the canonical location can be added via `PI_ENSEMBLE_USER_EXTENSION=<abs-path or npm:ref>`.

### Step 2 — Define MCP servers (bridge config, 4 tiers)

`pi-mcp-adapter` merges these in ascending precedence — **project files win**:

| Tier | Path | Scope |
|---|---|---|
| 1 | `~/.config/mcp/mcp.json` | Cross-tool global (shared with claude-code/cursor/etc.) |
| 2 | `~/.pi/agent/mcp.json` | Pi-global on this host |
| 3 | `./.mcp.json` | Project (cross-tool) |
| 4 | `./.pi/mcp.json` | Project, Pi-specific — **highest precedence** |

The bridge also supports an `imports` array that auto-adopts servers already configured for Claude Code, Cursor, VS Code, Windsurf, Claude Desktop, Codex. See the [pi-mcp-adapter docs](https://github.com/nicobailon/pi-mcp-adapter) for the full JSON schema.

> **codebase-memory-mcp is wired automatically by `./install.sh`.** It writes a `codebase_memory` entry to `~/.config/mcp/mcp.json` (Tier 1) with selective `directTools` exposing the seven read-side tools (`search_code`, `search_graph`, `trace_path`, `detect_changes`, `get_code_snippet`, `get_architecture`, `query_graph`). Admin tools (`index_repository`, `delete_project`, `manage_adr`) stay behind the proxy `mcp` tool. Re-running `./install.sh` is safe — other MCP servers you've configured by hand are preserved (idempotent jq merge). See "Prerequisites" above for the binary install.

#### Tool-surface modes: `directTools`

Each server entry can set `"directTools": true | false`. This controls how the bridge surfaces tools to Pi — and therefore what the permission prompt asks about:

| Mode | What Pi sees | First-call prompt covers |
|---|---|---|
| `directTools: false` *(default)* | One gateway tool literally named `mcp` | Everything that bridge ever does (single Allow/Deny) |
| `directTools: true` | Each MCP tool registered as a top-level Pi tool named `<server_snake_case>_<tool>` (kebab→snake, then `_<tool>`) | Each tool individually — finer-grained audit trail |

Example: a server named `staging-db` with `directTools: true` and a `list_schemas` MCP tool surfaces in Pi as `staging_db_list_schemas`. With `directTools: false`, the same call goes via `mcp({server: "staging-db", tool: "list_schemas", args: …})`.

Either mode works with the ask-by-default prompt UX described below — pick based on how much per-tool granularity you want in your `$PWD/.pi/decisions.json` audit trail. Read-only safety (e.g. `--access-mode=restricted` for `crystaldba/postgres-mcp`) is enforced at the MCP server level regardless of the surface mode.

### Step 3 — Grant role access (pi-ensemble permission overlay, 3 tiers)

The shipped baseline gives **project-manager** an "ask-by-default" catch-all (`"*": "ask"`) — so the first call to any tool that isn't on an explicit allow- or deny-list (the `mcp` gateway, per-server direct tools like `<server>_<action>`, etc.) prompts you:

> `Allow once / Allow always / Deny once / Deny always`

Choosing **"Allow always"** persists the decision to `$PWD/.pi/decisions.json` — **per-project**, automatically. Other projects on the host still prompt on their first call. No host-wide opt-in by accident. This matches the Claude-Code-style permission UX users expect.

Headless mode (no UI) hard-denies every `"ask"` verdict, so CI/automation is unchanged. Bash commands with injection vectors (`&&`, `|`, `$(...)`, redirects) are still hard-denied at the matcher level — they never reach the prompt.

For finer control (narrower wildcards, host-wide overrides, role overrides), the resolver checks three tiers in order — **first match wins, project beats host**:

| Tier | Path | Scope |
|---|---|---|
| 1 | `$PWD/.pi/permissions.json` | Per-project (highest precedence) |
| 2 | `~/.pi/agent/permissions.json` | Per-host |
| 3 | `<pi-ensemble repo>/agents.json` | Shipped baseline (this is what `mcp*: ask` lives in) |

Per-project example — grant `mcp` to developer in *this* project only, while leaving the host default unchanged:

```json
// ~/projects/v10r/.pi/permissions.json
{
  "developer": {
    "permission": {
      "mcp*": "allow"
    }
  }
}
```

Wildcard precedence (`permission-guard.ts:lookupPermission`): exact match → longest prefix wildcard → catch-all `"*"`. So `"mcp__safe__*": "allow"` beats `"mcp*": "ask"` beats `"*": "deny"`.

### Security notes

- Read-only guarantees for database access must come from the MCP server's own credentials (restricted DB user, read-only role). pi-ensemble gates *who can call the tool*, not *what the tool can do*.
- Subagents are spawned with `--no-extensions`, so pi-ensemble's permission interceptor doesn't run inside them — only role prompts constrain. The bridge IS still forwarded (so subagents have MCP access), but the deny doesn't fire in-child. If you don't want a role calling MCP, omit the grant from the role's prompt doctrine and from any project/global overlay; the subagent simply won't have a reason to call it.
- `PI_ENSEMBLE_DISABLE_EXTENSION_FORWARD=1` opts out of auto-forwarding entirely (subagents inherit nothing — disables pi-claude-auth, MCP bridges, etc.). `PI_ENSEMBLE_USER_EXTENSION` is independent of this flag; when set, that one extension is always forwarded.

## Configuration & paths

| | Path |
|---|---|
| Extension entry | `extension/index.ts` |
| Slash-command bodies | `pi-prompts/*.md` |
| Per-role system prompts (built) | `dist/prompts/standard/<role>.md` (generated by `./install.sh` / `bun run build`; gitignored) |
| Source modules feeding the build | `modules/`, `manifests/`, `agents-base/`, `skill/`, `agents.json` |
| Skills (auto-installed) | `~/.pi/agent/skills/` |
| Run transcripts | `~/.pi/agent/ensemble-runs/<date>/` |
| Saved model config | `~/.pi/agent/ensemble-models.json` |

## Environment variables

All optional. Defaults are reasonable for typical use.

| Variable | Default | Purpose |
|---|---|---|
| `PI_ENSEMBLE_QUIET_STATUS` | unset | Set to `1` to disable the live dispatch deck — one footer status row per in-flight subagent ([#117](https://github.com/randomm/pi-ensemble/issues/117)). |
| `PI_ENSEMBLE_QUIET_LIFECYCLE` | unset | Set to `1` to disable scrollback lifecycle markers (`▸ ensemble: dispatched / ✓ finished / ✗ failed`) ([#118](https://github.com/randomm/pi-ensemble/issues/118)). |
| `PI_ENSEMBLE_SPAWN_TIMEOUT_MS` | `1800000` (30 min) | Hard wall-clock cap per spawned subagent. Operator/CI override — not settable by the agent. |
| `PI_ENSEMBLE_RUNS_KEEP_LAST` | `20` | How many recent subagent transcript batches to keep on disk; older ones auto-prune. Set to `0` to disable pruning. |
| `PI_ENSEMBLE_DEBUG` | unset | Set to `1` for verbose stderr trace from the extension. |
| `PI_ENSEMBLE_SUBAGENT_MODEL` | unset | Global fallback model for all subagents (see "Configuring subagent models"). |
| `PI_ENSEMBLE_SUBAGENT_PROVIDER` | unset | Optional Pi provider name paired with `PI_ENSEMBLE_SUBAGENT_MODEL` — required for custom OpenAI-compatible providers whose model IDs don't carry a built-in provider prefix. |
| `PI_ENSEMBLE_MODEL_<ROLE>` | unset | Per-role model override (e.g. `PI_ENSEMBLE_MODEL_DEVELOPER`). Uppercase, `-` → `_`. |
| `PI_ENSEMBLE_PROVIDER_<ROLE>` | unset | Per-role provider override, paired with the corresponding `_MODEL_` var. Same naming rule. |
| `PI_ENSEMBLE_DISABLE_EXTENSION_FORWARD` | unset | Set to `1` to opt out of auto-forwarding installed extensions to subagents (subagents inherit nothing — disables pi-claude-auth, MCP bridges, etc.). |
| `PI_ENSEMBLE_USER_EXTENSION` | unset | Absolute path or `npm:<pkg>` ref of an extra extension to forward to subagents, on top of the auto-discovered list. |
| `PI_ENSEMBLE_AUTOSAVE` | unset | Set to `1` to opt into a deterministic session summary written to `vipune` on session quit ([#23](https://github.com/randomm/pi-ensemble/issues/23)). Pure local extract — no LLM call. Off by default. |

Advanced (internal path overrides; rarely needed): `PI_ENSEMBLE_DIR`, `PI_ENSEMBLE_PROMPTS_DIR`, `PI_ENSEMBLE_PI_PROMPTS_DIR`, `PI_ENSEMBLE_PM_PROMPT`, `PI_ENSEMBLE_MODELS_CONFIG`, `PI_ENSEMBLE_RUNS_DIR`, `PI_ENSEMBLE_SKILLS_DIR` — override default file/directory locations.

`PI_ENSEMBLE_ROLE` is set internally by `spawn.ts` for subagent processes; do not set it manually.

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
