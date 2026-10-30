#!/usr/bin/env bun
/**
 * lean/submit-tests-cap — the boundary a `submit_tests` row passes through, the
 * bounds the call carries, and the per-call memo the base-commit newness probe
 * runs through.
 *
 * Split out of `specify-tree.ts` because every half here exists for one reason:
 * the rule set over a submitted path is cheap, but the newness rule is a git
 * read, and both the number of names in a row and the number of rows in a call
 * come from an untrusted child. `specify-tree.ts` keeps the worktree primitives
 * and re-exports `validateSubmitRows` from here, so the callers never moved.
 *
 * The three size rules (`MAX_TEST_LINES`, `MAX_TEST_BYTES`,
 * `MAX_TEST_FILES_PER_CRITERION`, with
 * `countTestLines` and the refusal sentences in `test-size.ts`, applied by
 * `sizeJudgement` in `submit-tests-size.ts`) judge the
 * CHILDREN'S work rather than the call's cost: what a run freezes is a property
 * of the tests, and a thousand lines of them is the failure the boundary exists
 * to refuse. They are applied here, where a submitted path is finally a file,
 * and defined there, where the prompt that quotes the numbers and the tests
 * that pin them have one place to import from.
 */

import path from "node:path";
import { type TestLocation, testLocationProblem } from "./config-test-location.ts";
import type { PiSpec } from "./spec.ts";
import { normaliseRelPath, pathProblem } from "./specify-path.ts";
import { SpecifyInfraError } from "./specify-reset.ts";
import type { SubmitTestsRow } from "./submit-tests-extract.ts";
import { sizeJudgement, statSizeOf } from "./submit-tests-size.ts";
import { MAX_TEST_FILES_PER_CRITERION, testFileQuotaProblem } from "./test-size.ts";
/**
 * How many test files one submitted row may name.
 *
 * The boundary runs its whole rule set — including a git read per path — over
 * every name a row carries, and a row comes from an untrusted child. An
 * unbounded list is an unbounded number of git calls from one tool call, so the
 * row is refused outright rather than processed: a criterion genuinely needs a
 * handful of files, and the cap is not close to that.
 *
 * It counts the files of ONE row (one `submit_tests` call for one criterion),
 * not the files a criterion ends up with: a child that legitimately needs more
 * makes more calls, and each row is judged on its own.
 */
export const MAX_TEST_FILES_PER_ROW = 8;

/**
 * How many DISTINCT test paths one `submit_tests` call may get probed for.
 *
 * The row cap bounds one row; it does not bound the call, and a call carries
 * any number of rows. The newness rule costs one git read per distinct path,
 * so 3,000 rows of 8 names would be 24,000 git reads from a single tool call.
 * The memo's size is the count that matters: git is asked about each distinct
 * normalised path once, so the call is bounded where the work actually costs.
 * A real submission names a handful of files for a handful of criteria; once
 * the call passes this many distinct paths the surplus is refused without a
 * probe, so exceeding the bound is free.
 */
export const MAX_TEST_FILES_PER_CALL = 32;

/**
 * A memoised `existsAtBase` for ONE boundary call, plus the count of distinct
 * paths it has actually asked git about.
 *
 * One git read per distinct path per call, not per mention: two rows (or one
 * row twice) naming `tests/AC1-x.test.ts` used to ask the base twice about the
 * same name. The answer is a fact about (base, rel), so one call's cache is
 * exactly as fresh as the tree it reads — and it must not outlive the call,
 * because between two calls the step may have committed, and a stale "new" is
 * the fraud the rule exists to refuse.
 *
 * `probed` is what the call cap counts against: `has(rel)` distinguishes a
 * name already asked about (free, and must stay free) from a new one, which is
 * only allowed while `probed` sits under `MAX_TEST_FILES_PER_CALL`.
 */
export function baseProbe(existsAtBase: ((rel: string) => Promise<boolean>) | undefined): {
  ask: ((rel: string) => Promise<boolean>) | undefined;
  has: (rel: string) => boolean;
  probed: () => number;
} {
  const answers = new Map<string, Promise<boolean>>();
  return {
    ask:
      existsAtBase === undefined
        ? undefined
        : (rel: string): Promise<boolean> => {
            const hit = answers.get(rel);
            if (hit !== undefined) return hit;
            const asked = existsAtBase(rel);
            answers.set(rel, asked);
            return asked;
          },
    has: (rel: string) => answers.has(rel),
    probed: () => answers.size,
  };
}

