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
# Shared digest-filter contract (the enforced, pinned part, #1028): the only
# shared, pinned contract is the ✗ line-start anchor — the --digest branch
# anchors only on `✗ ` (with the indented detail lines that follow a kept ✗),
# while the #827 tail keeps ✗-containing lines via `grep -F "✗"` (so a line
# containing ✗ anywhere, not only at line start, is kept there).
# Everything else is implementation-local: ci-log-digest.sh additionally keeps
# ##[error] / error: / FAILED: marker lines (not part of the shared contract),
# and indented-detail attribution is deliberately NOT part of the shared
# contract and allowed to differ: the #827 tail is bounded (first 3 ✗ lines
# per test, 200 chars each) for the 800-char extractAttributedTail window,
# the digests are unbounded, and verify-loop.sh's --digest branch attributes
# detail to ✗ markers only while ci-log-digest.sh attributes it to any kept
# anchor. The summary `FAILED: N test(s)` line and the `P:/F:` tally are
# global lines that follow all per-test blocks in the --digest output.
#
# Usage:
#   verify-loop.sh <file> [<file> ...]           — normal mode
#   verify-loop.sh --digest <file> [<file> ...] — #1028 digest mode
#
# Normal mode: runs every test once, prints each test's full output plus a
# per-failure `FAILED: <file>` marker and a final summary line.
#
# Digest mode (--digest): prints ONLY the failure detail — per-failure
# markers, each failing test's ✗ lines with their indented detail lines, the
# summary marker, and a pass/fail tally line (P: <pass-count>  F:
# <fail-count>). P counts every non-live test that was not a failure — i.e.
# the passing tests (live tests are skipped and count toward neither P nor
# F). No ✓ lines, no passing tests' output. Exit codes are identical to
# normal mode (0 all-pass, 1 any failure, 2 usage error), so the gate can
# switch call sites to --digest without a separate exit-code path.
# The #827 echo of the first 3 ✗ lines (truncated to 200 chars) does NOT
# apply in digest mode — the digest prints EVERY ✗ line and its indented
# detail, because the 3×200 bound was sized for the 800-char
# extractAttributedTail window, not for a full digest.
#
# Digest mode prints NOTHING on all-pass (exit 0). Callers must distinguish
# pass from no-output by exit code (0 = pass), not by stdout presence.
#
# The caller expands the glob; the script receives the file list.
# Live tests (suffix -live.ts) are skipped in both modes, matching the legacy
# `case "$t" in *-live.ts) continue;; esac` exclusion.

set -u

# #1017 — forbid live spawns in every offline test. Any offline test that
# reaches the real spawn path (spawnSpecialist) fails loudly in ~5s with the
# FORBID_LIVE_SPAWN error naming the role and the injection point, instead of
# silently burning real model tokens and stalling the suite. Live tests
# (*-live.ts) are skipped before this matters, and a test that needs a (fake)
# child sets PI_ENSEMBLE_ALLOW_LIVE_SPAWN=1 locally. The canary
# (test-verify-loop.ts case 8 + fixture-spawn-env.ts) proves this export
# reaches the child env.
export PI_ENSEMBLE_FORBID_LIVE_SPAWN=1

# #1069 — the per-clone review ledger lives under the git common dir, and a
# worktree's common dir resolves to the main clone's .git. Every test that
# calls a ledger writer seam (runLensReview / runAdversarialLoop /
# appendLedgerEntry / writeLensLedgerEntry / writeAdversarialLedgerEntry /
# finishLensReview) must self-isolate via ONE of:
#   - an explicit `PI_ENSEMBLE_REVIEW_LEDGER_FILE=<abs-temp>` set at the top
#     of the test file (honouring an already-set value, e.g. an operator's),
#   - a temp git repo as the write cwd (the writer keys its file on the
#     common dir of the CWD it is given, so the write lands in the temp dir),
#   - a mocked `appendLedgerEntry` (the file mocks the seam before importing
#     the lens modules, so the real writer never runs).
# `test-ledger-isolation.ts` enforces this statically: it scans every
# `smoke-tests/test-*.ts` and fails naming any file that calls a seam without
# an isolation marker. The gate does NOT export the override globally — the
# ledger tests (test-review-ledger*.ts, test-review-ledger-973.ts) use temp
# repos and their writer must write to the temp repo's git dir, not a shared
# env-var path.

