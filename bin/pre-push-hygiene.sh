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
# expression, `#` starts a comment. Its contents are never printed: a refusal
# names the LINE NUMBER only, because the term is what the file exists to keep
# out of public view.
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
# No denylist means no private terms to look for. The agent-side guard still
# applies its built-in generic set to prose; a diff legitimately carries an
# example address, so this script has no generic set of its own.
[ -f "$DENYLIST" ] || exit 0

ZERO=$(printf '0000000000000000000000000000000000000000')
found=0

# git feeds the hook, on stdin, one line per ref being pushed:
#   <local_ref> <local_oid> <remote_ref> <remote_oid>
while read -r local_ref local_oid remote_ref remote_oid; do
  [ -n "$local_oid" ] || continue
  # A deletion carries the all-zero local oid: nothing is being published.
  [ "$local_oid" = "$ZERO" ] && continue
  if [ "$remote_oid" = "$ZERO" ] || [ -z "$remote_oid" ]; then
    # A new branch: everything the commit has that no origin ref already has.
    range=$(git rev-list "$local_oid" --not --remotes=origin 2>/dev/null)
  else
    range=$(git rev-list "$remote_oid..$local_oid" 2>/dev/null)
  fi
  [ -n "$range" ] || continue

  # The outgoing text, bounded. `git log -p` on a large range is not a string
  # any hook should hold in a variable: it is streamed into the scan through a
  # `head -c` bound instead, so one enormous push cannot exhaust the hook's
  # memory before it answers. The bound truncates the SAME way for every entry,
  # so a match past 5 MiB is missed and the refusal for the rest still fires.
  messages=$(git log --format=%B -- $range 2>/dev/null | head -c 5242880)
  added=$(git log -p --format= -- $range 2>/dev/null | head -c 5242880)

  # One pass over the denylist, one git read for the messages and one for the
  # added lines, reused per entry. `nl -ba -w1 -s:` numbers every line (blank
  # and comment lines keep their numbers, so the line we name is the line the
  # operator sees in an editor).
  entries=$(nl -ba -w1 -s: "$DENYLIST" | grep -vE '^[0-9]+:[[:space:]]*(#.*)?$')

  for numbered in $entries; do
    line=${numbered%%:*}
    entry=${numbered#*:}
    entry=$(printf '%s' "$entry" | sed -e 's/^[[:space:]]*//' -e 's/[[:space:]]*$//')
    [ -n "$entry" ] || continue
    case "$entry" in
      regex:*)
        pattern=${entry#regex:}
        [ -n "$pattern" ] || continue
        # `grep -E -i` reads the entry as an extended regex. An invalid pattern
        # exits 2 (an error), which is NOT a match: an unreadable entry must
        # not refuse every push in the repository.
        if printf '%s\n' "$messages" | LC_ALL=C grep -qiE -- "$pattern" 2>/dev/null ||
           printf '%s\n' "$added" | LC_ALL=C grep -qiE -- "$pattern" 2>/dev/null; then
          echo "pre-push-hygiene: refusing push of $local_ref: denylist line $line matched an outgoing commit" >&2
          found=1
        fi
        ;;
      *)
        # A literal entry, matched case-insensitively as a substring. -F makes
        # grep treat it as a string, so a term with metacharacters is a term.
        if printf '%s\n' "$messages" | LC_ALL=C grep -qFi -- "$entry" 2>/dev/null ||
           printf '%s\n' "$added" | LC_ALL=C grep -qFi -- "$entry" 2>/dev/null; then
          echo "pre-push-hygiene: refusing push of $local_ref: denylist line $line matched an outgoing commit" >&2
          found=1
        fi
        ;;
    esac
  done
done

# The term is never echoed above — a line number is the whole report, so it
# cannot reach the terminal scrollback, a CI log or a screenshot.
[ "$found" = "1" ] && exit 1
exit 0
