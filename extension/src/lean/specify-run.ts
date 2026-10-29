/**
 * lean/specify-run — the CAPTURE / RESET / REWRITE / PROVE / COMMIT pipeline
 * `specify` and `challenge` share.
 *
 * Both steps pay one adversary to write test files, and both then have to turn
 * whatever it submitted into frozen, committed, provably-red tests. What they
 * actually differ in is TWO inputs, not two algorithms:
 *
 *   - what the child is shown and asked for (`specifyPrompt` vs `challengePrompt`,
 *     assembled by the caller, which also owns the dispatch);
 *   - **`headBefore`** — the commit the tree is reset back to and the commit the
 *     red proof runs against. For `specify` that is the run's base sha: its claim
 *     is that the tests are red on code nobody has written. For `challenge` it is
 *     the current head: the code claims to pass the frozen tests, so a new test is
 *     only worth freezing if it is red against that head.
 *
 * Everything downstream of the dispatch is identical, so it lives here once.
 * Copying it would be the worse failure: the eleven stages below are each a
 * response to a way a child can lie about what it wrote (a symlink swapped in
 * after validation, a commit of its own, a green file reported as red, a commit
 * that quietly contains a stray edit), and two copies drift — and the copy that
 * drifts is the one nobody is testing.
 *
 * The ref is a parameter and nothing else may vary by step: `resetWorktreeToBase`
 * is named for the base but takes any commit, and it verifies the tree got there
 * and is clean, so `challenge`'s reset to a head is exactly as proven as
 * `specify`'s reset to a base.
 *
 * The return types the two callers route on are deliberately distinct
 * (`PipelineVerdict`), and so is the COVERAGE RULE each one passes. `specify`
 * passes `"all-criteria"`: its claim is that every `verify: "test"` criterion is
 * falsifiable, so one criterion left without a red test refuses the whole run.
 * `challenge` passes `"any-red"`: its job is to add SOME edge case the frozen
 * tests missed, and an adversary that found one red edge for AC1 and nothing for
 * AC2 has done its job — refusing that run would throw away the one genuine
 * finding because the round was not exhaustive. Under `"any-red"` every proven-red
 * file is committed and the verdict is `committed` when at least one is red,
 * `empty` when none is.
 *
 * That judgement belongs to the caller, which is why the rule is an argument and
 * this module returns `committed` / `uncovered` / `empty` and lets the caller
 * name what each means.
 */

import { existsSync, rmSync } from "node:fs";
import path from "node:path";
import type { ExecFn } from "../worktree.ts";
import { type CaptureResult, captureTestBytes } from "./specify-capture.ts";
import type { Proof, TestRunLimits } from "./specify-proof.ts";
import { runTestFile, sha256 } from "./specify-proof.ts";
import {
  SpecifyCommitError,
  SpecifyInfraError,
  SpecifyResetError,
  commitTestFiles,
  committedBlob,
  resetWorktreeToBase,
  writeCaptured,
} from "./specify-reset.ts";

export { SpecifyInfraError };
import type { DeclaredPath, DroppedRow } from "./specify-tree.ts";
import { declaredPaths } from "./specify-tree.ts";
import type { SubmitTestsRow } from "./submit-tests-extract.ts";

/** What the pipeline did, before its caller decides what the verdict means. */
export type PipelineVerdict =
  | {
      kind: "committed";
      frozen: Record<string, string>;
      tests: Record<string, string[]>;
      reason: string;
    }
  /** No submitted row survived validation, capture and the red proof. */
  | { kind: "empty"; reason: string }
  /**
   * Only `"all-criteria"` returns this: at least one wanted criterion ended
   * with no red file, and under that rule a gap is a refusal rather than a
   * partial freeze. `reason` leads with the same `criterion <id> has no red
   * test` lines as `uncovered` — the per-file drop notes follow — so a caller
   * that surfaces only one of the two fields still tells the operator why.
   */
  | { kind: "uncovered"; uncovered: string[]; reason: string };

