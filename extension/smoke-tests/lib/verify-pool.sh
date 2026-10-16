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

JOB_TESTS=()
JOB_CAP=()
JOB_RC=()
JOB_PID=()
JOB_STATE=()
JOB_EXIT=()
# The $SECONDS value each job was started at, for run_pool's per-job wall-clock
# bound. Written by start_job next to JOB_PID, reset by pool_collect.
JOB_STARTED_AT=()
# Jobs currently in state 1. run_pool reads it; start_job and the completion
# branch are the only two places that move it.
POOL_RUNNING=0

# Every started job, whether or not it has since finished. The interrupt
# handler walks the tree of anything listed here, because a finished job's
# descendants can outlive the job.
POOL_STARTED=()

# pool_collect <run-dir> <file> ... — register each non-live test as a job, in
# argument order, with its capture and exit-code file inside <run-dir> (the
# private per-run directory verify-loop.sh created and will remove).
pool_collect() {
  local run_dir="$1" t n=0
  shift
  # Reset at entry: pool_collect's job arrays are globals, so anything left
  # from a previous collection would be replayed as jobs nobody asked for.
  JOB_TESTS=()
  JOB_CAP=()
  JOB_RC=()
  JOB_PID=()
  JOB_STATE=()
  JOB_EXIT=()
  JOB_STARTED_AT=()
  POOL_STARTED=()
  POOL_RUNNING=0
  for t in "$@"; do
    case "$t" in *-live.ts) continue;; esac
    JOB_TESTS+=("$t")
    JOB_CAP+=("$run_dir/$n.out")
    JOB_RC+=("$run_dir/$n.rc")
    JOB_STATE+=(0)
    JOB_PID+=(0)
    JOB_EXIT+=(0)
    JOB_STARTED_AT+=(0)
    n=$((n + 1))
  done
  # Clamp to what can actually run: 16 concurrent jobs for 3 tests would be a
  # pool with nothing to pool, and an operator asking for 200 jobs gets the
  # same 16 as everyone else. Either clamp is worth a line of stderr — except
  # the test-count clamp on an empty collection, which is the all-live-files
  # case verify-loop.sh reports through its own `no tests ran` exit 3. Warning
  # about 2 jobs for 0 tests there would just contradict that message.
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
  JOB_STARTED_AT[$i]=$SECONDS
  JOB_STATE[$i]=1
  # run_pool's admission test is the counter rather than a scan over every job,
  # so the increment belongs with the state change that made the job running —
  # here, not at the call site.
  POOL_STARTED+=("$i")
  POOL_RUNNING=$((POOL_RUNNING + 1))
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
  if [ -z "$_ct_out" ]; then
    echo "warn: verify-loop: collect_tree: no target variable given; refusing to walk" >&2
    return 1
  fi
  # The last statement is `eval`, and the ONLY thing eval expands is the
  # caller-supplied target NAME plus whatever collect_tree itself built — the
  # pid strings never reach it. That holds only while <var> is a plain
  # identifier: `collect_tree 'x=$(rm -rf /)' 1` would run the substitution at
  # assignment time. Nothing in-tree passes a non-identifier, so a violation is
  # a caller bug and is named rather than silently tolerated (an empty result
  # here would read as "this job has no descendants" and orphan its tree).
  if ! [[ "$_ct_out" =~ ^[A-Za-z_][A-Za-z0-9_]*$ ]]; then
    echo "warn: verify-loop: collect_tree: invalid target variable name; refusing to walk" >&2
    return 1
  fi
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
# and once after — through kill_process_tree, which SIGTERMs, polls up to 2s for
# liveness to clear and then SIGKILLs. Two walks meant two 2s grace polls and up
# to ~14s before the loop returned, and the second walk was defensive rather than
# load-bearing: the first pass already collected the whole descendant set, so a
# "survivor" was simply a pid that had not been scheduled yet, not one the walk
# had missed.
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
#
# Three corrections since that shape shipped:
#
#  * The tree walk covers jobs in state 1 AND state 2, taken from POOL_STARTED
#    rather than the state array alone. State 2 excludes a job from being
#    treated as running, not from having left descendants behind — and a job
#    that finished is precisely the one whose grandchildren were never looked at.
#    collect_tree on a dead root is best effort (it finds only what is still a
#    child of that pid), which is why it is attempted for both states rather
#    than asserted for one.
#  * `_extra_cleanup` is no longer probed with `type -t`. The probe made an
#    absent or misnamed hook (verify-loop.sh renamed it once already) look like
#    a clean interrupt while the private RUN_DIR, the failure captures and the
#    ledger temp dir stayed on disk: the EXIT trap it duplicates never runs on
#    this path. It is under the same hard name check verify-loop.sh applies to
#    every other hook it depends on, so a gap is a loud exit 2 at startup
#    instead of a silent leak per Ctrl-C. It is not optional: the EXIT trap
#    already calls it unconditionally, so a run with no cleanup routine is
#    already broken before the pool is reached.
#  * `_extra_cleanup` runs BEFORE the reap, and the reap is limited to pids
#    `kill -0` reports gone. `wait` on a running pid blocks until it exits, so
#    waiting on every non-zero JOB_PID made the bound above a fiction: one
#    descendant that ignores both signals held the handler open for as long as
#    it liked. Nothing in the cleanup depends on the reap, so the step that can
#    block now happens last.
interrupt_now() {
  local code="$1" i pid pids="" alive polls tree
  # Re-entry guard AND the reason the walk below is not interrupted itself: a
  # second Ctrl-C during the kill must not restart a half-finished pass.
  trap '' INT TERM
  # A job in state 2 has ALREADY been walked: run_pool's completion branch calls
  # kill_process_tree on it (a job only reaches state 2 once its rc file is
  # written or its pid is gone), so re-walking every finished job on every
  # Ctrl-C repeats a walk whose descendants were already collected and
  # signalled. Only the jobs that never completed — the ones actually running
  # when the signal landed — still need taking down here.
  for i in "${POOL_STARTED[@]}"; do
    [ "${JOB_STATE[$i]:-0}" -eq 1 ] || continue
    [ "${JOB_PID[$i]:-0}" -ne 0 ] || continue
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
  # Cleanup BEFORE the reap. _extra_cleanup removes the #827/#1028 failure
  # captures and the #1069 ledger temp dir, and is the single owner of
  # `rm -rf "$RUN_DIR"` — duplicating it here would only add a second place
  # where the private directory's lifetime is decided. It runs first because
  # the reap below is the only step that can still block: removing files does
  # not depend on the jobs being reaped, so a reap that stalls on a pid this
  # shell does not own cannot strand the temp state.
  _extra_cleanup
  # Reap only what is actually gone. `wait` on a pid that is still running
  # BLOCKS until it exits, so waiting on every non-zero JOB_PID made the
  # handler's bound a fiction — one descendant that ignores both signals would
  # hold the handler open for as long as it liked. `kill -0` reports gone for
  # a reaped-or-exited job, which is exactly the set `wait` can return from
  # immediately; anything still alive is left as a zombie of this shell, and
  # this shell is exiting anyway.
  for i in "${!JOB_PID[@]}"; do
    if [ "${JOB_PID[$i]}" -ne 0 ] && ! kill -0 "${JOB_PID[$i]}" 2>/dev/null; then
      wait "${JOB_PID[$i]}" 2>/dev/null
    fi
  done
  exit "$code"
}

