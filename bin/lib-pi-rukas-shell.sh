#!/usr/bin/env bash
#
# pi-rukas shell helpers — sourced by bin/pi-rukas. Holds non-entrypoint
# (common) subcommand bodies so bin/pi-rukas stays under the 500-line gate.
# See AGENTS.md §12 (file-size limit). No standalone CLI; source me only.
#
# All functions rely on bin/pi-rukas globals (BASE_NAME, IMAGE, …) and helpers
# (require_docker); they are bound against the enclosing shell at call time, so
# definition-order vs bin/pi-rukas does not matter as long as the reference is
# resolved before dispatch.

# cmd_prune — remove the shared named sandbox caches. Does NOT touch
# bind-mounted host state (vipune, transcripts, model picks). Uses the
# hardcoded volume set from build_mounts; keep in sync.
cmd_prune() {
  require_docker
  echo "This removes shared sandbox caches (codebase-memory-mcp index,"
  echo "bun/cargo caches, shell history). Bind-mounted host state"
  echo "(vipune, transcripts, model picks) is NOT affected."
  read -r -p "Continue? [y/N] " ans
  case "$ans" in
    y|Y|yes) ;;
    *) echo "Cancelled"; exit 0 ;;
  esac
  for vol in pi-ensemble-cache pi-ensemble-bun-cache pi-ensemble-cargo-cache pi-ensemble-history; do
    docker volume rm "$vol" 2>/dev/null && echo "removed $vol" || echo "skip $vol (not present or in use)"
  done
}
