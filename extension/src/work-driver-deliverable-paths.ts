/**
 * work-driver-deliverable-paths — the ONE grammar for a declared deliverable
 * path (#1155).
 *
 * The incident this closes (#1137, cycle 1137 on 2026-10-13): the plan wrote
 * `- d2: … [paths: extension/src/work-driver-verify.ts or new
 * work-driver-<name>.ts]`. The developers created
 * `extension/src/work-driver-acceptance-coverage.ts` (344 lines + a 481-line
 * test), the verify gate passed, and the converge completeness gate still
 * parked the cycle: `classifyDeliverables` compares declared paths to the diff
 * by exact string / `${p}/` prefix, so a declared path containing ` or ` or a
 * `<name>` template is a string no `git diff --name-only` can ever contain.
 * The one-shot corrective re-dispatch then spent 76 min trying to create a
 * file literally named `work-driver-<name>.ts`. 154 min, parked, finished by
 * hand as PR #1150.
 *
 * The rule the operator decided (issue #1155 DECISIONS, verbatim):
 *
 *   - Deliverable paths are parsed into alternatives: split on ' or ' /
 *     ' OR ' / '|'; strip annotations like '(new)'; a segment containing
 *     <...> or * is a glob (<...> → *).
 *   - A deliverable counts as delivered when ANY alternative matches a path
 *     in the diff (glob match for templates). 'Partial' warnings use the same
 *     matching.
 *   - A deliverable whose paths cannot be parsed into at least one concrete
 *     or glob path is 'unmeasurable': a warning in the PR body/handoff, never
 *     a cap.
 *   - The gate parks only when a deliverable with at least one concrete or
 *     glob alternative has no match at all, after the corrective re-dispatch.
 *
 * WHY THIS MODULE EXISTS AS A SEPARATE FILE — two reasons, both structural:
 *
 * 1. SHARED GRAMMAR. The converge gate (`classifyDeliverables`) and the plan-
 *    to-spec coverage gate (#819, `findUncoveredDeliverables`) judge the same
 *    `[paths:]` slot. If each grew its own splitting rule they would drift,
 *    and a drift between the two is invisible: a plan the coverage gate calls
 *    uncovered while the converge gate calls delivered is a cycle that halts
 *    at plan for work it would pass at develop. Both call this module.
 *
 * 2. THE GLOB LIVES IN THE SPEAKER'S SLOT, NOT THE PARSER'S. The alternatives
 *    split runs at PARSE time (`parseDeliverables`) so `[paths: a.ts, b or c]`
 *    carries two paths, not one string with a comma-list lie. The `<...>` →
 *    `*` rewrite deliberately does NOT: a `<…>` slot kept verbatim in
 *    `d.paths` is what tells the plan prompt, the corrective prompt and the
 *    PR body that the planner left a template, and
 *    `isPlainRepoRelativePath` — the shape gate the coverage gate runs —
 *    rejects `<`/`>`/`*` as shell metacharacters, so a parse-time rewrite
 *    would turn "the planner wrote a template" into a silent shape violation.
 *    The glob is therefore a MATCHING concept, applied here at the moment a
 *    declared path meets a diff path. `normaliseDeclaredPath` (verify.ts) is
 *    untouched: it is shared with `verifyConsolidation`'s exact-path coverage
 *    semantics, which #1155 puts explicitly out of scope.
 *
 * Blast radius, stated so a reviewer can check it: of the `normaliseDeclaredPath`
 * call sites, exactly ONE changes behaviour — `classifyDeliverables`'
 * workstream-path normalisation, which takes the same alternatives rule as the
 * deliverable side so `deliveredBy` attribution and presence cannot disagree
 * about what a path means. `verifyConsolidation`, the develop/commit-pr scope
 * fences, the path-collision check and the queue-overlap Jaccard all keep the
 * exact-string semantics they have today.
 */

import { isPlainRepoRelativePath } from "./work-driver-plan-paths.ts";
import { normaliseDeclaredPath } from "./work-driver-verify.ts";

/** One parsed alternative: a literal path, or a template the planner left. */
export interface DeclaredPathAlternative {
  /** The alternative as the planner wrote it, minus markup and annotation. */
  raw: string;
  /**
   * The form a glob comparison uses: `raw` with every `<…>` placeholder
   * collapsed to `*`. Equal to `raw` for a concrete path.
   */
  glob: string;
  /** True when this alternative contains `*` — i.e. it is a template. */
  isGlob: boolean;
}

