/**
 * lib/lean-result-fixture — the step logs the #1920 slice-B result cases drive.
 *
 * Split out of `test-headless-work-lean-result.ts` for the §12 size cap: that
 * file and `test-headless-work-lean-delivery.ts` drive the SAME projection
 * (`headless/work-lean-result.ts` through the `work-lean` verb) and each needs a
 * log a real run could have written, so the shape lives once. Two copies of a
 * fixture are two chances for one to stop describing a real record — which is
 * precisely how a projection starts reporting a field no run observed.
 *
 * What one legal log has to carry, and why the fixture builds all of it:
 *
 *   - a `ready` PR needs THREE records that agree, not one. `publish` says
 *     `draft: false` AND records the full `publishedHead` it pushed, `verify`
 *     goes green, and the green's `verifiedHead` IS that head — the land gate's
 *     rule, typed end to end since #1920 B (the reason line's `at <sha>` is
 *     prose and the projection reads no prose). That equality is why `head` and
 *     `publishedHead` are two knobs rather than one: a log naming a head in only
 *     one place is the drift case, and must not read as ready.
 *   - `handback`'s `posted` is the typed claim that its comment reached the forge.
 *     The step ends `done` whether or not the post landed, so the projection
 *     reads THAT field and not the reason prose — and a fixture that omitted it
 *     would report every delivered report as undelivered.
 */

import type { LeanRun, LeanState, Outcome, Step } from "../../src/lean/state.ts";
import type { DispatchUsageRow } from "../../src/lean/step-budget.ts";
import { fakeRun, verbRun } from "./work-lean-verb-fixture.ts";

/** The PR's address every case uses. */
export const URL = "https://example.test/pull/7";

/** The commit `verify` judged and `publish` shipped, when a case does not drift it. */
export const HEAD = "a".repeat(39) + "1";

/** One child the step paid for, with the cost a host adds up. */
export function row(role: string, usage: Partial<DispatchUsageRow["usage"]>): DispatchUsageRow {
  return {
    role,
    ms: 10,
    ok: true,
    usage: {
      input: 0,
      output: 0,
      cacheRead: 0,
      cacheWrite: 0,
      cost: 0,
      turns: 0,
      ...usage,
    },
  };
}

/** The children one run's `specify` step paid for, in total and per role. */
export const CHILDREN = [
  row("explore", { input: 100, output: 10, cacheRead: 5, cost: 0.5, turns: 2 }),
  row("developer", { input: 200, output: 20, cacheWrite: 3, cost: 0.25, turns: 4 }),
  row("developer", { input: 50, output: 5, cost: 0.1, turns: 1 }),
];

/** One step of the log, with distinct timestamps per attempt. */
export function stepWith(state: Step["state"], outcome: Outcome, n = 0): Step {
  return {
    key: `7:${state}:${String(n)}`,
    state,
    startedAt: 1_000 + n,
    endedAt: 2_000 + n,
    outcome,
  };
}

/**
 * The same step with its `reason` rewritten — for the case where a step's PROSE
 * says something its typed fields do not, which the projection must not read.
 */
export function withReason(step: Step, reason: string): Step {
  if (step.outcome === undefined) return step;
  return { ...step, outcome: { ...step.outcome, reason } };
}

export interface LeanLogOpts {
  prUrl?: string;
  draft?: boolean;
  dispatches?: DispatchUsageRow[];
  verify?: "green" | "red";
  /** The head `verify` judged and `publish` shipped. Green only. */
  head?: string;
  /** What `publish` records as the head it pushed: a full sha, `""` for none at
   *  all, or a different sha to build the drift case. */
  publishedHead?: string;
  /** Whether `publish` records a head at all (default: it does). */
  withPublishedHead?: boolean;
  /** Whether the handback comment reached the forge (default: it did). */
  posted?: boolean;
  /** Whether a `ci` step follows the publish (default: none). The engine's land
   *  gate reads the newest decided `ci` beside the newest decided `verify`, and
   *  so does `prState` — but only to REJECT: a run with no `ci` step is unjudged
   *  by the pipeline, not refused, because lean has no `ci` step built. */
  ci?: "green" | "red";
  /** How many `verify` steps the log carries (default 1): the newest one is the
   *  gate's current verdict, so 2 with `verifyCrashed` is a gate that died after
   *  going green. */
  verifySteps?: number;
  /** Whether the NEWEST `verify`/`ci` step carries no outcome — a crash mid-step. */
  crashed?: "verify" | "ci";
  /** The run's `counters.draft` (default false) — the engine's own red marker. */
  draftCounter?: boolean;
}

