/**
 * work-driver-ci-verify — #1647: the ci tier's full offline suite, attributed.
 *
 * `.pi/verify-cmd-full` now ends with the whole offline suite, which the develop
 * round no longer runs. Its failures are attributed the same way the selected
 * develop run's are (`withSelectedAttribution`): a flaky test passes, a test red
 * on the base commit too does not block, and anything else routes as a ci
 * failure does today. The non-blocking tests are disclosed in the PR body, and a
 * disclosure that cannot be written fails the ci tier: a red gate must never be
 * pushed without the record that makes it safe.
 */

import fs from "node:fs/promises";
import path from "node:path";
import { trace } from "./trace.ts";
import type { CycleContext } from "./work-driver-context.ts";
import { createVerifyChannel } from "./work-driver-integrate-verify-flake.ts";
import { runVerifyFull } from "./work-driver-verify-full.ts";
import { removeVerifyReportDir } from "./work-driver-verify-report-path.ts";
import {
  type SelectedVerifyRecord,
  withSelectedAttribution,
} from "./work-driver-verify-select-exec.ts";
import { verifyAttributionSectionOf } from "./work-driver-verify-select-render.ts";
import type { WorkState } from "./workflow-state.ts";
import type { ExecFn } from "./worktree.ts";

export interface CiVerifyRun {
  outcome: "success" | "failure";
  ms: number;
  output: string;
  recovered?: boolean;
  firstRunOutput?: string;
  /** Tests this run let through without blocking; undefined when attribution did not run. */
  record?: SelectedVerifyRecord;
}

const EXTENSION_PREFIX = "extension/";
const TEST_RE = /^smoke-tests\/test-[^/]+\.ts$/;

/**
 * Run `cmd` (the verify-cmd-full line) in the primary worktree. With attribution
 * available, the run is the attributed one and is not repeated by runVerifyFull;
 * without it (no base, no report channel, unreadable diff) the run is exactly
 * the pre-#1647 one: any failure is a failure.
 */
export async function runCiVerifyFull(
  ctx: CycleContext,
  state: WorkState,
  primaryWorktree: string,
  cmd: string,
  timeoutMs: number,
  execFn: ExecFn,
): Promise<CiVerifyRun> {
  const baseSha = state.pipelineState.baseSha;
  const channel = createVerifyChannel();
  // Argv form, no shell: the base is a ref from state, never shell input.
  const diff =
    baseSha === undefined
      ? undefined
      : await execFn("git", {
          argv: ["diff", "--name-only", "--no-renames", baseSha, "HEAD"],
          cwd: primaryWorktree,
        }).catch(() => undefined);
  if (channel === undefined || diff === undefined) {
    return runVerifyFull(cmd, primaryWorktree, timeoutMs, execFn, { retry: true });
  }
  const changedTests = diff.stdout
    .split("\n")
    .map((p) => p.trim())
    .filter((p) => p.startsWith(EXTENSION_PREFIX))
    .map((p) => p.slice(EXTENSION_PREFIX.length))
    .filter((p) => TEST_RE.test(p));
  const record: SelectedVerifyRecord = { flaky: [], baselineRed: [] };
  const attributed = withSelectedAttribution(execFn, execFn, {
    cmd,
    channel,
    repoRoot: ctx.repoRoot,
    baseSha,
    changeRoots: [primaryWorktree, ctx.repoRoot],
    changedTests,
    timeoutMs,
    record,
  });
  try {
    // The attribution already repeats a failing run once, so the tier does not.
    const result = await runVerifyFull(cmd, primaryWorktree, timeoutMs, attributed, {
      retry: false,
    });
    return { ...result, record };
  } finally {
    removeVerifyReportDir(channel.reportDir);
  }
}

/**
 * Append the carried tests to the PR body. Returns false when it could not be
 * written: the caller then fails the ci tier, because a red gate that was not
 * disclosed is the state this exists to prevent.
 */
export async function discloseInPrBody(
  ctx: CycleContext,
  state: WorkState,
  execFn: ExecFn,
  record: SelectedVerifyRecord,
): Promise<boolean> {
  const section = verifyAttributionSectionOf(record);
  if (section === "") return true;
  const prNumber = state.pipelineState.prNumber;
  if (prNumber === undefined) return false;
  try {
    const view = await execFn("gh", {
      argv: ["pr", "view", String(prNumber), "--json", "body", "--jq", ".body"],
      cwd: ctx.repoRoot,
    });
    const dir = path.join(ctx.repoRoot, "tmp", `issue-${ctx.issue}`);
    await fs.mkdir(dir, { recursive: true });
    const bodyFile = path.join(dir, `pr-body-verify-${prNumber}.md`);
    await fs.writeFile(bodyFile, `${view.stdout.replace(/\s+$/, "")}\n${section}\n`, "utf8");
    await execFn("gh", {
      argv: ["pr", "edit", String(prNumber), "--body-file", bodyFile],
      cwd: ctx.repoRoot,
    });
    return true;
  } catch (err) {
    trace(
      `work-driver: ci step — could not disclose the flaky and baseline-red tests in PR #${prNumber}: ${(err as Error).message?.slice(0, 160)}`,
    );
    return false;
  }
}
