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
check_cmd colgrep      "https://github.com/lightonai/next-plaid"
check_cmd oo           "cargo install double-o  (https://github.com/randomm/oo)"
check_cmd parallel-cli "brew install parallel-web/tap/parallel-cli  (then: parallel-cli login)"

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

cat <<EOF

==> Install complete.

Next steps:
  - Smoke test: in any git repo, run \`pi\` and try \`/start\`.
  - See \`/ensemble-debug\` for the live configuration overview.
  - Configure subagent models with \`/ensemble-model\`.
EOF
