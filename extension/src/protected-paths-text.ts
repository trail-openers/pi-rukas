/**
 * protected-paths-text — the shared wording for every gate that refuses on a
 * protected path: the develop-time halt, the driver's `merged` step, and the
 * mode-independent merge guard.
 *
 * One module because the three sites must not drift on the two sentences that
 * matter: which paths are protected and why an agent does not merge them, and
 * that a read which could not be had is not a clean read. The develop gate's
 * fuller prose (`explainProtectedPaths`, work-driver-doctrine.ts) is a separate
 * concern — it speaks to an operator who has a `--allow-protected` remedy; the
 * merge-time refusals deliberately offer none.
 */

/** A rejection bounded for an operator-facing refusal. */
export function errText(err: unknown): string {
  const text = err instanceof Error ? err.message : typeof err === "string" ? err : String(err);
  // A rejection that stringifies to nothing still needs a name in the reason —
  // an empty one reads as "git failed for no stated reason".
  if (text.trim().length > 0) return text.slice(0, 200);
  return (err === null ? "null" : err === undefined ? "undefined" : "unknown rejection").slice(
    0,
    200,
  );
}

/** The sentence naming what a PR's protected paths are and who merges them. */
export function protectedPathsSentence(paths: readonly string[]): string {
  return `this PR changes ${paths.length} protected path(s) — ${paths.join(", ")} — which define what verification, review and permission mean for this repository, so an agent does not merge them; the operator merges this PR themselves`;
}

/** The sentence naming a protected-path read that could not be completed. */
export function protectedReadUnreadableSentence(who: string, unreadable: string): string {
  return `the protected-path read for ${who} failed (${unreadable}) — a diff that could not be inspected is not a diff that is cleared`;
}