/** The two alternatives separators the operator decided on: ` or `, ` OR `, `|`. */
const ALTERNATIVE_SPLIT = /\s+or\s+|\s+OR\s+|\|/;

/** Placeholder form of a `<name>` template segment, per the decided rule. */
const ANGLE_PLACEHOLDER = /<[^<>]*>/g;

/** Placeholder words a `[paths:]` slot carries when the author had no file. */
const PLACEHOLDER_PATHS = new Set([
  "n/a",
  "na",
  "none",
  "null",
  "nil",
  "tbd",
  "todo",
  "tentative",
  "unknown",
  "unspecified",
  "placeholder",
  "prose",
  "-",
  "—",
  ".",
  "…",
]);

/**
 * The alternative's LITERAL form — what `raw` holds and what exact/directory
 * matching compares.
 *
 * `normaliseDeclaredPath` is the project's declared-path normaliser, but it
 * cannot be the last word for a template: its markup strip (`[/`*\s]+`) eats
 * `*`, so a path the planner wrote with a literal `*` would arrive here with
 * the wildcard removed and never match anything. A segment the planner wrote
 * as a bare placeholder (`<name>`) is therefore restored to `*` here, so a
 * whole-segment placeholder reads as a wildcard rather than as the mangled
 * text the normaliser left behind. A template with literal text around the
 * placeholder keeps that text verbatim; the wildcard expansion happens in
 * `toGlobForm`.
 */
function toRawForm(raw: string): string {
  return normaliseDeclaredPath(raw).replace(/^<[^<>]*>$/, "*");
}

/**
 * The GLOB form: every `<…>` placeholder collapsed to `*` (`<name>` → `*`,
 * `work-driver-<name>.ts` → `work-driver-*.ts`). Runs on the already-stripped
 * text so the placeholder survives `normaliseDeclaredPath`'s markup strip.
 */
function toGlobForm(raw: string): string {
  return normaliseDeclaredPath(raw).replace(ANGLE_PLACEHOLDER, "*");
}

function isGlobForm(glob: string): boolean {
  return glob.includes("*");
}

/**
 * A slot that is a filler word rather than an ownership claim. Compared
 * case-insensitively and after trailing dots, because the same intent arrives
 * as `n/a`, `N/A`, `n.a.` and `—`.
 *
 * A LIST and not a heuristic: the dangerous-character check alone is not
 * enough (`n/a` has no metacharacters and is a legal relative path), and a
 * heuristic like "no dot → not a file" would drop `extension/smoke-tests/`,
 * a legitimate DIRECTORY. This predicate moved here verbatim from
 * `work-driver-plan-spec-coverage.ts` so both gates answer it identically.
 */
export function isPlaceholderPath(p: string): boolean {
  return PLACEHOLDER_PATHS.has(p.trim().toLowerCase().replace(/[.]+$/, ""));
}

/**
 * Split one `[paths:]` slot into its concrete alternatives.
 *
 * `splitDeliverablePaths("extension/src/a.ts, new work-driver-<name>.ts")`
 * yields the comma-separated slots AND the `or`-split pieces. Dedup happens at
 * the callers (they keep their own ordering), so this stays a pure splitter.
 */
export function splitDeliverablePaths(raw: string | undefined): string[] {
  if (!raw) return [];
  return raw
    .split(",")
    .flatMap((piece) => piece.split(ALTERNATIVE_SPLIT))
    .map((seg) => normaliseDeclaredPath(seg))
    .filter((seg) => seg.length > 0);
}

/**
 * Split one slot into its alternatives WITHOUT normalisation.
 *
 * `splitDeliverablePaths` runs each piece through `normaliseDeclaredPath`,
 * which strips a trailing `*` as markdown markup — fine for matching, fatal
 * for asking "is this a pattern?", because `src/foo/*` arrives as `src/foo`
 * and reads as a concrete directory. A caller that must judge the slot's
 * pattern needs the text as written, trimmed only of surrounding whitespace.
 * The split grammar is shared with `splitDeliverablePaths` deliberately: the
 * comma-list and the ` or `/`|` alternatives are one grammar, not two.
 */
export function splitRawAlternatives(rawSlot: string | undefined): string[] {
  if (!rawSlot) return [];
  return rawSlot
    .split(",")
    .flatMap((piece) => piece.split(ALTERNATIVE_SPLIT))
    .map((seg) => seg.trim())
    .filter((seg) => seg.length > 0);
}

