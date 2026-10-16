/**
 * plan-labels — #1377: the pre-filing existence check for caller-supplied labels.
 *
 * Split out of plan-filing.ts along the 500-line seam (AGENTS.md §12): the
 * filing module owns the create call and its discriminated failures, this one
 * owns the check that has to run BEFORE it — and now owns the whole check, both
 * halves, so the read, the diff, the truncation verdict and the reason string
 * that names them live in one file instead of split across two. The two
 * together are what makes the "label present from the first moment" guarantee:
 * inside pi every role is refused `gh issue create`, so a caller cannot label
 * the issue itself, and a follow-up `gh issue edit` would leave a window where
 * an auto-filed ticket reads as manual work to the work driver's backlog and
 * the operator's queries.
 *
 * The rule is check-then-refuse, never create: `gh label create` as a side
 * effect of filing would let a caller mutate repo configuration through a ticket.
 */
import type { Forge } from "./forge.ts";
import type { FilingFailure } from "./plan-filing.ts";

/**
 * Read the repo's label names through an already-resolved adapter (#1377).
 *
 * The plan driver's forge seam injects a STUB for the create call, and the same
 * stub must answer the label read — but a stub that never implemented
 * `labelList` (every pre-existing plan test stub is a partial object cast to
 * `Forge`) must not turn into "these labels do not exist" and refuse a filing
 * that should run, nor into a crash. So a missing or throwing `labelList` is
 * `null` here: "could not read", which the caller reports as a halt rather than
 * answering the question it could not answer.
 *
 * A page-full read is the same kind of non-answer and returns `null` too. Both
 * CLIs page this list and neither has a read-all flag (`gh label list` exposes
 * only `--limit`; `glab label list` only `--page`/`--per-page` — verified
 * against `gh label list --help` and the `glab-label-list(1)` man page), so the
 * read asks for the largest page available and treats a row count that reaches
 * it as "possibly more beyond this". A label that lives past the page would
 * otherwise be reported MISSING, which is the wrong answer in the expensive
 * direction: the filing is refused, and the driver never creates the label to
 * correct it.
 */
export async function readLabelNames(forge: Forge): Promise<string[] | null> {
  try {
    const read = await forge.labelList();
    if (!read || !Array.isArray(read.names)) return null;
    if (read.truncated) return null;
    return read.names;
  } catch {
    return null;
  }
}

/**
 * The labels a filing may not carry, because the target repo does not have them.
 * `[]` when every requested label exists (or none was requested); `null` when
 * the list could not be read in full — a read failure or a truncated page is
 * never reported as "missing".
 */
export async function missingLabels(labels: string[], forge: Forge): Promise<string[] | null> {
  if (labels.length === 0) return [];
  const existing = await readLabelNames(forge);
  if (existing === null) return null;
  return labels.filter((l) => !existing.includes(l));
}

/**
 * The labels a filing may not carry, as the discriminated reason the filing
 * result carries (`label-missing`). The detail line distinguishes the two ways
 * the answer arrives — the repo genuinely lacks the label, versus the full
 * label set could not be read — because they have different fixes and the
 * operator sees only this text.
 *
 * A missing label is NEVER created as a side effect of filing (that would let a
 * caller mutate repo configuration through a ticket) and the issue is never
 * filed unlabelled (the whole point is that the marker is there from the first
 * moment). So nothing files. An unreadable or page-truncated label list is
 * reported as such rather than as "missing" — a flaky CLI must not refuse
 * legitimate filings, and must not pretend to have answered.
 *
 * Takes the RESOLVED adapter, not a resolver: the filing resolves the forge once
 * and hands the same object to the gate and to `fileIssue`. Two resolves would
 * mean two `detectForge` git reads per filing, and — with a stubbed seam — two
 * chances for the read and the create to disagree about which forge they are on.
 */
export async function labelGate(
  labels: string[],
  forge: Forge,
): Promise<FilingFailure | undefined> {
  if (labels.length === 0) return undefined;
  const missing = await missingLabels(labels, forge);
  if (missing === null) {
    return {
      reason: "label-missing",
      detail: `could not read the repository's full label set to verify ${labels.join(", ")} — nothing was filed (the CLI's label list is unreadable, or larger than the largest page either CLI reads; grant the label(s) directly or drop them from the call, and re-run start_plan_driver)`,
    };
  }
  if (missing.length === 0) return undefined;
  return {
    reason: "label-missing",
    detail: `the requested label(s) do not exist on the target repo: ${missing.join(", ")} — nothing was filed and no label was created (create the label(s), or drop them from the call)`,
  };
}
