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
# single summary marker:
#
#   FAILED: <n> test(s) — <name1>, <name2>, ...
#
# The summary is the last `^FAILED: .+$` line in the stream, so the
# driver's tail-anchored truncation (extractAttributedTail) keeps it. The
# name list is capped so the whole line fits 800 chars — the smallest maxLen
# any extractAttributedTail call site uses — emitting as many names as fit
# plus `…and <m> more` for the rest.
#
# #827 (echo of failing `✗` lines after the summary): why this exists and why
# the 3×200 bound is sized the way it is is commented at the echo loop below.
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
trap 'rm -f "$CAPTURE" ${_extra_captures[*]:-}' EXIT
_extra_captures=()

names=()
for t in "$@"; do
  case "$t" in *-live.ts) continue;; esac
  if bun run "$t" >"$CAPTURE" 2>&1; then
    cat "$CAPTURE"
  else
    names+=("$t")
    echo "FAILED: $t"
    cat "$CAPTURE"
    # #827 — keep this test's capture so its `✗` lines can be repeated
    # after the summary (below); removed on exit like $CAPTURE.
    capfile="$(mktemp "${TMPDIR:-/tmp}/verify-loop.XXXXXX")" || exit 2
    if ! cp "$CAPTURE" "$capfile"; then
      # Capture failed — degrade gracefully: the test has already failed and
      # its per-test output was printed above, so a missing echo is a
      # cosmetic gap in the tail, not a new failure. Do NOT register the
      # capfile, so the echo loop below skips it.
      echo "warn: verify-loop: could not capture output of $t for the tail echo; its ✗ lines will be absent from the summary tail" >&2
      rm -f "$capfile"
    else
      _extra_captures+=("$capfile")
    fi
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
  # #827 — repeat each failing test's `✗` lines AFTER the summary. WHY: the
  # driver's marker-anchored tail window (extractAttributedTail in
  # work-driver-exec-error.ts, maxLen=800 — the smallest of its call sites)
  # keeps only what comes at/after the LAST `FAILED:` marker, so with per-test
  # output first and the summary last, a failing test's real `✗` assertion
  # lines sat thousands of chars BEFORE the summary and were elided out of
  # every consumer's window (the #772 shape). Repeating them here, inside the
  # window, is what makes the tail name the actual assertion; the per-test
  # output above remains the full first occurrence, this is a bounded echo.
  # The bound (first 3 ✗ lines per test, each truncated to 200 chars) keeps
  # a single failing test's echo inside that 800-char window; with several
  # failing tests the consumer (extractAttributedTail) keeps the summary
  # marker line plus the LAST part of the echo, eliding the middle — so at
  # least the last failing test's assertion lines are guaranteed in the
  # tail. Only `✗` lines qualify — warnings (`!`
  # lines) and other output are intentionally excluded.
  for capfile in "${_extra_captures[@]}"; do
    cap=0
    while IFS= read -r line; do
      cap=$((cap + 1))
      if [ "$cap" -gt 3 ]; then
        break
      fi
      if [ ${#line} -gt 200 ]; then
        line="${line:0:199}…"
      fi
      echo "$line"
    done < <(grep -F -- "✗" "$capfile" || true)
  done
  exit 1
fi
exit 0