/**
 * The declared SLOTS of a `[paths:]` list — annotation-stripped, blanks
 * dropped, deduped, and NOT split into alternatives. Exposed so both gates
 * agree on what one slot is (the unit that must be covered / delivered) while
 * `splitDeliverablePaths` stays the unit that matches.
 */
export function splitDeclaredSlots(paths: readonly string[] | undefined): string[] {
  return (paths ?? []).map((p) => normaliseDeclaredPath(p)).filter((p) => p.length > 0);
}

/** One declared slot and everything it parses into. */
export interface DeclaredPathSlot {
  /** The slot as written, minus markup and annotation. */
  raw: string;
  /** Its alternatives; empty when the slot held nothing. */
  alternatives: DeclaredPathAlternative[];
}

/**
 * The alternatives of a whole `[paths:]` list, in declaration order, with the
 * glob form precomputed. Exposed for diagnostics and for callers that need to
 * show a template alongside what it matched; `classifyDeliverables` uses it
 * for its reason strings and never for the decision (the decision is
 * `declaredPathMatches`, so the two cannot disagree).
 */
export function deliverablePathAlternatives(
  paths: readonly string[] | undefined,
): DeclaredPathSlot[] {
  return (paths ?? [])
    .map((slot) => ({
      raw: normaliseDeclaredPath(slot),
      alternatives: splitDeliverablePaths(slot).map(toAlternative),
    }))
    .filter((row) => row.alternatives.length > 0);
}

export function toAlternative(raw: string): DeclaredPathAlternative {
  const literal = toRawForm(raw);
  const glob = toGlobForm(raw);
  return { raw: literal, glob, isGlob: isGlobForm(glob) || isGlobForm(literal) };
}

/** Every alternative of every slot, in order, deduped by glob form. */
function allAlternatives(paths: readonly string[] | undefined): DeclaredPathAlternative[] {
  return dedupeAlternatives(deliverablePathAlternatives(paths).flatMap((r) => r.alternatives));
}

function dedupeAlternatives(alts: DeclaredPathAlternative[]): DeclaredPathAlternative[] {
  const seen = new Map<string, DeclaredPathAlternative>();
  for (const alt of alts) if (!seen.has(alt.glob)) seen.set(alt.glob, alt);
  return [...seen.values()];
}

/**
 * The gate's `unmeasurable` predicate — declared paths exist, but none of them
 * is a concrete or glob path the diff could ever be checked against.
 *
 * This is the shape that #1155 turns from a PARK into a WARNING. The two
 * pre-existing reasons for `unmeasurable` (no paths at all, or every path
 * normalising away) are covered by the caller's own `paths.length === 0`
 * branch, which is deliberately left alone — the #792 no-diff marker decision
 * keys on exactly that branch and must not move.
 */
export function declaresNoMeasurablePath(paths: readonly string[] | undefined): boolean {
  const alts = allAlternatives(paths);
  return alts.length > 0 && !alts.some(measurableAlternative);
}

/**
 * Does this declared-path list contain at least one measurable alternative?
 * The positive form of `declaresNoMeasurablePath`, and the form the two gates
 * actually call: `classifyDeliverables` needs "is there anything to check" and
 * the #819 coverage gate needs "is this deliverable judgeable at all".
 */
export function declaresMeasurablePath(paths: readonly string[] | undefined): boolean {
  return allAlternatives(paths).some(measurableAlternative);
}

/**
 * Does a declared path slot carry at least one alternative the gate can MEASURE?
 *
 * Measurable = concrete or glob, AND a plain repo-relative path (the shared
 * `isPlainRepoRelativePath` shape gate — it rejects absolute paths, `..`
 * traversal and shell metacharacters other than the `<…>`/`*` the template
 * form legitimately uses), AND not a filler word.
 *
 * A slot with several alternatives is measurable when ANY of them is: a
 * deliverable that offered `src/gone.ts or nonsense` still has a concrete path
 * to hold the diff to, and calling the whole deliverable unmeasurable because
 * one half was prose is how a real gap escapes the gate.
 *
 * Exported (with `declaresNoMeasurablePath` built on it) so the #819 plan gate
 * answers "is this slot judgeable?" with this function rather than a second
 * copy of the rules (#1155).
 */
export function measurableAlternative(alt: DeclaredPathAlternative): boolean {
  const candidate = alt.isGlob ? alt.glob : alt.raw;
  return isPlainRepoRelativePath(candidate) && !isPlaceholderPath(candidate);
}

