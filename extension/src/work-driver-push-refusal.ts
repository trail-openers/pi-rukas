/**
 * work-driver-push-refusal — #1439: recognising that the FORGE refused the push.
 *
 * Measured shape. Cycle 1439 consolidated, committed and reached `git push`. GitHub
 * answered with push protection:
 *
 *   remote: error: GH013: Repository rule violations found for refs/heads/…
 *   remote: - GITHUB PUSH PROTECTION
 *   remote:     Resolve the following violations before …
 *
 * Pre-fix the push threw inside `integrate()`, the generic catch relabelled it as an
 * ordinary integrate failure, `runCommitPrLocked` fell back to an LLM ops dispatch —
 * which cannot lift a refusal the remote issued — and spent 40 minutes rediscovering
 * the same GH013 text before the cycle parked as `verify-failed:commit-pr` with a
 * cause verdict of `change` / "fix the change". The change is not what is broken: the
 * remote refused its CONTENT (secret-shaped fixtures are the common case), and only an
 * operator can allow it or the fixtures can change.
 *
 * Two rules this module exists to keep:
 *   - the RECOGNITION is a shared constant (`PUSH_REFUSAL_MARK`) the producer matches
 *     and the cause classifier matches, so the two cannot drift;
 *   - the refusal TEXT is the evidence. It is preserved verbatim (bounded, redacted
 *     downstream) including the allow-the-secret URLs, because those URLs are the
 *     operator's action.
 */

/**
 * The published markers of a server-side push refusal.
 *
 * `GH013` is GitHub push protection's error code; `push protection` and
 * `Repository rule violations` are the two prose lines GitHub prints with it (the
 * second appears even when a ruleset, not push protection, is what tripped). A
 * non-fast-forward is matched on the one unambiguous token git prints for it
 * (`(non-fast-forward)` — never `rejected` alone, which a hundred unrelated git messages
 * carry). Rewriting history to get past it is a force-push, which the driver will not do
 * to a shared branch, so it is the same operator decision rather than a local retry.
 */
export const PUSH_REFUSAL_MARK =
  /GH013|push protection|repository rule violations|non-fast-forward/i;

/** True when `text` is the output of a push the remote refused. */
export function isPushRefusal(text: string | undefined): boolean {
  return text !== undefined && text.length > 0 && PUSH_REFUSAL_MARK.test(text);
}

/**
 * The bounded refusal text to carry as evidence: the `remote:`-prefixed lines the
 * forge printed (which is where the verdict and the allow-the-secret URLs live),
 * falling back to the whole text when none match (a forge that does not prefix, or
 * a truncated error). Bounded so a verbose refusal cannot become unbounded cap
 * evidence; the lines that matter come first.
 */
export function pushRefusalEvidence(text: string, maxChars = 1200): string {
  const lines = text
    .split("\n")
    .map((l) => l.trim())
    .filter((l) => l.length > 0);
  const remote = lines.filter((l) => /^remote:/i.test(l) || /unblock-secret/i.test(l));
  const picked = remote.length > 0 ? remote.join("\n") : lines.join("\n");
  return picked.length <= maxChars ? picked : `${picked.slice(0, maxChars)} … (truncated)`;
}

/**
 * The bounded refusal text taken from a failed `git push`, or `undefined` when the
 * failure was NOT a refusal.
 *
 * `git push` reports on three channels at once — `stderr`, `stdout` and the thrown
 * message all carry parts of it, and which one holds the `remote:` lines varies by
 * transport — so all three are concatenated before matching. Callers rethrow whatever
 * this returns `undefined` for: a transport failure (`could not read from remote
 * repository`) is environment variance and belongs to the ops fallback, not here.
 */
export function pushRefusalFromError(err: unknown): string | undefined {
  const e = err as Error & { stderr?: string; stdout?: string };
  const stream = [e.stderr, e.message, e.stdout]
    .filter((s): s is string => typeof s === "string" && s.length > 0)
    .join("\n");
  return isPushRefusal(stream) ? pushRefusalEvidence(stream) : undefined;
}
