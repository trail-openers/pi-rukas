/**
 * work-queue-parks-claims — the operator action for a `cross-group-conflict`
 * park (#1454).
 *
 * Split out of `work-queue.ts` for the 500-line gate (AGENTS.md §12);
 * `humanActionFor` is the only caller.
 */

/**
 * The claimant's number is carried on the park reason (`parkReason` appends
 * `:claimant<N>`) because the action must name WHICH claim to inspect. When
 * the reason predates the suffix — or a park was recorded without one — the
 * action falls back to the claims file itself rather than guessing.
 */
export function crossGroupAction(reason: string, primary: number): string {
  const claimant = reason.match(/cross-group-conflict:claimant(\d+)/);
  const who = claimant ? `#${claimant[1]}` : "the claimant named in the evidence";
  return `check whether ${who}'s cycle is still running and whether it left a claim in .pi/work-state/path-claims.json — a claim whose owner has exited, or whose state file is terminal, is pruned on the next /work, so re-run \`/work ${primary} --restart\` once it is gone (do NOT edit the other cycle's files)`;
}
