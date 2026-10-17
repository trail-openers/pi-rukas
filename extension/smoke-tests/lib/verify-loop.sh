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
#   verify-loop.sh <file> [<file> ...]                  — normal mode
#   verify-loop.sh --digest <file> [<file> ...]         — #1028 digest mode
#   verify-loop.sh --jobs-from-host <file> [...]        — pool width from the host
#
# Normal mode: runs every test once, prints each test's full output plus a
# per-failure `FAILED: <file>` marker and a final summary line.
#
# Digest mode (--digest): prints ONLY the failure detail — per-failure
# markers, each failing test's ✗ lines with their indented detail lines, the
# summary marker, and a pass/fail tally line (P: <pass-count>  F:
# <fail-count>). P counts every non-live test that was not a failure — i.e.
# the passing tests (live tests are skipped and count toward neither P nor
# F). No ✓ lines, no passing tests' output. On all-pass it prints only the
# tally line, `P: <n>  F: 0`.
# The #827 echo of the first 3 ✗ lines (truncated to 200 chars) does NOT
# apply in digest mode — the digest prints EVERY ✗ line and its indented
# detail, because the 3×200 bound was sized for the 800-char
# extractAttributedTail window, not for a full digest.
#
# Exit codes (both modes):
#   0  every test passed
#   1  at least one test failed
#   2  usage error (no file arguments)
#   3  no tests ran (every argument was a skipped *-live.ts file)
#
# Stdout contract (digest mode): on failure, the detail described above; on
# all-pass, exactly one line, `P: <n>  F: 0`, with no ✗ and no `FAILED:`.
#
# Known callers — .github/workflows/ci.yml and .pi/verify-cmd — key on the
# exit code and always pass a non-empty glob. Exit 3 is what stops an empty
# glob from passing vacuously.
#
# The caller expands the glob; the script receives the file list.
# Live tests (suffix -live.ts) are skipped in both modes, matching the legacy
# `case "$t" in *-live.ts) continue;; esac` exclusion.
#
# --- #1365 — bounded job pool (lib/verify-pool.sh).
# Tests run concurrently, at most PI_ENSEMBLE_VERIFY_TEST_JOBS at once
# (${VERIFY_TEST_JOBS:-2}; 1 restores the strictly sequential pre-#1365
# shape). With --jobs-from-host and no ambient setting, the count comes from
# host_job_count (4 on a host reporting 8 or more CPUs, 2 otherwise) instead of
# the shipped default of 2 — see that function for why getconf, and why an
# unparseable CPU count sizes down rather than up. The count is clamped to the
# number of collected tests and to 16, with a warning naming the clamp — more
# than 16 concurrent `bun` processes compete with each other for CPU and the
# suite gets slower, not faster.
# Every job still runs under the per-test watchdog above. Output is replayed
# in ARGUMENT order after the pool drains, so both modes' output (and the
# digest) are byte-identical to a sequential run regardless of finish order.
# All per-job temp files live in one private per-run directory (0700, under
# TMPDIR) that the EXIT trap removes.

set -u

# Fixed locale for the whole file. Every digit and range test in this script
# and in verify-pool.sh is written `[0-9]`, and bash's `=~` matches that class
# through the C library under the active collation — so under a UTF-8 locale
# `[0-9]` is not ASCII digits alone. Verified on this host under
# `LC_ALL=en_US.UTF-8`: `[[ "٢" =~ ^[0-9]+$ ]]` (an Arabic-Indic digit) MATCHES,
# and under `LC_ALL=C` the same test does not. So the two `^[0-9]+$` gates here
# — the timeout bound and the pool's job count — would have accepted a non-ASCII
# digit and passed it straight into arithmetic. Set here rather than at each
# test because this file is both run directly and sourced by the smoke harness,
# and a script cannot set a variable its caller will not inherit.
export LC_ALL=C

# The tests build throwaway repositories (`git init --bare <tmp>/origin.git`,
# `git config user.email "t@t"`). With GIT_DIR in the environment — git sets
# it for every hook and for `git rebase --exec` — those commands act on the
# CALLER's repository instead of the temp directory: its config gained
# `core.bare = true` and a fake identity, and every worktree stopped working.
# Drop git's repository-locating variables before any test runs.
unset GIT_DIR GIT_WORK_TREE GIT_INDEX_FILE GIT_COMMON_DIR GIT_PREFIX \
  GIT_OBJECT_DIRECTORY GIT_ALTERNATE_OBJECT_DIRECTORIES GIT_NAMESPACE

