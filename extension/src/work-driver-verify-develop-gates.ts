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
import { withVerifySlot } from "./host-resources.ts";
import type { DriverContext } from "./work-driver-context.ts";
import { continuePrDevelopProblems } from "./work-driver-continue-pr-guard.ts";
import {
  TEST_BLOCK_MARKERS,
  countMarkersInDiffLine,
  countSkipMarkersInDiffLine,
} from "./work-driver-skip-ratchet.ts";
import { TIER_KNOB, smokeTierTimeoutMs, verifyTimeoutMs } from "./work-driver-verify-budget.ts";
import { readFirstConfigLine, verifyChildEnv } from "./work-driver-verify-cmd.ts";
import {
  boundText,
  formatExecError,
  testDeleteTolerance,
} from "./work-driver-verify-develop-helpers.ts";
import type { WorkState } from "./workflow-state.ts";
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
    // #1509 — the smoke tier has its OWN bound (`PI_ENSEMBLE_VERIFY_SMOKE_TIMEOUT_MS`,
    // `.pi/smoke-cmd-timeout-ms`, default 10 min). It used to inherit the
    // develop verify number, which meant raising the suite budget also raised
    // a bound on one product smoke path — and the failure string divided the
    // shared number by 60000 itself, so a sub-minute bound printed "0-min".
    const smokeTimeoutMs = await smokeTierTimeoutMs(repoRoot);
    try {
      await withVerifySlot(() =>
        execFn(smokeCmd, {
          cwd: smokeCwd,
          timeout: smokeTimeoutMs,
          maxBuffer: 4 * 1024 * 1024,
          // The project's gate never runs with the driver's knobs (#1642).
          env: verifyChildEnv(),
        }),
      );
    } catch (err) {
      const e = err as Error & {
        stdout?: string;
        stderr?: string;
        killed?: boolean;
      };
      failures.push(
        formatExecError(
          e,
          // #1509 — one renderer for the bound (`boundText`, which prints
          // seconds for a non-minute-aligned value) and the knob that governs
          // THIS tier, so the handoff tells the operator the variable that
          // actually moves this run.
          `smoke: command \`${smokeCmd}\` exceeded its ${boundText(smokeTimeoutMs)} timeout in ${smokeCwd} (the bound is ${TIER_KNOB.smoke})`,
          `smoke: command \`${smokeCmd}\` failed in ${smokeCwd}`,
        ),
      );
    }
  } else {
    notes.push("no .pi/smoke-cmd — product smoke not run");
  }
}

/**
 * #1468 — a continued PR's worktree must hold a finished merge of the mainline
 * commit on top of the PR head. Each problem fails the gate, so the developer
 * gets it on the retry.
 */
export async function runContinuePrGate(
  execFn: NonNullable<DriverContext["verifyExecFn"]>,
  state: WorkState,
  worktrees: Record<string, string>,
  failures: string[],
): Promise<void> {
  const cp = state.pipelineState.continuedPr;
  if (!cp) return;
  for (const [id, cwd] of Object.entries(worktrees)) {
    for (const problem of await continuePrDevelopProblems(execFn, cwd, cp)) {
      failures.push(`continue-pr: worktree "${id}": ${problem}`);
    }
  }
}
