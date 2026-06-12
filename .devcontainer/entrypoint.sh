#!/usr/bin/env bash
#
# pi-ensemble container entrypoint.
#
# When the wrapper or devcontainer.json mounts a named volume on
# /home/vscode/.cache, that volume MASKS the image's pre-fetched HF cache
# (Docker volume init only fires on first attach — existing volumes from
# prior image builds stay empty). Without this script, vipune would try
# to download BAAI/bge-small-en-v1.5 on every fresh container start and
# fail with "Failed to download embedding model" (vipune's HTTP client
# 404s on the pinned revision).
#
# Fix: if /opt/hf-cache-seed/ exists in the image AND ~/.cache/huggingface/
# is missing the model files, seed the cache. Cheap when already populated
# (skip), one-time copy when needed (~127 MB).
#
# Then exec whatever command was passed (default: `pi`, per Dockerfile CMD).

set -eu

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
