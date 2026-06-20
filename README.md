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

The installer builds the role prompts, symlinks the bundled skills into `~/.pi/agent/skills/`, installs the extension's deps, registers the extension with Pi, **pulls the sandbox Docker image from `ghcr.io/randomm/pi-ensemble:latest`** (~10-20s on broadband; falls back to a local build if the pull fails), and symlinks the `pi-ensemble` wrapper into `~/.local/bin/`. Pass `--build` if you're iterating on the Dockerfile and want to force a local build; pass `--pull-only` to hard-fail when the registry is unreachable.

Verify (sandbox mode, recommended):

```bash
cd ~/some/git/repo
pi-ensemble
# pi launches inside a Docker container with PI_ENSEMBLE_SANDBOX_MODE=1.
# Zero permission prompts inside; vipune + transcripts bind-mounted from host.
> /ensemble-debug
# should list 9 slash commands, 9 tools, and the per-role model table.
```

Verify (host mode, legacy):

```bash
cd ~/some/git/repo
pi
# in the Pi prompt:
> /ensemble-debug
# uses the 3-tier permission system; expect interactive prompts on novel commands.
```

## Sandboxed mode (recommended)

`pi-ensemble` launches Pi inside a Docker container where the container fence IS the trust boundary — no per-call permission prompts. Host state that should survive across sessions is bind-mounted in; container-local caches use named volumes.

**What's mounted where:**

| Source on host | Target in container | Type | Purpose |
|---|---|---|---|
| `$PWD` (the project) | same absolute path | bind | Workspace. Mounted at the host's absolute path (not `/workspace`) so Pi's session-scope buckets match host-mode `pi`. |
| `~/.vipune/` | same | bind / volume fallback | Cross-session project memory. If host has none, a named volume `pi-ensemble-vipune` is used. |
| `~/.pi/agent/sessions/` | same | bind / volume fallback | Pi conversation sessions — drives `pi-ensemble -r`. |
| `~/.pi/agent/ensemble-runs/` | same | bind / volume fallback | Subagent transcripts (`/runs` slash command). |
| `~/.pi/agent/ensemble-models.json` | same | bind (ro) | pi-ensemble per-role model picks. |
| `~/.pi/agent/models.json` | same | bind (ro) | Pi PROVIDER config (anthropic / openai / local-gpu / fieldbox / etc.). |
| `~/.config/mcp/mcp.json` | same | bind (ro) | pi-mcp-adapter config (codebase-memory-mcp wiring + your other MCP servers). |
| `~/.config/gh/` | same | bind (ro) | gh CLI config (fallback; primary auth is `GH_TOKEN` extracted from `gh auth token` and forwarded as env). |
| — | `~/.cache/` | named volume `pi-ensemble-cache` | codebase-memory-mcp index, HF model cache. |
| — | `~/.bun/` | named volume `pi-ensemble-bun-cache` | bun download cache. |
| — | `~/.cargo/` | named volume `pi-ensemble-cargo-cache` | cargo download cache. |
| — | `/commandhistory` | named volume `pi-ensemble-history` | shell history. |

