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
# Floor provenance: 0.84.4, decided by the operator 2026-08-29 (#578). It is
# the first release with the extension-message-order fix; 0.84.3 shipped with
# a live defect (extension messages inserted mid-tool-sequence, breaking
# message-order validation) that killed four consecutive /work cycles. The
# AGENTS.md §5 4-day embargo was deliberately overridden for this one bump
# because the known-bug window was actively breaking cycles on the author's
# host; future floor bumps follow the normal embargo.

set -o allexport
# The floor. Bump in one place; the drift gate keeps the README + Dockerfile
# in step.
MIN_PI_VERSION=0.84.4
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
  local floor_major="${MIN_PI_VERSION%%.*}"          # 0
  local floor_rest="${MIN_PI_VERSION#*.}"            # 84.4
  local floor_minor="${floor_rest%%.*}"              # 84
  local floor_patch="${floor_rest#*.}"               # 4

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

  echo "old:pi $ver is below the pi-ensemble minimum ${MIN_PI_VERSION} (0.84.3 ships a live bug in extension message ordering, fixed in 0.84.4 — see issue #578)"
  return 0
}

# Convenience predicate: 0 = at or above the floor (and present), 1 = not.
pi_floor_ok() {
  local status
  status="$(pi_preflight_status)"
  [ "$status" = "ok" ]
}

# Warn (never fail — install.sh is warn-only, never a hard gate) when
# pi-mcp-adapter is absent from BOTH known install layouts. Lives here next
# to the other preflight logic so install.sh stays under the 500-line
# limit; the rationale (Pi core has no native MCP, so without the bridge NO
# MCP server loads) is documented in the Dockerfile post-install check, and
# this mirror should stay in sync with it.
#
# The two layout paths are what actually exist:
#   $PI_AGENT_DIR/npm/node_modules/  — `pi install npm:<pkg>` layout
#   $PI_AGENT_DIR/extensions/        — git/local + extension-register layout
pi_bridge_warn() {
  local pi_agent_dir="${1:-$HOME/.pi/agent}"
  local ext_dir="$pi_agent_dir/extensions"
  if [ ! -e "$pi_agent_dir/npm/node_modules/pi-mcp-adapter" ] \
     && [ ! -e "$ext_dir/pi-mcp-adapter" ]; then
    echo ""
    echo "!! pi-mcp-adapter not found in $pi_agent_dir/npm/node_modules/"
    echo "   (pi install npm: layout) or $ext_dir (git/local layout)"
    echo "   — Pi core has no native MCP, so without the bridge"
    echo "   NO MCP server loads (including codebase_memory)."
    echo "   Install it with: pi install npm:pi-mcp-adapter   (README → Prerequisites)"
    echo "   and re-run ./install.sh."
    echo ""
  fi
}
