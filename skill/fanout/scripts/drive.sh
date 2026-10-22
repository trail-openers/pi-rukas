#!/usr/bin/env bash
# drive.sh — run a list of issues across N workers; append one row per finished cycle to
# <root>/summary.tsv.
#
#   drive.sh --repo <path> [--parallel N] [--forge-url <url>] [--dry-run] <issue>...
#   drive.sh --repo <path> --from-file queue.txt
#   echo 1514 1515 | drive.sh --repo <path> -
#
# --parallel is how many workers run at once, 1..4 (host-limits.md). Size it from
# scripts/capacity.sh, not from a remembered number.
#
# Exit codes: 0 when every worker finished cleanly; 1 when any worker did not. "Cleanly" is
# exit 0 AND the runner's own exitCode 0 (merged), or exit 10 AND runner exitCode 10 (handoff).
# A bare exit code is not enough: a failed install exits 10, and a worker with no result JSON exits 0. Per-issue detail is in summary.tsv.
# 2 is a usage error, raised before anything runs.
#
# Per issue: triage gate, path-claim gate, then worker.sh in its own clone. A refusal records
# a summary row and never spawns.
#
# Never forwarded, refused on argv: --restart, --merge, --auto-merge, --allow-unreviewed,
# --sandboxed, --allow-protected. See worker.sh and design.md §6–§7.
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
                 # One issue per line or whitespace-separated; # starts a comment.
                 while IFS= read -r line || [ -n "$line" ]; do
                   line="${line%%#*}"
                   for x in $line; do ISSUES+=("$x"); done
                 done <"$FROM_FILE" ;;
    --dry-run)   DRY_RUN=1 ;;
    --lean|--force-clone|--override-triage) EXTRA_WORKER_ARGS+=("$a") ;;
    -)           # stdin, lexed like --from-file
                 while IFS= read -r line || [ -n "$line" ]; do
                   line="${line%%#*}"
                   for x in $line; do ISSUES+=("$x"); done
                 done ;;
    ''|*[!0-9]*) die "unexpected argument '$a' (expected an issue number, '-', --repo, --parallel N, --forge-url, --timeout <min>, --from-file, --lean, --force-clone, --override-triage or --dry-run)" 2 ;;
    *)           ISSUES+=("$a") ;;
  esac
done

[ -z "$NEXT" ] || die "--$NEXT given with no value" 2
fanout_check_workers --parallel "$MAX_PARALLEL"
case "${FANOUT_SUMMARY_LOCK_WAIT:-60}" in
  ''|*[!0-9]*) die "FANOUT_SUMMARY_LOCK_WAIT must be a whole number of seconds, got '$FANOUT_SUMMARY_LOCK_WAIT'" 2 ;;
esac
fanout_resolve_repo
[ "${#ISSUES[@]}" -gt 0 ] || die "no issues given (pass numbers, '-', or --from-file <path>)" 2

# Reject a malformed queue. Silently dropping "1514x" would run a subset and report the whole
# queue as done. awk does the iteration: a host guard denies `for ... in` loops.
bad="$(printf '%s\n' "${ISSUES[@]}" | awk '/[^0-9]|^$/ { print; exit }')"
[ -z "$bad" ] || die "issue numbers must be digits only; got '$bad' (check the queue file)" 2

# Drop duplicates before any clone: two workers on one issue are refused by the pidfile only
# after clone and install, which is minutes of waste for a mistake in the queue.
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

mkdir -p "$RUNS_DIR"
SUMMARY="$FANOUT_ROOT/summary.tsv"
LOCK="$FANOUT_ROOT/.summary.lock"

# Header only when creating, so an appended row cannot be mistaken for the schema.
if [ ! -f "$SUMMARY" ]; then
  printf 'issue\tstatus\tcap\tfailedStep\texit\tcost_usd\tduration_s\tdispatches\tpr\tbranch\trun_dir\tfinished_at\n' >"$SUMMARY"
fi

