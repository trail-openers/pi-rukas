#!/usr/bin/env bash
# lib-runtime.sh — logging, JS runtime, forge url, ssh identity, bounded commands, pidfile.
# Sourced by lib.sh, never executed directly.
#
# Bash 3.2 (macOS /bin/bash): no associative arrays, no ${var^^}, no [[ ]], no `wait -n`.
# Write `command -v` as `type -P`: a host guard refuses the former as a store probe.

log()  { echo "[fanout] $*"; }
warn() { echo "[fanout][warn] $*" >&2; }
die()  { echo "[fanout][error] $*" >&2; exit "${2:-1}"; }

# ---------------------------------------------------------------------------
# JS runtime
# ---------------------------------------------------------------------------
# Order: FANOUT_JS > FANOUT_NODE (alias) > bun > node. An explicit override that is not
# executable is an error, not a silent fall-through to another runtime.
# Callers use "$(fanout_node)"; a die inside that exits only the subshell, and the empty
# result then fails the caller loudly.
fanout_node() {
  local p=""
  if [ -n "${FANOUT_JS:-}" ]; then
    p="$FANOUT_JS"
    [ -x "$p" ] || die "FANOUT_JS is set but is not an executable: $p" 2
  elif [ -n "${FANOUT_NODE:-}" ]; then
    p="$FANOUT_NODE"
    [ -x "$p" ] || die "FANOUT_NODE is set but is not an executable: $p" 2
  fi
  [ -n "$p" ] || p="$(type -P bun 2>/dev/null || true)"
  [ -n "$p" ] || p="$(type -P node 2>/dev/null || true)"
  [ -n "$p" ] && [ -x "$p" ] || die "no JS runtime found (tried FANOUT_JS, FANOUT_NODE, bun, node). Install bun, or set FANOUT_JS to an absolute path." 2
  printf '%s' "$p"
}

# ---------------------------------------------------------------------------
# repo / forge resolution
# ---------------------------------------------------------------------------
fanout_resolve_repo() {
  [ -n "${FANOUT_REPO:-}" ] || die "no repo given — pass --repo <path> or set FANOUT_REPO" 2
  [ -d "$FANOUT_REPO" ] || die "repo does not exist: $FANOUT_REPO" 2
  git -C "$FANOUT_REPO" rev-parse --git-dir >/dev/null 2>&1 \
    || die "not a git repository: $FANOUT_REPO" 2
  FANOUT_REPO="$(cd "$FANOUT_REPO" && pwd -P)"
  FANOUT_ROOT="${FANOUT_ROOT:-$FANOUT_REPO/tmp/fanout}"
  WORKERS_DIR="$FANOUT_ROOT/workers"
  RUNS_DIR="$FANOUT_ROOT/runs"
  export FANOUT_REPO FANOUT_ROOT WORKERS_DIR RUNS_DIR
}

# The url the worker's origin must point at. A --shared clone's origin is the LOCAL parent
# path; a worker pushing there ships nothing while reporting success, so the forge url is
# validated, never assumed. Classification is done by a parser, not by shell globbing: a
# glob that matches "/" anywhere lets local paths through as remotes.
fanout_forge_url() {
  local u="${FANOUT_FORGE_URL:-}" kind
  [ -n "$u" ] || u="$(git -C "$FANOUT_REPO" remote get-url origin 2>/dev/null || true)"
  [ -n "$u" ] || die "cannot determine a forge url for $FANOUT_REPO (no origin, and FANOUT_FORGE_URL unset). Pass --forge-url <ssh-or-https-url>." 3
  kind="$(FANOUT_URL="$u" "$(fanout_node)" --input-type=module -e '
    const u = process.env.FANOUT_URL || "";
    // A leading dash is read as an option by whatever later runs git or ssh with this url.
    if (u.startsWith("-")) process.stdout.write("option");
    else if (/^(\/|~\/|\.\/|\.\.\/)/.test(u) || /^(git\+)?file:/i.test(u)) process.stdout.write("local");
    else if (/^[A-Za-z][A-Za-z0-9+.-]*:\/\/-/.test(u)) process.stdout.write("option");
    else if (/^[A-Za-z][A-Za-z0-9+.-]*:\/\//.test(u)) process.stdout.write("remote");
    // scp-style host:path. The host starts with an alphanumeric, optionally after user@.
    else if (/^(?:[A-Za-z0-9_][A-Za-z0-9._-]*@)?[A-Za-z0-9][A-Za-z0-9._-]*:[^/]/.test(u)) process.stdout.write("remote");
    else process.stdout.write("unknown");
  ' 2>/dev/null)"
  case "$kind" in
    remote) : ;;
    option) die "forge url starts with '-' or names a host that does, so an option could be read from it: $u. Pass --forge-url with a real remote." 3 ;;
    local)  die "origin is a local path, which is not a forge: $u. Pass --forge-url, or workers will push into their parent clone and the PR will never appear." 3 ;;
    *)      die "origin is not a recognisable forge url (no scheme, no host colon): $u. Pass --forge-url." 3 ;;
  esac
  echo "$u"
}

