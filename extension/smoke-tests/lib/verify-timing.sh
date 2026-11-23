#!/usr/bin/env bash
# Issue #1878 — the per-test wall-clock record and the slowest-first summary.
#
# PURELY ADDITIVE — WITH THE CEILING KNOB OFF. Nothing here starts, bounds, signals
# or kills a job: the pool and the watchdog do that exactly as before, and this file
# only ever reads the moments they already recorded. `verify-pool.sh` sources it and writes two
# integers per job — `JOB_STARTED_AT[i]` at `start_job`, `JOB_STOP[i]` at
# `finish_job` — and the loop's own replay step turns that pair into a row. If
# every function here were deleted while the ceiling knob is off, the run's
# tests, verdicts, exit codes, captures and kill behaviour would be byte-identical;
# only the timing lines and the block would disappear. That is the property the
# #1878 scope rests on, and it is why the timing is stored in its own file rather
# than spread across the half that owns the pool. The ceiling is the declared
# exception to that claim, and the scoping is not a hedge: with
# `PI_ENSEMBLE_VERIFY_TIMING_CEILING_S` SET, a file this file reports as over the
# bound becomes a NAMED failure of the run — a different verdict and a different
# exit code — so a reader who deleted the functions below with the knob on would
# change a verdict, which is exactly what the sentence above promises cannot happen
# while the knob is off.
#
# What is recorded, and where
#
#   One row per TEST, written by `record_timing` from the loop's PARENT shell —
#   the one process that holds both stop clocks, so it is also the one that can
#   name the outcome. A row is
#
#     <duration>\t<file>\t<outcome>
#
#   in `$RUN_DIR/timing.tsv`, inside the run's private 0700 directory that the
#   EXIT trap removes as one unit — the same storage convention as the `<n>.out`
#   captures, the `<n>.rc` exit codes and the `<n>.timeout` marker: one file per
#   run, never a predictable path outside it.
#
#   The row's outcome is the same verdict the rest of the run already states:
#   `pass` or `fail` from the job's exit code, `timeout after <N>s` when the
#   job's timeout marker exists. It is derived from the same marker the `FAILED:`
#   line is derived from, in the same step, so the block and the marker cannot
#   disagree about one test. The outcome is also the field the ceiling reads to
#   EXEMPT a watchdog-killed row (R6): its seconds measure the bound, not the test.
#
#   A row's file field is the path the CALLER passed, verbatim — a shell-expanded
#   absolute path, `smoke-tests/x.ts`, `./x.ts`. That is why every comparison the
#   ceiling and the allow-list make goes through `timing_key`, which reduces every
#   spelling to one path relative to `extension/`. The record itself is left as
#   given, because the `TIME` lines and the `FAILED:` names must name what the
#   caller asked for.
#
# The clock is bash `SECONDS`, whole seconds — the same choice the two existing
# timing sites make (`run_test_with_timeout`'s `start=$SECONDS` and the pool's
# `JOB_STARTED_AT[i]=$SECONDS`) for the same reason: it is portable to bash 3.2,
# where a nanosecond clock is not. A duration is therefore a whole number of
# seconds and can legitimately read `0` for a test that finished inside one tick
# — `0` is a measurement, not an absent one, which is why the guards below test
# for EMPTY rather than for zero (`$SECONDS` starts at 0, so the first job of
# every run has a start clock of exactly 0). A clock that was never written is
# EMPTY, and a job with an empty clock gets NO row: with no end there is no
# duration, and a printed `0` would read as "this test is fast".
#
# What is printed
#
#   `emit_timing_lines` — one `TIME <seconds> <file>` line per test, in argument
#   order, printed by the replay step beside the test's own output. `TIME` is a
#   prefix no consumer parses: the attribution readers key on `FAILED:` and the
#   tally on `^P: <n>  F: <n>$` (src/work-driver-verify-names.ts), so a line that
#   is neither cannot enter either. It is deliberately unindented — an indented
#   row under a tally is harvested as evidence by the consolidated-tally reader,
#   and `  <file>  21.4s` is the third-party-gate shape that
#   work-driver-verify-tally.ts documents as an anti-pattern.
#
#   `emit_timing_summary` — after everything the run already prints: a header
#   naming the window, the rows slowest first, then one
#   `TOTAL wall <s>  sum <s>  max <s>` line. `wall` is the pool's own clock, from
#   the first job's start to the drain, so a pooled run's `wall` is LESS than
#   `sum` — which is exactly why the block prints both rather than one number
#   whose meaning a reader would have to guess. `sum` and `max` are taken over the
#   whole record — every test that ran, the same set `emit_timing_lines` prints and
#   the block draws its rows from — so a small `N` shrinks the rows, not the totals.
#
# Two contract decisions, both pinned by smoke-tests/test-verify-loop-timing.ts:
#
#   * Digest mode prints NO timing. `--digest`'s stdout is pinned to exactly one
#     line on all-pass (`P: <n>  F: 0`) and to the summary marker and the tally as
#     its last two lines on failure — test-ci-verify-digest.ts cases 1/2/3/4 and
#     test-verify-loop-jobs-from-host.ts case 3. Appending a block there would
#     break the one-line contract those consumers parse, so the digest stays the
#     verdict channel and the block is the extra normal mode prints.
#   * A run that never reaches the reporter prints nothing. The interrupt path
#     exits 130/143 without entering `report_results`, and a job still in flight
#     when the signal landed has a start and no stop — so it is ABSENT from the
#     record. The vacuous run (every argument a skipped live test, exit 3) never
#     starts a pool and so times nothing either.
#
# Both are opt-out: `PI_ENSEMBLE_VERIFY_TIMING=0` prints neither the lines nor the
# block, and changes nothing else about the run.

