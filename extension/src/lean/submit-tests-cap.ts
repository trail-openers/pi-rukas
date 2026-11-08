#!/usr/bin/env bun
/**
 * lean/submit-tests-cap — the boundary a `submit_tests` row passes through, the bounds
 * the call carries, and the per-call memo the base-commit newness probe runs through.
 *
 * Split out of `specify-tree.ts` because every half here exists for one reason: the
 * rule set over a submitted path is cheap, but the newness rule is a git read, and
 * both the number of names in a row and the number of rows in a call come from an
 * untrusted child. `specify-tree.ts` keeps the worktree primitives and re-exports
 * `validateSubmitRows` from here, so the callers never moved.
 *
 * The three size rules (`MAX_TEST_LINES`, `MAX_TEST_BYTES`,
 * `MAX_TEST_FILES_PER_CRITERION` — defined in `test-size.ts`, applied by
 * `sizeJudgement` in `submit-tests-size.ts`) judge the CHILDREN'S work rather than the
 * call's cost, and are applied here, where a submitted path is finally a file.
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
 * How many test files one submitted row may name. The boundary runs its whole rule
 * set — including a git read per path — over every name a row carries, and a row comes
 * from an untrusted child: an unbounded list is an unbounded number of git calls from
 * one tool call. The cap counts the files of ONE row, not the files a criterion ends
 * up with (that is `MAX_TEST_FILES_PER_CRITERION`).
 */
export const MAX_TEST_FILES_PER_ROW = 8;

/**
 * How many DISTINCT test paths one `submit_tests` call may get probed for. The row cap
 * bounds one row, not the call, and the newness rule costs one git read per distinct
 * path. The memo's size is the count that matters, so the call is bounded where the
 * work actually costs; past this many distinct paths the surplus is refused without a
 * probe, making the breach free.
 */
const MAX_TEST_FILES_PER_CALL = 32;

/**
 * A memoised `existsAtBase` for ONE boundary call, plus the count of distinct paths it
 * has actually asked git about. One git read per distinct path per call, not per
 * mention. The answer is a fact about (base, rel), so one call's cache is as fresh as
 * the tree it reads — and it must not outlive the call, because between two calls the
 * step may have committed, and a stale "new" is the fraud the rule exists to refuse.
 *
 * `probed` is what the call cap counts against: `has(rel)` distinguishes a name already
 * asked about (free) from a new one, allowed only while `probed` sits under
 * `MAX_TEST_FILES_PER_CALL`.
 */
