/**
 * The gate verdicts, the completed-review shapes and the stranger of the #2667 review panel.
 *
 * Sibling of `lean-review-incomplete-head-panel.ts`, which drives the rows: this file holds the
 * shapes a row is built from, so the driver stays about driving. The verdicts and pass records
 * here are CONTROL material — what the machine's own step records look like when the step is
 * not the one under test. The step under test (the review) is driven for real by the panel.
 */

import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import type { Outcome, Step } from "../../src/lean/state.ts";
import { git } from "./lean-review-fixtures.ts";
import { put } from "./lean-build-fixture.ts";
import { landedRoster } from "./lean-roster-fixture.ts";
import { BRANCH, ISSUE } from "./lean-review-incomplete-head-consts.ts";

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
 * A commit nobody certified, on top of the branch's head, and the one call that puts it on origin.
 *
 * Made in a scratch detached worktree, not by checking the branch out in the clone: the run's own
 * worktree owns the branch, and pushing a new commit by sha needs no checkout. The caller decides
 * WHEN origin moves, because the two refusals a rewind gives live in two different windows:
 *
 *   - `push()` BEFORE the step reads origin — the step reads a head it never pushed and refuses to
 *     overwrite a head it does not own;
 *   - `push()` from inside the rewind's push, AFTER that step read origin — the lease binds to the
 *     value the step read, so the lease is what refuses, and the refusal says so. A stranger that
 *     only ever appears in origin's ref store, never over a transport, makes origin name bytes it
 *     never received: the push then dies at `bad object` with the lease never evaluated, which is
 *     the transport's refusal and not this arm.
 *
 * `fetchInto` puts the object in the clone the rewind pushes from, which is what lets the
 * keeping-ref spec name a provable object instead of failing at `bad object`.
 */
export function pendingStranger(
  origin: string,
  head: string,
  fetchInto?: string,
): { sha: string; push: () => string; fetched: () => string } {
  const stranger = mkdtempSync(path.join(tmpdir(), "lean-stranger-"));
  git(stranger, "clone", "-q", "--no-checkout", origin, "repo");
  const repo = path.join(stranger, "repo");
  const w = path.join(stranger, "w");
  git(repo, "worktree", "add", "-q", "--detach", w, head);
  put(w, "stranger.ts", "export const s = 3;\n");
  git(w, "add", "-A");
  git(w, "commit", "-q", "-m", "a head nobody verified");
  const sha = git(w, "rev-parse", "HEAD");
  let pushed = false;
  let fetched = false;
  return {
    sha,
    /** Move origin's branch to the stranger, and teach the rewind's clone the object. */
    push: () => {
      if (!pushed) {
        git(repo, "push", "-q", "origin", `+${sha}:refs/heads/${BRANCH}`);
        pushed = true;
      }
      return sha;
    },
    /**
     * Move origin's branch to the stranger WITHOUT the rewind's clone learning it was told.
     *
     * Two steps, both needed. The objects travel on a ref the rewind never names, from the clone
     * that holds them, so origin really received the bytes — a branch file written by hand makes
     * origin name bytes it never got, and the rewind's push then dies at `bad object` with none of
     * its rules consulted. The branch is then repointed at that sha, so the rewind reads a head it
     * has no licence to move and must refuse rather than overwrite somebody else's work.
     */
    moveUnseen: () => {
      if (!pushed) {
        git(repo, "push", "-q", "origin", `+${sha}:refs/lean/stranger/${String(ISSUE)}`);
        const ref = `refs/heads/${BRANCH}`;
        const file = path.join(origin, ...ref.split("/"));
        mkdirSync(path.dirname(file), { recursive: true });
        writeFileSync(file, `${sha}\n`, { encoding: "utf8" });
        if (git(origin, "rev-parse", ref) !== sha)
          throw new Error(`origin's ${ref} was not moved to ${sha}, so the row moved nothing`);
        pushed = true;
      }
      return sha;
    },
    fetched: () => {
      if (fetchInto !== undefined && !fetched) {
        git(fetchInto, "fetch", "-q", "origin", sha);
        fetched = true;
      }
      return sha;
    },
  };
}

/** The one-shot form: make the stranger and move origin to it at once. */
export function plantStranger(origin: string, head: string, clone?: string): string {
  const stranger = pendingStranger(origin, head, clone);
  stranger.fetched();
  return stranger.push();
}
