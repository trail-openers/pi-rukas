/**
 * merge-refusal-render.ts — the shared renderers every merge refusal quotes,
 * split out of merge-guard.ts / merge-guard-reads.ts so both the hook and the
 * evidence gatherer use ONE rule for what an operator-facing line may contain,
 * and neither file grows past the 500-line gate (#12) carrying prose helpers.
 *
 * Both are never-throw by contract: they run inside the guard's `catch` blocks
 * and its refusal paths, where a throw would fail the guard OPEN (the command
 * runs). `analyseRefusal` narrows with `typeof` rather than casting for that
 * reason (#955 lens round 6) — a cast makes `(err as Error).constructor.name`
 * a throw site for a thrown `null`.
 */

/** How many check names a refusal spells out before counting the rest. */
const MAX_NAMED_CHECKS = 10;

/**
 * The control characters a forge-supplied name may carry, as a class body: C0
 * plus DEL. Built from the CODE POINTS rather than written as a literal, so
 * this module contains no control bytes of its own and the rule stays greppable
 * (`String.fromCharCode` names exactly which characters are stripped).
 */
const CONTROL_CLASS = `[${String.fromCharCode(0)}-${String.fromCharCode(31)}${String.fromCharCode(127)}]`;
const CONTROL_CHARS = new RegExp(`${CONTROL_CLASS}+`, "g");

/**
 * The bounded, one-line rendering of a check-name list (#2107). A PR with two
 * hundred failing checks used to produce a two-hundred-name refusal, and a
 * name that carried a newline (a gh that echoed a stack trace into the field)
 * broke the line the operator reads and any log that parses it — so names are
 * clipped to `MAX_NAMED_CHECKS` plus `( +N more )` and every control character
 * collapses to a space, the same treatment `adversarialRefusal` gives a ledger
 * row's `detail`.
 *
 * Check names come off the forge's JSON: untrusted text, on the path that ends
 * in an irreversible merge, so the bound is not cosmetic.
 */
export function clipCheckNames(names: string[]): string {
  const clean = names.map((n) => n.replace(CONTROL_CHARS, " ").trim());
  const shown = clean.slice(0, MAX_NAMED_CHECKS);
  const rest = clean.length - shown.length;
  return `${shown.join(", ")}${rest > 0 ? ` (+${rest} more)` : ""}`;
}

/**
 * One message builder for every throw the guard catches (#955 lens round 6).
 * The catches must not themselves throw: a thrown `null`/`undefined` value
 * makes `(err as Error).constructor.name` throw OUT of the catch, which
 * fails the guard OPEN (the command passes). `typeof` narrowing handles
 * every throwable value — no casts — and `String(err)` renders null and
 * undefined as the strings `null`/`undefined`.
 */
export function analyseRefusal(err: unknown, limit = 100): string {
  if (err instanceof Error) return `${err.name}: ${err.message.slice(0, limit)}`;
  return String(err).slice(0, limit);
}
