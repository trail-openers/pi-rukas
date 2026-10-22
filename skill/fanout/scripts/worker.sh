#!/usr/bin/env bash
# worker.sh — run ONE /work cycle in its own ephemeral clone.
#
#   worker.sh --repo <path> <issue> [--forge-url <url>] [--workers N] [--lean] [--heap MB]
#             [--timeout <min>] [--force-clone] [--dry-run] [--override-triage]
#
# Exit codes. A cycle that ran exits with the runner's own code (0 merged, 10 handoff,
# 11 clarification, 20 aborted, 21 interrupted, 30 crash, 40 refused). Otherwise:
#   2 usage  3 forge url or ssh identity  4 triage table  5 triage or forge gate
#   6 a worker already holds this issue  7 path collision  8 clone exists  9 clone or origin
#   10 dependency install (or its timeout)  11 build or claims unreadable  12 runner missing
#   13 reservation lock timeout  14 reservation not written
# Exit 10 is ambiguous on its own (install failure vs runner handoff); drive.sh tells them
# apart from the runner's exitCode in result.json. See references/design.md.
#
# One issue per worker, one process per worker. Parallelism comes from drive.sh.
set -uo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd -P)"
# shellcheck source=lib.sh
. "$SCRIPT_DIR/lib.sh"

# ---------------------------------------------------------------------------
# argv
# ---------------------------------------------------------------------------
[ "$#" -ge 1 ] || die "usage: worker.sh --repo <path> <issue> [--forge-url <url>] [--workers N] [--lean] [--heap MB] [--timeout <min>] [--force-clone] [--dry-run] [--override-triage]" 2

ISSUE=""
TIMEOUT_MIN=""
WORKERS_TOTAL="${FANOUT_WORKERS:-1}"
HEAP_OVR="${HEAP_OVR:-}"
LEAN=0
DRY_RUN=0
FORCE_CLONE=0
OVERRIDE_TRIAGE=0
NEXT=""   # which flag expects a value

while [ "$#" -gt 0 ]; do
  a="$1"; shift
  if [ -n "$NEXT" ]; then
    case "$a" in ''|*[!0-9]*) die "--$NEXT wants a positive integer, got '$a'" 2 ;; esac
    case "$NEXT" in
      timeout) TIMEOUT_MIN="$a" ;;
      workers) WORKERS_TOTAL="$a" ;;
      heap)    [ "$a" -gt 0 ] || die "--heap wants a positive whole number of MB, got '$a'" 2; HEAP_OVR="$a" ;;
    esac
    NEXT=""; continue
  fi
  case "$a" in
    # Refused before any read, clone or network call. design.md §6–§7.
    --restart)
      die "--restart is never allowed: it skips the live-owner check and wipes the state file" 2 ;;
    --merge|--auto-merge|--allow-unreviewed|--sandboxed|--force-merge|--allow-protected)
      die "'$a' is never passed. Merge authority is the project's AGENTS.md via the policy judge; protected-path grants are operator-only." 2 ;;

    --repo)      [ "$#" -ge 1 ] || die "--repo needs a path" 2; FANOUT_REPO="$1"; shift ;;
    --forge-url) [ "$#" -ge 1 ] || die "--forge-url needs a url" 2; FANOUT_FORGE_URL="$1"; shift ;;
    --timeout)   NEXT=timeout ;;
    --workers)   NEXT=workers ;;
    --heap)      NEXT=heap ;;
    --lean)            LEAN=1 ;;
    --dry-run)         DRY_RUN=1 ;;
    --force-clone)     FORCE_CLONE=1 ;;
    --override-triage) OVERRIDE_TRIAGE=1 ;;

    ''|*[!0-9]*) die "unexpected argument '$a' (expected an issue number or a documented flag)" 2 ;;
    *)           [ -z "$ISSUE" ] || die "unexpected extra issue number '$a' — one issue per worker" 2
                 ISSUE="$a" ;;
  esac
done

[ -n "$ISSUE" ] || die "no issue number given" 2
[ -z "$NEXT" ] || die "--$NEXT given with no value" 2
fanout_check_workers --workers "$WORKERS_TOTAL"
fanout_resolve_repo

