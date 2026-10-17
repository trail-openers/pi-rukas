#!/usr/bin/env bash
# Issue #1365 — the reporting half of verify-loop.sh, split out so each file
# stays under the AGENTS.md §12 500-line cap the `test-file-size-limit.ts` gate
# enforces. The seam is the one the code already had: verify-loop.sh runs the
# tests and collects per-job captures; everything below decides what the run
# PRINTS. Nothing here touches execution, the pool, or the watchdog.
#
# Sourced by verify-loop.sh after the run has drained, so it reads the state
# that file built: `names` (failing test paths, in argument order),
# `_extra_captures` (each failing test's saved capture, index-aligned with
# `names` — a capture that could not be copied is an empty placeholder so the
# pairing never shifts), `$DIGEST`, and `$total` (tests that actually ran).
#
# Contract this half owns — the pinned part of verify-loop.sh's header:
#
#   * normal mode: the `FAILED: <n> test(s) — <list>` summary, then each
#     failing test's `✗` lines echoed after it (the #827 tail, bounded 3×200);
#   * digest mode: per-failure `FAILED:` markers, each test's every `✗` line
#     with its indented detail, the summary, then the `P:`/`F:` tally;
#   * on all-pass, digest mode prints exactly one line, `P: <n>  F: 0`, and
#     normal mode prints nothing;
#   * exit 1 with failures, 0 without — identical between the two modes.
#
# The ✗ line-start anchor is the one shared, pinned filter rule (see the
# header of verify-loop.sh); the rest of this file is implementation-local.
#
# The `…and <m> more` collapse and the 780-char budget exist because the
# driver's extractAttributedTail window is 800 chars at its tightest call site;
# the sizing rationale lives with the call sites in work-driver-exec-error.ts.

# emit_tally <pass-count> <fail-count> — the pass/fail line, the one emitter
# for both digest paths (failure and all-pass).
emit_tally() {
  echo "P: $1  F: $2"
}

# report_results <total> — print the summary, the digest or the #827 echo, and
# exit with the run's verdict. Reads `names`, `_extra_captures` and `$DIGEST`
# from the caller rather than taking them as arguments: they are one index-aligned
# triple that only makes sense together, and passing three parallel arrays
# through a bash signature is how they get un-paired.
report_results() {
  local total="$1" name sep summary budget emitted cap capfile line i in_block

  if [ "${#names[@]}" -eq 0 ]; then
    if [ "$DIGEST" -eq 1 ]; then
      emit_tally "$total" 0
    fi
    exit 0
  fi

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

  if [ "$DIGEST" -eq 1 ]; then
    # #1028 — digest mode: emit per-failure markers, every ✗ line with its
    # indented detail, then the summary. The 3×200 bound from normal mode's
    # #827 echo does NOT apply here — the digest is the full failure detail.
    # names and _extra_captures are pushed in lockstep (a cp failure pushes an
    # empty placeholder), so index $i of each array is the same test.
    # Filter contract (shared with the #827 tail, see verify-loop.sh header):
    # a line is kept when it is a `✗` marker at line start, or when it is an
    # indented detail line (leading whitespace) following a kept ✗ marker; the
    # indented-detail attribution stops at the first non-indented line.
    # Pass/fail counts + exit code are printed below: `FAILED:` is the
    # canonical failure-count marker (extractAttributedTail anchors on it),
    # the `P`/`F` tally is the pass/fail summary the acceptance criteria
    # name, and the exit code (0 all-pass / 1 any failure) is identical to
    # normal mode.
    for i in "${!names[@]}"; do
      echo "FAILED: ${names[$i]}"
      capfile="${_extra_captures[$i]:-}"
      if [ -n "$capfile" ] && [ -f "$capfile" ]; then
        in_block=0
        while IFS= read -r line; do
          if [[ "$line" == "✗ "* ]]; then
            echo "$line"
            in_block=1
            continue
          fi
          if [ "$in_block" -eq 1 ]; then
            # Indented detail lines belong to the most recent ✗ block.
            if [[ "$line" =~ ^[[:space:]]+ ]]; then
              echo "$line"
              continue
            else
              in_block=0
            fi
          fi
          # Everything else (✓ lines, noise, passing output) is dropped.
        done < "$capfile"
      fi
    done
    echo "$summary"
    emit_tally "$((total - ${#names[@]}))" "${#names[@]}"
    exit 1
  fi

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
  # #1365 — the verdict is the count, not the status that happens to be
  # current. report_results is the only intended exit path and it `exit 1`s on
  # failure, but a half that returned instead of exiting would let the caller
  # fall through at exit 0 with `FAILED: N test(s)` as the last line the operator
  # read (observed on a full-suite run: two failures named, process exited 0).
  # Deriving the status from `names` — the array the summary is built from —
  # makes the marker and the exit code one fact that cannot disagree.
  [ "${#names[@]}" -eq 0 ] || exit 1
  exit 0
}