# #1017 — forbid live spawns in every offline test. Any offline test that
# reaches the real spawn path (spawnSpecialist) fails loudly in ~5s with the
# FORBID_LIVE_SPAWN error naming the role and the injection point, instead of
# silently burning real model tokens and stalling the suite. Live tests
# (*-live.ts) are skipped before this matters, and a test that needs a (fake)
# child sets PI_ENSEMBLE_ALLOW_LIVE_SPAWN=1 locally. The canary
# (test-verify-loop.ts case 8 + fixture-spawn-env.ts) proves this export
# reaches the child env.
export PI_ENSEMBLE_FORBID_LIVE_SPAWN=1

# #1043 — the /plan investigation cache lives under the git common dir, which a
# worktree resolves to the main clone's .git. An offline test that never installs
# a git-state stub must not write into the real clone's pi-plan-cache, so the
# real lookup is off here. A test that wants the cache installs a stub
# (newPlanCache) — the explicit enable; the canary in test-plan-investigation-cache.ts
# proves this export disables the real lookup.
export PI_ENSEMBLE_PLAN_CACHE=0

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


# #1365 — the watchdog half (#1014: the per-test bound, the descendant-tree
# kill, and the timeout marker) lives in verify-kill.sh so each file stays under
# the §12 500-line cap. Sourced FIRST: verify-pool.sh calls run_test_with_timeout
# and kill_process_tree, and the watchdog calls collect_tree back out of the pool
# file, so the two halves are mutually dependent and the hard name checks below
# run only once both are loaded.
. "$(dirname "${BASH_SOURCE[0]}")/verify-kill.sh"
for _kill_fn in run_test_with_timeout kill_process_tree mark_timeout prepend_timeout_line; do
  if [ "$(type -t "$_kill_fn")" != function ]; then
    echo "error: verify-loop: lib/verify-kill.sh did not define $_kill_fn — the watchdog is broken; refusing to run" >&2
    exit 2
  fi
done
unset _kill_fn

# #1365 — the bounded job pool (verify-pool.sh) runs the tests collected below.
# It calls run_test_with_timeout and kill_process_tree, so it is sourced here,
# after both are defined.
. "$(dirname "${BASH_SOURCE[0]}")/verify-pool.sh"

# #1365 — the reporting half (summary, digest, #827 echo) lives in
# verify-report.sh so each file stays under the §12 500-line cap. Sourced
# unconditionally: `report_results` below is the only exit path for a run that
# collected tests, so a missing half would otherwise surface as "the suite
# printed nothing and exited 0". The same named check the pool gets.
. "$(dirname "${BASH_SOURCE[0]}")/verify-report.sh"
for _verify_fn in report_results emit_tally; do
  if [ "$(type -t "$_verify_fn")" != function ]; then
    echo "error: verify-loop: lib/verify-report.sh did not define $_verify_fn — the reporter is broken; refusing to run" >&2
    exit 2
  fi
done
unset _verify_fn

# The source above is not optional and not best-effort. If verify-pool.sh is
# missing, truncated, or a stale copy from before #1365, `set -u` alone will
# not stop the loop: the missing functions would surface as command-not-found
# and the tests would still be reported as passing. Each name is checked and
# the failure is named, so a broken pool is a hard stop rather than a suite
# whose verdict nobody earned. `collect_tree` is checked too — it is the
# descendant walk both the watchdog and the interrupt handler depend on, so a
# pool that loads without it can kill a hung test's top process and orphan the
# rest of its tree while still reporting the timeout correctly.
for _pool_fn in pool_collect run_pool interrupt_now collect_tree start_job; do
  if [ "$(type -t "$_pool_fn")" != function ]; then
    echo "error: verify-loop: lib/verify-pool.sh did not define $_pool_fn — the test pool is broken; refusing to run" >&2
    exit 2
  fi
done
unset _pool_fn

# pgrep powers the descendant kill; without it only the top-level test
# process would be killed (descendants orphaned). Warn, do not fail.
if ! command -v pgrep >/dev/null 2>&1; then
  echo "warn: verify-loop: pgrep not found — on timeout only the top-level test process will be killed (descendants may be orphaned)" >&2
fi

# --- #1028 — parse the --digest flag, and the host-sizing flag.
#
# Both parse BEFORE the usage check so that a bare `--digest` / `--jobs-from-host`
# with no files is still a usage error. `--digest` stays position-pinned (only
# accepted as the first word) because test-ci-verify-digest.ts pins that argv
# shape; the new flag is accepted in ANY position, which is what lets
# .pi/verify-cmd carry it either side of the test glob — case 4 of
# test-verify-loop-jobs-from-host.ts pins both positions.
#
# A flag is never a test path: each recognised word is `shift`ed out of "$@", so
# the pool only ever collects real paths, and `pool_collect`'s `--` guard against
# dash-leading arguments stays intact.
#
# An unrecognised dash-leading word is a usage error too, not a test path. Before
# this, `verify-loop.sh --diagst …` fell through the `*` arm, got collected, and
# the pool reported "no such file" for a typo in a flag — a run whose real tests
# were never given the flag's behaviour. `--` itself still passes through to the
# pool's own guard (see the explicit arm below) rather than being refused, so the
# documented `-- <files>` shape is unaffected.
DIGEST=0
if [ "$#" -gt 0 ] && [ "$1" = "--digest" ]; then
  DIGEST=1
  shift
