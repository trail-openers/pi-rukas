/**
 * work-driver-plan-paths — plan-quality checks on per-workstream `paths`.
 *
 * Two structural defects, both invisible at plan time and both paying for
 * themselves at commit-pr consolidation:
 *
 * 1. A COLLISION: two workstreams claim the same file. `runDevelop` fans one
 *    developer per workstream into its own worktree, so two declared `paths`
 *    lists naming the same file is two developers editing it in parallel.
 *    The only Jaccard logic in the driver groups *issues*, not workstreams;
 *    nothing checked this. The collision surfaced as a bare `git apply`
 *    failure during consolidation — a HALT step, after the whole develop and
 *    adversarial spend.
 *
 * 2. A COUPLING split (#479 / #483): a test and the file it exercises are
 *    declared by DIFFERENT workstreams. Each workstream then passes its own
 *    develop gate against its own tree, and the consolidated verify fails
 *    later, for the same reason. Measured live on issue #479: task-a owned
 *    `build.sh`, task-b owned only the test asserting on it.
 *
 * Not hypothetical: measured on this host, current cycles are routinely N>1
 * (lantern 664 = 3 workstreams, 673 = 2, 677 = 3).
 */

import { normaliseDeclaredPath } from "./work-driver-verify.ts";

/**
 * #1005 — a declared path is a plain repo-relative path when it has no
 * shell metacharacter, no leading `/`, and no `..` segment. The check is
 * deliberately conservative (rejects what is clearly dangerous; does not
 * try to be a full path grammar): the fence and the consolidation checks
 * compare these strings as-is, so a `..`-traversing or absolute path is
 * not a scope the driver can verify.
 *
 * #819 round-2 — moved here from work-driver-plan-helpers.ts and exported: the
 * plan-to-spec gate (`findUncoveredDeliverables`, which must not turn a prose
 * `paths:` slot into an uncovered row) judges the same slot by the same rule.
 * helpers→paths is an existing dependency, so the predicate lives where both
 * readers can reach it without a cycle and without a second copy.
 */
