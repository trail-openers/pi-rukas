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
#   JOB_STARTED_AT[i] the $SECONDS value at start_job — run_pool's per-job bound
#   JOB_EXIT[i]   the test's exit code (its REAL code; a timeout is recorded by
#                 $RUN_DIR/<i>.timeout, written by mark_timeout, never by 214)
#   JOB_KILLED[i] 1 once the outer per-job bound has fired for this job, so the
#                 kill and the bookkeeping happen exactly once (see run_pool)
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
#
# A missing function here is a broken file, not a missing optional feature:
# verify-loop.sh would run every test through a sequential path and report
# pass/fail results it never produced. So verify-loop.sh checks these four
# names exist right after the source line and exits 2 naming the gap; a stale
# copy of either library halts there instead of running an unverified suite.

# Job count — the timeout bound in verify-loop.sh shares the shape, with one
# tightening: this range is closed. A value like 1e9 is a "positive integer" to
# `[1-9][0-9]*` and would sail into the arithmetic below; 1-99 is everything a
# host can usefully run, and VERIFY_TEST_JOBS_MAX still clamps the top.
if [[ "${PI_ENSEMBLE_VERIFY_TEST_JOBS:-}" =~ ^[1-9][0-9]?$ ]]; then
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

# host_job_count — the pool width a host can actually use: 4 where the machine
# reports 8 or more CPUs, 2 otherwise. A small host gains nothing from a wide
# pool and pays for it in contention.
#
# `getconf _NPROCESSORS_ONLN` rather than `nproc`: nproc is GNU coreutils, and
# `getconf` is in POSIX, so the same call works on macOS and Linux CI images
# alike. On a host without it the lookup fails and the answer is the narrow
# default — sizing UP off an unknown host is the wrong direction to guess.
#
# A function rather than an inline substitution at the call site, so the tests
# can put a stub `getconf` earlier on PATH and pin all three branches (8+ CPUs,
# under 8, no working getconf) without owning a machine of each kind.
host_job_count() {
  local cpus
  cpus="$(getconf _NPROCESSORS_ONLN 2>/dev/null)" || cpus=""
  # `case` rather than `[[ =~ ]]`: an unquoted, unvalidated `$cpus` in an
  # arithmetic test is the shape that accepts junk, and getconf on a BSD host
  # can print something that is not a bare count.
  case "$cpus" in
    '' | *[!0-9]*) echo 2 ;;
    *) if [ "$cpus" -ge 8 ]; then echo 4; else echo 2; fi ;;
  esac
}

# apply_host_jobs — the `--jobs-from-host` decision, kept separate from
# host_job_count so each half is testable on its own: this function answers
# "should the host be consulted at all?", that one answers "what width?".
#
# An explicitly set PI_ENSEMBLE_VERIFY_TEST_JOBS always wins, host or no host:
# the operator who named a number outranks a guess about the machine, and the
# flag is there for the case where nobody named one. So the ambient variable is
# tested HERE rather than relying on the parse above having honoured it.
apply_host_jobs() {
  # One `if` rather than two early-return lines: this file is SOURCED, so a
  # caller running under `set -e` would treat a bare `[ … ] || return 0` whose
  # test fails as the statement of record. `return 0` at the end keeps the
  # function's status 0 on every path whichever way the caller's shell is set.
  if [ -n "${VERIFY_JOBS_FROM_HOST:-}" ] && [ "$VERIFY_JOBS_FROM_HOST" -eq 1 ]; then
    # An ambient setting wins; only an UNSET variable lets the host decide.
    # Deliberately not "unset or unparseable": the parse above already warned
    # about junk and fell back to 2, and a caller who set the variable at all
    # said "I want to choose the width, not the machine".
    if [ -z "${PI_ENSEMBLE_VERIFY_TEST_JOBS:-}" ]; then
      VERIFY_TEST_JOBS="$(host_job_count)"
    fi
  fi
  return 0
}

