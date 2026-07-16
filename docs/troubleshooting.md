# pi-ensemble troubleshooting

Symptoms → causes → fixes. Most issues here come from running an older sandbox image; the first move on anything weird is usually `./install.sh` from the pi-ensemble repo to rebuild + refresh.

## Subagent silently "finished" but the worktree wasn't touched

### Symptom

PM dispatches a subagent (developer / explore / ops); the `[ensemble:async]` report comes back looking normal — "Subagent finished — N turns, Tm Ts" with what reads like a final assistant message (e.g. *"Step 1: Read sweep_stats.rs"*). PM proceeds as if work was done. You arrive at the desk and find `git status` clean, no commits, no PR — the agent never actually wrote anything.

### Cause

The provider HTTP request hung mid-stream. pi-ai turned the timeout into a synthetic assistant message with `stopReason: "error"` and empty content. Pre-#236 the dispatch report treated that as a normal completion and displayed the agent's last successful thinking block as if it were the final reply. Pi's default HTTP timeout is ~10 minutes (provider SDK default), so a degraded provider could burn 4 retry attempts × 10 min = 40 min before failing — and the failure looked like a success.

This is **independent of the LLM backend**: across recent runs, Anthropic Claude Sonnet 4.6 and Cerebras `zai-glm-4.7` produced this failure roughly equally.

### Fix

```bash
cd ~/.config/opencode/pi-ensemble && git pull && ./install.sh
```

Post-#236, `install.sh` writes sensible `retry.provider` defaults into `~/.pi/agent/settings.json` (3 min per request, 3 retries with backoff). Healthy LLM calls return in seconds; 3 min is well above p99 of healthy traffic but tight enough to detect hangs fast. If you have non-default settings you want to keep, they're preserved — install.sh only writes the retry block when it's missing.

The dispatch report also now distinguishes the failure mode visually:

- Header: `Subagent \`developer\` (job X) FAILED-PROVIDER-ERROR — N turns, Tm Ts`
- Body prefix: *"Provider request error: \<errorMessage\>. Last text below is the agent's pre-failure activity — VERIFY DIRECTLY before assuming progress."*
- Scrollback line: `▸ ensemble: ⚠ developer terminated mid-stream — provider request error, see report`

