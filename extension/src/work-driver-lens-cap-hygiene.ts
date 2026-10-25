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

import { execp } from "./exec.ts";
import type { Forge } from "./forge.ts";
import { driverPublishCheck } from "./public-hygiene-driver.ts";
import type { VisibilityFn } from "./public-hygiene-visibility.ts";
import type { CycleContext } from "./work-driver-context.ts";
import { forgeForCycle } from "./work-driver-forge-ctx.ts";
import type { ExecFn } from "./worktree.ts";

/** What the disclosure post may do: post this text, or refuse. */
export type DisclosureCheck = { text: string; rewritten: boolean } | { refusal: string };

/**
 * Check (and normalise) a driver-authored comment before it is written.
 *
 * Two publishes use this: the round-cap residual post, and the handoff comment
 * body (`work-driver-handoff-body.ts`). Both are driver prose the `tool_call`
 * guard cannot see, and both therefore ask the ONE driver seam rather than
 * re-implementing the public/private decision at their own call site — that
 * duplication is how a private repository's handoff came to be folded (#1820).
 *
 * The target is the forge's own owner/repo/host — the same shape `createForge`'s
 * `checkPublicText` passes — so the visibility question is asked of the
 * repository the comment actually lands on rather than guessed from the command
 * string. `forge`/`forgeForCycle` answering `undefined` is not a pass: with no
 * slug the seam falls back to resolving the clone's origin, and a target it
 * cannot name is the driver seam's standing "check it" answer.
 *
 * The caller turns a refusal into its own failure shape, so a publish that could
 * not be checked is a publish that did not happen. The comment marker survives the
 * rewrite: a `<!-- pi-rukas: … -->` span is never touched.
 */
export async function residualDisclosureBody(
  ctx: Pick<CycleContext, "repoRoot" | "verifyExecFn">,
  body: string,
  execFn: ExecFn | undefined,
  /** The caller's already-resolved forge; else this function resolves one. */
  forge?: Forge,
  visibility?: VisibilityFn,
): Promise<DisclosureCheck> {
  const run = execFn ?? execp;
  const resolved = forge ?? (await forgeForCycle(ctx, run));
  const checked = await driverPublishCheck("pull request comment", body, {
    command: "gh pr comment",
    cwd: ctx.repoRoot,
    repoRoot: ctx.repoRoot,
    exec: run,
    visibility,
    target:
      resolved && resolved.owner !== "" && resolved.repo !== ""
        ? { owner: resolved.owner, repo: resolved.repo, host: resolved.host }
        : undefined,
  });
  return checked.refusal === undefined
    ? { text: checked.text, rewritten: checked.rewritten }
    : { refusal: checked.refusal };
}