/**
 * The path(s) the corrective re-dispatch and the operator should be shown for
 * a deliverable that no diff satisfied (#1155).
 *
 * A deliverable is `absent` only when NONE of its alternatives matched, so
 * every alternative is missing and every one is worth naming — that is the
 * pre-#1155 meaning of `missing`, kept. What this function adds is the shape
 * the corrective child needs: the `raw` forms (a `<name>` template visible as
 * a template, never as a filename to create), split out of the comma-list
 * lie the parser used to hand over.
 */
export function missingPathDisplays(
  presentAlternatives: readonly string[],
  declaredPaths: readonly string[] | undefined,
): string[] {
  const present = new Set(presentAlternatives);
  const out: string[] = [];
  for (const alt of allAlternatives(declaredPaths)) {
    if (present.has(alt.glob)) continue;
    if (!out.includes(alt.raw)) out.push(alt.raw);
  }
  return out;
}

/**
 * Does a declared path read as this diff path?
 *
 * Four rules, cheapest first:
 *
 *   1. EXACT — `a.ts` matches `a.ts` (the pre-#1155 rule, unchanged).
 *   2. DIRECTORY — a declared directory covers its contents, so a concrete
 *      path also matches anything beneath it with a `/` boundary (the
 *      pre-#1155 rule, unchanged). Containment runs ONE way only: a diff file
 *      never "covers" a declared path in the other direction here, because
 *      this predicate answers "did the work land", not "do two declarations
 *      collide".
 *   3. GLOB — a template alternative matches at SEGMENT level: `*` stands for
 *      exactly one path segment, so `extension/src/work-driver-*.ts` matches
 *      a sibling in that directory and NOT `extension/src/deep/work-driver-x.ts`.
 *      Anchored per segment deliberately: a single regex over the whole path
 *      with `.` semantics would let `src/<x>.ts` match `src/a/b.ts`, which is
 *      the false pass that would let a deliverable about one directory be
 *      satisfied by work in another.
 *   4. WORKSTREAM — `workstreamPaths` is the #1137 d2 `deliveredBy` channel: a
 *      sibling workstream whose declared path covers this one counts as
 *      having delivered it. Containment runs BOTH ways there (a workstream may
 *      declare the file while the deliverable declares its directory), which
 *      is the #819 ownership rule, and a workstream that declared no
 *      measurable path can stand in for none.
 *
 * A glob NEVER gets the directory rule: a `src/` + wildcard prefix treated as
 * a directory would match `src/anything/deep/x.ts` through a `startsWith` on
 * the wildcard text, which the segment rule above refuses.
 */
export function declaredPathMatches(
  declared: string,
  diffFiles: ReadonlySet<string>,
  workstreamPaths?: readonly string[],
): boolean {
  const alternatives = dedupeAlternatives(splitDeliverablePaths(declared).map(toAlternative));
  if (alternatives.length === 0) return false;
  if (workstreamPaths?.length) {
    const wsAlternatives = dedupeAlternatives(
      workstreamPaths.flatMap((ws) => splitDeliverablePaths(ws).map(toAlternative)),
    );
    if (wsAlternatives.length === 0) return false;
    // OWNERSHIP is one-directional: a workstream path covers a deliverable
    // path, never the reverse. `owns(a, w)` would ask the deliverable to own
    // the declaration, and since every declared path trivially "owns" itself
    // (same text), the whole pool collapsed to a self-match and ANY
    // non-empty workstream set covered every deliverable — the coverage gate
    // would have passed a plan that declared nothing related.
    const matched = alternatives.some((a) =>
      wsAlternatives.some((w) => owns(w, a) || covers(w, a)),
    );
    if (matched) return true;
  }
  for (const alt of alternatives) {
    for (const f of diffFiles) {
      if (f === alt.raw) return true;
      if (alt.isGlob) {
        if (globMatchesSegments(alt.glob, f)) return true;
      } else if (f.startsWith(`${alt.raw}/`)) {
        return true;
      }
    }
  }
  return false;
}

/** Does the concrete path `parent` sit above the concrete path `child`? */
function concreteCovers(parent: string, child: string): boolean {
  return child.startsWith(`${parent}/`);
}

/**
 * Does `outer` cover `inner`? Runs the segment rule in both directions, so
 * either side may be the template: a workstream that declared
 * `src/work-driver-<name>.ts` covers the deliverable `src/work-driver-a.ts`,
 * and a deliverable that declared `src/<x>.ts` covers the workstream file.
 */
function covers(outer: DeclaredPathAlternative, inner: DeclaredPathAlternative): boolean {
  if (outer.isGlob) return globMatchesSegments(outer.glob, inner.raw);
  return concreteCovers(outer.raw, inner.raw);
}

