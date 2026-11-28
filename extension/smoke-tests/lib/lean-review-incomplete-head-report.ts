/**
 * The reporting step of a #2667 row, driven over a REAL origin that a third party moved.
 *
 * Sibling of `lean-review-incomplete-head-panel.ts`, which drives the rows: this file holds the
 * reporting step's two rewind arms, so the driver stays about driving. A rewind refuses in two
 * different windows and a row has to say which one it drove:
 *
 *   `read` — origin moves before the reporting step is called. Its rewind reads a head the run
 *     never pushed, and the refusal wording the record has to carry is its own.
 *   `push` — origin moves from inside the rewind's own push, after that step read origin. That is
 *     the window `--force-with-lease=<branch>:<held>` guards, and the refusal it produces says
 *     `the lease refused the rewind`. That arm is pinned against a real origin by
 *     `test-lean-rewind-lease-binds.ts`; this rig supplies the reporting step around it.
 *
 * `pendingStranger` makes the commit once and leaves the instant to the caller. The stranger
 * travels to origin over a transport: a stranger that only ever appears in origin's ref store makes
 * origin name bytes it never received, and the push then dies at `bad object` with none of the
 * rewind's own rules consulted — which would pin the transport and not the refusal.
 */

import type { LeanHandlers } from "../../src/lean/engine.ts";
import { rewindToVerified } from "../../src/lean/handback-rewind.ts";
import { handbackOutcome } from "../../src/lean/handback.ts";
import { git } from "./lean-review-fixtures.ts";
import { BRANCH, ISSUE, exec } from "./lean-review-incomplete-head-consts.ts";
import { pendingStranger } from "./lean-review-incomplete-head-gate.ts";

/** Origin's own value for its branch, or `undefined` when it holds nothing there. */
function originHead(origin: string): string | undefined {
	const out =
		git(origin, "ls-remote", ".", `refs/heads/${BRANCH}`).split(/\s+/)[0] ?? "";
	return /^[0-9a-f]{40}$/.test(out) ? out : undefined;
}

/**
 * The `handback` handler of a stranger arm: the real reporting step, the real rewind, the real
 * origin read, and the head the step found on origin read back afterwards rather than handed in.
 *
 * `plant` reports where the step's read left origin, so the row can assert the head the record
 * names is the head origin really holds.
 */
export function strangerHandback(opts: {
  arm: "read" | "push";
  repoRoot: string;
  origin: string;
  verifiedHead: string;
  posts: string[];
  visited: string[];
  seen: Record<string, number>;
}): LeanHandlers["handback"] {
  const { arm, repoRoot, origin, verifiedHead, posts, visited, seen } = opts;
  return (ctx) => {
    visited.push("handback");
    seen.handback = (seen.handback ?? 0) + 1;
    const stranger = pendingStranger(origin, verifiedHead, repoRoot);
    let planted: string | undefined;
    let originAtReport: string | undefined;
    // The rewind's clone has to hold the head its keeping-ref spec names, or the push dies at
    // `bad object` before any of the rewind's own rules is consulted. The bare sha form, which
    // refreshes no ref: the branch is checked out in the run's worktree, and git refuses a fetch
    // that would write a checked-out branch.
    const move = (): string => {
      if (planted === undefined) {
        planted = stranger.push();
        git(repoRoot, "fetch", "-q", "origin", planted);
        if (originHead(origin) === verifiedHead)
          throw new Error(`origin's ${BRANCH} did not move, so the row proved nothing`);
      }
      return planted;
    };
    if (arm === "read") {
      // Origin moves, and the clone the rewind pushes from is NOT told: that is what makes the
      // rewind's refusal a refusal of its own rules rather than a transport accident.
      if (planted === undefined) planted = stranger.moveUnseen();
    }
    let raced = false;
    const rigExec: typeof exec = async (cmd, execOpts) => {
      if (arm === "push" && (execOpts?.argv ?? []).includes("push")) {
        if (raced) throw new Error("the rewind pushed twice, so a second refusal proves nothing");
        raced = true;
        move();
      }
      return await exec(cmd, execOpts);
    };
    return handbackOutcome(
      ctx,
      async (_r, _i, body) => void posts.push(body),
      (verified) =>
        rewindToVerified(
          arm === "push" ? rigExec : exec,
          { repoRoot, issue: ISSUE, run: ctx.run },
          verified,
          { net: true },
        ),
      // Where the reporting step found origin once the rewind is done: read back off origin, never
      // handed to the record as a literal.
      () => {
        originAtReport = originHead(origin);
        return originAtReport;
      },
    );
  };
}
