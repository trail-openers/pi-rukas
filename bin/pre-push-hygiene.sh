#!/bin/sh
# pre-push-hygiene — the human-side counterpart of pi-rukas's public hygiene
# guard (#1788).
#
# The agent-side guard (extension/src/public-hygiene-guard.ts) is a Pi
# tool_call hook, so a push typed in a terminal never passes it. This hook is
# the same rule for a human push: scan the commits about to leave this clone
# for the terms in the operator's private denylist, and refuse the push.
#
# Install (it is deliberately NOT auto-installed — a repository must opt in):
#
#   ln -s ../../bin/pre-push-hygiene.sh .git/hooks/pre-push
#
# The denylist lives OUTSIDE the repository, at
# ~/.config/pi-rukas/public-denylist (override with PI_ENSEMBLE_PUBLIC_DENYLIST),
# one entry per line, case-insensitive substring, `regex:` prefix for a regular
# expression, `#` (optionally indented) starts a comment. Its contents are
# never printed: a refusal names the LINE NUMBER only, because the term is what
# the file exists to keep out of public view.
#
# FAILS CLOSED (#1788 round 2). A hook that cannot read its own list, or cannot
# read the commits it is about to let out, does not know whether the push is
# clean — and "clean" is the one claim it must never make without evidence. So
# an unreadable denylist and a failed commit read both refuse, with a generic
# message that names no term (not even the reason's wording could leak one:
# none of these branches echo anything it reads).
#
# Escape hatch: PI_ENSEMBLE_PUBLIC_HYGIENE=0, the same variable the agent-side
# guard honours, so one switch governs both when an operator means it.
#
# POSIX sh only, and it must not depend on pi-rukas being installed — a bare
# clone gets the same check. The line-number loop is a plain `nl` over the
# file rather than a nested `sed`, because a hook that re-reads its own list
# once per entry is quadratic on a large file.

[ "$PI_ENSEMBLE_PUBLIC_HYGIENE" = "0" ] && exit 0

DENYLIST="${PI_ENSEMBLE_PUBLIC_DENYLIST:-$HOME/.config/pi-rukas/public-denylist}"

# No denylist file at all means there are no private terms configured for this
# host, which is a legitimate state for a bare clone. A file that EXISTS but
# cannot be opened is not: the operator configured terms and the hook is being
# denied them. The first exits 0; the second refuses. `[ -f ] && [ ! -r ]` is
# the discriminator — a missing path fails `-f` and is never reached.
if [ -f "$DENYLIST" ] && [ ! -r "$DENYLIST" ]; then
  echo "pre-push-hygiene: refusing push — the denylist file exists but cannot be read, so this hook cannot tell whether the push is clean. Fix its permissions, or set PI_ENSEMBLE_PUBLIC_HYGIENE=0 to opt out." >&2
  exit 1
fi

# No denylist means no private terms to look for. The agent-side guard still
# applies its built-in generic set to prose; a diff legitimately carries an
# example address, so this script has no generic set of its own.
[ -f "$DENYLIST" ] || exit 0

ZERO=$(printf '0000000000000000000000000000000000000000')
found=0

# Reads every outgoing commit of one ref into two bounded strings, and reports
# whether BOTH git reads succeeded. A failed read is NOT an empty range: an
# empty range is a real answer ("nothing new here") and the loop continues,
# while a failed read is no answer at all and the caller refuses. The 2>/dev/null
# discards git's own stderr, which can quote a path or a ref; the refusal text
# the hook prints is generic and names nothing.
#
# The revision range sits BEFORE `--`. Everything after `--` is a PATHSPEC:
# written as `git log --format=%B -- $range`, git looked for commits that
# touched a path literally named after a commit sha, found none, printed
# nothing and exited 0 — so the hook reported every push clean, including one
# carrying the denylist term, which is the one thing this script exists to
# catch. `--not --remotes` is a revision modifier, not a path, so it belongs
# with the range and no `--` separator is needed: every word here is a revision
# and there is no pathspec to delimit.
#
# `head -c` bounds the text the hook holds: one enormous push cannot exhaust
# the hook's memory before it answers. The bound truncates the SAME way for
# every entry, so a match past 5 MiB is missed and the refusal for the rest
# still fires. A truncated `git` behind the pipe is not a failure signal: the
# status checked below is `git`'s own, taken before the pipe, so a push large
# enough to truncate still gets its first 5 MiB scanned and reported clean.
read_outgoing_text() {
  # "$@" is the revision arguments. Sets the globals below; returns non-zero
  # when either read failed. A shell function cannot return a string, so the
  # results are globals — the hook reads one ref at a time, so there is
  # nothing to shadow.
  outgoing_messages=""
  outgoing_added=""
  # The liveness probe: cheap, and the one read whose failure means the
  # revisions themselves are unreadable.
  git rev-list "$@" >/dev/null 2>&1 || return 1
  # Each capture is a compound of `git` piped into `head`: a plain `if ! git …
  # | head` tests head's status, which is 0 whatever git did, so the gate that
  # makes this fail closed is the explicit `$?` check after the assignment —
  # in POSIX sh that reports the status of the pipeline, i.e. git's.
  outgoing_messages=$(git log --format=%B "$@" 2>/dev/null | head -c 5242880)
  [ $? -eq 0 ] || return 1
  outgoing_added=$(git log -p --format= "$@" 2>/dev/null | head -c 5242880)
  [ $? -eq 0 ] || return 1
  return 0
}

