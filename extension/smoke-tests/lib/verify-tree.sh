#!/usr/bin/env bash
# Issue #1365 — the process-tree half of the offline verify loop: the BFS
# descendant walk (`collect_tree`) and the INT/TERM handler (`interrupt_now`).
# Sourced by verify-pool.sh, which keeps each file under the §12 500-line cap
# the `test-file-size-limit.ts` gate enforces. The seam is the
# one the code already had: verify-pool.sh decides WHICH job runs and when a
# job is done; everything here walks and tears down a set of pids. Nothing
# here reads the job arrays' meaning beyond the liveness of a pid.
#
# Sourced by verify-pool.sh (which verify-loop.sh sources after verify-kill.sh),
# so the walk is defined before kill_process_tree and interrupt_now are ever
# called, and both files reach the SAME walk — which is the whole reason it is
# shared rather than duplicated: a disagreement between the watchdog's idea of
# "the job's tree" and the interrupt handler's is an orphan.
#
# Sourced, never executed: no `set -u` here (verify-loop.sh sets it). The pool
# file hard-checks these names the way verify-loop.sh checks the other halves.

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
  #
  # Both name checks run BEFORE any eval, including the dead-root shortcut's:
  # that used to sit above them running `eval "$_ct_out=''"` on the unvalidated
  # name and returning 0, so an injection there fired and read as a clean early
  # exit.
  if ! [[ "$_ct_out" =~ ^[A-Za-z_][A-Za-z0-9_]*$ ]]; then
    echo "warn: verify-loop: collect_tree: invalid target variable name; refusing to walk" >&2
    return 1
  fi
  # A dead root costs one `kill -0`, not one `pgrep` fork per queued level:
  # every pid of a dead tree is dead, so the walk has nothing to find. Both
  # callers probe dead roots — the interrupt walks every started job, and the
  # outer-bound branch walks a job it has already taken down — so without this
  # the tick after a kill pays a fork storm for an empty result.
  if [[ "$_ct_root" =~ ^[0-9]+$ ]] && ! kill -0 "$_ct_root" 2>/dev/null; then
    eval "$_ct_out=''"
    return 0
  fi
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
#  * The tree walk covers jobs in state 1 ONLY, taken from POOL_STARTED. A job
#    in state 2 has already been walked: run_pool's completion branch calls
#    kill_process_tree on it once its rc file lands or its pid is gone, so its
#    descendants were collected and signalled then. Re-walking every finished job
#    on every Ctrl-C repeats a walk that can find nothing new, so only the jobs
#    that never completed — the ones actually running when the signal landed —
#    are taken down here. `wait` at the end of this handler reaps the finished
#    ones. (The first draft of this comment claimed state 1 AND state 2, which
#    was the old shape; the filter below has always been state 1 alone.)
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
  local code="$1" i pid pids="" alive polls tree survivors
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
  # Name whatever survived the SIGKILL round, the same way kill_process_tree
  # does. Without it a descendant that ignores both signals leaves this handler
  # silently and the leak is invisible: `wait` below skips precisely those pids,
  # so nothing else reports them, and "still alive after SIGKILL" is the only
  # evidence a later diagnosis has. A zombie answers `kill -0`, so it is
  # counted as alive here and named; that is the honest reading (this shell
  # could not reap it), and `wait` has already been given its chance below.
  survivors=""
  for pid in $pids; do
    if kill -0 "$pid" 2>/dev/null; then survivors="$survivors $pid"; fi
  done
  if [ -n "$survivors" ]; then
    echo "warn: verify-loop: still alive after SIGKILL: ${survivors# }" >&2
  fi
  # Cleanup BEFORE the reap. _extra_cleanup removes the #827/#1028 failure
  # captures and the #1069 ledger temp dir, and is the single owner of
  # `rm -rf "$RUN_DIR"` — duplicating it here would only add a second place
  # where the private directory's lifetime is decided. It runs first because
  # the reap below is the only step that can still block: removing files does
  # not depend on the jobs being reaped, so a reap that stalls on a pid this
  # shell does not own cannot strand the temp state.
  #
  # This is a cross-file call into verify-loop.sh by design, and it is the
  # declared cleanup hook rather than a helper reached for convenience:
  # verify-loop.sh defines `_extra_cleanup` and hard-checks it at startup
  # (`type -t _extra_cleanup` → exit 2) alongside every other name this path
  # depends on, so a rename is a loud refusal to run, not a Ctrl-C that leaks
  # the run's temp state. The coupling stays as documented — the alternative is
  # a second owner of `rm -rf "$RUN_DIR"`, which is how a temp dir survives its
  # own trap.
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