# A die inside a command substitution exits only the subshell, so the caller checks the
# status rather than trusting the callee to abort.
FORGE="$(fanout_forge_url)" || die "forge url resolution failed" 3
[ -n "$FORGE" ] || die "no usable forge url for $FANOUT_REPO — a worker whose origin is a local path ships nothing. Pass --forge-url." 3

CLONE="$WORKERS_DIR/issue-$ISSUE/repo"
RUNDIR="$RUNS_DIR/issue-$ISSUE"
LOCKDIR="$WORKERS_DIR/issue-$ISSUE.lock"
FANOUT_RES_FILE=""
mkdir -p "$WORKERS_DIR" "$RUNDIR"

# ---------------------------------------------------------------------------
# one worker per issue; cleanup and signal forwarding
# ---------------------------------------------------------------------------
if ! fanout_pidfile_acquire "$LOCKDIR" "worker issue-$ISSUE"; then
  owner="$(cat "$LOCKDIR/pid" 2>/dev/null || echo unknown)"
  started="$(cat "$LOCKDIR/started" 2>/dev/null || echo unknown)"
  die "a worker for issue $ISSUE is already running (pid ${owner:-?}, started ${started:-?}, lock $LOCKDIR). Read $RUNDIR/ndjson.log before assuming it is wedged. If the pid is gone, remove the lock directory; do not reach for --restart." 6
fi

RUNNER_PID=""
SIGNALLED=""
cleanup() {
  fanout_sampler_stop "$LOCKDIR"
  [ -z "$FANOUT_RES_FILE" ] || rm -f -- "$FANOUT_RES_FILE"
  fanout_pidfile_release "$LOCKDIR"
  fanout_ssh_cleanup
}
trap cleanup EXIT

# Before the runner starts there is nothing to forward to, so stop now. After it starts,
# forward the signal and wait: the runner writes its own result before it exits.
on_signal() {
  local code=143
  [ "$1" = INT ] && code=130
  if [ -z "$RUNNER_PID" ]; then
    echo "worker: $1 before the runner started, stopping" >&2
    exit "$code"
  fi
  SIGNALLED="$code"
  echo "worker: $1 received, forwarded to the runner" >>"$RUNDIR/runner.log" 2>/dev/null || true
  kill -"$1" "$RUNNER_PID" 2>/dev/null || true
}
trap 'on_signal TERM' TERM
trap 'on_signal INT' INT

# ---------------------------------------------------------------------------
# gates — a refusal here is usually the correct answer
# ---------------------------------------------------------------------------
TRIAGE="$(fanout_triage_file)"
if [ "$OVERRIDE_TRIAGE" = 0 ] && [ ! -f "$TRIAGE" ]; then
  die "no triage.tsv at $TRIAGE. Run scripts/triage.sh first, or pass --override-triage only if you have personally checked this issue." 4
fi
fanout_check_triage_header

# FANOUT_FORGE_CHECK=0 skips the forge reads. A dry run defaults to 0 so a queue can be checked
# offline; the collision gate below is never skippable.
if [ -z "${FANOUT_FORGE_CHECK:-}" ]; then
  if [ "$DRY_RUN" = 1 ]; then FANOUT_FORGE_CHECK=0; else FANOUT_FORGE_CHECK=1; fi
fi
export FANOUT_FORGE_CHECK

if [ "$OVERRIDE_TRIAGE" = 0 ]; then
  fanout_require_ready "$ISSUE"
  # ready-lean means --lean. Apply it from the table so the verdict, not the argv, sets the budget.
  if [ "$(fanout_row "$ISSUE" verdict)" = ready-lean ]; then LEAN=1; fi
  fanout_require_current "$ISSUE" ""
fi

