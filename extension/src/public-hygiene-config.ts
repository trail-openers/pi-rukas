/**
 * public-hygiene-config — the two things every #1788 module needs and nothing
 * else: the operator's off switch, and the error class a refused publish throws.
 *
 * It exists to break an import cycle. Before it, `public-hygiene-text.ts`
 * imported `hygieneGuardDisabled` from `public-hygiene-guard.ts` while the guard
 * imported `publicTextRefusal` from the text module — a real cycle that only
 * worked because of load order, and one that made either module unimportable on
 * its own in the position the other happened to occupy. This file has no
 * imports at all, so anything may reach it without closing a ring.
 *
 * It is also the ONE place the escape hatch is read. `PI_ENSEMBLE_PUBLIC_HYGIENE`
 * had two readers — the guard's registration and `forge.ts`'s `checkPublicText`,
 * which spelled the comparison inline — so a change to the off switch (a second
 * value, a trim, a case rule) had to be made twice, and the second site would
 * have silently disagreed with the first.
 *
 * Only the exact string `0` disables. `false`, `""` and `off` all leave every
 * check on, so an operator cannot switch the guard off by accident.
 */

/** The operator's off switch — exactly `0`, read nowhere else. */
export function hygieneGuardDisabled(env: NodeJS.ProcessEnv = process.env): boolean {
  return env.PI_ENSEMBLE_PUBLIC_HYGIENE === "0";
}

/**
 * The refusal a driver-authored publish carries when the forge exec seam
 * rejects it (#1788).
 *
 * Typed so the driver's existing error handling distinguishes "this text is
 * not publishable" from "`gh` failed" without parsing prose, and so a caller
 * that wants to surface the refusal verbatim has a named class to catch. The
 * message IS the refusal text and never contains the matched term.
 */
export class PublicHygieneError extends Error {
  /** Stable marker the driver's error paths match on, independent of the text. */
  readonly publicHygiene = true;

  constructor(message: string) {
    super(message);
    this.name = "PublicHygieneError";
  }
}
