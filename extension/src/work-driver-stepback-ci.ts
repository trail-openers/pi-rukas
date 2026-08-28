/**
 * work-driver-stepback-ci — Step 7h (step-back) + Step 8 (CI monitoring)
 * handlers.
 *
 * Extracted from work-driver.ts (issue #171 file-size hygiene). Grouped
 * together as small tail-pipeline steps — step-back reroutes to handoff
 * with a spec-revision proposal; CI is the last gate before merge.
 *
 * Issue #279 adds the verify-full tier to runCi BEFORE the ops gh-run-watch
 * dispatch.
 */

import { exec as nodeExec } from "node:child_process";
import { promisify } from "node:util";
import { readMarker } from "./reply-markers.ts";
import { trace } from "./trace.ts";
import { type DriverContext, MAX_CI_RETRIES } from "./work-driver-context.ts";
import {
  contradictsSuccess,
  gatherMergeEvidence,
  mergeAuthorityEnabled,
} from "./work-driver-merge-authority.ts";
import { runSingleDispatch } from "./work-driver-merged.ts";
import { inlineCiPrompt, inlineStepBackPrompt } from "./work-driver-prompts-late.ts";
import { runVerifyFull, verifyCmdFullFor } from "./work-driver-verify-full.ts";
import { scratchDir } from "./work-driver-workspace.ts";
import { type WorkState, appendEvent } from "./workflow-state.ts";

const execp = promisify(nodeExec);

/**
 * Step-back when findings cluster around a theme. Dispatches @explore with
 * the SDD-six-element step-back prompt.
 *
 * v1: the driver does NOT cluster findings itself (that's fuzzy judgement).
 * It dispatches step-back unconditionally when the cap-hit nextStep routes
 * here, includes the prior lens-findings as input, and lets @explore
 * decide which SDD element is underspecified.
 */
/**
 * PR12 — Parse the @explore step-back reply for the structured fields
 * `sddElement:`, `diagnosis:`, `proposedRevision:`. Lenient: tolerates
 * markdown emphasis around the keys, leading whitespace, multi-line
 * values (everything from the colon to the next `^<key>:` line or the
 * end of the reply). All three fields fall back to empty strings when
 * absent — the renderer surfaces what's present and the cap-hit fires
 * regardless so the handoff still happens.
 */
export function parseStepBackReply(text: string): {
  sddElement: string;
  diagnosis: string;
  proposedRevision: string;
} {
  const extract = (key: string): string => {
    // Anchor key at start-of-line (input start OR after newline). Capture
    // is non-greedy + multi-line ([\s\S]*?) and terminates at the next
    // recognised key OR end-of-input. `$` without `m` flag matches end-
    // of-input only — `m` would terminate at the first newline and lose
    // multi-line values like proposedRevision.
    const re = new RegExp(
      String.raw`(?:^|\n)\s*[*_\x60]*${key}[*_\x60]*\s*:\s*([\s\S]*?)(?=\n\s*[*_\x60]*(?:sddElement|diagnosis|proposedRevision|alternativeApproach)[*_\x60]*\s*:|$)`,
      "i",
    );
    const m = text.match(re);
    return (m?.[1] ?? "").trim();
  };
  return {
    sddElement: extract("sddElement"),
    diagnosis: extract("diagnosis"),
    proposedRevision: extract("proposedRevision"),
  };
}

export async function runStepBack(
  ctx: DriverContext,
  state: WorkState,
  now: number,
): Promise<WorkState> {
  const allFindings = state.eventLog
    .filter(
      (e): e is Extract<(typeof state.eventLog)[number], { kind: "lens-issues-found" }> =>
        e.kind === "lens-issues-found",
    )
    .map((e) => e.findings)
    .join("\n---\n");
  let next = await runSingleDispatch(
    ctx,
    state,
    "step-back",
    "explore",
    "explore:step-back",
    now,
    () => inlineStepBackPrompt(ctx.issue, allFindings, scratchDir(ctx.repoRoot, ctx.issue)),
  );
  // PR12 — parse the structured reply + emit step-back-completed and
  // cap-hit so the handoff renderer can branch on cap='step-back-revise-spec'.
  // Pre-PR12 the routing fell through the generic linear table
  // (step-back → handoff) and the handoff renderer had no cap to switch
  // on, surfacing the wrong recovery commands ("git push what's there"
  // etc.) for a spec-revision workflow.
  const last = next.eventLog[next.eventLog.length - 1];
  if (last?.kind === "dispatch-completed") {
    const parsed = parseStepBackReply(last.summary ?? "");
    next = appendEvent(
      next,
      {
        kind: "step-back-completed",
        at: Date.now(),
        jobId: last.jobId,
        sddElement: parsed.sddElement || "(not specified)",
        diagnosis: parsed.diagnosis || "(not specified)",
        proposedRevision: parsed.proposedRevision || "(not specified)",
      },
      {
        kind: "cap-hit",
        at: Date.now(),
        cap: "step-back-revise-spec",
        reviewRound: next.pipelineState.reviewRound,
        nextStep: "handoff",
      },
    );
  }
  return next;
}

