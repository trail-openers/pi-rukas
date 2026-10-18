#!/usr/bin/env bash
# lib-claims.sh — live path-claims: the cross-cycle collision fence and its containment check.
# Sourced by lib.sh, never executed directly.
#
# ---------------------------------------------------------------------------
# live path-claims — the cross-cycle collision fence
# ---------------------------------------------------------------------------
# The driver records each running group's declared paths in
# <project>/.pi/work-state/path-claims.json keyed by owning pid. A headless cycle's project
# is ITS OWN CLONE, so a claim written by a fleet worker lands in
# $WORKERS_DIR/issue-<N>/repo/.pi/work-state/, not in the operator checkout. The fence
# therefore reads the operator checkout AND every worker clone. Two PRs over one file is a
# guaranteed conflict on the forge, which is the thing this fence exists to prevent.
#
# Claims are filtered on owner-pid ALIVENESS, not on age. A stale claim from a crashed
# cycle is not a collision; a live-but-old claim absolutely is. Never sweep these by age.
#
# FAIL-DIRECTION IS A DELIBERATE CHOICE. A claims file that is ABSENT means no cycle is
# running there, which is a genuine no-collision state. A file that EXISTS but cannot be
# read, or is not valid JSON, is a hard error: returning empty would make every collision
# check silently pass, which is the exact shape of a gate that cannot fail.
#
# FANOUT_CLAIMS_SOURCE, when set, replaces the whole search (it is a test hook and an
# explicit override), so it reads that one file and no worker clones.
#
# $1 (optional) is the calling worker's OWN clone. It is excluded from the search: a cycle
# for this issue has not started yet, so any claim in its clone is a leftover from an earlier
# run, and the fence must not refuse a worker over its own previous state.
fanout_live_claims() {  # [$1 = own clone to skip] -> "path<TAB>issue<TAB>pid<TAB>age_s" per live claim
  local main="${FANOUT_CLAIMS_SOURCE:-$FANOUT_REPO/.pi/work-state/path-claims.json}"
  local workers="${WORKERS_DIR:-}"
  local self="${1:-}"
  [ -z "${FANOUT_CLAIMS_SOURCE:-}" ] || workers=""
  if [ -f "$main" ] && [ ! -r "$main" ]; then
    die "claims file exists but is not readable: $main — refusing to assume 'no collisions'" 11
  fi
  # The node source below is wrapped in single quotes, so it must contain NO single quote at
  # all: an apostrophe closes the shell string early and the rest of the JS runs as SHELL.
  # The JS never prints diagnostics; it exits with a distinct code and bash composes the
  # message. Every node eval in this file follows the same convention.
  local out rc
  out="$(FANOUT_CLAIMS_FILE="$main" FANOUT_WORKERS_DIR="$workers" FANOUT_SKIP_CLONE="$self" "$(fanout_node)" --input-type=module -e '
    import fs from "node:fs";
    import path from "node:path";
    const mainFile = process.env.FANOUT_CLAIMS_FILE || "";
    const workersDir = process.env.FANOUT_WORKERS_DIR || "";
    const skip = process.env.FANOUT_SKIP_CLONE ? path.resolve(process.env.FANOUT_SKIP_CLONE) : "";
    const files = [mainFile];
    let code = 0;
    if (workersDir) {
      let names = [];
      try { names = fs.readdirSync(workersDir); } catch (e) { if (e.code !== "ENOENT") code = 3; }
      for (const n of names) {
        const clone = path.join(workersDir, n, "repo");
        if (skip && path.resolve(clone) === skip) continue;
        files.push(path.join(clone, ".pi", "work-state", "path-claims.json"));
      }
    }
    const now = Date.now();
    const out = [];
    for (const file of files) {
      if (code) break;
      let text = null;
      try { text = fs.readFileSync(file, "utf8"); } catch (e) { if (e.code !== "ENOENT") code = 3; continue; }
      let rows = null;
      try { rows = JSON.parse(text); } catch { code = 4; continue; }
      if (!Array.isArray(rows)) { code = 5; continue; }
      for (const r of rows) {
        if (!r || typeof r.issue !== "number" || !Array.isArray(r.paths)) continue;
        // Aliveness must be PROVED. kill(-1, 0) and kill(0, 0) succeed (they signal whole
        // process groups), so a claim with pid -1 or 0 would read as permanently live. Only a
        // positive integer pid is probed; anything else cannot be proved alive and is skipped.
        if (!Number.isInteger(r.pid) || r.pid < 1) continue;
        let alive = true;
        try { process.kill(r.pid, 0); } catch (e) { if (e.code === "ESRCH") alive = false; }
        if (!alive) continue;
        for (const p of r.paths) {
          out.push([String(p), r.issue, r.pid, Math.round((now - (r.startedAt || 0)) / 1000)].join("\t"));
        }
      }
    }
    if (code) process.exitCode = code;
    else process.stdout.write(out.map((l) => l + "\n").join(""));
  ' 2>/dev/null)"
  rc=$?
  if [ "$rc" -ne 0 ]; then
    # Empty output with exit 0 is the common case and is NOT an error. Only a nonzero exit is.
    case "$rc" in
      3) die "a claims file could not be read under $FANOUT_REPO or $WORKERS_DIR — refusing to assume no collisions" 11 ;;
      4) die "a claims file is not valid JSON — refusing to assume no collisions. Inspect the .pi/work-state/path-claims.json files under the repo and worker clones." 11 ;;
      5) die "a claims file is not a JSON array — refusing to assume no collisions. Inspect the .pi/work-state/path-claims.json files under the repo and worker clones." 11 ;;
      *) die "could not evaluate the claims files (exit $rc) — refusing to assume no collisions. Inspect them directly, or point FANOUT_CLAIMS_SOURCE at a readable copy." 11 ;;
    esac
  fi
  printf '%s' "$out"
}

