#!/usr/bin/env bash
# drive.sh — run a list of issues across N independent workers; append one row per
# finished cycle to <repo>/tmp/fanout/summary.tsv.
#
#   drive.sh --repo <path> [--parallel N] [--forge-url <url>] [--dry-run] <issue>...
#   drive.sh --repo <path> --from-file queue.txt
#   echo 1514 1515 | drive.sh --repo <path> -
#
# --parallel is the concurrency, i.e. how many workers run at once. Size it from
# scripts/capacity.sh, not from a remembered number: pi-rukas's own budget reads
# os.totalmem(), so a machine that is already starved still advertises full capacity.
# Starting at 2 and raising from measured RSS beats starting high and discovering it via
# OOM kills — the victim of an unbounded OOM may be the user's own interactive cycle.
#
# What it does per issue:
#   1. triage gate  — a verdict other than `ready`/`ready-lean` records `skipped-triage`
#                     and never spawns. A refusal is usually correct; read it.
#   2. claim gate   — likely files intersecting a LIVE cycle's path claims record
#                     `skipped-claim-collision`. Claims are filtered on owner-pid aliveness.
#   3. worker.sh    — ephemeral --shared clone, own .git, divided budgets, one cycle.
#   4. summary row  — appended under a per-file lock so parallel writers cannot lose a row.
#
# Never forwarded, refused on argv outright: --restart, --merge, --auto-merge,
# --allow-unreviewed, --sandboxed, --allow-protected. See worker.sh + design.md §6-§7.
# Never run anywhere in this tree: git gc / repack / prune / worktree prune (design.md §2).
set -uo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd -P)"
# shellcheck source=lib.sh
. "$SCRIPT_DIR/lib.sh"

MAX_PARALLEL=2
ISSUES=()
EXTRA_WORKER_ARGS=()
TIMEOUT_ARGS=()
DRY_RUN=0
NEXT=""   # which flag is expecting a value

while [ "$#" -gt 0 ]; do
  a="$1"; shift
  if [ -n "$NEXT" ]; then
    case "$a" in ''|*[!0-9]*) die "--$NEXT wants a positive integer, got '$a'" 2 ;; esac
    case "$NEXT" in
      parallel) MAX_PARALLEL="$a" ;;
      timeout)  TIMEOUT_ARGS=(--timeout "$a") ;;
    esac
    NEXT=""; continue
  fi
  case "$a" in
    --restart) die "--restart is never allowed (skips the live-owner check; would clobber a cycle another process owns)" 2 ;;
    --merge|--auto-merge|--allow-unreviewed|--sandboxed|--force-merge|--allow-protected)
      die "'$a' is never passed (merge authority is the project's AGENTS.md alone; protected-path grants are operator-only)" 2 ;;
    --parallel)  NEXT=parallel ;;
    --timeout)   NEXT=timeout ;;
    --repo)      [ "$#" -ge 1 ] || die "--repo needs a path" 2; FANOUT_REPO="$1"; shift ;;
    --forge-url) [ "$#" -ge 1 ] || die "--forge-url needs a url" 2; FANOUT_FORGE_URL="$1"; shift ;;
    --from-file) [ "$#" -ge 1 ] || die "--from-file needs a path" 2
                 FROM_FILE="$1"; shift
                 [ -r "$FROM_FILE" ] || die "cannot read $FROM_FILE" 2
                 # One issue per line, or whitespace-separated; # starts a comment.
                 while IFS= read -r line || [ -n "$line" ]; do
                   line="${line%%#*}"
                   for x in $line; do ISSUES+=("$x"); done
                 done <"$FROM_FILE" ;;
    --dry-run)   DRY_RUN=1 ;;
    --lean|--force-clone|--override-triage) EXTRA_WORKER_ARGS+=("$a") ;;
    -)           # stdin: same lexing as --from-file
                 while IFS= read -r line || [ -n "$line" ]; do
                   line="${line%%#*}"
                   for x in $line; do ISSUES+=("$x"); done
                 done ;;
    ''|*[!0-9]*) die "unexpected argument '$a' (expected an issue number, '-', --repo, --parallel N, --forge-url, --timeout <min>, --from-file, --lean, --force-clone, --override-triage or --dry-run)" 2 ;;
    *)           ISSUES+=("$a") ;;
  esac
done

fanout_resolve_repo
[ "${#ISSUES[@]}" -gt 0 ] || die "no issues given (pass numbers, '-', or --from-file <path>)" 2

