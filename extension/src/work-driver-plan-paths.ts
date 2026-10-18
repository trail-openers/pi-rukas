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
 *
 * #1581 — the collision check also covers NEW files nobody declared: two
 * workstreams whose scope each says it creates the same file collide as an
 * add/add conflict at consolidation, just like a shared declared path.
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
 *
 * #1581 — a file two workstreams each intend to CREATE collides too, even
 * when neither declared it: each developer adds its own copy and the second
 * is an add/add conflict at consolidation. The intent is read by `newFilesOf`,
 * and only a pair of intents is compared — a sibling that merely mentions the
 * file is not a second creator.
 */
export function findPathCollisions(
  workstreams: Record<string, { paths: string[]; scope?: string }>,
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
  const intents = Object.entries(workstreams).map(([id, ws]) => ({ id, files: newFilesOf(ws) }));
  for (let i = 0; i < intents.length; i++) {
    for (let j = i + 1; j < intents.length; j++) {
      const a = intents[i];
      const b = intents[j];
      if (!a || !b || collisions.some((c) => c.a === a.id && c.b === b.id)) continue;
      for (const fa of a.files) {
        const fb = b.files.find((f) => sameFile(fa, f));
        if (fb === undefined) continue;
        const path = fa === fb ? fa : `${fa} / ${fb}`;
        collisions.push({ a: a.id, b: b.id, path: `${path} (each creates it as a new file)` });
        break;
      }
    }
  }
  return collisions;
}

/** A file-shaped token: the last segment carries an extension. */
const FILE_TOKEN = String.raw`([A-Za-z0-9_][A-Za-z0-9_./-]*\.[A-Za-z][A-Za-z0-9]*)`;
/**
 * `create(s) [a|the] [new] <file>` or `a new <file>`, allowing only a kind noun
 * and an `(e.g.` / `called` / `named` / `at` lead-in in between. `the new
 * src/x.ts` is a reference to a sibling's file, not a creation, and so is
 * anything with another word between the verb and the file (`uses the new
 * helper in src/x.ts`): neither matches, and the read fails open.
 */
const CREATES_LEAD = String.raw`\b(?:creat(?:e|es|ed|ing)\s+(?:(?:a|an|the)\s+)?(?:new\s+)?|an?\s+new\s+)(?:(?:smoke[- ]?)?test|file|module|source file|helper|script)?\s*(?:\((?:e\.g\.|i\.e\.)?\s*|called\s+|named\s+|at\s+)?`;
const CREATES = new RegExp(`${CREATES_LEAD}\`?${FILE_TOKEN}`, "gi");
const ANNOTATED_NEW = new RegExp(`\`?${FILE_TOKEN}\`?${String.raw`\s*\(new\)`}`, "gi");

/** True when `index` sits inside an unclosed `(` — an aside such as
 * `(task-a creates src/x.ts)` describes a sibling, not this workstream. */
function insideParens(text: string, index: number): boolean {
  let depth = 0;
  for (const ch of text.slice(0, index)) depth += ch === "(" ? 1 : ch === ")" ? -1 : 0;
  return depth > 0;
}

/**
 * #1581 — the files a workstream says it will create: `create <file>` or
 * `a new <file>` in its scope label, or a declared path annotated `(new)`.
 * An inference from planner prose, so it is deliberately narrow (`CREATES`).
 */
export function newFilesOf(ws: { paths: string[]; scope?: string }): string[] {
  const out = new Set<string>();
  const scope = ws.scope ?? "";
  for (const re of [CREATES, ANNOTATED_NEW]) {
    for (const m of scope.matchAll(re)) {
      if (re === CREATES && insideParens(scope, m.index ?? 0)) continue;
      const p = normaliseDeclaredPath(m[1] ?? "");
      if (p && isPlainRepoRelativePath(p)) out.add(p);
    }
  }
  for (const raw of ws.paths ?? []) {
    const p = normaliseDeclaredPath(raw);
    if (p && /\(new\)\s*$/i.test(raw)) out.add(p);
  }
  return [...out];
}

/**
 * Same file, by `findPathCollisions`' containment rule — or by basename when
 * one side is a bare filename, because scope prose often names a new file
 * without its directory (`plus a new test-handoff-post-retry.ts`). A generic
 * basename (`index.ts`, `mod.rs`) names no particular file, so it never
 * matches by basename alone.
 */
function sameFile(a: string, b: string): boolean {
  if (a === b || a.startsWith(`${b}/`) || b.startsWith(`${a}/`)) return true;
  if (a.includes("/") && b.includes("/")) return false;
  const base = a.split("/").pop() ?? "";
  if (GENERIC_BASENAME.test(base)) return false;
  return base === b.split("/").pop();
}

const GENERIC_BASENAME =
  /^(?:index|mod|main|lib|types|utils?|helpers?|config|constants|setup|readme|__init__)\.[^.]+$/i;

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