# Runs on every path, including --override-triage and --dry-run: it guards the forge (two PRs
# over one file), not the triage verdict. A blank cell declares no path, so the gate is blind
# for that issue, and it says so.
files="$(fanout_norm_list "$(fanout_row "$ISSUE" files-likely-touched)")"
# Validated here, not inside the claims reader: a die in its command substitution would exit
# that subshell only, and the failure would surface as "claims unreadable" (exit 11).
fanout_claims_relpath >/dev/null
if [ -n "$files" ]; then
  reserve=1
  [ "$DRY_RUN" = 0 ] || reserve=0
  rc=0
  fanout_reserve_paths "$ISSUE" "$CLONE" "$files" "$reserve" || rc=$?
  case "$rc" in
    0)  ;;
    7)  die "issue $ISSUE collides with a LIVE cycle's declared paths: $FANOUT_HIT — two PRs over one file is a guaranteed conflict and a wasted cycle" 7 ;;
    11) die "the path-claims files could not be read, so collisions cannot be ruled out" 11 ;;
    13) die "could not take the reservation lock under $WORKERS_DIR within 30 s" 13 ;;
    *)  die "could not write the path reservation under $WORKERS_DIR/reservations (exit $rc)" 14 ;;
  esac
else
  warn "issue $ISSUE has no files-likely-touched in triage.tsv; the path-claim gate is therefore blind for it"
fi

if [ "$DRY_RUN" = 1 ]; then
  forge="checked"
  if [ "$FANOUT_FORGE_CHECK" != 1 ] || [ "${FANOUT_SKIP_STALE:-0}" = 1 ]; then forge="NOT CHECKED"; fi
  log "dry run: issue $ISSUE passed the triage and path-claim gates (nothing cloned, nothing spawned); closed/attention: $forge"
  exit 0
fi

# Refuse before the clone when pushes cannot work (design.md §3). Runs after the dry-run exit.
fanout_ssh_ensure

# ---------------------------------------------------------------------------
# budgets and runner environment
# ---------------------------------------------------------------------------
# The divisor is max(requested N, live workers on this fleet): a second drive.sh on the same
# WORKERS_DIR splits the host instead of each taking all of it. Snapshot at start; host-limits.md.
DIVISOR="$WORKERS_TOTAL"
live="$(fanout_live_workers)"
if [ "$live" -gt "$FANOUT_MAX_WORKERS" ]; then
  die "$live workers (this one included) are live on this fleet, above the ceiling of $FANOUT_MAX_WORKERS across all drive.sh runs (references/host-limits.md). Wait for one to finish." 2
fi
if [ "$live" -gt "$DIVISOR" ]; then
  DIVISOR="$live"
  log "host share: $live workers are live on this fleet, so the budget divides by $DIVISOR, not $WORKERS_TOTAL"
fi
# Redirected, never piped: a pipeline would run the function in a subshell and lose its exports.
fanout_apply_budget "$DIVISOR" "$LEAN" "$HEAP_OVR" >"$RUNDIR/budget.log"
cat "$RUNDIR/budget.log"

# Self-signed provider certificates: set only for a provider you trust, never globally on a host
# that also talks to real CAs (environment.md).
[ -z "${FANOUT_NODE_TLS_INSECURE:-}" ] || export NODE_TLS_REJECT_UNAUTHORIZED="$FANOUT_NODE_TLS_INSECURE"
export PI_ENSEMBLE_RUNS_DIR="${FANOUT_TRANSCRIPTS_DIR:-$RUNDIR/transcripts}"

# Test hook: write the environment the runner will inherit and stop before any clone. Nothing
# after this point exports PI_ENSEMBLE_* or NODE_OPTIONS, so this is the runner's environment.
if [ -n "${FANOUT_RUNNER_ENV_DUMP:-}" ]; then
  env | grep -E '^(PI_ENSEMBLE_|NODE_OPTIONS=|NODE_TLS_)' | sort >"$FANOUT_RUNNER_ENV_DUMP"
  exit 0
fi

# ---------------------------------------------------------------------------
# clone
# ---------------------------------------------------------------------------
# A --shared clone: full .git of its own, alternating objects with the main clone (design.md §1–§2).
if [ -e "$CLONE" ]; then
  if [ "$FORCE_CLONE" = 1 ]; then
    log "rebuilding the clone at $CLONE (--force-clone)"
    rm -rf -- "$CLONE" || die "could not remove $CLONE"
  else
    die "clone exists at $CLONE. --force-clone rebuilds it, which also deletes this run's .pi/work-state/ — the record of what the cycle already paid for." 8
  fi