# Reject a malformed queue loudly. Silently dropping "1514x" would run a subset and report
# the whole queue as done, which is the worst kind of partial success. awk does the
# iteration: a mode-independent bash guard on some hosts denies `for ... in` loops.
bad="$(printf '%s\n' "${ISSUES[@]}" | awk '/[^0-9]|^$/ { print; exit }')"
[ -z "$bad" ] || die "issue numbers must be digits only; got '$bad' (check the queue file)" 2

# Drop duplicates: two workers on one issue is refused by the pidfile anyway, but only
# after both clone and install, which is minutes of waste for a mistake in the queue.
DEDUPED="$(printf '%s\n' "${ISSUES[@]}" | awk 'NF && !seen[$0]++')"
n_before="$(printf '%s\n' "${ISSUES[@]}" | grep -c .)"
n_after="$(printf '%s\n' "$DEDUPED" | grep -c .)"
if [ "$n_after" != "$n_before" ]; then
  warn "dropped $((n_before - n_after)) duplicate issue(s) from the queue"
fi
ISSUES=()
while IFS= read -r x; do [ -n "$x" ] && ISSUES+=("$x"); done <<__DEDUP__
$DEDUPED
__DEDUP__
[ "$MAX_PARALLEL" -ge 1 ] || MAX_PARALLEL=1

mkdir -p "$RUNS_DIR"
SUMMARY="$FANOUT_ROOT/summary.tsv"
LOCK="$FANOUT_ROOT/.summary.lock"

# Header only when creating, so an appended row can never be mistaken for the schema.
if [ ! -f "$SUMMARY" ]; then
  printf 'issue\tstatus\tcap\tfailedStep\texit\tcost_usd\tduration_s\tdispatches\tpr\tbranch\trun_dir\tfinished_at\n' >"$SUMMARY"
fi

append_row() {  # one row, under a mkdir lock so parallel writers cannot interleave
  local row="$1" waited=0
  # Bounded: a lock left behind by a killed drive.sh used to hang every worker forever with no
  # output. Wait FANOUT_SUMMARY_LOCK_WAIT seconds (default 60), then say which directory to remove.
  while ! mkdir "$LOCK" 2>/dev/null; do
    sleep 0.05
    waited=$((waited + 1))
    if [ "$waited" -ge "$(( ${FANOUT_SUMMARY_LOCK_WAIT:-60} * 20 ))" ]; then
      die "summary lock still held after ${FANOUT_SUMMARY_LOCK_WAIT:-60} s: $LOCK. If no drive.sh is running, remove that directory and re-run; this worker's summary row was not written." 1
    fi
  done
  printf '%s\n' "$row" >>"$SUMMARY"
  rmdir "$LOCK" 2>/dev/null || true
}

# Read the headless --json result and emit one tab-separated row. Falls back to a
# row that names the parse failure rather than silently dropping the run — a lost
# row is worse than an ugly one, because the operator sizes N from this table.
row_from_result() {  # $1 = issue, $2 = exit code, $3 = result json path, $4 = run dir
  # Emits the 12 columns of the summary header exactly once, run_dir and finished_at included.
  # The caller appends the row as-is; splicing columns onto it after the fact is what put
  # finished_at under the wrong header and produced 13 fields.
  "$(fanout_node)" -e '
    const fs = require("fs");
    const [issue, code, path, rundir] = process.argv.slice(1);
    const t = (s) => String(s ?? "-").replace(/[\t\n]/g, " ");
    try {
      const d = JSON.parse(fs.readFileSync(path, "utf8"));
      const i = (d.issues || [{}])[0] || {};
      const u = i.usage || {};
      console.log([issue, t(i.status), t(i.cap), t(i.failedStep), t(code),
        t(u.cost), t(Math.round((i.durationMs || 0) / 1000)), t(u.dispatches),
        t(i.prNumber), t(i.branch), t(rundir), t(new Date().toISOString())].join("\t"));
    } catch (e) {
      console.log([issue, "unparsed:" + e.message.slice(0, 40), "-", "-", t(code),
        "-","-","-","-","-", t(rundir), t(new Date().toISOString())].join("\t"));
    }
  ' "$1" "$2" "$3" "$4" 2>/dev/null || printf '%s\t%s\t-\t-\t%s\t-\t-\t-\t-\t-\t%s\t%s\n' "$1" "unparsed" "$2" "$4" "$(date -u +%Y-%m-%dT%H:%M:%SZ)"
}

