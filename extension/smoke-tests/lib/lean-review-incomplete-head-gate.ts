/**
 * The gate verdicts, the completed-review shapes and the stranger of the #2667 review panel.
 *
 * Sibling of `lean-review-incomplete-head-panel.ts`, which drives the rows: this file holds the
 * shapes a row is built from, so the driver stays about driving. The verdicts and pass records
 * here are CONTROL material — what the machine's own step records look like when the step is
 * not the one under test. The step under test (the review) is driven for real by the panel.
 */

import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import type { Outcome, Step } from "../../src/lean/state.ts";
import { git } from "./lean-review-fixtures.ts";
import { put } from "./lean-build-fixture.ts";
import { landedRoster } from "./lean-roster-fixture.ts";
import { BRANCH } from "./lean-review-incomplete-head-consts.ts";

/** The record the engine writes when a handler throws: `errorOutcome`'s own shape. */
export function erroredReview(): Outcome {
  return { kind: "error", message: "the row's gate named no head, so the review step cannot run" };
}


/** The step's own words for a head it is told it cannot answer on. */
export function gateRefusal(verdict: "red" | "headless" | "undecided"): string {
  return verdict === "headless"
    ? "no decided green verify of this run named a verified head"
    : "the newest decided verify is red, not green, so no head is verified";
}

/** The gate's verdict a row walks on: green naming the head, red, a green that named
 * none, or a `verify` that entered and never decided (the write-ahead the rule must refuse
 * to ship over). */
export function gateVerdict(
  kind: "green" | "red" | "headless" | "undecided",
  head: string,
  base: string,
): Outcome {
  // `undecided` is the write-ahead the rule must refuse to ship over: the gate was entered
  // and never answered, so its `red` shape here is the ROUTE back to the review and nothing
  // more — the row asserts the rule's own words, not a verdict a fake handed it.
  if (kind === "red" || kind === "undecided")
    return { kind: "red", reason: "AC1 exited 1 at the head" };
  return {
    kind: "green",
    ...(kind === "headless" ? {} : { verifiedHead: head }),
    reason: `all frozen tests green at ${kind === "headless" ? "an unnamed commit" : head}`,
    projectRoster: landedRoster(base),
  };
}

/**
 * A review step that COMPLETED, built from what the same walk's own record says.
 *
 * The control arms do not run the step: they script its two pass kinds, which is the
 * control the issue asks for — the same log, the same reporting step, the pre-feature
 * bytes. `fixed` records the wave head the walk's own publish carried, so no fixture
 * invents a head the run never pushed.
 */
export function completedReview(kind: "done" | "fixed", steps: Step[]): Outcome {
  const head = steps.find((s) => s.state === "publish")?.outcome?.publishedHead;
  return kind === "done"
    ? {
        kind: "done",
        reason: "adversarial and six-lens review clean",
        review: { rounds: [{ CRITICAL: 0, HIGH: 0, MEDIUM: 0, LOW: 0 }], waves: [] },
      }
    : {
        kind: "fixed",
        reason: "adversarial and six-lens review clean on the fix",
        review: {
          rounds: [
            { CRITICAL: 1, HIGH: 0, MEDIUM: 0, LOW: 0 },
            { CRITICAL: 0, HIGH: 0, MEDIUM: 0, LOW: 0 },
          ],
          waves: [{ wave: "fix", head: head ?? "b".repeat(40) }],
        },
      };
}

/**
 * A commit on top of the branch's head, pushed to origin so the rewind's lease must refuse.
 *
 * Made in a scratch detached worktree, not by checking the branch out in the clone: the run's
 * own worktree owns the branch, and pushing a new commit by sha needs no checkout. The stranger
 * is then fetched into the clone's own tracking ref, so the rewind reaches its lease check with
 * an object it can prove rather than failing the earlier "this clone cannot see that head" guard.
 */
export function plantStranger(origin: string, head: string): string {
  // A clone of the run's own origin, and the stranger committed on the certified head. The
  // run's clone is never written to: a stranger it could see is a stranger a lease accepts, and
  // this row is about the refusal. The branch is not checked out in origin itself, so origin's
  // `receive.denyCurrentBranch` does not answer for the push — the lease does.
  const stranger = mkdtempSync(path.join(tmpdir(), "lean-stranger-"));
  git(stranger, "clone", "-q", "--no-checkout", origin, "repo");
  const repo = path.join(stranger, "repo");
  const w = path.join(stranger, "w");
  git(repo, "worktree", "add", "-q", "--detach", w, head);
  put(w, "stranger.ts", "export const s = 3;\n");
  git(w, "add", "-A");
  git(w, "commit", "-q", "-m", "a head nobody verified");
  const sha = git(w, "rev-parse", "HEAD");
  git(repo, "push", "-q", "origin", `+${sha}:refs/heads/${BRANCH}`);
  return sha;
}
