#!/usr/bin/env bash
# Issue #1365 — the watchdog half of verify-loop.sh: the per-test timeout bound
# (#1014), the descendant-tree kill, and the timeout marker. Split out of
# verify-loop.sh so each file stays under the AGENTS.md §12 500-line cap the
# `test-file-size-limit.ts` gate enforces; verify-loop.sh sources this BEFORE
# verify-pool.sh, because the pool calls run_test_with_timeout and
# kill_process_tree and the watchdog calls collect_tree out of the pool file.
#
# Nothing here decides what the run PRINTS or how many jobs run at once: it
# bounds one test, takes its process tree down, and records the fact that the
# bound fired. The verdict key is that record — $RUN_DIR/<n>.timeout — not the
# exit code, which is why the functions here never invent a code. See the
# marker contract in run_test_with_timeout below.
#
# Sourced, never executed: no `set -u` here (verify-loop.sh sets it), and every
# name is defined before use in the sourcing order.

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
#   * SIGTERM first, SIGKILL only for survivors: a test with cleanup handlers
#     gets a chance to exit cleanly. The grace is a BOUNDED POLL — up to
#     20 × 0.1s = 2s ceiling, so a tree that dies in 50ms costs 50ms, not the
#     2s a fixed `sleep 2` charged every timeout. See kill_process_tree below.
#   * The watchdog fires at the bound and records the fact in a MARKER FILE
#     ($RUN_DIR/<n>.timeout), not in an exit code. The old shape returned its
#     own sentinel 214 — distinct from 124, the conventional "timed out" code a
#     test can exit on its own — and the caller keyed the per-test
#     "(timed out after <N>s)" suffix and the `✗ timed out` line on
#     `rc -eq 214`. That only moved the collision the round-1 review found for
#     124: a test that itself exits 214 (its own tooling's convention, or the
#     pool's old outer-bound code) was reported as "timed out" though the
#     watchdog never fired. A file name cannot collide with an exit code, so the
#     timeout is now reported from the marker alone and the test's REAL exit
#     code is preserved. The `✗ timed out after <N>s` line the watchdog prepends
#     to the capture is what the #827 echo and extractSpecificAssertion name as
#     the specific assertion; a test that exits 124 or 214 of its own accord
#     gets neither.
#   * Both timeouts write the marker: the watchdog below AND the pool's outer
#     per-job bound (verify-pool.sh), which sees the job subshell stuck in the
#     tail the watchdog cannot reach. Whichever one fires, the caller reads the
#     same marker.
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

# Descendant-tree kill: SIGTERM, then a bounded grace (poll up to 20 × 0.1s =
# 2s for liveness to clear — the ceiling, not the typical cost), then SIGKILL
# survivors. Without pgrep only the top-level test process can be killed
# (descendants are orphaned).
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
  local root_pid="$1" current_pid pids_to_kill alive_count waited polls_to_kill
  # #1365: the BFS now lives in collect_tree (verify-pool.sh), shared with the
  # interrupt handler so the two cannot disagree about what a job's tree
  # contains. Called for its side effect, NOT through $(...) — a substitution
  # would run the walk in a subshell, where `pgrep -P` sees the substitution's
  # pid instead of this shell's and reports the job subshell as childless.
  pids_to_kill=""
  collect_tree pids_to_kill "$root_pid"
  if [ -z "$pids_to_kill" ]; then pids_to_kill="$root_pid"; fi
  for current_pid in $pids_to_kill; do kill -TERM "$current_pid" 2>/dev/null; done
  # Grace: poll for liveness to clear rather than sleeping a fixed 2s, so the
  # cost is the time the tree actually takes to die and not a flat 2s charged
  # even when it died in 50ms — and so a clean exit is distinguishable from a
  # process that ignored SIGTERM for the whole window. Same shape as
  # interrupt_now's poll: bounded (20 × 0.1s, i.e. a 2s ceiling), exits the
  # moment nothing answers `kill -0`, and falls through
  # to the SIGKILL round when something does not.
  polls_to_kill=0
  while [ "$polls_to_kill" -lt 20 ]; do
    alive_count=0
    for current_pid in $pids_to_kill; do
      if kill -0 "$current_pid" 2>/dev/null; then alive_count=$((alive_count + 1)); fi
    done
    if [ "$alive_count" -eq 0 ]; then break; fi
    sleep 0.1
    polls_to_kill=$((polls_to_kill + 1))
  done
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
  # #1365: the capture is the job's own file, passed as $2. The scratch file
  # goes inside the caller's per-run private directory (the capture's own
  # dirname) rather than beside the capture by name, so nothing writes to a
  # predictable path outside the 0700 directory and the whole run's temp state
  # is removed as one unit. A missing cap argument is a bug in the caller, not
  # a reason to write a file named `.tmp` in the CWD.
  local bound="$1" cap="${2:-}" tmp
  if [ -z "$cap" ]; then
    echo "warn: verify-loop: no capture file for this test; the timeout line was not prepended" >&2
    return 1
  fi
  # mktemp, not a name built from $$ and $RANDOM: two jobs of one run share
  # this shell's pid, so the derived name collided between them and one
  # `mv` silently replaced the other's capture. 0600 and O_EXCL are the
  # defaults mktemp gives, which the derived name did not have.
  tmp="$(mktemp "$(dirname "$cap")/timeout.XXXXXX")" || {
    echo "warn: verify-loop: could not create the scratch file for the timeout line of this test" >&2
    return 1
  }
  {
    echo "✗ timed out after ${bound}s"
    cat "$cap" 2>/dev/null
  } >"$tmp" 2>/dev/null && mv "$tmp" "$cap" 2>/dev/null || {
    rm -f "$tmp"
    echo "warn: verify-loop: could not prepend the timeout line to the capture of this test" >&2
    return 1
  }
  return 0
}

