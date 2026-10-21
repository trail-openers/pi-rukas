/**
 * work-driver-declared-path — the ONE normaliser for a declared path.
 *
 * A declared path is prose from the plan step or the spec resolver, not `git`
 * output, and — measured across the real state files on this host — it carries
 * markup and annotations a planner added for a human reader:
 *
 *     "extension/src/work-driver-verify-cmd.ts (new)"
 *     "extension/src/role-tools.ts (no changes)"
 *     "`extension/src/lens-review.ts`"
 *     "**AGENTS.md**"
 *
 * Compared by exact equality against `git diff --name-only`, none of those ever
 * matches, so the workstream reads as MISSING even when its files changed. The
 * failure is one-directional — a false alarm at commit-pr, never a false pass —
 * which is why it went unnoticed for so long.
 *
 * The function lived in `work-driver-verify.ts` and stays re-exported from
 * there; it moved here because #1707 grew the markup rule past what that
 * module's own budget holds, and a path normaliser is not a verify concern.
 *
 * THE RULE #1707 FIXED: markup is stripped only when PAIRED. The old strip was
 * a character class (`[`*\s]+` at each end), which cannot tell emphasis from a
 * wildcard, so it turned `src/foo/*` into `src/foo` and `src/review-ledger-*`
 * into `src/review-ledger-` — and every downstream question about whether a
 * slot is a pattern was answered from the mangled text. The #819 plan-to-spec
 * gate then demanded a path no plan may name, and an emphasised concrete path
 * could exempt itself by looking like a glob. One representation, judged once:
 * that is what this file exists to guarantee.
 */

import { hasPathspecChar } from "./plan-path-shape.ts";
import { globMatchesSegments } from "./work-driver-deliverable-paths.ts";

/**
 * The paired markdown wrappers a planner puts around a path.
 *
 * PAIRED, deliberately — see the module header. A paired wrapper (`**x**`,
 * `*x*`, `` `x` ``) is unambiguous: both ends carry the same marker with
 * something between them. A lone trailing `*` is what a glob actually looks
 * like, so it survives.
 *
 * Underscore is NOT in the list. `__tests__`, `__mocks__` and `__snapshots__`
 * are real directory names, and unlike `*` an underscore emphasis wrapper is
 * not a shape this project's planners emit — the pre-#1707 normaliser never
 * stripped `_` either, so leaving it out is not a behaviour change.
 *
 * The residual risk is a slot globbed at BOTH ends (a star, a path, a star),
 * which the separator guard below keeps. When a paired strip does mis-read a
 * glob, the result is a concrete-looking slot DEMANDED of the plan — a refusal
 * the operator sees, never a silent pass; the fail-open direction (an
 * emphasised concrete path exempting itself from a gate) is the one this shape
 * must not have.
 *
 * Backticks are stripped as a RUN at either end rather than as a pair: a
 * backtick is refused outright by `plannedPathProblem` (it is shell
 * substitution), so an unbalanced one is markup a markdown renderer failed to
 * close, never part of a path.
 */
function stripMarkup(raw: string): string {
  let out = raw.trim().replace(/^[`\s]+|[`\s]+$/g, "");
  for (;;) {
    const inner =
      out.length > 4 && out.startsWith("**") && out.endsWith("**")
        ? out.slice(2, -2)
        : out.length > 2 && out.startsWith("*") && out.endsWith("*")
          ? out.slice(1, -1)
          : out;
    if (inner === out) return out;
    // A glob the planner wrote at BOTH ends survives: its interior is delimited
    // by separators, not by the markers, and stripping it would drop two
    // wildcards and hand back an absolute-looking path. A markdown emphasis
    // never wraps a path that way.
    if (inner.startsWith("/") || inner.endsWith("/")) return out;
    out = inner.trim().replace(/^[`\s]+|[`\s]+$/g, "");
  }
}

/**
 * A declared path as `git` would spell it — markup, annotation, `./` prefix
 * and trailing separators gone, WILDCARDS INTACT.
 *
 * A trailing parenthetical is stripped (`a.ts (new)`, `ci.yml(new)`); one
 * INSIDE a name ("notes (draft).md") is not, and neither is one that is a whole
 * path segment (`app/(group)`, #1652), because those are real names.
 *
 * Markup is stripped BEFORE the annotation (so `**a.ts (new)**` loses both) and
 * AFTER it (so `a.ts **(new)**` loses both). Nothing here strips a `*`: a slot
 * the planner wrote as a glob keeps its wildcard through this function, which
 * is what lets the #819 exemption judge the slot it was actually given
 * (#1707). The fence grammar's opposite reading — a trailing `/**` means "this
 * directory" — lives in {@link fenceDirPrefix} / {@link fenceMatches}, which
 * every fence-matching caller uses, because that reading belongs to the fence,
 * not to the normaliser.
 *
 * #1725 — the UNTERMINATED-parenthesis rule (#784) lives here, not only in the
 * develop gate's module-local `normaliseScopePath`. Real state files carry
 * fence entries whose annotation has no closing paren at all (the 778.json
 * shape), and since both fences now ask THIS normaliser (#1725, one predicate),
 * the rule has to sit where both fences read it — a fence whose entry never
 * deannotates is a fence that never fires.
 */
