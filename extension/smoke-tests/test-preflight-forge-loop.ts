#!/usr/bin/env bun
/**
 * Forge pseudo-entry in install.sh's REQUIRED_CLIS loop — issue #967.
 *
 * install.sh's REQUIRED_CLIS carries the pseudo-entry `forge:…`: no binary
 * named `forge` exists, the real check is the dedicated gh-OR-glab dual check
 * right after the loop (#608). The generic `for entry … check_cmd` loop must
 * SKIP the pseudo-entry (by name) so "forge" never lands in missing[] on a
 * host that has gh or glab. The fix lives in install.sh itself (task-a); this
 * test drives the EXTRACTED loop body with a stubbed PATH and proves the
 * contract in both directions.
 *
 * Method (same shape as test-pi-min-version.ts): the `check_cmd` function,
 * the REQUIRED_CLIS array, and the `for entry in … done` loop body are
 * pulled from install.sh by regex and driven in a fresh `bash -c` with a
 * stubbed PATH. The installer itself is never sourced or executed, so no
 * install side effects run, and the test is fully offline (it never calls
 * the real `gh` / `glab`).
 *
 * The stubbed PATH is built in a temp dir:
 *   - positive cases: a stub `gh`, a stub `glab`, or both → "forge" must
 *     NOT appear in missing[] (the operator-reported false positive).
 *   - negative case: neither `gh` nor `glab` → missing[] holds NO forge
 *     entry (the loop skips the pseudo-entry by name), and the dedicated
 *     "!! Neither gh nor glab found…" block is the single operator-visible
 *     forge warning.
 *   - canary: an unpatched loop body (no skip) + empty PATH → "forge"
 *     MUST appear exactly once in missing[]. This proves the gate CAN
 *     fail — a regression that re-adds the generic probe (or removes the
 *     skip) would ship with all other green gates.
 *
 * install.sh stays ≤500 lines (enforced by test-file-size-limit.ts); this
 * test adds no lines to install.sh.
 */

import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

const REPO_ROOT = path.resolve(import.meta.dirname, "..", "..");
const INSTALL_SH = path.join(REPO_ROOT, "install.sh");

let exit = 0;
function assert(cond: boolean, msg: string) {
  if (cond) console.log(`✓ ${msg}`);
  else {
    console.error(`✗ ${msg}`);
    exit = 1;
  }
}

const installSrc = readFileSync(INSTALL_SH, "utf8");

/** The `check_cmd` function from install.sh, verbatim. */
function extractCheckCmd(): string {
  const m = installSrc.match(/^check_cmd\(\) \{[\s\S]*?^\}\n/m);
  if (!m) throw new Error("install.sh: check_cmd() not found — removed or renamed");
  return m[0];
}

/** The REQUIRED_CLIS array literal, verbatim (multi-line). */
function extractRequiredClis(): string {
  const m = installSrc.match(/^REQUIRED_CLIS=\([\s\S]*?^\)\n/m);
  if (!m) throw new Error("install.sh: REQUIRED_CLIS=(…) not found — removed or renamed");
  return m[0];
}

/**
 * The `for entry in "${REQUIRED_CLIS[@]}"` loop body, verbatim — from the
 * `for` line through the matching `done`. This is the post-fix shape that
 * carries the skip logic; the test drives it as-is.
 *
 * Coupling to install.sh's exact loop and hint text is DELIBERATE: like
 * test-pi-min-version.ts and test-oo-min-version.ts, this test extracts by
 * regex, so a reformat of the loop (or its hint string) must update the
 * test. The behavioural assertions (gh, glab, both, neither, canary) are
 * the real regression gate.
 */
function extractLoopBody(): string {
  const m = installSrc.match(/^for entry in "\$\{REQUIRED_CLIS\[@\]\}"; do[\s\S]*?^done\n/m);
  if (!m) throw new Error("install.sh: for entry in REQUIRED_CLIS loop not found");
  return m[0];
}

/**
 * Names the harness itself needs on PATH to execute (beyond the tools under
 * test). These are symlinked from the real system into the stub dir so the
 * child runs hermetic: PATH is ONLY the stub dir, and every tool it can see
 * is either a stub or a deliberate symlink.
 */
const HARNESS_TOOLS = ["bash", "sh", "printf"];

/**
 * Run the extracted loop in a fresh bash with a fully hermetic PATH.
 *
 * @param loopBody  the for-loop to execute (post-fix shape, or unpatched
 *                  canary variant).
 * @param stubBinaries  names of stub executables to create in a temp dir
 *                      and put on PATH (the ONLY tools the child sees are
 *                      these stubs, `gh`/`glab` when stubbed, and the
 *                      HARNESS_TOOLS symlinks).
 * @returns the lines of the rendered "Missing dependencies" block (the
 *          `   - <entry>` lines, minus the leading dash), or an empty array
 *          if the block was not printed (missing[] was empty).
 */
