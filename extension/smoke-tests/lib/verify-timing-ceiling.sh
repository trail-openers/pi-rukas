#!/usr/bin/env bash
# Issue #2449 — the per-file wall-time ceiling and the committed allow-list it reads.
#
# Sourced by `verify-timing.sh` at the end of its own parse block, so every name here
# is defined before `verify-pool.sh`'s hard check of the five timing function names
# runs. Split out of that file for the AGENTS.md §12 500-line cap: the timing record and
# its printing live beside the clocks that wrote them, and the ratchet that reads the
# record is a separate concern with its own list, its own key, and its own knob.
#
# PURELY ADDITIVE WHILE THE KNOB IS OFF, and that claim is the whole reason the ceiling
# lives in a file that can be deleted. With
# `PI_ENSEMBLE_VERIFY_TIMING_CEILING_S` unset, every function below returns at its first
# gate, so a run reads NO allow-list and prints NO verdict: `TIMING_ALLOWLIST_PROBE`
# stays empty and the loop's stdout/stderr are what they were before the ceiling existed.
# WITH THE KNOB SET the claim ends: a row this half reports as over the bound becomes a
# NAMED failure of the run — a different verdict and a different exit code.
#
# One contract is shared with the sourcing file and cannot be moved: `TIMING_ALLOWLIST`
# and `TIMING_ALLOWLIST_BASE` are resolved from `BASH_SOURCE`, which is THIS file. Both
# land on `extension/` because this half sits one level under it, exactly as
# `lib/verify-timing.sh` does. The shrink-only gate
# (smoke-tests/test-verify-timing-allowlist.ts) sources `verify-timing.sh` and calls
# `_timing_allowlist_entries` bare, so the name and its bare one-shot print are the
# gate's interface, not an implementation detail.

# The per-file wall-time ceiling — `PI_ENSEMBLE_VERIFY_TIMING_CEILING_S`, seconds.
# OFF by default and OFF is the shipped state: wall times are load- and
# neighbour-sensitive (the same file measured 99 s and 139 s in two runs of this
# repo's own suite), so a bound every local run enforced would flake on a shared
# host. An operator who wants the ratchet names the number; CI names it in its own
# step env. Accepted only as 1-4 digits — the width is part of the parse, not a
# check after it, so a value long enough to overflow an arithmetic context can never
# reach one. A rejected value is named on stderr and leaves the ceiling OFF, the
# shape the TOP_N parse in verify-timing.sh uses; `0` is off and says nothing, being
# the documented way to ask for no bound.
VERIFY_TIMING_CEILING_S=0
if [ -n "${PI_ENSEMBLE_VERIFY_TIMING_CEILING_S:-}" ] && [[ "${PI_ENSEMBLE_VERIFY_TIMING_CEILING_S}" =~ ^[0-9]{1,4}$ ]]; then
  # `$((10#…))`, not the matched string: bash reads a leading zero as OCTAL, so
  # `[ 008 -gt 0 ]` is a syntax error whose status is FAILURE. A verbatim store would
  # have let `00`, `000` and `0030` past the parse above and then refused them at
  # every `-gt 0` gate below — the ceiling silently OFF, with none of the warning the
  # junk arm prints. The radix prefix says decimal and makes each spelling answer as
  # the number it names; `10#` is accepted by bash 3.2, the floor this file targets.
  VERIFY_TIMING_CEILING_S="$((10#$PI_ENSEMBLE_VERIFY_TIMING_CEILING_S))"
else
  if [ -n "${PI_ENSEMBLE_VERIFY_TIMING_CEILING_S:-}" ] && [ "${PI_ENSEMBLE_VERIFY_TIMING_CEILING_S}" != "0" ]; then
    echo "warn: verify-loop: PI_ENSEMBLE_VERIFY_TIMING_CEILING_S must be 1-4 digits; got '${PI_ENSEMBLE_VERIFY_TIMING_CEILING_S}', ceiling stays off" >&2
  fi
  VERIFY_TIMING_CEILING_S=0
