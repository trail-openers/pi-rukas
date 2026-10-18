#!/usr/bin/env bash
# capacity.sh — how many workers can this host actually run, from measurement.
#
#   capacity.sh [--repo <path>] [--observed]
#
# Prints observed available memory, per-worker RSS if a run has been sampled, a
# recommended N, and the divided budgets that N implies.
#
# WHY THIS EXISTS RATHER THAN A HARDCODED DEFAULT
# pi-rukas's hostBudget() reads os.totalmem() and availableParallelism(). On macOS there is
# no cgroup, so nothing corrects for pressure. Observed on a 24 GiB host: ~954 MiB
# free+speculative with NOTHING running and a 4 GiB compressor. Any N derived from total
# memory is therefore wrong in the dangerous direction — it oversubscribes, and the OOM
# killer's victim may be the user's own interactive cycle rather than a worker.
#
# So: derive from FREE bytes, and prefer MEASURED worker RSS over the heap ceiling. The
# --max-old-space-size value is a cap, not a steady-state, and treating it as the
# allocation will understate how many workers fit.
#
# --observed reads the sampled rss.log from real runs and uses measured peak RSS.
#
# NOTE ON COMMAND SHAPES (affects your own invocations too, not just this file):
# a mode-independent bash guard on some hosts denies `for VAR in ...; do ...; done` loops
# outright, so any documented command using one is unrunnable by an agent. This script and
# its siblings therefore use `while read`, globs, `find | while`, and `awk`. If you add a
# loop here, use `while`, and prefer delegating iteration to awk/find/node.
set -uo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd -P)"
# shellcheck source=lib.sh
. "$SCRIPT_DIR/lib.sh"

OBSERVED=0
# `while read` rather than a `for ... in` loop: see the note above.
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
HEAP_MB="${FANOUT_HEAP_MB:-$([ "$LEAN" = 1 ] && echo 1536 || echo 3072)}"

# ---------------------------------------------------------------------------
# available memory
# ---------------------------------------------------------------------------
# Linux: MemAvailable is the kernel's own estimate of what a new process can get.
# macOS: no MemAvailable; (free + speculative) pages is the usable figure, and the
# compressor is reported separately because a host can look "fine" while spending all
# its CPU compressing. 4096-byte pages.
read_avail_kib() {
  if [ -r /proc/meminfo ]; then
    awk '/MemAvailable/ { print $2; found=1 } END { if (!found) print "" }' /proc/meminfo
    return
  fi
  if which vm_stat >/dev/null 2>&1; then
    # The page size is read from the system, never assumed. It was hardcoded to 4096 here
    # once, on a host reporting 16384, which made available 4x too small and recommended a
    # 4x too small N. That is the exact class of silent error this file exists to avoid.
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
if [ -z "${AVAIL_KIB:-}" ]; then
  echo "capacity: could not read available memory on this platform."
  echo "  Do not guess an N. Sample a real run with drive.sh at --parallel 1, read"
  echo "  <repo>/tmp/fanout/runs/issue-<N>/rss.log, and size from that."
  exit 1
fi

# ---------------------------------------------------------------------------
# per-worker RSS
# ---------------------------------------------------------------------------
# Measured peak from sampled runs beats the heap ceiling. Fall back to the ceiling only
# when nothing has been sampled yet, and SAY which one was used — a recommendation built
# on a ceiling is much less trustworthy than one built on a sample, and the operator
# needs to know which they are acting on.
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
    echo "          run one cycle at --parallel 1 first (lib.sh's sampler writes rss.log)." >&2
  fi
fi
if [ -z "${RSS_KIB:-}" ]; then
  RSS_KIB=$(( HEAP_MB * 1024 ))
fi

# Guard against the two ways a stale rss.log silently corrupts N. A log written by the OLD
# sampler summed every bun/node on the host (inflating per-worker cost ~3x) and used a wrong
# page size (deflating available 4x). Those logs are still on disk. Rather than trust a
# plausible number, require the fields the current sampler emits and say when they are absent.
if [ "$OBSERVED" = 1 ] && [ -n "${RSS_SOURCE:-}" ] && [ "${RSS_SOURCE#measured}" != "$RSS_SOURCE" ]; then
  if ! grep -q 'pagesize=' "$(ls -1 "$FANOUT_ROOT/runs"/*/rss.log 2>/dev/null | head -1 || true)" 2>/dev/null; then
    echo "capacity: sampled rss.log predates the tree-scoped sampler (no pagesize= field)." >&2
    echo "capacity:   Its numbers are host-wide and 4x-wrong on macOS. Falling back to the heap" >&2
    echo "capacity:   ceiling. Re-run one cycle to produce a trustworthy sample." >&2
    RSS_KIB=$(( HEAP_MB * 1024 ))
    RSS_SOURCE="heap ceiling (sampled log is from an outdated sampler)"
  fi
fi

# ---------------------------------------------------------------------------
# recommendation
# ---------------------------------------------------------------------------
# Keep a reserve: the host needs headroom for the OS, the verify subprocesses, and
# whatever the user is doing interactively. 20% of available is the floor we refuse to
# eat into. Deriving N from the post-reserve pool is the whole point.
RESERVE_KIB=$(( AVAIL_KIB / 5 ))
USABLE_KIB=$(( AVAIL_KIB - RESERVE_KIB ))
N=$(( USABLE_KIB / RSS_KIB ))
[ "$N" -ge 1 ] || N=1
[ "$N" -le 16 ] || N=16   # a ceiling on the recommendation, not on what you may force

CPUS="$( (which sysctl >/dev/null 2>&1 && sysctl -n hw.ncpu 2>/dev/null) || nproc 2>/dev/null || echo '?' )"

echo "capacity"
echo "  host cpus          : $CPUS"
echo "  available memory   : $(( AVAIL_KIB / 1024 )) MiB  (kernel's own estimate, not totalmem)"
echo "  reserve (20%)      : $(( RESERVE_KIB / 1024 )) MiB kept for the OS, verify, and interactive work"
echo "  per-worker         : $(( RSS_KIB / 1024 )) MiB  [$RSS_SOURCE]"
echo "  recommended N      : $N"
echo
echo "  budgets each worker would get at N=$N:"
# Print, do not apply — this script must not mutate the caller's environment.
total="$N"
cap=$(( 64 / total )); conc=$(( 4 / total )); ws=$(( 6 / total )); heap=3072
# Lean changes only workstreams and heap; spawn cap and verify slots still divide by N (as lib-budget.sh).
if [ "$LEAN" = 1 ]; then ws=1; heap=1536; fi
[ "$cap" -ge 4 ] || cap=4; [ "$conc" -ge 1 ] || conc=1; [ "$ws" -ge 1 ] || ws=1
echo "    PI_ENSEMBLE_SPAWN_CAP=$cap  PI_ENSEMBLE_VERIFY_CONCURRENCY=$conc  PI_ENSEMBLE_MAX_WORKSTREAMS=$ws  heap=${heap}MB"
echo
echo "  caveat: these are PER-PROCESS bounds divided by hand. pi-rukas has no cross-process"
echo "  coordinator, so forgetting the division silently gives every worker the full machine"
echo "  (design.md §4). Check the 'budget:' line in each run's runner.log before trusting N."
