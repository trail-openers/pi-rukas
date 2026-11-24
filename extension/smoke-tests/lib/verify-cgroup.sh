#!/usr/bin/env bash
# host_cgroup_quota — the CPU count the cgroup quota allows, or empty when unlimited or
# unreadable. Sourced by verify-pool.sh; host_job_count only ever lowers its width by it.
#
# Read the way `extension/src/host-resources.ts` reads it: v2 `cpu.max` ("quota period", or
# "max") along /proc/self/cgroup up to the root, the tightest wins (a limit on a parent slice
# is the common container shape); else v1 `cpu.cfs_quota_us` / `cpu.cfs_period_us`.
# floor(quota/period), at least 1. VERIFY_CGROUP_ROOT is the filesystem root the /proc and
# /sys paths resolve under, so a test points it at a fixture tree.
host_cgroup_quota() {
  local root="${VERIFY_CGROUP_ROOT:-}" cg="${VERIFY_CGROUP_ROOT:-}/sys/fs/cgroup"
  local best="" own dir q p n
  _quota_lower() {
    case "$1" in '' | *[!0-9]* | 0) return 0 ;; esac
    case "$2" in '' | *[!0-9]* | 0) return 0 ;; esac
    n=$(($1 / $2))
    [ "$n" -lt 1 ] && n=1
    if [ -z "$best" ] || [ "$n" -lt "$best" ]; then best="$n"; fi
  }
  own="$(sed -n 's/^0:://p' "$root/proc/self/cgroup" 2>/dev/null | head -n 1)"
  if [ -n "$own" ] && [ -e "$cg/cgroup.controllers" ]; then
    dir="$cg$own"
    while :; do
      if read -r q p <"$dir/cpu.max" 2>/dev/null; then _quota_lower "$q" "$p"; fi
      case "$dir" in "$cg" | "$cg/") break ;; "$cg"*) dir="${dir%/*}" ;; *) break ;; esac
    done
  else
    for dir in "$cg/cpu" "$cg/cpu,cpuacct"; do
      if [ -r "$dir/cpu.cfs_period_us" ]; then
        read -r q <"$dir/cpu.cfs_quota_us" 2>/dev/null || q=""
        read -r p <"$dir/cpu.cfs_period_us" 2>/dev/null || p=""
        _quota_lower "$q" "$p"
        break
      fi
    done
  fi
  unset -f _quota_lower
  echo "$best"
}