JOB_TESTS=()
JOB_CAP=()
JOB_RC=()
JOB_PID=()
JOB_STATE=()
JOB_EXIT=()
# One-shot latch for the outer per-job bound: 1 once run_pool has taken that job
# down. Without it every later tick re-entered the bound branch for a job that
# was already dead and re-walked/re-killed its tree, because the only thing
# distinguishing "stuck" from "already taken down" was the elapsed comparison,
# which stays true forever once it has become true.
JOB_KILLED=()
# The run's private directory, remembered from pool_collect so the outer bound
# can write the same $RUN_DIR/<n>.timeout marker the watchdog writes. Without it
# the two timeout paths would disagree about how they are reported.
POOL_RUN_DIR=""
# The $SECONDS value each job was started at, for run_pool's per-job wall-clock
# bound. Written by start_job next to JOB_PID, reset by pool_collect.
JOB_STARTED_AT=()
# Jobs currently in state 1. run_pool reads it; start_job and the completion
# branch are the only two places that move it.
POOL_RUNNING=0

# Every started job, whether or not it has since finished. The interrupt
# handler walks the tree of the entries still in state 1 — the jobs actually
# running when the signal landed (see interrupt_now in verify-tree.sh, which
# filters `JOB_STATE[$i] -eq 1`); a finished job's tree was already taken down
# by run_pool's completion branch.
POOL_STARTED=()

# pool_collect <run-dir> -- <file> ... — register each non-live test as a job,
# in argument order, with its capture, exit-code and timeout-marker file inside
# <run-dir> (the private per-run directory verify-loop.sh created and will
# remove). The `--` separates the directory from the file list: a test path
# beginning with a dash would otherwise read as an option to the parser.
pool_collect() {
  local run_dir="$1" t n=0
  shift
  [ "${1:-}" = "--" ] && shift
  # Reset at entry: pool_collect's job arrays are globals, so anything left
  # from a previous collection would be replayed as jobs nobody asked for.
  JOB_TESTS=()
  JOB_CAP=()
  JOB_RC=()
  JOB_PID=()
  JOB_STATE=()
  JOB_EXIT=()
  JOB_KILLED=()
  JOB_STARTED_AT=()
  POOL_STARTED=()
  POOL_RUNNING=0
  POOL_RUN_DIR="$run_dir"
  for t in "$@"; do
    case "$t" in *-live.ts) continue;; esac
    JOB_TESTS+=("$t")
    JOB_CAP+=("$run_dir/$n.out")
    JOB_RC+=("$run_dir/$n.rc")
    JOB_STATE+=(0)
    JOB_PID+=(0)
    JOB_EXIT+=(0)
    JOB_KILLED+=(0)
    JOB_STARTED_AT+=(0)
    n=$((n + 1))
  done
  # Clamp to what can actually run: 16 concurrent jobs for 3 tests would be a
  # pool with nothing to pool, and an operator asking for 200 jobs gets the
  # same 16 as everyone else. Either clamp is worth a line of stderr — except
  # the test-count clamp on an empty collection, which is the all-live-files
  # case verify-loop.sh reports through its own `no tests ran` exit 3. Warning
  # about 2 jobs for 0 tests there would just contradict that message.
  #
  # The host sizing is applied HERE, not at the parse above, because the test-
  # count clamp below is the last writer to VERIFY_TEST_JOBS: a host-derived 4
  # applied before this would be silently overwritten for a small collection,
  # and an applied-after clamp would print its warning naming a number the pool
  # no longer runs. The operator's explicit value still wins inside
  # apply_host_jobs.
  apply_host_jobs
  if [ "${#JOB_TESTS[@]}" -ne 0 ] && [ "${#JOB_TESTS[@]}" -lt "$VERIFY_TEST_JOBS" ]; then
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
    run_test_with_timeout "$VERIFY_TEST_TIMEOUT_S" "${JOB_TESTS[$i]}" "${JOB_CAP[$i]}" "$i" "$POOL_RUN_DIR"
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
  JOB_STARTED_AT[$i]=$SECONDS
  JOB_STATE[$i]=1
  # run_pool's admission test is the counter rather than a scan over every job,
  # so the increment belongs with the state change that made the job running —
  # here, not at the call site.
  POOL_STARTED+=("$i")
  POOL_RUNNING=$((POOL_RUNNING + 1))
}

