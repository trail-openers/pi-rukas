#!/usr/bin/env bash
# Issue #1365 — bounded job pool for verify-loop.sh.
#
# Sourced by verify-loop.sh AFTER run_test_with_timeout and kill_process_tree
# are defined; they are called at run time, not at source time. Each test runs
# under the same per-test watchdog as before, inside a background job, with at
# most PI_ENSEMBLE_VERIFY_TEST_JOBS jobs running at once (default 2; 1 is
# strictly sequential, as before #1365).
#
# Per-job state lives in parallel arrays indexed by argument order:
#   JOB_TESTS[i]  the test file            JOB_CAP[i]   its own capture file
#   JOB_RC[i]     file the job writes its exit code to when it finishes
#   JOB_PID[i]    pid of the job's subshell
#   JOB_STATE[i]  0 queued, 1 running, 2 finished
#   JOB_EXIT[i]   the test's exit code (214 = the watchdog fired)
# verify-loop.sh replays the captures in index order, so printed output and the
# digest do not depend on which job finished first.
#
# Bash 3.2 safe like the rest of verify-loop.sh: no `wait -n`, no associative
# arrays. Completion is polled every 0.1s.

# Job count — same validation shape as the timeout bound in verify-loop.sh.
if [[ "${PI_ENSEMBLE_VERIFY_TEST_JOBS:-}" =~ ^[1-9][0-9]*$ ]]; then
  VERIFY_TEST_JOBS="$PI_ENSEMBLE_VERIFY_TEST_JOBS"
else
  if [ -n "${PI_ENSEMBLE_VERIFY_TEST_JOBS:-}" ]; then
    echo "warn: verify-loop: PI_ENSEMBLE_VERIFY_TEST_JOBS must be a positive integer; got '${PI_ENSEMBLE_VERIFY_TEST_JOBS}', falling back to 2" >&2
  fi
  VERIFY_TEST_JOBS=2
fi

JOB_TESTS=()
JOB_CAP=()
JOB_RC=()
JOB_PID=()
JOB_STATE=()
JOB_EXIT=()
# Every per-job file, for the EXIT-trap cleanup in verify-loop.sh.
JOB_FILES=()

# pool_collect <file> ... — register each non-live test as a job, in argument
# order. Needs $CAPTURE (the mktemp base name) set by verify-loop.sh.
pool_collect() {
  local t n=0
  for t in "$@"; do
    case "$t" in *-live.ts) continue;; esac
    JOB_TESTS+=("$t")
    JOB_CAP+=("$CAPTURE.$n")
    JOB_RC+=("$CAPTURE.$n.rc")
    JOB_FILES+=("$CAPTURE.$n" "$CAPTURE.$n.rc")
    JOB_STATE+=(0)
    JOB_PID+=(0)
    JOB_EXIT+=(0)
    n=$((n + 1))
  done
}

# start_job <i> — run job i in the background under the watchdog. The subshell
# records the exit code in a file as its last act; that file is how the poll
# loop learns the job finished.
start_job() {
  local i="$1"
  (
    rc=0
    run_test_with_timeout "$VERIFY_TEST_TIMEOUT_S" "${JOB_TESTS[$i]}" "${JOB_CAP[$i]}"
    rc=$?
    echo "$rc" >"${JOB_RC[$i]}"
  ) &
  JOB_PID[$i]=$!
  JOB_STATE[$i]=1
}

# interrupt_now <exit-code> — the INT/TERM handler. Two things make a plain
# `kill_running_jobs; exit N` insufficient. (1) bash defers a trapped signal
# until the foreground command returns; with jobs in the background that can be
# a long wait, so the handler asks each live job's own process tree to die
# FIRST — the test's `bun` process must not outlive the decision to interrupt.
# (2) a job subshell can be killed while its `bun` child survives (the signal
# reaches the subshell, not the grandchild), which would leave a live test
# running with no parent; so the trees are re-walked after the jobs are reaped.
# kill_process_tree is safe on a dead pid (SIGKILL to a zombie is a no-op),
# which is what makes the second walk cheap. The exit code is the shell
# convention: 128 + signal (130 = SIGINT, 143 = SIGTERM).
interrupt_now() {
  local code="$1" i
  for i in "${!JOB_TESTS[@]}"; do
    if [ "${JOB_STATE[$i]}" -eq 1 ]; then
      kill_process_tree "${JOB_PID[$i]}"
    fi
  done
  # Reap whatever is still ours so no job of this run is left running.
  for i in "${!JOB_PID[@]}"; do
    if [ "${JOB_PID[$i]}" -ne 0 ]; then wait "${JOB_PID[$i]}" 2>/dev/null; fi
  done
  for i in "${!JOB_TESTS[@]}"; do
    if [ "${JOB_STATE[$i]}" -eq 1 ]; then
      kill_process_tree "${JOB_PID[$i]}"
    fi
  done
  exit "$code"
}

# run_pool <jobs> — keep up to <jobs> jobs running; return when all are done.
run_pool() {
  local max_jobs="$1" next=0 running done_n=0 i total="${#JOB_TESTS[@]}"
  while [ "$done_n" -lt "$total" ]; do
    running=0
    for ((i = 0; i < total; i++)); do
      [ "${JOB_STATE[$i]}" -eq 1 ] || continue
      if [ -s "${JOB_RC[$i]}" ] || ! kill -0 "${JOB_PID[$i]}" 2>/dev/null; then
        wait "${JOB_PID[$i]}" 2>/dev/null
        JOB_EXIT[$i]="$(cat "${JOB_RC[$i]}" 2>/dev/null)"
        if [ -z "${JOB_EXIT[$i]}" ]; then
          echo "warn: verify-loop: job for ${JOB_TESTS[$i]} ended without an exit status; counted as failed" >&2
          JOB_EXIT[$i]=1
        fi
        JOB_STATE[$i]=2
        done_n=$((done_n + 1))
      else
        running=$((running + 1))
      fi
    done
    while [ "$running" -lt "$max_jobs" ] && [ "$next" -lt "$total" ]; do
      start_job "$next"
      next=$((next + 1))
      running=$((running + 1))
    done
    if [ "$done_n" -lt "$total" ]; then sleep 0.1; fi
  done
}
