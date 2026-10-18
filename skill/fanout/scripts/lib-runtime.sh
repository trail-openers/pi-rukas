#!/usr/bin/env bash
# lib-runtime.sh — runtime helpers: logging, JS runtime discovery, repo/forge resolution,
# ssh-agent ownership and pidfile claims. Sourced by lib.sh, never executed directly.
#
# ---------------------------------------------------------------------------
# logging
# ---------------------------------------------------------------------------
log()  { echo "[fanout] $*"; }
warn() { echo "[fanout][warn] $*" >&2; }
die()  { echo "[fanout][error] $*" >&2; exit "${2:-1}"; }

# Node discovery.
#
# Do NOT use `command -v` here: a mode-independent bash guard in some host configurations
# refuses several read-only command shapes (`command -v X`, `grep -rn`, `git -C <path>`) as
# possible probes of the review findings store. But `which` is not a safe substitute either --
# it is an external, not a builtin, and is absent from restricted PATHs (measured: it vanished
# inside a command substitution in a subshell, so every structured reader silently got nothing
# and the gates below degraded). So resolution is attempted across several independent sources
# and the result is CACHED: one resolution per process, reused by every reader.
# Pick a JS runtime, preferring bun. pi-rukas is a bun-first project -- bun is the package
# manager, the test runner and the script runner (`bun run smoke-tests/...`), and it is what
# the extension itself executes under. Node worked here only because bun runs CommonJS
# identically, so the same `require`-style scripts load either way; but resolving to node by
# default meant this skill disagreed with the project it drives about which runtime is normal,
# and it made the skill's behaviour depend on an fnm shim dir being on PATH.
#
# Order: FANOUT_JS (explicit, any runtime) > FANOUT_NODE (old override, still honoured) >
# bun > node. Result is CACHED: one resolution per process, reused by every reader.
FANOUT_JS_CACHED=""
fanout_node() {
  [ -n "$FANOUT_JS_CACHED" ] && { printf '%s' "$FANOUT_JS_CACHED"; return 0; }
  local b n
  # 1. an explicit override always wins, and is trusted -- the operator may want node specifically
  if [ -n "${FANOUT_JS:-}" ] && [ -x "${FANOUT_JS:-}" ]; then
    FANOUT_JS_CACHED="$FANOUT_JS"; printf '%s' "$FANOUT_JS_CACHED"; return 0
  fi
  if [ -n "${FANOUT_NODE:-}" ] && [ -x "${FANOUT_NODE:-}" ]; then
    FANOUT_JS_CACHED="$FANOUT_NODE"; printf '%s' "$FANOUT_JS_CACHED"; return 0
  fi
  # 2. bun first: it is this project's runtime and it does not need an fnm multishell on PATH
  for b in "$HOME/.bun/bin/bun" /opt/homebrew/bin/bun /usr/local/bin/bun; do
    if [ -x "$b" ]; then FANOUT_JS_CACHED="$b"; printf '%s' "$FANOUT_JS_CACHED"; return 0; fi
  done
  if b="$(type -P bun 2>/dev/null)" && [ -n "$b" ] && [ -x "$b" ]; then
    FANOUT_JS_CACHED="$b"; printf '%s' "$FANOUT_JS_CACHED"; return 0
  fi
  # 3. node as fallback. `type -P` before `which`: which is unreliable inside subshells and
  #    under a stripped PATH, and the first version of this function led with it, so a worker
  #    launched with a minimal environment resolved to nothing and every JSON reader failed.
  if n="$(type -P node 2>/dev/null)" && [ -n "$n" ] && [ -x "$n" ]; then
    FANOUT_JS_CACHED="$n"; printf '%s' "$FANOUT_JS_CACHED"; return 0
  fi
  n="$(command -v node 2>/dev/null || true)"
  if [ -n "$n" ] && [ -x "$n" ]; then
    FANOUT_JS_CACHED="$n"; printf '%s' "$FANOUT_JS_CACHED"; return 0
  fi
  for n in /usr/local/bin/node /opt/homebrew/bin/node /usr/bin/node; do
    if [ -x "$n" ]; then FANOUT_JS_CACHED="$n"; printf '%s' "$FANOUT_JS_CACHED"; return 0; fi
  done
  # 4. last resort: let env search PATH. Better than failing, but say so, because a reader
  #    that silently got nothing is the failure mode this whole file argues against.
  warn "no JS runtime resolved (tried bun then node); falling back to /usr/bin/env bun"
  FANOUT_JS_CACHED="/usr/bin/env bun"
  printf '%s' "$FANOUT_JS_CACHED"
}

# ---------------------------------------------------------------------------
# repo / forge resolution — validated, never assumed
# ---------------------------------------------------------------------------
# Requires $FANOUT_REPO to be a git checkout, and derives the worktree-relative dir
# from it so a single checkout's scratch never lands in the repo root (repo-root debris
# has aborted cycles before: a dirty `git status --porcelain` fails the branch step).
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

