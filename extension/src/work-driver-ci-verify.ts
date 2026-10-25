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
import { driverPublicTextRefusal } from "./public-hygiene-driver.ts";
import { trace } from "./trace.ts";
import type { CycleContext } from "./work-driver-context.ts";
import { createVerifyChannel } from "./work-driver-integrate-verify-flake.ts";
import { runVerifyFull, storeTierOutput } from "./work-driver-verify-full.ts";
import { removeVerifyReportDir } from "./work-driver-verify-report-path.ts";
import { selectOptedIn } from "./work-driver-verify-select-develop.ts";
import {
  type SelectedVerifyRecord,
  withSelectedAttribution,
} from "./work-driver-verify-select-exec.ts";
import {
  replaceAttributionBlock,
  verifyAttributionSectionOf,
} from "./work-driver-verify-select-render.ts";
import { SHA_RE, isOfflineTest } from "./work-driver-verify-shared.ts";
import type { WorkState } from "./workflow-state.ts";
import type { ExecFn } from "./worktree.ts";

export interface CiVerifyRun {
  outcome: "success" | "failure";
  ms: number;
  output: string;
  recovered?: boolean;
  firstRunOutput?: string;
  /**
   * #1762 round 2/4 — passed through from `runVerifyFull`: the offset of the
   * recognised failure line inside `output`, which is what tells the ci step's
   * evidence cut where to start. Undefined when the excerpt carries no anchor.
   */
  anchorOffset?: number;
  /**
   * #1762 round 4 — the offset of the failure line inside `firstRunOutput`, for the
   * recovered run whose evidence is that excerpt rather than `output`. Undefined
   * when that excerpt carries no anchor. Never borrowed from {@link anchorOffset}:
   * the two are different strings and each has its own position.
   */
  firstRunAnchorOffset?: number;
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
    // The recovered excerpt is the attribution's OWN text, so it goes through the
    // same producer the ci tier uses — and BOTH of its halves come from that ONE
    // call. Pairing a raw stream with an offset measured inside the stored excerpt
    // describes two different strings with one number, and leaves the raw, unbounded
    // and unredacted first run in a field the state file persists and the handoff
    // renders. An excerpt with no recognised failure line carries no offset rather
    // than the run's own.
    return {
      ...result,
      ...(record.recovered === undefined
        ? {}
        : (() => {
            const stored = storeTierOutput(record.recovered.firstRunOutput);
            return {
              recovered: true,
              firstRunOutput: stored.output,
              firstRunAnchorOffset: stored.anchorOffset,
            };
          })()),
      record,
    };
  } finally {
    removeVerifyReportDir(channel.reportDir);
  }
}

export type DisclosureResult = { ok: true } | { ok: false; reason: string };

/**
 * Write the cycle's whole attribution record into the PR body, replacing the
 * marked block the develop round wrote. Called only on a passing tier, with the
 * record already folded into state, so the block is the complete account and a
 * repeated write changes nothing. A failure returns its reason: the caller then
 * fails the tier, because a red gate that was not disclosed is the state this
 * exists to prevent.
 */
export async function discloseInPrBody(
  ctx: CycleContext,
  state: WorkState,
  execFn: ExecFn,
): Promise<DisclosureResult> {
  const prNumber = state.pipelineState.prNumber;
  if (prNumber === undefined) return { ok: false, reason: "the PR number is not known" };
  const block = verifyAttributionSectionOf(state.pipelineState.verifyAttribution);
  try {
    const view = await execFn("gh", {
      argv: ["pr", "view", String(prNumber), "--json", "body"],
      cwd: ctx.repoRoot,
    });
    // `null` is an empty body; anything else that is not a string is a read
    // this writer does not understand, and writing over it could blank the PR.
    const parsed = JSON.parse(view.stdout) as { body?: unknown };
    if (parsed.body !== null && typeof parsed.body !== "string") {
      return { ok: false, reason: "the PR body could not be read as text, so it was not edited" };
    }
    const current = parsed.body ?? "";
    const next = replaceAttributionBlock(current, block);
    if (next === current) return { ok: true };
    // #1788 — this is a public publish: it writes the PR body with `gh`, in
    // process, so the tool_call guard that refuses an agent's `gh pr edit` never
    // sees it. The same pure matcher judges it, on the same public-repositories-
    // only rule, BEFORE the file is written and before the command runs, so a
    // refused body posts nothing and leaves the reason in the ci tier's own
    // failure rather than on the forge.
    const refusal = await driverPublicTextRefusal(
      "pull request body",
      next,
      "gh pr edit",
      ctx.repoRoot,
      { exec: execFn },
    );
    if (refusal !== undefined) {
      trace(
        `work-driver: ci step — the attribution block was not written: ${refusal.slice(0, 160)}`,
      );
      return { ok: false, reason: refusal };
    }
    const dir = path.join(ctx.repoRoot, "tmp", `issue-${ctx.issue}`);
    await fs.mkdir(dir, { recursive: true });
    const bodyFile = path.join(dir, `pr-body-verify-${prNumber}.md`);
    await fs.writeFile(bodyFile, next, "utf8");
    await execFn("gh", {
      argv: ["pr", "edit", String(prNumber), "--body-file", bodyFile],
      cwd: ctx.repoRoot,
    });
    return { ok: true };
  } catch (err) {
    const message = (err as Error).message?.slice(0, 160) ?? String(err);
    trace(
      `work-driver: ci step — could not disclose the flaky and baseline-red tests in PR #${prNumber}: ${message}`,
    );
    return { ok: false, reason: `the PR body write failed: ${message}` };
  }
}
