#!/usr/bin/env bash
# pi-ensemble install preflight — source-able helpers for install.sh.
#
# Sourced by install.sh (not executed) so the version floor and its check
# are testable in isolation (smoke test: test-pi-min-version.ts) the way the
# OS guard's classify_os is (test-os-guard.ts): the test extracts these
# functions by regex and drives them against faked `pi --version` output.
# This file performs no side effects on source — it only defines functions.
#
# Why a file instead of inline in install.sh (#578):
#
#   * install.sh sits against the 500-line hard limit (test-file-size-limit.ts),
#     so the new logic lands next to it, not in it.
#   * The floor is the SINGLE SOURCE OF TRUTH for the minimum Pi version
#     across every install surface. install.sh reads it from here;
#     test-prerequisite-drift.ts and test-pi-min-version.ts parse it from
#     here; the README install line and the Dockerfile pin are cross-checked
#     against it. No other file may hardcode the value.
#
# Floor provenance: 1.0.0, decided by the operator 2026-10-02 (issue #959).
# Pi 1.0.0 (2026-10-01) is the first release of the 1.x line — native MCP
# (mcp.json) plus `--no-extensions` also disabling built-in extensions, which
# the subagent spawn path compensates for with `-e builtin:mcp` (CHILD_ARGS_BASE
# in spawn-support.ts). The 4-day npm embargo was deliberately overridden for
# this upgrade (operator decision 2026-10-02; supply-chain check done — see
# extension/bunfig.toml minimumReleaseAgeExcludes).

set -o allexport
# The floor. Bump in one place; the drift gate keeps the README + Dockerfile
# in step.
MIN_PI_VERSION=1.0.0
# The oo (double-o) floor. 0.5.0 is the newest release that cleared the
# 4-day embargo as of /work time (0.6.0 released 2026-09-10, only 1 day old
# — pin it after 2026-09-14). See issue #715.
MIN_OO_VERSION=0.5.0
set +o allexport

# Parse the MAJOR.MINOR.PATCH prefix of a `pi --version` output into three
# globals: PI_VER_MAJOR, PI_VER_MINOR, PI_VER_PATCH.
#
# The first whitespace-separated token is the version; anything after it
# (channel tags, build suffixes) is ignored — version strings from pi
# releases carry none today, but the parser must tolerate them. `pi
# --version` on a healthy install always prints something, so a blank
# output is a broken install and must fail CLOSED, not assume latest.
#
# On success prints nothing and returns 0; on unparseable input prints
# nothing and returns 1 (PI_VER_* are unset).
parse_pi_version() {
  local tok
  if [ -z "${1// /}" ]; then
    unset PI_VER_MAJOR PI_VER_MINOR PI_VER_PATCH
    return 1
  fi
  tok="$(printf '%s' "$1" | awk '{print $1}')"
  if [[ ! "$tok" =~ ^[0-9]+\.[0-9]+\.[0-9]+$ ]]; then
    unset PI_VER_MAJOR PI_VER_MINOR PI_VER_PATCH
    return 1
  fi
  IFS='.' read -r PI_VER_MAJOR PI_VER_MINOR PI_VER_PATCH <<<"$tok"
  return 0
}

# Preflight status of the Pi CLI against MIN_PI_VERSION. Prints exactly one
# status line:
#
#   "ok"              — pi at or above the floor
#   "missing"         — pi not on PATH (install hint applies)
#   "old:<reason>"    — pi present but below the floor; reason names the
#                       floor and why it exists (operator-facing)
#   "unparseable:<output>" — `pi --version` gave no parseable
#                       MAJOR.MINOR.PATCH. Fails CLOSED: we never assume
#                       latest.
#
# Test seams (never set by install.sh): PI_BIN names the binary to probe
# (default: pi); PI_VER_OVERRIDE skips the probe entirely and uses the given
# value as the faked version string.
pi_preflight_status() {
  local bin="${PI_BIN:-pi}"
  local ver
  if [ -n "${PI_VER_OVERRIDE+set}" ]; then
    ver="$PI_VER_OVERRIDE"
  else
    if ! command -v "$bin" >/dev/null 2>&1; then
      echo "missing"
      return 0
    fi
    ver="$("$bin" --version 2>/dev/null || true)"
  fi

  if ! parse_pi_version "$ver"; then
    echo "unparseable:${ver}"
    return 0
  fi

  # MAJOR.MINOR.PATCH is pi's release grammar, so per-field numeric compare
  # is a correct semver compare without pre-release handling. No `10#` base
  # prefix here: the floor fields come from our own decimal source and have
  # no leading zeros, so plain arithmetic expansion is correct and `10#`
  # would be actively wrong — bash `10#84` parses as octal-ish and returns
  # 68, which made 0.9.0 "fail" against floor 0.84.4.
  local floor_major="${MIN_PI_VERSION%%.*}"          # 1
  local floor_rest="${MIN_PI_VERSION#*.}"            # 0.0
  local floor_minor="${floor_rest%%.*}"              # 0
  local floor_patch="${floor_rest#*.}"               # 0

  if [ "$((10#$PI_VER_MAJOR))" -gt "$floor_major" ]; then
    echo "ok"
    return 0
  fi
  if [ "$((10#$PI_VER_MAJOR))" -eq "$floor_major" ]; then
    if [ "$((10#$PI_VER_MINOR))" -gt "$floor_minor" ]; then
      echo "ok"
      return 0
    fi
    if [ "$((10#$PI_VER_MINOR))" -eq "$floor_minor" ] \
       && [ "$((10#$PI_VER_PATCH))" -ge "$floor_patch" ]; then
      echo "ok"
      return 0
    fi
  fi

  echo "old:pi $ver is below the pi-ensemble minimum ${MIN_PI_VERSION} (1.0.0 is the first line with native MCP and `-e builtin:mcp` re-enabling under `--no-extensions` — required since issue #959)"
  return 0
}

