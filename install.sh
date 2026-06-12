#!/usr/bin/env bash
set -euo pipefail

# pi-ensemble installer — idempotent.
#
# 1. Builds the per-role system prompts from manifests/ + modules/ + agents-base/.
# 2. Symlinks skill/ into ~/.pi/agent/skills/ (Claude-Agent-Skills compatible).
# 3. Installs extension deps and registers the extension with Pi.

ENSEMBLE_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PI_AGENT_DIR="${PI_AGENT_DIR:-$HOME/.pi/agent}"

echo "==> pi-ensemble install"
echo "    ensemble dir: $ENSEMBLE_DIR"
echo "    pi agent dir: $PI_AGENT_DIR"

# ---- 0. Preflight: required CLIs ---------------------------------------------

missing=()
check_cmd() {
  local cmd="$1"
  local hint="$2"
  if ! command -v "$cmd" >/dev/null 2>&1; then
    missing+=("$cmd — $hint")
  fi
}

# Hard dependencies — install will continue but tools will fail at runtime.
check_cmd pi           "bun add -g @earendil-works/pi-coding-agent"
check_cmd git          "OS package manager"
check_cmd gh           "brew install gh"
check_cmd jq           "brew install jq"
check_cmd vipune       "cargo install vipune  (https://github.com/randomm/vipune)"
check_cmd oo           "cargo install double-o  (https://github.com/randomm/oo)"
# codebase-memory-mcp is not preflighted here — it's an MCP server loaded by
# pi-mcp-adapter, not a CLI on PATH. See README → Using MCP servers + the
# codebase-memory-mcp install at https://github.com/DeusData/codebase-memory-mcp
check_cmd parallel-cli "brew install parallel-web/tap/parallel-cli  (then: parallel-cli login)"
check_cmd ctx7         "npm install -g ctx7  (free tier works without login; Node.js >= 18)"