fi
# #1365 follow-up — --jobs-from-host: size the pool from the host CPU count when
# the caller did not name a number. Opt-in, and CI does not pass it, so the
# shipped default of 2 stays the CI shape; the host-derived 4 is what this repo's
# own develop gate needs to stay inside PI_ENSEMBLE_VERIFY_TIMEOUT_MS. It lives
# here rather than as an inline expansion in .pi/verify-cmd because that word is
# not a form the review-accept guard (#1125) admits: A5 (`armVerifyLoop`) accepts
# `bash …/verify-loop.sh` only when every word after the script is `--digest` or a
# test path, and `PI_ENSEMBLE_VERIFY_TEST_JOBS="${…:-$(getconf …)}"` is neither.
# A5 is not a general ban on expansions in a `bash` command — it is this arm's
# argv rule — so the sizing has to be a flag the arm recognises.
VERIFY_JOBS_FROM_HOST=0
_args=()
while [ "$#" -gt 0 ]; do
  case "$1" in
    --jobs-from-host) VERIFY_JOBS_FROM_HOST=1 ;;
    --) _args+=("$1") ;;
    --*)
      echo "usage: verify-loop.sh [--digest] [--jobs-from-host] <file> ..." >&2
      echo "error: verify-loop: unknown option '$1'" >&2
      exit 2
      ;;
    *) _args+=("$1") ;;
  esac
  shift
done
set -- ${_args[@]+"${_args[@]}"}

if [ "$#" -eq 0 ]; then
  echo "usage: verify-loop.sh [--digest] [--jobs-from-host] <file> ..." >&2
  exit 2
fi

# Single-execution capture (DECISION 3): every test runs exactly once; its
# output is captured to a temp file that is removed on every exit path.
# #1365 — one private directory for the whole run instead of a temp file per
# job. The pool writes $RUN_DIR/<n>.out and $RUN_DIR/<n>.rc into it and the
# timeout prepend keeps its scratch file there; mktemp -d creates it 0700, so
# no other user of the host can read a test's output, and cleanup is one
# recursive removal rather than a list of derived names. The old shape derived
# `$CAPTURE.<n>` from a single mktemp base, which scattered predictable paths
# across TMPDIR and needed JOB_FILES to remember them.
RUN_DIR="$(mktemp -d "${TMPDIR:-/tmp}/verify-loop.XXXXXX")" || exit 2
chmod 700 "$RUN_DIR" 2>/dev/null || true
# One trap cleans everything on every exit path: the per-test capture, the
# #1028/​#827 failure captures, and the #1069 ledger temp dir (empty when an
# operator-supplied override was honoured).
# #1365: the per-test capture is now the whole $RUN_DIR, removed as one unit.
_extra_captures=()
# #1365 — each statement ends in `|| :`, and that is the load-bearing part.
# bash takes the EXIT trap's final status as the shell's when the trap does not
# call `exit` itself, so one non-zero command in the cleanup turns `exit 1` into
# exit 0: the suite reports a FAILURE and the gate passes. `rm -f` is close to
# unconditional, but ${_extra_captures[*]} is UNQUOTED (word-splitting is
# wanted), so an unreadable RUN_DIR or a root-owned ledger temp can reach the
# tail and decide the verdict.
_extra_cleanup() {
  rm -f ${_extra_captures[*]:-} || :
  if [ -n "$RUN_DIR" ]; then rm -rf "$RUN_DIR" || :; fi
  if [ -n "${_ledger_tmp_dir:-}" ]; then rm -rf "${_ledger_tmp_dir}" || :; fi
}
trap '_extra_cleanup' EXIT

