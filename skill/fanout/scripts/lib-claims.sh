#!/usr/bin/env bash
# lib-claims.sh — the cross-cycle path fence: live claims, reservations, containment.
# Sourced by lib.sh, never executed directly.
#
# Two sources feed the fence. A running cycle records its declared paths in
# <clone>/.pi/work-state/path-claims.json, keyed by owner pid, and the fence reads the
# operator checkout and every worker clone. A worker that has not started its cycle yet
# has nothing in its clone, so it RESERVES its paths in WORKERS_DIR/reservations/ under a
# lock. The reservation has the claims-file shape, so the one reader covers both.
#
# Only claims whose owner pid is alive count. A stale claim is not a collision; a live-but-old
# claim is. Never filter by age.
#
# FAIL DIRECTION: an ABSENT claims file means no cycle is running there. A file that EXISTS
# but cannot be read, or is not valid JSON, is a hard error (exit 11). Returning empty would
# make every collision check pass.
#
# FANOUT_CLAIMS_SOURCE replaces the whole search (a test hook and an explicit override).
# FANOUT_CLAIMS_RELPATH is the claims path inside the repo and each clone (default unchanged).

FANOUT_HIT=""

fanout_claims_relpath() {  # -> the validated relative claims path
  local rel="${FANOUT_CLAIMS_RELPATH:-.pi/work-state/path-claims.json}"
  case "$rel" in
    /*|*..*) die "FANOUT_CLAIMS_RELPATH must be a relative path inside the clone with no '..': $rel" 2 ;;
  esac
  printf '%s' "$rel"
}

# Prints "path<TAB>issue<TAB>pid<TAB>age_s" for each live claim or reservation. $1 = own clone,
# excluded from the search (a cycle does not collide with its own leftover state).
fanout_live_claims() {
  local rel main workers="${WORKERS_DIR:-}" self="${1:-}" out rc
  rel="$(fanout_claims_relpath)"
  main="${FANOUT_CLAIMS_SOURCE:-$FANOUT_REPO/$rel}"
  [ -z "${FANOUT_CLAIMS_SOURCE:-}" ] || workers=""
  if [ -f "$main" ] && [ ! -r "$main" ]; then
    die "claims file exists but is not readable: $main — refusing to assume 'no collisions'" 11
  fi
  # The node source is single-quoted, so it contains NO single quote: one would end the shell
  # string early. It exits with a code and bash composes the message.
  out="$(FANOUT_CLAIMS_FILE="$main" FANOUT_WORKERS_DIR="$workers" FANOUT_SKIP_CLONE="$self" FANOUT_CLAIMS_REL="$rel" "$(fanout_node)" --input-type=module -e '
    import fs from "node:fs";
    import path from "node:path";
    const mainFile = process.env.FANOUT_CLAIMS_FILE || "";
    const workersDir = process.env.FANOUT_WORKERS_DIR || "";
    const rel = process.env.FANOUT_CLAIMS_REL || ".pi/work-state/path-claims.json";
    const skip = process.env.FANOUT_SKIP_CLONE ? path.resolve(process.env.FANOUT_SKIP_CLONE) : "";
    const files = [mainFile];
    let code = 0;
    if (workersDir) {
      let names = [];
      try { names = fs.readdirSync(workersDir); } catch (e) { if (e.code !== "ENOENT") code = 3; }
      for (const n of names) {
        const clone = path.join(workersDir, n, "repo");
        if (skip && path.resolve(clone) === skip) continue;
        files.push(path.join(clone, rel));
      }
      const resDir = path.join(workersDir, "reservations");
      let res = [];
      try { res = fs.readdirSync(resDir); } catch (e) { if (e.code !== "ENOENT") code = 3; }
      for (const n of res) if (n.endsWith(".json")) files.push(path.join(resDir, n));
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
        // A row we cannot read is a claim we cannot judge. Skipping it would pass a collision
        // for the same reason an unreadable file must not, so it is refused like a bad file.
        if (!r || typeof r !== "object" || typeof r.issue !== "number" || !Array.isArray(r.paths)) { code = 6; break; }
        // Aliveness must be PROVED. kill(-1, 0) and kill(0, 0) signal whole process groups and
        // succeed, so a claim with pid -1 or 0 would read as permanently live.
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
    case "$rc" in
      3) die "a claims file could not be read under $FANOUT_REPO or $WORKERS_DIR — refusing to assume no collisions" 11 ;;
      4) die "a claims file is not valid JSON — refusing to assume no collisions. Inspect the $rel files under the repo, worker clones and reservations." 11 ;;
      5) die "a claims file is not a JSON array — refusing to assume no collisions. Inspect the $rel files under the repo, worker clones and reservations." 11 ;;
      6) die "a claims row is malformed ('issue' must be a number, 'paths' an array) — refusing to assume no collisions. Inspect the $rel files under the repo, worker clones and reservations." 11 ;;
      *) die "could not evaluate the claims files (exit $rc) — refusing to assume no collisions. Point FANOUT_CLAIMS_SOURCE at a readable copy to inspect." 11 ;;
    esac
  fi
  printf '%s' "$out"
}

fanout_norm_list() {  # $1 = comma or newline separated entries -> normalised, one per line
  # Each entry goes through fanout_norm_path: an annotation ("src/a.ts (edits)") is stripped,
  # "(new)" and a bare "-" vanish. Comparing raw cells lets annotated paths slip past the fence.
  local f
  while IFS= read -r f; do
    f="$(fanout_norm_path "$f")"
    [ -n "$f" ] && printf '%s\n' "$f"
  done <<__NORM__
$(printf '%s\n' "$1" | tr ',' '\n')
__NORM__
  return 0
}

# fanout_intersection <claim lines> <candidate files>: prints a JSON array of candidates that
# intersect a claim, each annotated with its owner. Pass the FULL claim lines: the owner lives
# in the tab-separated tail. Exit 0 with "[]" when clear; a nonzero exit is a failure, which
# the caller must treat as "cannot tell", never as clear.
fanout_intersection() {
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
    // Containment counts both ways: a claimed directory covers the files under it, and a
    // claimed file covers its directory. A shared prefix is not containment.
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

# fanout_reserve_paths <issue> <own clone> <candidate files> <reserve 0|1>
# Checks the candidates against live claims AND other workers' reservations, and, when
# reserve=1, writes this worker's reservation. The lock makes check-and-write one step: without
# it two workers launched together both pass the check. Dry runs pass reserve=0.
# Returns: 0 clear (reserved if asked), 7 collision (FANOUT_HIT set), 11 claims unreadable,
#          13 reservation lock not obtained, 14 reservation not written.
fanout_reserve_paths() {
  local issue="$1" clone="$2" files="$3" reserve="$4" lock res tries=0 claims hit
  mkdir -p "$WORKERS_DIR/reservations" || return 14
  lock="$WORKERS_DIR/reserve.lock"
  res="$WORKERS_DIR/reservations/issue-$issue.json"
  while ! fanout_pidfile_acquire "$lock" "reserve issue-$issue"; do
    tries=$((tries + 1))
    [ "$tries" -le 300 ] || return 13
    sleep 0.1
  done
  rm -f -- "$res"
  claims="$(fanout_live_claims "$clone")" || { fanout_pidfile_release "$lock"; return 11; }
  hit="$(fanout_intersection "$claims" "$files")" || { fanout_pidfile_release "$lock"; return 11; }
  if [ "$hit" != "[]" ]; then
    FANOUT_HIT="$hit"
    fanout_pidfile_release "$lock"
    return 7
  fi
  if [ "$reserve" = 1 ]; then
    FANOUT_RES_PATHS="$files" FANOUT_ISSUE="$issue" FANOUT_PID="$$" "$(fanout_node)" -e '
      const paths = (process.env.FANOUT_RES_PATHS || "").split("\n").filter(Boolean);
      process.stdout.write(JSON.stringify([{ issue: Number(process.env.FANOUT_ISSUE), pid: Number(process.env.FANOUT_PID), startedAt: Date.now(), paths }]) + "\n");
    ' >"$res.tmp.$$" 2>/dev/null && mv -f "$res.tmp.$$" "$res" || { rm -f -- "$res.tmp.$$"; fanout_pidfile_release "$lock"; return 14; }
    FANOUT_RES_FILE="$res"
  fi
  fanout_pidfile_release "$lock"
  return 0
}