export function isPlainRepoRelativePath(p: string): boolean {
  const trimmed = p.trim();
  if (trimmed.length === 0) return false;
  // Shell metacharacters that would execute in a shell-built command.
  if (/[`$;&|<>(){}\\\"'\s]/.test(trimmed)) return false;
  // Absolute path (leading /).
  if (trimmed.startsWith("/")) return false;
  // .. traversal (as a segment, not inside a filename like "a..b.ts").
  if (trimmed.split("/").includes("..")) return false;
  return true;
}

/** A file two workstreams both claimed. */
export interface PathCollision {
  a: string;
  b: string;
  path: string;
}

/** A test declared by one workstream whose subject sits in another. */
export interface TestSubjectSplit {
  /** The workstream that declared the test file. */
  test: string;
  /** The workstream that declared the file the test exercises. */
  subject: string;
  /** The test file, normalised. */
  testPath: string;
  /** The subject file, normalised. */
  subjectPath: string;
}

/**
 * Workstreams that were told to edit the same file.
 *
 * `runDevelop` fans one developer per workstream into its own worktree, so two
 * lists naming the same path is two developers editing the same file in
 * parallel. It surfaced only at commit-pr, as a bare `git apply` failure during
 * consolidation — a HALT step, after the whole develop and adversarial spend,
 * with nothing in the error explaining why.
 *
 * Containment counts, not just equality: a workstream owning `src/foo` and one
 * owning `src/foo/bar.ts` collide. Prefix alone does not — `src/foo` does not
 * contain `src/foobar`, which is why the check appends the separator.
 *
 * Paths are normalised first (`normaliseDeclaredPath`) because they are prose
 * from a planner, not `git` output: without it, `src/a.ts (new)` and `src/a.ts`
 * read as different files and the check is evaded by an annotation.
 */
export function findPathCollisions(
  workstreams: Record<string, { paths: string[] }>,
): PathCollision[] {
  const normalised = Object.entries(workstreams).map(([id, ws]) => ({
    id,
    paths: [...new Set((ws.paths ?? []).map(normaliseDeclaredPath).filter(Boolean))],
  }));
  const collisions: PathCollision[] = [];
  for (let i = 0; i < normalised.length; i++) {
    for (let j = i + 1; j < normalised.length; j++) {
      const a = normalised[i];
      const b = normalised[j];
      if (!a || !b) continue;
      for (const pa of a.paths) {
        for (const pb of b.paths) {
          if (pa === pb || pa.startsWith(`${pb}/`) || pb.startsWith(`${pa}/`)) {
            collisions.push({ a: a.id, b: b.id, path: pa === pb ? pa : `${pa} / ${pb}` });
          }
        }
      }
    }
  }
  return collisions;
}

/** A fence entry that contradicts the workstream declaring it (#1167). */
export interface FenceContradiction {
  /** The workstream whose fence contradicts its own paths. */
  workstream: string;
  /** The fence entry as the planner wrote it. */
  entry: string;
  /** The workstream's own declared path the entry names. */
  path: string;
}

/**
 * #1167 — fences that contradict the plan declaring them.
 *
 * The planner prompt's cross-declaration contract (#572) tells every
 * workstream to put its siblings' paths into its own `out-of-scope:` line,
 * so a fence naming a path is normal. What is never legitimate is a fence
 * naming a path the SAME workstream also declares — the plan says both
 * "this file is yours" and "do not touch it". That is the #776 / #1020
 * incident: the develop fence hit parked a correct, complete change.
 *
 * The comparison reuses `findPathCollisions`' containment semantics
 * (exact match, or containment either way on a `/` boundary) and normalises
 * BOTH sides with `normaliseDeclaredPath` first. The normalisation is the
 * whole game: a fence entry carrying an annotation — `src/x.ts (new)` — is
 * the same file as `src/x.ts`, and comparing un-normalised strings lets the
 * contradiction pass silently (the issue's own named pitfall).
 *
 * Prose fence entries that name no path (`"sibling owns all tests"`, `"docs/"`
 * when no path declares it) are NOT flagged: there is nothing to compare, and
 * inventing a match from free text would reject plans whose fences are simply
 * worded loosely.
 */
export function findFenceContradictions(
  workstreams: Record<string, { paths: string[]; outOfScope?: string[] }>,
): FenceContradiction[] {
  const out: FenceContradiction[] = [];
  for (const [id, ws] of Object.entries(workstreams)) {
    const own = [...new Set((ws.paths ?? []).map((p) => normaliseDeclaredPath(p)).filter(Boolean))];
    if (own.length === 0) continue;
    for (const entry of ws.outOfScope ?? []) {
      const n = normaliseDeclaredPath(entry);
      if (!n) continue;
      const path = own.find((p) => p === n || p.startsWith(`${n}/`) || n.startsWith(`${p}/`));
      if (path !== undefined) out.push({ workstream: id, entry, path });
    }
  }
  return out;
}

/**
 * True when the basename looks like a test file, by naming convention only.
 *
 * Exported for the develop-step scope gate (#672): the fence's test-file
 * exception reuses this exact convention rather than inventing a parallel
 * one. Deliberately JS/TS-named (`test-` prefix, `.test.`/`.spec.`
 * extension) — the Rust `foo_tests.rs` convention is intentionally NOT
 * covered; the exception stays as narrow as this heuristic is.
 */
export function isTestPath(path: string): boolean {
  const base = path.split("/").pop() ?? path;
  return /^(test[-_.]|[-_.]test[-_.])/i.test(base) || /\.(test|spec)\.[cm]?[jt]sx?$/.test(base);
}

/**
 * The issue's naming inference: `test-<x>.ts` is coupled to `<x>.ts`, or a
 * test path "naming a `src/` module".
 *
 * Mechanically: strip the leading `test-` and the extension from the test's
 * basename to get its STEM, then decompose the stem into tokens on `[-_.]`
 * (`build-list-dedup` → `build`, `list`, `dedup`). The subject path COUPLES
 * to the test when at least one of the stem's tokens EQUALS the ENTIRE
 * basename of the subject (the subject's name, not just a token of it). This
 * is the tightest inference that still catches the issue's fixture:
 *
 *   - `build.sh` vs `test-build-list-dedup.ts`
 *     subject basename: `build`; stem tokens: `build`, `list`, `dedup`.
 *     `build` ∈ stem tokens → COUPLED. ✓ (the issue's own fixture)
 *
 *   - `src/foo.ts` vs `smoke-tests/test-foobar.ts`
 *     subject basename: `foo`; stem tokens: `foobar`.
 *     `foo` ∉ `{foobar}` → NOT coupled. ✓
 *     (a test named `test-foobar.ts` is about `foobar.ts`, a different module)
 *
 *   - `src/vipune.ts` vs `smoke-tests/test-vipune-seam-loop.ts`
 *     subject basename: `vipune`; stem tokens: `vipune`, `seam`, `loop`.
 *     `vipune` ∈ stem tokens → COUPLED. ✓
 *     (this repo's own live test genuinely exercises `vipune.ts`)
 *
 *   - `src/a.ts` vs `smoke-tests/test-foo.ts`
 *     subject basename: `a`; stem tokens: `foo`.
 *     `a` ∉ `{foo}` → NOT coupled. ✓
 *     (anti-false-positive: a shared token is not enough)
 *
 * One test module exercising several subjects is legitimate (this repo's own
 * `test-vipune-seam-loop.ts` does exactly that): when it does NOT name any
 * single subject, the inference finds no coupling and does not flag it, which
 * is the correct behaviour — the check must not collapse every plan into N=1.
 */
export function couplesTo(testPath: string, subjectPath: string): boolean {
  const testBase = testPath.split("/").pop() ?? testPath;
  const testStem = testBase.replace(/^test[-_.]/i, "").replace(/\.[^.]+$/, "");
  const stemTokens = new Set(
    testStem
      .split(/[-_.]+/)
      .filter((t) => t && t.toLowerCase() !== "test")
      .map((t) => t.toLowerCase()),
  );
  if (stemTokens.size === 0) return false;
  const subjBase = (subjectPath.split("/").pop() ?? subjectPath)
    .replace(/\.[^.]+$/, "")
    .toLowerCase();
  if (!subjBase) return false;
  // The subject's ENTIRE basename must be a token of the test's stem.
  // This is the tightest inference that catches the issue's fixture without
  // collapsing every plan into N=1: a test named `test-foo.ts` is about
  // `foo` (a module), not about every file that happens to contain the token
  // `foo` somewhere in its name.
  return stemTokens.has(subjBase);
}

/**
 * Workstreams that split a test from the file it exercises.
 *
 * `runDevelop` fans one developer per workstream into its own worktree, so a
 * test and its subject in different worktrees provably never meet: each
 * workstream passes its own develop gate against its own tree, and the first
 * verification that sees them together is the consolidated tree at commit-pr,
 * after the full develop and adversarial spend.
 *
 * Two rules, in order:
 *
 * 1. Naming inference (the issue's stated rule): a test-named file declared
 *    by one workstream is coupled to a file in another workstream when the
 *    test's stem names that file (see `couplesTo`).
 *
 * 2. The unambiguous shape, flagged regardless of naming: a workstream whose
 *    ONLY declared file(s) look like tests of a file owned by a different
 *    workstream. A workstream that is only a test is the shape with no
 *    legitimate reading — that test is by definition about someone else's
 *    code, and it cannot run against any of it.
 *
 * Paths are normalised first (`normaliseDeclaredPath`) for the same reason as
 * `findPathCollisions`: they are prose from a planner, not `git` output.
 * A test is never paired with a workstream that ALSO declares the exact same
 * path — that is an overlap, `findPathCollisions`' job, not a split.
 */
export function findTestSubjectSplits(
  workstreams: Record<string, { paths: string[] }>,
): TestSubjectSplit[] {
  const normalised = Object.entries(workstreams).map(([id, ws]) => ({
    id,
    paths: [...new Set((ws.paths ?? []).map(normaliseDeclaredPath).filter(Boolean))],
  }));
  const splits: TestSubjectSplit[] = [];
  for (const w of normalised) {
    if (!w) continue;
    const others = normalised.filter((o) => o.id !== w.id);
    const rule1Found: string[] = [];
    for (const tp of w.paths.filter(isTestPath)) {
      for (const o of others) {
        if (!o) continue;
        // Rule 1 — naming inference: the test's stem names a file in the
        // other workstream, and that file is not the test itself (an overlap
        // would be, not a split).
        const subject = o.paths.find((p) => p !== tp && couplesTo(tp, p));
        if (subject) {
          splits.push({ test: w.id, subject: o.id, testPath: tp, subjectPath: subject });
          rule1Found.push(o.id);
        }
      }
    }
    // Rule 2 — a workstream made up of tests alone, whose subjects live
    // elsewhere, is a split no naming convention can rescue. The subject is
    // an other-workstream file whose basename matches the test's stem tokens
    // (rule 1's inference) OR whose path appears as a substring of the test
    // path. We skip workstreams that rule 1 already flagged — that would
    // duplicate the same split.
    const tests = w.paths.filter(isTestPath);
    if (w.paths.length > 0 && tests.length === w.paths.length) {
      for (const tp of tests) {
        for (const o of others) {
          if (!o || rule1Found.includes(o.id)) continue;
          const subject = o.paths.find(
            (p) => p !== tp && (tp.includes(p.split("/").pop() ?? p) || couplesTo(tp, p)),
          );
          if (subject) {
            splits.push({ test: w.id, subject: o.id, testPath: tp, subjectPath: subject });
            rule1Found.push(o.id);
            break;
          }
        }
      }
    }
  }
  return splits;
}