fi
# NO SHIPPED CODE PATH FORCES A CEILING. The off-path canary of
# test-verify-timing-ceiling.ts needs a run that asked for no bound and still walks the
# list, and the seam that used to supply it was read HERE, from the loop's own
# environment: one exported name armed the ratchet for a run nobody asked to grade and
# failed it with nothing naming why. So nothing below this parse can turn the ceiling
# on. The canary arms its run from OUTSIDE the shipped code instead — the harness hands
# that one spawn the real knob through bash's startup file, and the parse above is the
# only thing that can read it back. Forcing it can never invent an exemption either:
# the list still has to exist and name the path.
# The committed exemption list — see `_timing_allowlist_entries`. Its path is
# overridable so a test exercises an exemption against a temp file instead of editing
# the shipped one, which the parallel suite would read half-written. It is a PATH and
# nothing more: it decides WHICH file an armed run reads, never WHETHER one is read —
# the knob above is the only arm of the ceiling. The harness names an explicit path on
# every spawn rather than relying on the default below, which is resolved relative to
# this file and so names no list when a caller has copied these halves elsewhere.
TIMING_ALLOWLIST="${TIMING_ALLOWLIST:-$(dirname "${BASH_SOURCE[0]}")/../../timing-allowlist.json}"

# The base the allow-list is written against: `extension/`, resolved from THIS file's
# own location (`lib/verify-timing-ceiling.sh` sits one level under it), never from
# `$PWD`. The `$PWD`-relative base is wrong because the loop's cwd is not fixed — the
# harness invokes the loop from `smoke-tests/`, the operator's glob from `extension/` —
# and a key that depends on where the caller happened to `cd` matches the list on one
# host and not another. One base, tied to the file, is the whole normalisation contract.
TIMING_ALLOWLIST_BASE="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." 2>/dev/null && pwd)"

# Normalised key of one path, as the ceiling matcher and the allow-list both know it:
# the path relative to `extension/`. Needed because the record stores whatever the
# CALLER passed — a glob the shell expanded to `$PWD/smoke-tests/test-x.ts`, a bare
# `smoke-tests/test-x.ts`, a `./x.ts` — while the list stores one spelling. ONE
# function, used by the matcher and by the shrink-only gate alike, so the two cannot
# drift into exempting different sets of files (R4).
timing_key() {
  local k="${1#./}"
  k="${k#./}"
  local base
  # Assigned in its own statement, not in the `local`: `local x="$base/"` word-splits
  # the value on the field separator, so the strip below would remove only the FIRST
  # path segment and no absolute path would ever match a list entry.
  base="$TIMING_ALLOWLIST_BASE/"
  if [ -n "$TIMING_ALLOWLIST_BASE" ] && [ "${k#"$base"}" != "$k" ]; then
    k="${k#"$base"}"
  else
    local pwd_prefix
    pwd_prefix="${PWD}/"
    [ "${k#"$pwd_prefix"}" != "$k" ] && k="${k#"$pwd_prefix"}"
  fi
  echo "$k"
}

# `secs` is a record field, so anything but a decimal is refused rather than
# evaluated: a junk value has no business answering a bound it was never measured
# against. No knob gate here: its only caller, `timing_ceiling_offenders`, is gated
# first, and a second one would add a branch that cannot be reached to decide anything.
timing_over_ceiling() {
  local secs="${1:-}"
  [[ "$secs" =~ ^[0-9]+$ ]] || return 1
  [ "$VERIFY_TIMING_CEILING_S" -gt 0 ] || return 1
  [ "$secs" -gt "$VERIFY_TIMING_CEILING_S" ]
}

# The allow-list of the current run, `secs<TAB>key` per entry, one line each, in the
# order the committed JSON declares them. Populated by the ONE read this file makes —
# `_timing_allowlist_entries` below — and emptied by `timing_start`, so every
# `timing_ceiling_offenders` in the shell's next run re-reads. A sourced file's
# variables survive the previous run in the same shell, so the reset is part of the
# record's reset and not an extra: a stale list would exempt the previous run's files.
_TIMING_ALLOWLIST_ROWS=""
# Has the list been read since the record opened? Deliberately NOT derived from the
# rows above being empty: a list that parses to zero entries has been read, and a run
# would otherwise fork it once per row — which is the cost this cache exists to pay
# down, and the shape the warning below has to be able to see.
_TIMING_ALLOWLIST_LOADED=0

