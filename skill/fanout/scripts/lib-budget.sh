#!/usr/bin/env bash
# lib-budget.sh — divided per-worker budgets, the worker-count limit and the preflight summary.
# Sourced by lib.sh, never executed directly.
#
# Every pi-rukas bound is per-process (PI_ENSEMBLE_SPAWN_CAP, the verify pool, and
# hostBudget()), so N workers multiply each limit by N. The division is done here, floored
# so a worker is never starved to zero. The floors and the N ceiling are in host-limits.md.

# Above this, the verify-concurrency and workstream floors take over and the division
# stops meaning anything. Measured numbers: host-limits.md.
FANOUT_MAX_WORKERS=4

# fanout_check_workers <flag> <n>: refuses a non-integer or an N above FANOUT_MAX_WORKERS.
# Called at argument parse, before any side effect.
fanout_check_workers() {
  case "$2" in ''|*[!0-9]*) die "$1 wants a positive integer, got '$2'" 2 ;; esac
  if [ "$2" -lt 1 ] || [ "$2" -gt "$FANOUT_MAX_WORKERS" ]; then
    die "$1 $2 is outside 1..$FANOUT_MAX_WORKERS. Above $FANOUT_MAX_WORKERS the verify and workstream floors become the budget, so the division no longer bounds the host (references/host-limits.md)." 2
  fi
}

# fanout_budget_values <divisor> <lean 0|1> [heap override]
# Pure: prints "cap conc ws heap clamped" and writes nothing. worker.sh and capacity.sh both
# read it, so the two cannot drift. clamped is "none" or a comma list of floored limits.
fanout_budget_values() {
  local total="$1" lean="$2" heap_ovr="${3:-}"
  local cap_d="${FANOUT_CAP_DEFAULT:-64}" conc_d="${FANOUT_CONC_DEFAULT:-4}" ws_d="${FANOUT_WS_DEFAULT:-6}"
  local cap conc ws heap clamped=""
  cap=$(( cap_d / total )); conc=$(( conc_d / total )); ws=$(( ws_d / total )); heap=3072
  # Lean changes only the workstream count and the heap; spawn cap and verify slots still divide.
  if [ "$lean" = 1 ]; then ws=1; heap=1536; fi
  if [ "$cap" -lt 4 ]; then cap=4; clamped="${clamped}spawn_cap,"; fi
  if [ "$conc" -lt 1 ]; then conc=1; clamped="${clamped}verify_conc,"; fi
  if [ "$ws" -lt 1 ]; then ws=1; clamped="${clamped}max_workstreams,"; fi
  [ -z "$heap_ovr" ] || heap="$heap_ovr"
  clamped="${clamped%,}"
  printf '%s %s %s %s %s\n' "$cap" "$conc" "$ws" "$heap" "${clamped:-none}"
}

# fanout_live_workers: how many worker lock directories under WORKERS_DIR have a live owner.
# The budget divides by max(requested N, this): two drive.sh runs on one host then split the
# host between them, not each give itself the whole machine. A snapshot at worker start, so a
# worker started before another keeps the larger share. See host-limits.md.
fanout_live_workers() {
  local d owner
  printf '%s\n' "$WORKERS_DIR"/issue-*.lock 2>/dev/null | while IFS= read -r d; do
    [ -d "$d" ] || continue
    owner="$(cat "$d/pid" 2>/dev/null || true)"
    if [ -n "$owner" ] && kill -0 "$owner" 2>/dev/null; then echo live; fi
  done | awk 'END { print NR + 0 }'
}

# fanout_apply_budget <divisor> <lean> [heap override]: exports the limits for the runner and
# prints the applied line. Prints; the caller redirects. Never pipe this: a pipeline runs the
# function in a subshell and its exports are lost, which is how the first version shipped
# budgets that never reached the runner.
fanout_apply_budget() {
  local total="$1" lean="$2" heap_ovr="${3:-}" cap conc ws heap clamped
  read -r cap conc ws heap clamped <<__BUDGET__
$(fanout_budget_values "$total" "$lean" "$heap_ovr")
__BUDGET__
  export PI_ENSEMBLE_SPAWN_CAP="${FANOUT_SPAWN_CAP:-$cap}"
  export PI_ENSEMBLE_VERIFY_CONCURRENCY="${FANOUT_VERIFY_CONCURRENCY:-$conc}"
  export PI_ENSEMBLE_MAX_WORKSTREAMS="${FANOUT_MAX_WORKSTREAMS:-$ws}"
  # Headless already runs one group at a time, so intra-process fan-out is what would
  # oversubscribe. Set it explicitly rather than rely on the default.
  export PI_ENSEMBLE_PARALLEL_WORK=0
  # Unattended: no forge comment, no label. The handoff body returns in the JSON result.
  export PI_ENSEMBLE_HANDOFF_CHANNEL=host
  # A heap cap turns an OOM into a loud exit 30 instead of a kernel-chosen victim.
  export NODE_OPTIONS="${FANOUT_NODE_OPTIONS:---max-old-space-size=$heap}"
  echo "budget: workers=$total lean=$lean spawn_cap=$PI_ENSEMBLE_SPAWN_CAP verify_conc=$PI_ENSEMBLE_VERIFY_CONCURRENCY max_workstreams=$PI_ENSEMBLE_MAX_WORKSTREAMS heap=${heap}MB"
  if [ "$clamped" != none ]; then
    echo "budget: CLAMPED at N=$total for: $clamped. Those limits cannot divide further, so the host carries N x the floor."
  fi
}
