#!/usr/bin/env bash
# Issue #1028 — CI-log digest recipe for `gh run view <run-id> --log-failed`.
#
# Strips the `job<TAB>step<TAB>timestamp<TAB>` line prefix, keeps ✗ / FAILED: /
# ##[error] / error: lines plus their following indented detail lines, and
# drops every other line — including ✓ lines that happen to contain the word
# "error" (the anchor is a line-start match, not a substring search).
#
# The filter is anchored: each keep pattern matches at the start of the
# stripped content (after the job/step/timestamp prefix). A ✓ line that
# contains "error" mid-text is dropped because the pattern is a line-start
# match, not a substring search.
#
# The script trims leading whitespace from the stripped content for marker
# detection, then prints the original (untrimmed) line. This handles the 2-space
# indent that CI logs add after the timestamp prefix while keeping the anchor
# at the start of the logical line (after leading whitespace).
#
# Indented detail lines are only kept if they are NOT markers themselves AND
# do NOT start with ✓ (a check-mark line is never a detail line, even if
# indented). This prevents ✓ lines from leaking into the digest as "detail".
#
# Indented-detail attribution: a line is "indented detail" when it IMMEDIATELY
# follows a kept marker line AND its first character is a space or a tab
# (leading whitespace of any length, of either kind). The attribution stops
# at the first non-indented line, so detail from one ✗ block is never carried
# into the next ✗'s block. A ✓ line is never a detail line, even when indented.
#
# Shared marker anchors (enforced part of the digest-filter contract, #1028):
# this script, verify-loop.sh's --digest branch, and its #827 tail echo keep
# the SAME line-start marker anchors (✗ / FAILED: / ##[error] / error: above
# — line-start match, not substring). Indented-detail attribution is
# deliberately NOT part of the shared contract and allowed to differ: the
# #827 tail is bounded (first 3 ✗ lines per test, 200 chars each) for the
# 800-char extractAttributedTail window, the digests are unbounded, and
# verify-loop.sh's --digest branch attributes detail to ✗ markers only while
# this script attributes it to any kept anchor.
#
# The filter itself is pinned by test-ci-log-digest.ts, which runs this
# script against a recorded fixture and asserts the invariants; the TS
# reference in that test mirrors this rule (same two-character "first char is
# space-or-tab" test) and the byte-equality assertion keeps them in
# lockstep.

set -u
if [ "$#" -ne 1 ]; then
  echo "ci-log-digest: usage: ci-log-digest.sh <logfile>" >&2
  exit 2
fi
if [ ! -f "$1" ] || [ ! -r "$1" ]; then
  echo "ci-log-digest: cannot read input: $1" >&2
  exit 2
fi
TAB="$(printf '\t')"
state=idle
while IFS= read -r raw || [ -n "$raw" ]; do
  content="$raw"
  content="${content#*${TAB}}"
  content="${content#*${TAB}}"
  content="${content#*${TAB}}"
  trimmed="${content#"${content%%[![:space:]]*}"}"
  is_marker=0
  case "$trimmed" in
    "✗ "*) is_marker=1 ;;
    "##[error]"*) is_marker=1 ;;
    "FAILED:"*) is_marker=1 ;;
    "error:"*) is_marker=1 ;;
  esac
  if [ "$is_marker" -eq 1 ]; then
    echo "$content"
    state=detail
  else
    if [ "$state" = "detail" ]; then
      # Indented = first char is a space or a tab (leading whitespace of any
      # length of either kind). Kept only if it is not itself a marker and
      # not a ✓ line (a check-mark line is never detail, even when indented).
      case "$content" in
        " "* | "${TAB}"*)
          case "$trimmed" in
            "✗ "*) : ;;
            "✓ "*) : ;;
            "##[error]"*) : ;;
            "FAILED:"*) : ;;
            "error:"*) : ;;
            *) echo "$content";;
          esac
        ;;
        *) state=idle;;
      esac
    else
      state=idle
    fi
  fi
done < "$1"
