/**
 * plan-filing — Phase 5 of the compiled /plan pipeline.
 *
 * Split out of plan-driver.ts at the same seam as forge-ci.ts / plan-gaps.ts
 * (the 500-line hard limit, AGENTS.md §12). Owns:
 *
 *   - `fileIssue`: the filing seam (forge resolve → issueCreate → discriminated
 *     failure reasons),
 *   - `planForgeFor`: forge adapter resolution (detectForge + createForge),
 *   - `setPlanForge`: the injectable forge-resolution seam (tests),
 *   - the `FilingFailure` / `FilingResult` types (D7: discriminated reasons).
 *
 * The `FilingFailure.reason` union is declared ONCE here and re-exported;
 * `PlanResult.filingFailure` (plan-types.ts) references this type, so a
 * reason added on the filing side is forced onto the type side.
 */
import { detectForge } from "./forge-detect.ts";
import type { FileIssueOpts } from "./forge-types.ts";
import { type Forge, createForge } from "./forge.ts";
import { missingLabels } from "./plan-labels.ts";
import { trace } from "./trace.ts";

/**
 * A filing failure (or deliberate skip) with enough detail to diagnose it
 * WITHOUT setting PI_ENSEMBLE_DEBUG. Before D7, "filing failed or was
 * blocked" covered at least four situations (forge unresolved, create threw,
 * empty url, all-angles-failed skip) and the forge stderr reached only a
 * trace() call behind PI_ENSEMBLE_DEBUG=1.
 *
 * `needs-clarification` and `draft-invalid` are the two DETERMINISTIC
 * skips: the pre-dispatch under-specification triage (plan-precheck.ts)
 * returned targeted questions instead of investigating, or the drafted
 * body failed mechanical validation (plan-validate.ts) before the gap gate
 * ever saw it. Both are policy skips, not failures.
 *
 * `label-missing` (#1377) is a third deterministic skip: a caller asked for
 * labels the target repo does not have. Nothing is filed and no label is
 * created — the detail names the missing ones.
 */
export interface FilingFailure {
  reason:
    | "forge-unresolved"
    | "create-error"
    | "empty-url"
    | "skipped-all-angles-failed"
    | "gate-unavailable"
    | "needs-clarification"
    | "draft-invalid"
    | "duplicate-risk"
    | "review-unparseable"
    | "body-too-large"
    | "filing-in-progress"
    | "label-missing";
  detail?: string;
}

export interface FilingResult {
  url?: string;
  /**
   * #1377: the filed issue's number, from the forge's parsed response. Left
   * undefined when the forge gave a URL it could not number (the number is
   * convenience for the caller — `url` remains the authority).
   */
  number?: number;
  failure?: FilingFailure;
}

/**
 * Options a filing may carry beyond the title and body (#1377). Re-exported from
 * `forge-types.ts` — the single declaration lives there next to `NormalizedIssue`,
 * so the forge adapter never imports from the plan layer.
 */
export type { FileIssueOpts };

/**
 * File the spec via the forge adapter's `issueCreate`. The forge is resolved
 * through the seam `setPlanForge` (tests inject a stub; production uses
 * `planForgeFor`), and every failure path is DISCRIMINATED and carried on
 * the result — the forge's stderr (captured in the thrown Error message) is
 * included in the detail for `create-error` so the operator sees WHY the
 * issue did not file.
 *
 * #1377: `labels` reaches the create call through `createForge`'s opts (the
 * adapter renders one `--label` per label on gh, `--label a,b` on glab), and
 * the created issue's number travels back on the result so a caller does not
 * have to parse the URL itself.
 */
export async function fileIssue(
  title: string,
  body: string,
  resolveForge: () => Promise<Forge | undefined>,
  opts: FileIssueOpts = {},
): Promise<FilingResult> {
  const resolved = await resolveForge();
  if (!resolved) {
    trace("plan-driver: no forge resolved — issue filing skipped");
    return { failure: { reason: "forge-unresolved" } };
  }
  try {
    const issue = await resolved.issueCreate(title, body, opts);
    const url = issue.url;
    if (!url) {
      return {
        failure: {
          reason: "empty-url",
          detail: "the forge returned an issue with an empty url field",
        },
      };
    }
    return { url, number: issue.number };
  } catch (err) {
    // A non-Error throw (a plain string, as CLIs and JSON parsers throw)
    // has no `.message` — casting to Error would leave the detail silently
    // empty, degrading exactly the path D7 hardened. String() the fallback.
    const msg = err instanceof Error ? err.message : String(err);
    trace(`plan-driver: forge issueCreate failed: ${msg}`);
    return { failure: { reason: "create-error", detail: msg } };
  }
}

/**
 * #1377 — check the requested labels exist on the target repo BEFORE anything
 * files. The check itself (read the label list, diff it, fail-open on a read
 * error) lives in `missingLabels` (plan-labels.ts); this is the filing-side
 * half that turns the answer into the discriminated `label-missing` reason.
 *
 * A missing label is NEVER created as a side effect of filing (that would let a
 * caller mutate repo configuration through a ticket) and the issue is never
 * filed unlabelled (the whole point is that the marker is there from the first
 * moment). So nothing files. An unreadable label list is reported as such
 * rather than as "missing" — a flaky CLI must not refuse legitimate filings.
 */
export async function labelGate(
  labels: string[],
  resolveForge: () => Promise<Forge | undefined>,
): Promise<FilingFailure | undefined> {
  if (labels.length === 0) return undefined;
  const missing = await missingLabels(labels, resolveForge);
  if (missing === null) {
    return {
      reason: "label-missing",
      detail: `could not read the repository's labels to verify ${labels.join(", ")} — nothing was filed (fix the forge CLI access and re-run start_plan_driver)`,
    };
  }
  if (missing.length === 0) return undefined;
  return {
    reason: "label-missing",
    detail: `the requested label(s) do not exist on the target repo: ${missing.join(", ")} — nothing was filed and no label was created (create the label(s), or drop them from the call)`,
  };
}

/**
 * Resolve the forge adapter for the plan driver's filing step
 * (#612 S4 task-b). `PI_ENSEMBLE_FORGE=none` refuses; unknown detection
 * falls back to raw `gh` (pre-migration behaviour). Detection errors are no
 * longer swallowed silently (D7): they propagate to `fileIssue`'s catch and
 * are carried through the `create-error` failure.
 */
export async function planForgeFor(
  repoRoot: string,
  labels: string[] = [],
): Promise<Forge | undefined> {
  if (process.env.PI_ENSEMBLE_FORGE === "none") return undefined;
  const det = await detectForge(repoRoot, {});
  if (det.forge === "unknown") return undefined;
  return createForge(det, { cwd: repoRoot, labels });
}

/**
 * The forge-resolution seam, injectable so the smoke test can drive the
 * filing step with a stubbed forge (the `setPlanDispatch`-style DI the
 * driver's dispatch seam already uses — ESM namespaces are not mutable in
 * Bun, so the seam is a module-level setter).
 */
let _forgeResolver: (() => Promise<Forge | undefined>) | null = null;

/** Set a forge resolver stub for the next run (tests). Pass `null` to clear. */
export function setPlanForge(fn: (() => Promise<Forge | undefined>) | null): void {
  _forgeResolver = fn;
}

/** The current forge resolver (for the driver to use). */
export function getPlanForge(): (() => Promise<Forge | undefined>) | null {
  return _forgeResolver;
}