# The knob, read once here at source time. Anything but exactly `0` is on,
# matching how the pool and the watchdog read their knobs: a junk value keeps the
# shipped behaviour and says so, rather than silently turning a feature off.
VERIFY_TIMING=1
if [ "${PI_ENSEMBLE_VERIFY_TIMING:-1}" = "0" ]; then
  VERIFY_TIMING=0
elif [ -n "${PI_ENSEMBLE_VERIFY_TIMING:-}" ] && ! [[ "${PI_ENSEMBLE_VERIFY_TIMING}" =~ ^[01]$ ]]; then
  echo "warn: verify-loop: PI_ENSEMBLE_VERIFY_TIMING must be 0 or 1; got '${PI_ENSEMBLE_VERIFY_TIMING}', timing stays on" >&2
fi

# How many files the slowest-first block lists — `PI_ENSEMBLE_VERIFY_TIMING_TOP_N`,
# named like every other knob this loop reads. One to four digits only: anything
# else falls back to the shipped 30 with the rejected value named, because a typo
# in a bound the operator chose is worth one line of stderr — the same discipline
# as the job-count and timeout parses. The width is part of the parse, not a
# sanity check after it: a value of any length is accepted by `^[0-9]+$`, and one
# long enough to overflow an arithmetic context would reach `head -n` and the
# `[ -lt ]` comparison below as a number this script cannot represent. `0` is
# legal and means "header and TOTAL only", which is how an operator asks for the
# totals without the rows.
VERIFY_TIMING_TOP_N=30
if [ -n "${PI_ENSEMBLE_VERIFY_TIMING_TOP_N:-}" ] && [[ "${PI_ENSEMBLE_VERIFY_TIMING_TOP_N}" =~ ^[0-9]{1,4}$ ]]; then
  VERIFY_TIMING_TOP_N="$PI_ENSEMBLE_VERIFY_TIMING_TOP_N"
else
  if [ -n "${PI_ENSEMBLE_VERIFY_TIMING_TOP_N:-}" ]; then
    echo "warn: verify-loop: PI_ENSEMBLE_VERIFY_TIMING_TOP_N must be 1-4 digits; got '${PI_ENSEMBLE_VERIFY_TIMING_TOP_N}', showing 30" >&2
  fi
  VERIFY_TIMING_TOP_N=30
fi


# The ceiling and the committed allow-list it reads are their own half, sourced here
# rather than spread across the record: the record's file owns the clocks, the
# printing and the reset, and this file owns the bound, the list and the verdict. It
# is sourced at the END of the parse block so `VERIFY_TIMING_CEILING_S` has its
# shipped value before anything reads it, and before verify-pool.sh's hard check of
# the five timing names runs. `TIMING_FILE` above is read, never assigned, by it.
. "$(dirname "${BASH_SOURCE[0]}")/verify-timing-ceiling.sh"

# The split is only safe while BOTH halves arrive. `verify-pool.sh` hard-checks the
# five timing names, but it runs BEFORE this file is sourced by anything that needs
# them, and `timing_ceiling_offenders` is the name whose absence is silent: with the
# half missing, an armed run calls nothing, prints no `CEILING:` line and exits 0 — the
# ratchet off while every knob says it is on, which is the one verdict a reader cannot
# distinguish from a run with nothing over the bound. A missing file here is a broken
# install, not a configuration, so it is a hard stop naming the file rather than a
# warning the summary scrolls past.
for _timing_ceiling_name in timing_ceiling_offenders timing_key; do
  if [ "$(type -t "$_timing_ceiling_name" 2>/dev/null)" != "function" ]; then
    echo "verify-loop: $(dirname "${BASH_SOURCE[0]}")/verify-timing-ceiling.sh did not define $_timing_ceiling_name; the timing ceiling cannot run" >&2
    exit 2
  fi
done
unset _timing_ceiling_name

