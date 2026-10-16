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
import { trace } from "./trace.ts";

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
/**
 * The outcome of the pre-filing label read, as a discriminated union (#1377).
 *
 * A bare `string[] | null` could not say WHICH non-answer happened, and the two
 * non-answers have different fixes: a CLI that failed (or a test stub that never
 * implemented the read) is an environment problem the operator may clear by
 * retrying, while a page-full read says the repo has more labels than either CLI
 * can enumerate in one call — the fix is to grant the label or drop it, not to
 * re-run. Collapsing both into "unreadable" also threw away the CLI's own error
 * text, which is the only thing that tells the operator WHY (auth, rate limit, a
 * renamed subcommand). So each arm carries its own reason and, for a failed
 * read, the CLI detail the caller traces.
 */
export type LabelRead =
  | { ok: true; names: string[] }
  | { ok: false; reason: "read-failed"; detail: string }
  | { ok: false; reason: "truncated" };

/**
 * Read the repo's label names through an already-resolved adapter (#1377).
 *
 * The plan driver's forge seam injects a STUB for the create call, and the same
 * stub must answer the label read — but a stub that never implemented
 * `labelList` (every pre-existing plan test stub is a partial object cast to
 * `Forge`) must not turn into "these labels do not exist" and refuse a filing
 * that should run, nor into a crash. So a missing or throwing `labelList` is a
 * `read-failed` arm carrying the CLI error: the caller reports a halt rather
 * than answering the question it could not answer.
 *
 * A page-full read is the other non-answer, on its own arm. Both
 * CLIs page this list and neither has a read-all flag (`gh label list` exposes
 * only `--limit`; `glab label list` only `--page`/`--per-page` — verified
 * against `gh label list --help` and the `glab-label-list(1)` man page), so the
 * read asks for the largest page available and treats a row count that reaches
 * it as "possibly more beyond this". A label that lives past the page would
 * otherwise be reported MISSING, which is the wrong answer in the expensive
 * direction: the filing is refused, and the driver never creates the label to
 * correct it.
 */
export async function readLabelNames(forge: Forge): Promise<LabelRead> {
  // Awaited INSIDE the try, not before it: a `labelList` that REJECTS must land
  // on the `read-failed` arm carrying the CLI's words, and an assignment outside
  // the try is how that error escapes to the caller as an exception.
  try {
    const read = await forge.labelList();
    if (!read || !Array.isArray(read.names)) {
      return { ok: false, reason: "read-failed", detail: "the adapter returned no label list" };
    }
    if (read.truncated) return { ok: false, reason: "truncated" };
    return { ok: true, names: read.names };
  } catch (err) {
    // The CLI's own words, kept rather than dropped. Before this the bare catch
    // turned an `gh: HTTP 401 (bad token)` into the same nothing as a page-full
    // read, and the operator saw a halt with no cause to act on.
    return {
      ok: false,
      reason: "read-failed",
      detail: err instanceof Error ? err.message : String(err),
    };
  }
}

/** What `missingLabels` can answer: the diff, or why the question went unanswered. */
export type MissingLabels =
  | { ok: true; missing: string[] }
  | { ok: false; reason: "read-failed"; detail: string }
  | { ok: false; reason: "truncated" };

/**
 * The labels a filing may not carry, because the target repo does not have them,
 * or the reason the question could not be answered. `[]` when every requested
 * label exists (or none was requested); the `read-failed` / `truncated` arms
 * when the list could not be read in full — a read failure or a truncated page
 * is never reported as "missing".
 */
export async function missingLabels(labels: string[], forge: Forge): Promise<MissingLabels> {
  if (labels.length === 0) return { ok: true, missing: [] };
  const read = await readLabelNames(forge);
  if (!read.ok) return read;
  return { ok: true, missing: labels.filter((l) => !read.names.includes(l)) };
}

/**
 * The labels a filing may not carry, as the discriminated reason the filing
 * result carries. The two answers the read can give get TWO reasons, because
 * they have different fixes and the operator sees only this text:
 *
 *   - `label-missing` — the full label set WAS read and the repo does not have
 *     the name. The fix is to create the label or drop it from the call.
 *   - `label-list-unreadable` — the question was never answered (the CLI failed,
 *     the adapter has no such read, or the set is larger than one page). The fix
 *     is to make the read work, not to create anything; and the CLI's own error
 *     is traced so the cause is recoverable.
 *
 * A missing label is NEVER created as a side effect of filing (that would let a
 * caller mutate repo configuration through a ticket) and the issue is never
 * filed unlabelled (the whole point is that the marker is there from the first
 * moment). So nothing files under either reason.
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
  const read = await missingLabels(labels, forge);
  if (!read.ok) {
    // Name the cause in the log; the detail line the operator sees cannot carry
    // an arbitrary CLI string (it may quote the caller's own argv) but it does
    // say which of the two non-answers happened.
    trace(
      `plan-labels: the pre-filing label read did not answer (${read.reason}${
        read.reason === "read-failed" ? `: ${read.detail}` : ""
      }) — filing halted rather than guessing`,
    );
    return {
      reason: "label-list-unreadable",
      detail: `could not read the repository's full label set to verify ${labels.join(", ")} — nothing was filed (${read.reason === "read-failed" ? "the CLI's label list is unreadable" : "the set is larger than the largest page either CLI reads"}; grant the label(s) directly or drop them from the call, and re-run start_plan_driver)`,
    };
  }
  if (read.missing.length === 0) return undefined;
  return {
    reason: "label-missing",
    detail: `the requested label(s) do not exist on the target repo: ${read.missing.join(", ")} — nothing was filed and no label was created (create the label(s), or drop them from the call)`,
  };
}
