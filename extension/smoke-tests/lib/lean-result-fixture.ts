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
 *     `draft: false`, `verify` went green, and the green's `verifiedHead` IS the
 *     head publish says it pushed — the `at <sha>` its reason line carries, which
 *     is the only head publish records (`state-outcome.ts` refuses `verifiedHead`
 *     on any step but `verify`). That equality is the land gate's rule, and why
 *     `head` and `publishedHead` are two knobs rather than one: a log naming a
 *     head in only one place is the drift case, and must not read as ready.
 *   - `handback`'s `posted` is the typed claim that its comment reached the forge.
 *     The step ends `done` whether or not the post landed, so the projection
 *     reads THAT field and not the reason prose — and a fixture that omitted it
 *     would report every delivered report as undelivered.
 */

import type { DispatchUsageRow } from "../../src/lean/step-budget.ts";
import type { LeanRun, Outcome, Step } from "../../src/lean/state.ts";
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

export interface LeanLogOpts {
  prUrl?: string;
  draft?: boolean;
  dispatches?: DispatchUsageRow[];
  verify?: "green" | "red";
  /** The head `verify` judged and `publish` shipped. Green only. */
  head?: string;
  /** Override the head `publish`'s reason names, to build a drift case. */
  publishedHead?: string;
  /** Whether the handback comment reached the forge (default: it did). */
  posted?: boolean;
}

/** The whole log one ending is made of — see the module header for its rules. */
export function leanLog(opts: LeanLogOpts): Step[] {
  // The 12-char prefix `publish` prints, and the full sha `verify` records.
  const head = opts.head ?? HEAD;
  const headPrefix = head.slice(0, 12);
  const steps: Step[] = [
    stepWith("ready", { kind: "ok" }),
    stepWith("specify", { kind: "ok", dispatches: opts.dispatches }),
    stepWith("build", { kind: "ok" }),
    stepWith("verify", {
      kind: opts.verify ?? "green",
      ...(opts.verify === "red"
        ? { reason: "acceptance test x is red" }
        : { verifiedHead: head }),
    }),
  ];
  if (opts.prUrl !== undefined) {
    steps.push(
      stepWith("publish", {
        kind: "ok",
        prUrl: opts.prUrl,
        ...(opts.draft === undefined ? {} : { draft: opts.draft }),
        reason: `published ${opts.draft === true ? "draft " : ""}PR ${opts.prUrl} at ${opts.publishedHead ?? headPrefix}`,
      }),
    );
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
): Promise<LeanDrive> {
  const r = await verbRun(["7"], async () => ({
    summary: `work-lean #7: ${leanState} (exit ${code})`,
    result: fakeRun({ code, state: leanState, steps }),
  }));
  const issues = r.doc.issues as Record<string, unknown>[] | undefined;
  return {
    code: r.code,
    doc: r.doc,
    issue: Array.isArray(issues) ? issues[0] : undefined,
    violations: r.violations,
  };
}
