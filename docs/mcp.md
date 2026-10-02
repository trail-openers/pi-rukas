# Using MCP servers (per-host or per-project)

Pi 1.0.0 ships **native MCP** as a built-in extension. There is no bridge
extension to install or forward to subagents — Pi reads `mcp.json`
directly. pi-rukas's job is to gate access per role and to make sure the
subagent spawn path keeps native MCP enabled (see
`extension/src/spawn-support.ts` `CHILD_ARGS_BASE`, which passes
`--no-extensions -e builtin:mcp`).

Two independent layers are at play:

1. **Which MCP servers exist** — owned by Pi's native MCP, which reads
   `mcp.json` from two paths: user-level `~/.pi/agent/mcp.json` and
   project-level `.pi/mcp.json` (the latter is read only after project
   trust is granted).
2. **Which pi-rukas role may reach them** — owned by pi-rukas's permission
   overlay. 3-tier merge; project-local files override host-global ones.

### Step 1 — (no bridge to install)

Pi 1.0.0's built-in MCP extension is loaded automatically in every Pi
session. Subagents spawned by pi-rukas get it explicitly via the
`-e builtin:mcp` flag (because the `--no-extensions` flag that isolates
subagents from user-installed extensions would otherwise also disable the
built-in MCP — issue #959).

> **Migration note (pre-1.0 hosts).** If you upgrade from a pi-rukas that
> relied on `pi-mcp-adapter`, re-run `./install.sh`. It removes the adapter
> from both `~/.pi/agent/npm/node_modules/pi-mcp-adapter` and
> `~/.pi/agent/extensions/pi-mcp-adapter` (an installed extension that
> registers the `/mcp` command *replaces* the built-in MCP for the whole
> session — a lingering adapter would silently disable native MCP), and it
> re-wires the `codebase_memory` entry from the adapter-era
> `~/.config/mcp/mcp.json` into the native `~/.pi/agent/mcp.json` (removing
> the `codebase_memory` key from the old file while preserving everything
> else).

### Step 2 — Define MCP servers (native `mcp.json`)

Native MCP reads two files, in this precedence order (project wins over
user when the same server key appears in both):

| Tier | Path | Scope |
|---|---|---|
| 1 | `~/.pi/agent/mcp.json` | Pi-global on this host |
| 2 | `.pi/mcp.json` | Project, Pi-specific — **highest precedence**, read only after project trust is granted |

The JSON schema is the standard `mcpServers` format (same as other MCP
clients — Claude Code, Cursor, VS Code, etc.):

```json
{
  "mcpServers": {
    "codebase_memory": {
      "command": "codebase-memory-mcp",
      "args": [],
      "exposure": "direct"
    }
  },
  "autoEnableCodemode": false
}
```

Top-level `autoEnableCodemode: false` prevents the MCP built-in from
auto-activating the codemode built-in when a server with `codemode` exposure
connects (Pi 1.0.0's default behaviour for a codemode-exposure server).
pi-rukas sets this in both the host and the sandbox so the subagent toolset
is exactly what the role prompt + permission overlay expects.

> **codebase-memory-mcp is wired automatically by `./install.sh`.** It
> writes a `codebase_memory` entry to `~/.pi/agent/mcp.json` with
> `exposure: "direct"` for the seven read-side tools (`search_code`,
> `search_graph`, `trace_path`, `detect_changes`, `get_code_snippet`,
> `get_architecture`, `query_graph`) and `autoEnableCodemode: false`. Admin
> tools (`index_repository`, `delete_project`, `manage_adr`) are exposed
> as `mcp__codebase_memory__index_repository` etc. and granted to
> project-manager only in `agents.json`. Re-running `./install.sh` is safe —
> other MCP servers you've configured by hand are preserved (idempotent jq
> merge with key-level replace of `.mcpServers.codebase_memory`). See
> [Prerequisites](../README.md#prerequisites) for the binary install.

#### `command:` portability between host and sandbox

The same `~/.pi/agent/mcp.json` is read by both host-mode `pi` and
sandbox-mode `pi-rukas` (the wrapper bind-mounts the host file into the
container — see `.devcontainer/devcontainer.json`). For server entries to
work in BOTH contexts, use **PATH-relative `command:` values** — a bare
binary name or `npx -y <package>`. Node's `spawn` resolves non-absolute
`command:` values via `$PATH` at MCP-spawn time, so the same entry resolves
to `~/.local/bin/foo` on host and `/usr/local/bin/foo` (or wherever) inside
the sandbox.

```jsonc
// ✅ Portable — works on host AND in sandbox
{ "command": "codebase-memory-mcp" }
{ "command": "npx", "args": ["-y", "@anthropic/some-mcp"] }

// ❌ Host-only — fails inside the sandbox (path doesn't exist there)
{ "command": "/Users/janni/.local/bin/codebase-memory-mcp" }
```

If a server's binary doesn't exist inside the sandbox container, you have
two options: extend `.devcontainer/Dockerfile` to install it, or scope that
server to host-mode only by placing the entry in `~/.pi/agent/mcp.json`
(user-level, not project-level).

#### Tool naming: `mcp__<server>__<tool>`

Every MCP tool is registered in Pi's toolset as
`mcp__<server>__<tool>`, where `<server>` is the key in `mcpServers` (with
`-` replaced by `_`, per Pi 1.0.0's naming rule) and `<tool>` is the
tool's name on the MCP server. So the seven read-side tools of the
`codebase_memory` server surface as:

- `mcp__codebase_memory__search_code`
- `mcp__codebase_memory__search_graph`
- `mcp__codebase_memory__trace_path`
- `mcp__codebase_memory__detect_changes`
- `mcp__codebase_memory__get_code_snippet`
- `mcp__codebase_memory__get_architecture`
- `mcp__codebase_memory__query_graph`

These are the exact names that `agents.json` grants per role, and the exact
names the role prompts and the `mcp__codebase_memory__*` wildcard in
project overlays use.

`exposure` controls whether a tool is declared to the model:

| Exposure | Effect |
|---|---|
| `direct` | Declared to the model like a built-in (this is what `codebase_memory` uses) |
| `codemode` | Callable from codemode scripts, not declared to the model (the default for other servers) |
| `deferred` | Not declared until `tool_search` loads it |
| `hidden` | Not declared at all |

### Step 3 — Grant role access (pi-rukas permission overlay, 3 tiers)

The shipped baseline in `agents.json` grants the seven
`mcp__codebase_memory__*` read-side tools to every role (with per-role
subsets — `ops` gets only 3 of the 7: `search_code`, `get_code_snippet`,
`get_architecture`). PM additionally gets
`mcp__codebase_memory__index_repository` for the first-run admin call.

PM's tool-level catch-all is `"*": "deny"` (deny-by-default for unknown
tools), so a new MCP server the operator has not reviewed is simply
invisible to the model unless explicitly granted. Bash subcommands keep
their own ask-by-default allowlist (`bash.*: ask`).

Headless mode (no UI) hard-denies every `"ask"` verdict and every unlisted
tool, so CI/automation is unchanged. Bash commands with injection vectors
(`&&`, `|`, `$(...)`, redirects) are still hard-denied at the matcher level
— they never reach the prompt.

For finer control (narrower wildcards, host-wide overrides, role overrides),
the resolver checks three tiers in order — **first match wins, project
beats host**:

| Tier | Path | Scope |
|---|---|---|
| 1 | `$PWD/.pi/permissions.json` | Per-project (highest precedence) |
| 2 | `~/.pi/agent/permissions.json` | Per-host |
| 3 | `<pi-rukas repo>/agents.json` | Shipped baseline (this is what `mcp__codebase_memory__*` lives in) |

Per-project example — grant every `mcp__safe__*` tool to developer in
*this* project only, while leaving the host default unchanged:

```json
// ~/projects/v10r/.pi/permissions.json
{
  "developer": {
    "permission": {
      "mcp__safe__*": "allow"
    }
  }
}
```

Wildcard precedence (`permission-guard.ts:lookupPermission`): exact match →
longest prefix wildcard → catch-all `"*"`. So
`"mcp__safe__*": "allow"` beats `"*": "deny"` (the PM catch-all).

### Security notes

- Read-only guarantees for database access must come from the MCP server's
  own credentials (restricted DB user, read-only role). pi-rukas gates *who
  can call the tool*, not *what the tool can do*.
- Subagents are spawned with `--no-extensions -e builtin:mcp`, so
  pi-rukas's permission interceptor does NOT run inside them (the
  `--no-extensions` flag suppresses user-installed extensions, including
  the pi-rukas guard itself). Only role prompts constrain MCP use in a
  child. If you don't want a role calling MCP, omit the grant from the
  role's prompt doctrine and from any project/global overlay; the subagent
  simply won't have a reason to call it.
- `PI_ENSEMBLE_DISABLE_EXTENSION_FORWARD=1` opts out of auto-forwarding
  user-installed extensions entirely (subagents inherit nothing — disables
  pi-claude-auth, etc.). It does NOT disable native MCP: the `-e
  builtin:mcp` flag in `CHILD_ARGS_BASE` is independent of this env var,
  because MCP is no longer an extension but a built-in. `PI_ENSEMBLE_USER_EXTENSION`
  is likewise independent.
- **An installed extension that registers `/mcp` (e.g. a lingering
  pi-mcp-adapter) REPLACES the built-in MCP for the whole session** — Pi
  will not read `mcp.json` or connect its servers. `install.sh` removes
  the adapter on re-run, and `discoverInstalledExtensions` skips it for
  subagents even if it lingers in `~/.pi/agent/extensions/`.
