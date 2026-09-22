#!/usr/bin/env bash
# Issue #803 — run-all offline smoke-test loop.
#
# Shared implementation of the smoke-test loop carried in three places
# (`.pi/verify-cmd`, `.github/workflows/ci.yml`, AGENTS.md §1). The old shape
# `bun "$t" >/dev/null || { echo "FAILED: $t"; bun "$t"; exit 1; }` exited on
# the FIRST failure, so every later-sorted test was silently skipped — and
# double-ran the failing one. This runs EVERY test exactly once, prints a
# `FAILED: <file>` marker plus the test's own output for each failure (the
# marker contract pinned by test-exec-error-attribution.ts), and ends with a
# single summary marker on the FINAL line of the run:
#
#   FAILED: <n> test(s) — <name1>, <name2>, ...
#
# The summary is the last `^FAILED: .+$` line in the stream, so the
# driver's tail-anchored truncation (extractAttributedTail) keeps it. The
# name list is capped so the whole line fits 800 chars — the smallest maxLen
# any extractAttributedTail call site uses — emitting as many names as fit
# plus `…and <m> more` for the rest.
#
# Usage: verify-loop.sh <file> [<file> ...]
#   The caller expands the glob; the script receives the file list.
#   Live tests (suffix -live.ts) are skipped, matching the legacy
#   `case "$t" in *-live.ts) continue;; esac` exclusion.

set -u

if [ "$#" -eq 0 ]; then
  echo "usage: verify-loop.sh <file> ..." >&2
  exit 2
fi

# Single-execution capture (DECISION 3): every test runs exactly once; its
# output is captured to a temp file that is removed on every exit path.
CAPTURE="$(mktemp "${TMPDIR:-/tmp}/verify-loop.XXXXXX")" || exit 2
trap 'rm -f "$CAPTURE"' EXIT

names=()
for t in "$@"; do
  case "$t" in *-live.ts) continue;; esac
  if bun run "$t" >"$CAPTURE" 2>&1; then
    cat "$CAPTURE"
  else
    names+=("$t")
    echo "FAILED: $t"
    cat "$CAPTURE"
  fi
done

if [ "${#names[@]}" -gt 0 ]; then
  # Build `FAILED: <n> test(s) — <list>`, capping the name list so the whole
  # line fits the 800-char tail budget. Names that no longer fit are
  # collapsed to `…and <m> more` so the count survives even when the list
  # itself cannot.
  summary="FAILED: ${#names[@]} test(s) —"
  # Reserve 20 chars for the `…and NNN more` suffix.
  budget=780
  emitted=0
  for name in "${names[@]}"; do
    if [ "$emitted" -eq 0 ]; then
      sep=" "
    else
      sep=", "
    fi
    if [ $(( ${#summary} + ${#sep} + ${#name} )) -gt "$budget" ]; then
      summary="$summary… and $(( ${#names[@]} - emitted )) more"
      break
    fi
    summary="$summary$sep$name"
    emitted=$((emitted + 1))
  done
  echo "$summary"
  exit 1
fi
exit 0
