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
import { type CommentEvidence, formatLostComments } from "./comment-evidence.ts";
import { checkComments, commentRetentionEnabled } from "./comment-retention.ts";
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
 * The #948 comment-loss check, as evidence for the reviewers (#1040). A removed
 * comment line whose trimmed text does not reappear under `paths` at the
 * workstream's head is "lost" (the developer deleted it to shrink the file):
 * listed in a NOTE (with the added comment lines of its hunk as context) for the
 * adversarial reviewer and the six-lens review to judge. It never fails the
 * develop step and cannot throw. Runs PER-WORKTREE against each workstream's
 * effective base, mirroring `runFalsilyGreenCheck`. A git error or an unreadable
 * tree reads `NOT CHECKED (<reason>)` (infra errors are never failures).
 * `PI_ENSEMBLE_COMMENT_RETENTION=0` disables the check and emits a note instead.
 * Returns one entry per outcome that needs a human eye (a lost comment or a
 * NOT CHECKED); the note and the structured result travel together.
 */
export async function collectCommentEvidence(
  execFn: NonNullable<DriverContext["verifyExecFn"]>,
  effectiveBaseFor: (wsId: string) => string | undefined,
  worktrees: Map<string, string>,
  paths: string[],
): Promise<CommentEvidence[]> {
  const out: CommentEvidence[] = [];
  if (!commentRetentionEnabled()) {
    const reason = "PI_ENSEMBLE_COMMENT_RETENTION=0";
    out.push({ note: `comment-retention: NOT CHECKED (${reason})`, result: { ok: false, reason } });
    return out;
  }
  for (const [id, cwd] of worktrees) {
    const baseRef = effectiveBaseFor(id);
    if (!baseRef) {
      const reason = `no base ref for workstream ${id}`;
      out.push({
        note: `comment-retention: NOT CHECKED (${reason}) in ${cwd}`,
        result: { ok: false, reason },
      });
      continue;
    }
    const res = await checkComments(execFn, cwd, baseRef, "HEAD", paths, verifyTimeoutMs());
    if (!res.ok) {
      out.push({ note: `comment-retention: NOT CHECKED (${res.reason}) in ${cwd}`, result: res });
    } else if (res.lost.length > 0) {
      out.push({ note: formatLostComments(res), result: res });
    }
  }
  return out;
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
      const e = err as Error & {
        stdout?: string;
        stderr?: string;
        killed?: boolean;
      };
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