**Cross-mode persistence:** vipune memories, transcripts, sessions, model picks, MCP config, and gh auth all share state between host-mode `pi` and sandbox-mode `pi-ensemble` (same bind-mount targets, same Pi scope-bucket keys post-#207). Container-local caches (above) don't — they're container-scoped and survive container restarts via named volumes, but the host runs against its own caches.

**Wrapper subcommands:**

| Command | What it does |
|---|---|
| `pi-ensemble` | Interactive `pi` session in the container (default) |
| `pi-ensemble -r` | `pi -r` passthrough — resume a previous sandbox session for this project (see note on cross-mode resume below) |
| `pi-ensemble shell` | Drop into bash inside the container |
| `pi-ensemble rebuild` | Rebuild the pi-ensemble image (after pulling new pi-ensemble code) |
| `pi-ensemble stop` | Stop all running containers for this project (multi-session safe) |
| `pi-ensemble prune` | Remove sandbox caches (bind-mounted host state is NOT touched) |
| `pi-ensemble logs` | Tail container logs (errors with a name list if multiple sessions are running) |
| `pi-ensemble status` | Show all running containers for this project |

> **Multiple concurrent sessions.** Each `pi-ensemble` invocation gets its own container (per-invocation random suffix on the name). You can run several sessions in the same project simultaneously — e.g., long-form work in one terminal, a quick investigation in another. Bind-mounted state (`sessions/`, vipune, `models.json`) is concurrency-safe at the storage layer. `pi-ensemble stop` stops them all; `pi-ensemble status` lists them all.

> **Session resume note.** Pi scopes sessions by absolute project path. The same project at `~/projects/foo` on the host mounts at `/workspace` inside the container, so host-mode `pi -r` sessions and sandbox-mode `pi-ensemble -r` sessions live in different scope buckets and don't cross-resume — even though both modes share `~/.pi/agent/sessions/` via bind-mount. Within a single mode, resume works as expected.

**Why a sandbox.** Models emit novel command shapes constantly — chained pipes, new git subcommands, novel paths. Gating every call with a yes/no prompt produces ~30 prompts/minute, which trains users to rubber-stamp and degrades attention on prompts that DO matter (anti-protection). Sandbox mode moves the trust boundary from per-call gating to the container fence: full filesystem isolation from the host, all tools allowed inside. The image bakes in every CLI the role prompts assume on `$PATH` (Pi, bun, node, git, gh, vipune, oo, codebase-memory-mcp, ctx7).

**What v1 does NOT include.** The container has unrestricted network egress for v1. A follow-up (see issues) adds an init-firewall.sh + `--cap-add=NET_ADMIN` allowlist for `api.anthropic.com`, `github.com`, npm/pypi/crates.io, parallel.ai, ctx7. Until then, the sandbox protects your filesystem but not your network.

**Symlink-traversal mitigation.** Even Anthropic's reference devcontainer had a symlink-traversal escape (CVE-2026-39861, fixed Apr 2026). pi-ensemble ships with `extension/src/sandbox-fs-guard.ts` that canonicalizes any filesystem path argument and rejects ones pointing outside `/workspace`.

**Host mode is still available.** `pi` continues to work for users who don't have Docker, prefer the legacy UX, or are iterating on pi-ensemble itself. Per-call permission gating is OFF in interactive host mode by default — when pi-ensemble runs as your own UID outside a sandbox, there is no agent-tool-layer gate that can meaningfully constrain a misbehaving subagent (it has the same FS / network / credential access as you). The honest position: you trust the agent, or you don't run it. Set `PI_ENSEMBLE_STRICT_PERMISSIONS=1` to restore the legacy ask-flow if you actively want prompts back. Headless mode (`pi -p`) still hard-denies novel commands — no human to consent means the deny is meaningful.

**Reaching hosts that live on your mesh network / LAN.** The container's resolver doesn't see Mesh VPN mesh DNS or your `/etc/hosts`. If you've registered an OpenAI-compatible LLM gateway at `http://fieldbox:8080` (or similar) in your `~/.pi/agent/models.json`, the wrapper teaches the container's resolver via `--add-host` so the hostname works inside. The default registration covers `fieldbox:192.0.2.10`. Override or extend via env:

```bash
PI_ENSEMBLE_HOST_ALIASES="fieldbox:192.0.2.10,myserver:192.0.2.20" pi-ensemble
```

Comma-separated `name:ip` pairs. The IPs must be reachable from the host (the container's network rides the host's stack via Docker bridge); Mesh VPN-only hostnames work as long as your host can route to the mesh network IP.

**Drag-and-drop images.** Pi uses `@<path>` to attach a file as multimodal input — e.g. `@/Users/you/Downloads/screenshot.png describe this`. Dragging an image into the terminal pastes its absolute path; **you then type `@` in front of the pasted path yourself** (the terminal doesn't add it). Without the `@` prefix, Pi treats the path as plain text in the prompt and never attaches the bytes.

Typical flow: drag image → cursor lands after the pasted path → press `Home` (or `Ctrl-A`) to jump to line start → type `@` → submit. The wrapper bind-mounts `$HOME/Downloads`, `$HOME/Desktop`, and `$HOME/Pictures` read-only at their host absolute paths and tells `sandbox-fs-guard` to permit reads under those roots via `PI_ENSEMBLE_ALLOWED_ROOTS`, so the path the terminal pastes resolves inside the container. A vision-capable model (Claude / GPT-4o / Qwen3.6-35B / Gemma-4 / etc.) then sees the image.

Add or replace image dirs via env:

```bash
# Add (keeps default + appends)
PI_ENSEMBLE_EXTRA_IMAGE_DIRS="$HOME/Documents/screenshots" pi-ensemble

# Replace entirely
PI_ENSEMBLE_IMAGE_DIRS="$HOME/work-images" pi-ensemble
```

For your provider to actually use the image, `~/.pi/agent/models.json` must mark the model as multimodal: `"input": ["text", "image"]`. Built-in providers (Anthropic / OpenAI / Google) know vision capabilities natively; custom OpenAI-compatible providers (e.g. fieldbox's Qwen3.6) need the explicit hint.

**Docker-based MCP servers and SSH work transparently.** Two capabilities that exist on the host carry through to the sandbox by default — you don't set a flag for them:

- **Docker socket** — if Docker is running on the host, `/var/run/docker.sock` is bind-mounted into the sandbox. MCP servers in `.pi/mcp.json` that launch via `docker run` Just Work; spawned containers are sibling containers on the host's daemon (not nested), visible in your host's `docker ps`.
- **SSH** — `~/.ssh/` is bind-mounted read-only and the host's `$SSH_AUTH_SOCK` (if set) is forwarded. Inside the sandbox, `ssh remote-host` uses the same identities as host-mode pi.

**Security trade-off (named explicitly):** the docker socket grants root-equivalent host access from inside the sandbox; SSH agent access lets the sandbox impersonate any identity loaded in your agent. Both weaken the container-fence-as-trust-boundary story (#200 / #215). Consistent with pi-ensemble's design: the sandbox is the agent's runtime, not the user's security boundary. Opt out with `PI_ENSEMBLE_NO_DOCKER_SOCKET=1` and/or `PI_ENSEMBLE_NO_SSH=1` if you want the tighter sandbox (docker-based MCPs / outbound SSH stop working under these opt-outs).

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

#### `command:` portability between host and sandbox

The same `~/.config/mcp/mcp.json` is read by both host-mode `pi` and sandbox-mode `pi-ensemble` (the wrapper bind-mounts the host file into the container). For server entries to work in BOTH contexts, use **PATH-relative `command:` values** — a bare binary name or `npx -y <package>`. Node's `spawn` resolves non-absolute `command:` values via `$PATH` at MCP-spawn time, so the same entry resolves to `~/.local/bin/foo` on host and `/usr/local/bin/foo` (or wherever) inside the sandbox.

```jsonc
// ✅ Portable — works on host AND in sandbox
{ "command": "codebase-memory-mcp" }
{ "command": "npx", "args": ["-y", "@anthropic/some-mcp"] }

// ❌ Host-only — fails inside the sandbox (path doesn't exist there)
{ "command": "/Users/dev/.local/bin/codebase-memory-mcp" }
```

If a server's binary doesn't exist inside the sandbox container, you have two options: extend `.devcontainer/Dockerfile` to install it, or scope that server to host-mode only by placing the entry in `~/.pi/agent/mcp.json` (Tier 2) and adding it to the bind-mount exclude list in `bin/pi-ensemble`.

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
| (no env var) | settings.json `retry.provider.timeoutMs` | `install.sh` writes a 3-min default into `~/.pi/agent/settings.json` (#236). Healthy LLM calls return in seconds; 3 min detects provider hangs fast while leaving headroom. Edit settings.json directly to tune; idempotent — install.sh preserves existing values. |
| `PI_ENSEMBLE_RUNS_KEEP_LAST` | `20` | How many recent subagent transcript batches to keep on disk; older ones auto-prune. Set to `0` to disable pruning. |
| `PI_ENSEMBLE_DEBUG` | unset | Set to `1` for verbose stderr trace from the extension. |
| `PI_ENSEMBLE_SUBAGENT_MODEL` | unset | Global fallback model for all subagents (see "Configuring subagent models"). |
| `PI_ENSEMBLE_SUBAGENT_PROVIDER` | unset | Optional Pi provider name paired with `PI_ENSEMBLE_SUBAGENT_MODEL` — required for custom OpenAI-compatible providers whose model IDs don't carry a built-in provider prefix. |
| `PI_ENSEMBLE_MODEL_<ROLE>` | unset | Per-role model override (e.g. `PI_ENSEMBLE_MODEL_DEVELOPER`). Uppercase, `-` → `_`. |
| `PI_ENSEMBLE_PROVIDER_<ROLE>` | unset | Per-role provider override, paired with the corresponding `_MODEL_` var. Same naming rule. |
| `PI_ENSEMBLE_DISABLE_EXTENSION_FORWARD` | unset | Set to `1` to opt out of auto-forwarding installed extensions to subagents (subagents inherit nothing — disables pi-claude-auth, MCP bridges, etc.). |
| `PI_ENSEMBLE_USER_EXTENSION` | unset | Absolute path or `npm:<pkg>` ref of an extra extension to forward to subagents, on top of the auto-discovered list. |
| `PI_ENSEMBLE_AUTOSAVE` | unset | Set to `1` to opt into a deterministic session summary written to `vipune` on session quit ([#23](https://github.com/randomm/pi-ensemble/issues/23)). Pure local extract — no LLM call. Off by default. |

**Sandbox mode (`pi-ensemble` wrapper):**

| Variable | Set by | Purpose |
|---|---|---|
| `PI_ENSEMBLE_SANDBOX_MODE` | wrapper / devcontainer.json | `1` inside container; the parent + subagent permission guards short-circuit and treat the container fence as the trust boundary. |
| `PI_ENSEMBLE_WORKSPACE_ROOT` | wrapper | Absolute host path mounted into the container as the workspace. `sandbox-fs-guard.ts` reads it to enforce out-of-workspace FS access (#207). |
| `PI_ENSEMBLE_HOST_ALIASES` | user | Comma-separated `name:ip` pairs the wrapper passes as `--add-host`. Default: `fieldbox:192.0.2.10`. Use to teach the container's resolver about Mesh VPN / LAN hostnames not in DNS. |
| `PI_ENSEMBLE_EXTRA_ENV` | user (deprecated) | Pre-#228 escape hatch for forwarding specific env vars. No longer needed — the wrapper now forwards the **entire host shell env** by default (less a small conflict-blocklist; see below). Kept as a no-op so existing shell rc lines don't break. |
| `PI_ENSEMBLE_DISABLE_SUBAGENT_GUARD` | user (debugging) | `1` disables the subagent permission-broker socket. Redundant in sandbox / interactive host where the guard already short-circuits; meaningful only under `PI_ENSEMBLE_STRICT_PERMISSIONS=1`. |
| `PI_ENSEMBLE_STRICT_PERMISSIONS` | user (host mode) | `1` restores the legacy per-call ask-flow in interactive host mode. Default OFF — pi-ensemble does not enforce per-call permissions in interactive host mode (no real boundary exists; prompts are theatre at runtime volumes). Use this only if you want prompts back. |
| `PI_ENSEMBLE_TRUST_MODE` | internal (spawn.ts) | `1` propagated from parent to subagent when parent is in trust mode. Mirror of `PI_ENSEMBLE_SANDBOX_MODE` for the interactive-host case. Not a user-facing knob. |
| `PI_ENSEMBLE_NO_DOCKER_SOCKET` | user (opt-out) | `1` skips the default docker-socket bind-mount. By default the wrapper mounts `/var/run/docker.sock` so `.pi/mcp.json` docker-based MCPs Just Work; setting this disables that. Grants root-equivalent host access in the default-on case — weakens the sandbox fence. |
| `PI_ENSEMBLE_NO_SSH` | user (opt-out) | `1` skips the default `~/.ssh/` bind-mount + `SSH_AUTH_SOCK` forwarding. By default the wrapper makes `ssh remote-host` work inside the sandbox the same way it does on host. Setting this disables outbound SSH from the sandbox. |
| `GH_TOKEN` / `GITHUB_TOKEN` | host shell, or wrapper | If set on host, forwarded directly. If unset, wrapper extracts via `gh auth token` (handles macOS Keychain). Container's `gh` reads it for auth. |
| **All host env vars** | host shell | Forwarded into the sandbox by default (post-#228). Matches host-mode `pi`'s env-inheritance. `.pi/mcp.json` env-refs (`${VAR}` / `{env:VAR}`) work identically inside and outside the sandbox. **Blocklist:** `PATH`, `HOME`, `SHELL`, `PWD`, `OLDPWD`, `USER`, `LOGNAME`, `TMPDIR`/`TEMP`/`TMP`, `SHLVL`, `_`, `MAIL`, `HOSTNAME`, `SSH_AUTH_SOCK` (container's own), plus pattern matches `LC_*`, `PI_ENSEMBLE_*`, `BASH_FUNC_*`, `__*`. Empty values skipped. |
| `PARALLEL_API_KEY` | host shell | Forwarded via the wholesale host-env passthrough. Required for @explore's web research via `parallel-cli` (baked into the sandbox image). Without it, @explore's `parallel-cli search` returns an auth error. |
| `PI_ENSEMBLE_IMAGE_DIRS` | user | Colon-separated list of host dirs to bind-mount RO for image drag-and-drop (`@file` syntax). Default: `$HOME/Downloads:$HOME/Desktop:$HOME/Pictures`. Replaces default if set. |
| `PI_ENSEMBLE_EXTRA_IMAGE_DIRS` | user | Colon-separated host dirs to APPEND to the image-dir list (keeps the default). Use to add e.g. `~/Documents/screenshots`. |
| `PI_ENSEMBLE_ALLOWED_ROOTS` | wrapper | Colon-separated allowed roots for `sandbox-fs-guard` beyond the workspace. Auto-populated from the image-dir list so dragged images aren't blocked. |
| `PI_ENSEMBLE_DECK_MAX_ROWS` | user | Maximum rows shown in the live dispatch deck (the in-flight subagent footer). Default: `20`. The deck bypasses Pi's built-in 10-row widget cap via the factory-form `setWidget` so two-batch lens-reviews (~14 rows) fit cleanly. Lower it (`=15`) for a tighter footer, raise it (`=50`) to never get clipped, set to `999` for effectively unlimited. |

Advanced (internal path overrides; rarely needed): `PI_ENSEMBLE_DIR`, `PI_ENSEMBLE_PROMPTS_DIR`, `PI_ENSEMBLE_PI_PROMPTS_DIR`, `PI_ENSEMBLE_PM_PROMPT`, `PI_ENSEMBLE_MODELS_CONFIG`, `PI_ENSEMBLE_RUNS_DIR`, `PI_ENSEMBLE_SKILLS_DIR` — override default file/directory locations.

`PI_ENSEMBLE_ROLE` is set internally by `spawn.ts` for subagent processes; do not set it manually.

## Customising the role prompts

The 28 modules under `modules/` (vipune memory patterns, output standards, async-task discipline, workflows, etc.) compose into per-role system prompts via `manifests/<role>.manifest`. To change behaviour for a role:

1. Edit the module (e.g. `modules/core/vipune-baseline.md`) or add a new one referenced in a manifest.
2. Run `bun run build` from the repo root.
3. Re-launch Pi — children pick up the new prompts on next spawn.

`pi-prompts/*.md` (slash-command bodies) are read at runtime — no rebuild needed.

## Caveats (alpha)

- **Three permission modes.** **Sandbox** (recommended): container fence IS the trust boundary; no per-call gating. **Interactive host**: also no per-call gating by default — when the agent runs as your UID outside a sandbox, there's no agent-tool-layer gate that can constrain it meaningfully (same FS / network / creds as you); per-call prompts at runtime volumes are theatre. **Headless** (`pi -p`) or **`PI_ENSEMBLE_STRICT_PERMISSIONS=1`**: 3-tier allow/deny/ask policy applies (`agents.json` baseline + `~/.pi/agent/permissions.json` global overlay + `$PWD/.pi/permissions.json` project overlay). Headless hard-denies on ask (no human to consent); strict-opt-in prompts as before. Use sandbox for confined execution; use interactive host when you trust the agent; use headless or strict-opt-in for automation / paranoia.
- **Cost.** Six-pass review on a typical PR is roughly 6 × ~2K tokens output per child plus context — order of `$0.02–$0.10` per cycle on cheap Cerebras models, more on Anthropic.
- **Worktrees are git CLI calls.** Will be migrated to the safer [`pi-worktree`](https://github.com/randomm/pi-worktree) plugin when its programmatic API stabilises.
- **Smoke tests live in `extension/smoke-tests/`.** `*-live.ts` files actually spawn Pi children and cost a few cents per run; CI runs only the offline ones.

## Pi compatibility

pi-ensemble depends on Pi's CLI flags, JSON event stream shape, and `ExtensionAPI` surface. The current sandbox image ships pi `0.79.1`; the host-mode dev-deps pin `@earendil-works/pi-coding-agent` to `~0.75.3` so a Pi minor bump is a deliberate update.

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
