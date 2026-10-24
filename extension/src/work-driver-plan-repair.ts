/**
 * work-driver-plan-repair — the single-workstream repair of omitted spec
 * deliverable paths.
 *
 * The incident (#1439, run 5): the plan had ONE workstream, the spec named two
 * test files for one deliverable, and the planner left both out on two
 * attempts. The plan-to-spec gate (#819) parked the cycle as
 * `plan-spec-mismatch` before develop ever ran.
 *
 * With exactly one workstream there is no judgement left to make about WHICH
 * workstream owns a missing path: the only owner is the one workstream. So,
 * deterministically and before the one-shot corrective is spent, the driver
 * appends the omitted paths to that workstream's `paths` — and only when the
 * workstream already owns at least one measurable deliverable path (a plan that
 * covers nothing of the spec is a wrong plan, not an omitted one, and is left
 * to the gate) and every missing path is safe to add:
 *
 *   - a single plain path, not an either/or (`a.ts or b.ts` is a choice the
 *     planner must make, so it keeps today's behaviour);
 *   - acceptable to the planner's own path-shape gate (`plannedPathProblem`),
 *     so the driver never writes a path the plan-quality pass would itself
 *     refuse — the repair is held to the same bar the planner is;
 *   - not a protected path (`isProtectedPath`), granted or not;
 *   - not fenced in the workstream's `outOfScope`, in either containment
 *     direction (the path under the fence, or the fence under the path);
 *   - not a deferred protected path (#1642);
 *   - not carrying an invisible or control character (see {@link INVISIBLE_PATH}).
 *
 * The evidence that the plan targets THIS spec is also narrow: at least one of
 * the workstream's OWN declared paths must be a concrete plain file that a spec
 * deliverable names. A plan whose only overlap with the spec is a directory it
 * declared, or a glob/template, is not evidence of the right plan — the concrete
 * file is what says the planner meant this spec.
 *
 * One missing path that fails any of these and nothing is repaired: the gate
 * then runs exactly as before. N>1 workstreams are never repaired — which
 * workstream owns the path is a judgement.
 *
 * What the repair adds is disclosed on the resolved spec as one assumption, so
 * the PR body says what the driver changed rather than the plan silently
 * differing from the model's output.
 */

import { OPEN_POINT_CHAR_CAP } from "./open-points-reader.ts";
import { plannedPathProblem, quotedPaths } from "./plan-path-shape.ts";
import { boundPaths } from "./plan-paths-bound.ts";
import { flattenIssueText, redactThenBound } from "./text-flatten.ts";
import { fenceDirPrefix } from "./work-driver-declared-path.ts";
import {
  declaredPathsCoveredBy,
  isPlaceholderPath,
  measurableAlternative,
  splitDeliverablePaths,
  toAlternative,
} from "./work-driver-deliverable-paths.ts";
import { isProtectedPath } from "./work-driver-doctrine.ts";
import type { SpecAssumption } from "./work-driver-intent.ts";
import { deferredProtectedPaths } from "./work-driver-plan-fence.ts";
import { isPlainRepoRelativePath } from "./work-driver-plan-paths.ts";
import {
  type SpecCoverageSpec,
  findUncoveredDeliverables,
} from "./work-driver-plan-spec-coverage.ts";
import { normaliseDeclaredPath } from "./work-driver-verify.ts";
import type { Workstream } from "./workflow-state-schema.ts";
import type { WorkState } from "./workflow-state.ts";

/** A repair: the workstreams with the paths appended, and what was appended. */
type OmittedPathRepair = {
  workstreams: Record<string, Workstream>;
  added: string[];
};

/** The basis every repair assumption carries; rendered beside its text. */
const OMITTED_PATH_BASIS =
  "plan-to-spec gate (single-workstream repair): spec deliverable path the plan omitted";

/**
 * Format and control characters a spec slot can carry invisibly: Unicode `Cf`
 * (bidi overrides/isolates, zero-width characters, BOM, word joiner), every
 * `Cc` control character, and the line/paragraph separators U+2028/U+2029.
 *
 * The deliverable-path grammar is a whitelist over visible characters, so
 * nothing in it speaks for these: `\u200D` sits inside a segment, `\u200B` before
 * a dot, and the string still reads as an ordinary path to every reader and every
 * shape gate — `isPlainRepoRelativePath`'s `\s` and `plannedPathProblem`'s
 * `\t\r\n\v\f\0` are named ASCII classes, not general categories.
 * What an unlisted character then is, is whatever the reader is not looking at —
 * `.\u200Bgithub/workflows/ci.yml` reads as an ordinary file and is the protected
 * directory, and a RLO reorders what a reviewer sees. Refusing the character is
 * cheaper than teaching every downstream reader to see it (#1688).
 *
 * The tests build their probes with `String.fromCharCode`, never a literal: a
 * source file carrying a real bidi control is a review hazard of its own, and
 * `\p{Cc}`/`\p{Cf}` name them without one.
 */
