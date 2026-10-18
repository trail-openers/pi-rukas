#!/usr/bin/env bash
# lib-sampler.sh — per-worker resource sampling: process-tree RSS and host-available memory,
# read by capacity.sh. Sourced by lib.sh, never executed directly.
#
# ---------------------------------------------------------------------------
# per-worker resource sampling
# ---------------------------------------------------------------------------
# The point of the fleet is throughput *within the host's limits*, so the limit is
# measured, not assumed. pi-rukas's own budget reads os.totalmem() and will happily
# advertise capacity the machine cannot start. We sample the worker tree's RSS and the
# host's available memory at a fixed cadence into <rundir>/rss.log, which is what
# capacity.sh then derives N from.
#
# Invariants:
#   - The page size is read from the system, never assumed: a wrong constant scales every N.
#   - RSS is attributed to the worker's own process tree, rooted at a pid. A host-wide sum
#     counts other people's processes.
#   - Both numbers are labelled with how they were obtained, so the denominator is auditable.
fanout_sampler_start() {  # $1 = pidfile dir, $2 = output file, $3 = root pid (default: this shell)
  local pidfile="$1" out="$2" root="${3:-$$}" sp
  case "$root" in
    ''|*[!0-9]*|0) warn "sampler not started: root pid '$root' is not a positive integer"; return 1 ;;
  esac
  : >"$out"
  sp="$(cat "$pidfile/sampler" 2>/dev/null || true)"
  [ -z "$sp" ] || kill "$sp" >/dev/null 2>&1 || true
  (
    # Resolve the page size once, from the system. Never assume it: it differs by platform
    # and by kernel build, and a wrong constant silently scales every derived N.
    local pagesize
    pagesize="$( (sysctl -n hw.pagesize 2>/dev/null || echo 4096) | tr -cd '0-9')"
    [ -n "$pagesize" ] || pagesize=4096
    while [ -d "$pidfile" ]; do
      {
        printf '%s ' "$(date -u +%Y-%m-%dT%H:%M:%SZ)"
        printf 'pagesize=%s ' "$pagesize"
        # Descendant set of $root, computed in one ps pass and closed over in awk. Includes
        # the root itself. Anything not reachable from $root is somebody else's workload and
        # must not be attributed to this worker.
        ps -eo pid,ppid,rss,comm 2>/dev/null | awk -v root="$root" '
          { pid[$1] = 1; ppid[$1] = $2; rss[$1] = $3; if ($1 == root) have_root = 1 }
          END {
            if (!have_root) { printf "tree_rss_kib=0 tree_procs=0 root_gone=1 "; exit }
            # BFS down from root. Guard against a cycle in malformed ps output.
            n = 1; frontier[1] = root; seen[root] = 1
            total = 0; procs = 0
            for (i = 1; i <= n; i++) {
              p = frontier[i]
              if (p in rss) { total += rss[p]; procs++ }
              for (q in ppid) if (ppid[q] == p && !(q in seen)) { seen[q] = 1; n++; frontier[n] = q }
            }
            printf "tree_rss_kib=%d tree_procs=%d ", total, procs
          }'
        # Host-available, in KiB, from the platform's own accounting.
        if [ -r /proc/meminfo ]; then
          awk '/MemAvailable/ { printf "host_avail_kib=%d ", $2 }' /proc/meminfo 2>/dev/null
        else
          # macOS: (free + speculative) pages x pagesize. The compressor is reported so a
          # host that looks free but is spending all its CPU compressing is visible.
          vm_stat 2>/dev/null | awk -v ps="$pagesize" '
            /Pages free/          { gsub(/\./, "", $NF); free   = $NF }
            /Pages speculative/   { gsub(/\./, "", $NF); spec   = $NF }
            /Pages occupied by compressor/ { gsub(/\./, "", $NF); compr = $NF }
            END {
              printf "host_avail_kib=%d host_compr_kib=%d ", (free + spec) * ps / 1024, compr * ps / 1024
            }'
        fi
        printf '\n'
      } >>"$out" 2>/dev/null || true
      sleep 20
    done
  ) >/dev/null 2>&1 &
  echo "$!" >"$pidfile/sampler"
}

fanout_sampler_stop() {  # $1 = pidfile dir
  local pidfile="$1" sp
  sp="$(cat "$pidfile/sampler" 2>/dev/null || true)"
  [ -n "$sp" ] && kill "$sp" >/dev/null 2>&1 || true
}