# The record lives beside the captures, in the run's private directory. Kept in a
# variable rather than derived at each call site, so the functions below cannot
# disagree about which file holds the run's timings.
TIMING_FILE=""
# The pool's own clock: opened by `run_pool` when it admits the first job, closed
# by `timing_finish` when it drains. Separate from the per-job clocks because it
# answers a different question — how long the RUN took, not one test.
VERIFY_POOL_STARTED_AT=""
VERIFY_POOL_WALL=0

# timing_start <run-dir> — begin a run's record, in the directory the captures
# already live in, so the record is removed by the trap that removes them. All
# three pieces of state are reset here: a sourced file's variables survive a
# previous run in the same shell, and a stale record would print another run's
# times. An empty run dir is a caller bug and is NAMED: without the path there is
# nowhere to record, and the alternative — a default path — is a predictable file
# in TMPDIR that a sibling run could read or overwrite.
timing_start() {
  TIMING_FILE=""
  VERIFY_POOL_STARTED_AT=""
  VERIFY_POOL_WALL=0
  # Drop the previous run's cached allow-list with the previous run's record: this
  # file is SOURCED, so the rows survive a run in the same shell, and a list that
  # still read as loaded would exempt this run's files by the last run's answer — a
  # renamed or emptied list would keep exempting under the old rows. FIRST, ahead of
  # every early return below: a run that timed itself off, or got no run directory, or
  # could not create its record still ends the previous run's authority, and a reset
  # parked after those returns left a stale list loaded for whatever came next.
  _TIMING_ALLOWLIST_ROWS=""
  _TIMING_ALLOWLIST_LOADED=0
  if [ "$VERIFY_TIMING" -ne 1 ]; then return 0; fi
  local run_dir="${1:-}"
  if [ -z "$run_dir" ]; then
    echo "warn: verify-loop: no run directory for the timing record; per-test times will be absent" >&2
    return 1
  fi
  if ! : >"$run_dir/timing.tsv" 2>/dev/null; then
    echo "warn: verify-loop: could not create the timing record in $run_dir; per-test times will be absent" >&2
    return 1
  fi
  TIMING_FILE="$run_dir/timing.tsv"
  return 0
}

# timing_finish — close the run's own wall clock. Called by `run_pool` once the
# pool has drained, and not by the reporter: the reporter does its own work, and
# that work is not the pool's duration.
timing_finish() {
  if [ -z "$VERIFY_POOL_STARTED_AT" ]; then return 0; fi
  VERIFY_POOL_WALL=$((SECONDS - VERIFY_POOL_STARTED_AT))
  [ "$VERIFY_POOL_WALL" -ge 0 ] || VERIFY_POOL_WALL=0
}

# record_timing <file> <secs> <outcome> — append one test's row. Called from the
# loop's PARENT shell, never from a job subshell: a subshell could append out of
# order, and its write could not be told apart from a sibling's. `secs` is only
# ever a real elapsed value the caller subtracted from the pool's own clocks;
# anything unparseable is REFUSED rather than recorded as 0, so a lost start or
# stop reads as a missing row and not as a fast test.
record_timing() {
  [ -n "$TIMING_FILE" ] || return 0
  local file="${1:-}" secs="${2:-}" outcome="${3:-unknown}"
  if [ -z "$file" ] || ! [[ "$secs" =~ ^[0-9]+$ ]]; then
    return 0
  fi
  if ! printf '%s\t%s\t%s\n' "$secs" "$file" "$outcome" >>"$TIMING_FILE" 2>/dev/null; then
    # Losing the record must not change the run's verdict: the timings are an
    # extra, and the tests and their exit codes have already been decided.
    echo "warn: verify-loop: could not append the timing for $file; it will be absent from the summary" >&2
  fi
}

# record_job_timing <i> <rc> <timed_out> — the timing row for one finished job.
# Takes the pool's two clocks for job <i>, the replay's own reading of its exit
# code, and
# the replay's one reading of the timeout marker. Refuses to record anything
# unless both clocks were actually written (see the header: no end, no duration,
# no row). The outcome is read from the SAME timeout
# marker the `FAILED:` line is read from — passed in as `timed_out` so this step
# reads the marker once and both outputs see the same answer.
record_job_timing() {
  local i="$1" rc="$2" timed_out="$3" started stopped secs outcome
  [ -n "$TIMING_FILE" ] || return 0
  started="${JOB_STARTED_AT[$i]:-}"
  stopped="${JOB_STOP[$i]:-}"
  [[ "$started" =~ ^[0-9]+$ ]] && [[ "$stopped" =~ ^[0-9]+$ ]] || return 0
  secs=$((stopped - started))
  [ "$secs" -ge 0 ] || return 0
  if [ "$timed_out" -eq 1 ]; then
    # The timeout is the MARKER, not the exit code: 214 is an ordinary code a test
    # may return itself, and only this file says the watchdog fired — the same rule
    # the `FAILED:` line follows, so the two cannot name different tests.
    outcome="timeout after ${VERIFY_TEST_TIMEOUT_S}s"
  elif [ "$rc" -eq 0 ]; then
    outcome=pass
  else
    outcome=fail
  fi
  record_timing "${JOB_TESTS[$i]}" "$secs" "$outcome"
}

