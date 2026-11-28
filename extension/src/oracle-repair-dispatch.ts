/**
 * oracle-repair-dispatch — the one child the repair round pays for, and the freeze it earns.
 *
 * The seat is the specify adversary (`developer`); the tree is the run's specify worktree, reset to the BUILD
 * HEAD the blocked report was judged at; the arms come from the SPECIFY step budget, clamped by the run's
 * deadline through the same `armsStepBudget`/`stepDispatchArms` pair #2660 put behind every dispatching step.
 * The round never extends a budget: it inherits specify's row and the deadline that already binds the cycle.
 *
 * The order below is the whole safety of the round, and each step's rule lives with its own module: the reset
 * and the dispatch (the head carries the frozen test as the record hashes it and none of the builder's
 * implementation, since a builder the driver honoured had produced nothing the named test could pass
 * against); the capture of the seat's `submit_tests` bytes, nothing else; the mechanical judgement in a real
 * checkout of `baseSha`; and the freeze, which is `specify`'s own primitive.
 */ import { type StepArmsCtx, armsStepBudget, stepDispatchArms } from "./lean-step-bound.ts";
import type { BuildExec } from "./lean/build-types.ts";
import type { WorkConfig } from "./lean/config.ts";
import type { PiSpec } from "./lean/spec.ts";
import { SpecifyCommitError, commitTestFiles, committedBlob } from "./lean/specify-commit.ts";
import { fileProblem, normaliseRelPath } from "./lean/specify-path.ts";
import { runTestFile, sha256 } from "./lean/specify-proof.ts";
import { writeCaptured } from "./lean/specify-reset.ts";
import { SpecifyInfraError } from "./lean/specify-reset.ts";
import type { ensureSpecifyWorktreeWithProvision } from "./lean/specify-tree.ts";
import {
  type DispatchUsageRow,
  budgetFor,
  dispatchUsageRow,
  readDispatched,
} from "./lean/step-budget.ts";
import { extractSubmitTests } from "./lean/submit-tests-extract.ts";
import { SUBMIT_TESTS_REPORTER_PATH } from "./lean/submit-tests-reporter.ts";
import { repairPrompt } from "./oracle-repair-brief.ts";
import { readRepairSubmission } from "./oracle-repair-capture.ts";
import type { EvidenceRow, HeadEvidenceRow } from "./oracle-repair-evidence.ts";
import { RepairJudgeError, judgeRepairSubmission } from "./oracle-repair-judge.ts";
import { statReporterPath } from "./reporter-preflight.ts";
import { traceWarn } from "./trace.ts";
import type { DispatchResult } from "./types.ts";

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
  /** The run's permission stamp, threaded the way every dispatching step threads it. */
  /** The child's trust stamp, from the release's own helper (`cycleChildOpts`) at the call site. */
  childOpts: { workCycleTrust: boolean };
  repoRoot: string;
  issue: number;
  baseSha: string;
  /** The build head the replacements are re-run at for the record. */
  headBefore: string;
  /** The seat's tree: the run's specify worktree, which this round resets. */
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
 * Ask the tree to sit ON the build head before anything is written, and refuse the round if it does not.
 *
 * `commitTestFiles` proves a freeze by diffing against the commit it names, so that commit has to be HEAD's
 * parent for the proof to mean what the round needs: the correction sits on the run's own change, and the
 * diff holds the named files and nothing else. A tree that came back anywhere else is a tree this round does
 * not understand, and a freeze made on the wrong parent is a contract no later check can read.
 */
async function commitOnHead(exec: BuildExec, wt: string, headBefore: string): Promise<void> {
  const { headDescendsFrom } = await import("./lean/build-git.ts");
  if (!(await headDescendsFrom(exec, wt, headBefore)))
    throw new SpecifyCommitError(
      `the seat's tree does not sit on the build head ${headBefore} — refusing to freeze there`,
    );
}

/**
 * Run the round. The caller owns the base checkout; everything else about the round happens here.
 */
