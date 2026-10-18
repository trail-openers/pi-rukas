#!/usr/bin/env bash
# lib-budget.sh — divided per-worker budgets and the preflight summary written to each run log.
# Sourced by lib.sh, never executed directly.
#
# ---------------------------------------------------------------------------
# divided budgets
# ---------------------------------------------------------------------------
# Everything below is divided because pi-rukas holds these as PER-PROCESS module state
# with no cross-process coordinator: PI_ENSEMBLE_SPAWN_CAP (default 64) and the verify
# slot pool are module-scope `let active`, and hostBudget() is memoised per process from
# os.totalmem(). N workers therefore multiply every limit by N. Divide by N, floored so a
# worker is never starved into a livelock.
#
# Two traps that make this worse than it looks:
#   PI_ENSEMBLE_SPAWN_CAP=0 DISABLES the semaphore (runs unguarded) — it does not mean
#     "zero children", so an operator setting 0 to cap things removes the cap entirely.
#   Setting PI_ENSEMBLE_PARALLEL_GROUPS or PI_ENSEMBLE_MAX_WORKSTREAMS explicitly
#     SHORT-CIRCUITS the host budget for that limit, reintroducing the unbounded shape.
fanout_apply_budget() {  # $1 = workers-total, $2 = lean (0|1), $3 = heap override (may be empty)
  local total="$1" lean="$2" heap_ovr="${3:-}"
  case "$total" in ''|*[!0-9]*) total=1 ;; esac
  [ "$total" -ge 1 ] || total=1

  # The divisors are the UNDIVIDED defaults pi-rukas would use for a single cycle, taken
  # from references/host-limits.md: spawn cap 64, verify pool ~4 on a 10-core host, and
  # max workstreams 6. They must be comfortably larger than N x the floor, or the floors
  # below silently become the answer and every worker gets the same budget at N=2 and N=8
  # -- which looks correct in the logs and oversubscribes the host exactly as badly as
  # forgetting the division entirely. That is a silent failure, so print the raw numbers
  # and let the operator see a clamp rather than infer one.
  local CAP_DEFAULT="${FANOUT_CAP_DEFAULT:-64}"
  local CONC_DEFAULT="${FANOUT_CONC_DEFAULT:-4}"
  local WS_DEFAULT="${FANOUT_WS_DEFAULT:-6}"

  if [ "$lean" = 1 ]; then
    # One workstream, one verify slot: ~1 bun at a time. Lets N go higher on a tight host.
    cap=16; conc=1; ws=1; heap=1536
  else
    cap=$(( CAP_DEFAULT / total )); conc=$(( CONC_DEFAULT / total )); ws=$(( WS_DEFAULT / total )); heap=3072
  fi
  # Floors keep a worker from livelocking (zero slots = it waits forever). A clamp is a
  # signal that N is above what these budgets can carry, so it is reported, not hidden.
  clamped=""
  [ "$cap"  -ge 4 ] || { cap=4;  clamped="${clamped} spawn_cap"; }
  [ "$conc" -ge 1 ] || { conc=1; clamped="${clamped} verify_conc"; }
  [ "$ws"   -ge 1 ] || { ws=1;   clamped="${clamped} max_workstreams"; }
  [ -z "$heap_ovr" ] || heap="$heap_ovr"

  export PI_ENSEMBLE_SPAWN_CAP="${FANOUT_SPAWN_CAP:-$cap}"
  export PI_ENSEMBLE_VERIFY_CONCURRENCY="${FANOUT_VERIFY_CONCURRENCY:-$conc}"
  export PI_ENSEMBLE_MAX_WORKSTREAMS="${FANOUT_MAX_WORKSTREAMS:-$ws}"
  # Headless already runs one group at a time (headless/run.ts), so intra-process
  # workstream fan-out is what would oversubscribe. Say it explicitly rather than rely
  # on the default.
  export PI_ENSEMBLE_PARALLEL_WORK=0
  # Unattended: post no handoff comment and apply no label. The body comes back in the
  # JSON result and the driver decides what the operator sees. 60 parked cycles posting
  # comments to the forge is spam, not signal.
  export PI_ENSEMBLE_HANDOFF_CHANNEL=host
  # A heap cap makes an OOM a loud crash (exit 30 in the result) rather than letting the
  # kernel choose a victim, which may be the user's own interactive cycle.
  export NODE_OPTIONS="${FANOUT_NODE_OPTIONS:---max-old-space-size=$heap}"
  # Make the applied numbers visible in runner.log; a worker that silently kept the
  # defaults is indistinguishable from a correctly divided one. This line is the single
  # artifact that distinguishes "the fleet is misconfigured" from "pi-rukas did this".
  echo "budget: workers=$total lean=$lean spawn_cap=$PI_ENSEMBLE_SPAWN_CAP verify_conc=$PI_ENSEMBLE_VERIFY_CONCURRENCY max_workstreams=$PI_ENSEMBLE_MAX_WORKSTREAMS heap=${heap}MB"
  if [ -n "$clamped" ]; then
    echo "budget: CLAMPED at N=$total for:$clamped -- those limits cannot divide further."
    echo "budget:   Each worker still gets a whole verify slot / workstream, so the host"
    echo "budget:   carries N x those. Lower N, or raise FANOUT_CONC_DEFAULT / FANOUT_WS_DEFAULT"
    echo "budget:   only if you have confirmed the host can hold N x the raised value."
  fi
}

# ---------------------------------------------------------------------------
# preflight summary
# ---------------------------------------------------------------------------
# One place that states, in the run's own log, what the fleet believes about the host. When
# N workers misbehave, the first question is always "did the division apply" and the answer
# should already be on disk rather than reconstructed from four env vars.
fanout_log_preflight() {  # $1 = issue, $2 = extra note (may be empty)
  local issue="$1" note="${2:-}"
  {
    printf 'preflight: issue=%s\n' "$issue"
    printf 'preflight: repo=%s\n' "${FANOUT_REPO:-unset}"
    printf 'preflight: root=%s\n' "${FANOUT_ROOT:-unset}"
    printf 'preflight: forge=%s\n' "${FANOUT_FORGE_URL:-derived-from-origin}"
    printf 'preflight: spawn_cap=%s verify_conc=%s max_workstreams=%s parallel_work=%s handoff=%s\n' \
      "${PI_ENSEMBLE_SPAWN_CAP:-unset}" "${PI_ENSEMBLE_VERIFY_CONCURRENCY:-unset}" \
      "${PI_ENSEMBLE_MAX_WORKSTREAMS:-unset}" "${PI_ENSEMBLE_PARALLEL_WORK:-unset}" \
      "${PI_ENSEMBLE_HANDOFF_CHANNEL:-unset}"
    printf 'preflight: node_options=%s\n' "${NODE_OPTIONS:-unset}"
    printf 'preflight: stale_gate=%s attention_gate=%s forge_check=%s\n' \
      "${FANOUT_SKIP_STALE:-0}" "${FANOUT_ALLOW_ATTENTION:-0}" "${FANOUT_FORGE_CHECK:-1}"
    [ -z "$note" ] || printf 'preflight: note: %s\n' "$note"
  }
}
