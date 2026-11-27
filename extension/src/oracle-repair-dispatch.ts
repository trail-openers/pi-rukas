/**
 * oracle-repair-dispatch — the one child the repair round pays for, and the freeze it earns.
 *
 * The seat is the specify adversary (`developer`); the tree is the run's specify worktree, reset to
 * `baseSha` so the implementation the seat must not copy is not there to copy; the arms come from the
 * SPECIFY step budget, clamped by the run's deadline through the shared helpers — the same
 * `armsStepBudget`/`stepDispatchArms` pair #2660 put behind every dispatching step. The round never extends
 * a budget: it inherits specify's row and the deadline that already binds the cycle.
 *
 * The order below is the whole safety of the round:
 *
 *   1. reset the seat's tree to `baseSha` BEFORE the child is paid (blindness, performed);
 *   2. dispatch the seat on the blind brief (`oracle-repair-brief.ts`);
 *   3. read its `submit_tests` calls and capture only those bytes, refusing any file outside the named set;
 *   4. judge them mechanically in a real checkout of `baseSha` (`oracle-repair-judge.ts`) — a replacement
 *      that is green at base, identical to the frozen file, or red only on a case the frozen file already
 *      had, refuses the round;
 *   5. FREEZE the accepted bytes the way `specify` froze the originals: `writeCaptured` into the base tree,
 *      one commit whose diff is exactly the replaced paths, and hashes taken from the COMMITTED blobs. The
 *      step that replaces a contract must freeze its replacement with the same primitive that froze the
 *      original, or the run's tamper evidence describes bytes git never held.
 *
 * A refusal is a verdict with a reason, never a throw. Only a tree or git the step cannot account for
 * throws, and then as `SpecifyInfraError`, which the engine turns into a handback.
 */
import { armsStepBudget, stepDispatchArms, type StepArmsCtx } from "./lean-step-bound.ts";
import {
  budgetFor,
  dispatchUsageRow,
  readDispatched,
  type DispatchUsageRow,
} from "./lean/step-budget.ts";
import type { BuildExec } from "./lean/build-types.ts";
import type { WorkConfig } from "./lean/config.ts";
import { commitTestFiles, committedBlob } from "./lean/specify-commit.ts";
import { writeCaptured } from "./lean/specify-reset.ts";
import { runTestFile, sha256 } from "./lean/specify-proof.ts";
import { fileProblem, normaliseRelPath } from "./lean/specify-path.ts";
import { SpecifyInfraError } from "./lean/specify-reset.ts";
import { ensureSpecifyWorktreeWithProvision } from "./lean/specify-tree.ts";
import { extractSubmitTests } from "./lean/submit-tests-extract.ts";
import { SUBMIT_TESTS_REPORTER_PATH } from "./lean/submit-tests-reporter.ts";
import { statReporterPath } from "./reporter-preflight.ts";
import { traceWarn } from "./trace.ts";
import type { DispatchResult } from "./types.ts";
import { judgeRepairSubmission } from "./oracle-repair-judge.ts";
import { readRepairSubmission } from "./oracle-repair-capture.ts";
import { repairPrompt } from "./oracle-repair-brief.ts";
import type { PiSpec } from "./lean/spec.ts";
import type { EvidenceRow, HeadEvidenceRow } from "./oracle-repair-evidence.ts";

/** The repair round's verdict, in the shape the `repair` step turns into an `Outcome`. */
export type RepairOutcome =
  | {
      kind: "repaired";
      /** The NEW frozen map — the run's map with each replaced path's hash taken from the commit. */
      frozen: Record<string, string>;
      /** Each replaced path's ORIGINAL frozen hash, for the disclosure. */
      originalHashes: Record<string, string>;
      /** Each replaced path: whether it passed at the build head, as the driver observed it. */
      passedAtHead: Record<string, boolean>;
      /** The paths the round replaced, in submission order. */
      paths: string[];
      /** The build head the replacements were run at — the commit `verify` then had to hold green. */
      head: string;
      rows: DispatchUsageRow[];
    }
  | { kind: "refused"; why: string; rows: DispatchUsageRow[] };

