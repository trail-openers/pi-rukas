#!/usr/bin/env bash
# lib-claims.sh — live path-claims: the cross-cycle collision fence and its containment check.
# Sourced by lib.sh, never executed directly.
#
# ---------------------------------------------------------------------------
# live path-claims — the cross-cycle collision fence
# ---------------------------------------------------------------------------
# The driver records each running group's declared paths in
# <repo>/.pi/work-state/path-claims.json keyed by owning pid. Workers are separate clones,
# so there is no filesystem collision to fence — the shared resource is the FORGE: two
# cycles opening PRs over the same files is a guaranteed conflict and a wasted cycle.
#
# Claims are filtered on owner-pid ALIVENESS, not on age. A stale claim from a crashed
# cycle is not a collision; a live-but-old claim absolutely is. Never sweep these by age.
#
# FAIL-DIRECTION IS A DELIBERATE CHOICE. The file being ABSENT means no cycle is running,
# which is a genuine no-collision state and must not block a fleet. A file that EXISTS but
# cannot be read is a different thing: a truncated write, an unreadable permission, a node
# that went missing. Returning empty there would make every collision check silently pass,
# which is the exact shape of a gate that cannot fail. So a present-but-unreadable claims
# file is a hard error, and callers must not swallow it.
fanout_live_claims() {  # -> "path<TAB>issue<TAB>pid<TAB>age_s" per live claim
  local claims_file="${FANOUT_CLAIMS_SOURCE:-$FANOUT_REPO/.pi/work-state/path-claims.json}"
  [ -f "$claims_file" ] || return 0        # genuinely no claims file -> no live claims
  if [ ! -r "$claims_file" ]; then
    die "claims file exists but is not readable: $claims_file — refusing to assume 'no collisions'" 11
  fi
  # The node source below is wrapped in single quotes, so it must contain NO single quote at
  # all -- an apostrophe inside it closes the shell string early and the rest of the JS is then
  # executed as SHELL. Nasty class of bug: the script appears to work until a claims file is
  # malformed. So this JS never prints its own diagnostics; it only exits with a distinct code
  # and bash composes the message. Every other node eval in this file is quote-free for the
  # same reason, and that is a convention, not an accident.
  local out rc
  out="$(FANOUT_CLAIMS_FILE="$claims_file" "$(fanout_node)" --input-type=module -e '
    import fs from "node:fs";
    const path = process.env.FANOUT_CLAIMS_FILE;
    let text = null;
    try { text = fs.readFileSync(path, "utf8"); } catch { process.exitCode = 3; }
    let rows = null;
    if (text !== null) { try { rows = JSON.parse(text); } catch { process.exitCode = 4; } }
    if (process.exitCode === undefined && !Array.isArray(rows)) process.exitCode = 5;
    if (process.exitCode === undefined) {
      const now = Date.now();
      for (const r of rows) {
        if (!r || typeof r.issue !== "number" || !Array.isArray(r.paths)) continue;
        // Aliveness must be PROVED, not assumed. Two traps, both measured:
        //   - kill(-1, 0) SUCCEEDS (it signals every process the caller may signal), so a
        //     malformed claim carrying pid -1 -- or 0, the caller process group -- would read
        //     as permanently live and block its paths forever. Requiring a positive integer
        //     before any kill() is what keeps that from hanging the fleet.
        //   - an error other than ESRCH is unknown, not alive. Treating unknown as live
        //     fail-CLOSES the fence, which is the safe direction, but such a claim should be
        //     inspected rather than silently honoured forever.
        if (typeof r.pid === "number") {
          if (!Number.isInteger(r.pid) || r.pid < 1) continue;
          try { process.kill(r.pid, 0); } catch (e) { if (e.code === "ESRCH") continue; }
        }
        for (const p of r.paths) {
          process.stdout.write([String(p), r.issue, r.pid, Math.round((now - (r.startedAt || 0)) / 1000)].join("\t") + "\n");
        }
      }
    }
  ' 2>/dev/null)"
  rc=$?
  if [ "$rc" -ne 0 ]; then
    # Empty output is the common case (a file of claims, none of them live) and is NOT an
    # error -- only a nonzero exit is. Distinguishing the two is the whole point: returning
    # empty on a read failure would make every collision check silently pass, which is exactly
    # the shape of a gate that can never fail.
    case "$rc" in
      3) die "claims file could not be read: $claims_file -- refusing to assume no collisions" 11 ;;
      4) die "claims file is not valid JSON: $claims_file -- refusing to assume no collisions" 11 ;;
      5) die "claims file is not a JSON array: $claims_file -- refusing to assume no collisions" 11 ;;
      *) die "could not evaluate the claims file at $claims_file (exit $rc) -- refusing to assume no collisions. Inspect it directly, or point FANOUT_CLAIMS_SOURCE at a readable copy." 11 ;;
    esac
  fi
  printf '%s' "$out"
}

fanout_intersection() {  # $1 = claim lines, $2 = candidate files (comma or newline separated)
  # Prints a JSON array of candidate paths intersecting a live claim, annotated with owner.
  # Pass the FULL claim lines: the owner annotation lives in the tab-separated tail, so
  # piping through `cut -f1` first silently loses it and every refusal becomes unattributed.
  local claims="$1" files="$2"
  [ -n "$claims" ] || { echo "[]"; return 0; }
  [ -n "$files" ]  || { echo "[]"; return 0; }
  FANOUT_CLAIMS="$claims" FANOUT_FILES="$files" "$(fanout_node)" --input-type=module -e '
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

