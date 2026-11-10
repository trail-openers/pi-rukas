/**
 * lean/specify-requirements — the specify step's half of the requirement lever.
 *
 * `requirements.ts` holds the RULE (what an item is, how a gap is judged, how the
 * list renders). This module holds the step's USE of it: run the child's
 * `preserved` items against the repository's own test files, decide which gaps
 * are charged to the child and which are merely recorded, and shape what the
 * attempt returns for each case.
 *
 * Two rules split a gap into a CHARGE and a RECORD, and both are about what the
 * next round can actually change:
 *
 *   - An uncovered behaviour or edge item the child left WITHOUT a `note` asserts
 *     coverage the step cannot honour. That is the one thing a retry can fix —
 *     the child writes the test it skipped — so it becomes a refusal line on the
 *     attempt, and `specify.ts` gates its bounded retry on exactly that channel.
 *   - An item the child EXPLAINED with a `note`, and every `preserved` item, is a
 *     confession rather than a claim. No retry can conjure a project test that
 *     predates the run, so spending the step's single retry on it would trade a
 *     recorded gap for an unrecorded one. It is recorded, with the child's reason.
 *
 * An item cannot be covered by a red filed under a criterion that merely happens
 * to exercise the same code: coverage is read from the item's OWN file list, so
 * the child is asked whether IT covered IT. A `preserved` item is never satisfied
 * by a red file either — a red proves a behaviour does not work today, which is
 * the opposite of the claim — so those files are run at the head, beside the
 * pipeline rather than through it (the pipeline deletes everything that is not
 * red) and only against paths that existed at the run's base.
 *
 * Split out of `specify-attempt.ts`, which is at its file-size ceiling and whose
 * remaining half is the dispatch-and-pipeline flow.
 */

import { proveExistingTestsGreen } from "./requirements-existing.ts";
import type { RequirementItem, RequirementsRecord } from "./requirements.ts";
import { idList, requirementGaps } from "./requirements.ts";
import type { TestRunLimits } from "./specify-proof.ts";
import type { Outcome } from "./state.ts";
import { joinNotes } from "./text-fence.ts";

/** The executor seam, as `proveExistingTestsGreen` takes it. */
type Exec = Parameters<typeof proveExistingTestsGreen>[0];

/** What the coverage pass needs from the attempt around it. */
export interface RequirementCheckArgs {
  exec: Exec;
  /** The worktree the attempt's child wrote in. */
  wt: string;
  /** The project's `verify.test` runner template. */
  template: string;
  /** The files present at the run's base — the only ones a `preserved` item may name. */
  existingTests: ReadonlySet<string> | undefined;
  /** Per-file execution limits, forwarded to the preserved proof when set. */
  limits?: TestRunLimits;
  /** The paths the pipeline committed as red, keyed by criterion id. */
  frozenTests: Record<string, string[]>;
}

/** What the coverage pass decided about one round's list. */
export interface RequirementCheck {
  /** The record for the attempt's outcome, or `undefined` when nothing was named. */
  record: RequirementsRecord | undefined;
  /** Refusal lines charged to the child; empty when every gap was one it declared. */
  charged: string[];
  /** Every gap, charged or not — the reason line names these. */
  gaps: string[];
}

/**
 * Judge one round's requirement list against what the step proved.
 *
 * Returns no record at all when the child named no items: `submit_requirements`
 * is registered for every specify dispatch, so an off-state run whose child
 * guessed the tool — or an on-state child that filled in nothing — must not gain
 * a coverage record the step cannot stand behind.
 */
export async function checkRequirements(
  args: RequirementCheckArgs,
  items: readonly RequirementItem[],
): Promise<RequirementCheck> {
  if (items.length === 0) return { record: undefined, charged: [], gaps: [] };
  // The preserved half is settled by running the named EXISTING files at the
  // head, beside the pipeline rather than through it.
  const green = await proveExistingTestsGreen(args.exec, {
    wt: args.wt,
    template: args.template,
    paths: items.flatMap((i) => (i.kind === "preserved" ? i.testFiles : [])),
    allowed: args.existingTests ?? new Set<string>(),
    ...(args.limits === undefined ? {} : { limits: args.limits }),
  });
  const { record, gaps } = requirementGaps(items, {
    redFor: (id) => keptRed(args.frozenTests, id, items),
    green,
  });
  const charged = record.items
    .filter((item) => item.gap !== undefined && chargeable(item))
    .map((item) => item.gap ?? "");
  return { record, charged, gaps };
}

/**
 * Whether an uncovered item is charged to the child. `requirements.ts` puts a
 * `gap` line on every uncovered behaviour/edge item; only a bare item — one the
 * child offered without a reason — asserts coverage the step could not honour.
 */
function chargeable(item: { kind: string; reason?: string }): boolean {
  return item.kind !== "preserved" && item.reason === undefined;
}

/**
 * The paths the pipeline proved RED that this item itself named.
 *
 * The pipeline's `tests` map is keyed by CRITERION, a requirement by its own id,
 * and the two lists are different claims about the same files. An item is
 * covered only by a red it named itself — see the module header.
 */
function keptRed(
  tests: Record<string, string[]>,
  id: string,
  items: readonly { id: string; testFiles: string[] }[],
): string[] {
  const item = items.find((i) => i.id === id);
  if (item === undefined) return [];
  const froze = new Set(Object.values(tests).flat());
  return item.testFiles.filter((p) => froze.has(p));
}

/** The clause that says which items went uncovered, capped so one long list cannot bloat a reason. */
export function gapNote(gaps: string[]): string {
  if (gaps.length === 0) return "";
  const ids = gaps.map((g) => /^requirement (\S+) /.exec(g)?.[1] ?? g);
  return `requirement coverage: uncovered ${idList(ids)}`;
}

/** Fold a coverage clause into an outcome's reason, leaving the outcome otherwise untouched. */
export function withCoverageReason(outcome: Outcome, gaps: string[]): Outcome {
  if (gaps.length === 0 || outcome.kind !== "ok") return outcome;
  return { ...outcome, reason: joinNotes([outcome.reason ?? "", gapNote(gaps)]) };
}
