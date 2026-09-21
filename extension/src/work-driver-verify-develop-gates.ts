/**
 * work-driver-verify-develop-gates — skip-ratchet + product-smoke gates.
 *
 * Extracted from work-driver-verify-develop.ts (AGENTS.md §12 file-size cap).
 * The consolidated-verify logic was also added here in #782, pushing the
 * original file past 500 lines; the two independent post-verify gates
 * (skip-ratchet, product-smoke) move to this module so the develop verify
 * stays within the cap.
 */

import fs from "node:fs/promises";
import path from "node:path";
import type { DriverContext } from "./work-driver-context.ts";
import {
  TEST_BLOCK_MARKERS,
  countMarkersInDiffLine,
  countSkipMarkersInDiffLine,
} from "./work-driver-skip-ratchet.ts";
import { readFirstConfigLine } from "./work-driver-verify-cmd.ts";
import {
  formatExecError,
  testDeleteTolerance,
  verifyTimeoutMs,
} from "./work-driver-verify-develop-helpers.ts";
import type { ExecFn } from "./worktree.ts";

/** PR338 — validate a git SHA before shell interpolation. */
const VALID_SHA_RE = /^[0-9a-f]{40}$/;
function isValidSha(s: string | undefined) {
  return typeof s === "string" && VALID_SHA_RE.test(s);
}

/**
 * The #672 skip-ratchet gate: counts net added/removed skip markers and
 * test-block markers in the per-worktree diff. Mutates `failures` in place.
 */
export async function runSkipRatchetGate(
  execFn: NonNullable<DriverContext["verifyExecFn"]>,
  repoRoot: string,
  baseSha: string | undefined,
  changedWorktrees: string[],
  failures: string[],
  notes: string[],
): Promise<void> {
  if (process.env.PI_ENSEMBLE_SKIP_RATCHET === "0") {
    notes.push("PI_ENSEMBLE_SKIP_RATCHET=0 — skip-ratchet gate disabled");
    return;
  }
  if (!baseSha) {
    notes.push(
      "baseSha unavailable — skip-ratchet compared working tree against HEAD only; committed changes not inspected",
    );
  }
  for (const cwd of changedWorktrees) {
    let diffContent = "";
    try {
      const baseRef = isValidSha(baseSha) ? baseSha : "HEAD";
      const { stdout } = await execFn(`git diff ${baseRef} -U0`, {
        cwd,
        timeout: verifyTimeoutMs(),
        maxBuffer: 64 * 1024 * 1024,
      });
      diffContent = stdout;
    } catch (err) {
      failures.push(
        `skip-ratchet: git diff failed in ${cwd} (${(err as Error).message?.slice(0, 100)}) — cannot inspect diff`,
      );
      continue;
    }
    if (!diffContent) continue;
    let netIncrease = 0;
    let netTestBlockDeletion = 0;
    for (const line of diffContent.split("\n")) {
      if (line.startsWith("+++") || line.startsWith("---")) continue;
      if (line.startsWith("+")) {
        netIncrease += countSkipMarkersInDiffLine(line);
        netTestBlockDeletion -= countMarkersInDiffLine(line, TEST_BLOCK_MARKERS);
      } else if (line.startsWith("-")) {
        netIncrease -= countSkipMarkersInDiffLine(line);
        netTestBlockDeletion += countMarkersInDiffLine(line, TEST_BLOCK_MARKERS);
      }
    }
    if (netIncrease > 0) {
      failures.push(
        `diff adds ${netIncrease} skipped-test marker(s) — a skipped test is a disabled gate`,
      );
    }
    const tolerance = testDeleteTolerance();
    if (netTestBlockDeletion > tolerance) {
      failures.push(
        `diff removes ${netTestBlockDeletion} test block(s), beyond the tolerance of ${tolerance} — a shrinking test suite is a disabled gate`,
      );
    }
  }
}

/**
 * The product-smoke gate (#451): runs `.pi/smoke-cmd` in the first changed
 * worktree. Mutates `failures` and `notes` in place.
 */
export async function runSmokeGate(
  execFn: NonNullable<DriverContext["verifyExecFn"]>,
  repoRoot: string,
  changedWorktrees: string[],
  failures: string[],
  notes: string[],
): Promise<void> {
  if (process.env.PI_ENSEMBLE_SMOKE === "0") {
    notes.push("PI_ENSEMBLE_SMOKE=0 — smoke gate disabled");
    return;
  }
  let smokeCmd: string | undefined;
  try {
    const smokeFile = path.join(repoRoot, ".pi", "smoke-cmd");
    const content = await fs.readFile(smokeFile, "utf8");
    smokeCmd = readFirstConfigLine(content);
  } catch {
    // No smoke-cmd file — not a failure, just a note
  }
  if (smokeCmd) {
    const smokeCwd = changedWorktrees[0] ?? repoRoot;
    try {
      await execFn(smokeCmd, {
        cwd: smokeCwd,
        timeout: verifyTimeoutMs(),
        maxBuffer: 4 * 1024 * 1024,
      });
    } catch (err) {
      const e = err as Error & { stdout?: string; stderr?: string; killed?: boolean };
      failures.push(
        formatExecError(
          e,
          `smoke: command \`${smokeCmd}\` exceeded its ${Math.round(verifyTimeoutMs() / 60000)}-min timeout in ${smokeCwd}`,
          `smoke: command \`${smokeCmd}\` failed in ${smokeCwd}`,
        ),
      );
    }
  } else {
    notes.push("no .pi/smoke-cmd — product smoke not run");
  }
}