# --- #1014 — per-test timeout watchdog.
#
# Each test is bounded at ${PI_ENSEMBLE_VERIFY_TEST_TIMEOUT_S:-300} seconds.
#
# Design (portability-first, no GNU tools):
#   * No `timeout` (GNU coreutils), no `wait -n` (bash 4.3+), no
#     process-group kill (no setsid on macOS): the test runs in the
#     background, a 0.1s poll loop counts wall-clock (bash SECONDS,
#     second resolution) until the bound, identical on bash 3.2 (macOS)
#     and 5.x (Linux).
#   * On timeout the whole descendant tree is killed — a bare `kill <pid>`
#     would orphan bun's children (`bun run` forks a child for the script,
#     and a test can spawn grandchildren, e.g. a `sleep`). The tree is found
#     by a BFS `pgrep -P` walk.
#   * SIGTERM first, SIGKILL only for survivors, after a 2s grace: a test
#     with cleanup handlers gets a chance to exit cleanly.
#   * The watchdog fires at the bound and returns its OWN sentinel (214),
#     deliberately distinct from 124 — the conventional "timed out" code that
#     a test can exit on its own. Because the sentinel is 214, the per-test
#     "(timed out after <N>s)" suffix is emitted only for a true watchdog
#     kill, never for a coincidental self-exit-124 test (the round-1
#     finding: the old code keying the suffix on `rc -eq 124` misattributed
#     those). The `✗ timed out after <N>s` line the watchdog prepends to the
#     capture is what the #827 echo and extractSpecificAssertion name as the
#     specific assertion; a self-exit-124 test gets neither.
#   * The bound must be a positive integer; anything else falls back to 300
#     with a warning so the silent default is visible.

if [[ "${PI_ENSEMBLE_VERIFY_TEST_TIMEOUT_S:-}" =~ ^[1-9][0-9]*$ ]]; then
  VERIFY_TEST_TIMEOUT_S="$PI_ENSEMBLE_VERIFY_TEST_TIMEOUT_S"
else
  if [ -n "${PI_ENSEMBLE_VERIFY_TEST_TIMEOUT_S:-}" ]; then
    echo "warn: verify-loop: PI_ENSEMBLE_VERIFY_TEST_TIMEOUT_S must be a positive integer; got '${PI_ENSEMBLE_VERIFY_TEST_TIMEOUT_S}', falling back to 300" >&2
  fi
  VERIFY_TEST_TIMEOUT_S=300
fi

