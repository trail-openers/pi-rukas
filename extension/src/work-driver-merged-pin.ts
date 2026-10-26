/**
 * work-driver-merged-pin — #1533: the vocabulary of the head pin.
 *
 * The merged step refuses to merge anything it did not verify, and the refusal
 * has to be *recognised* in two places: before the merge (the builder refuses an
 * OID that is not a full 40-char SHA) and after the forge answered (the CLI
 * rejected the pin because the head moved). Both decisions are small, purely
 * textual, and load-bearing — mis-read a pin refusal and it lands in the
 * "already merged" tolerance (reporting a merge that never happened) or in the
 * permanent-error bucket (falling back to an LLM ops dispatch against the same
 * moved head). They live here so `work-driver-merged-mechanized.ts` keeps one
 * job, and so the classifier is testable without a forge, an executor or a
 * cycle.
 *
 * Spellings were collected from the upstream sources:
 *
 *  - GitHub CLI (`cli/cli`, `pkg/cmd/pr/merge/merge.go`) renders the API's
 *    `headRefOid` mismatch as a pull-request-state error whose text contains
 *    the flag name — that is the stable token, and gh's surrounding prose is
 *    not. So the token alone never classifies: it is required ALONGSIDE a
 *    mismatch word, so a gh error that merely mentions the flag (an unknown
 *    flag on an old gh, for instance) is not read as a moved head.
 *  - GitLab's `glab mr merge --sha` refuses with the SHA it was given and the
 *    one it found (its MR merge checks `sha` against `diff_refs.head_sha`),
 *    which is the second shape — a mismatch sentence naming SHAs, with or
 *    without the flag name.
 *
 * A pin refusal is never retried and never handed to the LLM-ops fallback:
 * both would be an attempt to merge a head nobody reviewed.
 */

/** Valid merge methods — maps to the forge adapter's `prMerge` method argument. */
export type MergeMethod = "squash" | "merge" | "rebase";

/**
 * Does this forge error say the pinned head no longer matches the PR?
 *
 * Deliberately conservative in one direction only: it requires a mismatch
 * sentence ABOUT the head, not merely a sentence that mentions SHAs. A
 * base-branch or author mismatch also renders "does not match" and is an
 * ordinary merge failure that the caller's other classifiers handle.
 */
export function isHeadPinRefusal(message: string): boolean {
  const m = message.toLowerCase();
  // The field the forges name in a refusal, as ONE token: `head`, `headRefOid`,
  // `head_oid`, `head_sha`. Deliberately NOT `\bhead(?:_oid)?\b` — a trailing
  // `\b` after `d` matches nothing inside `headrefoid`, so the bounded form is
  // satisfied by the bare word `head` ALONE and silently fails on every real
  // message (`headRefOid does not match…` is GitHub's own wording, and the
  // classifier returned false for it until this was pinned). Left boundary only,
  // so `--match-head-commit` and `myhead` cannot supply a false `head`.
  const HEAD_TOKEN = String.raw`\bhead(?:_?(?:ref_)?oid|_sha)?(?![a-z0-9_])`;
  const MISMATCH = String.raw`(?:does not match|no longer match|mismatch|changed|moved)`;
  // The mismatch must be about the HEAD / the pinned commit, not about some other
  // SHA the error happens to name — so the gap is bounded (a `baseRefName … does
  // not match … head` sentence 200 characters apart is not a pin refusal) and the
  // two orders are both accepted, because forges phrase it either way.
  const mismatch = new RegExp(
    `${HEAD_TOKEN}[^\n]{0,60}${MISMATCH}|${MISMATCH}[^\n]{0,60}${HEAD_TOKEN}|\bmismatched head\b|\bhead commit\b|\b(?:sha|commit) mismatch\b`,
  ).test(m);
  if (!mismatch) return false;
  // …and the sentence must actually be about the PIN: it names one of the two
  // flags, or it spells the pin's own field name. A bare hex run is NOT enough —
  // "pull request 999 baseRefName does not match main" names a SHA-like token and
  // is an ordinary merge failure that the caller's other classifiers own.
  return (
    m.includes("match-head-commit") || m.includes("--sha") || /head_?(?:ref_)?oid|head_sha/.test(m)
  );
}

/**
 * The refusal text of a pin rejection, bounded for the state file.
 *
 * The prefix names the mechanism ("head pin refused") because this string is
 * what the operator reads in the handoff: a bare CLI sentence does not say that
 * the driver chose not to merge rather than failing to.
 */
export function pinRefusalReason(message: string): string {
  return `head pin refused: the PR head no longer matches the reviewed commit — ${message
    .slice(0, 300)
    .replace(/[\r\n\t]+/g, " ")}`;
}
