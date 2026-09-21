# Sandboxed mode (recommended)

`pi-rukas` launches Pi inside a Docker container with no per-call permission prompts — see the threat model note below for what the container fence does and does not contain. Host state that should survive across sessions is bind-mounted in; container-local caches use named volumes. This is the recommended mode; host-mode `pi` remains available without Docker.

> **Threat model.** If your threat model is a compromised or prompt-injected subagent, the default sandbox does NOT contain it (docker.sock = root-on-host, unrestricted egress, full env forwarding). To make the container fence the trust boundary: opt out of the passthroughs (`PI_ENSEMBLE_NO_DOCKER_SOCKET=1` + `PI_ENSEMBLE_NO_SSH=1`) **and** strip forwarded secrets — env forwarding has only a static blocklist (PATH, HOME, etc.), so `unset` the credentials before launching (e.g. `GH_TOKEN`, provider API keys, `SSH_AUTH_SOCK` if not needed). Alternatively run in a network-restricted environment.

**What's mounted where:**

| Source on host | Target in container | Type | Purpose |
|---|---|---|---|
| `$PWD` (the project) | same absolute path | bind | Workspace. Mounted at the host's absolute path (not `/workspace`) so Pi's session-scope buckets match host-mode `pi`. |
| `~/.vipune/` | same | bind / volume fallback | Cross-session project memory. If host has none, a named volume `pi-ensemble-vipune` is used. |
| `~/.pi/agent/sessions/` | same | bind / volume fallback | Pi conversation sessions — drives `pi-rukas -r`. |
| `~/.pi/agent/ensemble-runs/` | same | bind / volume fallback | Subagent transcripts (`/runs` slash command). |
| `~/.pi/agent/ensemble-models.json` | same | bind (ro) | pi-rukas per-role model picks. |
| `~/.pi/agent/models.json` | same | bind (ro) | Pi PROVIDER config (anthropic / openai / trailopeners / halo / etc.). |
| `~/.config/mcp/mcp.json` | same | bind (ro) | pi-mcp-adapter config (codebase-memory-mcp wiring + your other MCP servers). |
| `~/.config/gh/` | same | bind (ro) | gh CLI config (fallback; primary auth is `GH_TOKEN` extracted from `gh auth token` and forwarded as env). |
| — | `~/.cache/` | named volume `pi-ensemble-cache` | codebase-memory-mcp index, HF model cache. |
| — | `~/.bun/` | named volume `pi-ensemble-bun-cache` | bun download cache. |
| — | `~/.cargo/` | named volume `pi-ensemble-cargo-cache` | cargo download cache. |
| — | `/commandhistory` | named volume `pi-ensemble-history` | shell history. |

