/**
 * forge-read-refusal.ts — the ONE refusal text of the #2638 forge-config rule.
 *
 * The rule has two voices: the child guard that refuses a read of an operator
 * forge config directory, and the `gh`/`glab` wrapper that answers a child's
 * CLI call. They must say the same thing, in the same words — two spellings
 * across two files is the drift `FORGE_READ_OFF_REASON` (forge-read-off-switch.ts)
 * exists to prevent, and why this constant has exactly one owner. Both import
 * it; neither composes its own sentence.
 *
 * The text is CONDITIONAL (decision 11) because "read it through `forge_read`"
 * is only a route when the child was given `forge_read`: registration and
 * activation both require the parent's broker pair, so a child whose parent
 * served no broker would be told to use a tool it does not have. That arm names
 * the broker's absence as its own reason instead, and names the ops role, which
 * is the only role that still holds a login.
 *
 * The reason NEVER names the path it refused, and never echoes file content —
 * the disclosure this rule exists to close is content.
 */

import { keepsForgeLogin } from "./child-forge-env.ts";
import { forgeReadAvailableForRole } from "./child-forge-read-activation.ts";

/** The sentence both voices lead with. One owner; no other file spells it. */
export const FORGE_READ_RULE = "forge access is not available to this role";

/** The clause that names the sanctioned route, for a child that HAS the tool. */
export const FORGE_READ_ROUTE = "Read through forge_read, or ask the ops role.";

/** The clause for a child with no parent broker: the route it was offered is absent. */
export const FORGE_READ_NO_BROKER =
  "This child has no parent forge-read broker, so there is no forge_read to use: ask the ops role, which is the only role that keeps a forge login.";

/**
 * The refusal one child sees: the rule, then the route its own env allows.
 *
 * With no argument the availability question is asked of the CALLING process's
 * env through the one predicate the tool's registration and its activation also
 * apply (`forgeReadAvailableForRole`), so the guard (in the child) and the
 * wrapper (in the child's PATH) cannot disagree about which route exists.
 */
export function forgeReadRefusalText(
  forgeReadAvailable: boolean = forgeReadAvailableForRole(process.env.PI_ENSEMBLE_ROLE),
): string {
  const route = forgeReadAvailable ? FORGE_READ_ROUTE : FORGE_READ_NO_BROKER;
  return `Refused: ${FORGE_READ_RULE}. ${route}`;
}

/**
 * The rule's own role test: the role that KEEPS its login is exempt; an absent
 * or unrecognised role is NOT (decision 12 — the rule fails closed, so a child
 * whose spawn forgot to stamp a role is judged rather than waved through).
 */
export function roleKeepsForgeLogin(role: string | undefined): boolean {
  return role !== undefined && role !== "" && keepsForgeLogin(role);
}
