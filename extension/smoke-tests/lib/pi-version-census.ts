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
    .map((f) => path.join(repoRoot, f));
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
    // The dev pins (lockstep) + this gate's own literals + its fixture.
    // (The @earendil-works/pi marker puts the 1.x pins in a claim context; the other 1.x
    // literals in the file — 1.2.20 bun engines floor, 1.9.0 biome — are not Pi claims.)
    "extension/package.json": ["1.0.0"],
    // …plus this gate's own canary literals (0.82.1 stale-verified canary, 0.84.3 floor canary,
    // 0.83.9/0.85.0/0.84.5 numeric-matrix canaries, 0.83.0 --exclude-tools canary, 0.86.0
    // gitignore-listing canary, 0.87.0 undeclared-literal canary — all in canary strings, all
    // must stay visible to the census).
    // (Plus the 1.0.1/1.1.0/1.2.20 post-#959 claim-context canaries.)
    // Self-census: if this file grows a new canary literal, the list must
    // grow here too — the gate fails otherwise (a self-census that cannot
    // see its own declaration is the "census that passes by silence"
    // failure mode this gate exists to stop).
    "test-pi-version-drift.ts": ["0.84.4", "0.99.0", "0.82.0", "0.82.1", "0.84.3", "0.83.9", "0.85.0", "0.84.5", "0.83.0", "0.86.0", "0.87.0", "1.0.0", "1.0.1", "1.1.0", "1.2.20"],
    // The preflight floor (MIN_PI_VERSION + the #578 provenance/bug-window notes).
    // (Post-#959: the 0.84.4/0.84.3 bug-window literals + the 1.0.0 floor.)
    "install-preflight.sh": ["1.0.0", "0.84.4", "0.84.3"],
    // The install floor on the install line. (Post-#959: the 1.0.0 pi pin; the 1.2.20 bun
    // floor sits within 20 chars of the "pi-coding-agent@1.0.0" marker — claim-adjacent,
    // declared here, not a Pi claim, but the window is what it is.)
    "README.md": ["1.0.0", "1.2.20"],
    // Floor pin (×2: install line + pi-mcp-adapter comment) + #578 bug-window note.
    // (Pre-#959: the 0.84.4 install-line pin + the 0.84.3 adapter note; post-#959: the 1.0.0
    // install-line pin + the §4 pi-1.0 reference — the 0.84.4/0.84.3 bug-window literals
    // moved to the install-preflight.sh row above.)
    "Dockerfile": ["1.0.0"],
    // test-pi-min-version.ts fakes pi --version output (at-floor / bug-window / matrix).
    // (Post-#959: the 0.8x.y literals are the pre-#959 bug-window cases, the 1.x the
    // current-floor matrix + numeric-compare cases.)
    "test-pi-min-version.ts": ["1.0.0", "1.0.1", "1.1.0", "0.84.4", "0.84.3", "0.83.9", "0.85.0"],
    // The existing prerequisite-drift gate + its EXCEPTIONS pin + canary comments.
    // (Post-#959: 0.8x.y — the historical claim space, detected unconditionally; its
    // 1.x literals sit in "Pi 1.0.0's" claim-context strings within the 20-char window.
    // The 0.84.4/0.84.3 fixtures moved to the prerequisite-drift fixtures themselves,
    // exercised by that gate.)
    "test-prerequisite-drift.ts": ["0.84.4", "0.84.3", "1.0.0", "1.1.0"],
    // The Dockerfile-pins gate's canary comment line.
    // (Post-#959: "Pi 1.0.0's native MCP" + the fixture "@earendil-works/pi-coding-agent@1.0.0" pin.)
    "test-dockerfile-pins.ts": ["1.0.0"],
    // The live shape test's "Pi 1.0.0's native MCP" doc comments.
    "test-pi-shape-live.ts": ["1.0.0"],
    // The --exclude-tools rationale (Pi >= 0.83.0).
    // (Post-#959: + the CHILD_ARGS_BASE doc comment "Under Pi 1.0.0's semantics" +
    // A comment referencing the pinned pi-tui d.ts (0.82.0 pre-#959; the row's 1.0.0 is the §4 reference).) The pinned pi-tui d.ts
    // comment (0.82.0 pre-#959; the row's 1.0.0 is the §4 reference).
    "spawn-support.ts": ["0.83.0", "1.0.0"],
    // The pi-mcp-adapter-skip doc comment ("On Pi 1.0.0, an installed
    // extension...").
    "spawn-extension-forward.ts": ["1.0.0"],
    // The census-table home moved here by #959 (the gate file stays under
    // the 500-line cap by moving code, not compressing comments). This file
    // carries the same canary literals as test-pi-version-drift.ts's own
    // row, so its superset is the same list — a literal added to one table
    // must be added to both or the census fails (self-census of the census).
    "pi-version-census.ts": ["0.84.4", "0.99.0", "0.82.0", "0.82.1", "0.84.3", "0.83.9", "0.85.0", "0.84.5", "0.83.0", "0.86.0", "0.87.0", "1.0.0", "1.0.1", "1.1.0", "1.2.20"],
    // bun.lock resolves the declared pins (lockfile, not a claim — the gate
    // reads the DECLARED pin from package.json; the lock is listed so a
    // lockstep bump is visible here, not silent). The @earendil-works/pi
    // package names put the 1.0.0 pins in a Pi-claim context; the typebox
    // 1.3.27 on the pi-agent-core line is within the 20-char window of the
    // marker (declared here, not a Pi claim — the window is what it is).
    "bun.lock": ["1.0.0", "1.3.27"],
    // The embargo override comment's "the Pi 1.0.0 pin" (claim context via
    // the "Pi " marker; the 1.2.20 bun floor is outside the window).
    "bunfig.toml": ["1.0.0"],
    // The Pi 1.0.0 native-MCP wiring comments + step-6 banner ("Pi 1.0.0's
    // native MCP" is a claim; the 1.2.20 bun floor is not).
    "install.sh": ["1.0.0"],
    // The sandbox wrapper's native-MCP bind-mount comment names the Pi 1.0.0
    // path (issue #959); the header + mount comment both reference it.
    "bin/pi-rukas": ["1.0.0"],
    // No claim: bump examples are relative (~0.XY.Z → ~0.XY.(Z+1)).
    // No current-claim literals (historical 0.7x.y only — out of census scope).
    // Post-#959: 1.0.0 is the native-MCP walkthrough's pi claim; the other 1.x literals
    // are bun/npm floors, not Pi claims.
    "CONTRIBUTING.md": ["1.0.0"],
    // The census-table home moved here by #959 (the gate file stays under
    // the 500-line cap by moving code, not compressing comments). This file
    // carries the same canary literals as test-pi-version-drift.ts's own
    // row, so its superset is the same list — a literal added to one table
    // must be added to both or the census fails (self-census of the census).
    "pi-version-census.ts": ["0.84.4", "0.99.0", "0.82.0", "0.82.1", "0.84.3", "0.83.9", "0.85.0", "0.84.5", "0.83.0", "0.86.0", "0.87.0", "1.0.0", "1.0.1", "1.1.0", "1.2.20"],
  };
}
