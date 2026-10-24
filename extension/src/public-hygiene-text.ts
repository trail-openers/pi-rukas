/**
 * public-hygiene-text — the two TEXT surfaces of the #1788 guard that are not
 * git reads, split out of `public-hygiene-guard.ts` along the seam AGENTS.md §12
 * asks for (the guard decides; these decide what a command's own words say).
 *
 * ## `publicTextRefusal` — the driver's seam
 *
 * The driver posts issue and PR bodies and merge subjects from process memory,
 * through no shell, so no `tool_call` hook ever sees them. This is the pure
 * check those call sites run before they exec anything (#1788, PM decision 1).
 * The generic set applies, as it does to every public text surface: only the
 * `git push` DIFF scan is private-denylist-only.
 *
 * It returns a refusal STRING rather than throwing. Every caller here already
 * has a failure shape of its own — `{ ok: false, reason }` for the merge, a
 * blocked `tool_call` for a comment — and a throw past a contract is a step that
 * dies instead of a cycle that parks with a reason. `undefined` means clean; the
 * string never carries the term, only what `public-hygiene-refusals.ts` renders.
 *
 * ## `publishesText` — the publish predicate
 *
 * The unreadable-operand check needs to know whether a command publishes at all
 * before it refuses to read one of its fields. That predicate is the same one
 * the scan uses, and it lives there for one reason: `gh api` is a publish only
 * with a content-carrying `-f/-F`, and the scan owns that nuance. Duplicating
 * the bare-`api` rule here would create a second owner of a decision the scan
 * already had to think through (#1788 round-1 adversarial: "a second owner of
 * the push-verb decision").
 */

import { type DenylistRead, publicTextProblem, readPublicDenylist } from "./public-denylist.ts";
import { hygieneGuardDisabled } from "./public-hygiene-guard.ts";
import { denylistUnreadableRefusal, refusalFor } from "./public-hygiene-refusals.ts";
import { publishesText as publishesCommand } from "./public-hygiene-scan.ts";

/**
 * The pure text check the driver's own forge posts go through (#1788, PM
 * decision 1): issue and PR titles and bodies checked before the forge adapter
 * execs anything. The generic set applies to every public text surface,
 * including the driver's in-process writes; only the `git push` DIFF scan is
 * private-denylist-only.
 *
 * Returns a refusal string, or undefined when the text is clean. It never
 * contains the matched term.
 */
export function publicTextRefusal(
  label: string,
  text: string,
  deny: DenylistRead = readPublicDenylist(),
): string | undefined {
  if (hygieneGuardDisabled()) return undefined;
  const hit = publicTextProblem(text, deny, true);
  if (!hit) return undefined;
  if (hit.kind === "unreadable") return denylistUnreadableRefusal(hit.reason);
  if (hit.kind === "denylist") {
    return refusalFor(undefined, { location: label, line: hit.line }, undefined);
  }
  return refusalFor(undefined, undefined, { location: label, category: hit.category });
}

/**
 * Whether this command publishes text the guard is meant to read. Delegates to
 * the scan's own predicate so `gh api` without a content flag is not called a
 * publish here either.
 */
export function publishesText(argv: readonly string[]): boolean {
  return publishesCommand(argv);
}
