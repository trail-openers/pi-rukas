#!/usr/bin/env bun
/**
 * Pi version-claim gate support module (#787 / #959).
 *
 * Two pieces moved here VERBATIM from test-pi-version-drift.ts so the gate
 * file could stay under the 500-line cap while restoring its comments
 * (move code, not compress comments — the comments are load-bearing):
 *   - gitRepoFiles — the git ls-files census listing (doc comment intact);
 *   - siteCensus — the full site-census data table (per-site comments
 *     intact, literals updated for the #959 1.x bump).
 *
 * Intentionally NOT named test-*.ts — verify-loop.sh runs only test-*.ts as
 * tests (same shape as glab-arch-check.ts and handoff-provenance-fixtures.ts);
 * coverage comes through test-pi-version-drift.ts, which imports both.
 */

import path from "node:path";
import { execFileSync } from "node:child_process";
import fs from "node:fs";

/**
 * Every file git considers part of the repo: tracked (`--cached`) plus
 * untracked-but-not-ignored (`--others --exclude-standard`). A plain
 * readdir walk reads git-IGNORED runtime debris (outputs/ research
 * artifacts, .pi-subagents/ transcripts) that carries historical Pi version
 * literals — at repoRoot that debris makes the census fail on every
 * consolidated verify even though the debris is not part of the repo. One
 * ls-files call gives exactly the tracked+untracked-not-ignored set; the
 * caller's explicit exclusions (fixtures, etc.) apply on top.
 *
 * Fails loudly (throws) if git is unavailable — a silent fallback to a
 * directory walk would re-admit the ignored debris the gate exists to skip.
 */
export function gitRepoFiles(repoRoot: string): string[] {
  // -c core.quotepath=false makes the raw-path output explicit: -z already
  // emits unquoted bytes (verified empirically — quoting only applies to the
  // non -z textual path), but the flag guards a config-level surprise in the
  // one place where a quoted path would corrupt the census listing silently.
  const out = execFileSync("git", ["-c", "core.quotepath=false", "-C", repoRoot, "ls-files", "-z", "--cached", "--others", "--exclude-standard"], {
    encoding: "utf8",
    maxBuffer: 64 * 1024 * 1024,
  });
  return out
    .split("\0")
    .filter((f) => f.length > 0)
    .map((f) => path.join(repoRoot, f))
    .filter((f) => {
      try {
        return fs.statSync(f).isFile();
      } catch {
        return false; // deleted-but-not-committed — not part of the working tree
      }
    });
}

/**
 * The full site census: every repo file that can carry a Pi version claim,
 * with the expected superset of bare 0.8x.y literals it may hold. Adding a
 * new version-claim site means adding a row here — the gate fails otherwise
 * (a census that only knows a subset of the tree is worse than none).
 */
