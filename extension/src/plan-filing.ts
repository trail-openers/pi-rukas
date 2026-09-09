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
import { type Forge, createForge } from "./forge.ts";
import { trace } from "./trace.ts";

/**
 * A filing failure (or deliberate skip) with enough detail to diagnose it
 * WITHOUT setting PI_ENSEMBLE_DEBUG. Before D7, "filing failed or was
 * blocked" covered at least four situations (forge unresolved, create threw,
 * empty url, all-angles-failed skip) and the forge stderr reached only a
 * trace() call behind PI_ENSEMBLE_DEBUG=1.
 *
 * `cap-surface` is the DELIBERATE-SKIP case: the gap-gate cap routed to
 * surface because unresolved CRITICAL gaps remain (CRITICAL-only terminal
 * rule, #664 transposed — HIGH findings travel in the residual disclosure
 * instead, so they do NOT route to surface). The spec is NOT filed by
 * policy (it is surfaced to the operator). Nothing failed to resolve, so it
 * must NOT reuse `forge-unresolved`.
 *
 * `needs-clarification` and `draft-invalid` are the two DETERMINISTIC
 * skips: the pre-dispatch under-specification triage (plan-precheck.ts)
 * returned targeted questions instead of investigating, or the drafted
 * body failed mechanical validation (plan-validate.ts) before the gap gate
 * ever saw it. Both are policy skips, not failures.
 */
export interface FilingFailure {
  reason:
    | "forge-unresolved"
    | "create-error"
    | "empty-url"
    | "skipped-all-angles-failed"
    | "cap-surface"
    | "gate-unavailable"
    | "needs-clarification"
    | "draft-invalid"
    | "duplicate-risk"
    | "review-unparseable";
  detail?: string;
}

export interface FilingResult {
  url?: string;
  failure?: FilingFailure;
}

/**
 * File the spec via the forge adapter's `issueCreate`. The forge is resolved
 * through the seam `setPlanForge` (tests inject a stub; production uses
 * `planForgeFor`), and every failure path is DISCRIMINATED and carried on
 * the result — the forge's stderr (captured in the thrown Error message) is
 * included in the detail for `create-error` so the operator sees WHY the
 * issue did not file.
 */
export async function fileIssue(
  title: string,
  body: string,
  resolveForge: () => Promise<Forge | undefined>,
): Promise<FilingResult> {
  const resolved = await resolveForge();
  if (!resolved) {
    trace("plan-driver: no forge resolved — issue filing skipped");
    return { failure: { reason: "forge-unresolved" } };
  }
  try {
    const issue = await resolved.issueCreate(title, body);
    const url = issue.url;
    if (!url) {
      return {
        failure: {
          reason: "empty-url",
          detail: "the forge returned an issue with an empty url field",
        },
      };
    }
    return { url };
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
 * Resolve the forge adapter for the plan driver's filing step
 * (#612 S4 task-b). `PI_ENSEMBLE_FORGE=none` refuses; unknown detection
 * falls back to raw `gh` (pre-migration behaviour). Detection errors are no
 * longer swallowed silently (D7): they propagate to `fileIssue`'s catch and
 * are carried through the `create-error` failure.
 */
export async function planForgeFor(repoRoot: string): Promise<Forge | undefined> {
  if (process.env.PI_ENSEMBLE_FORGE === "none") return undefined;
  const det = await detectForge(repoRoot, {});
  if (det.forge === "unknown") return undefined;
  return createForge(det, { cwd: repoRoot });
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
