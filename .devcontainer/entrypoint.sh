#!/usr/bin/env bash
#
# pi-rukas container entrypoint.
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
# Cache seed: a named volume mounted on /home/vscode/.cache MASKS the image's
# pre-fetched HF cache (Docker populates a volume only on first attach, so
# volumes from earlier builds stay empty). The entrypoint copies
# /opt/hf-cache-seed/ into place when the cache has no model, then asserts the
# files vipune opens — without them the first offline `vipune search` fails with
# "Failed to download embedding model".

set -eu

# -----------------------------------------------------------------------------
# Phase 1 (root): docker socket fixup, then drop to vscode and re-exec.
# -----------------------------------------------------------------------------
if [ "$(id -u)" = "0" ]; then
  # The wrapper bind-mounts /var/run/docker.sock by default
  # (opt out with PI_ENSEMBLE_NO_DOCKER_SOCKET=1). The socket lands
  # inside the container with whatever ownership the host
  # exposes. On Docker Desktop / many Linux hosts that's root-owned, which
  # leaves the vscode user (UID 1000) unable to connect. Relaxing to 666 is
  # safe inside the container: the container is a single trust domain anyway
  # (trust mode already strips per-call gating), and on the HOST side the
  # socket's normal perms are unchanged — we only modify the inode view
  # inside our container. Silenced if it fails (read-only mount edge cases).
  if [ -S /var/run/docker.sock ]; then
    chmod 666 /var/run/docker.sock 2>/dev/null || true
  fi
  # SSH agent-forward sanity check (post-#227). The wrapper bind-mounts the
  # host's $SSH_AUTH_SOCK to /run/host-ssh-auth.sock and forwards that path
  # in the container env. Two failure modes need handling:
  #   (a) Socket is a real socket but root-owned with restrictive perms
  #       (Linux hosts where the user's agent socket isn't world-writable).
  #       Same fix as docker.sock: chmod 666. Single-trust-domain container.
  #   (b) Mount destination ended up as a DIRECTORY, not a socket — happens
  #       when Docker can't resolve the host-side path as a usable socket at
  #       mount time. macOS Docker Desktop + launchd-managed agent paths
  #       (`/private/tmp/com.apple.launchd.<random>/Listeners`) are the
  #       canonical case. SSH would loop on "Error connecting to agent"
  #       even though on-disk keys at ~/.ssh/ would work fine. Unset
  #       SSH_AUTH_SOCK so SSH falls back cleanly. The `unset` propagates
  #       through the upcoming `exec env HOME=... setpriv ... "$0" "$@"`
  #       because `env HOME=...` only ADDS/OVERRIDES HOME — the rest of
  #       the env is inherited from this shell.
  if [ -n "${SSH_AUTH_SOCK-}" ]; then
    if [ -S "${SSH_AUTH_SOCK}" ]; then
      chmod 666 "${SSH_AUTH_SOCK}" 2>/dev/null || true
    else
      echo "pi-rukas: SSH_AUTH_SOCK=${SSH_AUTH_SOCK} is not a usable socket (likely a Docker Desktop on macOS bind-mount quirk); unsetting so SSH falls back to ~/.ssh/ on-disk keys." >&2
      unset SSH_AUTH_SOCK
    fi
  fi
  # Issue #933 — repair NAMED VOLUMES created root-owned by an older image.
  # When build_mounts() falls back to a named volume (host dir missing) or
  # mounts an always-on cache volume, and the mount point didn't exist in the
  # image at launch time, Docker creates the volume owned by root (755), which
  # the vscode user (UID 1000) can't write to — crashing pi on first launch in
  # a freshly-created sandbox, or breaking shell history in legacy volumes.
  #
  # We chown ONLY targets the launcher explicitly handed us via
  # PI_ENSEMBLE_VOLUME_MOUNTS (the container-side destinations of every named
  # volume it mounted, colon-separated) AND that appear on the hard-coded
  # allowlist below. A bind-mounted host directory is path-/socket-sourced and
  # is never on the list, so it can never be chowned here (a root-owned host
  # binding must stay untouched). Only directories that are actually
  # root-owned are changed; absence or empties mean no-op, so devcontainer.json
  # users (always bind mounts) and a bare `docker run` are unaffected.
  if [ -n "${PI_ENSEMBLE_VOLUME_MOUNTS-}" ]; then
    IFS=: read -r -a _vol_targets <<<"${PI_ENSEMBLE_VOLUME_MOUNTS}"
    for _t in "${_vol_targets[@]}"; do
      case "$_t" in
        /home/vscode/.pi/agent/sessions|/home/vscode/.pi/agent/ensemble-runs|/home/vscode/.pi/agent/review-state|/home/vscode/.vipune|/home/vscode/.cache|/home/vscode/.bun|/home/vscode/.cargo|/commandhistory) ;;
        *) continue ;;
      esac
      if [ -d "$_t" ] && [ "$(stat -c %u "$_t")" = "0" ]; then
        chown vscode:vscode "$_t"
      fi
    done
    unset _vol_targets _t
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
REVISION="5c38ec7c405ec4b44b94cc5a9bb96e735b38267a"

if [ -d "$SEED_DIR" ] && [ ! -d "$MODEL_DIR" ]; then
  mkdir -p "$CACHE_DIR"
  # cp -a (not cp -r): preserves the seed's modes, which is what the build's
  # assertion checked. No `|| true` and no stderr redirect: a seed that cannot be
  # copied means vipune has no model, so `set -e` fails the container here.
  cp -a "$SEED_DIR"/. "$CACHE_DIR"/
  # Assert the files vipune opens, after the copy. Each names the path it could
  # not find before `set -e` exits, so a boot failure says which part of the
  # seed is broken. `-f` as well as `-s`: a directory satisfies `-s`, and
  # refs/<revision> is what vipune's resolver opens to resolve the pinned
  # revision — its absence is the offline 404. `-s` on the snapshot entries
  # follows the symlink to the blob, so a link into the xet staging tree (which a
  # copy of hub/ cannot contain) fails rather than passing as a non-empty name.
  for _f in "refs/$REVISION" "snapshots/$REVISION/onnx/model.onnx" "snapshots/$REVISION/tokenizer.json"; do
    if [ ! -f "$MODEL_DIR/$_f" ] || [ ! -s "$MODEL_DIR/$_f" ]; then
      echo "pi-rukas: model seed is missing or empty: $MODEL_DIR/$_f" >&2
      exit 1
    fi
  done
  unset _f
fi

exec "$@"
