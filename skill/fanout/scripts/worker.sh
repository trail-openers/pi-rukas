#!/usr/bin/env bash
# worker.sh — run ONE /work cycle in its own ephemeral clone.
#
#   worker.sh --repo <path> <issue> [--forge-url <url>] [--workers N] [--lean]
#             [--timeout <min>] [--force-clone] [--dry-run] [--override-triage]
#
# One issue per worker, one process per worker. Parallelism comes from running several
# of these (see drive.sh), NOT from worktrees and NOT from subagents. Read
# references/design.md before editing — the invariants below are all silent-failure fixes.
#
# ---------------------------------------------------------------------------
# Why a full clone and never a worktree  (design.md §1)
# ---------------------------------------------------------------------------
# `git rev-parse --git-common-dir` from a linked worktree resolves to the MAIN clone's
# .git. The review ledger (#912 merge guard — fails closed without adversarial + lens
# rows), the integration lockfile and the worktree namespace all resolve from there. N
# worktree-hosted drivers therefore share one ledger and one lock: they do not merely
# contend, they corrupt the gate that stops unreviewed merges.
#
# A full clone gets its own .git and is genuinely isolated. --shared keeps that .git at
# ~300 KB by alternating to the main object store — isolation at clone cost.
#
# ---------------------------------------------------------------------------
# Why GC is forbidden, in this and every sibling script  (design.md §2)
# ---------------------------------------------------------------------------
# --shared points objects/info/alternates at the MAIN clone's object directory: both
# clones read the SAME objects. `git gc`, `git repack`, `git prune`, `git worktree prune`
# — here or against the main clone while a worker lives — can delete objects the other
# clone still reads, and loose objects unreferenced from this clone's refs may be
# reachable only from the user's live checkout. This is the one rule whose violation
# damages the user's working tree rather than just this run.
#
# Defence in depth: (1) never run those commands, (2) gc.auto=0 + receive.autogc=false in
# each clone so an incidental fetch/push cannot schedule one, (3) remote.origin.prune
# stays false so no remote-tracking ref pruning either.
# ---------------------------------------------------------------------------

set -uo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd -P)"
# shellcheck source=lib.sh
. "$SCRIPT_DIR/lib.sh"

# ---------------------------------------------------------------------------
# argv
# ---------------------------------------------------------------------------
[ "$#" -ge 1 ] || die "usage: worker.sh --repo <path> <issue> [--forge-url <url>] [--workers N] [--lean] [--timeout <min>] [--force-clone] [--dry-run] [--override-triage]" 2

ISSUE=""
TIMEOUT_MIN=""
WORKERS_TOTAL="${FANOUT_WORKERS:-1}"
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
      heap)    HEAP_OVR="$a" ;;
    esac
    NEXT=""; continue
  fi
  case "$a" in
    # Hard refusals, BEFORE any read, clone, or network call. Never route around these;
    # see design.md §6-§7 for why each one is load-bearing.
    --restart)
      die "--restart is never allowed: it skips the live-owner check and wipes the state file, letting two workers drive one cycle" 2 ;;
    --merge|--auto-merge|--allow-unreviewed|--sandboxed|--force-merge|--allow-protected)
      die "'$a' is never passed. Merge authority belongs to the project's AGENTS.md via the policy judge; protected-path grants are operator-only." 2 ;;

    --repo)      [ "$#" -ge 1 ] || die "--repo needs a path" 2; FANOUT_REPO="$1"; shift ;;
    --forge-url) [ "$#" -ge 1 ] || die "--forge-url needs a url" 2; FANOUT_FORGE_URL="$1"; shift ;;
    --timeout)   NEXT=timeout ;;
    --workers)   NEXT=workers ;;
    --heap)      NEXT=heap ;;
    --lean)          LEAN=1 ;;
    --dry-run)       DRY_RUN=1 ;;
    --force-clone)   FORCE_CLONE=1 ;;
    --override-triage) OVERRIDE_TRIAGE=1 ;;

    ''|*[!0-9]*) die "unexpected argument '$a' (expected an issue number or a documented flag)" 2 ;;
    *)           [ -z "$ISSUE" ] || die "unexpected extra issue number '$a' — one issue per worker" 2
                 ISSUE="$a" ;;
  esac
done

[ -n "$ISSUE" ] || die "no issue number given" 2
[ -z "$NEXT" ] || die "--$NEXT given with no value" 2
fanout_resolve_repo
HEAP_OVR="${HEAP_OVR:-}"