fi

log "cloning issue $ISSUE (--shared from $FANOUT_REPO)"
if ! clone_out="$(git clone --shared --no-checkout "$FANOUT_REPO" "$CLONE" 2>&1)"; then
  printf '%s\n' "$clone_out" | tail -3
  rm -rf -- "$CLONE"
  die "clone failed" 9
fi
printf '%s\n' "$clone_out" | tail -3

# A --shared clone's origin is the LOCAL parent path: repoint it before anything reads it.
git -C "$CLONE" remote set-url origin "$FORGE"          || die "could not repoint origin" 9
git -C "$CLONE" remote set-url --push origin "$FORGE"   || die "could not repoint push url" 9
[ "$(git -C "$CLONE" remote get-url origin)" = "$FORGE" ] || die "origin did not take: $(git -C "$CLONE" remote get-url origin)" 9

# No GC, ever (design.md §2): these three stop an incidental fetch or push from scheduling one.
git -C "$CLONE" config receive.autogc false
git -C "$CLONE" config gc.auto 0
git -C "$CLONE" config gc.autoPackLimit 0
git -C "$CLONE" config gc.pruneExpire never
git -C "$CLONE" config remote.origin.prune false

# The base is origin/main, never the local main: a --shared clone copies the source checkout's
# local main, which can be behind the forge or carry unpushed commits. A fetch that did not
# complete therefore leaves no trustworthy base, and the cycle refuses unless the operator opts in.
fanout_bounded "${FANOUT_TIMEOUT_FETCH:-120}" git -C "$CLONE" fetch --tags origin >/dev/null 2>&1
rc=$?
if [ "$rc" != 0 ]; then
  why="failed"
  [ "$rc" != 124 ] || why="timed out after ${FANOUT_TIMEOUT_FETCH:-120}s (FANOUT_TIMEOUT_FETCH)"
  [ "${FANOUT_ALLOW_LOCAL_BASE:-0}" = 1 ] \
    || die "forge fetch $why, so origin/main is not known to be current. Refusing to branch from a stale or unpushed local main. Fix the connection, or set FANOUT_ALLOW_LOCAL_BASE=1 to accept the clone's last-known origin/main." 9
  warn "forge fetch $why; FANOUT_ALLOW_LOCAL_BASE=1 accepts the clone's last-known origin/main as the base"
fi
git -C "$CLONE" rev-parse --verify -q origin/main >/dev/null 2>&1 \
  || die "origin/main is not present in the clone, so there is no base to build on. Is the mainline named main?" 9
git -C "$CLONE" checkout -q -B main origin/main >/dev/null 2>&1 \
  || die "could not check out origin/main as the base" 9

# ---------------------------------------------------------------------------
# dependencies and role prompts
# ---------------------------------------------------------------------------
log "installing extension dependencies"
install_out="$( (cd "$CLONE/extension" && fanout_bounded "${FANOUT_TIMEOUT_INSTALL:-600}" bun install --frozen-lockfile) 2>&1)"
rc=$?
if [ "$rc" != 0 ]; then
  printf '%s\n' "$install_out" | tail -5
  if [ "$rc" = 124 ]; then
    die "bun install timed out after ${FANOUT_TIMEOUT_INSTALL:-600}s (FANOUT_TIMEOUT_INSTALL)" 10
  fi
  die "bun install failed" 10
fi
printf '%s\n' "$install_out" | tail -5
[ -d "$CLONE/extension/node_modules/@earendil-works/pi-coding-agent" ] \
  || die "install produced no pi-coding-agent — the cycle would spawn no children" 10

# Role prompts are gitignored: a fresh clone has none, and every child spawn reads them.
log "building role prompts (output: $RUNDIR/build.log)"
( cd "$CLONE" && bun run build ) >"$RUNDIR/build.log" 2>&1 \
  || die "bun run build failed — dist/prompts/standard/ is required by every child spawn. Last lines:
$(tail -n 8 "$RUNDIR/build.log")" 11
[ -f "$CLONE/dist/prompts/standard/explore.md" ] || die "build succeeded but dist/prompts/standard/explore.md is missing" 11

