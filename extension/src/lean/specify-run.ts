/**
 * lean/specify-run — the CAPTURE / RESET / REWRITE / PROVE / COMMIT pipeline
 * `specify` and `challenge` share.
 *
 * Both steps pay one adversary to write test files and must turn whatever it submitted into frozen,
 * committed, provably-red tests. They differ in TWO inputs, not two algorithms:
 *
 *   - what the child is shown and asked for (`specifyPrompt` vs `challengePrompt`, assembled by the caller,
 *     which also owns the dispatch);
 *   - **`headBefore`** — the commit the tree is reset to and the red proof runs against: `specify`'s base
 *     sha, `challenge`'s current head.
 *
 * Everything downstream of the dispatch is identical, so it lives here once: each stage answers a way a child
 * can lie about what it wrote (a symlink swapped in after validation, a commit of its own, a green file
 * reported as red). `noteClause` is exported so `challenge`'s sweep shares the cap.
 *
 * The ref is a parameter and nothing else may vary by step: `resetWorktreeToBase` verifies the tree got there
 * and is clean, whichever commit it was given.
 *
 * The COVERAGE RULE is an argument, not a branch: `specify` passes `"all-criteria"` (one criterion without a red
 * test refuses the run); `challenge` passes `"any-red"` — an adversary that found one red edge for AC1 and
 * nothing for AC2 has done its job. The judgement belongs to the caller, which is why this returns `committed` /
 * `uncovered` / `empty`.
 */
import { existsSync, rmSync } from "node:fs";
import path from "node:path";
import {
  preservedCriteria,
  preservedFiles,
  uncoveredExcludingPreserved,
} from "../lean-preserved-step.ts";
import type { ExecFn } from "../worktree.ts";
import type { FreezeCheck } from "./freeze-check.ts";
import { freezeCheckDrops, freezeCheckNote, runFreezeCheck } from "./freeze-check.ts";
import { type CaptureResult, captureTestBytes } from "./specify-capture.ts";
import { commitTestFiles, committedBlob } from "./specify-commit.ts";
import { formatSubmitted } from "./specify-format.ts";
import type { Proof, TestRunLimits } from "./specify-proof.ts";
import { runTestFile, sha256 } from "./specify-proof.ts";
import {
  SpecifyCommitError,
  SpecifyInfraError,
  SpecifyResetError,
  resetWorktreeToBase,
  writeCaptured,
} from "./specify-reset.ts";
import type { DeclaredPath, DroppedRow } from "./specify-tree.ts";
import { declaredPaths } from "./specify-tree.ts";
import type { SubmitTestsRow } from "./submit-tests-extract.ts";
import { MAX_TEST_BYTES, testBytesProblem } from "./test-size.ts";
import type { VerifyExec } from "./verify-types.ts";

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
   * Only `"all-criteria"` returns this: a wanted criterion ended with no red file, and under that rule a gap
   * is a refusal, not a partial freeze. `reason` leads with the same `criterion <id> has no red test` lines.
   */
  | { kind: "uncovered"; uncovered: string[]; reason: string };

/**
 * What the pipeline requires of its coverage, decided by the caller.
 *
 * - `"all-criteria"` (`specify`): every id in `wanted` needs at least one red file, or the run is refused.
 * - `"any-red"` (`challenge`): one red file anywhere is enough. The round exists to surface SOME gap the
 *   frozen tests missed, so partial coverage is a result, not a failure.
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
   * The commit the tree is reset to, the commit the red proof runs against, and the parent the
   * frozen commit is checked against.
   */
  headBefore: string;
  /** The project's `verify.test` template. Required — every caller checks first. */
  runnerTemplate: string;
  /** The ids of the criteria the step requires a red test for. */
  wanted: string[];
  /**
   * The coverage rule, passed IN rather than inferred from the caller: the pipeline must not grow an
   * `if challenge` branch, or the two steps drift apart in the one place they share.
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
   * The project's `verify.freezeCheck` command, if configured: a shell command over the whole tree judging
   * test-file CONTENT, run twice — at the reset base and with the candidates — so a gate green at base and
   * red with the candidates drops the files it named instead of freezing an unwinnable contract.
   */
  freezeCheck?: string;
  /** The bound for one freeze-check run; a test shortens it to observe a hang. */
  freezeCheckTimeoutMs?: number;
  /** The project's `verify.format` template, run on each captured file before its red proof. */
  formatTemplate?: string;
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