# Read the committed allow-list AT MOST ONCE per run: one `secs<TAB>key` line per entry
# on stdout, and the same lines cached in `_TIMING_ALLOWLIST_ROWS` for `timing_listed`.
# Printing them is the contract two offline gates read —
# test-verify-timing-allowlist.ts sources this file and calls this function bare, and
# its whole shrink-only ratchet is judged against the rows this prints — so the cache
# sits BEHIND the print rather than replacing it, and the gate sees the same bytes
# before and after the cache landed. stdout is the answer and stderr is the diagnostic,
# the same split `timing_ceiling_offenders` keeps for the same reason.
#
# The knob gate at the top is the whole cost claim, and the probe measures it from the
# OUTSIDE: a run that asked for no ceiling must not read this list at all, because the
# read forks the awk at the bottom of this function (~2 forks per timing row was ~3,154
# forks / ~21 s on this repo's own suite). `TIMING_ALLOWLIST_PROBE` names a file that
# gets one line per read — a caller cannot see a fork, so the read announces itself,
# and case 7g of test-verify-timing-ceiling.ts runs a whole loop with the knob unset
# and asserts that file stays EMPTY. Its mutant twin is a harness-only seam (see the
# note at the ceiling's parse): the canary forces the ceiling from outside the shipped
# code, so the same assertion is observed RED rather than argued — a gate nobody has
# watched fail proves nothing. Forcing it can never invent an exemption: the list still
# has to exist and name the path. The probe is counted here, at the fork, and NOT in the
# caller-side gates above it: a row that was under the bound asked the list nothing and
# must not be tallied as a read, or the off-path witness would report reads the run
# never paid for. Both seams are unset in the shipped state and pinned off by the
# harness `env()`.
#
# The fields ACCUMULATE ACROSS LINES: the file may carry one entry per line, or the
# same JSON pretty-printed with one field per line (what a formatter does to it), and
# a parser that required both on one line read the pretty-printed shape as an EMPTY
# list — every entry silently stopped exempting anything, and a run whose only fault
# was its formatting failed on its whole slow set. A `file` with no following
# `seconds` yields no record, so junk costs an exemption rather than inventing one.
#
# ABSENT, UNREADABLE OR EMPTY IS DISCLOSED, NEVER SILENT: each of those three states
# prints ONE line naming the path, and exempts NOTHING — the fail-closed side. Silence
# is the bug this closes: an operator who armed the ratchet against a list whose path
# was wrong read a run that failed every slow file and said nothing about the list, so
# the obvious next move was to widen it. One line per RUN, not per row: the gate below
# returns before the read, so a run of a hundred rows warns once.
_timing_allowlist_entries() {
  [ "$VERIFY_TIMING_CEILING_S" -gt 0 ] || return 0
  [ "$_TIMING_ALLOWLIST_LOADED" -eq 1 ] && { printf '%s\n' "$_TIMING_ALLOWLIST_ROWS"; return 0; }
  _TIMING_ALLOWLIST_LOADED=1
  # One line per read of the list, which is one line per fork. The `if` rather than a
  # trailing `… && echo` keeps the function's status about the READ, not about whether
  # a probe was asked for — a caller's `x && _timing_allowlist_entries` chain must not
  # see a failure here merely because the shipped state names no probe.
  if [ -n "${TIMING_ALLOWLIST_PROBE:-}" ]; then
    echo "$$" >>"$TIMING_ALLOWLIST_PROBE" 2>/dev/null || :
  fi
  _TIMING_ALLOWLIST_ROWS="$(awk '
    {
      if (match($0, /"file"[[:space:]]*:[[:space:]]*"[^"]*"/)) {
        f = substr($0, RSTART, RLENGTH)
        sub(/^"file"[[:space:]]*:[[:space:]]*"/, "", f)
        sub(/"$/, "", f)
      }
      if (match($0, /"seconds"[[:space:]]*:[[:space:]]*[0-9]+/)) {
        n = substr($0, RSTART, RLENGTH)
        sub(/^"seconds"[[:space:]]*:[[:space:]]*/, "", n)
        if (f != "") { print n "\t" f; f = "" }
      }
    }' "$TIMING_ALLOWLIST" 2>/dev/null)"
  if [ ! -f "$TIMING_ALLOWLIST" ]; then
    echo "warn: verify-loop: timing ceiling is on but no allow-list at $TIMING_ALLOWLIST; nothing is exempt" >&2
  elif [ ! -r "$TIMING_ALLOWLIST" ]; then
    echo "warn: verify-loop: timing ceiling is on but the allow-list at $TIMING_ALLOWLIST is unreadable; nothing is exempt" >&2
  elif [ -z "$_TIMING_ALLOWLIST_ROWS" ]; then
    echo "warn: verify-loop: timing ceiling is on but the allow-list at $TIMING_ALLOWLIST has no entries; nothing is exempt" >&2
  fi
  [ -n "$_TIMING_ALLOWLIST_ROWS" ] && printf '%s\n' "$_TIMING_ALLOWLIST_ROWS"
  return 0
}

# Is <key> named by the list? Asks the loader above, which answers from its cache on
# every call after the first, so the read count is one per run however many rows a run
# has. The match is pure shell, and the newline on BOTH sides of the needle is what makes
# it a whole-field test: the rows are `secs<TAB>key` with one row per line, so a key is
# preceded by a tab and followed by a newline — pinning the newline after it is what
# stops a key that is a PREFIX of an entry from matching that entry (a list that exempts
# `a/b.ts` must not exempt `a/b.tsx`, and an entry ending in a directory component must
# not exempt a sibling file under it). A tab after the needle could never match: the key
# is the row's LAST field, terminated by the newline. The cache is what lets the match be
# pure shell at all — one parameter substitution over the run's rows, where the old shape
# forked `awk` twice for every row past the bound.
timing_listed() {
  _timing_allowlist_entries >/dev/null
  local needle="${1:-}"
  [ -n "$needle" ] || return 1
  [ -n "$_TIMING_ALLOWLIST_ROWS" ] || return 1
  local nl
  nl="$(printf '\n')"
  case $'\n'"$_TIMING_ALLOWLIST_ROWS"$'\n' in
    *"$nl$needle$nl"*) return 0 ;;
  esac
  return 1
}

# Is <file> exempt from the ceiling? The knob gate here is the caller-side half of
# the off-path cost claim. It goes through the one `timing_key` above, so every spelling
# the caller can hand the loop reaches the list as the same key. There is deliberately
# no exemption by any other recorded field: a row that could exempt itself by a column
# it carries would make the list mean nothing.
timing_exempt() {
  [ "$VERIFY_TIMING_CEILING_S" -gt 0 ] || return 1
  local k
  k="$(timing_key "${1:-}")"
  [ -n "$k" ] || return 1
  timing_listed "$k"
}

# The caller's seam, and why the verdict is not an exit status:
#
#   offenders="$(timing_ceiling_offenders)"   # stdout = the offending paths
#
# stdout carries the offending paths, one per line, for the replay step to append to
# its failing-test names; stderr carries the `CEILING:` lines a reader sees. A status
# would report ONE answer where the run needs a LIST, and a caller under `set -e`
# would have the loop die on the first offender instead of naming every one — so
# every diagnostic this function writes goes to stderr, because stdout is the answer.
# Silent, and therefore a no-op for the caller, whenever the ceiling is off.
#
# timing_ceiling_offenders — the run's ceiling verdict.
timing_ceiling_offenders() {
  [ "$VERIFY_TIMING_CEILING_S" -gt 0 ] || return 0
  [ -n "$TIMING_FILE" ] || return 0
  [ -f "$TIMING_FILE" ] || return 0
  local tab secs file outcome
  tab="$(printf '\t')"
  while IFS="$tab" read -r secs file outcome; do
    [ -n "$file" ] || continue
    # R6: a row the watchdog killed is exempt. Its seconds measure the BOUND, not the
    # test, and the marker already made that test a named failure — failing the run
    # twice for one hang would blame the ceiling for a hang.
    case "$outcome" in
      timeout\ after*) continue ;;
    esac
    timing_over_ceiling "$secs" || continue
    timing_exempt "$file" && continue
    # Digest mode prints no timing on either channel — the contract the TIME lines and
    # the block obey — but the offender still fails the run.
    if [ "${DIGEST:-0}" -eq 0 ]; then
      echo "CEILING: ${secs}s ${file} (ceiling ${VERIFY_TIMING_CEILING_S}s)" >&2
    fi
    echo "$file"
  done <"$TIMING_FILE"
}
