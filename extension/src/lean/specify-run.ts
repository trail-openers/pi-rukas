/**
 * lean/specify-run — the CAPTURE / RESET / REWRITE / PROVE / COMMIT pipeline
 * `specify` and `challenge` share.
 *
 * Both steps pay one adversary to write test files, and both then have to turn
 * whatever it submitted into frozen, committed, provably-red tests. They differ in
 * TWO inputs, not two algorithms:
 *
 *   - what the child is shown and asked for (`specifyPrompt` vs `challengePrompt`,
 *     assembled by the caller, which also owns the dispatch);
 *   - **`headBefore`** — the commit the tree is reset back to and the commit the
 *     red proof runs against. For `specify` that is the run's base sha (its claim is
 *     that the tests are red on code nobody has written); for `challenge` the current
 *     head (a new test is only worth freezing if it is red against it).
 *
 * Everything downstream of the dispatch is identical, so it lives here once: each of
 * the eleven stages below is a response to a way a child can lie about what it wrote
 * (a symlink swapped in after validation, a commit of its own, a green file reported
 * as red, a commit that quietly contains a stray edit), and the copy that drifts is
 * the one nobody is testing. `noteClause` is exported so `challenge`'s sweep shares
 * its cap with these.
 *
 * The ref is a parameter and nothing else may vary by step: `resetWorktreeToBase`
 * is named for the base but takes any commit, and it verifies the tree got there
 * and is clean, so `challenge`'s reset to a head is exactly as proven as
 * `specify`'s reset to a base.
 *
 * The return type the two callers route on is deliberately distinct
 * (`PipelineVerdict`), and so is the COVERAGE RULE each one passes. `specify`
 * passes `"all-criteria"`: one criterion left without a red test refuses the whole
 * run. `challenge` passes `"any-red"`: an adversary that found one red edge for AC1
 * and nothing for AC2 has done its job, and refusing that run would throw away the
 * one genuine finding because the round was not exhaustive. Under `"any-red"` every
 * proven-red file is committed and the verdict is `committed` when at least one is
 * red, `empty` when none is. That judgement belongs to the caller, which is why the
 * rule is an argument and this module returns `committed` / `uncovered` / `empty`.
 */

import { existsSync, rmSync } from "node:fs";
import path from "node:path";
import type { ExecFn } from "../worktree.ts";
import type { FreezeCheck } from "./freeze-check.ts";
import { freezeCheckDrops, freezeCheckNote, runFreezeCheck } from "./freeze-check.ts";
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
import { MAX_TEST_BYTES, testBytesProblem } from "./test-size.ts";
import type { VerifyExec } from "./verify-types.ts";

export { SpecifyInfraError };
import type { DeclaredPath, DroppedRow } from "./specify-tree.ts";
import { declaredPaths } from "./specify-tree.ts";
import type { SubmitTestsRow } from "./submit-tests-extract.ts";

/** What the pipeline did, before its caller decides what the verdict means. */
type PipelineVerdict =
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
 * - `"all-criteria"` (`specify`): every id in `wanted` must have at least one red file,
 *   or the run is refused.
 * - `"any-red"` (`challenge`): at least one red file anywhere is enough. The round
 *   exists to surface SOME gap the frozen tests missed, so partial coverage is a result,
 *   not a failure — and everything proven red is kept.
 */
type CoverageRule = "all-criteria" | "any-red";