# Descendant-tree kill: SIGTERM, 2s grace, SIGKILL survivors. Without pgrep
# only the top-level test process can be killed (descendants are orphaned).
# The BFS tracks visited PIDs so each is walked once (a pid re-appearing in
# two parents' child lists would otherwise be re-added).
# After the grace, SIGKILL goes to EVERY collected pid unconditionally — the
# kill -0 pre-check is a trap: a zombie satisfies kill -0, but so would a
# pid that died between the check and the kill, and a pid recycled into an
# unrelated process would make the check say "no, it's alive" for the wrong
# reason. SIGKILL to a dead or zombie pid is a harmless no-op.
# Then wait (bounded ≤5s) until no collected pid is alive; a pid whose exit
# we cannot reap ourselves is still visible in `ps` as a zombie to its new
# parent, so polling on liveness here is the right check — and survivors are
# named so a leak is diagnosable, not silently dropped.
kill_process_tree() {
  local root_pid="$1" queue current_pid child_pids pids_to_kill visited alive_count waited
  pids_to_kill="$root_pid"
  visited="$root_pid"
  queue="$root_pid"
  while [ -n "$queue" ]; do
    child_pids=""
    for current_pid in $queue; do
      child_pids="$child_pids $(pgrep -P "$current_pid" 2>/dev/null)"
    done
    child_pids="${child_pids# }"
    # Prune pids already collected (visited) so each is walked exactly once.
    local fresh_child
    fresh_child=""
    for child_pid in $child_pids; do
      case " $visited " in
        *" $child_pid "*) : ;;
        *) fresh_child="$fresh_child $child_pid" ;;
      esac
    done
    fresh_child="${fresh_child# }"
    if [ -n "$fresh_child" ]; then
      pids_to_kill="$pids_to_kill $fresh_child"
      visited="$visited $fresh_child"
      queue="$fresh_child"
    else
      queue=""
    fi
  done
  for current_pid in $pids_to_kill; do kill -TERM "$current_pid" 2>/dev/null; done
  sleep 2
  for current_pid in $pids_to_kill; do kill -KILL "$current_pid" 2>/dev/null; done
  # Bounded wait (≤5s, 0.1s polls) for the whole tree to actually die; name
  # survivors so a leaked descendant is visible in the output.
  waited=0
  while [ "$waited" -lt 50 ]; do
    alive_count=0
    for current_pid in $pids_to_kill; do
      if kill -0 "$current_pid" 2>/dev/null; then alive_count=$((alive_count + 1)); fi
    done
    if [ "$alive_count" -eq 0 ]; then return 0; fi
    sleep 0.1
    waited=$((waited + 1))
  done
  local survivors=""
  for current_pid in $pids_to_kill; do
    if kill -0 "$current_pid" 2>/dev/null; then survivors="$survivors $current_pid"; fi
  done
  if [ -n "$survivors" ]; then
    echo "warn: verify-loop: still alive after SIGKILL: ${survivors# }" >&2
  fi
}

# Prepend the `✗ timed out after <N>s` line to the capture (front, so
# extractSpecificAssertion names it; partial output stays after it).
prepend_timeout_line() {
  local bound="$1"
  {
    echo "✗ timed out after ${bound}s"
    cat "$CAPTURE" 2>/dev/null
  } >"$CAPTURE.tmp" 2>/dev/null && mv "$CAPTURE.tmp" "$CAPTURE" 2>/dev/null || {
    rm -f "$CAPTURE.tmp"
    echo "warn: verify-loop: could not prepend the timeout line to the capture of this test" >&2
  }
}

# Run one test under the watchdog. Returns the test's exit code, or 214 (the
# watchdog's own sentinel, distinct from a test that exits 124 itself) if the
# bound fired.
run_test_with_timeout() {
  local bound="$1" t="$2" pid=0 start rc=0
  start=$SECONDS
  bun run "$t" >"$CAPTURE" 2>&1 &
  pid=$!
  # Poll every 0.1s (sleep 0.1 works on macOS and GNU coreutils), comparing
  # elapsed wall-clock via SECONDS (second resolution — the bound is still
  # honoured to the second, the fast poll only removes the 1s latency that
  # previously added ~1s to every fast test). bash 3.2 safe: no associative
  # arrays, no wait -n, fractional sleep only.
  while :; do
    if kill -0 "$pid" 2>/dev/null; then
      if [ "$((SECONDS - start))" -ge "$bound" ]; then
        kill_process_tree "$pid"
        wait "$pid" 2>/dev/null
        # NB: the timeout path returns 214 on purpose (not 124) — the test's
        # own wait status (whatever the SIGTERM/SIGKILL left behind) is
        # intentionally replaced by the sentinel, and 214 is chosen BECAUSE
        # it is distinct from 124: a test that itself exits 124 (the
        # conventional "timed out" code) returns through the normal path
        # below and gets no timeout marker, so the cosmetic "(timed out)"
        # suffix is emitted only for a true watchdog kill, never for a
        # coincidental self-exit-124. The `✗ timed out after <N>s` line
        # prepended to the capture is what the #827 echo /
        # extractSpecificAssertion surface as the specific assertion.
        prepend_timeout_line "$bound"
        return 214
      fi
    else
      break
    fi
    sleep 0.1
  done
  wait "$pid" 2>/dev/null
  rc=$?
  return "$rc"
}