# mark_timeout <run-dir> <index> — record that the watchdog (or the pool's
# outer bound) took this job down: one empty file, $RUN_DIR/<index>.timeout,
# inside the run's private 0700 directory that the EXIT trap removes as one
# unit. A missing run dir or index is a caller bug and is NAMED rather than
# silently dropped: nothing else records a timeout, so a lost marker would
# report the event as a plain failure — which is the exact refutation of the
# 214 sentinel this replaces, arriving as a silent no-op instead of a warning.
mark_timeout() {
  local run_dir="$1" idx="$2"
  if [ -z "$run_dir" ] || [ -z "$idx" ]; then
    echo "warn: verify-loop: cannot record the timeout (no run dir or job index); it will read as a plain failure" >&2
    return 1
  fi
  if ! : >"$run_dir/$idx.timeout" 2>/dev/null; then
    echo "warn: verify-loop: could not write the timeout marker for job $idx; it will read as a plain failure" >&2
    return 1
  fi
  return 0
}

# Run one test under the watchdog. Returns the test's REAL exit code in every
# path — a timeout is recorded through mark_timeout, never through a code (see
# the watchdog design note in the header). #1365: $3 is this job's capture
# file, $4 the job index whose timeout marker is written, and $5 the run dir
# those markers live in (all pool-supplied).
run_test_with_timeout() {
  local bound="$1" t="$2" cap="$3" idx="${4:-}" run_dir="${5:-}" pid=0 start rc=0
  start=$SECONDS
  # #1404 — the child is scrubbed of VERIFY_REPORT_FILE. The scrub is
  # the whole point of the out-of-band channel: a test that cannot see the path
  # cannot forge the verdict the driver reads, and the forged triad (`FAILED:`
  # per-file + a count-matched summary + a non-zero `P:/F:` tally) is otherwise
  # byte-identical to what the loop itself prints.
  #
  # It is spelled as an explicit `env -u` rather than as `unset VERIFY_REPORT_FILE`
  # in the parent because the parent's own copy of that variable is the path the
  # loop still has to write its report to at the end of the run — verify-loop.sh
  # deliberately does NOT scrub it at startup. Unsetting it in the parent would
  # silently produce no report at all, and "no report" is the
  # unattributable shape rather than a passing one. `env -u` takes the variable
  # out of the CHILD's environment only, and every test descendant goes through
  # this one spawn.
  env -u VERIFY_REPORT_FILE bun run "$t" >"$cap" 2>&1 &
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
        # NB: the timeout path does NOT replace the test's wait status. What
        # the SIGTERM/SIGKILL left behind (143, 137, or the test's own code if
        # it died of something else while the watchdog walked its tree) is
        # returned unchanged, and the marker file is the WHOLE record of "the
        # watchdog fired". A test that exits 124 or 214 of its own accord comes
        # back through the normal path below with its real code and no timeout
        # text. The `✗ timed out after <N>s` line prepended to the capture is
        # what the #827 echo / extractSpecificAssertion surface as the specific
        # assertion.
        mark_timeout "$run_dir" "$idx"
        prepend_timeout_line "$bound" "$cap"
        break
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
