#!/usr/bin/env bash
# Issue #1404 — the out-of-band verdict channel for verify-loop.sh.
#
# WHY THIS EXISTS
#
# The commit-pr baseline probe decides whether to PUSH with a red gate by
# diffing the failing-test names of the change run against the base run. Those
# names used to be read out of the run's combined stdout+stderr, which a test
# can write to. `failingTestNames` (extension/src/work-driver-verify-names.ts)
# already refuses a stream whose `FAILED: <n> test(s) — <list>` summary does not
# agree with its per-file markers and its `P:/F:` tally, and that holds for a
# lone forgery. It does NOT hold for the triad: a test that prints all three
# shapes at once — a per-file `FAILED: <path>`, a count-matched
# `FAILED: 1 test(s) — <path>` summary, and a non-zero `P:/F:` tally — is
# byte-identical to what the loop itself emits, so it is indistinguishable from
# the loop's own verdict. A base run that is actually GREEN then appears to
# name the change's failure, the change-caused failure is excused, and the cycle
# pushes. Root-anchoring the names does not help (the forged name can sit under
# the probe root), and `probed` is derived from the same stream so it is not an
# independent signal.
#
# So the verdict moves to a channel a test cannot write: the loop writes the
# failing-test names ITSELF to the file named by VERIFY_REPORT_FILE, and the
# loop REMOVES that variable from every test child's environment, so a test
# cannot even learn the path, let alone open it. The driver reads names ONLY
# from those files (extension/src/work-driver-verify-report-file.ts). No file,
# an empty file, a malformed file, or a count that disagrees with its own names
# is unattributable and the cycle parks — which is exactly the pre-#1404
# behaviour, so a project whose verify command is not this loop is no worse off
# than it was before the feature existed.
#
# CONTRACT (the part the TypeScript side parses)
#
#   VERIFY_REPORT_FILE=<absolute path>
#     unset                 — no report is written. This is the shape the
#                             offline suite, CI, and every interactive run use:
#                             the gate output is the deliverable there, and a
#                             report written into an attacker-chosen path would
#                             be a file-write primitive with no consumer.
#     one failing path/line — the failing test paths, in argument order
#     final line            — `FAILED-TESTS: <n>`, n the loop's own fail count
#
# The trailer is the count the loop wrote its own names from (`${#names[@]}`),
# i.e. the SAME fact the summary marker is built from — so a reader can check
# the names against the count rather than trusting either alone. A reader that
# cannot check both is the case this file exists to refuse.
#
# WRITE DISCIPLINE
#
# Written ONCE, after every test has finished, by `write_verify_report`, which
# `report_results` calls on every exit path (all-pass included — an all-pass
# run must produce a file carrying zero names, because a missing file is
# unattributable and a green base must be positively establishable).
#
# A run that never reaches the report half — killed at the pool level, died in
# the interrupt path — leaves either nothing at the path, or a 0-byte file from
# the `: >` below. Both are unattributable to the reader. The file is NEVER
# left holding a half-written name list: names are buffered and written in one
# redirection, so a reader that sees content sees a complete list.

# write_verify_report — emit the out-of-band verdict, if one was asked for.
#
# Reads `names` (the failing test paths, in argument order) from verify-loop.sh,
# the same array the `FAILED: <n> test(s)` summary is built from. Takes no
# arguments: a parameterised signature would offer a caller the chance to state
# a list different from the one the run produced, which is the exact disagreement
# this channel exists to make impossible.
write_verify_report() {
  [ -n "${VERIFY_REPORT_FILE:-}" ] || return 0
  local count="${#names[@]}" line
  # Buffer first, write once. Assigning to `line` cannot fail on a name that
  # has already been printed to stdout, so the file appears either complete or
  # absent rather than mid-list.
  line=""
  local name
  for name in "${names[@]}"; do
    line="${line}${name}"$'\n'
  done
  line="${line}FAILED-TESTS: ${count}"
  # `: >` truncates (or creates) the file BEFORE the redirection of the body
  # would — kept separate so a failure of the body leaves a 0-byte file rather
  # than a stale one from a previous run at the same path.
  if ! : >"$VERIFY_REPORT_FILE" 2>/dev/null; then
    echo "warn: verify-loop: could not create the verify report file at \$VERIFY_REPORT_FILE; the run's verdict is out-of-band-unreadable" >&2
    return 0
  fi
  if ! printf '%s\n' "$line" >"$VERIFY_REPORT_FILE" 2>/dev/null; then
    echo "warn: verify-loop: could not write the verify report file; the run's verdict is out-of-band-unreadable" >&2
    return 0
  fi
  # 0400 — the driver is the only reader and runs as the same user. Tightening
  # the mode costs nothing and removes the group/other-readable window a
  # default-umask file would have had. A failed chmod does not invalidate the
  # content, so it is not fatal; the warning is enough.
  chmod 400 "$VERIFY_REPORT_FILE" 2>/dev/null
  return 0
}