# pgrep powers the descendant kill; without it only the top-level test
# process would be killed (descendants orphaned). Warn, do not fail.
if ! command -v pgrep >/dev/null 2>&1; then
  echo "warn: verify-loop: pgrep not found — on timeout only the top-level test process will be killed (descendants may be orphaned)" >&2
fi

# --- #1028 — parse --digest flag (must come before the usage check so that
# a bare `--digest` with no files is still a usage error).
DIGEST=0
if [ "$#" -gt 0 ] && [ "$1" = "--digest" ]; then
  DIGEST=1
  shift
fi

if [ "$#" -eq 0 ]; then
  echo "usage: verify-loop.sh [--digest] <file> ..." >&2
  exit 2
fi

# Single-execution capture (DECISION 3): every test runs exactly once; its
# output is captured to a temp file that is removed on every exit path.
CAPTURE="$(mktemp "${TMPDIR:-/tmp}/verify-loop.XXXXXX")" || exit 2
# One trap cleans everything on every exit path: the per-test capture, the
# #1028/​#827 failure captures, and the #1069 ledger temp dir (empty when an
# operator-supplied override was honoured).
_extra_captures=()
_extra_cleanup() {
  rm -f "$CAPTURE" ${_extra_captures[*]:-}
  if [ -n "${_ledger_tmp_dir:-}" ]; then rm -rf "${_ledger_tmp_dir}"; fi
}
trap '_extra_cleanup' EXIT

names=()
total=0
for t in "$@"; do
  case "$t" in *-live.ts) continue;; esac
  total=$((total + 1))
  rc=0
  run_test_with_timeout "$VERIFY_TEST_TIMEOUT_S" "$t"
  rc=$?
  if [ "$rc" -eq 0 ]; then
    if [ "$DIGEST" -eq 0 ]; then
      cat "$CAPTURE"
    fi
  else
    names+=("$t")
    if [ "$DIGEST" -eq 0 ]; then
      if [ "$rc" -eq 214 ]; then
        echo "FAILED: $t (timed out after ${VERIFY_TEST_TIMEOUT_S}s)"
      else
        echo "FAILED: $t"
      fi
      cat "$CAPTURE"
    fi
    # #827 — keep this test's capture so its `✗` lines can be repeated
    # after the summary (below); removed on exit like $CAPTURE. Also used
    # by #1028 digest mode to emit ✗ lines + indented detail.
    capfile="$(mktemp "${TMPDIR:-/tmp}/verify-loop.XXXXXX")" || exit 2
    if ! cp "$CAPTURE" "$capfile"; then
      # Capture failed — degrade gracefully: the test has already failed and
      # its per-test output was printed above, so a missing echo is a
      # cosmetic gap in the tail, not a new failure. Do NOT register the
      # capfile, so the echo loop below skips it.
      echo "warn: verify-loop: could not capture output of $t for the tail echo; its ✗ lines will be absent from the summary tail" >&2
      rm -f "$capfile"
      # Push a placeholder so the digest loop's names/_extra_captures index
      # pairing stays aligned; the digest emits the FAILED: marker with no
      # detail for this test. An empty entry makes the #827 echo loop's
      # `grep -F -- "✗" ""` error out on an invalid file name; `|| true`
      # swallows that error, so an empty entry simply yields no lines.
      _extra_captures+=("")
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

  if [ "$DIGEST" -eq 1 ]; then
    # #1028 — digest mode: emit per-failure markers, every ✗ line with its
    # indented detail, then the summary. The 3×200 bound from normal mode's
    # #827 echo does NOT apply here — the digest is the full failure detail.
    # names and _extra_captures are pushed in lockstep (a cp failure pushes an
    # empty placeholder), so index $i of each array is the same test.
    # Filter contract (shared with the #827 tail, see header): a line is
    # kept when it is a `✗` marker at line start, or when it is an indented
    # detail line (leading whitespace) following a kept ✗ marker; the
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
    echo "P: $((total - ${#names[@]}))  F: ${#names[@]}"
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
  exit 1
fi
exit 0