**Cross-mode persistence:** vipune memories, transcripts, sessions, model picks, MCP config, and gh auth all share state between host-mode `pi` and sandbox-mode `pi-rukas` (same bind-mount targets, same Pi scope-bucket keys post-#207). Container-local caches (above) don't — they're container-scoped and survive container restarts via named volumes, but the host runs against its own caches.

**Wrapper subcommands:**

| Command | What it does |
|---|---|
| `pi-rukas` | Interactive `pi` session in the container (default) |
| `pi-rukas -r` | `pi -r` passthrough — resume a previous sandbox session for this project (see note on cross-mode resume below) |
| `pi-rukas shell` | Drop into bash inside the container |
| `pi-rukas rebuild` | Rebuild the pi-rukas image (after pulling new pi-rukas code) |
| `pi-rukas stop` | Stop all running containers for this project (multi-session safe) |
| `pi-rukas prune` | Remove sandbox caches (bind-mounted host state is NOT touched) |
| `pi-rukas logs` | Tail container logs (errors with a name list if multiple sessions are running) |
| `pi-rukas status` | Show all running containers for this project |

> **Multiple concurrent sessions.** Each `pi-rukas` invocation gets its own container (per-invocation random suffix on the name). You can run several sessions in the same project simultaneously — e.g., long-form work in one terminal, a quick investigation in another. Bind-mounted state (`sessions/`, vipune, `models.json`) is concurrency-safe at the storage layer. `pi-rukas stop` stops them all; `pi-rukas status` lists them all.

> **Session resume note.** Pi scopes sessions by absolute project path. The same project at `~/projects/foo` on the host mounts at `/workspace` inside the container, so host-mode `pi -r` sessions and sandbox-mode `pi-rukas -r` sessions live in different scope buckets and don't cross-resume — even though both modes share `~/.pi/agent/sessions/` via bind-mount. Within a single mode, resume works as expected.

**Why a sandbox.** Models emit novel command shapes constantly — chained pipes, new git subcommands, novel paths. Gating every call with a yes/no prompt produces ~30 prompts/minute, which trains users to rubber-stamp and degrades attention on prompts that DO matter (anti-protection). Sandbox mode moves the trust boundary from per-call gating to the container fence (see the threat model note above for what the fence does and does not contain), all tools allowed inside. The image bakes in every CLI the role prompts assume on `$PATH` (Pi, bun, node, git, gh, vipune, oo, codebase-memory-mcp, ctx7).

**What v1 does NOT include.** The container has unrestricted network egress for v1. A follow-up (see issues) adds an init-firewall.sh + `--cap-add=NET_ADMIN` allowlist for `api.anthropic.com`, `github.com`, npm/pypi/crates.io, parallel.ai, ctx7. Until then, the sandbox protects your filesystem but not your network.

**Symlink-traversal mitigation.** Even Anthropic's reference devcontainer had a symlink-traversal escape (CVE-2026-39861, fixed Apr 2026). pi-rukas ships with `extension/src/sandbox-fs-guard.ts` that canonicalizes any filesystem path argument and rejects ones pointing outside `/workspace`.

**Host mode is still available.** `pi` continues to work for users who don't have Docker, prefer the legacy UX, or are iterating on pi-rukas itself. Per-call permission gating is OFF in interactive host mode by default — when pi-rukas runs as your own UID outside a sandbox, there is no agent-tool-layer gate that can meaningfully constrain a misbehaving subagent (it has the same FS / network / credential access as you). The honest position: you trust the agent, or you don't run it. Set `PI_ENSEMBLE_STRICT_PERMISSIONS=1` to restore the legacy ask-flow if you actively want prompts back. Headless mode (`pi -p`) still hard-denies novel commands — no human to consent means the deny is meaningful.

**Reaching hosts that live on your tailnet / LAN.** The container's resolver doesn't see Tailscale MagicDNS or your `/etc/hosts`. If you've registered an OpenAI-compatible LLM gateway at `http://halo:8080` (or similar) in your `~/.pi/agent/models.json`, the wrapper teaches the container's resolver via `--add-host` so the hostname works inside. The default registration covers `halo:192.168.8.249`. Override or extend via env:

```bash
PI_ENSEMBLE_HOST_ALIASES="halo:192.168.8.249,llm-box:10.0.0.7" pi-rukas
```

Comma-separated `name:ip` pairs. The IPs must be reachable from the host (the container's network rides the host's stack via Docker bridge); Tailscale-only hostnames work as long as your host can route to the tailnet IP.

**Drag-and-drop images.** Pi uses `@<path>` to attach a file as multimodal input — e.g. `@/Users/you/Downloads/screenshot.png describe this`. Dragging an image into the terminal pastes its absolute path; **you then type `@` in front of the pasted path yourself** (the terminal doesn't add it). Without the `@` prefix, Pi treats the path as plain text in the prompt and never attaches the bytes.

Typical flow: drag image → cursor lands after the pasted path → press `Home` (or `Ctrl-A`) to jump to line start → type `@` → submit. The wrapper bind-mounts `$HOME/Downloads`, `$HOME/Desktop`, and `$HOME/Pictures` read-only at their host absolute paths and tells `sandbox-fs-guard` to permit reads under those roots via `PI_ENSEMBLE_ALLOWED_ROOTS`, so the path the terminal pastes resolves inside the container. A vision-capable model (Claude / GPT-4o / Qwen3.6-35B / Gemma-4 / etc.) then sees the image.

Add or replace image dirs via env:

```bash
# Add (keeps default + appends)
PI_ENSEMBLE_EXTRA_IMAGE_DIRS="$HOME/Documents/screenshots" pi-rukas

# Replace entirely
PI_ENSEMBLE_IMAGE_DIRS="$HOME/work-images" pi-rukas
```

For your provider to actually use the image, `~/.pi/agent/models.json` must mark the model as multimodal: `"input": ["text", "image"]`. Built-in providers (Anthropic / OpenAI / Google) know vision capabilities natively; custom OpenAI-compatible providers (e.g. halo's Qwen3.6) need the explicit hint.

**Docker-based MCP servers and SSH work transparently.** Two capabilities that exist on the host carry through to the sandbox by default — you don't set a flag for them:

- **Docker socket** — if Docker is running on the host, `/var/run/docker.sock` is bind-mounted into the sandbox. MCP servers in `.pi/mcp.json` that launch via `docker run` Just Work; spawned containers are sibling containers on the host's daemon (not nested), visible in your host's `docker ps`.
- **SSH** — `~/.ssh/` is bind-mounted read-only and the host's `$SSH_AUTH_SOCK` (if set) is forwarded. Inside the sandbox, `ssh remote-host` uses the same identities as host-mode pi.

**Security trade-off (named explicitly):** the docker socket grants root-equivalent host access from inside the sandbox; SSH agent access lets the sandbox impersonate any identity loaded in your agent. Both weaken the container-fence-as-trust-boundary story (#200 / #215). Consistent with pi-rukas's design: the default sandbox is the agent's runtime, not the user's security boundary — the opt-out configuration described above restores the fence. Opt out with `PI_ENSEMBLE_NO_DOCKER_SOCKET=1` and/or `PI_ENSEMBLE_NO_SSH=1` if you want the tighter sandbox (docker-based MCPs / outbound SSH stop working under these opt-outs).