# `die` inside a function that is called from a command substitution cannot stop the script --
# exit only leaves the subshell. fanout_forge_url is called as FORGE="$(fanout_forge_url)", so
# its own die would print a message and vanish, leaving FORGE empty and letting the worker clone
# and push nowhere while the run looked successful. Measured: exactly that, exit 9 from a later
# step instead of the intended refusal. So the caller validates rather than trusting the callee
# to abort, and the callee's message is still printed for the operator.
FORGE="$(fanout_forge_url)" || die "forge url resolution failed" 3
[ -n "$FORGE" ] || die "no usable forge url for $FANOUT_REPO. A worker whose origin is a local path pushes into its own parent clone and the PR never appears -- the cycle then reports success having shipped nothing. Pass --forge-url explicitly." 3
CLONE="$WORKERS_DIR/issue-$ISSUE/repo"
RUNDIR="$RUNS_DIR/issue-$ISSUE"
LOCKDIR="$WORKERS_DIR/issue-$ISSUE.lock"
mkdir -p "$WORKERS_DIR" "$RUNS_DIR"

# ---------------------------------------------------------------------------
# one worker per issue
# ---------------------------------------------------------------------------
fanout_ssh_ensure
if ! fanout_pidfile_acquire "$LOCKDIR" "worker issue-$ISSUE"; then
  owner="$(cat "$LOCKDIR/pid" 2>/dev/null || echo unknown)"
  started="$(cat "$LOCKDIR/started" 2>/dev/null || echo unknown)"
  die "a worker for issue $ISSUE is already running (pid ${owner:-?}, started ${started:-?}, lock $LOCKDIR). Read $RUNDIR/ndjson.log before assuming it is wedged -- a slow cycle is not a stuck one, and killing a live cycle mid-develop loses its worktree. If the pid is genuinely gone, remove the lock directory explicitly rather than reaching for --restart, which skips the live-owner check entirely." 6
fi
trap 'fanout_sampler_stop "$LOCKDIR"; fanout_pidfile_release "$LOCKDIR"; fanout_ssh_cleanup' EXIT
# SIGTERM/SIGINT are trapped to the same cleanup path rather than left to default-kill.
# A plain `timeout N worker.sh` sends SIGTERM, which under the default disposition kills the
# process WITHOUT running the EXIT trap -- measured, it left a stale lock and wrote no
# exit-code, no started-at/ended-at and no report block, so the run silently lost its entire
# reporting contract. Operators reach for `timeout` as a wedge-guard, so this path has to work.
# The runner's own bound (--timeout, forwarded to the headless runner) is the better bound
# because it lets the driver emit a result; this trap is the safety net for the case where it
# cannot.
trap 'echo "worker: terminated by signal, cleaning up" >>"$RUNDIR/runner.log" 2>/dev/null || true; exit 143' TERM
trap 'exit 130' INT

# ---------------------------------------------------------------------------
# gates — a refusal here is usually the correct answer
# ---------------------------------------------------------------------------
if [ "$OVERRIDE_TRIAGE" = 0 ]; then
  [ -f "${FANOUT_TRIAGE_FILE:-$FANOUT_ROOT/triage.tsv}" ] \
    || die "no triage.tsv at ${FANOUT_TRIAGE_FILE:-$FANOUT_ROOT/triage.tsv}. Run scripts/triage.sh first, or pass --override-triage only if you have personally checked this issue." 4
  fanout_require_ready "$ISSUE"
  # Pre-clone staleness: closed on the forge, or handed off previously. Both are refuse-now
  # facts, and checking them before cloning saves a clone + bun install + prompt build for a
  # ticket that must not run at all.
  #
  # FANOUT_FORGE_CHECK=0 skips the forge round-trips. A dry run defaults to 0: `--dry-run` is
  # used to check a queue offline and without paying a rate limit per issue, and these two
  # facts are re-checked for real the moment the run is not a dry run. The collision gate
  # below is NOT skippable -- see its comment.
  if [ "${FANOUT_FORGE_CHECK:-$([ "$DRY_RUN" = 1 ] && echo 0 || echo 1)}" = 1 ]; then
    fanout_require_current "$ISSUE" ""
  fi
  files="$(fanout_row "$ISSUE" files-likely-touched)"
  if [ -n "$files" ]; then
    # Runs under --dry-run too, deliberately. The whole purpose of a dry run is to predict
    # what the real run will do; a gate that only bites at runtime means the dry run silently
    # approves a collision the real run refuses, which is worse than having no dry run at all.
    # fanout_live_claims dies (exit 11) on an unreadable claims file, but `die` inside a
    # command substitution only exits the subshell. Capture it on its own line and propagate
    # the status, or a corrupt claims file reads as "no live claims" and the gate fails OPEN.
    claims="$(fanout_live_claims)" || exit "$?"
    hit="$(fanout_intersection "$claims" "$files")"
    [ "$hit" = "[]" ] || die "issue $ISSUE collides with a LIVE cycle's declared paths: $hit — two PRs over one file is a guaranteed conflict and a wasted cycle" 7
  else
    warn "issue $ISSUE has no files-likely-touched in triage.tsv; the path-claim gate is therefore blind for it"
  fi
