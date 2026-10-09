#!/usr/bin/env bash
# Issue #1028 — CI-log digest recipe for `gh run view <run-id> --log-failed`.
#
# Strips the `job<TAB>step<TAB>timestamp<TAB>` line prefix, keeps ✗ / FAILED: /
# ##[error] / error: lines plus their following indented detail lines, and
# drops every other line — including ✓ lines that happen to contain the word
# "error" (the anchor is a line-start match, not a substring search).
#
# Indented-detail attribution: a line is "indented detail" when it IMMEDIATELY
# follows a kept marker line AND its first character is a space or a tab
# (leading whitespace of any length, of either kind). The attribution stops
# at the first non-indented line, so detail from one ✗ block is never carried
# into the next ✗'s block. A ✓ line is never a detail line, even when indented.
#
# This is the SINGLE source of truth for the digest filter. The test
# (test-ci-log-digest.ts) runs this script against a recorded fixture and
# asserts the invariants; the TS reference in that test mirrors this rule
# (same two-character "first char is space-or-tab" test) and the byte-equality
# assertion keeps them in lockstep.

TAB="$(printf '\t')"
set -u
input="$(cat "$1")"
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
        " "*)
          case "$trimmed" in
            "✗ "*) : ;;
            "✓ "*) : ;;
            "##[error]"*) : ;;
            "FAILED:"*) : ;;
            "error:"*) : ;;
            *) echo "$content";;
          esac
        ;;
        "${TAB}"*)
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
done <<< "$input"