/** The whole log one ending is made of — see the module header for its rules. */
export function leanLog(opts: LeanLogOpts): Step[] {
  // The 12-char prefix `publish` prints in its reason line, and the full sha
  // `verify` records.
  const head = opts.head ?? HEAD;
  const steps: Step[] = [
    stepWith("ready", { kind: "ok" }),
    stepWith("specify", { kind: "ok", dispatches: opts.dispatches }),
    stepWith("build", { kind: "ok" }),
    stepWith("verify", {
      kind: opts.verify ?? "green",
      ...(opts.verify === "red" ? { reason: "acceptance test x is red" } : { verifiedHead: head }),
    }),
  ];
  for (let n = 1; n < (opts.verifySteps ?? 1); n++) {
    // A re-run's verdict, older than the newest one below: reading THIS green
    // over a newer step is what the projection must not do.
    steps.push(stepWith("verify", { kind: "green", verifiedHead: head }, n));
  }
  if (opts.crashed === "verify") {
    // A crash mid-gate: no outcome, so the gate has said nothing since the green.
    steps.push({
      key: `7:verify:${String(opts.verifySteps ?? 1)}`,
      state: "verify",
      startedAt: 3_000,
      endedAt: 3_001,
    });
  }
  if (opts.prUrl !== undefined) {
    // The head publish records as typed data, never as a prefix in prose:
    // `publishedHead` absent is the unobserved case, and a value unequal to the
    // green's `verifiedHead` is the drift case.
    const published = opts.withPublishedHead === false ? undefined : (opts.publishedHead ?? head);
    steps.push(
      stepWith("publish", {
        kind: "ok",
        prUrl: opts.prUrl,
        ...(opts.draft === undefined ? {} : { draft: opts.draft }),
        ...(published === undefined ? {} : { publishedHead: published }),
        reason: `published ${opts.draft === true ? "draft " : ""}PR ${opts.prUrl} at ${head.slice(0, 12)}`,
      }),
    );
  }
  if (opts.ci !== undefined) {
    // The pipeline's verdict on the head the PR stands on: a decided `ci` that
    // is not green is as much a refusal as a red gate. Its ABSENCE is neither —
    // lean has no `ci` step built, so a run with none is unjudged, not refused.
    steps.push(stepWith("ci", { kind: opts.ci }));
    if (opts.crashed === "ci") {
      steps.push({
        key: "7:ci:1",
        state: "ci",
        startedAt: 3_002,
        endedAt: 3_003,
      });
    }
  }
  steps.push(
    stepWith("handback", {
      kind: "done",
      // Default `true`: the ordinary case is a comment that posted, and the
      // projection reads this field rather than the reason prose.
      posted: opts.posted !== false,
      reason:
        opts.posted === false
          ? "handback comment NOT posted: forge unreachable"
          : "handback comment posted",
    }),
  );
  return steps;
}

/** What driving one ending through the verb hands back. */
export interface LeanDrive {
  code: number;
  doc: Record<string, unknown>;
  /** The one projected issue, or undefined on a document that projects none. */
  issue: Record<string, unknown> | undefined;
  /** The shared output contract's verdict — every case asserts this is empty. */
  violations: string[];
}

/** Drive one ending through the verb and hand back its projected issue. */
export async function driveLean(
  leanState: LeanRun["state"],
  code: number,
  steps: Step[],
  counters?: Partial<LeanRun["counters"]>,
): Promise<LeanDrive> {
  // The counters override drives its own verb run rather than patching this one:
  // the record the projection reads is the one the verb was handed.
  const base = fakeRun({ code, state: leanState, steps });
  const run: LeanRun =
    counters === undefined ? base.run : { ...base.run, counters: { ...base.run.counters, ...counters } };
  const r = await verbRun(["7"], async () => ({
    summary: `work-lean #7: ${leanState} (exit ${code})`,
    result: { ...base, run },
  }));
  const issues = r.doc.issues as Record<string, unknown>[] | undefined;
  return {
    code: r.code,
    doc: r.doc,
    issue: Array.isArray(issues) ? issues[0] : undefined,
    violations: r.violations,
  };
}
