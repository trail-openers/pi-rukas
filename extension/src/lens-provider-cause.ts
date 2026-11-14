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

/** What a context-length refusal looks like in a provider's own words. */
const PATTERNS: readonly RegExp[] = [
  /maximum context length/i,
  /context length exceeded/i,
  /context_length_exceeded/i,
  /prompt is too long/i,
  /too many tokens/i,
  /input tokens exceeded/i,
];

/** An HTTP 400 carried by the child's own error text — the status a provider
 * uses for a request it refuses to even tokenize. */
const HTTP_400 =
  /\b400\b[^\n]{0,200}status code|\bstatus code\b[^\n]{0,40}\b400\b|HTTP\/1\.[01] 400|\b400 Bad Request\b/i;

/**
 * The named reason for a provider refusal that is really "this prompt is too
 * big", or `undefined` when the text describes something else.
 *
 * `text` is whatever the child left behind — an `errorStop.message`, a stderr
 * tail, or a lane reason already built from one. It is matched case-
 * insensitively and never echoed whole: the returned string is a fixed shape
 * plus the refusal's own first line, clipped, because the raw provider body is
 * untrusted text that has no business in a prompt or a report.
 */
export function providerContextProblem(text: string | undefined): string | undefined {
  if (!text) return undefined;
  const hit = PATTERNS.find((re) => re.test(text));
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

/** True when the child's own text says the provider refused it with a 400. */
export function providerRejected400(
  source: { text?: string; error?: string } | string | undefined,
): boolean {
  return HTTP_400.test(joinSources(source));
}

/**
 * The named reason for a context-length refusal seen in ANY of the places a
 * failed child leaves its output (#2261).
 *
 * The spawn layer resolves the child's text as `text || stderr || "(no output)"`
 * (`spawn-collapse-events.ts`), so a child that died before printing anything
 * carries the provider's refusal in `text` and has no separate error field;
 * a child that died mid-stream may carry it in either. Checking all the shapes
 * at once is what keeps the caller from having to know which arm it is in.
 */
export function providerTurnCapProblem(
  source: { text?: string; error?: string } | string | undefined,
): string | undefined {
  return providerContextProblem(joinSources(source));
}

function joinSources(source: { text?: string; error?: string } | string | undefined): string {
  if (typeof source === "string") return source;
  if (source === undefined) return "";
  return `${source.text ?? ""}\n${source.error ?? ""}`;
}

/**
 * Did this child die of a context-length refusal? True when the provider's 400
 * and the context vocabulary appear in the same text, or when the vocabulary
 * alone is unambiguous (a provider that says "maximum context length" is not
 * saying anything else).
 */
export function isProviderContextLengthFailure(
  result: { errorStop?: { message?: string }; text?: string } | undefined,
): boolean {
  if (result === undefined) return false;
  const candidates = [result.errorStop?.message, result.text];
  return candidates.some((t) => providerContextProblem(t) !== undefined);
}