export function normaliseDeclaredPath(raw: string): string {
  // The annotation strip tolerates markup AFTER the closing paren
  // (`a.ts **(new)**`), which is why its tail is a markup run and not just
  // `\s*`. That run can only follow a `)` the annotation regex already
  // matched, so it can never eat a slot's own trailing wildcard: `src/foo/*`
  // has no parenthetical, and the lookbehind still refuses to strip a
  // parenthetical that is a whole path segment (`app/(group)`, #1652).
  const deannotated = stripMarkup(raw)
    .replace(/(?<=[^/])\s*\([^()]*\)[`*\s]*$/, "")
    // #784: an UNTERMINATED " (…" runs to the end of the entry (778.json).
    // Requires a literal space before the paren, so a whole-segment
    // parenthetical ("app/(group") and a real "notes (draft).md" survive.
    .replace(/ \((?:[^()]*)$/, "");
  return stripMarkup(deannotated).replace(/^\.\//, "").replace(/\/+$/, "").trim();
}

/**
 * The FENCE grammar's own half of a fence entry: a trailing `/**` or `/*` is
 * how a planner spells "this directory", not a pattern the fence matches, so
 * both forms reduce to the directory itself. Takes a value an earlier
 * normaliser already produced — see {@link fenceDirPrefix} for the whole rule.
 *
 * A lone `*` with no separator (`*`, `**.ts`) is deliberately LEFT ALONE: it
 * names no directory, and turning it into `""` would convert a fence that
 * matches nothing into a fence over the whole tree.
 */
export function stripFenceGlob(normalised: string): string {
  const noGlob = normalised.replace(/\/\*\*$/, "").replace(/\/\*$/, "");
  // A leading `**` is stripped only when a trailing directory glob was also
  // present, which is what makes it noise rather than markup: `**extension/src/**`
  // (a bolded directory) and `**/src/**` (a globstar prefix) both survive
  // `normaliseDeclaredPath` — its PAIRED-wrapper rule refuses a star at both
  // ends — and a fence that reads literally matches nothing, which is exactly
  // the fail-open this round closes. A value with no trailing glob is left
  // alone: there `**` is a real wildcard the caller must keep (`**/*.ts`).
  const noStar = noGlob === normalised ? normalised : noGlob.replace(/^\*\*\/?/, "");
  return noStar.replace(/\/+$/, "");
}

/**
 * A fence entry read as a FENCE: markup, annotation and `./` gone via
 * {@link normaliseDeclaredPath}, then the directory spellings collapsed —
 * `extension/src/**`, `extension/src/*` and `extension/src/` are one fence on
 * the directory `extension/src`.
 *
 * #1707 round 4 — the directory reading used to live in one caller's private
 * regex, so the two OTHER places that match a fence (`fenced()` in
 * `work-driver-plan-repair.ts`, `findFenceContradictions` in
 * `work-driver-plan-paths.ts`) went blind to `dir/**` the moment a wildcard
 * survived `normaliseDeclaredPath`: a path under that fence read as unfenced,
 * the repair appended it to `ws.paths`, and a self-contradictory fence escaped
 * the plan-quality check. Matching a fence is one question, so it has one
 * answer, here.
 *
 * The result is a DIRECTORY PREFIX and every caller compares on a `/` boundary
 * (`path.startsWith(dir + "/")`), so `extension/src` fences only what lives
 * inside it — never a sibling named `extension/srcfoo`.
 */
export function fenceDirPrefix(entry: string): string {
  return stripFenceGlob(normaliseDeclaredPath(entry));
}

/**
 * The ONE fence predicate: does fence entry `entry` cover git path `file`?
 *
 * #1725 — the two fences that refuse a path (the fix fence's `fencedBy` and the
 * develop gate's `outOfScope` check) used to read the same entry through two
 * grammars: one compared `fenceDirPrefix` output by exact/`/`-prefix match, the
 * other by its own normalise-then-compare. `dir/** (note)` or a real glob entry
 * (`src/*.test.ts`) therefore refused one fence and passed the other — two
 * decisions from one entry is the drift this predicate closes. Both fences now
 * call THIS, and so does the spec-slot admitter (which takes it as input), so
 * "is it fenced" has exactly one answer per (entry, file).
 *
 * Three arms, in order:
 *
 *   1. normalise {@link normaliseDeclaredPath} then {@link stripFenceGlob} —
 *      markup, annotation, `./` and the `dir/**` / `dir/*` directory spellings
 *      collapse to the directory;
 *   2. no pathspec character left → EXACT match or a `/`-boundary prefix
 *      (`extension/src` fences what lives inside it, never `extension/srcfoo`);
 *   3. a pathspec character survives (`src/*.test.ts`) → the converge gate's
 *      OWN segment-anchored matcher ({@link globMatchesSegments}), so `*` spans
 *      one segment and the fence, the admitter and converge agree on what the
 *      same text matches.
 *
 * An entry that normalises to nothing covers nothing — fail-closed, never a
 * whole-tree fence.
 */
export function fenceMatches(entry: string, file: string): boolean {
  const normalised = stripFenceGlob(normaliseDeclaredPath(entry));
  if (normalised.length === 0) return false;
  if (!hasPathspecChar(normalised)) {
    return file === normalised || file.startsWith(`${normalised}/`);
  }
  return globMatchesSegments(normalised, file);
}