function runLoop(loopBody: string, stubBinaries: string[]): string[] {
  // One parent temp dir per run: stubDir (the stub PATH) and homeDir (the
  // child's HOME) live inside it, so a single finally removes everything.
  let parent: string | undefined;
  try {
    parent = mkdtempSync(path.join(tmpdir(), "preflight-forge-loop-"));
    const stubDir = path.join(parent, "bin");
    const homeDir = path.join(parent, "home");
    mkdirSync(stubDir);
    mkdirSync(homeDir);
    for (const bin of stubBinaries) {
      const p = path.join(stubDir, bin);
      // A minimal executable script — `command -v` only needs +x on PATH.
      writeFileSync(p, "#!/bin/sh\nexit 0\n", { mode: 0o755 });
    }
    // Symlink the harness's own coreutils into the stub dir (they resolve via
    // /usr/bin on this host, so they do NOT defeat the "neither gh nor glab"
    // negative case). Skipped if the binary is absent from the real system.
    for (const tool of HARNESS_TOOLS) {
      try {
        const real = execFileSync("bash", ["-c", `command -v ${tool} || true`], {
          encoding: "utf8",
          timeout: 5_000,
          env: {
            PATH: `${stubDir}:/usr/local/bin:/usr/bin:/bin`,
            HOME: "/tmp",
            LANG: "C",
            LC_ALL: "C",
          },
        }).trim();
        if (real) symlinkSync(real, path.join(stubDir, tool));
      } catch {
        // absent on this host — the harness only needs what it finds
      }
    }
    const checkCmd = extractCheckCmd();
    const clis = extractRequiredClis();
    // The harness: declare missing[], load check_cmd and REQUIRED_CLIS
    // verbatim from install.sh, run the loop, then print the missing[]
    // entries one per line so the TypeScript side can parse them. Bash
    // `${...}` variables are escaped as `\${...}` in the template literal
    // below.
    // install-preflight.sh defines MIN_PI_VERSION / MIN_OO_VERSION; the
    // harness only needs the array literal to parse, so stub them.
    const code = [
      "set -u",
      "missing=()",
      "MIN_PI_VERSION=0.0.0",
      "MIN_OO_VERSION=0.0.0",
      checkCmd,
      clis,
      loopBody,
      "if [ ${#missing[@]} -gt 0 ]; then",
      'for m in "${missing[@]}"; do printf \'%s\n\' "$m"; done',
      "fi",
      "exit 0",
      "",
    ].join("\n");
    const out = execFileSync("bash", ["-c", code], {
      encoding: "utf8",
      timeout: 5_000,
      // Hermetic env: nothing from process.env (no BASH_ENV, no GLOBIGNORE,
      // no inherited state). Only the stub dir on PATH, a temp HOME, and a
      // fixed locale. This test is stricter than test-pi-min-version.ts /
      // test-oo-min-version.ts on purpose: the stub PATH must be the ONLY
      // tool source, because an inherited BASH_ENV (or similar) could let
      // the child reach the real gh/glab.
      env: {
        PATH: stubDir,
        HOME: homeDir,
        LANG: "C",
        LC_ALL: "C",
      },
    }).trim();
    if (!out) return [];
    return out.split("\n").filter((l) => l.trim() !== "");
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    assert(
      false,
      `bash harness crashed (${stubBinaries.length ? stubBinaries.join(",") : "no stubs"}): ${msg}`,
    );
    return ["<harness crashed>"];
  } finally {
    if (parent) rmSync(parent, { recursive: true, force: true });
  }
}

// ---------------------------------------------- extraction integrity
//
// Deliberate coupling: these source-shape assertions match install.sh's
// exact text (like test-pi-min-version.ts / test-oo-min-version.ts, this
// test extracts by regex — a reformat of the loop or hint text must
// update the test). The behavioural assertions below (gh, glab, both,
// neither, canary) are the real regression gate.

{
  const checkCmd = extractCheckCmd();
  assert(checkCmd.includes("command -v"), "extracted check_cmd() calls command -v");
  assert(checkCmd.includes("missing+="), "extracted check_cmd() appends to missing[]");

  const clis = extractRequiredClis();
  assert(clis.includes('"forge:'), "REQUIRED_CLIS retains the `forge` pseudo-entry (#967)");
  assert(clis.includes('"pi:'), "REQUIRED_CLIS retains the pi entry");
  assert(clis.includes('"git:'), "REQUIRED_CLIS retains the git entry");
  assert(clis.includes('"jq:'), "REQUIRED_CLIS retains the jq entry");
  assert(clis.includes('"vipune:'), "REQUIRED_CLIS retains the vipune entry");
  assert(clis.includes('"oo:'), "REQUIRED_CLIS retains the oo entry");
  assert(clis.includes('"parallel-cli:'), "REQUIRED_CLIS retains the parallel-cli entry");
  assert(clis.includes('"ctx7:'), "REQUIRED_CLIS retains the ctx7 entry");
}

// ---------------------------------------------- the loop skips forge by name

