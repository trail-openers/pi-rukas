/**
 * lens-provider-cause — the provider refusal a lens child died of, read from the
 * child's own reply rather than its exit code (#2261).
 *
 * A lens whose prompt filled the model's context does not fail like a broken
 * harness. The provider answers HTTP 400 "This model's maximum context length is
 * N tokens", Pi turns that into an assistant message with `stopReason: "error"`,
 * and the child still exits non-zero. Before this module the retry loop recorded
 * only `attempt N/4: exit 1`, so six lenses × four attempts of a prompt that was
 * never going to fit read as flaky infrastructure and the operator went hunting
 * for a spawn bug.
 *
 * The rule here is narrow and it is a *reading*, not a classification of every
 * provider fault (that is `work-driver-failure-taxonomy.ts`, which owns the
 * driver's dispatch events and needs a shell-error grammar this child never
 * produces): it recognises the context-length refusal in the three shapes it
 * actually arrives in — the quoted JSON message, a bare `400 status code` line,
 * and a prompt too long for a token window stated either way — and returns a
 * reason naming what the child hit.
 *
 * Two consequences follow from recognising it, and both belong to the caller
 * that reads this: the refusal is NOT a transient failure, so the retry loop
 * stops at the first attempt (re-spawning the same oversized prompt four times
 * is four guaranteed failures and four times the wall clock), and the reason
 * reaches the operator through the lane reason rather than as a verdict word.
 */

/** The operator-visible phrase that names this refusal wherever it is rendered. */
export const CONTEXT_LENGTH_HINT = "provider context-length limit";

/** What a context-length refusal looks like in a provider's own words.
 *
 * The two token-count forms are the weak members of this list: "too many tokens"
 * is ALSO what a rate limit says, so they are vocabulary a display path may read
 * and the terminal decision must not (see {@link TERMINAL_PATTERNS}). */
const PATTERNS: readonly RegExp[] = [
  /maximum context length/i,
  /context length exceeded/i,
  /context_length_exceeded/i,
  /prompt is too long/i,
  /too many tokens/i,
  /input tokens exceeded/i,
];

/** The subset of {@link PATTERNS} that is unambiguous about the PROMPT's size, and
 * therefore the only vocabulary allowed to end a lens lane. A provider that says
 * "maximum context length" or "prompt is too long" is refusing this request for
 * its size; a provider that says "too many tokens" may be refusing the minute. */
const TERMINAL_PATTERNS: readonly RegExp[] = PATTERNS.filter(
  (re) => re.source !== "too many tokens" && re.source !== "input tokens exceeded",
);

/** Rate / quota wording. A refusal carrying it is transient by definition — the
 * retry loop and its backoff exist precisely to ride it out — so it can never be
 * terminal no matter what size words share the body. Providers mix the two in one
 * message ("too many tokens in this prompt or too many requests", "reduce tokens
 * per request"), which is why the discriminator has to be the rate wording rather
 * than an assumption that size vocabulary implies a size refusal.
 *
 * `\b429\b` is deliberately looser than the shared `RATE_LIMIT_429_PATTERN`
 * (`types.ts`, which wants `429 status`): this test guards against a rate body
 * wearing size vocabulary, and here an over-broad match is the safe direction — a
 * false positive keeps a lane its retries, where a false negative burns them. */
const RATE_OR_QUOTA =
  /\b429\b|too many requests|rate.?limit|per minute|per hour|requests? per|retry in|retry after|retry delay|quota|throttl|back off|too many concurrent|exceeded your current|slow down/i;

/** An HTTP 400 carried by the provider's OWN error text — the status a provider
 * uses for a request it refuses to even tokenize, and the only status at which a
 * request is refused for its shape rather than its timing. A 429 is a refusal of
 * the moment, never of the prompt. Read only from `errorStop`, the structured
 * channel the spawn layer fills from the final assistant message's `errorMessage`
 * (`types.ts`): never from the child's prose, which the prompt orders to quote the
 * diff verbatim and would let a diff-authored "400 status code" string decide a
 * retry policy. */