/**
 * The workstream-ownership form of the question: does the pool of declared
 * workstream paths cover this declared path?
 *
 * Ownership is ONE-directional (the pool covers the declaration). A concrete
 * path in the pool also covers a declaration beneath it, and a template in the
 * pool covers any concrete declaration it matches — which is what lets a
 * workstream that declared `src/work-driver-<name>.ts` cover the deliverable
 * `src/work-driver-a.ts`.
 *
 * Exported so the #819 plan-to-spec gate asks it with the SAME slot semantics
 * as the converge gate's diff matching — one slot is covered when ANY of its
 * alternatives is, which is the decided "delivered when ANY alternative
 * matches" rule read against declarations instead of a diff. The two gates
 * share one matcher for that reason: if each kept its own, a plan could be
 * rejected at plan time for work develop would have passed.
 */
export function declaredPathsCoveredBy(
  declared: string,
  workstreamPaths: readonly string[],
): boolean {
  const alternatives = dedupeAlternatives(splitDeliverablePaths(declared).map(toAlternative));
  if (alternatives.length === 0) return false;
  const wsAlternatives = dedupeAlternatives(
    workstreamPaths.flatMap((ws) => splitDeliverablePaths(ws).map(toAlternative)),
  );
  if (wsAlternatives.length === 0) return false;
  // Ownership runs in both directions. The forward one is the #819 rule: the
  // pool covers the declaration (a workstream that declared `extension/src`
  // covers the deliverable `extension/src/integrate.ts`, and a pool TEMPLATE
  // covers any concrete declaration it matches). The reverse is the #1137
  // "sibling delivered it" reading, and it asks the CONCRETE question only —
  // a declaration sitting above a pool entry — because running the template
  // rule in that direction means every declared path trivially matches its own
  // template and the gate covers everything by construction. That is the
  // self-match the earlier draft shipped and why a concrete pool entry alone
  // still cannot claim a whole-directory template.
  return alternatives.some((a) =>
    wsAlternatives.some(
      (w) => owns(w, a) || covers(w, a) || (!a.isGlob && !w.isGlob && concreteCovers(a.raw, w.raw)),
    ),
  );
}

function owns(wsPath: DeclaredPathAlternative, deliverable: DeclaredPathAlternative): boolean {
  if (wsPath.raw === deliverable.raw) return true;
  return covers(wsPath, deliverable);
}

/**
 * Segment-anchored glob match: every `*` consumes exactly one path segment.
 *
 * Regex-special characters are escaped individually rather than through a
 * group — a capture group would shift `match()`'s indices and the segment
 * arithmetic below reads them.
 */
export function globMatchesSegments(glob: string, filePath: string): boolean {
  if (!glob.includes("*")) return glob === filePath;
  // Two-stage replace, in a deliberate order. Stage 1 escapes every regex
  // special EXCEPT `*`, leaving the wildcards live; stage 2 substitutes the
  // segment rule for each live `*`. Escaping is done with a single-`
  // $&`-over-a-character-class replacement rather than a per-character map,
  // because the class is the one place the set of escaped characters is
  // written down.
  const source = escapeForSegmentRegex(glob).replaceAll("*", SEGMENT_PATTERN);
  const matched = new RegExp(`^${source}$`).exec(filePath)?.[0];
  // Belt-and-braces over the segment rule: a `*` may never be the part of the
  // match that spans a `/`. `[^/]+` already cannot, so this never fires today
  // — it is here because the false pass it guards against (a deliverable about
  // one directory satisfied by work in another) is the failure this whole
  // matcher exists to avoid, and a guard nobody can trigger is cheaper than a
  // silent wrong verdict.
  return matched !== undefined && matched.length > 0 && !matched.includes("//");
}

/** One path segment: any run of characters that does not contain a `/`. */
const SEGMENT_PATTERN = "[^/]+";

/**
 * Regex specials EXCEPT `*`, which the caller substitutes with the segment
 * rule. `-` is in the class deliberately: it is regex-inert outside a
 * character class, so escaping it is harmless, and including it means a
 * hyphenated template (`work-driver-*.ts`) escapes through stage 1 unchanged
 * except for the hyphen — which stays literal in the final source.
 */
const REGEX_SPECIALS = /[.+?^${}()|[\]\\-]/g;

function escapeForSegmentRegex(s: string): string {
  return s.replace(REGEX_SPECIALS, "\\$&");
}