export function siteCensus(verifiedV: string): Record<string, string[]> {
  const v = [verifiedV];
  return {
    // The maintained line (version + its date's digits).
    "docs/pi-compatibility.md": v,
    // The `pi install` verification claim. (Post-#959: the native-MCP
    // walkthrough's pi-1.0 claim.)
    "docs/mcp.md": [...v, "1.0.0"],
    // The sandbox bind-mount table + troubleshooting entries that name the
    // post-#959 config path ("Pi 1.0.0's native MCP").
    "docs/sandbox.md": [...v, "1.0.0"],
    "docs/troubleshooting.md": [...v, "1.0.0"],
    // The audit code-search policy's config-path reference ("Pi 1.0.0's
    // native MCP config") + the user-global native MCP config path.
    "docs/audit-code-search-policy.md": [...v, "1.0.0"],
    // The AGENTS.md § 4 restatement (+ the date's digits). (Post-#959: the
    // "Last verified against pi" 1.0.0 claim line; the §5 embargo comment's
    // 1.2.20 bun floor is not a claim.)
    "AGENTS.md": v,
    // The dev pins (lockstep; the @earendil-works/pi marker puts the 1.x
    // pins in a Pi-claim context). The 1.2.20 bun engines floor and the
    // 1.9.0 biome floor are 1.x literals with no Pi-claim context, so the
    // detector ignores them — and this row must not declare them.
    "extension/package.json": ["1.0.0"],
    // …plus this gate's own canary literals (0.82.1 stale-verified canary,
    // 0.84.3 floor canary, 0.83.9/0.85.0/0.84.5 numeric-matrix canaries,
    // 0.83.0 --exclude-tools canary, 0.86.0 gitignore-listing canary, 0.87.0
    // undeclared-literal canary — all in canary strings, all must stay
    // visible to the census; the 1.0.1/1.1.0 canaries sit in the
    // "pi-coding-agent"/"@earendil-works" claim-context strings, and the
    // 1.2.20 bun-floor canary string carries no Pi marker, so it is prose
    // to the detector and is not declared here — the 0.99.0 co-pin canary
    // is likewise a prose literal).
    // Self-census: if this file grows a new canary literal, the list must
    // grow here too — the gate fails otherwise (a self-census that cannot
    // see its own declaration is the "census that passes by silence"
    // failure mode this gate exists to stop).
    "test-pi-version-drift.ts": ["0.84.4", "0.82.0", "0.87.0", "0.84.5", "0.82.1", "0.86.0", "1.0.0", "1.0.1", "1.1.0"],
    // The preflight floor (MIN_PI_VERSION = 1.0.0) plus the 0.84.4
    // bug-window literal in the §4 provenance comment (the 0.84.3 in the §5
    // embargo comment is 30+ chars from every marker, so it is not a
    // declared claim).
    "install-preflight.sh": ["1.0.0", "0.84.4"],
    // The install floor on the install line ("Bun ≥ 1.2.20 and Node ≥ 22
    // (Pi's own requirement)") — the 1.2.20 bun floor sits within 20 chars
    // of the "Pi's" marker, detected as claim-adjacent, declared here.
    "README.md": ["1.0.0", "1.2.20"],
    // The floor pin on the install line.
    ".devcontainer/Dockerfile": ["1.0.0"],
    // test-pi-min-version.ts fakes pi --version output (at-floor / bug-window / matrix).
    // (Post-#959: the 0.8x.y literals are the pre-#959 bug-window cases, the 1.x the
    // current-floor matrix + numeric-compare cases.)
    "test-pi-min-version.ts": ["0.84.4", "0.84.3", "0.83.9", "0.85.0"],
    // The existing prerequisite-drift gate + its EXCEPTIONS pin + canary
    // comments. 0.8x.y is detected unconditionally; the 1.x literals sit in
    // "Pi 1.0.0's" claim-context strings within the 20-char window. The
    // 0.84.4/0.84.3 fixtures moved to the prerequisite-drift fixtures
    // themselves, exercised by that gate.
    "test-prerequisite-drift.ts": ["0.84.4", "0.84.3", "1.0.0", "1.1.0"],
    // The Dockerfile-pins gate's canary comment line ("Pi 1.0.0's native
    // MCP") + the fixture "@earendil-works/pi-coding-agent@1.0.0" pin.
    "test-dockerfile-pins.ts": ["1.0.0"],
    // The --exclude-tools rationale (0.83.0, detected unconditionally); the
    // "Under Pi 1.0.0's semantics" childArgsBase() doc comment is 23 chars
    // past the Pi marker, so the 1.0.0 there is prose, not a detected claim.
    "spawn-support.ts": ["0.83.0"],
    // The pi-mcp-adapter-skip doc comment ("On Pi 1.0.0, an installed
    // extension...") sits 22 chars past the "Pi" marker — prose, not a
    // detected claim (the 1.x claim-context canaries live in the
    // version-drift gate, not here).
    "spawn-extension-forward.ts": [],
    // bun.lock resolves the declared pins (lockfile, not a claim — the gate
    // reads the DECLARED pin from package.json; the lock is listed so a
    // lockstep bump is visible here, not silent). The @earendil-works/pi
    // package names put the 1.0.0 pins in a Pi-claim context; the typebox
    // 1.3.27 sits outside the 20-char window of the marker, so it is not
    // declared here.
    "extension/bun.lock": ["1.0.0"],
    // No claim: bump examples are relative (~0.XY.Z → ~0.XY.(Z+1)); the
    // "Pi 1.0.0's native MCP" prose is 23 chars past the marker, so nothing
    // in the file is a detected claim. (Other 1.x literals — bun, npm and
    // release-lease floors — are not Pi claims.)
    "CONTRIBUTING.md": [],
    // The census-table home moved here by #959 (the gate file stays under
    // the 500-line cap by moving code, not compressing comments). The
    // "@earendil-works/pi" marker in its own table literal puts the 1.x
    // row literals in a claim context; the 0.8x.y entries are the canaries
    // copied verbatim from the gate's own row (self-census of the census).
    // Declared literals are exactly the detected set — the gate's census
    // block proves declared ⊆ detected, so a literal the detector cannot
    // see is a gate failure, not a silent entry.
    "pi-version-census.ts": ["0.82.1", "0.84.3", "0.83.9", "0.85.0", "0.84.5", "0.83.0", "0.86.0", "0.87.0", "0.84.4", "0.82.0", "1.0.0"],
  };
}
