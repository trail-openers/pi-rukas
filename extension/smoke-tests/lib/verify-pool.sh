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
# Every per-job file is $RUN_DIR/<n>.out and $RUN_DIR/<n>.rc inside ONE private
# directory that verify-loop.sh creates (mode 0700) and its EXIT trap removes.
# The old shape derived names from a single mktemp base ($CAPTURE.<n>), which
# put sibling files next to a predictable path and scattered them across TMPDIR;
# a directory is private, atomic to clean, and gives the timeout prepend a
# place to keep its scratch file too.
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
# Ceiling on concurrent jobs. More than this buys nothing — every job is a full
# `bun` process plus whatever the test itself spawns, so past 16 the pool is
# competing with itself for CPU and the suite gets slower, not faster. Clamped
# again in pool_collect against the number of collected tests.
VERIFY_TEST_JOBS_MAX=16

JOB_TESTS=()
JOB_CAP=()
JOB_RC=()
JOB_PID=()
JOB_STATE=()
JOB_EXIT=()

# pool_collect <run-dir> <file> ... — register each non-live test as a job, in
# argument order, with its capture and exit-code file inside <run-dir> (the
# private per-run directory verify-loop.sh created and will remove).
pool_collect() {
  local run_dir="$1" t n=0
  shift
  for t in "$@"; do
    case "$t" in *-live.ts) continue;; esac
    JOB_TESTS+=("$t")
    JOB_CAP+=("$run_dir/$n.out")
    JOB_RC+=("$run_dir/$n.rc")
    JOB_STATE+=(0)
    JOB_PID+=(0)
    JOB_EXIT+=(0)
    n=$((n + 1))
  done
  # Clamp to what can actually run: 16 concurrent jobs for 3 tests would be a
  # pool with nothing to pool, and an operator asking for 200 jobs gets the
  # same 16 as everyone else. Either clamp is worth a line of stderr.
  if [ "${#JOB_TESTS[@]}" -lt "$VERIFY_TEST_JOBS" ]; then
    echo "warn: verify-loop: PI_ENSEMBLE_VERIFY_TEST_JOBS=${VERIFY_TEST_JOBS} clamped to ${#JOB_TESTS[@]} (the number of tests)" >&2
    VERIFY_TEST_JOBS="${#JOB_TESTS[@]}"
  fi
  if [ "$VERIFY_TEST_JOBS" -gt "$VERIFY_TEST_JOBS_MAX" ]; then
    echo "warn: verify-loop: PI_ENSEMBLE_VERIFY_TEST_JOBS=${VERIFY_TEST_JOBS} clamped to $VERIFY_TEST_JOBS_MAX" >&2
    VERIFY_TEST_JOBS="$VERIFY_TEST_JOBS_MAX"
  fi
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
    # The rc file is the ONLY way the poll loop learns this job finished. If
    # the write fails the job is indistinguishable from one still running
    # until the pid dies, and then from one that died without reporting — so
    # the failure is named rather than silently swallowed.
    if ! echo "$rc" >"${JOB_RC[$i]}"; then
      echo "warn: verify-loop: could not record exit status for ${JOB_TESTS[$i]}" >&2
    fi
  ) &
  JOB_PID[$i]=$!
  JOB_STATE[$i]=1
}

# collect_tree <var> <root-pid> — put the space-separated pid set of the tree
# rooted at <root-pid> (the root included) into the caller's variable <var>.
# Each pid is walked once: a pid that appears in two parents' child lists would
# otherwise re-enter the queue and be re-walked for each parent. Shared by
# kill_process_tree and the interrupt handler so both agree on what "the job's
# tree" means.
#
# Two rules this function exists to satisfy, both learned the hard way:
#
#  1. Callers must NOT wrap it in $(...). Command substitution runs the body in
#     a SUBSHELL, and `pgrep -P` reports children of the process that called
#     it — so from inside a substitution the job subshell appears childless and
#     its `bun`/`sh -c` grandchildren are never collected. That is precisely the
#     orphan the old second tree-walk used to paper over. The caller therefore
#     declares the variable and calls this for its side effect.
#  2. The result is written with one eval at the end, from a local accumulator.
#     Writing it incrementally (`printf -v "$_ct_out" '%s' "$_ct_out" ...`)
#     expands the name in the ARGUMENT against the CALLER's binding while the
#     -v target resolves to the local, so the caller's variable came back
#     holding its own name.
#
# Re-entrant by construction: nothing is shared through a global, so the two
# jobs of one interrupt pass cannot clobber each other's visited set.
collect_tree() {
  local _ct_out="$1" _ct_root="$2"
  if [ -z "$_ct_out" ]; then return 0; fi
  # `wait` owns the liveness of a tree this shell still owns, so this only
  # refuses values that could never be a pid.
  if [[ ! "$_ct_root" =~ ^[0-9]+$ ]]; then
    eval "$_ct_out=''"
    return 0
  fi
  local _ct_all="$_ct_root" _ct_vis=" $_ct_root " _ct_queue="$_ct_root" _ct_cur _ct_cids _ct_fresh _ct_child
  while [ -n "$_ct_queue" ]; do
    _ct_cids=""
    for _ct_cur in $_ct_queue; do
      _ct_cids="$_ct_cids $(pgrep -P "$_ct_cur" 2>/dev/null)"
    done
    _ct_fresh=""
    for _ct_child in $_ct_cids; do
      case "$_ct_vis" in
        *" $_ct_child "*) : ;;
        *) _ct_fresh="$_ct_fresh $_ct_child" ;;
      esac
    done
    _ct_fresh="${_ct_fresh# }"
    if [ -n "$_ct_fresh" ]; then
      _ct_vis="$_ct_vis$_ct_fresh "
      _ct_all="$_ct_all $_ct_fresh"
      _ct_queue="$_ct_fresh"
    else
      _ct_queue=""
    fi
  done
  eval "$_ct_out=\"$_ct_all\""
}

