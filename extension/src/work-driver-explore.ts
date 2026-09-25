/**
 * work-driver-explore — Step 1 (explore) handler.
 *
 * Extracted from work-driver.ts (issue #171 file-size hygiene). Dispatches
 * `@explore` with all requested issue bodies inlined, then routes on the
 * parsed verdict(s) via work-driver-plan.ts's parsers.
 */

import { exec } from "node:child_process";
import { promisify } from "node:util";
import { trace } from "./trace.ts";
import {
  jitteredMs,
  transientRetryBackoffMs,
  transientRetryEnabled,
} from "./work-driver-failure-taxonomy.ts";
import { forgeForCycle } from "./work-driver-forge-ctx.ts";

const execp = promisify(exec);

/** Per-attempt deadline for one `gh issue view` (45 s). */
export const ISSUE_BODY_TIMEOUT_MS = 45_000;
/** Attempts per issue body, including the first. */
const ISSUE_BODY_ATTEMPTS = 3;
type IssueBodyExec = (
  cmd: string,
  opts: { cwd: string; maxBuffer: number; timeout: number },
) => Promise<{ stdout: string }>;

/**
 * The production issue-body fetch. `execFn` is injected by the smoke test so
 * the per-attempt deadline is asserted rather than assumed.
 *
 * Routed through the forge adapter (S4 of epic #608, #612): the adapter is
 * built on the SAME injected seam with the per-attempt deadline carried in
 * `execOpts`. On a GitHub remote the adapter runs `gh issue view N` through
 * that seam. The body is rendered as `"<title>\n\n<body>"` — the `gh issue
 * view` plain-text shape the grouping and handoff renderers consume.
 */
export function fetchIssueBodyViaGh(
  issue: number,
  cwd: string,
  execFn: IssueBodyExec = execp,
): Promise<{ stdout: string }> {
  const exec = (cmd: string, opts?: { cwd?: string; maxBuffer?: number; timeout?: number }) =>
    execFn(cmd, opts as { cwd: string; maxBuffer: number; timeout: number });
  return forgeForCycle({ repoRoot: cwd }, exec, new Map(), {
    execOpts: { timeout: ISSUE_BODY_TIMEOUT_MS, maxBuffer: 256 * 1024 },
  }).then(async (f) => {
    if (!f) {
      // Forge undetermined — fail closed: the retry loop treats a rejection
      // as a failed attempt and the empty-body cap still parks the cycle.
      throw new Error("forge undetermined — cannot fetch issue body");
    }
    const d = await f.issueView(issue);
    return { stdout: `${d.title}\n\n${d.body}` };
  });
}

/**
 * Fetch one issue body, retrying a transient failure.
 *
 * A live cycle for issue #700 died 56 ms after step-started —
 * cap-hit `explore-bodies-empty`, before any dispatch ran — because a single
 * `gh issue view` hit a connection reset. Nothing was wrong with the issue;
 * the operator had to `--restart` and clear a `needs-human-attention` label.
 *
 * The retry belongs HERE, around the fetch and before the cap is appended:
 * `work-driver-step-router.ts` gives a `cap-hit` tail zero retries (its retry
 * branches are gated on `dispatch-failed*`), so a cap-hit is terminal by
 * construction.
 *
 * Empty stdout is retried as well as a rejection — a severed or truncated
 * response yields empty output, indistinguishable from a genuinely empty issue
 * until we have asked again.
 *
 * The cap itself is unchanged and still fails closed: a body that is still
 * empty (or still failing) after the last attempt is returned/thrown as-is and
 * halts the cycle.
 */
export async function fetchIssueBodyWithRetry(
  fetchBody: (issue: number, cwd: string) => Promise<{ stdout: string }>,
  issue: number,
  cwd: string,
  opts: { attempts?: number; sleep?: (ms: number) => Promise<void>; rand?: () => number } = {},
): Promise<{ stdout: string }> {
  const attempts = transientRetryEnabled() ? (opts.attempts ?? ISSUE_BODY_ATTEMPTS) : 1;
  const sleep = opts.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
  let lastError: unknown;
  let lastEmpty: { stdout: string } | undefined;
  for (let attempt = 1; attempt <= attempts; attempt++) {
    try {
      const result = await fetchBody(issue, cwd);
      if (result.stdout.trim()) return result;
      lastEmpty = result;
      lastError = undefined;
      trace(`work-driver: gh issue view ${issue} returned empty stdout (${attempt}/${attempts})`);
    } catch (err) {
      lastError = err;
      lastEmpty = undefined;
      trace(
        `work-driver: gh issue view ${issue} failed (${attempt}/${attempts}): ${(err as Error).message?.slice(0, 200)}`,
      );
    }
    if (attempt < attempts) {
      await sleep(jitteredMs(transientRetryBackoffMs() * attempt, 0, opts.rand ?? Math.random));
    }
  }
  if (lastError !== undefined) throw lastError;
  return lastEmpty ?? { stdout: "" };
}

/**
 * Did explore say anything the driver can act on? Two channels can carry a
 * decision: the `## Spec` block (intent path) and the legacy `EXPLORE-VERDICT`
 * token. Reaching this point means the spec block did not parse; if the legacy
 * token is absent too, explore produced no decision at all — and the driver
 * used to treat that as permission to proceed, planning and building against a
 * reply it could not read. A single-issue intent cycle is the case that
 * matters, because there the prompt does not ask for the legacy token
 * (`useLegacyVerdict` is false), so the fallback cannot fire by construction.
 */
export function exploreProducedNoSignal(
  intentPathActive: boolean,
  legacyVerdict: string | null | undefined,
): boolean {
  return intentPathActive && !legacyVerdict;
}

/** #799 — the step handler moved to work-driver-explore-run.ts (verbatim,
 * for 500-line headroom); re-exported so existing imports keep their path. */
export { runExplore } from "./work-driver-explore-run.ts";