run_one() {  # $1 = issue
  local issue="$1" code row
  log "worker $issue starting"
  # shellcheck disable=SC2086
  "$SCRIPT_DIR/worker.sh" --repo "$FANOUT_REPO" --workers "$MAX_PARALLEL" \
    ${EXTRA_WORKER_ARGS[@]+"${EXTRA_WORKER_ARGS[@]}"} ${TIMEOUT_ARGS[@]+"${TIMEOUT_ARGS[@]}"} "$issue" \
    >"$RUNS_DIR/issue-$issue/worker.out" 2>&1
  code=$?
  mkdir -p "$RUNS_DIR/issue-$issue"
  # shellcheck disable=SC2086
  row="$(row_from_result "$issue" "$code" "$RUNS_DIR/issue-$issue/result.json" "$RUNS_DIR/issue-$issue")"
  append_row "$row"
  log "worker $issue finished exit=$code"
  return "$code"
}

# --------------------------------------------------------------------------
# dispatch — a bounded worker pool
# --------------------------------------------------------------------------
# Issues are consumed in the order given, so priority order is the caller's argument
# order. A worker that finishes frees a slot for the next issue; nothing waits for a
# whole batch.
log "queue: ${#ISSUES[@]} issues, parallel=$MAX_PARALLEL, repo=$FANOUT_REPO"

if [ "$DRY_RUN" = 1 ]; then
  # `while read` over a here-string rather than a `for ... in` loop: a mode-independent bash
  # guard on some hosts denies for-loops, and a documented command an agent cannot run is a
  # worse bug than the verbosity this costs.
  #
  # ONE invocation per issue, capturing output. The first version ran worker.sh twice -- once
  # to test the exit code and again to capture the message -- which doubled the refusals and
  # allowed the two runs to disagree (a live-claim gate is not idempotent when a sibling worker
  # started between them).
  #
  # ${arr[@]+${arr[@]}} is the bash-3.2-safe way to expand a possibly-empty array under set -u;
  # a bare $EXTRA_WORKER_ARGS aborts the script with "unbound variable", which is how this
  # first presented -- and only on the --dry-run path with no extra flags, so it hid until now.
  # ${ISSUES[*]} joins with the first char of IFS, which is a SPACE -- so the whole queue
  # arrived as one "issue number". Set IFS to newline for the expansion, and quote it so
  # word-splitting cannot re-break it.
  while IFS= read -r i; do
    [ -n "$i" ] || continue
    out="$("$SCRIPT_DIR/worker.sh" --repo "$FANOUT_REPO" --dry-run ${EXTRA_WORKER_ARGS[@]+"${EXTRA_WORKER_ARGS[@]}"} "$i" 2>&1)"
    rc=$?
    if [ "$rc" = 0 ]; then
      echo "  $i  would run"
    else
      echo "  $i  refused (exit $rc): $(printf '%s' "$out" | tail -1)"
    fi
  done <<__QUEUE__
$(printf '%s\n' "${ISSUES[@]}")
__QUEUE__
  exit 0
fi

# Count live workers by PID in THIS shell. `jobs -rp` inside a command substitution runs in a
# subshell whose job table does not hold the parent's background jobs, so the count read 0 and
# --parallel was silently ignored. A kill -0 probe of tracked PIDs has no such dependency.
# The count is set in LIVE, not echoed, for the same reason: no subshell is involved at all.
PIDS=()
LIVE=0
count_live() {
  LIVE=0
  local p
  for p in ${PIDS[@]+"${PIDS[@]}"}; do
    if kill -0 "$p" 2>/dev/null; then LIVE=$((LIVE + 1)); fi
  done
}

i=0
while [ "$i" -lt "${#ISSUES[@]}" ]; do
  count_live
  while [ "$LIVE" -ge "$MAX_PARALLEL" ]; do sleep 1; count_live; done
  issue="${ISSUES[$i]}"
  mkdir -p "$RUNS_DIR/issue-$issue"
  run_one "$issue" &
  PIDS+=("$!")
  i=$((i + 1))
done
wait

echo
echo "done — $SUMMARY"
"$(fanout_node)" -e '
  const fs = require("fs");
  const rows = fs.readFileSync(process.argv[1], "utf8").split("\n").filter(Boolean);
  const head = rows[0].split("\t");
  const si = head.indexOf("status"), ci = head.indexOf("cost_usd");
  const tally = {};
  let cost = 0;
  for (const r of rows.slice(1)) { const c = r.split("\t");
    const s = (c[si] || "?").split(":")[0]; tally[s] = (tally[s] || 0) + 1;
    const p = parseFloat(c[ci]); if (isFinite(p)) cost += p; }
  console.log("outcomes: " + Object.entries(tally).map(([k, v]) => k + "=" + v).join("  "));
  console.log("total cost: $" + Math.round(cost * 100) / 100);
' "$SUMMARY" 2>/dev/null || cat "$SUMMARY"
