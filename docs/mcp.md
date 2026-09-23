# Using MCP servers (per-host or per-project)

Pi has no built-in Model Context Protocol support — MCP is provided by a bridge extension. pi-rukas's job is to forward that bridge to subagents and to gate access per role. Two independent layers are at play:

1. **Which MCP servers exist** — owned by the bridge (e.g. [`pi-mcp-adapter`](https://github.com/nicobailon/pi-mcp-adapter)). The bridge merges its own 4-tier config; project-local files override host-global ones.
2. **Which pi-rukas role may reach them** — owned by pi-rukas's permission overlay. 3-tier merge; project-local files override host-global ones.

### Step 1 — Install the bridge

```bash
pi install npm:pi-mcp-adapter
```

(Already done as part of the [Prerequisites install commands](../README.md#install-commands)? Skip to Step 2.)

`pi install npm:<pkg>` installs into the flat npm project under `~/.pi/agent/npm/node_modules/` (NOT the `extensions/` dir, which is only used for git/local installs) — verified against pi `0.84.4` (the "Last verified against" line in [docs/pi-compatibility.md](docs/pi-compatibility.md); `test-pi-version-drift.ts` cross-checks this claim), so treat a pi version bump as a deliberate re-verification. Pi's own package manager loads it at runtime via the `pi.extensions` manifest in the package's package.json — **in the parent session**. For subagents, pi-rukas's auto-forward (`discoverInstalledExtensions`) reads only the `extensions/` layout, so an npm-layout install is NOT forwarded to subagents: either install the bridge git/local into `~/.pi/agent/extensions/` (auto-forwarded), or set `PI_ENSEMBLE_USER_EXTENSION=<abs-path or npm:ref>` to forward it explicitly. If `/mcp` shows no MCP tools inside a subagent, this is the usual cause. This step covers the bridge install; the bridge itself is a generic prerequisite — any MCP server you add later (Step 2 onward) depends on it.

### Step 2 — Define MCP servers (bridge config, 4 tiers)

`pi-mcp-adapter` merges these in ascending precedence — **project files win**:

| Tier | Path | Scope |
|---|---|---|
| 1 | `~/.config/mcp/mcp.json` | Cross-tool global (shared with claude-code/cursor/etc.) |
| 2 | `~/.pi/agent/mcp.json` | Pi-global on this host |
| 3 | `./.mcp.json` | Project (cross-tool) |
| 4 | `./.pi/mcp.json` | Project, Pi-specific — **highest precedence** |

The bridge also supports an `imports` array that auto-adopts servers already configured for Claude Code, Cursor, VS Code, Windsurf, Claude Desktop, Codex. See the [pi-mcp-adapter docs](https://github.com/nicobailon/pi-mcp-adapter) for the full JSON schema.

> **codebase-memory-mcp is wired automatically by `./install.sh`.** It writes a `codebase_memory` entry to `~/.config/mcp/mcp.json` (Tier 1) with selective `directTools` exposing the seven read-side tools (`search_code`, `search_graph`, `trace_path`, `detect_changes`, `get_code_snippet`, `get_architecture`, `query_graph`). Admin tools (`index_repository`, `delete_project`, `manage_adr`) stay behind the proxy `mcp` tool. Re-running `./install.sh` is safe — other MCP servers you've configured by hand are preserved (idempotent jq merge). See [Prerequisites](../README.md#prerequisites) for the binary install.

#### `command:` portability between host and sandbox

The same `~/.config/mcp/mcp.json` is read by both host-mode `pi` and sandbox-mode `pi-rukas` (the wrapper bind-mounts the host file into the container). For server entries to work in BOTH contexts, use **PATH-relative `command:` values** — a bare binary name or `npx -y <package>`. Node's `spawn` resolves non-absolute `command:` values via `$PATH` at MCP-spawn time, so the same entry resolves to `~/.local/bin/foo` on host and `/usr/local/bin/foo` (or wherever) inside the sandbox.

```jsonc
// ✅ Portable — works on host AND in sandbox
{ "command": "codebase-memory-mcp" }
{ "command": "npx", "args": ["-y", "@anthropic/some-mcp"] }

// ❌ Host-only — fails inside the sandbox (path doesn't exist there)
{ "command": "/Users/janni/.local/bin/codebase-memory-mcp" }
```

If a server's binary doesn't exist inside the sandbox container, you have two options: extend `.devcontainer/Dockerfile` to install it, or scope that server to host-mode only by placing the entry in `~/.pi/agent/mcp.json` (Tier 2) and adding it to the bind-mount exclude list in `bin/pi-rukas`.

#### Tool-surface modes: `directTools`

Each server entry can set `"directTools": true | false`. This controls how the bridge surfaces tools to Pi — and therefore what the permission prompt asks about:

| Mode | What Pi sees | First-call prompt covers |
|---|---|---|
| `directTools: false` *(default)* | One gateway tool literally named `mcp` | Everything that bridge ever does (single Allow/Deny) |
| `directTools: true` | Each MCP tool registered as a top-level Pi tool named `<server_snake_case>_<tool>` (kebab→snake, then `_<tool>`) | Each tool individually — finer-grained audit trail |

Example: a server named `staging-db` with `directTools: true` and a `list_schemas` MCP tool surfaces in Pi as `staging_db_list_schemas`. With `directTools: false`, the same call goes via `mcp({server: "staging-db", tool: "list_schemas", args: …})`.

Either mode works with the ask-by-default prompt UX described below — pick based on how much per-tool granularity you want in your `$PWD/.pi/decisions.json` audit trail. Read-only safety (e.g. `--access-mode=restricted` for `crystaldba/postgres-mcp`) is enforced at the MCP server level regardless of the surface mode.

### Step 3 — Grant role access (pi-rukas permission overlay, 3 tiers)

The shipped baseline gives **project-manager** an "ask-by-default" catch-all (`"*": "ask"`) — so the first call to any tool that isn't on an explicit allow- or deny-list (the `mcp` gateway, per-server direct tools like `<server>_<action>`, etc.) prompts you:

> `Allow once / Allow always / Deny once / Deny always`

Choosing **"Allow always"** persists the decision to `$PWD/.pi/decisions.json` — **per-project**, automatically. Other projects on the host still prompt on their first call. No host-wide opt-in by accident. This matches the Claude-Code-style permission UX users expect.

Headless mode (no UI) hard-denies every `"ask"` verdict, so CI/automation is unchanged. Bash commands with injection vectors (`&&`, `|`, `$(...)`, redirects) are still hard-denied at the matcher level — they never reach the prompt.

For finer control (narrower wildcards, host-wide overrides, role overrides), the resolver checks three tiers in order — **first match wins, project beats host**:

| Tier | Path | Scope |
|---|---|---|
| 1 | `$PWD/.pi/permissions.json` | Per-project (highest precedence) |
| 2 | `~/.pi/agent/permissions.json` | Per-host |
| 3 | `<pi-rukas repo>/agents.json` | Shipped baseline (this is what `mcp*: ask` lives in) |

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

- Read-only guarantees for database access must come from the MCP server's own credentials (restricted DB user, read-only role). pi-rukas gates *who can call the tool*, not *what the tool can do*.
- Subagents are spawned with `--no-extensions`, so pi-rukas's permission interceptor doesn't run inside them — only role prompts constrain. The bridge IS still forwarded (so subagents have MCP access), but the deny doesn't fire in-child. If you don't want a role calling MCP, omit the grant from the role's prompt doctrine and from any project/global overlay; the subagent simply won't have a reason to call it.
- `PI_ENSEMBLE_DISABLE_EXTENSION_FORWARD=1` opts out of auto-forwarding entirely (subagents inherit nothing — disables pi-claude-auth, MCP bridges, etc.). `PI_ENSEMBLE_USER_EXTENSION` is independent of this flag; when set, that one extension is always forwarded.