/**
 * Step 8 — CI monitoring. ops runs `gh run watch` and reports the outcome.
 * The driver parses the result text for "ci-status: success/failure" so
 * routing is deterministic.
 */
/**
 * PR15 — resolve the ci-step ops timeout. `gh run watch` blocks until
 * CI completes; real project CI runs regularly exceed the ops role's
 * 10-min default (spawn.ts:141). Ci-specific override lifts the cap
 * to 30 min by default, env-tunable via
 * `PI_ENSEMBLE_CI_WATCH_TIMEOUT_MS`. Empirical: 3× ops-CI-poll
 * timeouts this session before PR15 forced cycles to false-halt on
 * `step-failed:ci`.
 */
function ciWatchTimeoutMs(): number {
  const envRaw = process.env.PI_ENSEMBLE_CI_WATCH_TIMEOUT_MS;
  const env = Number(envRaw);
  if (Number.isFinite(env) && env > 0) return env;
  return 30 * 60_000; // 30 min default
}

/**
 * #279 — verify-full tier timeout. The full suite can take longer
 * than the fast verify command (e.g., running workspace-wide tests).
 * Default 30 min, env-tunable via `PI_ENSEMBLE_VERIFY_FULL_TIMEOUT_MS`.
 */
function verifyFullTimeoutMs(): number {
  const envRaw = process.env.PI_ENSEMBLE_VERIFY_FULL_TIMEOUT_MS;
  const env = Number(envRaw);
  if (Number.isFinite(env) && env > 0) return env;
  return 30 * 60_000; // 30 min default
}

/**
 * #279 — escape hatch for the verify-full tier. When set to "0" or "false",
 * skips the verify-full command entirely (restores pre-#279 behaviour).
 */
function verifyFullEnabled(): boolean {
  const v = process.env.PI_ENSEMBLE_VERIFY_FULL;
  return v !== "0" && v !== "false";
}

