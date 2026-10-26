/**
 * review-state-types — the shape of one resolved findings-store location.
 *
 * A leaf: the pure computation (review-store-locator.ts) CONSTRUCTS it and the
 * writing half (review-state-path.ts) returns it, so the type cannot live on
 * either side of the edge between them without one importing the other's
 * behaviour. Keeping it here is what lets `FindingsLocation` stay one type rather
 * than a re-export chain, which is the property that makes "both arms name the
 * same file" a checked fact instead of a hope.
 */

/** One resolved store: the directory, the file inside it, and where the ledger
 * that guards it lives (unchanged, under the git common dir). */
export interface FindingsLocation {
  /** The store's directory — `<agentDir>/review-state/<key>/<token>`. */
  dir: string;
  /** The findings file inside `dir`. */
  file: string;
  /** The ledger that guards writes to it (still under the git common dir). */
  ledger: string;
  /** True when the store could NOT be relocated and lives beside the ledger. */
  fellBack: boolean;
}
