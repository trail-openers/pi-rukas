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
 *   - the RECOGNITION is one function (`isPushRefusal`) that the producer matches and the
 *     cause classifier matches, so the two cannot drift;
 *   - the refusal TEXT is the evidence. It is preserved (bounded, and REDACTED at the
 *     write site — see `pushRefusalEvidence`) including the allow-the-secret URLs,
 *     because those URLs are the operator's action.
 */

import { redactThenBound } from "./text-flatten.ts";

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
 *
 * ANCHORED TO THE LINES THE FORGE WROTE. The pre-fix matcher tested the WHOLE concatenated
 * stream, so any line naming those tokens made the whole failure a refusal: a project's own
 * output that merely mentions `non-fast-forward` (a test fixture, a changelog line, a lint
 * rule) relabelled an unrelated failure as the forge's verdict and parked the cycle blaming
 * a remote that never spoke. Git and GitHub put the server's verdict on `remote:`-prefixed
 * lines, and the rejected ref on `! [rejected]` / `! [remote rejected]` /
 * `error: failed to push some refs`. Only those lines may carry the verdict.
 */
const PUSH_REFUSAL_MARK = /GH013|push protection|repository rule violations|non-fast-forward/i;

/** The line shapes git and the forge use to report a refused ref. */
const FORGE_AUTHORED_LINE =
  /^(?:remote:|! \[rejected\]|! \[remote rejected\]|error: failed to push)/i;

/**
 * True when `text` is the output of a push the remote refused.
 *
 * Both conditions must hold on the SAME line: the line is one git or the forge authored
 * (`FORGE_AUTHORED_LINE`) and it names a refusal (`PUSH_REFUSAL_MARK`). A single
 * line-level test — rather than "does the stream contain a forge line" AND "does the
 * stream contain a token" — is what keeps a project's own `non-fast-forward` prose from
 * pairing with an unrelated `remote:` line and manufacturing a refusal.
 *
 * Returns false for the whole stream when nothing qualifies, which is how callers tell a
 * transport failure (the ops fallback's job) from the forge's verdict (a terminal park).
 */
export function isPushRefusal(text: string | undefined): boolean {
  if (text === undefined || text.length === 0) return false;
  return text
    .split("\n")
    .some((l) => FORGE_AUTHORED_LINE.test(l.trim()) && PUSH_REFUSAL_MARK.test(l));
}

/**
 * The bounded, REDACTED refusal text to carry as evidence: the `remote:`-prefixed lines the
 * forge printed (which is where the verdict and the allow-the-secret URLs live), falling
 * back to the whole text when none match (a forge that does not prefix, or a truncated
 * error). Bounded so a verbose refusal cannot become unbounded cap evidence; the lines that
 * matter come first.
 *
 * THE REDACTION IS NOT DECORATIVE ON THIS PATH. A GH013 refusal quotes the content push
 * protection flagged, so a credential is not hypothetical here: whatever the remote refused
 * is present in the text the driver is about to store. Without a redaction pass the driver
 * republishes the secret it was refused for, into the state file, the cap evidence, the
 * handoff comment and the PR. Redaction runs BEFORE the clip (`redactThenBound`) so the
 * bound cannot cut a token into a fragment no pattern recognises. The `unblock-secret/…`
 * URLs survive it — they are not credential-shaped, and they are the operator's action.
 */
export function pushRefusalEvidence(text: string, maxChars = 1200): string {
  const lines = text
    .split("\n")
    .map((l) => l.trim())
    .filter((l) => l.length > 0);
  const remote = lines.filter((l) => /^remote:/i.test(l) || /unblock-secret/i.test(l));
  const picked = remote.length > 0 ? remote.join("\n") : lines.join("\n");
  const { text: bound, clipped } = redactThenBound(picked, maxChars);
  return clipped ? `${bound} … (truncated)` : bound;
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
