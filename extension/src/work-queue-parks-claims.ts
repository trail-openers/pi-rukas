/**
 * work-queue-parks-claims — the operator action for a `cross-group-conflict`
 * park (#1454).
 *
 * Split out of `work-queue.ts` for the 500-line gate (AGENTS.md §12);
 * `humanActionFor` is the only caller.
 */

import { claimantOnThisHost } from "./work-driver-explain-claims.ts";

/**
 * The claimant's number is carried on the park reason (`parkReason` appends
 * `:claimant<N>`) because the action must name WHICH claim to inspect. When the
 * reason predates the suffix — or a park was recorded without one — the action
 * falls back to the claims file itself rather than guessing.
 *
 * #2173 — the evidence is read for WHERE the holder lives, with the same
 * judgement the claims registry itself uses (`claimantOnThisHost` →
 * `judgeOwner`), so this sentence and `explainCrossGroupConflict` cannot call
 * one claimant a foreign container and a sibling at once. A same-host sibling
 * is named as one, with its issue number, because the operator's next step is
 * `/work-status` on that issue on this machine; the other-namespace wording
 * stays for the holder whose host or pid namespace is genuinely not ours.
 */
export function crossGroupAction(reason: string, primary: number, evidence = ""): string {
  const claimant = reason.match(/cross-group-conflict:claimant(\d+)/);
  const who = claimant ? `#${claimant[1]}` : "the claimant named in the evidence";
  const where = claimantOnThisHost(evidence)
    ? ` ${who} is a sibling cycle on this host (issue ${claimant ? `#${claimant[1]}` : who}, still running), so \`/work-status\` and its pid are both checkable here`
    : ` whether ${who}'s cycle is still running`;
  return `check${where} and whether it left a claim in .pi/work-state/path-claims.json — a claim whose owner has exited, or whose state file is terminal, is pruned on the next /work, so re-run \`/work ${primary} --restart\` once it is gone (do NOT edit the other cycle's files)`;
}
