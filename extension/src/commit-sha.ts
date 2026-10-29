/**
 * commit-sha — the ONE shape check a value must pass to be called a commit oid.
 *
 * A dependency-free leaf: no executor, no trace, no timeout constant, nothing
 * that reaches the filesystem or a subprocess. That property is the reason this
 * predicate has its own file rather than riding along in `review-head-sha.ts`.
 * The resolver next door pulls in `exec.ts`, `trace.ts` and the git bound, and
 * the lean base gate needs only the shape — `lean/state.ts` validates a record
 * field and `lean/base-proof.ts` refuses a value before it can become a git
 * argument. Importing the shape from a module that also imports the executor
 * drags a subprocess seam into the state record's own validator; importing it
 * from here costs one regex.
 *
 * The predicate is a SHAPE check and nothing more: it says the string is 40
 * lowercase hex, which is what makes it an immutable object name rather than a
 * ref (`main`, `HEAD`, `@{0}` and a short prefix all fail it). It does NOT say
 * the clone holds such an object — that is `lean/base-proof.ts`, which asks
 * git. Anything that treats this as existence has the same hole the base proof
 * exists to close.
 *
 * `review-head-sha.ts` re-exports this so its existing importers keep working;
 * new callers should import from here.
 */

/**
 * #1039 — true when the value is a full 40-char lowercase-hex commit SHA.
 * A branch name or abbreviated OID (pre-#1039 legacy entry) is treated as
 * UNKNOWN — never matched by string equality against a PR head OID.
 */
export function isFullCommitSha(value: string): boolean {
  return /^[0-9a-f]{40}$/.test(value);
}
