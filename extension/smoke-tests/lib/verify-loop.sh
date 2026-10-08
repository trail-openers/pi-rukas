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

# #1017 — forbid live spawns in every offline test. Any offline test that
# reaches the real spawn path (spawnSpecialist) fails loudly in ~5s with the
# FORBID_LIVE_SPAWN error naming the role and the injection point, instead of
# silently burning real model tokens and stalling the suite. Live tests
# (*-live.ts) are skipped before this matters, and a test that needs a (fake)
# child sets PI_ENSEMBLE_ALLOW_LIVE_SPAWN=1 locally. The canary
# (test-verify-loop.ts case 8 + fixture-spawn-env.ts) proves this export
# reaches the child env.
export PI_ENSEMBLE_FORBID_LIVE_SPAWN=1

# --- #1014 — per-test timeout watchdog.
#
# Each test is bounded at ${PI_ENSEMBLE_VERIFY_TEST_TIMEOUT_S:-300} seconds.
#
# Design (portability-first, no GNU tools):
#   * No `timeout` (GNU coreutils), no `wait -n` (bash 4.3+), no
#     process-group kill (no setsid on macOS): the test runs in the
#     background, a 1s poll loop counts wall-clock (bash SECONDS) until the
#     bound, identical on bash 3.2 (macOS) and 5.x (Linux).
#   * On timeout the whole descendant tree is killed — a bare `kill <pid>`
#     would orphan bun's children (`bun run` forks a child for the script,
#     and a test can spawn grandchildren, e.g. a `sleep`). The tree is found
#     by a BFS `pgrep -P` walk.
#   * SIGTERM first, SIGKILL only for survivors, after a 2s grace: a test
#     with cleanup handlers gets a chance to exit cleanly.
#   * Exit code 124 is the conventional "timed out" sentinel; the test's
#     partial output is kept (partial-output contract) and a
#     `✗ timed out after <N>s` line is prepended to the capture so the #827
#     echo and extractSpecificAssertion name it as the specific assertion.
#     A test that itself exits 124 is told apart: it is a timeout only if
#     the `✗ timed out` line was added by this watchdog (the loop checks
#     rc=124 from run_test_with_timeout, never the raw child exit code).
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

# Run one test under the watchdog. Returns the test's exit code, or 124 if
# the bound fired.
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
        # NB: the timeout path returns 124 on purpose — the test's own wait
        # status (whatever the SIGTERM/SIGKILL left behind) is intentionally
        # replaced by the conventional 124 timeout sentinel; the
        # `✗ timed out after <N>s` line prepended to the capture is what
        # tells the two apart in the output.
        prepend_timeout_line "$bound"
        return 124
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
  rc=0
  run_test_with_timeout "$VERIFY_TEST_TIMEOUT_S" "$t"
  rc=$?
  if [ "$rc" -eq 0 ]; then
    cat "$CAPTURE"
  else
    names+=("$t")
    if [ "$rc" -eq 124 ]; then
      echo "FAILED: $t (timed out after ${VERIFY_TEST_TIMEOUT_S}s)"
      cat "$CAPTURE"
    else
      echo "FAILED: $t"
      cat "$CAPTURE"
    fi
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