const INVISIBLE_PATH = /[\p{Cf}\p{Cc}\u2028\u2029]/u;

/**
 * Appends the omitted deliverable paths to the sole workstream, or returns
 * `undefined` when there is nothing to repair, or when a repair is declined —
 * the caller then runs the gate unchanged. `onRefuse` receives the reason for
 * a decline, so the caller can trace it.
 */
export function repairOmittedDeliverablePaths(
  workstreams: Record<string, Workstream>,
  spec: SpecCoverageSpec | undefined,
  grant: readonly string[],
  onRefuse: (reason: string) => void = () => undefined,
): OmittedPathRepair | undefined {
  const refuse = (reason: string): undefined => {
    onRefuse(reason);
    return undefined;
  };
  const ids = Object.keys(workstreams);
  const [id] = ids;
  if (ids.length !== 1 || id === undefined) return undefined;
  const ws = workstreams[id];
  // Fail closed: without a normalised spec there is no deliverable to repair to.
  if (!ws || !spec) return undefined;
  const { uncovered } = findUncoveredDeliverables(workstreams, spec, grant);
  if (uncovered.length === 0) return undefined;
  // Evidence the plan targets THIS spec: one of the workstream's OWN declared
  // paths is a concrete plain file that a spec deliverable also names. The
  // three clauses each rule out a way a plan can "overlap" without having read
  // the spec: a workstream that declared only a directory covers deliverables
  // beneath it by prefix alone, and one that declared only a template covers
  // anything the glob matches — neither is evidence the planner meant this spec.
  // Without a concrete shared file the plan is wholly wrong, and extending it
  // would hide that rather than repair an omission.
  //
  // The WITNESS is the one path this function trusts without looking at it: the
  // comparison below is equality against the spec's own copy of the string, so the
  // character travels in both and no shape gate sees it. Judged on the raw declared
  // form (what is stored and what `quotedPaths` renders to a model-run shell),
  // because `normaliseDeclaredPath` strips only ASCII backticks/whitespace and an
  // annotation — a zero-width survives it. Runs BEFORE the test itself, so a plan
  // whose only witness is poisoned never reads as the right plan.
  for (const witness of ws.paths) {
    if (INVISIBLE_PATH.test(witness))
      return refuse(
        `${JSON.stringify(witness)}: an invisible or control character in a declared path cannot witness a repair`,
      );
  }
  const targetsSpec = (spec.deliverables ?? []).some((d) =>
    d.paths.some((slot) =>
      splitDeliverablePaths(slot)
        .map(toAlternative)
        .some(
          (alt) =>
            !alt.isGlob &&
            measurableAlternative(alt) &&
            ws.paths
              .map((p) => normaliseDeclaredPath(p))
              .some((declared) => declared === alt.raw && isConcreteRepairPath(declared)),
        ),
    ),
  );
  if (!targetsSpec)
    return refuse(
      "the sole workstream covers no spec deliverable path, so it is the wrong plan, not an omitted one",
    );

  const deferred = new Set(deferredProtectedPaths(spec, grant));
  // Containment runs BOTH ways, the same reading `findFenceContradictions` uses:
  // a fence under the path (the path is inside a fenced directory) and a fence
  // over it (the planner fenced `src/a.ts` and declared only `src/a.ts/notes.md`)
  // both say "do not touch this". The FENCE side is read by `fenceDirPrefix`, so
  // the directory spelling `extension/src/**` fences `extension/src/foo.ts` —
  // #1707 round 4: with the wildcard merely surviving `normaliseDeclaredPath`
  // this predicate matched nothing, and the repair appended a path the plan had
  // deliberately fenced out.
  const fences = ws.outOfScope.map(fenceDirPrefix).filter((n) => n.length > 0);
  const fenced = (path: string) =>
    fences.some((n) => path === n || path.startsWith(`${n}/`) || n.startsWith(`${path}/`));
  const added: string[] = [];
  for (const row of uncovered) {
    for (const slot of row.paths) {
      // Already covered by the workstream: only the missing slots are added.
      if (declaredPathsCoveredBy(slot, ws.paths)) continue;
      // An either/or slot is the planner's choice between alternatives, and a
      // template (`<name>`, `work-driver-<name>.ts`) is a pattern, not a file:
      // writing it literally is the #1155 failure the grammar exists to prevent.
      const alternatives = splitDeliverablePaths(slot).map(toAlternative);
      const [alt] = alternatives;
      if (alternatives.length !== 1 || alt === undefined)
        return refuse(`${slot}: an either/or slot is the planner's choice`);
      if (alt.isGlob || !measurableAlternative(alt))
        return refuse(`${slot}: not a single measurable file path`);
      const path = normaliseDeclaredPath(alt.raw);
      if (path.length === 0) return refuse(`${slot}: empty after normalisation`);
      // Runs BEFORE the shape gate and before the protected-path check: both
      // compare visible text, so `isProtectedPath(".\u200Bgithub/…")` is false and
      // `plannedPathProblem` has no clause for a character its grammar never
      // mentions. The RAW slot is judged as well as the normalised path, since the
      // normaliser strips only ASCII backticks/whitespace and an annotation.
      if (INVISIBLE_PATH.test(slot))
        return refuse(`${JSON.stringify(slot)}: invisible or control character in the slot`);
      if (INVISIBLE_PATH.test(path))
        return refuse(`${JSON.stringify(path)}: invisible or control character in the path`);
      // The planner's own path-shape gate, run on the normalised path before it
      // is appended: whatever the plan-quality pass would refuse as an
      // `invalid-path`, the driver must not write into the plan itself.
      const shapeProblem = plannedPathProblem(path);
      if (shapeProblem !== undefined) return refuse(`${slot}: ${shapeProblem}`);
      if (isProtectedRepairPath(path)) return refuse(`${path}: protected path`);
      if (fenced(path)) return refuse(`${path}: fenced in the workstream's outOfScope`);
      if (deferred.has(path)) return refuse(`${path}: deferred protected path`);
      if (!added.includes(path)) added.push(path);
    }
  }
  if (added.length === 0) return undefined;
  // Every paths writer dedupes the same way (#1756 part b): the repair appends
  // to a list the plan step already bounded, and a slot that reached here
  // through a different spelling can still be a file the plan declared. The
  // driver must not store a second entry for it — the fanout denominator reads
  // this list, and the prompts print it.
  return {
    workstreams: { [id]: { ...ws, paths: boundPaths([...ws.paths, ...added]).paths } },
    added,
  };
}