/**
 * What the pipeline requires of its coverage, decided by the caller.
 *
 * - `"all-criteria"` (`specify`): every id in `wanted` must have at least one
 *   red file, or the run is refused. This is the rule the pipeline has always
 *   applied, and `specify`'s behaviour is unchanged by its presence here.
 * - `"any-red"` (`challenge`): at least one red file anywhere is enough. The
 *   round exists to surface SOME gap the frozen tests missed, so partial
 *   coverage is a result, not a failure — and everything proven red is kept.
 */
export type CoverageRule = "all-criteria" | "any-red";

export interface RunTestsArgs {
  exec: ExecFn;
  /** Absolute path of the worktree the child worked in. */
  wt: string;
  repoRoot: string;
  issue: number;
  /** The run's branch — the ref `resetWorktreeToBase` points at the head. */
  branch: string;
  /**
   * The commit the tree is reset to, the commit the red proof runs against, and
   * the parent the frozen commit is checked against. `baseSha` for `specify`,
   * the current head for `challenge`.
   */
  headBefore: string;
  /** The project's `verify.test` template. Required — every caller checks first. */
  runnerTemplate: string;
  /** The ids of the criteria the step requires a red test for. */
  wanted: string[];
  /**
   * The coverage rule, passed IN rather than inferred from which caller this
   * is: the pipeline must not grow a `if challenge` branch, or the two steps
   * drift apart in the one place they are supposed to share.
   */
  coverage: CoverageRule;
  /** toolUses -> the rows the child declared, plus how many calls were malformed. */
  extract: (toolUses: unknown[]) => { rows: SubmitTestsRow[]; skipped: number };
  /** The boundary every declared path passes through; `validateSubmitRows` in both callers. */
  validate: (rows: SubmitTestsRow[]) => { kept: SubmitTestsRow[]; dropped: DroppedRow[] };
  /** Create-or-reset-and-provision; `ensureSpecifyWorktreeWithProvision` in both callers. */
  prepare: () => Promise<{ wt: string; linked: string[]; problem?: string }>;
  /** The subject of the commit the pipeline makes. */
  commitMessage: string;
  /** The single-descriptor read; `captureTestBytes` in production. */
  capture?: (wt: string, paths: string[], owners: Map<string, string>) => CaptureResult;
  /** Per-run runner limits; a test injects a short timeout to prove a hang is infra. */
  testLimits?: TestRunLimits;
}

/** How many per-file notes an outcome reason carries before it says `(+N more)`. */
const NOTE_CAP = 8;
/** How long one note's detail may run before the reason clips it. */
const NOTE_DETAIL_MAX = 200;

/** A note's detail, clipped: one chatty runner must not drown the reason. */
function clip(detail: string): string {
  const one = detail.replace(/\s+/g, " ").trim();
  return one.length > NOTE_DETAIL_MAX ? `${one.slice(0, NOTE_DETAIL_MAX)}…` : one;
}

/**
 * A capped `label: a; b; c` clause. Both note families go through here so a
 * run with fifty dropped files produces a bounded reason, not a wall.
 */
function noteClause(label: string, notes: string[]): string {
  if (notes.length === 0) return "";
  const shown = notes.slice(0, NOTE_CAP).map(clip);
  const more = notes.length - shown.length;
  return `${label} ${notes.length}: ${shown.join("; ")}${more > 0 ? ` (+${more} more)` : ""}`;
}

/**
 * A `dropped N (…) — a; b; c` clause, with NO leading space: each call site
 * supplies the separator its own position needs, so the clause does not carry
 * padding that a caller then has to trim before joining.
 */
function dropNote(dropped: { criterionId: string; path?: string; reason: string }[]): string {
  if (dropped.length === 0) return "";
  const parts = dropped
    .slice(0, NOTE_CAP)
    .map((d) => clip(`${d.criterionId}${d.path === undefined ? "" : ` ${d.path}`}: ${d.reason}`));
  const more = dropped.length - parts.length;
  return `dropped ${dropped.length}${more > 0 ? ` (+${more} more)` : ""} — ${parts.join("; ")}`;
}

/** Remove a non-red file the step refused; the reason it is still there, if any. */
function removeRejected(wt: string, rel: string): string | undefined {
  if (!existsSync(path.join(wt, rel))) return undefined;
  try {
    rmSync(path.join(wt, rel));
  } catch (err) {
    return `could not remove the rejected test ${rel}: ${(err as Error).message}`;
  }
  if (existsSync(path.join(wt, rel))) return `the rejected test ${rel} could not be removed`;
  return undefined;
}