# interrupt_now <exit-code> — the INT/TERM handler, ONE bounded pass.
#
# Bash defers a trapped signal until the foreground command returns, so by the
# time this runs the decision to interrupt is already made and the hung tests
# are still alive; the handler must take them down itself rather than exit and
# leave them running with no parent.
#
# The previous shape walked each live job's tree twice — once before reaping
# and once after — through kill_process_tree, which SIGTERMs, sleeps 2s and
# then SIGKILLs. Two walks meant two 2s graces and up to ~14s before the loop
# returned, and the second walk was defensive rather than load-bearing: the
# first pass already collected the whole descendant set, so a "survivor" was
# simply a pid that had not been scheduled yet, not one the walk had missed.
#
# One pass instead: block INT/TERM first (the trap itself is the re-entry
# guard — a second Ctrl-C must not restart a half-finished kill), collect every
# running job's tree INCLUDING the job subshell pids themselves (the signal
# reaches the subshell, not its grandchild, so the subshell has to be in the
# set explicitly), SIGTERM the whole set once, poll up to 20 × 0.1s for
# liveness to clear, SIGKILL whatever still answers `kill -0`, then `wait` on
# the job pids so they are reaped rather than left as zombies of this shell.
# SIGKILL to a dead or already-reaped pid is a harmless no-op, which is what
# makes the unconditional second round safe. Finally the run's temp state is
# dropped through _extra_cleanup — the same routine the EXIT trap runs, which
# this path does not reach — and the shell exits with the shell convention
# 128 + signal (130 = SIGINT, 143 = SIGTERM).
interrupt_now() {
  local code="$1" i pid pids="" alive polls tree
  # Re-entry guard AND the reason the walk below is not interrupted itself: a
  # second Ctrl-C during the kill must not restart a half-finished pass.
  trap '' INT TERM
  for i in "${!JOB_TESTS[@]}"; do
    [ "${JOB_STATE[$i]}" -eq 1 ] || continue
    [ "${JOB_PID[$i]}" -ne 0 ] || continue
    # No $(...) around the walk: see collect_tree's rule 1.
    tree=""
    collect_tree tree "${JOB_PID[$i]}"
    pids="$pids $tree"
  done
  pids="${pids# }"
  if [ -n "$pids" ]; then
    for pid in $pids; do kill -TERM "$pid" 2>/dev/null; done
  fi
  # Bounded wait (20 × 0.1s) for the set to stop answering kill -0. Bounded
  # rather than unconditional: one subshell that ignores SIGTERM must not block
  # the handler past the caller's patience.
  polls=0
  while [ "$polls" -lt 20 ]; do
    alive=0
    for pid in $pids; do
      if kill -0 "$pid" 2>/dev/null; then alive=1; fi
    done
    [ "$alive" -eq 0 ] && break
    sleep 0.1
    polls=$((polls + 1))
  done
  if [ -n "$pids" ]; then
    for pid in $pids; do kill -KILL "$pid" 2>/dev/null; done
  fi
  for i in "${!JOB_PID[@]}"; do
    if [ "${JOB_PID[$i]}" -ne 0 ]; then
      wait "${JOB_PID[$i]}" 2>/dev/null
    fi
  done
  # Cleanup on a path the EXIT trap does not reach. _extra_cleanup removes the
  # #827/#1028 failure captures and the #1069 ledger temp dir, and is the single
  # owner of `rm -rf "$RUN_DIR"` — duplicating it here would only add a second
  # place where the private directory's lifetime is decided.
  if [ "$(type -t _extra_cleanup)" = function ]; then _extra_cleanup; fi
  exit "$code"
}

# run_pool <jobs> <test> ... — keep up to <jobs> jobs running; return when all
# are done. The test list is taken from pool_collect; it is repeated here only
# so the caller states the same argument list it collected.
run_pool() {
  local max_jobs="$1" next=0 running done_n=0 i total="${#JOB_TESTS[@]}" retries
  if [ "$max_jobs" -lt 1 ]; then max_jobs=1; fi
  while [ "$done_n" -lt "$total" ]; do
    running=0
    for ((i = 0; i < total; i++)); do
      [ "${JOB_STATE[$i]}" -eq 1 ] || continue
      if [ -s "${JOB_RC[$i]}" ] || ! kill -0 "${JOB_PID[$i]}" 2>/dev/null; then
        wait "${JOB_PID[$i]}" 2>/dev/null
        JOB_EXIT[$i]="$(cat "${JOB_RC[$i]}" 2>/dev/null)"
        # A dead job with an empty rc file is a race, not yet a verdict: the
        # subshell's last act is the write, and the pid can be observed gone a
        # moment before that write lands. Give it 1s before believing it.
        if [ -z "${JOB_EXIT[$i]}" ]; then
          retries=0
          while [ -z "${JOB_EXIT[$i]}" ] && [ "$retries" -lt 10 ]; do
            sleep 0.1
            JOB_EXIT[$i]="$(cat "${JOB_RC[$i]}" 2>/dev/null)"
            retries=$((retries + 1))
          done
        fi
        # Numeric, not merely non-empty: a truncated or corrupt write is as
        # unusable as none, and replaying it as a bogus exit code would
        # mislabel the test's outcome downstream.
        if ! [[ "${JOB_EXIT[$i]}" =~ ^[0-9]+$ ]]; then
          echo "warn: verify-loop: job for ${JOB_TESTS[$i]} ended without a usable exit status; counted as failed" >&2
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
