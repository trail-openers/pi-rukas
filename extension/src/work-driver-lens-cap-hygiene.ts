/**
 * work-driver-lens-cap-hygiene — the public-text check the round-cap residual
 * post runs before it writes its body file (the #1788 follow-up).
 *
 * `work-driver-lens-cap.ts` decides where a capped review goes; that decision
 * is licensed by a comment the PR actually carries, and posting it is a publish
 * the `tool_call` guard cannot see — an in-process `gh pr comment`, composed
 * from findings quoted off the branch and naming host paths. It therefore goes
 * through the ONE driver seam every driver-authored publish uses
 * (`driverPublishCheck`), which applies the same public-only rule as everywhere
 * else and, on the public-or-unknown branch, rewrites this host's paths to
 * `~`/`<repo>`.
 *
 * Split out under AGENTS.md §12: the cap module owns routing and disclosure
 * bookkeeping at its size cap, and this is a self-contained contract with its
 * own failure shape.
 */

import { driverPublishCheck } from "./public-hygiene-driver.ts";
import type { CycleContext } from "./work-driver-context.ts";
import { forgeForCycle } from "./work-driver-forge-ctx.ts";
import type { ExecFn } from "./worktree.ts";

/** What the disclosure post may do: post this text, or refuse. */
export type DisclosureCheck = { text: string } | { refusal: string };

/**
 * Check (and normalise) the residual-findings disclosure before it is written.
 *
 * The target is the forge's own owner/repo/host — the same shape `createForge`'s
 * `checkPublicText` passes — so the visibility question is asked of the
 * repository the comment actually lands on rather than guessed from the command
 * string. `forgeForCycle` answering `undefined` is not a pass: with no slug the
 * seam falls back to resolving the clone's origin, and a target it cannot name
 * is the driver seam's standing "check it" answer.
 *
 * The caller turns a refusal into its existing `{ ok: false }`, so a disclosure
 * that could not be checked is a disclosure that did not happen and the cycle
 * parks rather than routes on. The disclosure marker survives the rewrite: a
 * `<!-- pi-rukas: … -->` span is never touched.
 */
export async function residualDisclosureBody(
  ctx: Pick<CycleContext, "repoRoot" | "verifyExecFn">,
  body: string,
  execFn: ExecFn,
): Promise<DisclosureCheck> {
  const forge = await forgeForCycle(ctx, execFn);
  const checked = await driverPublishCheck("pull request comment", body, {
    command: "gh pr comment",
    cwd: ctx.repoRoot,
    repoRoot: ctx.repoRoot,
    exec: execFn,
    target:
      forge && forge.owner !== "" && forge.repo !== ""
        ? { owner: forge.owner, repo: forge.repo, host: forge.host }
        : undefined,
  });
  return checked.refusal === undefined ? { text: checked.text } : { refusal: checked.refusal };
}