/**
 * A repair never adds a protected path, however it is spelled: `.GitHub/…`,
 * `.PI/verify-cmd` and a bare `.pi` are the same capabilities on a
 * case-insensitive checkout.
 */
function isProtectedRepairPath(path: string): boolean {
  const folded = path.replace(/\\/g, "/").toLowerCase();
  if (folded.split("/").some((s) => s === ".github" || s === ".pi")) return true;
  return isProtectedPath(path) || isProtectedPath(folded);
}

/**
 * A declared workstream path that is a concrete plain file, not a directory,
 * glob or template. `isPlainRepoRelativePath` is the shared shape gate (it
 * refuses `..`, absolute paths and shell metacharacters); `*` and `?` pass it
 * only because the deliverable grammar needs them, so the glob forms are
 * refused here on top. The `targetsSpec` witness must be a file a developer
 * actually wrote.
 */
function isConcreteRepairPath(declared: string): boolean {
  if (declared.includes("*") || declared.includes("?")) return false;
  return isPlainRepoRelativePath(declared) && !isPlaceholderPath(declared);
}

/** The one line a reviewer reads for the repair. */
function omittedPathAssumptionText(added: readonly string[]): string {
  return `driver added spec deliverable paths the plan omitted: ${added.join(", ")}`;
}

/**
 * Returns `state` with one assumption recording the repair appended to
 * `pipelineState.normalisedSpec` (idempotent), promoting a `proceed` verdict to
 * `proceed-with-assumptions` as the deferral notice does. Without a normalised
 * spec the trace is the only record.
 */
export function withOmittedPathAssumption(state: WorkState, added: readonly string[]): WorkState {
  const ns = state.pipelineState.normalisedSpec;
  if (!ns || added.length === 0) return state;
  const text = omittedPathAssumptionText(added);
  // The same normalisation `boundEntry` in open-points-reader.ts applies to every
  // stored open-point line, in the same order: redact, bound, then flatten. This
  // assumption is appended AFTER the #1187 finalise pass ran, so it normalises
  // itself rather than relying on a pass that already finished. The flatten is what
  // keeps the PR body one bullet: a path with a newline would forge a second line
  // and a bidi override reorders what the reviewer reads. A path carrying one of
  // those is refused by the gate above — this is the backstop for the rest of the
  // line, whose visible half can still carry a character this gate's class accepts
  // as whitespace.
  const bound = flattenIssueText(redactThenBound(text, OPEN_POINT_CHAR_CAP).text);
  if (ns.assumptions.some((a) => a.text === bound)) return state;
  const assumption: SpecAssumption = { text: bound, basis: OMITTED_PATH_BASIS };
  const verdict = ns.verdict === "proceed" ? "proceed-with-assumptions" : ns.verdict;
  return {
    ...state,
    pipelineState: {
      ...state.pipelineState,
      normalisedSpec: {
        ...ns,
        verdict,
        assumptions: [...ns.assumptions, assumption],
      },
    },
  };
}