export async function runRepairRound(o: RepairRoundOpts): Promise<RepairOutcome> {
  const { deps, ctx, config, wt, issue, baseSha } = o;
  const rows: DispatchUsageRow[] = [];
  const refuse = (why: string): RepairOutcome => refused(issue, why, rows);

  // 1. The seat is paid for only after its tree is at a commit that carries the frozen test it is being
  //    asked to correct, and holds none of the builder's implementation. That commit is the BUILD HEAD the
  //    blocked report was judged at, not the run's base: the run's contract lives on the builder's commits,
  //    and a reset to `baseSha` would delete them along with the implementation — the round would "repair"
  //    the oracle of a run whose change had silently vanished. `headBefore` is the head the driver ran the
  //    frozen tests at, so the file the seat must edit is there byte-for-byte as the record hashes it, and
  //    `specify`'s own primitive puts the tree at exactly that commit with the dependency links rebuilt.
  const prepared = await deps
    .ensureTree({
      repoRoot: o.repoRoot,
      issue,
      fromRef: o.headBefore,
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
  const budget = armsStepBudget(
    row,
    stepDispatchArms(ctx, (row?.minutes ?? 0) * 60_000, "specify"),
  );
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
        ...o.childOpts,
      },
    );
  } catch (err) {
    // A seat the harness could not run at all is a REFUSAL, not a thrown error, and that is a safety property
    // rather than tidiness: the round is billed on the edge that ENTERED this step, so an outcome that left
    // the state machine (an `error`) would hand back with the counter spent for nothing, while a `refused`
    // puts the builder back on the same contract with the red marker standing, which is where a run that
    // cannot answer the question belongs.
    return refuse(`the repair child could not run: ${(err as Error).message}`);
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
    baseRef: o.baseSha,
    template,
    named: o.named,
    replacements: captured.bytes.map((c) => ({
      path: c.path,
      bytes: c.bytes,
      frozenHash: o.frozen[c.path],
    })),
  });
  if (!judged.accepted) return refuse(judged.why);

  // 5. Freeze, by the release's own rules: write the accepted bytes into the seat's tree, then make ONE
  //    commit whose diff is exactly the replaced paths, and hash the committed blobs. A run cannot hold a
  //    frozen map for bytes no commit carries, because every later tamper check reads a blob.
  //
  //    The commit is made on the BUILD HEAD, and the primitive that proves a freeze names the commit it sits
  //    on — so the build head is asked for as an ancestor, and its own implementation commit stays under the
  //    correction. `specify`'s primitive has already put HEAD there and cleaned the tree, which is what makes
  //    "no other change" provable: any path the commit carried beyond the named ones is work this round
  //    invented, and the round that replaces a contract may not also write a feature.
  const replaced = judged.verdicts.map((v) => v.path);
  try {
    await commitOnHead(deps.exec, wt, o.headBefore);
    writeCaptured(wt, new Map(judged.verdicts.map((v) => [v.path, v.bytes])));
    await commitTestFiles(
      deps.exec,
      wt,
      o.headBefore,
      replaced,
      `test(oracle): repair frozen acceptance tests for issue #${String(issue)}`,
    );
  } catch (err) {
    throw new SpecifyInfraError(`repair freeze: ${(err as Error).message}`);
  }

  const originalHashes: Record<string, string> = {};
  const passedAtHead: Record<string, boolean> = {};
  let headObserved = true;
  const frozen: Record<string, string> = { ...o.frozen };
  for (const v of judged.verdicts) {
    const blob = await committedBlob(deps.exec, wt, v.path).catch(() => undefined);
    if (blob === undefined || sha256(blob) !== sha256(v.bytes))
      throw new SpecifyInfraError(
        `repair freeze: ${v.path} is not the bytes the round committed into the contract`,
      );
    frozen[v.path] = sha256(blob);
    originalHashes[v.path] = v.originalHash;
    const atHead = await passesAtHead(deps.exec, deps.baseTree, o.headBefore, v.path, template);
    passedAtHead[v.path] = atHead.passed;
    if (!atHead.observed) headObserved = false;
  }
  // The freeze is committed and the contract corrected whatever the head run said, so the one reading the
  // step may NOT take is a green no runner showed: when the project's own command gave no answer this step
  // could classify, the round cannot vouch for the corrected oracle passing anywhere.
  if (!headObserved)
    throw new RepairJudgeError(
      `the project's runner gave no verdict on the corrected test at the build head ${o.headBefore}`,
    );
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
/**
 * The builder's own implementation, laid over the judge's checkout of the base, and the replacement read as
 * the project's runner saw it. The second return value is not decoration: an `unclear` runner (exit 0 while
 * naming a failure) is a runner whose verdict nobody read, and a record claiming the corrected oracle
 * PASSED there would be a claim about output the driver could not classify.
 */
interface HeadRun {
  passed: boolean;
  observed: boolean;
}

async function passesAtHead(
  exec: BuildExec,
  baseTree: string,
  head: string,
  rel: string,
  template: string,
): Promise<HeadRun> {
  const unanswered: HeadRun = { passed: false, observed: false };
  // Which files the builder committed at `head`, read against its own parent: the source it wrote, and no
  // frozen file (its report having been honoured, it changed none). They go into the round's throwaway
  // checkout of the base, a tree of the SAME repository that is deleted when the step ends. Asking the
  // seat's tree instead would run the corrected test where nothing is implemented, which is the question the
  // judge already refused a weakened file for. A git this round cannot ask answers `unanswered` — the
  // disclosure "did NOT pass at head" — rather than a claim the round could not verify.
  const { blobAt, commitDiff } = await import("./lean/build-git.ts");
  let changed: string[];
  try {
    const parent = (
      await exec("git", {
        argv: ["rev-parse", `${head}^`],
        cwd: baseTree,
        timeout: 30_000,
        maxBuffer: 1024 * 1024,
      }).catch(() => undefined)
    )?.stdout?.trim();
    changed =
      parent === undefined || parent === "" ? [] : await commitDiff(exec, baseTree, parent, head);
  } catch {
    return unanswered;
  }
  const laid = new Map<string, Buffer>();
  for (const rel2 of changed) {
    if (rel2 === rel) continue;
    const bytes = await blobAt(exec, baseTree, head, rel2).catch(() => undefined);
    if (bytes !== undefined && bytes.length > 0) laid.set(rel2, bytes);
  }
  writeCaptured(baseTree, laid);
  const proof = await runTestFile(exec, { wt: baseTree, template, file: rel });
  return {
    passed: proof.kind === "green",
    observed: proof.kind === "green" || proof.kind === "red",
  };
}