# #1365 — the interrupt path (interrupt_now, now in lib/verify-tree.sh, reached
# through lib/verify-pool.sh) calls `_extra_cleanup` for the same reason the EXIT
# trap just did: RUN_DIR, the #827/#1028 failure captures and the #1069 ledger
# temp dir have to go. The pool used to reach it through a silent `type -t`
# probe, so a rename made Ctrl-C look clean while every one of those stayed on
# disk — the EXIT trap it duplicates never runs on that path. It is now under the
# same hard name check the pool's own functions get. Checked here rather than
# with them because a `type -t` test before the definition would fail for the
# wrong reason. It is not optional, so there is no declared flag and nothing to
# trace when absent: the pool calls it unconditionally and so does the trap
# above, so a run without it is broken before the pool starts. The call site
# names this as the declared hook rather than re-deriving the cleanup.
if [ "$(type -t _extra_cleanup)" != function ]; then
  echo "error: verify-loop: _extra_cleanup is missing — the interrupt path cannot clean the run's temp state; refusing to run" >&2
  exit 2
fi

names=()
# #1365: collect the tests, run them through the pool, then replay each job's
# result in argument order. RUN_DIR is passed explicitly so the pool never
# depends on an ambient temp name.
pool_collect "$RUN_DIR" -- "$@"
total=${#JOB_TESTS[@]}
# Interrupt: every running job's process tree is killed, and the loop does not
# return until each tree is reaped (see interrupt_now).
trap 'interrupt_now 130' INT
trap 'interrupt_now 143' TERM
run_pool "$VERIFY_TEST_JOBS"
for ((i = 0; i < total; i++)); do
  t="${JOB_TESTS[$i]}"
  cap="${JOB_CAP[$i]}"
  rc="${JOB_EXIT[$i]}"
  if [ "$rc" -eq 0 ]; then
    if [ "$DIGEST" -eq 0 ]; then
      cat "$cap"
    fi
  else
    names+=("$t")
    # The timeout is the MARKER, not the exit code: rc==214 is an ordinary exit
    # code a test may return, and only this file says the watchdog fired.
    timed_out=0
    if [ -f "$RUN_DIR/$i.timeout" ]; then timed_out=1; fi
    if [ "$DIGEST" -eq 0 ]; then
      if [ "$timed_out" -eq 1 ]; then
        echo "FAILED: $t (timed out after ${VERIFY_TEST_TIMEOUT_S}s)"
      else
        echo "FAILED: $t"
      fi
      cat "$cap"
    fi
    # #827 — keep this test's capture so its `✗` lines can be repeated
    # after the summary (below); removed on exit with $RUN_DIR. Also used
    # by #1028 digest mode to emit ✗ lines + indented detail.
    # #1365: the source of this copy is the job's own capture, not $CAPTURE.
    #
    # #1365 fix round: the copy lives INSIDE $RUN_DIR (this run's private 0700
    # directory) and a mktemp failure degrades to the empty-placeholder path
    # instead of `exit 2`. The old shape allocated in ${TMPDIR:-/tmp} with
    # `|| exit 2`, after every test had already run and been printed — so one
    # failure of a scratch-file allocation threw away a finished run's verdict
    # and reported the usage error (2) where the caller expected 0 or 1.
    capfile="$(mktemp "$RUN_DIR/keep-$i.out.XXXXXX" 2>/dev/null)"
    if [ -z "$capfile" ] || ! cp "$cap" "$capfile"; then
      # Could not keep a copy — degrade gracefully: the test has already failed
      # and its per-test output was printed above, so a missing echo is a
      # cosmetic gap in the tail, not a new failure. Do NOT register the
      # capfile, so the echo loop below skips it.
      echo "warn: verify-loop: could not capture output of $t for the tail echo; its ✗ lines will be absent from the summary tail" >&2
      [ -n "$capfile" ] && rm -f "$capfile"
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

# Nothing ran (every argument was skipped): refuse rather than pass vacuously.
if [ "$total" -eq 0 ]; then
  echo "verify-loop: no tests ran" >&2
  exit 3
fi

# The pass/fail tally line and the whole reporting half live in
# verify-report.sh (sourced above) — see that file for the digest/echo
# contract and the 800-char tail-window rationale.
#
# #1365 — `names` and `_extra_captures` are index-aligned (both pushed once per
# failing test, in order; the digest reads them by shared index in
# verify-report.sh). A mismatch would attach one test's ✗ lines to another's
# marker and read as a real assertion failure, so it fails loudly rather than
# reporting. (An EMPTY placeholder from a cp failure is still paired; a LENGTH
# mismatch is the bug.)
#
# The check runs BEFORE `report_results`, which exits: after that call it is
# unreachable, so a mispaired digest would already have been printed and the
# run's verdict handed out before the mismatch was noticed.
if [ "${#names[@]}" -ne "${#_extra_captures[@]}" ]; then
  echo "error: verify-loop: internal error — ${#names[@]} failure names against ${#_extra_captures[@]} captured outputs; the summary tail is unreliable" >&2
  exit 1
fi

report_results "$total"