{
  const loop = extractLoopBody();
  // The skip must be name-scoped to exactly "forge" — a case statement on
  // the entry's name. A hint-keyword match (e.g. on "checked below") or a
  // blanket continue is the wrong shape: it would silently skip a future
  // real CLI.
  const nameScoped = /case[^\n]*in[\s\S]*?forge\)[\s\S]*?esac/.test(loop);
  assert(
    nameScoped,
    "the loop skip is name-scoped to exactly 'forge' (case on the entry name), not a hint-keyword heuristic",
  );
  // The hint-keyword "checked below" must NOT be the skip criterion.
  const hintKeyed = /checked[\s_]?below[\s\S]{0,80}(continue|skip)/.test(loop);
  assert(!hintKeyed, "the loop does NOT skip on the 'checked below' hint keyword");
}

// ---------------------------------------------- positive case: gh on PATH

{
  const missing = runLoop(extractLoopBody(), ["gh"]);
  assert(
    !missing.some((l) => l.startsWith("forge —")),
    "gh on PATH: 'forge' NOT in missing[] (no false positive)",
  );
}

// ---------------------------------------------- positive case: glab only

{
  const missing = runLoop(extractLoopBody(), ["glab"]);
  assert(
    !missing.some((l) => l.startsWith("forge —")),
    "glab on PATH (no gh): 'forge' NOT in missing[]",
  );
}

// ---------------------------------------------- positive case: both on PATH

{
  const missing = runLoop(extractLoopBody(), ["gh", "glab"]);
  assert(
    !missing.some((l) => l.startsWith("forge —")),
    "both gh and glab on PATH: 'forge' NOT in missing[]",
  );
}

// ---------------------------------------------- negative case: neither on PATH

{
  // With the patched loop the pseudo-entry is skipped, so missing[] holds
  // NO forge entry even when neither binary is present — the dedicated
  // "!! Neither gh nor glab found…" block is the single operator-visible
  // forge warning (the canary below proves the generic loop would add a
  // second one).
  const missing = runLoop(extractLoopBody(), []);
  assert(
    !missing.some((l) => l.startsWith("forge —")),
    "neither gh nor glab: 'forge' NOT in missing[] (the dedicated dual check is the single source)",
  );
}

// ---------------------------------------------- canary: unpatched loop

{
  // The unpatched loop (the pre-fix shape) must REPORT "forge" when neither
  // gh nor glab is present — proving the gate can fail and the fix is what
  // suppresses it. If this assert passes, the test is a tautology; if the
  // real loop body has been changed to also not-report forge with an empty
  // PATH, the canary shape is stale and the test is wrong.
  // Build by concatenation to keep `${entry%%:*}` and `${entry#*:}` from
  // being interpolated by the TypeScript template literal.
  const unpatchedLoop = 'for entry in "${REQUIRED_CLIS[@]}"; do\n';
  const unpatchedBody = '  check_cmd "${entry%%:*}" "${entry#*:}"\ndone\n';
  const missing = runLoop(unpatchedLoop + unpatchedBody, []);
  const forgeLines = missing.filter((l) => l.startsWith("forge —"));
  assert(
    forgeLines.length === 1,
    `canary: unpatched loop + no gh/glab → exactly ONE 'forge — …' in missing[] (got ${forgeLines.length})`,
  );
  // The hint must match the README wording (the drift gate pins it).
  // The explicit undefined check is the assertion under test (canary — the
  // hint line must exist, not merely be non-matching); a typeof guard is not
  // an optional-chain candidate, so no lint suppression is needed.
  const first = forgeLines[0];
  assert(
    typeof first === "string" &&
      first.includes("brew install gh (GitHub) or brew install --no-quarantine glab (GitLab)"),
    `canary: the forge hint matches the README dual-install wording (got "${first ?? "none"}")`,
  );
}

// ---------------------------------------------- no double-report

{
  // The dedicated dual check (gh OR glab) is the single operator-visible
  // forge warning: it is warn-only, and with the patched loop the generic
  // loop contributes nothing to missing[] for forge — so with neither
  // binary present the operator sees exactly one warning (the dual check's
  // echo), and with any forge binary present they see none. Verify the dual
  // check is still present in install.sh (warn-only, not appending to
  // missing[]).
  const dual = installSrc.match(
    /if ! command -v gh[^\n]*&&[^\n]*! command -v glab[\s\S]*?^\s*fi\n/m,
  );
  assert(dual !== null, "install.sh retains the dedicated gh-OR-glab dual check (#608)");
  if (dual) {
    assert(
      !dual[0].includes("missing+="),
      "the dual check warns only — it does NOT append to missing[] (no double-report)",
    );
    assert(
      dual[0].includes("Neither gh nor glab found"),
      "the dual check prints the operator-visible warning",
    );
  }
}

console.log(exit === 0 ? "\nAll preflight-forge-loop checks passed." : "\nFAILED");
process.exit(exit);
