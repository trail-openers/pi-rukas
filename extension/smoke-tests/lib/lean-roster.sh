#!/usr/bin/env bash
# lean-roster.sh — pi-rukas's own `verify.roster` (.pi/work.json): run the offline smoke
# suite in a tree and write a JUnit report lean's project-test roster can read.
#
#   lean-roster.sh <tree> <report> [<test file> ...]
#
# The roster judges a run by per-test verdicts it reads from a JUnit report, and compares
# the head tree's against the base tree's by name. So each smoke-test file is one
# <testcase>, named by its tree-relative path (`smoke-tests/test-x.ts`), which is the same
# string in both trees, and failing when verify-loop recorded it as anything but `pass`.
#
# The verdicts come from verify-loop's slowest-first summary block, raised to cover every
# file (`PI_ENSEMBLE_VERIFY_TIMING_TOP_N`): its rows are `TIME <s> <file>  <outcome>` on
# stderr, split on the last double space. Test output is never read for names, so a test
# that prints a fake `FAILED:` marker cannot rename another file's verdict. The exit code is
# verify-loop's; only the tail of its output is passed through.
set -u

tree="${1:-}"
report="${2:-}"
if [ -z "$tree" ] || [ -z "$report" ]; then
  echo "usage: lean-roster.sh <tree> <report> [<test file> ...]" >&2
  exit 2
fi
shift 2
cd "$tree/extension" || exit 2

if [ "$#" -gt 0 ]; then
  files=("$@")
else
  mapfile -t files < <(ls smoke-tests/test-*.ts | grep -v -- '-live[.]ts$')
fi
if [ "${#files[@]}" -eq 0 ]; then
  echo "lean-roster: no offline smoke tests enumerated" >&2
  exit 2
fi

out="$(mktemp)"
err="$(mktemp)"
trap 'rm -f "$out" "$err"' EXIT
PI_ENSEMBLE_VERIFY_TIMING_TOP_N=9999 bash smoke-tests/lib/verify-loop.sh --jobs-from-host "${files[@]}" >"$out" 2>"$err"
rc=$?

{
  echo '<?xml version="1.0" encoding="UTF-8"?>'
  echo '<testsuite name="pi-rukas-smoke">'
  awk '
    /^SLOWEST: / { block = 1; next }
    block && /^TOTAL / { block = 0 }
    block && /^TIME / {
      line = substr($0, 6)
      cut = 0
      for (i = length(line) - 1; i > 0; i--) if (substr(line, i, 2) == "  ") { cut = i; break }
      if (cut == 0) next
      head = substr(line, 1, cut - 1)
      outcome = substr(line, cut + 2)
      sp = index(head, " ")
      file = substr(head, sp + 1)
      gsub(/&/, "\\&amp;", file); gsub(/"/, "\\&quot;", file); gsub(/</, "\\&lt;", file)
      if (outcome == "pass") printf "  <testcase classname=\"smoke\" name=\"%s\"/>\n", file
      else printf "  <testcase classname=\"smoke\" name=\"%s\"><failure message=\"%s\"/></testcase>\n", file, outcome
    }
  ' "$err"
  echo '</testsuite>'
} >"$report"

tail -n 200 "$out"
tail -n 50 "$err" >&2
exit "$rc"
