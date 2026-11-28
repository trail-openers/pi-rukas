/**
 * The review step's dependencies for one throw site of the #2667 panel.
 *
 * Sibling of `lean-review-incomplete-head-panel.ts`, which drives the rows. Each cause names the
 * seam the throw comes from; every seam the site does NOT use keeps the clean-pass shape from
 * `lean-review-fixtures.ts`, so a row fails at the site it names or not at all. Only the review
 * step's own inputs are scripted here — the step itself is the production `reviewOutcome`.
 */

import { execp } from "../../src/exec.ts";
import type { ReviewDeps } from "../../src/lean/review.ts";
import type { Severity } from "../../src/lens-review-format.ts";
import {
  blockingFinding,
  carriedFinding,
  depsWith,
  fixerThatCommits,
  lensRoundWith,
  parsedRound,
  result,
  stepGitEnv,
} from "./lean-review-fixtures.ts";
import { SPEC_BODY } from "./lean-spec-body.ts";
import { BRANCH, cfgWith, MIN } from "./lean-review-incomplete-head-consts.ts";

/** One throw site of the review step, named by the seam it reads. */
export type ReviewCause =
  | "stepBound"
  | "budgetStop"
  | "refusedReReview"
  | "lensDidNotRun"
  | "headIdentity"
  | "entryAssertion"
  | "configLoad"
  | "issueRead"
  | "thresholdLoad";

/** Every row of the panel, in the order the issue's table lists them. */
export const CAUSES: readonly ReviewCause[] = [
  "stepBound",
  "budgetStop",
  "refusedReReview",
  "lensDidNotRun",
  "headIdentity",
  "entryAssertion",
  "configLoad",
  "issueRead",
  "thresholdLoad",
];




/**
 * An executor that answers the head guard's `rev-parse origin/<branch>` with a stranger.
 *
 * Only that one command is intercepted, so the guard is what refuses: the head resolve, the
 * diff range and the frozen-blob reads all reach the real git.
 */
export function headReader(stranger?: string): ReviewDeps["exec"] {
  return async (cmd, o) => {
    const argv = o?.argv ?? [];
    if (argv.includes("rev-parse") && (argv.at(-1) ?? "").startsWith(`origin/${BRANCH}`))
      return {
        stdout: `${stranger ?? "e".repeat(39) + "1"}\n`,
        stderr: "",
      } as Awaited<ReturnType<typeof execp>>;
    return execp(cmd, { ...(o ?? {}), env: stepGitEnv() });
  };
}

/**
 * An executor whose mainline probe says origin's mainline IS the run's branch — the one
 * answer `assertPublishableBranch` must refuse, before the step resolves a head or buys a
 * child. Everything else is answered normally.
 */
export function entryRefuser(): ReviewDeps["exec"] {
  return async (cmd, o) => {
    // The mainline probe is one `git symbolic-ref --short refs/remotes/origin/HEAD` (see
    // `detectMainline`); answered with the run's own branch, the entry gate refuses before it
    // resolves a head or pays for a child. Every other command is answered normally.
    if (cmd.includes("symbolic-ref"))
      return { stdout: `origin/${BRANCH}\n`, stderr: "" } as Awaited<
        ReturnType<typeof execp>
      >;
    return execp(cmd, { ...(o ?? {}), env: stepGitEnv() });
  };
}

/** The blocking round that buys the fix wave, in the layer's own shape. */
const blocking = () => lensRoundWith("CRITICAL_ISSUES_FOUND", [blockingFinding()]);

/**
 * The review deps of one throw site: the seams the site does NOT use stay the clean-pass
 * shapes, so the row fails at the site it names and nowhere earlier.
 */
export function depsFor(
  cause: ReviewCause,
  repoRoot: string,
  origin: string,
  verifiedHead: string,
  clock: () => number,
): ReviewDeps {
  const clean: ReviewDeps = depsWith({
    loadConfig: async () => cfgWith({}),
    fetchIssueBody: async () => SPEC_BODY,
    reviewThreshold: async () => "HIGH" as Severity,
  });
  switch (cause) {
    case "stepBound":
      // The step's OWN clock, read past `budgets.review.minutes` at R1, before either gate
      // child is bought. The clock measures from the write-ahead entry's `startedAt` (the
      // engine stamped it at the run's frozen `now`), and this row's clock sits two minutes
      // past the one-minute ceiling. Its gate stubs would clear, so nothing else can fire —
      // and because the step throws before `buyFullReview`, no child is paid for at all.
      return {
        ...clean,
        now: clock,
        exec: headReader(),
        loadConfig: async () => cfgWith({ minutes: 1 }),
        adversarial: async () => result({ loopOutcome: "approved", ms: 0 }),
      };
    case "budgetStop":
      // A gate child the operator's minutes ceiling stopped: `budgetStopped`.
      return {
        ...clean,
        loadConfig: async () => cfgWith({ minutes: 15 }),
        adversarial: async () =>
          result({ loopOutcome: "approved", killCause: "child-bound", ms: 16 * MIN }),
      };
    case "refusedReReview":
      // Pass 1 blocks, the fixer pushes, and the re-review carries the rows: `refused`.
      return {
        ...clean,
        adversarial: async (a) =>
          result({
            loopOutcome: a.wave === "fix" ? "approved" : "rejected",
            text: a.wave === "fix" ? "" : "1. leak",
            adversarialRounds: parsedRound(a.wave === "fix" ? "APPROVED" : "CRITICAL_ISSUES_FOUND"),
          }),
        lens: async (a) =>
          a.wave === "fix"
            ? lensRoundWith("ISSUES_FOUND", [carriedFinding()])
            : blocking(),
        dispatch: fixerThatCommits("2667-carried"),
      };
    case "lensDidNotRun":
      // Pass 1's round names lanes it never judged: the pass-1 `LENS_DID_NOT_RUN` refusal.
      return { ...clean, lens: async () => lensRoundWith("REVIEW_INCOMPLETE", [], []) };
    case "headIdentity":
      // The head guard's own read of origin is answered with a stranger's commit: origin
      // moved since the gate certified the head the run is standing on. Every other git read
      // — the head resolve, the range, the frozen blobs — goes to the real executor.
      return { ...clean, exec: headReader(`e${"e".repeat(38)}1`) };
    case "entryAssertion":
      // The entry gate refuses the branch it was handed — the mainline probe resolves origin's
      // mainline to the run's OWN branch, which is the refusal `assertPublishableBranch`
      // exists for. Every other read is answered normally, so the step dies at its entry.
      return { ...clean, exec: entryRefuser() };
    case "configLoad":
      return {
        ...clean,
        loadConfig: async () => {
          throw new Error("the project config could not be read");
        },
      };
    case "issueRead":
      return {
        ...clean,
        fetchIssueBody: async () => {
          throw new Error("the forge refused the issue read");
        },
      };
    case "thresholdLoad":
      return {
        ...clean,
        reviewThreshold: async () => {
          throw new Error("the doctrine judge did not answer");
        },
      };
  }
}
