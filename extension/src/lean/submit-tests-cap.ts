#!/usr/bin/env bun
/**
 * lean/submit-tests-cap — the boundary a `submit_tests` row passes through, the bounds the call carries, and
 * the per-call memo the base-commit newness probe runs through.
 *
 * The rule set over a submitted path is cheap, but the newness rule is a git read, and both the number of
 * names in a row and the rows in a call come from an untrusted child. The size rules judge the CHILDREN'S
 * work rather than the call's cost, and are applied here, where a submitted path is finally a file.
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
 * How many test files one row may name: the boundary runs a git read per path, so an unbounded list is an
 * unbounded number of git calls from one tool call.
 */
export const MAX_TEST_FILES_PER_ROW = 8;

/**
 * How many DISTINCT paths one call may get probed for. The row cap bounds a row, not the call.
 */
const MAX_TEST_FILES_PER_CALL = 32;

/**
 * A memoised `existsAtBase` for ONE boundary call, plus how many distinct paths it asked git about. It must
 * not outlive the call: between calls the step may have committed, and a stale "new" is the fraud this
 * refuses.
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
 * The boundary's newness refusal, composed by the step as `<path> ${NEWNESS_REASON}` so the boundary's
 * sentence and the operator's cannot drift apart.
 */
export const NEWNESS_REASON =
  "already exists at the base commit; a new acceptance test must be a new file";

/**
 * The boundary every submitted path passes through.
 *
 * A row is dropped, with a reason, when its criterion is not a `verify: "test"` criterion of THIS spec, or
 * when one of these rules fires — in this order, and the FIRST that fires is the reason an operator reads:
 *
 *   1. path shape (absolute, traversal, forbidden directory);
 *   2. FROZEN (`frozenPaths` — only `challenge` passes it) — BEFORE the location rule, so an inherited
 *      contract outside the folder is reported as the contract it is;
 *   3. location (`testLocationProblem`);
 *   4. existence in the worktree (`exists`);
 *   5. base newness (`existsAtBase`) — a test the child did not write is not a new acceptance test;
 *   6. file shape (`fileProblem`);
 *   7. size (`sizeJudgement`) — stat first, refuse over `MAX_TEST_BYTES` without reading, then count lines;
 *   8. the per-criterion file quota — AFTER the size rule, so an over-long third file reads as too long.
 *
 * A stat or read whose error carries `ENOENT`, `ENOTDIR` or `ELOOP` is a DROP — a fact about the child's
 * file. Any other failure is infrastructure and THROWS `SpecifyInfraError`. No raw `err.message` is ever
 * interpolated into a reason.
 *
 * `wt` is REQUIRED: a boundary whose rules switch themselves off on a missing argument is one a caller can
 * silently opt out of. `sizeRules: false` is the one exception and is test-only.
 *
 * The boundary and the capture judge a kept file through the SAME code (`readOneDescriptor`).
 */
export async function validateSubmitRows(
  rows: SubmitTestsRow[],
  opts: {
    spec: PiSpec;
    exists: (rel: string) => boolean | Promise<boolean>;
    fileProblem?: (rel: string) => string | undefined;
    /**
     * Paths already frozen. `challenge` passes the run's frozen map: accepting a frozen path would
     * let the adversary commit a replacement over a test the run proved red.
     */
    frozenPaths?: ReadonlySet<string>;
    /**
     * Where the project keeps its tests (`verify.testDir` or `verify.testDirs`, + `verify.testGlob`). A
     * submitted test not DIRECTLY inside one of those directories, or whose basename does not match the pattern, is REFUSED with a
     * reason — so the prompt's instruction and the boundary that enforces it read the same config.
     */
    testLocation?: TestLocation;
    /**
     * A kept path must not exist at the run's BASE COMMIT — what makes an acceptance test one the child
     * WROTE: the child works in a checkout of that base, so a tracked project test it never opened passes
     * `exists`, gets proved red by absence of evidence, and is frozen as the run's contract.
     */
    existsAtBase?: (rel: string) => Promise<boolean>;
    /**
     * The worktree whose files the size rules judge. REQUIRED: a rule that switches itself off when its
     * argument is absent is one a caller can forget to apply.
     */
    wt: string;
    /**
     * TEST-ONLY escape: refuse the stat and the read, and judge every other rule as normal. Production never
     * sets it.
     */
    sizeRules?: false;
    /**
     * The byte size judged BEFORE reading. Defaults to `statSizeOf` (`lstat`, like `fileProblem`).
     */
    statSize?: (abs: string) => number;
    /**
     * What the RUN has already frozen per criterion. The quota bounds what a criterion ENDS UP WITH across
     * the run, so without this seed it is a per-call number a second round silently doubles.
     */
    frozenByCriterion?: Record<string, readonly string[]>;
  },
): Promise<{ kept: SubmitTestsRow[]; dropped: DroppedRow[] }> {
  const testable = new Set(opts.spec.criteria.filter((c) => c.verify === "test").map((c) => c.id));
  const keptByCriterion = new Map<string, string[]>();
  // ONE counter per criterion: the quota is RUN-level, so a criterion starts at what the run froze.
  const quota = new Map<string, number>();
  for (const [id, files] of Object.entries(opts.frozenByCriterion ?? {})) {
    quota.set(id, files.length);
  }
  // Paths kept for a criterion IN THIS CALL: what it forbids is one name appearing TWICE in the row the
  // step captures and commits.
  const keptRels = new Map<string, Set<string>>();
  // One git read per distinct path per call, bounded by `MAX_TEST_FILES_PER_CALL`.
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
      // The absolute check runs on the RAW string: `path.isAbsolute` on a normalised `//etc/passwd` would
      // report it as a relative path that merely does not exist.
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
      // Checked on the NORMALISED path, so two spellings cannot both name one frozen file.
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
      // The rule that tells "the child authored this" apart from "this was already here". The first name
      // over the call cap is refused without probing.
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
      // Already named AND kept earlier in this row? Free: no second read, no second quota spend.
      if (keptRels.get(row.criterionId)?.has(rel) === true) continue;
      // The size rules are the only ones that cost a read, so a row the cheap rules refused never opens a
      // descriptor.
      if (opts.sizeRules !== false) {
        const judgement = sizeJudgement(path.join(opts.wt, rel), rel, opts.statSize ?? statSizeOf);
        if (judgement.kind === "infra") {
          // The filesystem would not answer, so nothing here judges the child's work.
          throw new SpecifyInfraError(
            `could not read ${rel} to apply the acceptance-test size rules`,
          );
        }
        if (judgement.kind === "drop") {
          dropped.push({ criterionId: row.criterionId, path: rel, reason: judgement.reason });
          continue;
        }
      }
      // OUTSIDE the size-rule branch on purpose: a caller that switched those rules off is still bounded.
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
