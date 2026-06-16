# pi-ensemble troubleshooting

Symptoms → causes → fixes. Most issues here come from running an older sandbox image; the first move on anything weird is usually `./install.sh` from the pi-ensemble repo to rebuild + refresh.

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

**Fix:** `./install.sh` from pi-ensemble repo to refresh the wrapper. If after that the provider's API requests fail with `401`, check that the api key env var matches the auto-forward pattern (`*_API_KEY` or `*_LLM_KEY`). For odd names, add to `PI_ENSEMBLE_EXTRA_ENV="MY_CUSTOM_KEY,ANOTHER_TOKEN"`.

PR: [#205](https://github.com/randomm/pi-ensemble/pull/205)

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

### `ssh remote-host` fails with "Permission denied (publickey)" or "no identities"

**Symptom:** Agents inside the sandbox can't `ssh` to remote hosts that work fine on the host. `ssh-add -l` reports "Could not open a connection to your authentication agent" or "agent has no identities".

**Cause:** Stale wrapper (pre-#220). The wrapper now bind-mounts `~/.ssh/` (read-only) and forwards the host's `$SSH_AUTH_SOCK` by default so outbound SSH inside the sandbox uses the same identities as host-mode `pi`.

**Fix:**

```bash
cd ~/.config/opencode/pi-ensemble && git pull && ./install.sh
```

Then relaunch `pi-ensemble`. Verify: `pi-ensemble shell` → `ssh-add -l` lists your host's loaded identities; `ssh remote-host` works.

**If you have no SSH agent running on the host:** start one before launching pi-ensemble so the agent socket exists for forwarding:

```bash
eval "$(ssh-agent -s)"
ssh-add ~/.ssh/id_ed25519   # or whichever key
pi-ensemble
```

**If you have on-disk keys only (no agent):** the wrapper mounts `~/.ssh/` RO so the keys are visible inside, BUT SSH's `StrictModes` may reject keys whose host UID (501 on macOS) doesn't match the container's `vscode` UID (1000). Workaround: use ssh-agent (above) so the keys load via the agent socket and never get read from disk inside the container.

PR: [#220](https://github.com/randomm/pi-ensemble/pull/220)

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