interface RunTestsArgs {
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
  validate: (rows: SubmitTestsRow[]) => Promise<{ kept: SubmitTestsRow[]; dropped: DroppedRow[] }>;
  /** Create-or-reset-and-provision; `ensureSpecifyWorktreeWithProvision` in both callers. */
  prepare: () => Promise<{ wt: string; linked: string[]; problem?: string }>;
  /** The subject of the commit the pipeline makes. */
  commitMessage: string;
  /** The single-descriptor read; `captureTestBytes` in production. */
  capture?: (wt: string, paths: string[], owners: Map<string, string>) => CaptureResult;
  /** Per-run runner limits; a test injects a short timeout to prove a hang is infra. */
  testLimits?: TestRunLimits;
  /**
   * The project's `verify.freezeCheck` command, when it configured one: a shell
   * command over the whole tree that judges test-file CONTENT. The pipeline runs
   * it twice — at the reset base with nothing in place, and again with the
   * candidate files — and a gate green at base and red with the candidates drops
   * the files it named rather than freezing an unwinnable contract. See
   * `lean/freeze-check.ts`.
   */
  freezeCheck?: string;
  /** The bound for one freeze-check run; a test shortens it to observe a hang. */
  freezeCheckTimeoutMs?: number;
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
 * A capped `label N: a; b; c` clause, exported because every note family needs the
 * same bound — the pipeline's drop notes and `challenge`'s discarded-path clause.
 */
export function noteClause(label: string, notes: string[]): string {
  if (notes.length === 0) return "";
  const shown = notes.slice(0, NOTE_CAP).map(clip);
  const more = notes.length - shown.length;
  return `${label} ${notes.length}: ${shown.join("; ")}${more > 0 ? ` (+${more} more)` : ""}`;
}

/** A dropped row as the boundary reports it: the criterion, the path if it had one, the reason. */
export interface DropLabel {
  criterionId: string;
  path?: string;
  reason: string;
}

/**
 * The attributed form of one drop, `<criterionId> <path>: <reason>` with the
 * path omitted when there is none. The retry's feedback and the step's reason
 * both print it, so the child and an operator read the same attribution.
 */
export function droppedLabel(d: DropLabel): string {
  return `${d.criterionId}${d.path === undefined ? "" : ` ${d.path}`}: ${d.reason}`;
}

/**
 * A `dropped N (…) — a; b; c` clause, with NO leading space: each call site
 * supplies the separator its own position needs, so the clause does not carry
 * padding that a caller then has to trim before joining.
 */
function dropNote(dropped: DropLabel[]): string {
  if (dropped.length === 0) return "";
  const parts = dropped.slice(0, NOTE_CAP).map((d) => clip(droppedLabel(d)));
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
 * VERDICT about work the toolchain never got to judge.
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
  // The boundary reads git (`existsAtBase`), so an unreadable base commit
  // arrives as a rejection from inside it — and that is infrastructure, not a
  // verdict. A git failure that fell through as "nothing was submitted" would
  // report a broken repository as an adversary that found nothing.
  let kept: SubmitTestsRow[];
  let dropped: DroppedRow[];
  try {
    ({ kept, dropped } = await args.validate(rows));
  } catch (err) {
    if (err instanceof SpecifyInfraError) throw err;
    if (err instanceof SpecifyResetError) throw new SpecifyInfraError(err.message);
    throw new SpecifyInfraError(
      `could not validate the submitted tests: ${(err as Error).message}`,
    );
  }
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
  //
  //    The size rules bounded the file the boundary READ (their bound is per
  //    validation), and the child owns this window: it can grow a kept file
  //    between that read and this one. `readOneDescriptor` proves one file was
  //    stable across its own read and `MAX_CAPTURE_BYTES` is a far looser
  //    ceiling, so the byte bound is asserted again on the bytes actually held
  //    before a single one of them is rewritten into the tree. A file that grew
  //    past the bound is refused here, in the same words the boundary uses.
  const owners = new Map(candidates.map((c) => [c.path, c.criterionId]));
  let captured: Map<string, Buffer>;
  try {
    const got = (args.capture ?? captureTestBytes)(
      wt,
      candidates.map((c) => c.path),
      owners,
    );
    captured = new Map();
    for (const [rel, bytes] of got.captured) {
      if (bytes.length > MAX_TEST_BYTES) {
        dropped.push({
          criterionId: owners.get(rel) ?? "unknown",
          path: rel,
          reason: testBytesProblem(rel, bytes.length),
        });
        continue;
      }
      captured.set(rel, bytes);
    }
    dropped.push(...got.dropped);
  } catch (err) {
    throw new SpecifyInfraError((err as Error).message);
  }

  // 3. RESET to `headBefore` — the child's commits, its staging, its untracked
  //    files, its ignore rules and its dependency links all go, and the reset is
  //    confirmed before anything is written back. The links are then rebuilt by
  //    the caller's `prepare`, so the tree the runner executes in is provisioned
  //    the same way whether it was created fresh or left behind by a crash.
  // The freeze check's BASE run — the comparison that turns "the gate is red"
  // into "YOUR files made it red". It happens in the one window where the tree
  // is known to hold none of the candidates: after the reset to `headBefore` and
  // `prepare`, before a single captured byte is written back. Any earlier and it
  // would judge the child's own leftover writes rather than the base, which is
  // how a run comes to blame a candidate for a red the adversary itself caused.
  // A gate red at base is the mainline's own red, never attributed and never
  // blocking (`verify`'s baseline probe owns that question); one that could not
  // run blocks nothing but is disclosed below either way.
  let baseCheck: FreezeCheck | undefined;
  let baseCheckRan = false;
  try {
    await resetWorktreeToBase(exec, wt, headBefore, branch);
    await args.prepare();
    if (args.freezeCheck !== undefined && captured.size > 0) {
      baseCheckRan = true;
      baseCheck = await runFreezeCheck(
        args.freezeCheck,
        wt,
        exec as VerifyExec,
        ...(args.freezeCheckTimeoutMs === undefined ? [] : [args.freezeCheckTimeoutMs]),
      );
    }
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
  let red: DeclaredPath[] = [];
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
  // 5b. THE FREEZE CHECK. A candidate that trips a gate the project runs over
  //     test-file CONTENT must never join the contract: `build` may not edit a
  //     frozen file, so the run would have no round left that could make the gate
  //     green. A gate that was green at base and is red with the candidates drops
  //     the candidates its own output named — or all of them, when it named none,
  //     since a gate that failed over this tree failed because of what is in it.
  //
  //     Runs BEFORE the evidence clause is assembled: a drop is a `dropped N (…)`
  //     row like any other, and the coverage rules below quote that clause, so a
  //     check appended afterwards would leave the refusal it causes unattributed
  //     in the very field the retry's prompt is built from.
  let checkNote = "";
  if (args.freezeCheck !== undefined && red.length > 0) {
    const paths = [...new Set(red.map((r) => r.path))];
    const withCandidates = await runFreezeCheck(
      args.freezeCheck,
      wt,
      exec as VerifyExec,
      ...(args.freezeCheckTimeoutMs === undefined ? [] : [args.freezeCheckTimeoutMs]),
    );
    const droppedByCheck = freezeCheckDrops(
      baseCheck ?? { kind: "unknown", detail: "" },
      withCandidates,
      args.freezeCheck,
      paths,
    );
    if (droppedByCheck !== undefined) {
      const gone = new Set(droppedByCheck.map((d) => d.path ?? ""));
      for (const rel of gone) {
        const why = removeRejected(wt, rel);
        if (why !== undefined) notes.push(why);
      }
      dropped.push(...droppedByCheck);
      red = red.filter((r) => !gone.has(r.path));
    } else {
      // Green at base too, or a gate that could not answer: nothing is blocked
      // either way, but a check that never answered is disclosed, not silenced.
      checkNote = freezeCheckNote(args.freezeCheck, baseCheckRan, withCandidates);
    }
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
      reason: [
        `no submitted test was red against ${headBefore}${skippedNote}`,
        lead,
        [evidence, checkNote].filter((s) => s !== "").join(" "),
      ]
        .filter((s) => s !== "")
        .join("; "),
    };
  }

  // `4. REWRITE the captured bytes` is documented above the reset; the step
  // numbering is kept in one place rather than restated here.

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
    checkNote,
  ]
    .filter((s) => s !== "")
    .join("; ");
  return { kind: "committed", frozen, tests, reason };
}