fanout_norm_list() {  # $1 = comma or newline separated entries -> normalised, one per line
  # Each entry goes through fanout_norm_path: a planner annotation ("src/a.ts (edits)") is
  # stripped, a "(new)" entry and a bare "-" (what gen-triage writes for a blank cell) vanish.
  # Comparing raw cells is how an annotated path slipped past the fence unchecked.
  local f
  while IFS= read -r f; do
    f="$(fanout_norm_path "$f")"
    [ -n "$f" ] && printf '%s\n' "$f"
  done <<__NORM__
$(printf '%s\n' "$1" | tr ',' '\n')
__NORM__
  return 0
}

fanout_intersection() {  # $1 = claim lines, $2 = candidate files (comma or newline separated)
  # Prints a JSON array of candidate paths intersecting a live claim, annotated with owner.
  # Pass the FULL claim lines: the owner annotation lives in the tab-separated tail, so
  # piping through `cut -f1` first silently loses it and every refusal becomes unattributed.
  # Both sides are normalised with fanout_norm_path before the containment test.
  local claims="$1" files="$2" norm_claims="" line p
  [ -n "$claims" ] || { echo "[]"; return 0; }
  [ -n "$files" ]  || { echo "[]"; return 0; }
  while IFS= read -r line; do
    [ -n "$line" ] || continue
    p="$(fanout_norm_path "${line%%$'\t'*}")"
    [ -n "$p" ] || continue
    norm_claims="$norm_claims$p"$'\t'"${line#*$'\t'}"$'\n'
  done <<__CLAIMS__
$claims
__CLAIMS__
  files="$(fanout_norm_list "$files")"
  [ -n "$files" ] || { echo "[]"; return 0; }
  FANOUT_CLAIMS="$norm_claims" FANOUT_FILES="$files" "$(fanout_node)" --input-type=module -e '
    const claims = new Set();
    const owner = new Map();
    for (const line of (process.env.FANOUT_CLAIMS || "").split("\n").filter(Boolean)) {
      const [p, issue, pid] = line.split("\t");
      if (!p) continue;
      claims.add(p);
      if (!owner.has(p)) owner.set(p, issue === undefined ? "a live cycle" : "#" + issue + "@pid" + pid);
    }
    // Containment counts both ways: claiming a dir claims the files under it, and
    // claiming a file claims the dir. A shared *prefix* is not containment, so
    // src/a.ts and src/b.ts stay independent.
    const want = (process.env.FANOUT_FILES || "").split(/[,\n]/).map((s) => s.trim().replace(/^\.\//, "")).filter(Boolean);
    const hit = [];
    for (const w of want) {
      for (const c of claims) {
        if (c === w || c.startsWith(w + "/") || w.startsWith(c + "/")) {
          hit.push(w + " (claimed by " + owner.get(c) + ")");
          break;
        }
      }
    }
    process.stdout.write(JSON.stringify([...new Set(hit)]) + "\n");
  '
}
