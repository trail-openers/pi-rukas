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
 *
 * Attribution is opt-in with the develop round (`.pi/verify-select`). A project
 * that has not opted in runs the tier exactly as it did before #1647.
 */

import fs from "node:fs/promises";
import path from "node:path";
import { trace } from "./trace.ts";
import type { CycleContext } from "./work-driver-context.ts";
import { createVerifyChannel } from "./work-driver-integrate-verify-flake.ts";
import { runVerifyFull } from "./work-driver-verify-full.ts";
import { removeVerifyReportDir } from "./work-driver-verify-report-path.ts";
import { selectOptedIn } from "./work-driver-verify-select-develop.ts";
import {
  type SelectedVerifyRecord,
  withSelectedAttribution,
} from "./work-driver-verify-select-exec.ts";
import { verifyAttributionSectionOf } from "./work-driver-verify-select-render.ts";
import { SHA_RE, isOfflineTest } from "./work-driver-verify-shared.ts";
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

/**
 * Run `cmd` (the verify-cmd-full line) in the primary worktree. With attribution
 * available, the run is the attributed one and is not repeated by runVerifyFull;
 * without it (not opted in, no base, no diff) the run is exactly the pre-#1647
 * one: a failure is retried once, as it always was.
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
  const unattributed = () =>
    runVerifyFull(cmd, primaryWorktree, timeoutMs, execFn, { retry: true });
  if (!(await selectOptedIn(ctx.repoRoot))) return unattributed();
  if (baseSha === undefined || !SHA_RE.test(baseSha)) {
    trace(
      "work-driver: ci step — no valid base commit, so the full suite is not attributed (run as before)",
    );
    return unattributed();
  }
  // Argv form, no shell, and `--` ends the revisions: the base is a ref from
  // state, never shell input, and no name in it can read as an option.
  const diff = await execFn("git", {
    argv: ["diff", "--name-only", "--no-renames", baseSha, "HEAD", "--"],
    cwd: primaryWorktree,
  }).catch((err: unknown) => {
    trace(
      `work-driver: ci step — could not list the changed files for attribution, so the suite runs unattributed: ${(err as Error).message?.slice(0, 160)}`,
    );
    return undefined;
  });
  if (diff === undefined) return unattributed();
  // The channel is made once the attribution is certain to run, so no return
  // above can leave its report directory behind.
  const channel = createVerifyChannel();
  if (channel === undefined) return unattributed();
  const changedTests = diff.stdout
    .split("\n")
    .map((p) => p.trim())
    .filter((p) => p.startsWith(EXTENSION_PREFIX))
    .map((p) => p.slice(EXTENSION_PREFIX.length))
    .filter(isOfflineTest);
  const record: SelectedVerifyRecord = { flaky: [], baselineRed: [] };
  const attributed = withSelectedAttribution(execFn, execFn, {
    cmd,
    channel,
    repoRoot: ctx.repoRoot,
    baseSha,
    changeRoots: [primaryWorktree, ctx.repoRoot],
    changedTests,
    probeLabel: `ci-${ctx.issue}`,
    timeoutMs,
    record,
    // The tier had a single rerun of any failure before #1647; the attribution
    // keeps it, for a failure that names no test and for a timed-out run.
    rerunUnnamed: true,
  });
  try {
    // The attribution owns the rerun (named or not), so runVerifyFull does not repeat it.
    const result = await runVerifyFull(cmd, primaryWorktree, timeoutMs, attributed, {
      retry: false,
    });
    // The record is the attribution's own account of a rerun. It is read here,
    // not reconstructed: a recovered run reports the first run's tail, as runVerifyFull does.
    return {
      ...result,
      ...(record.recovered !== undefined
        ? { recovered: true, firstRunOutput: record.recovered.firstRunOutput }
        : {}),
      record,
    };
  } finally {
    removeVerifyReportDir(channel.reportDir);
  }
}

/**
 * Append the carried tests to the PR body. Returns false when it could not be
 * written: the caller then fails the ci tier, because a red gate that was not
 * disclosed is the state this exists to prevent. The names are written from the
 * caller's `record`, which lists only the names the PR body does not carry yet.
 */
export async function discloseInPrBody(
  ctx: CycleContext,
  state: WorkState,
  execFn: ExecFn,
  record: SelectedVerifyRecord,
): Promise<boolean> {
  // The develop round may already have written its own sections; the ci tier's
  // are headed apart so the PR body never carries two identical headings.
  const section = verifyAttributionSectionOf(record, "full suite");
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
