#!/usr/bin/env bash
# capacity.sh — how many workers this host can run, from measurement. Prints; changes nothing.
#
#   capacity.sh [--repo <path>] [--observed]
#
# Derives N from FREE memory, not total: on macOS there is no cgroup, and totalmem advertises a
# machine that is already committed. --observed uses the measured peak RSS from sampled runs;
# without it the heap ceiling is used, and the output says which one was used. Budgets are
# printed from the same function worker.sh applies (fanout_budget_values), so they cannot drift.
set -uo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd -P)"
# shellcheck source=lib.sh
. "$SCRIPT_DIR/lib.sh"

OBSERVED=0
while [ "$#" -gt 0 ]; do
  case "$1" in
    --observed) OBSERVED=1 ;;
    --repo) FANOUT_REPO="${2:-$FANOUT_REPO}"; shift ;;
    *) : ;;
  esac
  shift
done
fanout_resolve_repo

LEAN="${FANOUT_LEAN:-0}"
case "${FANOUT_HEAP_MB:-}" in
  '') HEAP_MB=$([ "$LEAN" = 1 ] && echo 1536 || echo 3072) ;;
  *[!0-9]*|0) die "FANOUT_HEAP_MB must be a positive whole number of MB, got '$FANOUT_HEAP_MB'" 2 ;;
  *) HEAP_MB="$FANOUT_HEAP_MB" ;;
esac

# ---------------------------------------------------------------------------
# available memory
# ---------------------------------------------------------------------------
# Linux: MemAvailable. macOS: (free + speculative) pages. The page size is read from the system.
read_avail_kib() {
  if [ -r /proc/meminfo ]; then
    awk '/MemAvailable/ { print $2; found=1 } END { if (!found) print "" }' /proc/meminfo
    return
  fi
  if [ -n "$(type -P vm_stat 2>/dev/null || true)" ]; then
    local pagesize
    pagesize="$( (sysctl -n hw.pagesize 2>/dev/null || echo 4096) | tr -cd '0-9')"
    [ -n "$pagesize" ] || pagesize=4096
    vm_stat | awk -v ps="$pagesize" '
      /Pages free/        { gsub(/\./, "", $NF); free = $NF }
      /Pages speculative/ { gsub(/\./, "", $NF); spec = $NF }
      END { if (NR) printf "%d\n", (free + spec) * ps / 1024 }'
    return
  fi
  echo ""
}

AVAIL_KIB="$(read_avail_kib)"
case "$AVAIL_KIB" in
  ''|*[!0-9]*|0)
    echo "capacity: could not read available memory on this platform (got '${AVAIL_KIB:-nothing}')."
    echo "  Do not guess an N. Sample a real run with drive.sh --parallel 1, read"
    echo "  <repo>/tmp/fanout/runs/issue-<N>/rss.log, and size from that."
    exit 1 ;;
esac

# ---------------------------------------------------------------------------
# per-worker RSS
# ---------------------------------------------------------------------------
RSS_KIB=""
RSS_SOURCE="heap ceiling (not measured)"
if [ "$OBSERVED" = 1 ]; then
  RSS_KIB="$("$(fanout_node)" -e '
    const fs = require("fs"), path = require("path");
    const root = process.argv[1];
    let peak = 0, files = 0;
    const walk = (d) => {
      let ents; try { ents = fs.readdirSync(d, { withFileTypes: true }); } catch { return; }
      for (const e of ents) {
        const p = path.join(d, e.name);
        if (e.isDirectory()) { walk(p); continue; }
        if (e.name !== "rss.log") continue;
        files++;
        for (const line of fs.readFileSync(p, "utf8").split("\n")) {
          const m = line.match(/tree_rss_kib=(\d+)/);
          if (m) peak = Math.max(peak, parseInt(m[1], 10));
        }
      }
    };
    walk(root);
    if (files && peak) process.stdout.write(peak + "\t" + files);
  ' "$FANOUT_ROOT/runs" 2>/dev/null || true)"
  if [ -n "$RSS_KIB" ]; then
    RSS_FILES="${RSS_KIB#*$'\t'}"
    RSS_KIB="${RSS_KIB%%$'\t'*}"
    RSS_SOURCE="measured peak across $RSS_FILES sampled run(s)"
  else
    echo "capacity: --observed requested but no rss.log found under $FANOUT_ROOT/runs" >&2
    echo "          run one cycle at --parallel 1 first (lib-sampler.sh writes rss.log)." >&2
  fi
fi
if [ -z "$RSS_KIB" ]; then
  RSS_KIB=$(( HEAP_MB * 1024 ))
fi

# A rss.log from the old, host-wide sampler is 3x wrong on macOS. It lacks the pagesize field.
if [ "$OBSERVED" = 1 ] && [ "${RSS_SOURCE#measured}" != "$RSS_SOURCE" ]; then
  if ! grep -q 'pagesize=' "$(ls -1 "$FANOUT_ROOT/runs"/*/rss.log 2>/dev/null | head -1 || true)" 2>/dev/null; then
    echo "capacity: sampled rss.log predates the tree-scoped sampler (no pagesize= field); its numbers are host-wide." >&2
    echo "capacity:   Falling back to the heap ceiling. Re-run one cycle to produce a trustworthy sample." >&2
    RSS_KIB=$(( HEAP_MB * 1024 ))
    RSS_SOURCE="heap ceiling (sampled log is from an outdated sampler)"
  fi
fi

# ---------------------------------------------------------------------------
# recommendation
# ---------------------------------------------------------------------------
# A 20% reserve for the OS, verify subprocesses and interactive work, then N = usable / RSS,
# clamped to the documented ceiling (lib-budget.sh FANOUT_MAX_WORKERS).
RESERVE_KIB=$(( AVAIL_KIB / 5 ))
USABLE_KIB=$(( AVAIL_KIB - RESERVE_KIB ))
N=$(( USABLE_KIB / RSS_KIB ))
[ "$N" -ge 1 ] || N=1
[ "$N" -le "$FANOUT_MAX_WORKERS" ] || N="$FANOUT_MAX_WORKERS"

CPUS="$( (type -P sysctl >/dev/null 2>&1 && sysctl -n hw.ncpu 2>/dev/null) || nproc 2>/dev/null || echo '?' )"

echo "capacity"
echo "  host cpus          : $CPUS"
echo "  available memory   : $(( AVAIL_KIB / 1024 )) MiB  (kernel's own estimate, not totalmem)"
echo "  reserve (20%)      : $(( RESERVE_KIB / 1024 )) MiB kept for the OS, verify, and interactive work"
echo "  per-worker         : $(( RSS_KIB / 1024 )) MiB  [$RSS_SOURCE]"
echo "  recommended N      : $N  (ceiling $FANOUT_MAX_WORKERS)"
echo
echo "  budgets each worker would get at N=$N (applied by worker.sh, lib-budget.sh):"
read -r cap conc ws heap clamped <<__CAP__
$(fanout_budget_values "$N" "$LEAN" "${FANOUT_HEAP_MB:-}")
__CAP__
echo "    PI_ENSEMBLE_SPAWN_CAP=$cap  PI_ENSEMBLE_VERIFY_CONCURRENCY=$conc  PI_ENSEMBLE_MAX_WORKSTREAMS=$ws  heap=${heap}MB  clamped=$clamped"
echo
echo "  caveat: these are per-process bounds divided by hand (host-limits.md). Check the"
echo "  'budget:' line in each run's runner.log before trusting N."
