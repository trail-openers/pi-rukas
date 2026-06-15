#!/usr/bin/env bash
#
# pi-ensemble container entrypoint.
#
# Runs as root briefly to do one-time fixups that need it (currently just
# relaxing the host docker socket perms when bind-mounted), then drops to
# the vscode user via `setpriv` for the rest of boot + the user's command.
# Self re-entry pattern: root branch exec's setpriv back into this same
# script as vscode, which then skips the root-only block.
#
# Why setpriv vs sudo: Debian's sudo default `secure_path` clobbers PATH,
# stripping /usr/local/cargo/bin (and any other custom PATH the image set
# via ENV). setpriv preserves env verbatim; we re-set HOME explicitly so
# the vscode-phase cache logic writes to /home/vscode/.cache/, not /root/.
#
# Why re-entry vs forking child scripts: keeps all entrypoint logic in one
# file so future maintainers see the boot sequence top-to-bottom without
# chasing through helper scripts.
#
# Cache-seed history: when the wrapper or devcontainer.json mounts a named
# volume on /home/vscode/.cache, that volume MASKS the image's pre-fetched
# HF cache (Docker volume init only fires on first attach — existing volumes
# from prior image builds stay empty). Without this script, vipune would try
# to download BAAI/bge-small-en-v1.5 on every fresh container start and fail
# with "Failed to download embedding model" (vipune's HTTP client 404s on
# the pinned revision). Seed the cache from /opt/hf-cache-seed/ if missing.

set -eu

# -----------------------------------------------------------------------------
# Phase 1 (root): docker socket fixup, then drop to vscode and re-exec.
# -----------------------------------------------------------------------------
if [ "$(id -u)" = "0" ]; then
  # When the wrapper bind-mounts /var/run/docker.sock (PI_ENSEMBLE_DOCKER_SOCKET=1),
  # the socket lands inside the container with whatever ownership the host
  # exposes. On Docker Desktop / many Linux hosts that's root-owned, which
  # leaves the vscode user (UID 1000) unable to connect. Relaxing to 666 is
  # safe inside the container: the container is a single trust domain anyway
  # (trust mode already strips per-call gating), and on the HOST side the
  # socket's normal perms are unchanged — we only modify the inode view
  # inside our container. Silenced if it fails (read-only mount edge cases).
  if [ -S /var/run/docker.sock ]; then
    chmod 666 /var/run/docker.sock 2>/dev/null || true
  fi
  # setpriv (util-linux, baked into image) preserves env verbatim — no PATH
  # stripping like sudo's secure_path. --init-groups initialises supplementary
  # groups for vscode. Explicit HOME=/home/vscode so the vscode-phase HF cache
  # logic writes to the right dir (otherwise inherits root's HOME=/root).
  exec env HOME=/home/vscode setpriv --reuid=vscode --regid=vscode --init-groups -- "$0" "$@"
fi

# -----------------------------------------------------------------------------
# Phase 2 (vscode): HF cache seed + exec user command.
# -----------------------------------------------------------------------------
CACHE_DIR="${HOME}/.cache/huggingface"
SEED_DIR="/opt/hf-cache-seed"
MODEL_DIR="${CACHE_DIR}/hub/models--BAAI--bge-small-en-v1.5"

if [ -d "$SEED_DIR" ] && [ ! -d "$MODEL_DIR" ]; then
  mkdir -p "$CACHE_DIR"
  # cp -rn: don't overwrite anything the user already has cached. Errors
  # silenced because the cache dir may contain partial state from prior
  # vipune runs that left a malformed download — we don't want entrypoint
  # to fail the whole boot for a cache hiccup.
  cp -rn "$SEED_DIR"/. "$CACHE_DIR"/ 2>/dev/null || true
fi

exec "$@"