# fanout_url_slug <forge url> -> "host/path", the form `gh --repo` and `glab -R` accept.
# Without it, forge calls resolve against the caller's cwd, so drive.sh run from another
# checkout reads that checkout's forge. Exit 3 when the url is not a remote with a path; a
# wrong path is the forge CLI's failure to report, and it does.
fanout_url_slug() {
  local slug
  slug="$(FANOUT_URL="$1" "$(fanout_node)" --input-type=module -e '
    const u = process.env.FANOUT_URL || "";
    const m = /^[A-Za-z][A-Za-z0-9+.-]*:\/\/(?:[^@\/]*@)?([^\/:]+)(?::\d+)?\/(.+)$/.exec(u)
      || /^(?:[^@\/]*@)?([^\/:]+):(.+)$/.exec(u);
    if (!m) process.exit(3);
    const repo = m[2].replace(/\/+$/, "").replace(/\.git$/, "");
    if (!repo) process.exit(3);
    process.stdout.write(m[1] + "/" + repo);
  ' 2>/dev/null)" || return 3
  printf '%s' "$slug"
}

# ---------------------------------------------------------------------------
# ssh identity
# ---------------------------------------------------------------------------
# Default: reuse an inherited agent that holds identities; otherwise a private agent, which
# is killed on exit. FANOUT_SSH_KEY pins exactly one key into a private agent and forces
# IdentitiesOnly, so the cycle cannot use the operator's other keys. Unset = no change.
FANOUT_OWNED_AGENT_PID=""

fanout_ssh_ready() {
  [ -n "${SSH_AUTH_SOCK:-}" ] && [ -S "$SSH_AUTH_SOCK" ] && ssh-add -l >/dev/null 2>&1
}

fanout_ssh_private() {
  local out
  [ -n "$(type -P ssh-agent 2>/dev/null || true)" ] || die "no ssh-agent on PATH and no usable SSH_AUTH_SOCK — pushes will fail" 3
  out="$(ssh-agent -s 2>/dev/null)" || die "ssh-agent failed to start" 3
  eval "$out"
  export SSH_AUTH_SOCK SSH_AGENT_PID
  FANOUT_OWNED_AGENT_PID="${SSH_AGENT_PID:-}"
}

fanout_ssh_ensure() {
  if [ -n "${FANOUT_SSH_KEY:-}" ]; then
    [ -r "$FANOUT_SSH_KEY" ] || die "FANOUT_SSH_KEY is not readable: $FANOUT_SSH_KEY" 3
    # The path is placed in double quotes inside GIT_SSH_COMMAND, so these characters would break it.
    case "$FANOUT_SSH_KEY" in
      *'"'*|*'$'*|*'`'*|*'\'*) die "FANOUT_SSH_KEY contains a quote, dollar, backtick or backslash, which breaks GIT_SSH_COMMAND: $FANOUT_SSH_KEY. Symlink the key to a plain path." 3 ;;
    esac
    fanout_ssh_private
    ssh-add "$FANOUT_SSH_KEY" >/dev/null 2>&1 \
      || die "ssh-add could not load $FANOUT_SSH_KEY (passphrase-protected? load it in a terminal first)" 3
    export GIT_SSH_COMMAND="ssh -o IdentitiesOnly=yes -i \"$FANOUT_SSH_KEY\""
    log "ssh: pushes are restricted to $FANOUT_SSH_KEY"
    return 0
  fi
  if fanout_ssh_ready; then log "ssh agent: reusing ${SSH_AUTH_SOCK}"; return 0; fi
  fanout_ssh_private
  ssh-add -l >/dev/null 2>&1 && return 0
  if [ "${FANOUT_SKIP_PUSH_CHECK:-0}" = 1 ]; then
    warn "no SSH identity loaded; FANOUT_SKIP_PUSH_CHECK=1, continuing. Pushes will fail."
    return 0
  fi
  die "no SSH identity is loaded, so the push would fail after the whole cycle. Load a key with ssh-add, or set FANOUT_SSH_KEY. FANOUT_SKIP_PUSH_CHECK=1 skips this check." 3
}

fanout_ssh_cleanup() {
  [ -n "$FANOUT_OWNED_AGENT_PID" ] || return 0
  kill "$FANOUT_OWNED_AGENT_PID" >/dev/null 2>&1 || true
  FANOUT_OWNED_AGENT_PID=""
}