# emit_timing_lines — the per-test `TIME <seconds> <file>` lines, in the order they
# were recorded (argument order, since the replay walks the jobs in the order the
# caller passed them).
emit_timing_lines() {
  [ -n "$TIMING_FILE" ] || return 0
  [ -f "$TIMING_FILE" ] || return 0
  local secs file _rest
  while IFS=$'\t' read -r secs file _rest; do
    [ -n "$file" ] || continue
    echo "TIME $secs $file" >&2
  done <"$TIMING_FILE"
}

# emit_timing_summary — the slowest-first block, printed by report_results after
# everything the run already prints. Rows are sorted by duration descending and
# ties keep the order they were recorded in (`sort -s`), so the block is stable
# across runs and across pool widths — which is what lets a comparison of two runs
# say something about the tests rather than about their scheduler.
emit_timing_summary() {
  [ -n "$TIMING_FILE" ] || return 0
  [ -f "$TIMING_FILE" ] || return 0
  # `rows`/`tab`/`secs` are deliberately NOT named `line`: the reporter calls this
  # from a scope that has a `local line`, and a sourced file's helpers share it.
  local count shown rows secs file outcome i sum max tab
  count="$(wc -l <"$TIMING_FILE" | tr -d ' ')"
  if [ -z "$count" ] || [ "$count" -eq 0 ]; then return 0; fi
  shown="$count"
  if [ "$VERIFY_TIMING_TOP_N" -lt "$shown" ]; then shown="$VERIFY_TIMING_TOP_N"; fi
  echo "SLOWEST: top $shown of $count (N=$VERIFY_TIMING_TOP_N)" >&2
  # The tab as sort's field separator, built rather than inlined: a literal tab in
  # a script is invisible to the next reader and indistinguishable from the spaces
  # an editor may quietly turn it into.
  tab="$(printf '\t')"
  rows="$(sort -t"$tab" -k1,1nr -s "$TIMING_FILE" | head -n "$shown")"
  i=0
  while IFS="$tab" read -r secs file outcome; do
    [ -n "$file" ] || continue
    i=$((i + 1))
    [ "$i" -le "$shown" ] || continue
    # The block row is the per-file line plus its outcome, separated by the same
    # double space the TOTAL line uses between its fields. The outcome is a single
    # word this file writes (`pass`, `fail`, `timeout after <N>s`), so a reader can
    # split on the last double space without a path ever containing one.
    echo "TIME $secs $file  $outcome" >&2
  done <<EOF
$rows
EOF
  # The sums are taken over the whole record — every test that ran, not merely the
  # window the block shows — so the TOTAL line describes the run rather than its
  # top N, and `sum` can be compared against `wall` for any N. `emit_timing_lines`
  # prints the same record in argument order, so lines, block and TOTAL all cover
  # the record (see the header).
  sum=0
  max=0
  while IFS="$tab" read -r secs file _rest; do
    [ -n "$file" ] || continue
    case "$secs" in
      '' | *[!0-9]*) continue ;;
    esac
    sum=$((sum + secs))
    [ "$secs" -gt "$max" ] && max="$secs"
  done <"$TIMING_FILE"
  echo "TOTAL wall ${VERIFY_POOL_WALL}  sum ${sum}  max ${max}" >&2
}

# The timing is a REPORT, not part of the run's verdict stream, so it prints on
# stderr while the verdict stays byte-identical on stdout. Two reasons, both
# observed on this repo's own consumers rather than argued from theory:
#
#   * `extractAttributedTail` (src/work-driver-exec-error.ts) cuts an 800-char
#     window whose exact bytes are the evidence a downstream reviewer reads, and
#     `extractSpecificAssertion` names the first `✗` line inside that window.
#     Timing lines carry no marker and no `✗`, so they cannot become the anchor or
#     the assertion — but they do consume budget: a three-failure run's tail is
#     682 of the 800 chars available, and three more lines would have displaced the
#     `✗` lines the #827 echo exists to surface. On stderr the window is what it
#     was before the feature.
#   * The tally contract pins "the last line of stdout is `P: <n>  F: <n>`", and
#     the digest pins its own stdout to one line on all-pass
#     (test-ci-verify-digest.ts, test-verify-loop-jobs-from-host.ts). Anything on
#     stdout after the report endangers both; stderr cannot.
#
# So: every print in this file goes to stderr, and a consumer that wants the times
# reads them where the warnings already go.