# run_pool <jobs> — keep up to <jobs> jobs running; return when all are done.
# The test list is pool_collect's alone; taking it again here only offered a
# way for the caller to state a different list than the one that was collected.
#
# `POOL_RUNNING` is a counter, not a scan: start_job increments it and the
# completion branch below decrements it, so the admission test is O(1). It was
# a full pass over every job on every 0.1s tick, which is the one thing in the
# loop that grows with the suite rather than staying constant.
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
  local max_jobs="$1" next=0 done_n=0 i total="${#JOB_TESTS[@]}" retries started elapsed outer_bound rc
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
        # The transition out of state 1 IS the completion, so the counter is
        # decremented here and nowhere else — one decrement per job, guaranteed
        # by the state change the branch itself makes.
        JOB_STATE[$i]=2
        POOL_RUNNING=$((POOL_RUNNING - 1))
        [ "$POOL_RUNNING" -ge 0 ] || POOL_RUNNING=0
        wait "${JOB_PID[$i]}" 2>/dev/null || :
        JOB_EXIT[$i]="$(cat "${JOB_RC[$i]}" 2>/dev/null)"
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
        done_n=$((done_n + 1))
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
        # kill/wait is followed by `|| rc=1` so a non-zero status there cannot
        # become the tick's status: under `set -e` a predicate that has just
        # said "not done" would otherwise end the whole pass.
        started="${JOB_STARTED_AT[$i]:-0}"
        elapsed=$((SECONDS - started))
        # The inner watchdog's worst case past its own bound: kill_process_tree
        # is a 20 × 0.1s grace poll plus a ≤50 × 0.1s reap, so ≤7s, plus 1s of
        # slack for the SECONDS rounding this comparison is built on. Literal
        # for the same reason the retry sleeps are: it is a number a reader has
        # to be able to check against kill_process_tree, not one derived at run
        # time from constants that live in another file.
        outer_bound=$((VERIFY_TEST_TIMEOUT_S + 8))
        if [ "$elapsed" -ge "$outer_bound" ]; then
          echo "warn: verify-loop: job for ${JOB_TESTS[$i]} exceeded the ${outer_bound}s per-job bound without reporting; killing its tree" >&2
          kill_process_tree "${JOB_PID[$i]}" || rc=1
          wait "${JOB_PID[$i]}" 2>/dev/null || rc=1
          JOB_STATE[$i]=2
          POOL_RUNNING=$((POOL_RUNNING - 1))
          [ "$POOL_RUNNING" -ge 0 ] || POOL_RUNNING=0
          JOB_EXIT[$i]=214
          done_n=$((done_n + 1))
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
      # that is a spec decision, not a fold-in. See
      # /tmp/pi-dev-1365/interrupt-min.sh for the reproducer.
      sleep 0.1
    fi
  done
}
