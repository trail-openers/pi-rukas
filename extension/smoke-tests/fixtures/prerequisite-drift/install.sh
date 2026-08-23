#!/usr/bin/env bash
# Canary fixture for test-prerequisite-drift.ts — NOT a runnable installer.
# Deliberately declares jq in REQUIRED_CLIS while the fixture README omits
# it, so the forward direction MUST flag jq.
set -euo pipefail

missing=()
check_cmd() {
  local cmd="$1"
  local hint="$2"
  if ! command -v "$cmd" >/dev/null 2>&1; then
    missing+=("$cmd — $hint")
  fi
}

REQUIRED_CLIS=(
  "pi:bun add -g @earendil-works/pi-coding-agent"
  "git:OS package manager"
  "jq:brew install jq"
)
for entry in "${REQUIRED_CLIS[@]}"; do
  check_cmd "${entry%%:*}" "${entry#*:}"
done