# ---------------------------------------------------------------------------
# bounded commands
# ---------------------------------------------------------------------------
# fanout_bounded <seconds> <command...>: prints the command's output, returns its status, or
# 124 when the bound fired. Uses gtimeout or timeout when present; macOS ships neither, so the
# fallback is a watchdog that sends TERM. The watchdog's output is discarded, so a caller that
# captures the command's output is not held open for the rest of the watchdog's sleep.
# A TERMed command may leave children running (bun spawns git); they are not reaped here.
fanout_bounded() {
  local secs="$1" tb flag pid watch rc
  shift
  tb="$(type -P gtimeout 2>/dev/null || true)"
  [ -n "$tb" ] || tb="$(type -P timeout 2>/dev/null || true)"
  if [ -n "$tb" ]; then
    "$tb" "$secs" "$@"
    return $?
  fi
  flag="$(mktemp "${TMPDIR:-/tmp}/fanout-bound.XXXXXX")" || return 1
  "$@" &
  pid=$!
  # The watchdog's sleep is recorded so that a command finishing early takes its timer with it.
  ( sleep "$secs" & echo "$!" >"$flag.sleep"; wait "$!" && : >"$flag" && kill -TERM "$pid" ) >/dev/null 2>&1 &
  watch=$!
  wait "$pid"
  rc=$?
  kill "$(cat "$flag.sleep" 2>/dev/null)" >/dev/null 2>&1 || true
  kill "$watch" >/dev/null 2>&1 || true
  wait "$watch" >/dev/null 2>&1 || true
  # Only TERM (143) means the watchdog fired. Any other status, including >=128 from a command
  # that exited on its own, is the command's own result.
  if [ -e "$flag" ] && [ "$rc" = 143 ]; then rc=124; fi
  rm -f -- "$flag" "$flag.sleep"
  return "$rc"
}

# ---------------------------------------------------------------------------
# pidfile — mkdir is the atomic test-and-set
# ---------------------------------------------------------------------------
# The directory is the claim; pid, label and started are evidence inside it. Each evidence
# file lands by temp-file-then-rename, so a reader never sees a torn pid.
fanout_pidfile_write() {  # $1 = dir, $2 = label
  printf '%s\n' "$$" >"$1/pid.$$.tmp" && mv -f "$1/pid.$$.tmp" "$1/pid"
  printf '%s\n' "$2" >"$1/label.$$.tmp" && mv -f "$1/label.$$.tmp" "$1/label"
  date -u +%Y-%m-%dT%H:%M:%SZ >"$1/started.$$.tmp" && mv -f "$1/started.$$.tmp" "$1/started"
}

fanout_dir_age() {  # $1 = dir -> whole seconds since its mtime; 0 when unknown (so: young)
  local m now
  m="$(stat -c %Y "$1" 2>/dev/null || stat -f %m "$1" 2>/dev/null || true)"
  case "$m" in ''|*[!0-9]*) echo 0; return 0 ;; esac
  now="$(date +%s)"
  echo $(( now - m ))
}

# Returns 0 when this process acquired the lock, 1 when a live owner (or a pid-less lock
# younger than 5 s, which may be mid-acquire) holds it.
#
# A stale lock is renamed aside only under the mutex <dir>.clearing, and the owner is re-read
# under that mutex first. A rename outside the mutex can move a lock another process has just
# taken, and a restore then opens a window for a third acquirer. A clearer that dies holding the
# mutex leaves it; it is aged out after 10 s.
fanout_pidfile_acquire() {  # $1 = dir, $2 = label
  local dir="$1" label="$2" clear="$1.clearing" grave="$1.stale.$$" owner="" age="" tries=0
  while [ "$tries" -lt 50 ]; do
    tries=$((tries + 1))
    if mkdir "$dir" 2>/dev/null; then
      fanout_pidfile_write "$dir" "$label"
      return 0
    fi
    owner="$(cat "$dir/pid" 2>/dev/null || true)"
    if [ -n "$owner" ]; then
      kill -0 "$owner" 2>/dev/null && return 1
    else
      # No pid yet: another acquirer may be between its mkdir and its pid write.
      age="$(fanout_dir_age "$dir")"
      [ "$age" -ge 5 ] || return 1
    fi
    if mkdir "$clear" 2>/dev/null; then
      if [ "$(cat "$dir/pid" 2>/dev/null || true)" = "$owner" ]; then
        rm -rf -- "$grave" 2>/dev/null || true
        if mv "$dir" "$grave" 2>/dev/null; then
          warn "clearing a stale lock at $dir (pid '${owner:-unknown}' is not running)"
          rm -rf -- "$grave" 2>/dev/null || true
        fi
      fi
      rmdir "$clear" 2>/dev/null || true
    else
      age="$(fanout_dir_age "$clear")"
      [ "$age" -lt 10 ] || rm -rf -- "$clear" 2>/dev/null || true
      sleep 0.05
    fi
  done
  return 1
}

fanout_pidfile_release() {  # $1 = dir; removes the claim only if it is still ours
  local owner
  owner="$(cat "$1/pid" 2>/dev/null || true)"
  [ "$owner" = "$$" ] || return 0
  rm -rf -- "$1" 2>/dev/null || true
}
