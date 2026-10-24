/**
 * public-hygiene-refusals — the text of a public-hygiene refusal (#1788).
 *
 * A refusal has one job the agent can still act on: say WHERE the problem is
 * and WHAT KIND it is, and tell the agent what to do. It must never say WHAT
 * the term was — that is the entire point of the guard, and a refusal that
 * quoted the match would put the private name in the transcript, the run log
 * and the PM's context, which is a wider audience than the repository would
 * have had.
 *
 * This is the `merge-refusals.ts` shape (one module owning every refusal
 * string, so the tests pin them in one place) applied to a guard whose
 * refusals are privacy-critical rather than merely explanatory.
 *
 * ## What each refusal names
 *
 * - a denylist hit: the denylist FILE PATH, the LINE NUMBER, the location
 *   (title / body / comment / release notes / commit message / diff path plus
 *   commit short sha), and the remedy;
 * - a generic-set hit: the CATEGORY (`private-ipv4`, `home-path`) and the
 *   remedy, with no path — there is no file to open;
 * - an unreadable input: why it could not be read, which is the actionable
 *   half ("the file is gone", "it is outside the tree", "git timed out").
 */

import { publicDenylistPath } from "./public-denylist.ts";
import type { GenericCategory } from "./public-denylist.ts";
import type { ScanProblem } from "./public-hygiene-types.ts";

/** The escape hatch, quoted verbatim in every refusal so it is discoverable. */
export const HYGIENE_ESCAPE_HATCH = "PI_ENSEMBLE_PUBLIC_HYGIENE";

/** A denylist entry matched in a piece of public text. */
export interface DenylistHitLocation {
  /** Where in the publish the text sat: "body", "commit message (a1b2c3d)". */
  location: string;
  /** The line number in the denylist. */
  line: number;
}

/**
 * The remedy, phrased once so the refusals cannot drift apart. The path is the
 * agent's only route to the term, and pointing at a line number rather than
 * quoting it is what makes that route a deliberate act by a human operator
 * rather than a copy-paste into the next public comment.
 */
function remedy(line: number): string {
  return (
    `Rewrite the text without that term. The private denylist is at ${publicDenylistPath()} ` +
    `(the entry that fired is line ${line}); the term itself is deliberately not repeated ` +
    `here, because this message reaches the transcript and the run log. If this publish is ` +
    `genuinely fine, an operator can set ${HYGIENE_ESCAPE_HATCH}=0.`
  );
}

/** A denylist entry matched in a piece of public text. */
export function denylistRefusal(hit: DenylistHitLocation): string {
  return [
    `Refused: this publish would put private text in a public repository.`,
    `A private-denylist entry matched the ${hit.location} (denylist line ${hit.line}).`,
    remedy(hit.line),
  ].join("\n");
}

/** The generic set matched in a piece of public text (no file, no line). */
export function genericRefusal(location: string, category: GenericCategory): string {
  const what =
    category === "private-ipv4"
      ? "a private network address (10/8, 172.16/12, 192.168/16 or 100.64/10)"
      : "a personal home directory path";
  return [
    `Refused: this publish would put private text in a public repository.`,
    `The ${location} contains ${what}. This check is built in — it applies whether or not a ` +
      `denylist file exists, so there is no line to look up.`,
    `Rewrite the ${location} to name the thing instead of the address or the path (an ` +
      `example address from RFC 5737 such as 192.0.2.10, or a placeholder like /home/dev/). ` +
      `If this publish is genuinely fine, an operator can set ${HYGIENE_ESCAPE_HATCH}=0.`,
  ].join("\n");
}

/** A publish whose text this guard could not read. */
export function unreadableRefusal(what: string, reason: string): string {
  return [
    `Refused: this publish could not be checked, and an unchecked publish is not a clean one.`,
    `The ${what} ${reason}.`,
    `Fix why it could not be read and run the command again — put the body in a file under ` +
      `the working directory or the system temp dir, or retry the git read. If this publish ` +
      `is genuinely fine, an operator can set ${HYGIENE_ESCAPE_HATCH}=0.`,
  ].join("\n");
}

/** The denylist file is configured but unreadable, so the private check cannot run. */
export function denylistUnreadableRefusal(reason: string): string {
  return [
    `Refused: the private denylist could not be checked, and a publish without that check is ` +
      `not a checked one.`,
    `Reason: ${reason}.`,
    `Fix the file (its path is ${publicDenylistPath()}), or remove it to fall back to the ` +
      `built-in generic set. If this publish is genuinely fine, an operator can set ` +
      `${HYGIENE_ESCAPE_HATCH}=0.`,
  ].join("\n");
}

/**
 * The refusal for the first problem in a scan: an unreadable surface wins over
 * a clean-looking text, because "I could not read it" is the more urgent thing
 * for the agent to fix.
 */
export function refusalFor(
  problem: ScanProblem | undefined,
  hit: DenylistHitLocation | undefined,
  generic: { location: string; category: GenericCategory } | undefined,
): string | undefined {
  if (problem) return unreadableRefusal(problem.location, problem.reason);
  if (hit) return denylistRefusal(hit);
  if (generic) return genericRefusal(generic.location, generic.category);
  return undefined;
}