/** A capped `label N: a; b; c` clause — every note family needs the same bound. */
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

/** The attributed form of one drop, `<criterionId> <path>: <reason>`, path omitted when there is none. */
export function droppedLabel(d: DropLabel): string {
  return `${d.criterionId}${d.path === undefined ? "" : ` ${d.path}`}: ${d.reason}`;
}

/**
 * A `dropped N (…) — a; b; c` clause with NO leading space: each call site supplies its own separator.
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
 * `runTestFile` never throws — a kill, a timeout and an un-startable runner all come back as
 * `kind: "infra"` — and throwing is right here: `specify`'s claim is that these tests are red, and a red
 * nobody executed proves nothing. Reading an unrunnable runner as "not red" hands the run a verdict about
 * work the toolchain never judged.
 */
function assertRan(proof: Proof, file: string): void {
  if (proof.kind === "infra")
    throw new SpecifyInfraError(`the test runner could not run ${file}: ${proof.detail}`);
}

/**
 * Run the pipeline. THROWS `SpecifyInfraError` on anything the step cannot establish about git, the tree or
 * the runner; otherwise returns a verdict about the CHILD's work.
 */
export async function runTestPipeline(
  args: RunTestsArgs,
  input: { toolUses: unknown[] },
): Promise<PipelineVerdict> {
  const { exec, wt, branch, headBefore } = args;

  // 1. Extract and validate at the boundary: a row whose path is not an ordinary file of THIS worktree is
  //    dropped before a byte of it is read.
  const { rows, skipped } = args.extract(input.toolUses);
  // The boundary reads git (`existsAtBase`), so an unreadable base arrives as a rejection from inside it —
  // infrastructure, not a verdict: a git failure falling through as "nothing was submitted" reports a broken
  // repository as an adversary that found nothing.
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
  // The preservation rule, and the reason one declared file keeps its bytes: `lean-preserved-step.ts`.
  const declaredPreserves = new Map(kept.map((row) => [row.criterionId, row.preserves === true]));
  const isPreserved = (id: string): boolean => declaredPreserves.get(id) === true;
  if (candidates.length === 0) {
    return {
      kind: "empty",
      reason: `the child submitted no test file the step could keep${skippedNote}${dropNote(dropped) === "" ? "" : `; ${dropNote(dropped)}`}`,
    };
  }

  // 2. CAPTURE: the bytes of every kept file, in memory, each through one descriptor. Nothing else the
  //    child produced survives what comes next, and a file unreadable that way — swapped for a hard link or
  //    symlink after validation — is dropped with its reason.
  //
  //    The size rules bounded the file the boundary READ; the child owns this window and can grow a kept
  //    file between that read and this one. `readOneDescriptor` proves stability across its own read, so the
  //    byte bound is asserted again on the bytes actually held, in the boundary's words.
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

  // 3. RESET to `headBefore` — the child's commits, staging, untracked files, ignore rules and dependency
  //    links all go, confirmed before anything is written back. `prepare` rebuilds the links, so the tree
  //    the runner executes in is provisioned the same way whether fresh or left by a crash.
  // The freeze check's BASE run — the comparison turning "the gate is red" into "YOUR files made it red".
  // It runs in the one window where the tree holds none of the candidates: after the reset and `prepare`,
  // before a captured byte returns. Any earlier it judges the child's leftover writes, not the base.
  // A gate red at base is the mainline's own red — never attributed, never blocking (`verify`'s baseline
  // probe owns that); one that could not run is disclosed either way.
  let baseCheck: FreezeCheck | undefined;
  let baseCheckRan = false;
  // What the preparation's submodule pass could not supply. The reset above and the
  // `prepare` below are where an unseeded gitlink is discovered, and this is the last
  // place before the commit that will be built on that tree — so the caveat has to ride
  // out on the reason, where the operator and the next step both read it. A step that
  // knew the tree was incomplete and reported a clean `ok` is the failure this guards:
  // the child's red would then read as a failing feature rather than a missing vendored
  // import, and the commit would be reproduced against bytes nobody has.
  let treeProblem: string | undefined;
  try {
    await resetWorktreeToBase(exec, wt, headBefore, branch);
    treeProblem = (await args.prepare()).problem;
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
    if (args.formatTemplate !== undefined)
      for (const r of await formatSubmitted(exec, wt, args.formatTemplate, [...captured.keys()])) {
        captured.delete(r.path);
        dropped.push({ criterionId: owners.get(r.path) ?? "unknown", ...r });
        removeRejected(wt, r.path);
      }
  } catch (err) {
    // A handback this window already named keeps its own words: re-wrapping the submodule pass's error as
    // "could not rewrite the captured tests" blames the file write that ran after it. Only an error this
    // window owns is wrapped.
    if (err instanceof SpecifyInfraError) throw err;
    if (err instanceof SpecifyResetError) throw new SpecifyInfraError(err.message);
    throw new SpecifyInfraError(
      `could not rewrite the captured tests in ${wt}: ${(err as Error).message}`,
    );
  }

  // 5. Prove red on exactly these bytes, per file, against `headBefore`. A green or unclear file is dropped
  //    and DELETED from the tree; only an unrunnable runner is infrastructure. Each verdict is kept so the
  //    preservation rule reads it from this one run, never from a second run.
  const proved = new Map<string, Proof>();
  let red: DeclaredPath[] = [];
  for (const cand of candidates) {
    if (!captured.has(cand.path)) continue; // dropped at capture — never run
    const proof = await runTestFile(exec, {
      wt,
      template: args.runnerTemplate,
      file: cand.path,
      ...(args.testLimits === undefined ? {} : { limits: args.testLimits }),
    });
    proved.set(cand.path, proof);
    if (proof.kind === "red") {
      red.push(cand);
      continue;
    }
    assertRan(proof, cand.path);
    // A declared must-pass file keeps its bytes; any other refused file is DELETED.
    if (isPreserved(cand.criterionId)) continue;
    notes.push(noteFor(cand, proof));
    const why = removeRejected(wt, cand.path);
    if (why !== undefined) notes.push(why);
  }
  // 5b. THE FREEZE CHECK. A candidate that trips a gate the project runs over test-file CONTENT never joins
  //     the contract: `build` may not edit a frozen file, so the run would have no round left that could
  //     make the gate green. A gate green at base and red with the candidates drops those its own output
  //     named — or all of them, when it named none.
  //
  //     Runs BEFORE the evidence clause is assembled: the coverage rules quote it, so a check appended after
  //     would leave the refusal it causes unattributed in the retry's prompt.
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
      // Green at base too, or a gate that could not answer: nothing is blocked either way, but a
      // check that never answered is disclosed, not silenced.
      checkNote = freezeCheckNote(args.freezeCheck, baseCheckRan, withCandidates);
    }
  }

  // A gap is `criterion <id> has no red test`, and under `"all-criteria"` the FIRST clause of every rule in
  // both fields: a rule whose per-file notes came first could render without naming the criterion it refuses.
  const droppedNote = noteClause("dropped", notes);
  const evidence = [droppedNote, dropNote(dropped)].filter((s) => s !== "").join(" ");
  const gapFor = (ids: string[], withEvidence: boolean): string[] =>
    ids.map(
      (id) =>
        `criterion ${id} has no red test${skippedNote}${withEvidence && evidence !== "" ? `; ${evidence}` : ""}`,
    );
  if (red.length === 0) {
    // Nothing survived the proof, so there is no coverage to report: verdict, then every criterion the run
    // still owes, then the per-file evidence.
    const lead = (args.coverage === "all-criteria" ? args.wanted : [])
      .map((id) => `criterion ${id} has no red test`)
      .join("; ");
    return {
      kind: "empty",
      reason: [
        `no submitted test was red against ${headBefore}${skippedNote}`,
        lead,
        // Every kind's reason carries the tree's caveat, and `empty` needs it most: a submitted test
        // that died on a missing vendored import reads exactly like an adversary that wrote nothing
        // red, unless the reason says the submodule was never populated.
        treeProblem ?? "",
        [evidence, checkNote].filter((s) => s !== "").join(" "),
      ]
        .filter((s) => s !== "")
        .join("; "),
    };
  }

  // 6. Coverage. ONLY `"all-criteria"` refuses a gap: `specify` needs a red for every test criterion, while
  //    `challenge` keeps whatever red it earned. Only a DECLARED preserved criterion is excused here.
  const provedFiles = candidates
    .filter((c) => captured.has(c.path))
    .map((c) => ({
      path: c.path,
      criterionId: c.criterionId,
      kind: proved.get(c.path)?.kind ?? "green",
      preserves: isPreserved(c.criterionId),
    }));
  const mustPass = preservedFiles(provedFiles);
  const covered = [...new Set([...red, ...provedFiles.filter((f) => mustPass.includes(f.path))])];
  const preservedIds = preservedCriteria(covered);
  if (args.coverage === "all-criteria") {
    const missing = uncoveredExcludingPreserved(
      args.wanted,
      [...new Set(covered.map((c) => c.criterionId))],
      preservedIds,
    );
    if (missing.length > 0) {
      const rules = gapFor(missing, true);
      return {
        kind: "uncovered",
        uncovered: rules,
        // Each rule already carries the evidence clause, so the caller renders either field and
        // says the same thing.
        reason: rules.join("; "),
      };
    }
  }

  // 7. COMMIT the red and preserved must-pass files, and assert the commit is exactly them.
  const paths = [...new Set([...red.map((r) => r.path), ...mustPass])];
  try {
    await commitTestFiles(exec, wt, headBefore, paths, args.commitMessage);
  } catch (err) {
    if (err instanceof SpecifyCommitError) throw new SpecifyInfraError(err.message);
    throw new SpecifyInfraError(`could not commit the acceptance tests: ${(err as Error).message}`);
  }

  // 8. HASH the COMMITTED blobs, not the working files: what the rest of the run compares against must
  //    describe the commit, not whatever was on disk when the step looked.
  const frozen: Record<string, string> = {};
  const tests: Record<string, string[]> = {};
  const contract = [...red, ...candidates.filter((c) => mustPass.includes(c.path))];
  for (const { criterionId, path: rel } of contract) {
    frozen[rel] = sha256(await committedBlob(exec, wt, rel));
    const list = tests[criterionId] ?? [];
    if (!list.includes(rel)) list.push(rel);
    tests[criterionId] = list;
  }

  const reason = [
    `froze ${Object.keys(frozen).length} red test file(s) for ${Object.keys(tests).length} criterion/criteria`,
    preservedIds.length > 0
      ? `preserved ${preservedIds.length} criterion/criteria (${preservedIds.join(", ")}), frozen as must-pass at head`
      : "",
    skipped > 0 ? `${skipped} submit_tests call(s) skipped or refused as malformed` : "",
    droppedNote,
    dropNote(dropped),
    checkNote,
    treeProblem ?? "",
  ]
    .filter((s) => s !== "")
    .join("; ");
  return { kind: "committed", frozen, tests, reason };
}
