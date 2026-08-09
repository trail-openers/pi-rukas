/**
 * reply-markers — reading a `TOKEN: value` marker out of a subagent's reply.
 *
 * Every step in this driver asks a child to end with a structured marker, and
 * every step grew its own matcher for it. They drifted, and each drifted into
 * the same defect: **a marker that fails to parse produces a confident wrong
 * answer rather than an obvious failure.**
 *
 *   - `parseVerdict` (adversarial) was case-sensitive with no bold tolerance,
 *     so `**VERDICT: APPROVED**` fell through to `ISSUES_FOUND` — and handed
 *     the fix-developer the entire approval message as its list of findings.
 *   - the `ci` step used a bare `text.includes("ci-status: success")`, so any
 *     emphasis or capitalisation drift silently became a CI failure, burning
 *     the retry budget and parking a green cycle.
 *   - `PARK-REASON` was colon-anchored, so a resolver writing it as a heading
 *     got the synthesised default `underspecified` instead — which #397's
 *     override then read as a diagnosis and used to license building the
 *     wrong thing (#404).
 *
 * One reader, shared, tolerant of the shapes agents actually emit — and, just
 * as importantly, able to say **"absent"** distinctly from **"parsed as X"**.
 * The callers are what decide whether absence is safe; they cannot decide it
 * if the parser has already collapsed the two.
 */

/**
 * Read a `TOKEN: value` marker, in every shape real replies use.
 *
 * Accepted (`token` = `VERDICT`, values `APPROVED|ISSUES_FOUND`):
 *
 *     VERDICT: APPROVED
 *     **VERDICT:** APPROVED
 *     **VERDICT: APPROVED**
 *     verdict: approved
 *     ### VERDICT
 *     APPROVED
 *
 * `value` must contain exactly one capture group. Returns the matched value
 * lowercased, or `undefined` when the marker is genuinely absent — which is
 * information, not a failure to paper over.
 */
export function readMarker(text: string, token: string, value: RegExp): string | undefined {
  const v = value.source;
  const inline = text.match(new RegExp(`${token}\\s*:?\\s*\\**\\s*:?\\s*${v}\\b`, "i"));
  if (inline?.[1]) return inline[1].toLowerCase();
  // Heading form: the token on its own line, the value on the next.
  const heading = text.match(
    new RegExp(`^#{1,6}\\s*\\**\\s*${token}\\s*\\**\\s*$\\n+\\s*\\**\\s*${v}\\b`, "im"),
  );
  return heading?.[1]?.toLowerCase();
}

/**
 * Read a marker whose permitted values are a fixed set, returning the value in
 * its canonical (upper-case) form.
 *
 * Convenience over `readMarker` for the many call sites whose value space is
 * an enum; keeps the regex construction in one place so a new call site cannot
 * reintroduce a case-sensitive or emphasis-blind variant.
 */
export function readEnumMarker<T extends string>(
  text: string,
  token: string,
  allowed: readonly T[],
): T | undefined {
  if (allowed.length === 0) return undefined;
  const alt = allowed.map((a) => a.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")).join("|");
  const hit = readMarker(text, token, new RegExp(`(${alt})`, "i"));
  if (!hit) return undefined;
  return allowed.find((a) => a.toLowerCase() === hit);
}