export async function runCi(ctx: DriverContext, state: WorkState, now: number): Promise<WorkState> {
  let next = state;

  // #279 — verify-full tier: read `.pi/verify-cmd-full` and execute it
  // BEFORE the ops gh-run-watch dispatch. Run in the group's primary
  // worktree, NOT repoRoot (addendum: parallel groups may have repoRoot
  // on a different branch by ci time).
  if (verifyFullEnabled()) {
    const ps = next.pipelineState;

    // Resolve the primary worktree (first key in worktrees map, or repoRoot fallback)
    const primaryWorktreeEntry = Object.entries(ps.worktrees ?? {})[0];
    const primaryWorktree = primaryWorktreeEntry?.[1] ?? ctx.repoRoot;
    const primaryWorktreeId = primaryWorktreeEntry?.[0] ?? "default";

    const cmd = await verifyCmdFullFor(ctx.repoRoot);
    if (cmd) {
      trace(
        `work-driver: ci step — running verify-full in worktree ${primaryWorktreeId}: ${cmd.slice(0, 100)}`,
      );
      const result = await runVerifyFull(
        cmd,
        primaryWorktree,
        verifyFullTimeoutMs(),
        ctx.verifyExecFn ?? execp,
      );
      next = appendEvent(next, {
        kind: "verify-full-status",
        at: Date.now(),
        status: result.outcome,
        ms: result.ms,
        evidenceTail: result.output.slice(-500), // Last 500 chars for handoff
      });

      if (result.outcome === "failure") {
        // Verify-full failed — bump ciRetryCount and skip ops dispatch for
        // this round. The ci-retry cap will fire on the next iteration if
        // we've exhausted retries.
        const nextCount = (next.pipelineState.ciRetryCount ?? 0) + 1;
        next = {
          ...next,
          pipelineState: { ...next.pipelineState, ciRetryCount: nextCount },
        };
        if (nextCount > MAX_CI_RETRIES) {
          next = appendEvent(
            next,
            {
              kind: "cap-hit",
              at: Date.now(),
              cap: "ci-retry",
              reviewRound: next.pipelineState.reviewRound,
              nextStep: "handoff",
            },
            {
              kind: "ci-status",
              at: Date.now(),
              status: "failure",
            },
          );
        }
        return next; // Skip ops dispatch on verify-full failure
      }
    } else {
      trace("work-driver: ci step — .pi/verify-cmd-full absent, skipping verify-full tier");
      next = appendEvent(next, {
        kind: "verify-full-status",
        at: Date.now(),
        status: "skipped",
      });
    }
  }

  next = await runSingleDispatch(
    ctx,
    next,
    "ci",
    "ops",
    "ops:ci",
    now,
    () =>
      inlineCiPrompt(ctx.issue, next.pipelineState.branchName, scratchDir(ctx.repoRoot, ctx.issue)),
    { timeoutMs: ciWatchTimeoutMs() },
  );
  // Parse the just-appended dispatch-completed event for a structured status
  // line. The ops prompt asks the agent to end with `ci-status: success` or
  // `ci-status: failure`. If parsing fails (no marker line), we treat as
  // "failure" rather than "pending" — that way the ci-retry cap engages
  // when the ops agent didn't follow the protocol (the empirical failure
  // mode on issue #553 was the ops agent reporting "no PR exists" without
  // emitting the marker, leaving status="pending" → driver stayed at ci
  // → safety-break would eventually fire).
  const last = next.eventLog[next.eventLog.length - 1];
  if (last?.kind === "dispatch-completed") {
    const text = last.summary ?? "";
    // #408 — this was a bare `text.includes("ci-status: success")`: case
    // sensitive, and blind to the `**ci-status:** success` an ops agent
    // routinely writes. Any such drift read as a CI failure, which burnt a
    // retry on a green run and could park a finished cycle. `readMarker`
    // accepts the shapes agents actually emit, and — unlike `includes` —
    // reports ABSENCE distinctly, so the two cases can be told apart in the
    // event payload instead of being collapsed into one.
    const marker = readMarker(text, "ci-status", /(success|failure|pending)/);
    let status: "success" | "failure" | "pending" =
      marker === "success"
        ? "success"
        : marker === "pending"
          ? "pending"
          : // Explicit failure, or no marker at all — treat as failure so the
            // retry cap fires rather than the driver idling at `ci` forever
            // (#553's shape: ops reported "no PR exists" with no marker).
            "failure";
    // #380 — a narrated success is a claim, not evidence. The driver used to
    // route to `merged` on `text.includes("ci-status: success")` without ever
    // calling `gh`. Check it: narration cannot PROMOTE a status, but executed
    // evidence can DEMOTE one. (Unreadable `gh` leaves the claim standing —
    // the merge gate fails closed, so being lenient here costs nothing.)
    if (status === "success" && mergeAuthorityEnabled() && next.pipelineState.prNumber) {
      const contradiction = contradictsSuccess(
        await gatherMergeEvidence(
          ctx.verifyExecFn ?? execp,
          ctx.repoRoot,
          next.pipelineState.prNumber,
        ),
      );
      if (contradiction) {
        trace(`work-driver: ci — ops claimed success, gh disagrees (${contradiction})`);
        status = "failure";
      }
    }
    // Bump ciRetryCount BEFORE appending the event so nextStep's
    // `ciRetryCount >= MAX_CI_RETRIES` check reflects this attempt.
    // Note: verify-full failures already bumped ciRetryCount above; don't
    // bump again to avoid double-counting a single ci-round failure.
    const hasVerifyFullFailure = next.eventLog.some(
      (e) => e.kind === "verify-full-status" && e.status === "failure",
    );
    const nextCount =
      (next.pipelineState.ciRetryCount ?? 0) +
      (status === "failure" && !hasVerifyFullFailure ? 1 : 0);
    next = {
      ...next,
      pipelineState: { ...next.pipelineState, ciRetryCount: nextCount },
    };
    if (status === "failure" && nextCount > MAX_CI_RETRIES) {
      // Cap hit — emit cap-hit AND ci-status (the cap-hit is the routing
      // signal; ci-status is the audit trail). Driver loop reads the
      // cap-hit branch in nextStep and routes to handoff.
      next = appendEvent(
        next,
        { kind: "ci-status", at: Date.now(), status },
        {
          kind: "cap-hit",
          at: Date.now(),
          cap: "ci-retry",
          reviewRound: next.pipelineState.reviewRound,
          nextStep: "handoff",
        },
      );
    } else {
      next = appendEvent(next, { kind: "ci-status", at: Date.now(), status });
    }
  }
  return next;
}