const HTTP_400 =
  /\b400\b[^\n]{0,200}status code|\bstatus code\b[^\n]{0,40}\b400\b|HTTP\/1\.[01] 400|\b400 Bad Request\b/i;

/**
 * The named reason for a provider refusal that is really "this prompt is too
 * big", or `undefined` when the text describes something else.
 *
 * `text` is the provider's own words — an `errorStop.message`, or a lane reason
 * already built from one. It is matched case-insensitively and never echoed
 * whole: the returned string is a fixed shape plus the refusal's own first line,
 * clipped, because the raw provider body is untrusted text that has no business
 * in a prompt or a report.
 *
 * `terminal` narrows the vocabulary to the unambiguous forms and refuses any body
 * carrying rate/quota wording. Callers that only DISPLAY a cause leave it out —
 * "too many tokens" is worth showing when a lane really died that way. Callers
 * that DECIDE whether to retry must pass it, because a misread rate refusal costs
 * a lane three of its four attempts and tells the operator the wrong story.
 */
export function providerContextProblem(
  text: string | undefined,
  opts?: { terminal?: boolean },
): string | undefined {
  if (!text) return undefined;
  if (opts?.terminal === true && RATE_OR_QUOTA.test(text)) return undefined;
  const patterns = opts?.terminal === true ? TERMINAL_PATTERNS : PATTERNS;
  const hit = patterns.find((re) => re.test(text));
  if (hit === undefined) {
    // A bare 400 with no context vocabulary is a different bad request; naming
    // it as a context problem would send the operator after the wrong cause.
    return undefined;
  }
  const firstLine = text
    .split("\n")
    .map((l) => l.trim())
    .find((l) => l !== "" && hit.test(l));
  const quote = firstLine === undefined ? "" : `: ${firstLine.slice(0, 160)}`;
  return `the ${CONTEXT_LENGTH_HINT} (${hit.source}) — the lens prompt was too large for the model's context window${quote}`;
}

/**
 * True when the provider's OWN error text carried an HTTP 400.
 *
 * `message` is the `errorStop.message` the spawn layer recorded, and nothing
 * else: the child's `text` is the model's prose (resolved as
 * `text || stderr || "(no output)"` by `spawn-collapse-events.ts`) and the lens
 * prompt orders the reviewer to quote the diff, so a line of diff text — a
 * fixture asserting a 400, a test name — is enough to reach `text` and would
 * otherwise decide a retry policy from content the change under review authored.
 */
export function providerRejected400(message: string | undefined): boolean {
  return message !== undefined && HTTP_400.test(message);
}

/**
 * Did this child die of a provider refusal it was never going to recover from?
 *
 * Three conditions, all read from the provider's OWN structured error
 * (`errorStop`), and none of them the child's prose:
 *
 *  - the refusal carries an HTTP 400 — the status for a request the provider
 *    refuses on its shape. {@link providerRejected400} is the predicate this rule
 *    was documented to pair with, and requiring it is what makes the pairing real:
 *    without a status the loop cannot tell a refusal of the prompt from a refusal
 *    of the minute, and a bare size sentence arrives from both. A 429 therefore
 *    never ends a lane however it is worded;
 *  - its unambiguous size vocabulary says the PROMPT was too large
 *    ({@link TERMINAL_PATTERNS}) — the token-count forms are excluded here, since
 *    "too many tokens" is what a rate refusal says in the same words a size
 *    refusal uses, and reading them terminally is how a busy endpoint cost a lane
 *    three of its four attempts and got blamed on the prompt's size;
 *  - and nothing in it says rate / quota / retry-later, which is wording a backoff
 *    clears and the retry loop exists to ride out.
 *
 * A child that died some other way has no `errorStop` and answers false: its `text`
 * is the model's prose, and the lens prompt orders the reviewer to quote the diff,
 * so a line of diff text is enough to reach it.
 */
export function isProviderContextLengthFailure(
  result: { errorStop?: { message?: string } } | undefined,
): boolean {
  const message = result?.errorStop?.message;
  if (!providerRejected400(message)) return false;
  return providerContextProblem(message, { terminal: true }) !== undefined;
}
