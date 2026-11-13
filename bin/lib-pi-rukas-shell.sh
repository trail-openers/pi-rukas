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

# >>> glab-config (extracted by extension/smoke-tests/test-sandbox-glab-config-mount.ts)
# glab config continuity — the image ships glab, so the host's glab config dir
# is bind-mounted read-only the way the gh config dir is. GitLab auth itself is
# NOT handled here: it is the host-provided `GITLAB_TOKEN` (with `GITLAB_HOST`),
# forwarded once by build_env's wholesale passthrough. Nothing here probes glab
# for a secret — glab has no token-printing subcommand, so a keychain-only host
# login cannot reach the container and `export GITLAB_TOKEN` is the documented
# remedy (docs/sandbox.md). No PI_ENSEMBLE_* knob is added: like the gh bind,
# the mount exists because the host dir exists, or not at all.

# The container-side target, written as a literal like the gh mount row does, so
# the container home never depends on the host's $HOME.
_GLAB_CONTAINER_DIR="/home/vscode/.config/glab-cli"

# Absolute-only resolution (mirrors the gh-config resolver in the extension's
# operator-config guard): an override that is empty or relative is IGNORED,
# because run_container classifies a mount source containing no `/` as a NAMED
# VOLUME — a relative GLAB_CONFIG_DIR would land on PI_ENSEMBLE_VOLUME_MOUNTS
# and be handed to the entrypoint's ownership repair.
_glab_config_dir() {
  case "${GLAB_CONFIG_DIR-}" in
    /*) printf '%s' "$GLAB_CONFIG_DIR"; return ;;
  esac
  case "${XDG_CONFIG_HOME-}" in
    /*) printf '%s/glab-cli' "$XDG_CONFIG_HOME"; return ;;
  esac
  printf '%s/.config/glab-cli' "$HOME"
}

# build_glab_mount — append the glab bind to the caller's `mounts` array, only
# when the resolved host dir exists. No dir: no row, and build_glab_env then
# exports nothing, leaving the container's own default in force.
build_glab_mount() {
  local dir
  dir="$(_glab_config_dir)"
  [ -d "$dir" ] || return 0
  mounts+=(-v "$dir:${_GLAB_CONTAINER_DIR}:ro")
}

# build_glab_env — append the container-side GLAB_CONFIG_DIR to the caller's
# `envs` array, but only when the host dir was actually mounted: the variable
# claims that a config tree exists at that path, so it ships with the mount row
# or not at all. Appended AFTER build_env's passthrough loop (that is where the
# caller invokes this), so the container path wins over a host export of the
# same name.
build_glab_env() {
  [ -d "$(_glab_config_dir)" ] || return 0
  envs+=(-e "GLAB_CONFIG_DIR=${_GLAB_CONTAINER_DIR}")
}
# <<< glab-config

# Repair the host terminal after `docker run -it`. Pi inside the container runs
# in TUI mode (alt-screen + raw input + hidden cursor). If the container exits
# abruptly (OOM-kill, segfault, dispatch_lens_review fanout overrun, etc.), Pi
# never gets a chance to exit alt-screen / restore terminal modes, and the host
# shell is left corrupted: typing produces "weird UTF-8 characters", the cursor
# is invisible, scrollback is gone. These commands are all no-ops on a clean
# terminal, so safe on every exit path; only fires when stdout is a TTY.
repair_tty() {
  if [ -t 1 ]; then
    stty sane 2>/dev/null || true
    tput rmcup 2>/dev/null || true   # exit alt-screen
    tput cnorm 2>/dev/null || true   # show cursor
  fi
}

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

# cmd_run — `pi-rukas run work N…` execs the headless runner (#1024). The
# runner ships in the image next to this script; absent it, exit 40 with a JSON
# error on stdout naming the rebuild.
cmd_run() {
  local bin="$PI_RUKAS_DIR/pi-rukas-headless"
  if [ ! -x "$bin" ]; then
    command -v pi-rukas-headless >/dev/null 2>&1 || {
      echo '{"error":{"code":"headless-runner-missing","message":"pi-rukas-headless not found; rebuild the image (pi-rukas rebuild)"}}'
      exit 40
    }
    bin="pi-rukas-headless"
  fi
  shift
  exec "$bin" "$@"
}