# Post-clone: the files the ticket names must exist in the tree actually being built.
fanout_require_current "$ISSUE" "$CLONE"

# ---------------------------------------------------------------------------
# run
# ---------------------------------------------------------------------------
# The runner comes from the BUILT clone, so its imports and node_modules are this worker's own.
# FANOUT_RUNNER overrides the location; there is no source fallback.
HEADLESS="${FANOUT_RUNNER:-$CLONE/bin/pi-rukas-headless}"
[ -x "$HEADLESS" ] || die "runner not executable at $HEADLESS. Build the clone, or set FANOUT_RUNNER. There is no source fallback: a runner other than the built one is not the one design.md judges." 12

NDJSON="$RUNDIR/ndjson.log"
RESULT="$RUNDIR/result.json"
HOSTLOG="$RUNDIR/runner.log"
TIMEOUT_ARGS=()
[ -z "$TIMEOUT_MIN" ] || TIMEOUT_ARGS=(--timeout "$TIMEOUT_MIN")

{ echo "worker-start: $(date -u +%Y-%m-%dT%H:%M:%SZ) issue=$ISSUE repo=$FANOUT_REPO";
  cat "$RUNDIR/budget.log"; } | tee "$HOSTLOG"

# Sampled from this worker's own pid, so clone, install and build are attributed too.
fanout_sampler_start "$LOCKDIR" "$RUNDIR/rss.log" "$$"
RUN_START="$(date -u +%Y-%m-%dT%H:%M:%SZ)"
(
  cd "$CLONE" || exit 12
  exec "$HEADLESS" work "$ISSUE" --json ${TIMEOUT_ARGS[@]+"${TIMEOUT_ARGS[@]}"}
) 2>"$NDJSON" 1>"$RESULT" &
RUNNER_PID=$!

# wait returns early when a trapped signal arrives; the runner is still alive then, so loop.
while :; do
  wait "$RUNNER_PID"
  rc=$?
  if kill -0 "$RUNNER_PID" 2>/dev/null; then continue; fi
  RUN_CODE=$rc
  break
done
CODE="$RUN_CODE"
[ -z "$SIGNALLED" ] || CODE="$SIGNALLED"
RUN_END="$(date -u +%Y-%m-%dT%H:%M:%SZ)"
fanout_sampler_stop "$LOCKDIR"

echo "worker-end: $RUN_END exit=$CODE" | tee -a "$HOSTLOG"

# ---------------------------------------------------------------------------
# report, then exit with the runner's code. Diagnostics below cannot change CODE.
# ---------------------------------------------------------------------------
if [ -s "$RESULT" ]; then
  echo "--- result ---"
  "$(fanout_node)" -e '
    const fs = require("fs");
    try {
      const d = JSON.parse(fs.readFileSync(process.argv[1], "utf8"));
      const s = (d.issues || []).map((i) => [i.issue, i.status, i.cap || "-", i.failedStep || "-",
        i.prNumber ? "PR#" + i.prNumber : "-", (i.usage ? Math.round(i.usage.cost * 100) / 100 : "-") + "usd",
        Math.round((i.durationMs || 0) / 1000) + "s", (i.usage ? i.usage.dispatches : "-") + "disp"].join(" | "));
      console.log("exit=" + d.exitCode + " build=" + (d.buildVersion || "?") + (d.error ? " error=" + d.error.code : ""));
      s.forEach((x) => console.log("  " + x));
      if (d.resources && d.resources.limits) console.log("  limits=" + JSON.stringify(d.resources.limits));
    } catch (e) { console.log("could not parse result: " + e.message); }
  ' "$RESULT" 2>/dev/null || tail -c 2000 "$RESULT"
  echo "----------------"
else
  warn "no stdout JSON (exit $CODE). stderr tail:"
  tail -5 "$NDJSON" 2>/dev/null || true
fi

echo "$CODE"      >"$RUNDIR/exit-code"
echo "$RUN_START" >"$RUNDIR/started-at"
echo "$RUN_END"   >"$RUNDIR/ended-at"
exit "$CODE"
