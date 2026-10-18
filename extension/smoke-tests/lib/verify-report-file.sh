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
# the interrupt path — leaves either nothing at the path, or the 0-byte file the
# driver created with `O_EXCL` before the run started. Both are unattributable to
# the reader. The file is NEVER left holding a half-written name list: names are
# buffered, written to a temp file in the same directory, and `mv`'d into place,
# so a reader that sees the path sees either the previous content or the
# complete list, never a partial one.
#
# The path must already be a regular file the driver created. `write_verify_report`
# refuses a symlink (and a missing file, and any other non-regular node): a
# shell redirection writes through a symlink to whatever it points at, which
# would make this function an arbitrary-file writer for anything that could plant
# a link at the path. The driver's reader opens with `O_NOFOLLOW` anyway, so a
# symlinked report was never readable — refusing the write costs nothing and
# leaves the run unattributable, the same outcome as no report at all.

# write_verify_report — emit the out-of-band verdict, if one was asked for.
#
# Reads `names` (the failing test paths, in argument order) from verify-loop.sh,
# the same array the `FAILED: <n> test(s)` summary is built from. Takes no
# arguments: a parameterised signature would offer a caller the chance to state
# a list different from the one the run produced, which is the exact disagreement
# this channel exists to make impossible.
write_verify_report() {
  [ -n "${VERIFY_REPORT_FILE:-}" ] || return 0
  local count="${#names[@]}" line tmp
  # Buffer first, write once. Assigning to `line` cannot fail on a name that
  # has already been printed to stdout, so the file appears either complete or
  # absent rather than mid-list.
  line=""
  local name
  for name in "${names[@]}"; do
    line="${line}${name}"$'\n'
  done
  line="${line}FAILED-TESTS: ${count}"
  # #1404 fix round 3 — refuse to follow a symlink. `printf > path` truncates
  # whatever `path` RESOLVES to, so a report path swapped for a symlink to
  # another file turns the loop into an arbitrary-file writer: the victim's
  # content is destroyed and replaced with a verdict list. The driver creates
  # this file itself with `O_EXCL` in a 0700 dir and the reader opens it with
  # `O_NOFOLLOW`, so a symlink at the path is never the file the driver made —
  # the correct response is to write nothing and leave the run unattributable
  # (a park), which is the fail-closed direction this whole channel obeys.
  # `-f` alone is not enough: `[ -f ]` is true through a symlink to a regular
  # file, which is precisely the case being refused.
  if [ -L "$VERIFY_REPORT_FILE" ] || [ ! -f "$VERIFY_REPORT_FILE" ]; then
    echo "warn: verify-loop: \$VERIFY_REPORT_FILE is not a regular file the driver created (missing, a symlink, or some other node); refusing to write through it — the run's verdict is out-of-band-unreadable" >&2
    return 0
  fi
  # Write through a temp file in the SAME directory and `mv` it into place, so
  # the path the reader opens is never half-written and never opened while a
  # redirection has it truncated. Same directory because `mv` across filesystems
  # is a copy-then-unlink, which would reintroduce the window (and fail where the
  # dir is a mount point). The driver pre-created the target with `O_EXCL`, so
  # the replace is a rename onto an existing regular file, not a creation.
  tmp="${VERIFY_REPORT_FILE}.part.$$"
  if ! printf '%s\n' "$line" >"$tmp" 2>/dev/null; then
    rm -f "$tmp" 2>/dev/null
    echo "warn: verify-loop: could not write the verify report file; the run's verdict is out-of-band-unreadable" >&2
    return 0
  fi
  # 0400 before the rename, so the file is never briefly readable by group or
  # other at its final name. The driver is the only reader and runs as the same
  # user; a failed chmod does not invalidate the content, so it is not fatal.
  chmod 400 "$tmp" 2>/dev/null
  if ! mv -f "$tmp" "$VERIFY_REPORT_FILE" 2>/dev/null; then
    rm -f "$tmp" 2>/dev/null
    echo "warn: verify-loop: could not move the verify report into place; the run's verdict is out-of-band-unreadable" >&2
    return 0
  fi
  return 0
}