# git feeds the hook, on stdin, one line per ref being pushed:
#   <local_ref> <local_oid> <remote_ref> <remote_oid>
while read -r local_ref local_oid remote_ref remote_oid; do
  [ -n "$local_oid" ] || continue
  # A deletion carries the all-zero local oid: nothing is being published, so
  # there is nothing to fail closed on.
  [ "$local_oid" = "$ZERO" ] && continue

  # A new branch: everything the commit has that no origin ref already has.
  # Otherwise: the commits between the remote tip and the local tip.
  if [ "$remote_oid" = "$ZERO" ] || [ -z "$remote_oid" ]; then
    set -- "$local_oid" --not --remotes=origin
  else
    set -- "$remote_oid..$local_oid" --not --remotes=origin
  fi

  if ! read_outgoing_text "$@"; then
    echo "pre-push-hygiene: refusing push of $local_ref — the outgoing commits could not be read, so this hook cannot tell whether the push is clean. Set PI_ENSEMBLE_PUBLIC_HYGIENE=0 to opt out." >&2
    exit 1
  fi

  [ -n "$outgoing_messages$outgoing_added" ] || continue

  # One pass over the denylist, the two git reads above reused per entry.
  # The list is numbered by a hand-rolled counter rather than `nl`: coreutils
  # pads the number to the width of the widest one in the file (` 7:` once the
  # list has ten entries), and GNU `nl` rejects `-w0` outright, so the
  # `${numbered%%:*}` split below would yield an empty line number while the
  # entry kept its leading spaces — no term ever matched and the hook reported
  # every push clean. Blank and comment lines still consume a number, so the
  # line named is the line the operator sees in an editor. The comment test is
  # on the RAW line, before stripping, so an indented `#` is a comment too and
  # a list indented under a heading is never scanned as a term.
  lineno=0
  # The denylist lives outside the repository and holds operator text; the
  # redirect on the loop keeps it off stdin, which belongs to git.
  while IFS= read -r raw || [ -n "$raw" ]; do
    lineno=$((lineno + 1))
    # Blank and comment lines consume a number but are never terms. The test
    # runs on the RAW line, so an indented `#` is still a comment.
    case "$raw" in
      "") continue ;;
    esac
    case "$(printf '%s' "$raw" | sed -e 's/^[[:space:]]*//')" in
      '#'*) continue ;;
    esac
    entry=$(printf '%s' "$raw" | sed -e 's/^[[:space:]]*//' -e 's/[[:space:]]*$//')
    [ -n "$entry" ] || continue
    # `entry` is operator text: it is only ever compared against, never
    # executed and never echoed. A refusal names `$lineno` and nothing else.
    case "$entry" in
      regex:*)
        pattern=${entry#regex:}
        [ -n "$pattern" ] || continue
        # `grep -E -i` reads the entry as an extended regex. An invalid pattern
        # exits 2 (an error), which is NOT a match: an unreadable entry must
        # not refuse every push in the repository.
        if printf '%s\n' "$outgoing_messages" | LC_ALL=C grep -qiE -- "$pattern" 2>/dev/null ||
           printf '%s\n' "$outgoing_added" | LC_ALL=C grep -qiE -- "$pattern" 2>/dev/null; then
          echo "pre-push-hygiene: refusing push of $local_ref: denylist line $lineno matched an outgoing commit" >&2
          found=1
        fi
        ;;
      *)
        # A literal entry, matched case-insensitively as a substring. -F makes
        # grep treat it as a string, so a term with metacharacters is a term.
        if printf '%s\n' "$outgoing_messages" | LC_ALL=C grep -qFi -- "$entry" 2>/dev/null ||
           printf '%s\n' "$outgoing_added" | LC_ALL=C grep -qFi -- "$entry" 2>/dev/null; then
          echo "pre-push-hygiene: refusing push of $local_ref: denylist line $lineno matched an outgoing commit" >&2
          found=1
        fi
        ;;
    esac
  done <"$DENYLIST"
done

# The term is never echoed above — a line number is the whole report, so it
# cannot reach the terminal scrollback, a CI log or a screenshot.
[ "$found" = "1" ] && exit 1
exit 0