export interface DroppedRow {
  criterionId: string;
  path?: string;
  reason: string;
}

/**
 * The boundary's newness refusal. The step composes it as `<path> ${NEWNESS_REASON}`;
 * the tests import it rather than restating it, so the sentence the boundary
 * states and the sentence an operator is shown cannot drift apart.
 */
export const NEWNESS_REASON =
  "already exists at the base commit; a new acceptance test must be a new file";

/**
 * The boundary every submitted path passes through.
 *
 * A row is dropped, with a reason, when its criterion is not a `verify:
 * "test"` criterion of THIS spec, or when one of these rules fires — in this
 * order, and the FIRST that fires is the reason an operator reads:
 *
 *   1. path shape (absolute, traversal, forbidden directory);
 *   2. FROZEN (`frozenPaths` — only `challenge` passes that set: the child may
 *      not replace a test the run already committed) — BEFORE the location rule,
 *      so an inherited contract outside the configured folder is reported as the
 *      contract it is, not as a file to move;
 *   3. location (`testLocationProblem`);
 *   4. existence in the worktree (`exists`);
 *   5. base newness (`existsAtBase`) — a test the child did not write is not a
 *      new acceptance test;
 *   6. file shape (`fileProblem`);
 *   7. size (`sizeRules` aside — see below) — the boundary stats the file FIRST
 *      and refuses anything over `MAX_TEST_BYTES` without reading it, then reads
 *      what the stat admitted through the capture's own `readOneDescriptor` and
 *      counts lines (`MAX_TEST_LINES`). The byte bound is what makes the read
 *      bounded per CALL rather than merely bounded per kept file: at most
 *      `MAX_TEST_FILES_PER_CRITERION` files per criterion, each at most
 *      `MAX_TEST_BYTES`, is the most one validation ever reads. A NUL byte is
 *      dropped here too, as not a text file: the count cannot be honest about
 *      it, so the file is refused rather than guessed at;
 *   8. the per-criterion file quota (`MAX_TEST_FILES_PER_CRITERION`) — the
 *      first files kept for the criterion fill it, so the count is across the
 *      whole call, not per row, and across the whole RUN once `frozenByCriterion`
 *      seeds it. It is judged AFTER the size rule, so an over-long third file is
 *      reported as too long rather than as surplus, and it is NOT conditional on
 *      the size rules: a count is a count whether or not the bytes were read.
 *
 * A stat or a read whose error carries `ENOENT`, `ENOTDIR` or `ELOOP` is a DROP
 * — the submitted name does not resolve, which is a fact about the child's file,
 * and the capture reading the same name would refuse it for the same reason.
 * Any other failure — an EIO, an EMFILE, an EACCES — is infrastructure and
 * THROWS `SpecifyInfraError`, which `specify-run.ts` maps to a handback. It is
 * never a drop. No raw `err.message` is ever interpolated into a drop reason.
 *
 * `wt` is REQUIRED: the size rules read the candidate out of that tree, and a
 * caller that cannot name a tree cannot ask this question at all (a unit test
 * passes a real temp dir — a boundary whose rules switch themselves off on a
 * missing argument is a boundary a caller can silently opt out of). `sizeRules:
 * false` is the one deliberate exception, and it is test-only: it switches off
 * the stat and the read and NOTHING else. The per-criterion QUOTA is a rule
 * about how MANY files a criterion ends up with, not about their bytes, so it
 * applies with the size rules off exactly as it does with them on — a caller
 * that could not see the bytes must still not freeze four files for one
 * criterion. Both the steps pass `wt` and neither passes `sizeRules`.
 *
 * The boundary and the capture judge a kept file through the SAME code —
 * `readOneDescriptor`, the capture's own single-descriptor read — but the read
 * happens twice, once per consumer: a second open is the honest cost of deciding
 * before a byte is captured, and the capture's own `fstat` checks (one inode,
 * one hard link, and the same `ino`/`size`/`mtimeMs` before and after its read)
 * are what catch a file swapped in the window between the two. It costs one
 * extra read per KEPT file, and the quota keeps that number bounded.
 *
 * What survives is a criterion -> kept-paths map the step can capture, prove
 * and commit.
 *
 * `exists` and `existsAtBase` are async because the second is a git read, and
 * both go through here rather than the callers: a rule the boundary can skip is
 * a rule that gets skipped.
 */
