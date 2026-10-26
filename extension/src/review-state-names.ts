/**
 * review-state-names — the two literal names that make up the findings store's
 * path, in a leaf both halves of the locator can import.
 *
 * `review-state-path.ts` (the writing half) and `review-store-locator.ts` (the
 * pure computation) both need the store's basename and the state leaf, and
 * neither may spell its own copy: the accept guard builds its refusal spellings
 * from these same exports, so a second literal is a guard that stops matching the
 * file it exists to protect.
 *
 * It lives in its own module rather than in either locator because the two import
 * each other (the writing half calls the pure computation), and shared literals
 * cannot sit on either side of that edge without one of them importing the other's
 * behaviour.
 */

/**
 * The findings file's basename — inside the state dir from #1764 on, and the
 * name its `.tmp` / `.corrupt-*` / `.pre-migration` siblings are built from. The
 * name is deliberately UNCHANGED by the relocation: a redirect of
 * `PI_ENSEMBLE_REVIEW_LEDGER_FILE` still puts the store beside the override under
 * the one name every offline fixture builds its paths from.
 *
 * It is also the name the one-time migration looks for under the git common dir,
 * which is where it lived before #1764.
 */
export const FINDINGS_FILE = "review-findings.json";

/** The directory under the agent dir holding every clone's state. Exported so the
 * accept guard derives its spellings from here, not from its own literal. */
export const STATE_LEAF = "review-state";
