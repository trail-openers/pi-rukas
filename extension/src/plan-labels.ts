/**
 * plan-labels — #1377: the pre-filing existence check for caller-supplied labels.
 *
 * Split out of plan-filing.ts along the 500-line seam (AGENTS.md §12): the
 * filing module owns the create call and its discriminated failures, this one
 * owns the check that has to run BEFORE it. The two together are what makes the
 * "label present from the first moment" guarantee: inside pi every role is
 * refused `gh issue create`, so a caller cannot label the issue itself, and a
 * follow-up `gh issue edit` would leave a window where an auto-filed ticket reads
 * as manual work to the work driver's backlog and the operator's queries.
 *
 * The rule is check-then-refuse, never create: `gh label create` as a side
 * effect of filing would let a caller mutate repo configuration through a ticket.
 */
import { detectForge } from "./forge-detect.ts";
import { type Forge, createForge } from "./forge.ts";

/**
 * Read the repo's label names through a throwaway adapter (#1377).
 *
 * The plan driver's forge seam injects a STUB for the create call, and the same
 * stub must answer the label read — but a stub that never implemented
 * `labelList` (every pre-existing plan test stub is a partial object cast to
 * `Forge`) must not turn into "these labels do not exist" and refuse a filing
 * that should run, nor into a crash. So a missing or throwing `labelList` is
 * `null` here: "could not read", which the caller reports as a halt rather than
 * answering the question it could not answer.
 */
export async function readLabelNames(
  resolveForge: () => Promise<Forge | undefined>,
): Promise<string[] | null> {
  const resolved = await resolveForge();
  if (!resolved) return null;
  try {
    const names = await resolved.labelList();
    return Array.isArray(names) ? names : null;
  } catch {
    return null;
  }
}

/**
 * The labels a filing may not carry, because the target repo does not have them.
 * `[]` when every requested label exists (or none was requested); `null` when
 * the list could not be read — a read failure is never reported as "missing".
 */
export async function missingLabels(
  labels: string[],
  resolveForge: () => Promise<Forge | undefined>,
): Promise<string[] | null> {
  if (labels.length === 0) return [];
  const existing = await readLabelNames(resolveForge);
  if (existing === null) return null;
  return labels.filter((l) => !existing.includes(l));
}

/**
 * The production adapter for the label read, when the seam is not injected.
 * Detection failure is `undefined` (no forge), matching `planForgeFor`.
 */
export async function labelForgeFor(repoRoot: string): Promise<Forge | undefined> {
  if (process.env.PI_ENSEMBLE_FORGE === "none") return undefined;
  const det = await detectForge(repoRoot, {});
  if (det.forge === "unknown") return undefined;
  // A label read carries no labels — it is the one forge call in the filing
  // path that must never send them.
  return createForge(det, { cwd: repoRoot });
}