/** The classification of one non-red file, per the proof's own words. */
function noteFor(cand: DeclaredPath, proof: Proof): string {
  return clip(`${cand.criterionId} ${cand.path}: ${proof.detail}`);
}

/**
 * Why a runner the step cannot trust is infrastructure and not a verdict.
 *
 * `runTestFile` never throws — a kill, a timeout and a runner that could not be
 * started all come back as `kind: "infra"` — and the caller is the thing that
 * decides throwing is right. It is, here: `specify`'s whole claim is that these
 * tests are red, and a red nobody executed proves nothing. Reading an
 * unrunnable runner as "this file was not red" would hand the run a `no-red-test`
 * VERDICT about work the toolchain never got to judge, which is the mistake the
 * classifier used to make by matching on the test's own output.
 */
function assertRan(proof: Proof, file: string): void {
  if (proof.kind === "infra")
    throw new SpecifyInfraError(`the test runner could not run ${file}: ${proof.detail}`);
}

/**
 * Run the pipeline. THROWS `SpecifyInfraError` on anything the step cannot
 * establish about git, the tree or the runner; returns a verdict about the
 * CHILD's work otherwise.
 */
export async function runTestPipeline(
  args: RunTestsArgs,
  input: { toolUses: unknown[] },
): Promise<PipelineVerdict> {
  const { exec, wt, branch, headBefore, issue } = args;

  // 1. Extract and validate at the boundary. A row whose path is not an
  //    ordinary file of THIS worktree is dropped here, before a single byte of
  //    it is read.
  const { rows, skipped } = args.extract(input.toolUses);
  const { kept, dropped } = args.validate(rows);
  const notes: string[] = [];
  const candidates = declaredPaths(
    Object.fromEntries(kept.map((row) => [row.criterionId, row.testFiles])),
  );
  const skippedNote = skipped > 0 ? ` (${skipped} malformed submit_tests call(s))` : "";
  if (candidates.length === 0) {
    return {
      kind: "empty",
      reason: `the child submitted no test file the step could keep${skippedNote}${dropNote(dropped) === "" ? "" : `; ${dropNote(dropped)}`}`,
    };
  }

  // 2. CAPTURE: the bytes of every kept file, in memory, each through one
  //    descriptor. Nothing else the child produced survives what comes next,
  //    and a file that cannot be read that way — swapped for a hard link or a
  //    symlink in the window after validation, emptied, truncated — is dropped
  //    with its reason and never becomes a test.
  const owners = new Map(candidates.map((c) => [c.path, c.criterionId]));
  let captured: Map<string, Buffer>;
  try {
    const got = (args.capture ?? captureTestBytes)(
      wt,
      candidates.map((c) => c.path),
      owners,
    );
    captured = got.captured;
    dropped.push(...got.dropped);
  } catch (err) {
    throw new SpecifyInfraError((err as Error).message);
  }

  // 3. RESET to `headBefore` — the child's commits, its staging, its untracked
  //    files, its ignore rules and its dependency links all go, and the reset is
  //    confirmed before anything is written back. The links are then rebuilt by
  //    the caller's `prepare`, so the tree the runner executes in is provisioned
  //    the same way whether it was created fresh or left behind by a crash.
  // 4. REWRITE the captured bytes — never through a link, never into a name that
  //    already exists (see `writeCaptured`).
  try {
    await resetWorktreeToBase(exec, wt, headBefore, branch);
    await args.prepare();
    writeCaptured(wt, captured);
  } catch (err) {
    if (err instanceof SpecifyResetError) throw new SpecifyInfraError(err.message);
    throw new SpecifyInfraError(
      `could not rewrite the captured tests in ${wt}: ${(err as Error).message}`,
    );
  }

  // 5. Prove red on exactly these bytes, per file, against `headBefore`. A green
  //    or unclear file is dropped and DELETED from the tree; only a runner that
  //    could not be started (or was killed) is infrastructure.
  const red: DeclaredPath[] = [];
  for (const cand of candidates) {
    if (!captured.has(cand.path)) continue; // dropped at capture — never run
    const proof = await runTestFile(exec, {
      wt,
      template: args.runnerTemplate,
      file: cand.path,
      ...(args.testLimits === undefined ? {} : { limits: args.testLimits }),
    });
    if (proof.kind === "red") {
      red.push(cand);
      continue;
    }
    assertRan(proof, cand.path);
    notes.push(noteFor(cand, proof));
    const why = removeRejected(wt, cand.path);
    if (why !== undefined) notes.push(why);
  }
  // A gap is `criterion <id> has no red test`, and under `"all-criteria"` it is
  // the FIRST clause of every rule, in both fields. `origin/main` carried that
  // rule in `failedRules` and led `reason` with it, followed by the per-file
  // drop notes; those notes are the detail and never the headline. A rule whose
  // per-file notes were in FRONT would be a reason a caller could render without
  // ever naming the criterion it is refusing for — so `evidence` is appended
  // after the fixed prefix rather than prefixed, and the prefix is exactly the
  // string main wrote, so a diff of the two shapes reads as a no-op.
  const droppedNote = noteClause("dropped", notes);
  const evidence = [droppedNote, dropNote(dropped)].filter((s) => s !== "").join(" ");
  const gapFor = (ids: string[], withEvidence: boolean): string[] =>
    ids.map(
      (id) =>
        `criterion ${id} has no red test${skippedNote}${withEvidence && evidence !== "" ? `; ${evidence}` : ""}`,
    );
  if (red.length === 0) {
    // Nothing survived the proof, so there is no coverage to report: the reason
    // states the verdict itself, then every criterion the run still owes (only
    // meaningful under `"all-criteria"` — `"any-red"` has no list to owe), then
    // the per-file evidence. Under `"any-red"` this is `challenge`'s `none`.
    const lead = (args.coverage === "all-criteria" ? args.wanted : [])
      .map((id) => `criterion ${id} has no red test`)
      .join("; ");
    return {
      kind: "empty",
      reason: `no submitted test was red against ${headBefore}${skippedNote}; ${lead === "" ? "" : `${lead}; `}${evidence}`,
    };
  }

  // 6. Coverage. ONLY `"all-criteria"` refuses a gap: `specify` requires a red
  //    for every test criterion, while `challenge` keeps whatever red it earned
  //    and lets its caller record the gap it did not close.
  if (args.coverage === "all-criteria") {
    const missing = args.wanted.filter((id) => !red.some((r) => r.criterionId === id));
    if (missing.length > 0) {
      const rules = gapFor(missing, true);
      return {
        kind: "uncovered",
        uncovered: rules,
        // Each rule already carries the evidence clause, so the reason is those
        // rules joined — the caller renders either field and says the same thing.
        reason: rules.join("; "),
      };
    }
  }

  // 7. COMMIT the red files, and assert the commit is exactly them.
  const paths = [...new Set(red.map((r) => r.path))];
  try {
    await commitTestFiles(exec, wt, headBefore, paths, args.commitMessage);
  } catch (err) {
    if (err instanceof SpecifyCommitError) throw new SpecifyInfraError(err.message);
    throw new SpecifyInfraError(`could not commit the acceptance tests: ${(err as Error).message}`);
  }

  // 8. HASH the COMMITTED blobs, not the working files: what the rest of the run
  //    compares against has to describe the commit, not whatever was on disk when
  //    the step happened to look.
  const frozen: Record<string, string> = {};
  const tests: Record<string, string[]> = {};
  for (const { criterionId, path: rel } of red) {
    frozen[rel] = sha256(await committedBlob(exec, wt, rel));
    const list = tests[criterionId] ?? [];
    if (!list.includes(rel)) list.push(rel);
    tests[criterionId] = list;
  }

  const reason = [
    `froze ${Object.keys(frozen).length} red test file(s) for ${Object.keys(tests).length} criterion/criteria`,
    skipped > 0 ? `${skipped} submit_tests call(s) skipped or refused as malformed` : "",
    droppedNote,
    dropNote(dropped),
  ]
    .filter((s) => s !== "")
    .join("; ");
  return { kind: "committed", frozen, tests, reason };
}