# The forge the worker's origin must point at.
#
# `git clone --shared <local>` makes origin the LOCAL path, so a worker would push into
# its parent clone and the PR would never reach the forge — a cycle that looks like it
# worked and shipped nothing. So the push url must be the real forge. A repo whose own
# origin is already a local path (self-building from a seed clone) cannot supply it and
# must be told explicitly.
fanout_forge_url() {
  local u="${FANOUT_FORGE_URL:-}"
  [ -n "$u" ] || u="$(git -C "$FANOUT_REPO" remote get-url origin 2>/dev/null || true)"
  [ -n "$u" ] || die "cannot determine a forge url for $FANOUT_REPO (no origin, and FANOUT_FORGE_URL unset). Pass --forge-url <ssh-or-https-url>; a worker that pushes to a local path ships nothing." 3
  # Classify the url. The pattern set AND its order are both load-bearing. The first version
  # of this used a bare star-colon-star-slash-star as an scp-style remote test, which matches
  # ANY absolute path containing a slash -- the leading star-colon greedily absorbs the initial
  # slash. So a local path was accepted as a remote, the worker cloned, pushed into its parent,
  # and the cycle reported success having shipped nothing. Reject local shapes first, then
  # accept only an explicit scheme or an unambiguous host colon.
  # Classify the url. The pattern set AND its order are both load-bearing, and shell globbing
  # is the wrong tool for this decision. The first version used star-colon-star-slash-star as
  # an scp-style remote test, which matches ANY absolute path containing a slash because the
  # leading star-colon greedily absorbs the initial slash -- so a local path was accepted as a
  # remote, the worker cloned, pushed into its parent, and the cycle reported success having
  # shipped nothing. A second attempt leaked via a .git suffix arm, which a local path ending in
  # .git satisfies. So an explicit parser decides, and the cases are pinned in the harness.
  local kind
  kind="$(FANOUT_URL="$u" "$(fanout_node)" --input-type=module -e '
    const u = process.env.FANOUT_URL || "";
    // Local: begins with a slash, ~/, ./ or ../ . Remote: a scheme, or scp-style host:path
    // where the host part is non-empty and contains no slash. Anything else is unknown.
    // file: and git+file: are local repositories under a scheme, so they are local too.
    if (/^(\/|~\/|\.\/|\.\.\/)/.test(u) || /^(git\+)?file:/i.test(u)) { process.stdout.write("local"); }
    else if (/^[A-Za-z][A-Za-z0-9+.-]*:\/\//.test(u)) { process.stdout.write("remote"); }
    else if (/^[^/\s]+:[^/]/.test(u)) { process.stdout.write("remote"); }
    else { process.stdout.write("unknown"); }
  ' 2>/dev/null)"
  case "$kind" in
    remote) : ;;
    local)  die "origin is a local path, which is not a forge: $u. Pass --forge-url, or workers will push into their parent clone and the PR will never appear." 3 ;;
    *)      die "origin is not a recognisable forge url (no scheme, no host colon): $u. Pass --forge-url." 3 ;;
  esac
  echo "$u"
}

# ---------------------------------------------------------------------------
# ssh-agent ownership
# ---------------------------------------------------------------------------
# Pushes go out over SSH. Reuse an inherited agent with usable identities; otherwise
# start a private one and kill only our own on exit — never the user's agent.
FANOUT_OWNED_AGENT_PID=""

fanout_ssh_ready() {
  [ -n "${SSH_AUTH_SOCK:-}" ] || return 1
  [ -S "$SSH_AUTH_SOCK" ] || return 1
  ssh-add -l >/dev/null 2>&1
}

fanout_ssh_ensure() {
  fanout_ssh_ready && { log "ssh agent: reusing ${SSH_AUTH_SOCK}"; return 0; }
  which ssh-agent >/dev/null 2>&1 || die "no ssh-agent and no usable SSH_AUTH_SOCK — pushes will fail" 3
  log "ssh agent: no usable identities inherited, starting a private one"
  local out
  out="$(ssh-agent -s 2>/dev/null)" || die "ssh-agent failed to start" 3
  # shellcheck disable=SC2163
  eval "$out"
  export SSH_AUTH_SOCK SSH_AGENT_PID
  FANOUT_OWNED_AGENT_PID="${SSH_AGENT_PID:-}"
  ssh-add -l >/dev/null 2>&1 || warn "private agent has no identities: pushes will fail (run ssh-add in a terminal)"
}

fanout_ssh_cleanup() {
  [ -n "$FANOUT_OWNED_AGENT_PID" ] || return 0
  kill "$FANOUT_OWNED_AGENT_PID" >/dev/null 2>&1 || true
  FANOUT_OWNED_AGENT_PID=""
}

# ---------------------------------------------------------------------------
# pidfile — mkdir is the atomic test-and-set
# ---------------------------------------------------------------------------
# A plain lock *file* leaves a window where a SIGKILL between create and write reads as
# "no lock". The directory itself is the claim; pid/label/started are evidence inside it.
fanout_pidfile_acquire() {  # $1 = pidfile dir, $2 = label
  local dir="$1" label="$2" owner=""
  if ! mkdir "$dir" 2>/dev/null; then
    owner="$(cat "$dir/pid" 2>/dev/null || true)"
    if [ -n "$owner" ] && kill -0 "$owner" 2>/dev/null; then
      return 1  # live owner — the caller decides what to say
    fi
    warn "clearing a stale lock at $dir (pid '${owner:-unknown}' is not running)"
    rm -rf -- "$dir" 2>/dev/null || true
    mkdir "$dir" 2>/dev/null || return 1
  fi
  echo "$$" >"$dir/pid"
  echo "$label" >"$dir/label"
  date -u +%Y-%m-%dT%H:%M:%SZ >"$dir/started"
  return 0
}

fanout_pidfile_release() {  # $1 = dir; removes the claim only if it is still ours
  local dir="$1" owner=""
  owner="$(cat "$dir/pid" 2>/dev/null || true)"
  [ "$owner" = "$$" ] || return 0
  rm -rf -- "$dir" 2>/dev/null || true
}