if [ ${#missing[@]} -gt 0 ]; then
  echo ""
  echo "!! Missing dependencies (see README → Prerequisites):"
  for m in "${missing[@]}"; do echo "   - $m"; done
  echo ""
  echo "   Install continues, but agents will fail at runtime without these."
  echo ""
fi

# ---- 1. Build role prompts ----------------------------------------------------

echo "==> Building role prompts"
cd "$ENSEMBLE_DIR"
PI_ENSEMBLE_BASE="$ENSEMBLE_DIR" PROMPTS_DIR="$ENSEMBLE_DIR/dist/prompts" \
  ./build.sh standard

# ---- 2. Remove any old pi-prompts symlinks -----------------------------------

# Older installer revisions symlinked pi-prompts/ into ~/.pi/agent/prompts/,
# which made Pi auto-discover them as file-based templates AND our extension
# also register the same slash-command names — a collision that showed the
# user two entries in autocomplete. The extension is the single source of
# truth; it reads pi-prompts/*.md directly from this repo. Clean up any stale
# symlinks left over from previous installs.
if [ -d "$PI_AGENT_DIR/prompts" ]; then
  for name in start.md research.md plan.md work.md review.md; do
    target="$PI_AGENT_DIR/prompts/$name"
    if [ -L "$target" ]; then
      link_dest="$(readlink "$target")"
      case "$link_dest" in
        *pi-ensemble/pi-prompts/*)
          echo "==> Removing stale prompt symlink: $target"
          rm -f "$target"
          ;;
      esac
    fi
  done
fi

# ---- 3. Symlink skills --------------------------------------------------------

mkdir -p "$PI_AGENT_DIR/skills"
echo "==> Symlinking skills → $PI_AGENT_DIR/skills/"
for d in "$ENSEMBLE_DIR/skill"/*; do
  [ -d "$d" ] || continue
  name="$(basename "$d")"
  target="$PI_AGENT_DIR/skills/$name"
  ln -sfn "$d" "$target"
done
echo "    $(ls -1 "$PI_AGENT_DIR/skills" | wc -l | tr -d ' ') skills linked"

# ---- 4. Build extension -------------------------------------------------------

if command -v bun >/dev/null 2>&1; then
  echo "==> Installing extension deps (bun)"
  (cd "$ENSEMBLE_DIR/extension" && bun install)
elif command -v npm >/dev/null 2>&1; then
  echo "==> Installing extension deps (npm)"
  (cd "$ENSEMBLE_DIR/extension" && npm install)
else
  echo "!! No bun or npm found — skipping extension install. Install one and re-run."
fi

# ---- 5. Register the extension with Pi ---------------------------------------

mkdir -p "$PI_AGENT_DIR/extensions"
ext_target="$PI_AGENT_DIR/extensions/pi-ensemble"
ln -sfn "$ENSEMBLE_DIR/extension" "$ext_target"
echo "==> Registered extension at $ext_target"

# ---- 6. Register codebase-memory-mcp with pi-mcp-adapter ---------------------
#
# codebase-memory-mcp ships its own install script that writes MCP configs for
# Claude Code / Codex / OpenCode — but NOT for pi-mcp-adapter (which is what
# Pi uses). pi-mcp-adapter reads (precedence-ordered):
#   1. ~/.config/mcp/mcp.json   (user-global, preferred)
#   2. <PI_AGENT_DIR>/mcp.json  (Pi global override)
#   3. .mcp.json                (project-scoped)
#   4. .pi/mcp.json             (Pi project override)
#
# Without an entry in one of these, `/mcp` shows "0/0 servers, 0 tools" and
# every dispatched subagent fails the first codebase_memory_* call. pi-ensemble
# DOES depend on codebase-memory-mcp (see modules/core/codebase-memory-mcp.md)
# so we wire it explicitly into the user-global config — idempotent, merge-
# safe with other MCP servers the user already configured.
#
# Server-key is `codebase_memory` (underscore, not the binary's hyphenated
# package name) so pi-mcp-adapter's formatToolName produces tool names that
# match our doctrine exactly: `codebase_memory_search_code`, `_trace_path`,
# `_detect_changes`, etc. The seven read-side tools are surfaced via
# directTools so per-tool agents.json permissions work. Admin tools
# (index_repository, delete_project, manage_adr, index_status, list_projects,
# ingest_traces) stay behind the proxy `mcp` tool, gated by `"mcp": "ask"|
# "allow"` per role.

CBM_BIN=""
if command -v codebase-memory-mcp >/dev/null 2>&1; then
  CBM_BIN="$(command -v codebase-memory-mcp)"
elif [ -x "$HOME/.local/bin/codebase-memory-mcp" ]; then
  CBM_BIN="$HOME/.local/bin/codebase-memory-mcp"
fi

if [ -n "$CBM_BIN" ]; then
  echo "==> Registering codebase-memory-mcp with pi-mcp-adapter"
  echo "    binary: $CBM_BIN"
  MCP_CONFIG_DIR="$HOME/.config/mcp"
  MCP_CONFIG="$MCP_CONFIG_DIR/mcp.json"
  mkdir -p "$MCP_CONFIG_DIR"

  if [ ! -f "$MCP_CONFIG" ]; then
    echo '{"mcpServers": {}}' > "$MCP_CONFIG"
  fi

  # Validate JSON before merge — refuse to clobber a malformed file.
  if ! jq empty "$MCP_CONFIG" >/dev/null 2>&1; then
    echo "!! $MCP_CONFIG is not valid JSON — skipping codebase-memory-mcp registration."
    echo "   Fix the file and re-run install.sh, or add the server manually:"
    echo "     mcpServers.codebase_memory = {command: $CBM_BIN, ...}"
  else
    # Merge our entry; preserve everything else. Replace our key on re-runs
    # so updates to args/directTools propagate without leaving stale fields.
    tmp="$(mktemp)"
    jq --arg cmd "$CBM_BIN" '
      .mcpServers //= {} |
      .mcpServers.codebase_memory = {
        command: $cmd,
        args: [],
        lifecycle: "lazy",
        directTools: [
          "search_code",
          "search_graph",
          "trace_path",
          "detect_changes",
          "get_code_snippet",
          "get_architecture",
          "query_graph"
        ]
      }
    ' "$MCP_CONFIG" > "$tmp" && mv "$tmp" "$MCP_CONFIG"
    chmod 600 "$MCP_CONFIG"
    echo "    wrote $MCP_CONFIG (server key: codebase_memory; directTools: 7 read-side)"
  fi
else
  cat <<'CBM_HINT'
==> codebase-memory-mcp binary not found on \$PATH or at ~/.local/bin/.
    pi-ensemble's code-search doctrine assumes this tool is available.
    Install per upstream — typical one-liner:
      curl -fsSL https://raw.githubusercontent.com/DeusData/codebase-memory-mcp/main/install.sh | bash
    After installing, re-run ./install.sh from pi-ensemble to wire it into
    pi-mcp-adapter (user-global config at ~/.config/mcp/mcp.json).
CBM_HINT
fi

cat <<EOF

==> Install complete.

Next steps:
  - Smoke test: in any git repo, run \`pi\` and try \`/start\`.
  - See \`/ensemble-debug\` for the live configuration overview.
  - Configure subagent models with \`/ensemble-model\`.
  - Inside a project, run /mcp to confirm codebase_memory is connected (7 direct tools).
  - One-shot index per project on first use:
      mcp({tool: "codebase_memory_index_repository", args: '{"repo_path": "."}'})
    The file watcher keeps it current after that.
EOF