# Convenience predicate: 0 = at or above the floor (and present), 1 = not.
pi_floor_ok() {
  local status
  status="$(pi_preflight_status)"
  [ "$status" = "ok" ]
}

# Parse the MAJOR.MINOR.PATCH prefix of `oo version` output into three
# globals: OO_VER_MAJOR, OO_VER_MINOR, OO_VER_PATCH.
#
# `oo version` prints "oo 0.5.0" — the binary name is the FIRST token, the
# version is the SECOND. Anything after the version token is ignored.
# Unparseable output returns 1 (OO_VER_* unset) — fails CLOSED.
parse_oo_version() {
  local tok
  if [ -z "${1// /}" ]; then
    unset OO_VER_MAJOR OO_VER_MINOR OO_VER_PATCH
    return 1
  fi
  tok="$(printf '%s' "$1" | awk '{print $2}')"
  if [[ ! "$tok" =~ ^[0-9]+\.[0-9]+\.[0-9]+$ ]]; then
    unset OO_VER_MAJOR OO_VER_MINOR OO_VER_PATCH
    return 1
  fi
  IFS='.' read -r OO_VER_MAJOR OO_VER_MINOR OO_VER_PATCH <<<"$tok"
  return 0
}

# Preflight status of the oo CLI against MIN_OO_VERSION. Prints exactly one
# status line (same contract as pi_preflight_status):
#
#   "ok"                 — oo at or above the floor
#   "missing"            — oo not on PATH
#   "old:<reason>"       — oo present but below the floor
#   "unparseable:<out>"  — `oo version` gave no parseable MAJOR.MINOR.PATCH
#
# Test seams: OO_BIN (default: oo), OO_VER_OVERRIDE.
oo_preflight_status() {
  local bin="${OO_BIN:-oo}"
  local ver
  if [ -n "${OO_VER_OVERRIDE+set}" ]; then
    ver="$OO_VER_OVERRIDE"
  else
    if ! command -v "$bin" >/dev/null 2>&1; then
      echo "missing"
      return 0
    fi
    ver="$("$bin" version 2>/dev/null || true)"
  fi

  if ! parse_oo_version "$ver"; then
    echo "unparseable:${ver}"
    return 0
  fi

  local floor_major="${MIN_OO_VERSION%%.*}"
  local floor_rest="${MIN_OO_VERSION#*.}"
  local floor_minor="${floor_rest%%.*}"
  local floor_patch="${floor_rest#*.}"

  if [ "$((10#$OO_VER_MAJOR))" -gt "$floor_major" ]; then
    echo "ok"; return 0
  fi
  if [ "$((10#$OO_VER_MAJOR))" -eq "$floor_major" ]; then
    if [ "$((10#$OO_VER_MINOR))" -gt "$floor_minor" ]; then
      echo "ok"; return 0
    fi
    if [ "$((10#$OO_VER_MINOR))" -eq "$floor_minor" ] \
       && [ "$((10#$OO_VER_PATCH))" -ge "$floor_patch" ]; then
      echo "ok"; return 0
    fi
  fi

  echo "old:oo ${ver} is below the pi-ensemble minimum ${MIN_OO_VERSION} (0.3.1 lacks the npm/pnpm/yarn/bun test+build compression patterns added in 0.5.0 — see issue #715)"
  return 0
}

# Convenience predicate: 0 = at or above the floor (and present), 1 = not.
oo_floor_ok() {
  local status
  status="$(oo_preflight_status)"
  [ "$status" = "ok" ]
}

# Migrate (never fail — install.sh is warn-only, never a hard gate) any
# leftover pi-mcp-adapter out of the two known install layouts. On Pi 1.0+
# an installed extension that registers /mcp REPLACES native MCP for the
# whole session, so a lingering adapter would silently disable the mcp.json
# wiring install.sh writes (see install.sh §6). Native MCP makes the bridge
# obsolete, and removing it is the migration step — this function is the
# mirror of the `pi remove pi-mcp-adapter` calls install.sh runs below, and
# the fallback for hosts where the `pi` binary's remove verb differs (the
# layouts below cover `pi install npm:<pkg>` and git/local installs).
#
# The two layout paths are what actually exist:
#   $PI_AGENT_DIR/npm/node_modules/pi-mcp-adapter  — `pi install npm:<pkg>` layout
#   $PI_AGENT_DIR/extensions/pi-mcp-adapter        — git/local + extension-register layout
pi_mcp_remove() {
  local pi_agent_dir="${1:-$HOME/.pi/agent}"
  local npm_layout="$pi_agent_dir/npm/node_modules/pi-mcp-adapter"
  local ext_layout="$pi_agent_dir/extensions/pi-mcp-adapter"
  if [ -e "$npm_layout" ]; then
    echo "==> Removing legacy pi-mcp-adapter (npm layout): $npm_layout"
    rm -rf "$npm_layout"
  fi
  if [ -e "$ext_layout" ]; then
    echo "==> Removing legacy pi-mcp-adapter (extensions layout): $ext_layout"
    rm -rf "$ext_layout"
  fi
}