PM treats `FAILED-PROVIDER-ERROR` as a failed dispatch per existing doctrine (routes through the cap-hit handoff from #233), so you'll see the `needs-human-attention` label and PR comment when you check.

### Tuning

If 3 min is too tight for your provider (some heavy thinking on Sonnet's `-Opus`-tier with very long context can legitimately take 60-120 s, and you'd want headroom), edit `~/.pi/agent/settings.json` directly:

```json
{
  "retry": {
    "provider": {
      "timeoutMs": 300000,    // 5 min per request
      "maxRetries": 3,
      "maxRetryDelayMs": 60000
    }
  }
}
```

Keep `maxRetries * timeoutMs` comfortably below pi-ensemble's 30-min wall-clock cap (`DEFAULT_SPAWN_TIMEOUT_MS`); otherwise retries get truncated.

PR: [#236](https://github.com/randomm/pi-ensemble/pull/236)

## Permissions

### Host-mode pi-ensemble is asking me to approve every command

**Symptom:** Running `pi` (host mode, no sandbox) in an interactive terminal: every novel bash / tool call prompts "Allow once / Allow always / Deny once / Deny always". Within a few minutes, dozens of prompts. Unusable.

**Cause:** You have `PI_ENSEMBLE_STRICT_PERMISSIONS=1` set in your shell rc. Trust-mode (no per-call prompts in interactive host) is the default; strict-mode is opt-in.

**Fix:** Unset the var.

```bash
# Check
env | grep PI_ENSEMBLE_STRICT_PERMISSIONS

# Remove from your shell rc (~/.zshrc, ~/.bashrc, etc.) then:
unset PI_ENSEMBLE_STRICT_PERMISSIONS
exec $SHELL -l   # re-source rc
```

Relaunch `pi` — no more prompts. The agent runs as your UID with your credentials; that's the deal in interactive host mode. Use `pi-ensemble` (sandbox) if you want confined execution.

PR: [#215](https://github.com/randomm/pi-ensemble/pull/215)

### Headless `pi -p` hard-denies all novel commands

**Symptom:** `pi -p "do something"` in a script / CI returns immediately with "Tool 'bash' requires approval (no UI available)" for any command not in the role's allowlist.

**Cause:** Headless mode (no TTY) preserves the legacy strict ask-flow with no human to consent → hard-deny. This is deliberate safety: silent rubber-stamping in automation contexts would be worse than failing closed.

**Fix:** Either (a) widen the allowlist in `.pi/permissions.json` for that project, (b) run inside the sandbox where there's no per-call gating, or (c) if you genuinely need an unrestricted automated run, prepend `PI_ENSEMBLE_SANDBOX_MODE=1 pi -p ...` — but understand this disables ALL guard layers and should ONLY be used in a context already sandboxed by other means (Docker, VM).

PR: [#215](https://github.com/randomm/pi-ensemble/pull/215)

## Image acquisition

### `./install.sh` takes 10+ minutes (cold local build)

**Symptom:** Running `./install.sh` on a fresh host (or after `docker system prune`) takes 10-30 minutes. Output shows `cargo install vipune`, `cargo install double-o`, `npm install -g ...`, the Rust toolchain compiling.

**Cause:** You're on an `install.sh` from before #219 — pre-#219 the script always built the image locally. Post-#219 it pulls a pre-built multi-arch image from `ghcr.io/randomm/pi-ensemble:latest` (built + published on every merge to main).

**Fix:** Pull the latest pi-ensemble repo + rerun install.

```bash
cd ~/.config/opencode/pi-ensemble && git pull && ./install.sh
```

The pull should finish in ~10-20s on broadband. If it falls back to a local build, see the next entry.

PR: [#219](https://github.com/randomm/pi-ensemble/pull/219)

### `docker pull ghcr.io/randomm/pi-ensemble:latest` returns `denied`

**Symptom:** `./install.sh` reports `Pull failed; building locally from this checkout instead.` Inside that pull attempt: `Error response from daemon: denied`.

**Cause:** The GHCR package is private. By default, GHCR packages start private until the repo owner flips them to public.

**Fix (if you own the repo):** GitHub → Profile → Packages → `pi-ensemble` → Package settings → Change visibility → Public.

**Fix (if you don't own the repo, but have a GitHub account):** Authenticate to GHCR with a personal access token that has `read:packages`.

```bash
gh auth token | docker login ghcr.io -u USERNAME --password-stdin
./install.sh
```

PR: [#219](https://github.com/randomm/pi-ensemble/pull/219)

### Forcing a local build (Dockerfile development)

**When:** You're iterating on `.devcontainer/Dockerfile` and want to test changes before they're merged + republished.

**How:** Pass `--build` to install.sh.

```bash
./install.sh --build
```

Skips the registry pull, builds directly from your checkout. Takes 10-30 minutes cold; uses Docker layer cache on subsequent runs.

## Sandbox launch

### `MCP: 0/N servers` — codebase_memory not connected

**Symptom:** Inside `pi-ensemble`, the bottom status line shows `MCP: 0/1 servers` (or 0/N). `/mcp` reports no servers connected. Subagents fail any `codebase_memory_*` tool call.

**Cause:** pi-mcp-adapter reads `~/.config/mcp/mcp.json` (Tier 1). `install.sh` writes this file with the codebase_memory entry, but if you never ran `./install.sh` (or ran it before pi-ensemble shipped this wiring), the file is missing or empty.

**Fix:** `cd ~/.config/opencode/pi-ensemble && ./install.sh`. Validate with `jq '.mcpServers | keys' ~/.config/mcp/mcp.json` — should list `codebase_memory`. Restart the sandbox.

PR: [#196](https://github.com/randomm/pi-ensemble/pull/196)

### `gh issue list` returns "HTTP 401: Requires authentication" inside container

**Symptom:** Inside `pi-ensemble`, `gh` commands that hit the GitHub API return 401. Outside the container on the host, the same commands work fine.

**Cause:** macOS `gh auth login` stores the token in Keychain, not in `~/.config/gh/hosts.yml`. The container's bind-mount of `~/.config/gh/` brings the config dir but not the keychain-stored token.

**Fix:** The wrapper extracts the token via `gh auth token` on the host and forwards it as `GH_TOKEN` env into the container. If you're seeing 401, check the host: `gh auth status` should report you authenticated. If you're using a personal access token directly, export it as `GH_TOKEN` in your shell so the wrapper forwards it explicitly.

PR: [#203](https://github.com/randomm/pi-ensemble/pull/203)

### Custom LLM endpoint (e.g. `fieldbox`) returns "connection refused" or "no such host"

**Symptom:** A custom provider (configured in `~/.pi/agent/models.json` with `baseUrl: "http://fieldbox:8080/v1"`) works from host-mode `pi` but fails inside `pi-ensemble`.

**Cause:** The container's resolver doesn't see your `/etc/hosts`, Mesh VPN mesh DNS, or your home network. The hostname `fieldbox` doesn't resolve.

**Fix:** Set `PI_ENSEMBLE_HOST_ALIASES` before launching:

```bash
PI_ENSEMBLE_HOST_ALIASES="fieldbox:192.0.2.10,myserver:192.0.2.20" pi-ensemble
```

Comma-separated `name:ip` pairs. The IP must be reachable from the host (the container's network rides the host's stack via Docker bridge).

Default already includes `fieldbox:192.0.2.10` — set the var if your fieldbox is elsewhere or you need additional hosts.

PR: [#204](https://github.com/randomm/pi-ensemble/pull/204)

### Custom provider missing from `/ensemble-model` picker

**Symptom:** `/ensemble-model` inside sandbox shows fewer providers than `/ensemble-model` outside. Your `local-gpu`, `fieldbox`, or other custom provider is missing.

**Cause:** Wrapper bind-mounts `~/.pi/agent/models.json:ro` (post-#205). If you're on an older wrapper version, custom providers aren't visible inside the container.

**Fix:** `./install.sh` from pi-ensemble repo to refresh the wrapper. If after that the provider's API requests fail with `401`, check that the api key env var is exported in your shell rc — post-#228 the wrapper forwards the full host shell env, so any exported var (regardless of name) reaches the container.

PR: [#205](https://github.com/randomm/pi-ensemble/pull/205), [#228](https://github.com/randomm/pi-ensemble/pull/228)

### `MCP error -32000: Connection closed` for env-driven docker MCPs

**Symptom:** `.pi/mcp.json` defines an MCP server like `docker run -i --rm -e DATABASE_URI crystaldba/postgres-mcp` with `"env": { "DATABASE_URI": "${SOME_DB_URI}" }`. Works on host-mode `pi`; fails in `pi-ensemble` with `MCP error -32000: Connection closed`. The MCP server process exits within milliseconds.

**Diagnose (inside the sandbox):**

```bash
env | grep SOME_DB_URI   # is the var even visible inside?
```

If empty: the var isn't reaching the sandbox.

**Cause:** Pre-#228 the wrapper only forwarded a curated env subset (`*_API_KEY` / `*_LLM_KEY` patterns + explicit list). Vars referenced in `.pi/mcp.json` env-refs (`${VAR}` / `{env:VAR}`) had to be explicitly listed in `PI_ENSEMBLE_EXTRA_ENV`. pi-mcp-adapter interpolated them against the sandbox's env, got empty strings, spawned `docker run -e DATABASE_URI=""`, and the postgres-mcp container exited on invalid URI.

**Fix:** Refresh.

```bash
cd ~/.config/opencode/pi-ensemble && git pull && ./install.sh
```

Post-#228 the wrapper forwards the entire host shell env (less a small conflict-blocklist — see README env-vars table). Any var you `export` in your shell rc reaches the sandbox. Verify post-refresh: `pi-ensemble shell` → `echo "$SOME_DB_URI"` prints the URI.

PR: [#228](https://github.com/randomm/pi-ensemble/pull/228)

### `vipune search` returns "Failed to download embedding model … 404"

**Symptom:** Inside `pi-ensemble`, `vipune search` errors with `Configuration error: Failed to download embedding model 'BAAI/bge-small-en-v1.5': request error: http status: 404`. Suggests `huggingface-cli download …`.

**Cause:** vipune downloads the embedding model on first semantic-search call. Its HTTP client 404s on the pinned revision (URLs work via `curl` — likely a redirect/User-Agent quirk).

**Fix:** The image pre-fetches the model into `/opt/hf-cache-seed/` and the entrypoint seeds the named cache volume from there on first start. If you're seeing the 404, your image is stale: `./install.sh` to rebuild. Verify the seed is present:

```bash
docker run --rm randomm/pi-ensemble:latest ls /opt/hf-cache-seed/hub/models--BAAI--bge-small-en-v1.5/snapshots
```

Should list the pinned revision SHA.

PR: [#205](https://github.com/randomm/pi-ensemble/pull/205)

### "fd not found. Downloading..." / "ripgrep not found. Downloading..." at startup

**Symptom:** First few lines after `pi-ensemble` boot show Pi auto-downloading `fd` and `rg` into `~/.pi/agent/bin/`. Adds ~10s of boot time + requires network.

**Cause:** Image is stale (pre-#203). Modern image bakes both binaries in via apt.

**Fix:** `./install.sh` to rebuild. Verify: `docker run --rm randomm/pi-ensemble:latest which fd rg` → `/usr/local/bin/fd` + `/usr/bin/rg`.

PR: [#203](https://github.com/randomm/pi-ensemble/pull/203)

## Docker-based MCP servers

### `MCP: Failed to connect to <name>: spawn docker ENOENT` or `MCP error -32000: Connection closed`

**Symptom:** Project-level MCP servers configured in `.pi/mcp.json` with `command: "docker"` fail to connect inside the sandbox. Host-mode `pi` works fine. Pre-#216 the error was `spawn docker ENOENT` (docker CLI missing); pre-#220 it was `MCP error -32000: Connection closed` (CLI present, no socket mounted by default).

**Cause:** Stale wrapper / image. Post-#220 the docker socket is bind-mounted by default — no env-var flag needed.

**Fix:** Refresh.

```bash
cd ~/.config/opencode/pi-ensemble && git pull && ./install.sh
```

Then relaunch `pi-ensemble` (no env vars) and `/mcp` should show the docker-based MCP servers connected. Spawned MCP containers are siblings on the host's daemon — visible in the host's `docker ps`.

PR: [#220](https://github.com/randomm/pi-ensemble/pull/220)

### `docker: permission denied while trying to connect to the Docker daemon socket`

**Symptom:** Docker socket is mounted but `docker ps` inside the sandbox returns "permission denied".

**Cause:** The entrypoint's `chmod 666 /var/run/docker.sock` didn't fire — likely an outdated image (pre-#216 entrypoint runs as `vscode`, can't chmod a root-owned socket).

**Fix:** Rebuild the image.

```bash
cd ~/.config/opencode/pi-ensemble && ./install.sh
```

Verify post-rebuild: `pi-ensemble shell` → `ls -la /var/run/docker.sock` shows `srw-rw-rw-`.

PR: [#216](https://github.com/randomm/pi-ensemble/pull/216)

### I want a tighter sandbox — disable docker socket access

**Symptom:** You want the pre-#220 isolation where the sandbox can't talk to the host docker daemon.

**Cause:** Docker socket grants root-equivalent host access from inside the sandbox (any process can mount host paths, launch privileged containers, etc.). The default-on behavior accepts this trade-off; the opt-out is for users who don't.

**Fix:**

```bash
export PI_ENSEMBLE_NO_DOCKER_SOCKET=1
```

Note: docker-based MCPs in `.pi/mcp.json` will stop working under this opt-out.

PR: [#220](https://github.com/randomm/pi-ensemble/pull/220)

## SSH from inside the sandbox

### `ssh remote-host` fails with "Permission denied (publickey)" or "Error connecting to agent"

**Symptom:** Agents inside the sandbox can't `ssh` to remote hosts that work on the host. `ssh-add -l` returns one of:
- *"Could not open a connection to your authentication agent"* — no agent at all
- *"Error connecting to agent: Permission denied"* — the forwarded agent socket exists but isn't usable

Outbound `ssh` then fails with `Permission denied (publickey,...)` even though you have working keys on the host.

**Cause:** Two sub-cases:

1. **Stale wrapper (pre-#220).** The wrapper didn't bind-mount `~/.ssh/` or forward `$SSH_AUTH_SOCK`. Fix: `cd ~/.config/opencode/pi-ensemble && git pull && ./install.sh`.
2. **Broken agent forward (pre-#227).** Wrapper attempted the forward but Docker created an empty **directory** at `/run/host-ssh-auth.sock` instead of a usable socket — common on macOS Docker Desktop where the host's `$SSH_AUTH_SOCK` is a launchd-managed path Docker can't bind-mount cleanly. SSH then loops on "Error connecting to agent" even though on-disk keys at `~/.ssh/` would work. **Post-#227 the entrypoint detects this and unsets `SSH_AUTH_SOCK`** so SSH falls back to your on-disk keys cleanly. Refresh with `./install.sh`.

**Diagnose your case (inside the sandbox):**

```bash
echo "SSH_AUTH_SOCK=${SSH_AUTH_SOCK:-<unset>}"
ls -la "${SSH_AUTH_SOCK:-/dev/null}" 2>&1   # should show `srw-` (socket); `drwx` = broken bind-mount
ls -la ~/.ssh/                              # on-disk keys + known_hosts + config
```

**Fix:**

```bash
cd ~/.config/opencode/pi-ensemble && git pull && ./install.sh
```

Then relaunch `pi-ensemble`. Inside, `ssh-add -l` either lists your forwarded identities (working forward) or reports "Could not open a connection to your authentication agent" CLEANLY (broken forward → fell back to disk keys). `ssh remote-host` should succeed via one path or the other.

**If you have no SSH agent running on the host:** start one before launching pi-ensemble so a forwardable agent socket exists:

```bash
eval "$(ssh-agent -s)"
ssh-add ~/.ssh/id_ed25519   # or whichever key
pi-ensemble
```

**On-disk keys + UID mismatch (macOS edge case):** the wrapper mounts `~/.ssh/` RO so keys are visible inside, BUT SSH's `StrictModes` may refuse keys whose host UID (501 on macOS) doesn't match the container's vscode UID (1000). Workaround: use ssh-agent (above) — the agent socket bypasses file-perm checks.

**Last-resort manual recipe (pre-refresh or weird host env):** explicit key, bypass any broken agent.

```bash
ssh -o IdentityAgent=none -i ~/.ssh/<your-key> user@host
```

PRs: [#220](https://github.com/randomm/pi-ensemble/pull/220), [#227](https://github.com/randomm/pi-ensemble/pull/227)

### I want a tighter sandbox — disable SSH credentials access

**Symptom:** You want the sandbox to have no SSH identities — neither `~/.ssh/` keys nor agent forwarding.

**Cause:** SSH agent forwarding lets the sandboxed agent impersonate any identity loaded in your host agent (push to remotes, ssh into prod boxes, etc.). The default-on behavior accepts this trade-off; opt out if you don't.

**Fix:**

```bash
export PI_ENSEMBLE_NO_SSH=1
```

Note: outbound SSH from inside the sandbox will stop working — including agent operations that ssh to remotes (e.g. `git push` over ssh, deploy scripts).

PR: [#220](https://github.com/randomm/pi-ensemble/pull/220)

## Web research

### @explore agents are `curl`-scraping web pages instead of using `parallel-cli`

**Symptom:** `dispatch_peek` on a running @explore agent shows it `curl`-ing random pricing/blog pages. Long turn counts (30+) burning hundreds of thousands of tokens. Often returns hallucinated or stale data because pages dynamically render.

**Cause:** The image is stale — pre-#218 the sandbox didn't install `parallel-cli`. Without it, @explore's `parallel-cli search` returns `command not found` and the agent falls back to bare `curl` page-scraping (slow, bot-blocked, often wrong).

**Fix:** Rebuild the image.

```bash
cd ~/.config/opencode/pi-ensemble && ./install.sh
```

Verify post-rebuild: `pi-ensemble shell` → `which parallel-cli` returns a path; `parallel-cli --version` prints; `parallel-cli search "test"` returns structured results (requires `PARALLEL_API_KEY` exported on host — auto-forwarded by the wrapper).

If you don't have a parallel.ai account, @explore degrades to telling you to set up one. There's no other web-search path baked into the role — webfetch / Context7 are documented as unreliable for real-time data.

PR: [#218](https://github.com/randomm/pi-ensemble/pull/218)

## Vision / images

> **Reminder:** Pi attaches a file as multimodal input only when its path is prefixed with `@` (e.g. `@/Users/you/Downloads/foo.png describe this`). Dragging an image into the terminal pastes the path but does NOT add the `@` — you have to type it yourself. Without it, Pi treats the path as plain text and never sends image bytes.

### Image dropped but model never mentions it / treats it as text

**Symptom:** Pasted path appears in the prompt, no error, model's reply ignores the image entirely or describes the path string instead of the image.

**Cause:** Missing `@` prefix. Pi only triggers multimodal attachment for `@<path>` tokens; a bare absolute path is just a string.

**Fix:** Re-send with `@` prefixed. Use `Home` / `Ctrl-A` after the drop to jump to the start of the pasted path, type `@`, submit.

### Dropped image rejected by sandbox-fs-guard

**Symptom:** After dragging an image into the `pi-ensemble` session and prefixing `@`, Pi's `read` tool errors with `"Path '/Users/.../Downloads/foo.png' resolves outside the sandbox workspace"`.

**Cause:** The image lives outside the project workspace and outside the wrapper's default image-dir list (`$HOME/Downloads`, `$HOME/Desktop`, `$HOME/Pictures`).

**Fix:** Add the dir to `PI_ENSEMBLE_EXTRA_IMAGE_DIRS` before launching, OR move/copy the image into your project workspace.

```bash
PI_ENSEMBLE_EXTRA_IMAGE_DIRS="$HOME/Documents/screenshots" pi-ensemble
```

The wrapper bind-mounts each listed dir RO and tells `sandbox-fs-guard` to permit reads under those roots.

PR: [#213](https://github.com/randomm/pi-ensemble/pull/213)

### Image attached but model says "I can't see images"

**Symptom:** `@image.png` is included in the prompt, the file exists, but the model response says it can't see / process images.

**Cause:** Pi only routes image bytes to providers whose model entry declares `"input": ["text", "image"]` in `~/.pi/agent/models.json`. Custom OpenAI-compatible providers default to text-only.

**Fix:** Edit `~/.pi/agent/models.json` — add `"input": ["text", "image"]` to the model entry. Built-in providers (Anthropic Claude, OpenAI GPT-4o, Google Gemini) know vision capabilities natively; custom providers need the hint.

```jsonc
{
  "id": "qwen3.6-35b",
  "input": ["text", "image"],   // ← add this
  // ... rest of entry
}
```

PR: [#213](https://github.com/randomm/pi-ensemble/pull/213)

## Session resume

### `pi-ensemble -r` opens the picker but selecting a session does nothing

**Symptom:** `pi-ensemble -r` shows the resume picker with sessions listed. Selecting one returns "No session selected" or fails silently. Or: the picker shows sessions from many projects and your specific one is hard to find.

**Cause (pre-#207):** Pi keys sessions by absolute `cwd`. The old wrapper mounted projects at `/workspace`, so sandbox sessions for ALL projects co-mingled in a single `~/.pi/agent/sessions/--workspace--/` bucket. Selecting a session whose original `cwd` was a host path (`/Users/…/projects/foo`) failed to load because that path didn't exist inside the container.

**Fix:** `./install.sh` to refresh the wrapper. Post-#207, the wrapper mounts your project at its host absolute path inside the container — same `cwd` as host mode, so session buckets align. `pi-ensemble -r` from any project shows sessions for that project only, and host-mode `pi -r` sessions are visible too (and vice versa).

**Pre-fix sessions:** anything written to `~/.pi/agent/sessions/--workspace--/` before #207 is orphaned in that bucket. To resume one you specifically need, `pi --session <uuid>` from inside the container (it will search across scopes).

PR: [#207](https://github.com/randomm/pi-ensemble/pull/207)

### Container hostnames change between sandbox runs

**Symptom:** Container names like `pi-ensemble-lantern--8cbaf2dccfbd-a1b2c3d4` appear in `docker ps`. New name each launch.

**Cause:** Wrapper composes the container name as `pi-ensemble-<project>-<project-hash>-<run-suffix>`. The project-hash disambiguates DIFFERENT projects (avoiding collisions in `docker ps`). The 8-hex run-suffix disambiguates concurrent sessions in the SAME project. Not a bug.

**Not a fix:** The name doesn't affect functionality — only how containers show up in `docker ps`. `pi-ensemble stop` enumerates all containers matching the project's `<base>-*` prefix and stops them. `pi-ensemble status` lists all of them.

### `docker: Error response from daemon: Conflict. The container name "/pi-ensemble-..." is already in use`

**Symptom:** Trying to start a second `pi-ensemble` in the same project errors with a name-conflict from docker.

**Cause:** Pre-#217 the container name was deterministic per project, so two concurrent sessions in the same project collided on `docker run --name`.

**Fix:** Pull + rebuild — `cd ~/.config/opencode/pi-ensemble && git pull && ./install.sh`. Post-#217 each `pi-ensemble` invocation gets a unique 8-hex run-suffix; concurrent sessions in the same project Just Work.

PR: [#217](https://github.com/randomm/pi-ensemble/pull/217)

## State + caches

### `pi-ensemble prune` warning about volumes "in use"

**Symptom:** Running `pi-ensemble prune` errors with `volume is in use` for `pi-ensemble-cache` etc.

**Cause:** Another `pi-ensemble` session is currently running and holding the named volume.

**Fix:** Exit running `pi-ensemble` sessions (the wrapper uses `docker run --rm` so they're gone on exit) then re-run `prune`. Use `docker ps` to find still-running containers.

### Bind-mounted host state showing up in container as `root`-owned

**Symptom:** Files written by `pi-ensemble` end up on the host owned by `root` instead of your user.

**Cause:** This shouldn't happen — the image's `vscode` user has UID 1000, the wrapper does NOT use `--user root`. If you see this, you're likely running an old image (pre-#200) or a custom Dockerfile derivative that switched users.

**Fix:** `./install.sh` to rebuild the official image. Verify: `docker run --rm randomm/pi-ensemble:latest id` → `uid=1000(vscode)`.

## Diagnostics

### Confirm a bind-mount is reaching the container

```bash
docker run --rm \
  -v "$HOME/.pi/agent/models.json:/home/vscode/.pi/agent/models.json:ro" \
  randomm/pi-ensemble:latest \
  jq '.providers | keys' /home/vscode/.pi/agent/models.json
```

Should print your provider keys. If it prints `null` or the file is missing, the bind-mount didn't take.

### Confirm an env var was forwarded

```bash
docker run --rm \
  -e "TRAIL_OPENERS_LLM_KEY=$TRAIL_OPENERS_LLM_KEY" \
  randomm/pi-ensemble:latest \
  bash -c 'env | grep -E "(API|LLM)_KEY" | head -5'
```

Inside the wrapper-spawned container, the same env vars are auto-forwarded by pattern match (`*_API_KEY` / `*_LLM_KEY`).

### See what the wrapper actually does

`pi-ensemble shell` drops you into bash inside the container with all the same mounts + env. From there:

```bash
env | sort                       # what env was forwarded
mount | grep -v 'cgroup\|proc'   # what was bind-mounted
ls ~/.pi/agent/                   # what state is visible
cat ~/.config/mcp/mcp.json        # MCP server config
```

## When in doubt

`./install.sh` is the right first move for almost everything. It:

- Rebuilds the image (cache-fast unless prereqs changed)
- Refreshes the `~/.local/bin/pi-ensemble` symlink
- Re-writes `~/.config/mcp/mcp.json` with the current codebase-memory-mcp wiring
- Validates that codebase-memory-mcp is reachable on PATH

If after `./install.sh` something still doesn't work, capture:

1. `pi-ensemble --version` (or the wrapper file path: `which pi-ensemble`)
2. `docker images randomm/pi-ensemble --format '{{.Repository}}:{{.Tag}} {{.CreatedSince}} {{.Size}}'`
3. The exact failing command + error message
4. Open an issue at <https://github.com/randomm/pi-ensemble/issues>.

## `/work` driver state recovery

### Symptom

`/work N` says it can't start, or halts immediately with a message like:

```
pi-ensemble /work driver halted on issue #N: state-file inconsistencies detected.
  - pipelineState.inFlightJobIds includes <jobId> but log has no record of it
Inspect <project>/.pi/work-state/N.json or rm to start fresh (your git work is unaffected; only the workflow tracker state is removed).
```

Or you get a loud schema-version error when re-invoking `/work` after upgrading pi-ensemble:

```
work-state: <path> has schemaVersion=2 but this build expects 1. This /work cycle was started under a different driver version. …
```

### Cause

Since this PR, `/work` runs through a compiled state-machine driver (`extension/src/work-driver.ts`). Workflow state persists at `<project>/.pi/work-state/<issue>.json` so the user can intervene surgically when subagent providers degrade and the driver can resume cleanly after restart.

The state file is the durable contract that lets the driver know which step is current, what dispatches have completed, and which caps have already fired. Two situations can leave it in a state the driver refuses to run against:

1. **Mid-flight crash**: Pi got killed (process exit, machine reboot, OOM) while a dispatch was in flight. The eventLog has a `dispatch-started` without a matching `dispatch-completed`. The driver detects the orphan jobId on resume and halts rather than fabricating a result.
2. **Schema version mismatch**: you upgraded pi-ensemble between `/work` invocations, and the saved state-file's `schemaVersion` no longer matches what the new driver expects. We never auto-migrate state silently.

### Fix

Pick the option that matches your context:

**A. Resume manually (preferred for valuable in-flight work).** Open `<project>/.pi/work-state/<issue>.json` in your editor. The `eventLog` array shows every step the driver completed and every dispatch's outcome. Worktree path, branch name, PR number (if any), and last review round are all in `pipelineState`. Use that to decide what to do next yourself: finish the work in the worktree manually, or push the PR if the branch is ready, or rm the state file and start fresh.

**B. Start fresh.** `rm <project>/.pi/work-state/<issue>.json` — only the workflow-tracker state goes; your git work (worktree, branch, commits, PR) is unaffected. Then re-run `/work N` to begin a new cycle. The driver will detect that no PR / branch / worktree exists yet for this issue and run Steps 1-3 from scratch — for issues where the developer already pushed a PR, you may want to skip that path and resume manually instead.

**C. Bypass the driver entirely.** `PI_ENSEMBLE_WORK_DRIVER=0 /work N` falls back to the legacy PM-driven flow (`pi.sendUserMessage(work.md)`) — the same flow used before this PR. The driver's state file is left untouched. Use this when you need to debug a driver issue or you want the older PM-orchestrated path for any reason.

### Inspecting the state file directly

The state file shape (schema v1) is:

```jsonc
{
  "schemaVersion": 1,
  "resumable": false,          // v1 is observational; user intervenes, no auto-replay
  "issue": 547,                    // primary issue (state-file path + branch anchor)
  "issues": [547, 548, 549],       // PR10 — all issues passed to /work; absent for single-issue cycles
  "startedAt": <epoch-ms>,
  "updatedAt": <epoch-ms>,
  "pipelineState": {
    "currentStep": "lens-review",   // explore | plan | branch | develop | adversarial | commit-pr | lens-review | lens-fix | step-back | handoff | ci | merged
    "lastCompletedStep": "commit-pr",
    "inFlightJobIds": [],
    "branchName": "feature/issue-547-fix-thing",
    "worktrees": { "task-a": "/abs/path/.worktrees/task-a", ... },  // populated for N>1 fanout
    "workstreams": { "task-a": { id, scope, paths, outOfScope }, ... },  // PR3 decomposition
    "reviewRound": 2,
    "reviewCapStartedAt": <epoch-ms>,
    "ciRetryCount": 0,        // PR2 — outer ci → develop retry counter, capped at MAX_CI_RETRIES
    "retryAttempts": { "adversarial": 1 },  // PR5 — per-step RETRY_ONCE budget tracking
    "exploreVerdict": "NEEDS_WORK",  // PR6 — explore's parsed verdict (NEEDS_WORK | ALREADY_COMPLETE | NEEDS_CLARIFICATION)
    "activeIssues": [561, 563],      // PR10 — NEEDS_WORK subset for multi-issue cycles; fallback [issue] when absent
    "droppedIssues": [               // PR10 — ALREADY_COMPLETE / NEEDS_CLARIFICATION issues filtered out
      { "issue": 562, "verdict": "ALREADY_COMPLETE", "reason": "satisfied by PR #534" }
    ],
    "handoffSnapshot": {       // PR5 — captured by runHandoff for renderer surfaces
      "modifiedFiles": ["src/foo.ts"], "unstagedCount": 1, "stagedCount": 0,
      "branchExists": true, "branchPushed": true, "headSha": "abc1234",
      "capturedAt": <epoch-ms>
    },
    "plumbReports": [],
    "status": "running"             // running | merged | handoff | aborted
  },
  "eventLog": [
    { "kind": "step-started", "step": "explore", "at": <epoch-ms> },
    { "kind": "dispatch-completed", "step": "explore", "role": "explore", "ok": true, ... },
    { "kind": "branches-fanned-out", "step": "develop", "workstreams": ["task-a", "task-b"], "at": ... },  // PR3
    { "kind": "branch-completed", "step": "develop", "workstreamId": "task-a", "ok": true, ... },         // PR3
    { "kind": "branches-converged", "step": "develop", "verdicts": [{ "id": "task-a", "ok": true }, ...] },// PR3
    { "kind": "lens-skipped-empty-diff", "round": 1, "at": ... },  // PR6 — guard fired (no diff to review)
    { "kind": "cap-hit", "cap": "developer-timeout", "nextStep": "handoff", ... },  // PR5 cap shapes (below)
    ...
  ]
}
```

The `eventLog` is append-only and authoritative; `pipelineState` is a derived snapshot for O(1) "where are we" reads. Large subagent outputs go to claim-check artifacts under `.pi/work-state/<issue>/<jobId>.txt` and are referenced from the corresponding `dispatch-completed` event's `artifactPath`.

### Cap-hit shapes and what to do about each

When the driver halts intentionally on a load-bearing failure (rather than crashing), it appends a `cap-hit` event with a named `cap` shape, sets `currentStep="handoff"`, and runs `runHandoff` which posts a rich operator comment to the GitHub issue / PR (or surfaces it in chat if the GitHub post fails). The cap shape determines the operator-readable explanation and the recovery commands the renderer suggests.

| `cap` value | What it means | Most-common operator action |
|---|---|---|
| `developer-timeout` | Developer subagent SIGTERM'd at its wall-clock spawn cap (default 90 min via `PI_ENSEMBLE_SPAWN_TIMEOUT_MS_DEVELOPER`). Files-modified-but-uncommitted count appears in the message. | Inspect with `git status`; retry with a longer cap (`PI_ENSEMBLE_SPAWN_TIMEOUT_MS_DEVELOPER=5400000 && rm .pi/work-state/N.json && pi`) or split the issue. |
| `step-failed:<step>` | A HALT-class step's dispatch failed (network / provider error / non-zero exit). For multi-workstream steps (`develop`, `lens-review`), explainCap surfaces an `(N/M workstream branches failed)` parenthetical. Retry exhausted on RETRY_ONCE-class steps (`adversarial`, `lens-review`) also lands here. PR10: `step-failed:merged` fires when ops can't actually merge (auth / branch protection / conflicts / missing required review) — recovery is to run `gh pr merge <PR-N> --squash --delete-branch` manually. | Read the failing dispatch's transcript via `/runs` (path in the handoff comment); retry, or take over manually. |
| `explore-already-complete` | Explore concluded the issue is already done (e.g., satisfied by a prior PR). Driver halts before any branch/develop. No code was written. | `gh issue close N --comment "Verified complete by /work — see prior PR"` if you agree; or `gh issue comment N --body "Additional context: …"` + `rm .pi/work-state/N.json && pi` if you disagree. |
| `explore-needs-clarification` | Explore couldn't determine concrete work (issue ambiguous / missing acceptance criteria). PR13 fixed a false-positive variant where multi-issue cycles produced NEEDS_CLARIFICATION even when bodies existed (the agent's verdict raced the parallel `gh issue view` fetch — pre-PR13 the body was never inlined in the prompt). Re-running on v0.12.13+ resolves recurrences if you saw this before. | Edit issue body via `gh issue edit N`, then `/work N --restart`. |
| `explore-bodies-empty` | PR11 — `gh issue view <N>` returned empty or errored for one or more issues. Pre-condition failure; the driver cannot reliably classify work it can't read. Common causes: gh version with projectCards GraphQL deprecation, gh extension hijacking stdout, expired auth, network. | `gh auth status && gh --version` to confirm gh setup. `gh api repos/<owner>/<repo>/issues/<N> --jq .body` works when `gh issue view` is broken — use it to verify the issue body fetches via REST. `gh extension list` if a misbehaving extension is suspected. Once fixed, `rm .pi/work-state/N.json && pi`. |
| `step-back-revise-spec` | PR12 — `runStepBack` fired (lens-review fix loop kept flagging the same shape across rounds — spec-level problem fingerprint). The @explore SDD analysis identified which of the six SDD elements (outcomes / scope / constraints / prior decisions / task breakdown / verification) is underspecified, and produced a proposed revision. | Read the proposed revision (surfaced in the handoff body): `cat tmp/issue-N/handoff-comment.md`. Apply the revision via `/plan N` (or `gh issue edit N`). Restart the cycle: `/work N --restart`. The `--restart` flag wipes the prior state file so the fresh cycle reads the revised spec. |
| `commit-pr-incomplete-consolidation` | PR14 — multi-workstream cycles run N developers in N worktrees with uncommitted changes; ops's commit-pr step is supposed to consolidate ALL of them onto the integration branch. The post-dispatch gate found files from one or more workstreams missing from the committed diff — ops drifted and committed a partial slice. Pre-PR14 the partial diff shipped silently (v0.12.13 /work 577 closed an issue with 1 of 3 workstreams' changes — root fix lost from main). | Each missing workstream's work is still uncommitted in its worktree: `git -C .worktrees/issue-N-<id> status --porcelain`. Apply each missing diff to the integration tree: `git -C .worktrees/issue-N-<id> diff HEAD \| git apply --index`. Verify (`git diff --name-only --cached`), commit, push. Or restart: `rm .pi/work-state/N.json && /work N --restart`. The handoff comment quotes paste-and-run-ready commands for each missing workstream. |
| `adversarial-loop` | `adversarial_loop` ran its 3-round internal fix loop and could not reach APPROVED. For N>1 multi-workstream cycles, the aggregate-rejected case (any per-workstream adversarial REJECTED) also fires this cap, with per-workstream findings tagged `[workstream <id>]`. | Read the rejection findings; if phantom, merge manually; if real, take over the worktree to fix or split the work. |
| `round-cap` | Lens-review hit its 3-round cap with findings still open — review loop didn't converge. | Inspect the latest `lens-issues-found` event in `eventLog`; if findings cluster around a theme, that's a spec-level problem (consider revising the issue body before re-running). |
| `wall-clock` | Lens-review fix loop exceeded the 90-minute wall-clock cap. | Same as `round-cap` — inspect findings, decide whether to retry or take over. |
| `ci-retry` | CI failed `MAX_CI_RETRIES` times in a row (default 2 → 3 attempts total). Either CI is permanently broken for this branch, or develop keeps producing the same failure. | Read CI logs (URL in the handoff `ci-status` event); fix manually, or `rm .pi/work-state/N.json && pi` to re-run from scratch. |

The handoff comment quotes 4 concrete recovery shell commands keyed to the cap shape — paste-and-run-ready. The `/work-status` command renders the same postmortem layout from the state file if you'd rather inspect locally.

### Restarting a /work cycle after revising the issue (PR12)

When `/work N` terminates (handoff / aborted / merged) and you've since revised the issue body — typically via `/plan N` after a `step-back-revise-spec` handoff — re-running `/work N` would silently no-op pre-PR12 (the existing state file still showed `status=handoff`, and the loop never re-entered).

Fix: pass `--restart` to wipe the prior state file and start a fresh cycle.

```bash
/work N --restart            # restart the cycle against the (now-revised) spec
/work --restart N             # order-independent — flag can lead or trail
/work N M --restart           # multi-issue + restart also works
```

Without `--restart`, re-invoking `/work N` on a terminal-state file now emits a clear notify pointing at the recovery: *"`/work` for issue #N already terminated as <status>. To start a fresh cycle (e.g., after revising the issue via /plan), re-run with `--restart`..."*.

`--restart` only wipes the driver's state file (`.pi/work-state/N.json`). Worktrees and feature branches from the prior cycle are NOT removed — the branch step will detect existing branches at runtime (ops checks out + resets, or ABORTs cleanly with the error). If you want a fully clean slate, also `rm -rf .worktrees/issue-N-*` and `git branch -D feature/issue-N-*` before re-running.

### Per-role spawn timeouts (PR5)

The driver uses per-role wall-clock caps for each dispatched subagent. Defaults reflect typical role runtime (developer is the slow one):

| Role | Default cap | Env var override |
|---|---|---|
| `developer` | 90 min | `PI_ENSEMBLE_SPAWN_TIMEOUT_MS_DEVELOPER` |
| `code-review-specialist` | 15 min | `PI_ENSEMBLE_SPAWN_TIMEOUT_MS_CODE_REVIEW_SPECIALIST` |
| `adversarial-developer` | 15 min | `PI_ENSEMBLE_SPAWN_TIMEOUT_MS_ADVERSARIAL_DEVELOPER` |
| `explore` | 15 min | `PI_ENSEMBLE_SPAWN_TIMEOUT_MS_EXPLORE` |
| `ops` | 10 min | `PI_ENSEMBLE_SPAWN_TIMEOUT_MS_OPS` |
| `project-manager` | 30 min | `PI_ENSEMBLE_SPAWN_TIMEOUT_MS_PROJECT_MANAGER` |

Env precedence: per-role override > umbrella `PI_ENSEMBLE_SPAWN_TIMEOUT_MS` > per-role default. Setting a per-role override is the cleanest fix when a `developer-timeout` cap-hit suggests the issue genuinely needs more wall-clock than the default 90 min.

### `ci` step timeout — CI runs > 10 min (PR15)

The `ci` step dispatches `ops` to run `gh run watch <id>`, which blocks until CI completes. Pre-PR15 this inherited ops' 10-min default, so any CI run exceeding 10 min SIGTERM'd mid-watch and routed through `step-failed:ci` handoff (3× this session on lantern's ~15-min pipeline).

PR15 gives `ci` its own 30-min cap (30 × 60000 ms). Override via `PI_ENSEMBLE_CI_WATCH_TIMEOUT_MS` (milliseconds). Only the `ci` step's `ops` dispatch uses this cap — every other `ops` invocation (commit-pr, handoff, merged) still uses the 10-min ops default.

If your project's CI genuinely takes longer than 30 min, either raise `PI_ENSEMBLE_CI_WATCH_TIMEOUT_MS` or accept the handoff — inspect the CI run in the browser, then either fix + push or manually merge as appropriate.

The `inlineCiPrompt` also carries a bounded poll-fallback recipe (`gh run view --json status`) so ops has something to reach for if `gh run watch` fails outright.

## Multi-issue `/work` — how grouping is decided (PR16+)

### Behavior

`/work 561 562 563` runs a **deterministic grouping analysis** first, then iterates the resulting groups sequentially:

1. Fetches each issue's body via `gh issue view` (in parallel).
2. Runs `groupIssues()` (pure code, no LLM) which partitions the N issues into K groups.
3. Iterates groups: each group runs as one cycle producing one PR. Multi-issue groups use the PR10 bundled driver-level API (all issues in the group's PR body via `Fixes #X #Y`).
4. Halt-on-non-merged between groups: if a cycle handoffs / aborts, remaining groups are NOT started.

### Grouping rules (first-match-wins, union-find)

**R1 — Explicit link markers** merge issues into the same group. Regex on each body: `depends-on: #N`, `companion-to: #N`, `blocks #N`, `blocked-by: #N` (case-insensitive, hyphen or space).

**R2 — Path overlap ≥ 50% (Jaccard)** merges issues that touch the same files. Extract path-shaped tokens (`src/foo/bar.ts` etc.) from each body's prose + code blocks; compute Jaccard between issue pairs.

**R3 — SPLIT markers** force an issue into its own singleton group even if R1/R2 would have merged it. Regex on the body: `split`, `separate PRs`, `independent`.

**R4 — Subsystem tag prefix** in the issue title merges same-prefix issues (`[frontend]`, `[docs]`, `[ci]`, `[extension]`, ...).

**R5 — Default** is separate groups. Absent R1-R4 evidence, two issues do NOT merge.

### Guardrails

- **`MAX_ISSUES_PER_GROUP` = 3**: a component with more than 3 issues splits into per-issue singletons. Empirical convergence ceiling from vipune `memory-row` — bigger groups approach the adversarial fix-loop wall.
- **Fanout policy**: today groups run sequentially regardless of `fanout.mode`. Future PR may add per-group parallel worktrees; the `groupIssues()` return already carries the intended mode (`parallel` for K ≤ 2, `sequential` for K > 2), overridable via `PI_ENSEMBLE_PARALLEL_GROUPS`.

### Cycle shape per group

Each group's cycle runs end-to-end (explore → plan → branch → develop → adversarial → commit-pr → lens-review → ci → merged) with the group's issues in `ctx.issues`. Single-issue groups follow today's shape exactly. Multi-issue groups use the PR10 bundled shape — safe *because the grouping rules said the issues belong together*.

Each cycle produces **its own PR** and its own state file (`.pi/work-state/<primary>.json`).

### Pre-PR16 behavior (v0.12.6–v0.12.15)

- **PR10 (v0.12.6–v0.12.9)**: bundled ALL N issues into ONE PR unconditionally. Empirically failed 3× (vipune `memory-row`: convergence-drop, phantom-bundle, oversized-diff cap).
- **PR15 (v0.12.15)**: retreated to strictly sequential one-PR-per-issue. Safe but ignored the "these issues genuinely belong together" signal.
- **PR16 (v0.12.16+)**: deterministic grouping decides the middle path.

### Halt-on-non-merged

If a group's cycle terminates as anything other than `merged` (handoff, aborted, crashed), the queue **HALTS**. The extension emits a message like:

```
pi-ensemble: /work group-a (#561, #562) terminated as handoff; queue halted.
Remaining groups (group-b (#563)) were NOT started.
Fix / abandon group-a, then re-run /work with the remaining issues.
```

The operator inspects the handoff comment, either resolves the underlying blocker (re-run `/work 561 --restart` after `/plan 561` clarifies the spec) or abandons it, then re-runs `/work` with the remaining issues to continue.

Rationale: an intermediate handoff usually signals something the operator wants to review before we auto-start the next group. Auto-continuing would blur the "why the previous halted" signal.

### `--restart` semantics with a multi-issue queue

`/work 561 562 --restart` applies `--restart` to **every** cycle — each group's state file is wiped before its cycle starts. For groups that have no prior state file, `--restart` is a no-op.

### Why deterministic grouping rather than PM-narrated?

The compiled driver's PR10 shortcut (v0.12.5–v0.12.14) bundled ALL issues into ONE PR without any judgment — that empirically failed 3× (vipune `memory-row`). PR15's retreat to strictly-sequential was safe but ignored real relatedness signal. PR16's grouping rules encode explicit heuristics (link markers, path overlap, subsystem tags) that produce reproducible partitions — same input → same groups, testable, no LLM budget, no drift between runs.