append_row() {  # one row, under a mkdir lock so parallel writers cannot interleave
  local row="$1" waited=0
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

# The runner's own exitCode from its result JSON, or "-" when there is none.
runner_exit() {  # $1 = result json path
  "$(fanout_node)" -e '
    const fs = require("fs");
    try { const d = JSON.parse(fs.readFileSync(process.argv[1], "utf8"));
      console.log(d.exitCode === undefined ? "-" : String(d.exitCode));
    } catch (e) { console.log("-"); }
  ' "$1" 2>/dev/null || echo "-"
}

# One summary row per cycle, from the headless --json result. An unparseable result still
# yields a row that names the failure: a lost row is worse than an ugly one.
row_from_result() {  # $1 = issue, $2 = worker exit code, $3 = result json, $4 = run dir
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

run_one() {  # $1 = issue; returns 0 when the cycle finished cleanly, 1 otherwise
  local issue="$1" code row runner_code ok=0
  log "worker $issue starting"
  # shellcheck disable=SC2086
  "$SCRIPT_DIR/worker.sh" --repo "$FANOUT_REPO" --workers "$MAX_PARALLEL" \
    ${EXTRA_WORKER_ARGS[@]+"${EXTRA_WORKER_ARGS[@]}"} ${TIMEOUT_ARGS[@]+"${TIMEOUT_ARGS[@]}"} "$issue" \
    >"$RUNS_DIR/issue-$issue/worker.out" 2>&1
  code=$?
  mkdir -p "$RUNS_DIR/issue-$issue"
  row="$(row_from_result "$issue" "$code" "$RUNS_DIR/issue-$issue/result.json" "$RUNS_DIR/issue-$issue")"
  append_row "$row"
  runner_code="$(runner_exit "$RUNS_DIR/issue-$issue/result.json")"
  case "$code" in
    0)  [ "$runner_code" = 0 ] && ok=1 ;;
    10) [ "$runner_code" = 10 ] && ok=1 ;;
  esac
  log "worker $issue finished exit=$code runner=$runner_code"
  [ "$ok" = 1 ]
}

# ---------------------------------------------------------------------------
# dispatch — a bounded worker pool
# ---------------------------------------------------------------------------
# Issues are consumed in the order given, so the caller's argument order is the priority.
# A finished worker frees its slot at once; nothing waits for a whole batch.
log "queue: ${#ISSUES[@]} issues, parallel=$MAX_PARALLEL, repo=$FANOUT_REPO"

if [ "$DRY_RUN" = 1 ]; then
  # One worker.sh call per issue, output captured. The `while read` over a here-string avoids
  # a for-loop, which a host guard denies. ${ISSUES[*]} would join on a space, so the queue is
  # printed one issue per line instead.
  while IFS= read -r i; do
    [ -n "$i" ] || continue
    out="$("$SCRIPT_DIR/worker.sh" --repo "$FANOUT_REPO" --dry-run ${EXTRA_WORKER_ARGS[@]+"${EXTRA_WORKER_ARGS[@]}"} "$i" 2>&1)"
    rc=$?
    if [ "$rc" = 0 ]; then
      # A dry run skips the forge reads by default; say so on the line, or a CLOSED issue reads as runnable.
      note=""
      case "$out" in *"NOT CHECKED"*) note="  (forge closed/attention NOT CHECKED)" ;; esac
      echo "  $i  would run$note"
    else
      echo "  $i  refused (exit $rc): $(printf '%s' "$out" | tail -1)"
    fi
  done <<__QUEUE__
$(printf '%s\n' "${ISSUES[@]}")
__QUEUE__
  exit 0
fi

# Count live workers by PID in THIS shell. A `jobs -rp` inside a command substitution runs in a
# subshell that does not hold the parent's job table, so it reads 0 and --parallel is ignored.
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

# Collect each worker's status. Waiting on each pid, not a bare `wait`, keeps the status.
FAILED=0
j=0
while [ "$j" -lt "${#PIDS[@]}" ]; do
  if ! wait "${PIDS[$j]}"; then
    FAILED=$((FAILED + 1))
    warn "issue ${ISSUES[$j]} did not finish cleanly — see its row in $SUMMARY"
  fi
  j=$((j + 1))
done

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

[ "$FAILED" = 0 ] || exit 1