/** The round's outside world, all of it injected so the test drives the real thing. */
export interface RepairRoundDeps {
  exec: BuildExec;
  dispatch: (
    spec: { role: string; prompt: string; cwd: string },
    o: { [k: string]: unknown },
  ) => Promise<DispatchResult>;
  /** A real detached checkout of `baseSha`, created by the caller and removed after the step. */
  baseTree: string;
  /** The specify step's own tree primitive — create-or-own-check plus reset to the base, with provisioning.
   *  Injected so a test sees the reset the seat is judged in, and production gets the real one. */
  ensureTree: (
    o: Parameters<typeof ensureSpecifyWorktreeWithProvision>[1],
  ) => Promise<{ wt: string; linked: string[]; problem?: string }>;
  /** Preflight for the `submit_tests` companion; `statReporterPath` in production. */
  statReporter?: (p: string) => Promise<unknown>;
}

/** Everything the round needs to know about the run and the blocked verdict it answers. */
export interface RepairRoundOpts {
  deps: RepairRoundDeps;
  ctx: StepArmsCtx;
  config: WorkConfig;
  spec: PiSpec;
  headless: boolean;
  /** The run's permission stamp, threaded the way every dispatching step threads it. */
  childOpts: (headless: boolean) => { workCycleTrust: boolean };
  repoRoot: string;
  issue: number;
  baseSha: string;
  /** The build head the replacements are re-run at for the record. */
  headBefore: string;  /** The seat's tree: the run's specify worktree, which this round resets. */
  wt: string;
  /** The run's branch, which the reset puts the frozen commit ON. */
  branch: string;
  /** The run's frozen map as it stands — the source of each original's hash. */
  frozen: Record<string, string>;
  /** The blocked report's file list: the ONLY set this round may replace. */
  named: readonly string[];
  claims: EvidenceRow[];
  evidence: HeadEvidenceRow[];
  /** The write fence's scratch dir, which the caller computes beside the worktree. */
  scratch: string;
}

/** A refusal, worded for the handback and traced for the log. */
function refused(issue: number, why: string, rows: DispatchUsageRow[]): RepairOutcome {
  traceWarn(`lean repair #${String(issue)}: refused — ${why}`);
  return { kind: "refused", why, rows };
}

/**
 * Run the round. The caller owns the base checkout; everything else about the round happens here.
 */