# #1365 — the process-tree half (collect_tree + interrupt_now) lives in
# verify-tree.sh so each file stays under the §12 500-line cap. Sourced here —
# after start_job, which is the last thing either half's callers need defined —
# and checked the same way verify-loop.sh checks the watchdog and the reporter:
# a missing name here would surface as command-not-found inside the interrupt
# handler, which is exactly the path where a silent failure leaks every running
# job's process tree instead of taking it down.
. "$(dirname "${BASH_SOURCE[0]}")/verify-tree.sh"
for _tree_fn in collect_tree interrupt_now; do
  if [ "$(type -t "$_tree_fn")" != function ]; then
    echo "error: verify-loop: lib/verify-tree.sh did not define $_tree_fn — the process-tree teardown is broken; refusing to run" >&2
    exit 2
  fi
done
unset _tree_fn

# read_job_rc <i> — the ONE reader of a job's recorded exit code, used by both
# branches of run_pool (the completion branch and the outer-bound branch). It
# echoes a canonical base-10 number when the job's rc file has one, and nothing
# otherwise. `head -n1` because a truncated write can leave junk on a later
# line, which a numeric test over the whole file would not catch; the numeric
# rule is `^[0-9]+$` — the single rule both branches now share, where the
# completion branch used to accept `^[0-9]+$` and the outer bound `^[1-9][0-9]*$`
# (which rejects "0"), so a job whose rc landed late as "0" was reported as a
# timeout by one path and as a pass by the other. Callers own the fallback:
# nothing printed — absent, empty, or non-numeric — becomes 1 there.
read_job_rc() {
  local rc
  rc="$(head -n1 "${JOB_RC[$1]}" 2>/dev/null)"
  if [[ "$rc" =~ ^[0-9]+$ ]]; then
    echo "$rc"
  fi
}

# finish_job <i> <exit> — the single transition of a job out of state 1, shared
# by both branches of run_pool: the state change, the POOL_RUNNING decrement
# (with its clamp), and done_n — the three pieces of bookkeeping that used to be
# written twice, once per branch, where any future change had to land in both.
# The transition out of state 1 IS the completion, which is what makes one
# decrement per job the invariant rather than something the branches each
# maintain.
finish_job() {
  JOB_STATE[$1]=2
  POOL_RUNNING=$((POOL_RUNNING - 1))
  [ "$POOL_RUNNING" -ge 0 ] || POOL_RUNNING=0
  done_n=$((done_n + 1))
}