function baseProbe(existsAtBase: ((rel: string) => Promise<boolean>) | undefined): {
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
 *   2. FROZEN (`frozenPaths` — only `challenge` passes that set) — BEFORE the
 *      location rule, so an inherited contract outside the configured folder is
 *      reported as the contract it is, not as a file to move;
 *   3. location (`testLocationProblem`);
 *   4. existence in the worktree (`exists`);
 *   5. base newness (`existsAtBase`) — a test the child did not write is not a
 *      new acceptance test;
 *   6. file shape (`fileProblem`);
 *   7. size (`sizeJudgement`) — stat first, refuse over `MAX_TEST_BYTES` without
 *      reading, then count lines (`MAX_TEST_LINES`). The byte bound is what makes
 *      the read bounded per CALL rather than merely per kept file. A NUL byte is
 *      dropped here too, as not a text file;
 *   8. the per-criterion file quota (`MAX_TEST_FILES_PER_CRITERION`) — judged AFTER
 *      the size rule, so an over-long third file is reported as too long rather than
 *      as surplus, and NOT conditional on the size rules.
 *
 * A stat or read whose error carries `ENOENT`, `ENOTDIR` or `ELOOP` is a DROP — the
 * name does not resolve, a fact about the child's file. Any other failure is
 * infrastructure and THROWS `SpecifyInfraError`, which `specify-run.ts` maps to a
 * handback; never a drop. No raw `err.message` is ever interpolated into a reason.
 *
 * `wt` is REQUIRED: a boundary whose rules switch themselves off on a missing argument
 * is one a caller can silently opt out of. `sizeRules: false` is the one deliberate
 * exception and is test-only: it switches off the stat and the read and NOTHING else.
 *
 * The boundary and the capture judge a kept file through the SAME code —
 * `readOneDescriptor`, the capture's own single-descriptor read — but the read happens
 * twice, once per consumer: a second open is the honest cost of deciding before a byte
 * is captured, and the capture's `fstat` checks catch a file swapped in the window.
 *
 * `exists` and `existsAtBase` are async because the second is a git read, and both go
 * through here rather than the callers: a rule the boundary can skip is a rule that
 * gets skipped.
 */
export async function validateSubmitRows(
  rows: SubmitTestsRow[],
  opts: {
    spec: PiSpec;
    exists: (rel: string) => boolean | Promise<boolean>;
    fileProblem?: (rel: string) => string | undefined;
    /**
     * Paths already frozen. `challenge` passes the run's frozen map: accepting a
     * frozen path would let the adversary commit a replacement over a test the run
     * proved red — the one act that silently rewrites the contract the builder is
     * measured against. `specify` omits it: nothing is frozen when it runs.
     */
    frozenPaths?: ReadonlySet<string>;
    /**
     * Where the project keeps its tests (`verify.testDir` + `verify.testGlob`).
     * A submitted test not DIRECTLY inside that directory, or whose basename does
     * not match the pattern, is REFUSED with a reason. Both steps pass it when the
     * project configured one, so the prompt's instruction and the boundary that
     * enforces it read the same config.
     */
    testLocation?: TestLocation;
    /**
     * A kept path must not exist at the run's BASE COMMIT (`existsInCommit`), which is
     * what makes an acceptance test a test the child WROTE: the child works in a
     * checkout of that base, so an existing tracked project test it never opened — or
     * one it overwrote — passes `exists`, gets proved red by absence of evidence, and
     * is frozen as the run's contract. Both are refused here, before a byte is captured.
     */
    existsAtBase?: (rel: string) => Promise<boolean>;
    /**
     * The worktree whose files the size rules judge. REQUIRED: there is no "no
     * tree" shape of this call — a rule that quietly switches itself off when its
     * argument is absent is one a caller can forget to apply, and both real
     * callers have a worktree in hand. A unit test passes a temp dir.
     */
    wt: string;
    /**
     * TEST-ONLY escape: refuse the stat and the read, and judge every other rule
     * — including the per-criterion quota — as normal, so a test of a non-size
     * rule need not build files that satisfy the size rules. Production never
     * sets it.
     */
    sizeRules?: false;
    /**
     * The byte size judged BEFORE reading. Defaults to `statSizeOf` (`lstat`, like
     * `fileProblem`). A test drives it to refuse a file on size without the fixture
     * on disk, or to prove an unreadable stat is infrastructure. Its value is never
     * interpolated into a reason.
     */
    statSize?: (abs: string) => number;
    /**
     * What the RUN has already frozen per criterion, from the step log's `tests` maps.
     * The quota bounds what a criterion ENDS UP WITH across the run, and a fresh call
     * sees none of what an earlier round committed, so without this seed the cap is a
     * per-call number a second round silently doubles. Paths here are counted, not
     * re-checked: they come from the run's own record. Omit it and the count starts at
     * zero.
     */
    frozenByCriterion?: Record<string, readonly string[]>;
  },
): Promise<{ kept: SubmitTestsRow[]; dropped: DroppedRow[] }> {
  const testable = new Set(opts.spec.criteria.filter((c) => c.verify === "test").map((c) => c.id));
  const keptByCriterion = new Map<string, string[]>();
  // ONE counter per criterion: the quota is a RUN-level bound, so a criterion
  // starts at what the run already froze and every keep in this call lands on the
  // same number.
  const quota = new Map<string, number>();
  for (const [id, files] of Object.entries(opts.frozenByCriterion ?? {})) {
    quota.set(id, files.length);
  }
  // Paths already kept for a criterion IN THIS CALL — the dedupe. What this set
  // forbids is one name appearing TWICE inside one criterion's kept row, because
  // that row is what the step captures and commits. It is keyed per criterion, not
  // per row, so a later row cannot clear it and let a duplicate through.
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
      // `tests/AC1-x.test.sh` cannot both name one frozen file. FROZEN first, and
      // deliberately before both the existence and the location rule: an inherited
      // contract sits OUTSIDE the configured folder, and telling an operator to move a
      // file the run must not touch is a wrong instruction. What the child must DO
      // about a frozen path is nothing.
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
      // AFTER the existence check and before `fileProblem`: this is the rule that
      // tells "the child authored this" apart from "this was already here". The
      // memo's size is what this call has paid git for; the first name over the cap
      // is refused without probing.
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
      // The last two checks. The size rules are the only ones that cost a read, so
      // a row the cheap rules already refused never opens a descriptor; the quota
      // costs nothing and is NOT conditional on them — a quota that fired only when
      // the bytes were readable was a quota switched off by an argument.
      if (opts.sizeRules !== false) {
        // AFTER `fileProblem`, which establishes an ordinary file of this worktree —
        // reading a symlink or a fifo is not this rule's job.
        const judgement = sizeJudgement(path.join(opts.wt, rel), rel, opts.statSize ?? statSizeOf);
        if (judgement.kind === "infra") {
          // The filesystem would not answer, so nothing here judges the child's
          // work. A drop would tell the operator the adversary wrote nothing.
          throw new SpecifyInfraError(
            `could not read ${rel} to apply the acceptance-test size rules`,
          );
        }
        if (judgement.kind === "drop") {
          dropped.push({ criterionId: row.criterionId, path: rel, reason: judgement.reason });
          continue;
        }
      }
      // OUTSIDE the size-rule branch on purpose: one counter for what the run froze
      // plus what this call kept, so three rows of one file each still stop at two
      // and a caller that switched the size rules off is still bounded.
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
