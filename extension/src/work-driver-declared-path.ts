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
 * (#1707). A caller that must treat a trailing `/**` as "this directory" —
 * `fenceCoveringBroader` — strips it itself, because that reading belongs to
 * the fence grammar, not to the normaliser.
 */
export function normaliseDeclaredPath(raw: string): string {
  // The annotation strip tolerates markup AFTER the closing paren
  // (`a.ts **(new)**`), which is why its tail is a markup run and not just
  // `\s*`. That run can only follow a `)` the annotation regex already
  // matched, so it can never eat a slot's own trailing wildcard: `src/foo/*`
  // has no parenthetical, and the lookbehind still refuses to strip a
  // parenthetical that is a whole path segment (`app/(group)`, #1652).
  const deannotated = stripMarkup(raw).replace(/(?<=[^/])\s*\([^()]*\)[`*\s]*$/, "");
  return stripMarkup(deannotated).replace(/^\.\//, "").replace(/\/+$/, "").trim();
}