# run_pool <jobs> — keep up to <jobs> jobs running; return when all are done.
# The test list is pool_collect's alone; taking it again here only offered a
# way for the caller to state a different list than the one that was collected.
#
# `POOL_RUNNING` is a counter, not a scan: start_job increments it and
# finish_job — called by both branches below — decrements it, so the admission
# test is O(1). It was a full pass over every job on every 0.1s tick, which is
# the one thing in the loop that grows with the suite rather than staying
# constant.
#
# Every job also carries a wall-clock bound of its own (below, in the completion
# branch) reusing VERIFY_TEST_TIMEOUT_S — the same number run_test_with_timeout
# is already handed. It is not redundant with that watchdog: the watchdog bounds
# the TEST, and this bounds the JOB, i.e. the subshell that runs the watchdog
# and then writes the rc file. A job stuck in that tail — a `wait` on a
# descendant that ignores both signals, an rc write that never lands — is
# invisible to the inner watchdog, and without this bound the pool waits on it
# forever. Elapsed time is read from SECONDS (whole seconds) rather than a
# nanosecond clock, which is also what keeps this portable to bash 3.2.
run_pool() {
  local max_jobs="$1" next=0 done_n=0 i total="${#JOB_TESTS[@]}" retries started elapsed outer_bound landed
  if [ "$max_jobs" -lt 1 ]; then max_jobs=1; fi
  POOL_RUNNING=0
  while [ "$done_n" -lt "$total" ]; do
    for ((i = 0; i < total; i++)); do
      [ "${JOB_STATE[$i]}" -eq 1 ] || continue
      # Complete = the rc file has been written AND the job's pid is gone. The
      # old rule accepted either alone, so a job that had written its status but
      # was still being reaped counted as done and the pool moved on while its
      # subshell was alive. Both conditions are cheap, and the pid check is the
      # same `kill -0` already used here; a slow exit is handled by the bound in
      # the else branch rather than by guessing at a grace.
      if [ -s "${JOB_RC[$i]}" ] && ! kill -0 "${JOB_PID[$i]}" 2>/dev/null; then
        # A job the outer bound already took down is finished whether or not
        # its subshell managed to write an rc file on the way out: the bound
        # already counted it, and re-entering here would decrement
        # POOL_RUNNING a second time for the same job.
        finish_job "$i" 1
        wait "${JOB_PID[$i]}" 2>/dev/null || :
        JOB_EXIT[$i]="$(read_job_rc "$i")"
        # A dead job with an empty rc file is a race, not yet a verdict: the
        # subshell's last act is the write, and the pid can be observed gone a
        # moment before that write lands. Back off 0.1s, 0.2s, 0.4s — 0.7s
        # total, and each retry lands later than the last, so a write that is
        # merely slow is caught on the first or second pass rather than after
        # a fixed second of waiting for every job that finishes clean. The
        # three values are literal rather than `sleep "0.$((1 << retries))"`:
        # the arithmetic builds a string that is handed to an external command,
        # so a change to the base or the exponent produces `sleep 0.x`-shaped
        # garbage that fails at run time instead of a bound anyone can read.
        if [ -z "${JOB_EXIT[$i]}" ]; then
          retries=0
          while [ -z "${JOB_EXIT[$i]}" ] && [ "$retries" -lt 3 ]; do
            case "$retries" in
              0) sleep 0.1 ;;
              1) sleep 0.2 ;;
              *) sleep 0.4 ;;
            esac
            JOB_EXIT[$i]="$(read_job_rc "$i")"
            retries=$((retries + 1))
          done
        fi
        # Numeric, not merely non-empty: read_job_rc prints nothing for a
        # truncated or corrupt write, and replaying it as a bogus exit code
        # would mislabel the test's outcome downstream.
        if [ -z "${JOB_EXIT[$i]}" ]; then
          echo "warn: verify-loop: job for ${JOB_TESTS[$i]} ended without a usable exit status; counted as failed" >&2
          JOB_EXIT[$i]=1
        fi
      else
        # Not complete: bound it by wall-clock since the job started (whole
        # seconds, SECONDS). This is the OUTER bound — it bounds the JOB, not
        # the test — and it deliberately does not fire while the inner watchdog
        # is still working. `run_test_with_timeout` is handed the same
        # VERIFY_TEST_TIMEOUT_S and needs up to ~7s past the bound to take the
        # tree down (2s grace poll + ≤5s reap) and write the rc file; killing
        # the subshell at exactly the bound would preempt it and the capture
        # would lose the `✗ timed out after <N>s` line the #827 echo and
        # extractSpecificAssertion name as the specific assertion (measured:
        # case 9/10 of test-verify-loop-timeout.ts fail that way). So the outer
        # bound waits the inner watchdog's own worst case plus a slack before
        # intervening, and by then the inner one has either reported or is
        # provably stuck in the tail the inner watchdog cannot reach. Each
        # kill/wait is followed by `|| :` so a non-zero status there cannot
        # become the tick's status: it is the same guard the completion branch
        # already puts on its `wait`, kept here because this branch is entered
        # from an `if` whose condition just said "not done", and a stray status
        # leaving this body would be read as the tick's own result.
        started="${JOB_STARTED_AT[$i]:-0}"
        elapsed=$((SECONDS - started))
        # The inner watchdog's worst case past its own bound: kill_process_tree
        # is a 20 × 0.1s grace poll plus a ≤50 × 0.1s reap, so ≤7s, plus 1s of
        # slack for the SECONDS rounding this comparison is built on. Literal
        # for the same reason the retry sleeps are: it is a number a reader has
        # to be able to check against kill_process_tree, not one derived at run
        # time from constants that live in another file.
        outer_bound=$((VERIFY_TEST_TIMEOUT_S + 8))
        if [ "$elapsed" -ge "$outer_bound" ] && [ "${JOB_KILLED[$i]:-0}" -ne 1 ]; then
          # ONE-SHOT. The latch is set before anything that can take time, and
          # the completion branch above refuses a job whose latch is set, so
          # this branch is entered once per job: no later tick re-walks or
          # re-kills a tree it already took down (and no `done_n` double count,
          # which would end the pool early with jobs still running). Leaving
          # the state at 1 for a tick to retry was the bug — the elapsed test
          # stays true forever, so "retry" meant "kill it again, forever".
          JOB_KILLED[$i]=1
          echo "warn: verify-loop: job for ${JOB_TESTS[$i]} exceeded the ${outer_bound}s per-job bound without reporting; killing its tree" >&2
          kill_process_tree "${JOB_PID[$i]}" || :
          wait "${JOB_PID[$i]}" 2>/dev/null || :
          finish_job "$i" 1
          # The timeout is the MARKER, not a code: 214 used to go here and the
          # caller read it as "timed out", which is exactly the collision a
          # test that exits 214 itself would hit. mark_timeout is the same
          # routine the inner watchdog calls, so both timeout paths report
          # identically. Normally the job's rc file never lands (the subshell
          # was killed) and JOB_EXIT is set to 1 below. The latch
          # is set BEFORE the kill, so it also skips the completion branch for a
          # job that finished in its final moment and left a real rc behind —
          # and a pass must not be reported as a timeout. So the rc wins when it
          # is there and numeric, and only an absent or non-numeric rc is a
          # timeout. read_job_rc is the same single reader the completion branch
          # uses, so both agree on what a usable rc is.
          landed="$(read_job_rc "$i")"
          if [ -n "$landed" ]; then
            JOB_EXIT[$i]="$landed"
            echo "note: verify-loop: job for ${JOB_TESTS[$i]} wrote its exit code (${landed}) past the ${outer_bound}s bound; reporting it rather than a timeout" >&2
          else
            mark_timeout "$POOL_RUN_DIR" "$i"
            JOB_EXIT[$i]=1
          fi
        fi
      fi
    done
    while [ "$POOL_RUNNING" -lt "$max_jobs" ] && [ "$next" -lt "$total" ]; do
      start_job "$next"
      next=$((next + 1))
    done
    # If the counter ever drifts above the truth the pool would wait forever
    # for a slot that is already free; the ceiling turns that drift into a
    # slower run rather than a stall.
    if [ "$POOL_RUNNING" -gt "$max_jobs" ]; then POOL_RUNNING="$max_jobs"; fi
    if [ "$done_n" -lt "$total" ]; then
      # The tick is a foreground `sleep 0.1`, unchanged from before #1365's
      # interrupt work. It is worth knowing why the interrupt path only works
      # for SIGTERM: bash defers a trapped signal until the foreground command
      # returns, and in a NON-interactive shell a SIGINT that arrives while the
      # shell is blocked in a foreground `sleep` (or `wait`) is not delivered to
      # the trap at all — measured on bash 5.3.9 for `sleep 30`, for
      # `sleep 30 & wait $!`, and for the pool's own tick+wait loop; none ran
      # the handler within 6s. So `interrupt_now` cannot be reached by Ctrl-C
      # mid-tick no matter what it contains, and the trees leak. SIGTERM is
      # delivered and case 5 of test-verify-loop-parallel.ts pins that path.
      # Closing the SIGINT gap needs job control (`set -m`) or a SIGINT-to-
      # SIGTERM shim, which changes how every child in the pool is signalled —
      # that is a spec decision, not a fold-in. The reproducer is committed at
      # smoke-tests/fixtures/verify-loop/interrupt-min.sh (one trap, one sleep:
      # SIGINT leaves it alive, SIGTERM does not), so the claim is re-runnable
      # rather than a note about a scratch file that no longer exists.
      sleep 0.1
    fi
  done
}