export async function validateSubmitRows(
  rows: SubmitTestsRow[],
  opts: {
    spec: PiSpec;
    exists: (rel: string) => boolean | Promise<boolean>;
    fileProblem?: (rel: string) => string | undefined;
    /**
     * Paths already frozen. `challenge` passes the run's frozen map here: a
     * submitted path that is already frozen is REFUSED, because accepting it
     * would let the adversary commit a replacement over a test the run proved
     * red — the one act that would silently rewrite the contract the builder is
     * measured against. `specify` omits it: nothing is frozen when it runs.
     */
    frozenPaths?: ReadonlySet<string>;
    /**
     * Where the project keeps its tests (`verify.testDir` + `verify.testGlob`).
     * When set, a submitted test that is not DIRECTLY inside that directory, or
     * whose basename does not match the pattern, is REFUSED with a reason — the
     * same treatment an invalid path gets. `specify` and `challenge` both pass
     * it when the project configured one, so the prompt's instruction and the
     * boundary that enforces it read the same config.
     */
    testLocation?: TestLocation;
    /**
     * A kept path must not exist at the run's BASE COMMIT (`existsInCommit`,
     * `specify-path.ts`), and it is what makes an acceptance test a test the
     * child WROTE. `specify` and `challenge` both pass it.
     *
     * `exists` alone does not: it asks about the working tree, and the child
     * works in a checkout of that base — so an existing, green, tracked project
     * test the child never opened passes `exists`, gets proved red against a
     * source file it does not exercise (never run: red by absence of evidence,
     * which is the red the proof accepts), and is frozen as the run's contract.
     * The mirrored act — overwriting a tracked test and submitting it — was
     * reproduced too. Both are refused here, before a byte is captured.
     */ existsAtBase?: (rel: string) => Promise<boolean>;
    /**
     * The worktree whose files the size rules judge. REQUIRED: the boundary
     * stats the candidate, refuses it on `MAX_TEST_BYTES` alone, and reads what
     * the stat admitted through `readOneDescriptor` — the capture's own
     * single-descriptor read, so the boundary and the capture judge a kept file
     * through the SAME code; the read itself happens once per consumer, and the
     * capture's own `fstat` checks catch a file swapped in that window.
     *
     * There is no "no tree" shape of this call: a rule that quietly switches
     * itself off when its argument is absent is a rule a caller can forget to
     * apply, and both real callers have a worktree in hand. A unit test passes a
     * temp dir it wrote its fixtures into.
     */
    wt: string;
    /**
     * TEST-ONLY escape: refuse the stat and the read, and judge every other
     * rule — including the per-criterion quota — as normal. It exists so a test
     * of a non-size rule does not have to build files that satisfy the size
     * rules; production never sets it, and `specify` and `challenge` both leave
     * it out. With it off (the default) the size rules are applied to every
     * candidate the cheap rules admit.
     */
    sizeRules?: false;
    /**
     * The byte size the size rules judge a candidate against BEFORE reading it.
     * Defaults to `statSizeOf` (`lstat`, like `fileProblem`). A test drives it to
     * prove a file is refused on size without the fixture on disk, or to prove an
     * unreadable stat is infrastructure rather than a drop. Its value is never
     * interpolated into a reason: it is a number, and the sentence built from it
     * is `testBytesProblem`'s.
     */
    statSize?: (abs: string) => number;
    /**
     * What the RUN has already frozen per criterion, from the step log's
     * `tests` maps (`frozenFromLog`'s partners in `build.ts` / `publish.ts`).
     *
     * The quota is a bound on what a criterion ENDS UP WITH across the run, and
     * a fresh call sees none of what an earlier round committed, so without this
     * seed the cap is a per-call number that a second round silently doubles.
     * Each criterion starts its count at the number of files already recorded
     * for it; a criterion that is already full refuses every submission with the
     * existing quota reason. Paths here are counted, not re-checked: they come
     * from the run's own record, already captured, proved and committed.
     *
     * Omit it (a unit test, or a first `specify` — nothing is frozen yet) and
     * the count starts at zero, exactly as before.
     */
    frozenByCriterion?: Record<string, readonly string[]>;
  },
): Promise<{ kept: SubmitTestsRow[]; dropped: DroppedRow[] }> {
  const testable = new Set(opts.spec.criteria.filter((c) => c.verify === "test").map((c) => c.id));
  const keptByCriterion = new Map<string, string[]>();
  // ONE counter per criterion: the quota is a RUN-level bound, so a criterion
  // starts at what the run already froze and every keep in this call lands on
  // the same number. Two structures used to carry it (a kept-paths array per
  // criterion and a `Set` per seeded criterion) that had to be ADDED together at
  // the check, which is the shape a bound acquires an off-by-one in.
  const quota = new Map<string, number>();
  for (const [id, files] of Object.entries(opts.frozenByCriterion ?? {})) {
    quota.set(id, files.length);
  }
  // Paths already kept for a criterion IN THIS CALL — the dedupe. A path a
  // later row names again is a fresh REQUEST the quota judges (that is how AC4
  // fills its two files from `[small, fill, mid]` across rows in
  // `test-lean-test-size.ts`, and how a `./`-spelling of an already-kept good
  // path is refused rather than silently dropped — both pre-existing behaviour,
  // both pinned). What this set forbids is one name appearing TWICE inside one
  // criterion's kept row, because that row is what the step captures and
  // commits; `files` is keyed by criterion, so the check is per criterion and
  // lives on this map rather than on a per-row scratch set that a later row
  // cleared — which is what let a duplicated name reach the kept row twice.
  const keptRels = new Map<string, Set<string>>();
  // One git read per distinct path per call, and the call is bounded by
  // `MAX_TEST_FILES_PER_CALL` above.
  const base = baseProbe(opts.existsAtBase);
  const existsAtBaseCached = base.ask;
  const dropped: DroppedRow[] = [];
  for (const row of rows) {
    if (!testable.has(row.criterionId)) {
      dropped.push({
        criterionId: row.criterionId,
        reason:
          opts.spec.criteria.some((c) => c.id === row.criterionId) === true
            ? `criterion ${row.criterionId} is not a test criterion`
            : `unknown criterion ${row.criterionId} — not in the spec`,
      });
      continue;
    }
    const files = keptByCriterion.get(row.criterionId) ?? [];
    if (row.testFiles.length > MAX_TEST_FILES_PER_ROW) {
      dropped.push({
        criterionId: row.criterionId,
        reason: `criterion ${row.criterionId} submitted ${row.testFiles.length} test files; at most ${MAX_TEST_FILES_PER_ROW} are accepted per submit_tests row`,
      });
      continue;
    }
    for (const raw of row.testFiles) {
      // The absolute check runs on the RAW string: `path.isAbsolute` on a
      // normalised `//etc/passwd` would have collapsed it to `etc/passwd` and
      // reported it as a relative path that merely does not exist.
      const absolute =
        raw.startsWith("/") ||
        raw.startsWith("\\") ||
        path.isAbsolute(raw) ||
        /^[A-Za-z]:[\\/]/.test(raw);
      if (absolute) {
        dropped.push({
          criterionId: row.criterionId,
          path: raw,
          reason: `absolute path ${raw} is not a worktree-relative test file`,
        });
        continue;
      }
      const rel = normaliseRelPath(raw);
      const problem = rel === "" ? `empty path ${JSON.stringify(raw)}` : pathProblem(rel);
      if (problem !== undefined) {
        dropped.push({ criterionId: row.criterionId, path: raw, reason: problem });
        continue;
      }
      // Checked on the NORMALISED path, so `./tests/AC1-x.test.sh` and
      // `tests/AC1-x.test.sh` cannot both name one frozen file, and refused
      // BEFORE the existence check: a frozen path does exist in the worktree, so
      // the order is what makes the reason say "you may not replace a frozen
      // test" rather than the misleading "this file is not a regular file".
      // Checked on the NORMALISED path, so a test written into a NESTED folder
      // of the configured directory cannot read as inside it (`tests/sub/x.ts`
      // is not `tests/`), and so `./tests/x.ts` cannot dodge the name pattern.
      // After `pathProblem`, so the path is already traversal-free and slash-
      // clean, which is what `testLocationProblem` compares segments against.
      // FROZEN first, and deliberately before the location rule: a contract the
      // run inherited before `verify.testDir` existed sits OUTSIDE the configured
      // folder, and telling an operator to move a file the run must not touch is
      // a wrong instruction. What the child must DO about a frozen path is nothing.
      if (opts.frozenPaths?.has(rel) === true) {
        dropped.push({
          criterionId: row.criterionId,
          path: rel,
          reason: `${rel} is a frozen acceptance test — the adversary may not replace it`,
        });
        continue;
      }
      const misplaced =
        opts.testLocation === undefined ? undefined : testLocationProblem(opts.testLocation, rel);
      if (misplaced !== undefined) {
        dropped.push({ criterionId: row.criterionId, path: rel, reason: misplaced });
        continue;
      }
      if (!(await opts.exists(rel))) {
        dropped.push({
          criterionId: row.criterionId,
          path: rel,
          reason: `file ${rel} does not exist in the worktree`,
        });
        continue;
      }
      // AFTER the existence check and before `fileProblem`: a file the child
      // wrote is not in the base commit at all, so this is the rule that tells
      // "the child authored this" apart from "this file was already here".
      // The memo's size is the number of git reads this call has paid for; the
      // first name over the cap is refused without probing, so a call carrying
      // thousands of rows cannot spend thousands of git reads.
      if (
        existsAtBaseCached !== undefined &&
        !base.has(rel) &&
        base.probed() >= MAX_TEST_FILES_PER_CALL
      ) {
        dropped.push({
          criterionId: row.criterionId,
          path: rel,
          reason: `${rel} was not checked against the base commit: at most ${MAX_TEST_FILES_PER_CALL} distinct test files are accepted per submission`,
        });
        continue;
      }
      if ((await existsAtBaseCached?.(rel)) === true) {
        dropped.push({
          criterionId: row.criterionId,
          path: rel,
          reason: `${rel} ${NEWNESS_REASON}`,
        });
        continue;
      }
      const notAFile = opts.fileProblem?.(rel);
      if (notAFile !== undefined) {
        dropped.push({ criterionId: row.criterionId, path: rel, reason: notAFile });
        continue;
      }
      // Already named AND kept earlier in this row? Free: it neither re-reads
      // the file nor spends the quota a second time for the same name.
      if (keptRels.get(row.criterionId)?.has(rel) === true) continue;
      // The last two checks. The size rules are the only ones that cost a read,
      // so a row the cheap rules already refused never opens a descriptor; the
      // quota costs nothing and is NOT conditional on them — it bounds how many
      // files a criterion ends up with, a question about COUNTS that a caller
      // with the size rules off still has to answer. A quota that fired only
      // when the bytes were readable was a quota switched off by an argument.
      if (opts.sizeRules !== false) {
        // AFTER `fileProblem`, which is where an ordinary file of this worktree
        // is established — reading a symlink or a fifo is not this rule's job.
        const judgement = sizeJudgement(path.join(opts.wt, rel), rel, opts.statSize ?? statSizeOf);
        if (judgement.kind === "infra") {
          // The filesystem would not answer, so nothing here judges the child's
          // work. `runTestPipeline` maps this to a handback; a drop would tell
          // the operator the adversary wrote nothing.
          throw new SpecifyInfraError(
            `could not read ${rel} to apply the acceptance-test size rules`,
          );
        }
        if (judgement.kind === "drop") {
          dropped.push({ criterionId: row.criterionId, path: rel, reason: judgement.reason });
          continue;
        }
      }
      // OUTSIDE the size-rule branch on purpose: one counter for what the run
      // froze for the criterion plus what this call has kept for it, so three
      // rows of one file each still stop at two, a criterion that arrived full
      // from the record keeps nothing new, and a caller that switched the size
      // rules off is still bounded on how many files a criterion holds.
      if ((quota.get(row.criterionId) ?? 0) >= MAX_TEST_FILES_PER_CRITERION) {
        dropped.push({
          criterionId: row.criterionId,
          path: rel,
          reason: testFileQuotaProblem(row.criterionId),
        });
        continue;
      }
      files.push(rel);
      const seen = keptRels.get(row.criterionId) ?? new Set<string>();
      seen.add(rel);
      keptRels.set(row.criterionId, seen);
      quota.set(row.criterionId, (quota.get(row.criterionId) ?? 0) + 1);
    }
    if (files.length > 0) keptByCriterion.set(row.criterionId, files);
  }
  const kept: SubmitTestsRow[] = [...keptByCriterion.entries()].map(([criterionId, testFiles]) => ({
    criterionId,
    testFiles,
  }));
  return { kept, dropped };
}