fi

if [ "$DRY_RUN" = 1 ]; then
  log "dry run: issue $ISSUE passed the triage and path-claim gates (nothing cloned, nothing spawned)"
  exit 0
fi

# ---------------------------------------------------------------------------
# clone
# ---------------------------------------------------------------------------
if [ -e "$CLONE" ]; then
  if [ "$FORCE_CLONE" = 1 ]; then
    log "rebuilding the clone at $CLONE (--force-clone)"
    rm -rf -- "$CLONE" || die "could not remove $CLONE"
  else
    die "clone exists at $CLONE. --force-clone rebuilds it. Note that deleting it also deletes this run's .pi/work-state/, so the driver's own resume is gone — that state file is the record of what the cycle already paid for." 8
  fi
fi

log "cloning issue $ISSUE (--shared from $FANOUT_REPO)"
git clone --shared --no-checkout "$FANOUT_REPO" "$CLONE" 2>&1 | tail -3 || die "clone failed" 9

# A --shared clone's origin is the LOCAL path. Left alone, this worker pushes into its
# parent and the PR never reaches the forge: the cycle looks successful and ships nothing.
git -C "$CLONE" remote set-url origin "$FORGE"          || die "could not repoint origin" 9
git -C "$CLONE" remote set-url --push origin "$FORGE"   || die "could not repoint push url" 9
[ "$(git -C "$CLONE" remote get-url origin)" = "$FORGE" ] || die "origin did not take: $(git -C "$CLONE" remote get-url origin)" 9

git -C "$CLONE" config receive.autogc false
git -C "$CLONE" config gc.auto 0
git -C "$CLONE" config gc.autoPackLimit 0
git -C "$CLONE" config gc.pruneExpire never
git -C "$CLONE" config remote.origin.prune false

# The clone's refs came from the local checkout, which may be behind mainline; the driver
# diffs against origin/<base>, so fetch the forge's mainline explicitly. Offline-tolerant:
# a failure here degrades to running on local refs rather than killing the cycle.
git -C "$CLONE" fetch --tags origin >/dev/null 2>&1 || warn "forge fetch failed (offline?) — running on local refs"
git -C "$CLONE" checkout main >/dev/null 2>&1 \
  || git -C "$CLONE" checkout -B main origin/main >/dev/null 2>&1 \
  || die "checkout failed — is 'main' the mainline? The driver detects it via origin/HEAD, but the clone needs a starting ref." 9

# ---------------------------------------------------------------------------
# dependencies
# ---------------------------------------------------------------------------
# bun resolves from its global cache, so this is sub-second warm. It writes only into the
# worker's own extension/node_modules — never shared, unlike the main checkout's tree that
# .pi/worktree-setup symlinks into worktrees.
log "installing extension dependencies"
( cd "$CLONE/extension" && bun install --frozen-lockfile ) 2>&1 | tail -5 || die "bun install failed" 10
[ -d "$CLONE/extension/node_modules/@earendil-works/pi-coding-agent" ] \
  || die "install produced no pi-coding-agent — the cycle would spawn no children" 10

# Role prompts are gitignored, so a fresh clone has none, and spawnSpecialist reads
# <worktree>/dist/prompts/standard/<role>.md. Missing => every child spawn dies ENOENT.
# Asserting the file, not the exit code, because a build can succeed and still not emit it.
log "building role prompts"
( cd "$CLONE" && bun run build ) >/dev/null 2>&1 || die "bun run build failed — dist/prompts/standard/ is required by every child spawn" 11
[ -f "$CLONE/dist/prompts/standard/explore.md" ] || die "build succeeded but dist/prompts/standard/explore.md is missing" 11