export async function runRepairRound(o: RepairRoundOpts): Promise<RepairOutcome> {
  const { deps, ctx, config, wt, issue, baseSha } = o;
  const rows: DispatchUsageRow[] = [];
  const refuse = (why: string): RepairOutcome => refused(issue, why, rows);

  // 1. The seat is paid for only after its tree is at the base, so the implementation is absent rather
  //    merely unmentioned. `ensureSpecifyWorktreeWithProvision` is the specify step's own primitive: it
  //    refuses a tree this run does not own BEFORE it resets, and re-provisions the dependency links a
  //    `clean -fdx` took, which is what lets the project's runner execute here at all.
  const prepared = await deps
    .ensureTree({
      repoRoot: o.repoRoot,
      issue,
      fromRef: baseSha,
      branch: o.branch,
      allowAheadOfBase: true,
    })
    .catch((err: unknown) => {
      throw new SpecifyInfraError(`repair tree: ${(err as Error).message}`);
    });
  if (prepared.problem !== undefined)
    traceWarn(`lean repair #${String(issue)}: tree caveat — ${prepared.problem}`);

  // 2. The blind child, on the specify row and the run's deadline.
  const row = budgetFor(config, "specify");
  const budget = armsStepBudget(row, stepDispatchArms(ctx, (row?.minutes ?? 0) * 60_000, "specify"));
  let result: DispatchResult;
  try {
    await (deps.statReporter ?? statReporterPath)(SUBMIT_TESTS_REPORTER_PATH);
    result = await deps.dispatch(
      {
        role: "developer",
        cwd: wt,
        prompt: repairPrompt({
          issue,
          spec: o.spec,
          worktree: wt,
          ...(config.verify.test === undefined ? {} : { testRunner: config.verify.test }),
          claims: o.claims,
          evidence: o.evidence,
        }),
      },
      {
        writeFence: { root: wt, repo: o.repoRoot, scratch: o.scratch },
        extraArgs: ["--no-skills", "--extension", SUBMIT_TESTS_REPORTER_PATH],
        ...budget.opts,
        ...o.childOpts(o.headless),
      },
    );
  } catch (err) {
    throw new SpecifyInfraError(`repair child: ${(err as Error).message}`);
  }
  rows.push(dispatchUsageRow(result));
  const read = readDispatched(result);
  if ("stop" in read) return refuse("the repair child stopped at its own ceiling");

  // 3. What it submitted, at the boundary the specify step uses, and only those bytes.
  const submitted = extractSubmitTests(result.toolUses ?? []).rows.flatMap((r) =>
    r.testFiles.map((f) => normaliseRelPath(f)),
  );
  const paths = [...new Set(submitted)];
  const outside = paths.filter((p) => !o.named.includes(p));
  if (outside.length > 0)
    return refuse(
      `the repair replaced ${String(outside.length)} file(s) the blocked report never named: ${outside
        .slice(0, 4)
        .join(", ")}`,
    );
  for (const p of paths) {
    const bad = fileProblem(wt, p);
    if (bad !== undefined) return refuse(bad);
  }
  const captured = readRepairSubmission(wt, paths);
  if (captured.refused !== undefined) return refuse(captured.refused);
  if (captured.bytes.length === 0) return refuse("the repair submitted no test file");

  const template = config.verify.test;
  if (template === undefined || template.trim() === "")
    return refuse("no verify.test runner is configured to judge the replacement with");

  // 4. The mechanical judge, in the caller's real checkout of the run's own base.
  const judged = await judgeRepairSubmission({
    exec: deps.exec,
    baseTree: deps.baseTree,
    template,
    named: o.named,
    replacements: captured.bytes.map((c) => ({
      path: c.path,
      bytes: c.bytes,
      frozenHash: o.frozen[c.path],
    })),
  });
  if (!judged.accepted) return refuse(judged.why);

  // 5. Freeze, by the release's own rules: write the accepted bytes into the seat's tree (which is still at
  //    the base — the child committed nothing and the judge ran elsewhere), then make ONE commit whose diff
  //    is exactly the replaced paths, and hash the committed blobs. A run cannot hold a frozen map for bytes
  //    no commit carries, because every later tamper check reads a blob.
  const replaced = judged.verdicts.map((v) => v.path);
  try {
    writeCaptured(
      wt,
      new Map(judged.verdicts.map((v) => [v.path, v.bytes])),
    );
    await commitTestFiles(
      deps.exec,
      wt,
      baseSha,
      replaced,
      `test(oracle): repair frozen acceptance tests for issue #${String(issue)}`,
    );
  } catch (err) {
    throw new SpecifyInfraError(`repair freeze: ${(err as Error).message}`);
  }

  const originalHashes: Record<string, string> = {};
  const passedAtHead: Record<string, boolean> = {};
  const frozen: Record<string, string> = { ...o.frozen };
  for (const v of judged.verdicts) {
    const blob = await committedBlob(deps.exec, wt, v.path).catch(() => undefined);
    if (blob === undefined || sha256(blob) !== sha256(v.bytes))
      throw new SpecifyInfraError(
        `repair freeze: ${v.path} is not the bytes the round committed into the contract`,
      );
    frozen[v.path] = sha256(blob);
    originalHashes[v.path] = v.originalHash;
    passedAtHead[v.path] = await passesAtHead(deps.exec, wt, o.headBefore, v.path, template);
  }
  return {
    kind: "repaired",
    frozen,
    originalHashes,
    passedAtHead,
    paths: replaced,
    head: o.headBefore,
    rows,
  };
}

/**
 * Did the replacement pass where the builder's work stands? A head that holds no such blob, or a runner that
 * observed nothing, is `false`: the record says it did not pass, which is the honest reading of a run that
 * could not show that it did.
 */
async function passesAtHead(
  exec: BuildExec,
  wt: string,
  head: string,
  rel: string,
  template: string,
): Promise<boolean> {
  const { blobAt } = await import("./lean/build-git.ts");
  const bytes = await blobAt(exec, wt, head, rel).catch(() => undefined);
  if (bytes === undefined || bytes.length === 0) return false;
  const proof = await runTestFile(exec, { wt, template, file: rel });
  return proof.kind === "green";
}