# Post-clone staleness: the files the ticket names must exist in the tree actually being
# built. This is the check that catches a ticket describing code that has since been renamed
# or removed -- which the pre-clone gate cannot see, because "exists" is relative to a tree
# this point in the script is the first place one exists.
fanout_require_current "$ISSUE" "$CLONE"

# ---------------------------------------------------------------------------
# budgets + environment
# ---------------------------------------------------------------------------
mkdir -p "$RUNDIR"
fanout_apply_budget "$WORKERS_TOTAL" "$LEAN" "$HEAP_OVR" | tee "$RUNDIR/budget.log"

# The runner comes from the BUILT clone, never from the user's checkout: its imports and
# node_modules must be the ones this worker's bun install produced (a dirty or differently
# branched user checkout would otherwise change what every worker runs).
HEADLESS="$CLONE/bin/pi-rukas-headless"
[ -x "$HEADLESS" ] || HEADLESS="$CLONE/extension/src/headless/cli.ts"
[ -f "$HEADLESS" ] || die "runner not found in the clone ($HEADLESS) — the build cannot be run" 12

# Self-signed provider certificates. Deliberately NOT hardcoded: this is a property of the
# provider, not of the fan-out, so it arrives from the environment. Set it only for a
# provider you trust with a self-signed chain — never globally on a host that also talks
# to real certificate authorities. pi-rukas passes it through to every child.
[ -z "${FANOUT_NODE_TLS_INSECURE:-}" ] || export NODE_TLS_REJECT_UNAUTHORIZED="$FANOUT_NODE_TLS_INSECURE"

# Keep transcripts with the run they belong to rather than in the repo.
export PI_ENSEMBLE_RUNS_DIR="${FANOUT_TRANSCRIPTS_DIR:-$RUNDIR/transcripts}"

# ---------------------------------------------------------------------------
# run
# ---------------------------------------------------------------------------
NDJSON="$RUNDIR/ndjson.log"
RESULT="$RUNDIR/result.json"
HOSTLOG="$RUNDIR/runner.log"
TIMEOUT_ARGS=()
[ -z "$TIMEOUT_MIN" ] || TIMEOUT_ARGS=(--timeout "$TIMEOUT_MIN")

{ echo "worker-start: $(date -u +%Y-%m-%dT%H:%M:%SZ) issue=$ISSUE repo=$FANOUT_REPO";
  cat "$RUNDIR/budget.log"; } | tee "$HOSTLOG"

# Sample the worker's OWN process tree, rooted at this worker's pid. The runner is a
# descendant, so it and every child it spawns are attributed here; the operator's own pi
# session and any sibling worker are not. Rooting at $$ rather than at the runner means the
# samples cover clone + bun install + prompt build too, which is where a naive per-phase
# measurement misses cost entirely.
fanout_sampler_start "$LOCKDIR" "$RUNDIR/rss.log" "$$"
RUN_START="$(date -u +%Y-%m-%dT%H:%M:%SZ)"
(
  cd "$CLONE" || exit 12
  # The repo's own wrapper execs `bun .../headless/cli.ts`; falling back to the .ts keeps
  # a worker running where the wrapper is not on PATH or not executable.
  # ${arr[@]+...} because bash 3.2 reads an empty array expansion as unbound under set -u.
  if [ -x "$HEADLESS" ]; then exec "$HEADLESS" work "$ISSUE" --json ${TIMEOUT_ARGS[@]+"${TIMEOUT_ARGS[@]}"}
  else exec bun "$HEADLESS" work "$ISSUE" --json ${TIMEOUT_ARGS[@]+"${TIMEOUT_ARGS[@]}"}
  fi
) 2>"$NDJSON" 1>"$RESULT"
CODE=$?
RUN_END="$(date -u +%Y-%m-%dT%H:%M:%SZ)"
fanout_sampler_stop "$LOCKDIR"

echo "worker-end: $RUN_END exit=$CODE" | tee -a "$HOSTLOG"

# ---------------------------------------------------------------------------
# report, then propagate the runner's exit code VERBATIM
# ---------------------------------------------------------------------------
# The exit code IS the contract (0 merged, 10 handoff, 11 clarification, 20 aborted,
# 21 interrupted, 30 crash, 40 refused). Everything diagnostic below is guarded so it can
# never overwrite it, and the final exit uses the saved value.
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
