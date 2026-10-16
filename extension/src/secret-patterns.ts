/**
 * secret-patterns — the one secret-shape pattern set, shared by vipune.ts
 * (`looksLikeSecret`) and decision-log.ts (`redactSecrets`).
 */

/**
 * Secrets, by shape. vipune refuses to store a matching text (it persists
 * plaintext SQLite) and the decision log redacts matching spans (#1308) —
 * one pattern set, so the two cannot drift.
 *
 * Deliberately keyed on *shape with context*, never on raw entropy. An
 * earlier draft used `[A-Fa-f0-9]{40,}`, which matches every git SHA — so a
 * correction citing a commit, or a CI error line containing a hash, would
 * have been silently refused on the highest-value write path.
 *
 * THE CLOSING `\b` WAS THE SILENT GAP (#1393). The prefix rules closed with
 * `\b`, which demands a WORD character after a body that has already swallowed
 * every `-` it could reach. A trailing `"`, `,`, `?`, `&` or `)` — a key inside
 * JSON, a query string or a sentence — fails that assertion and the rule matches
 * NOTHING. Measured on the lens's own repro run UNBOUNDED, which is the check
 * that tells a pattern gap from a clip bug: zero matches, whole document. So the
 * decision log shipped the key intact while reporting `redactions: 0`, and no
 * scan window, however wide, can redact what no pattern matches — which is why
 * "widen the window" was never this fix. `TOKEN_END` asks instead that no
 * character the TOKEN continues across follow, so `"` and `,` satisfy it and a
 * git SHA still matches nothing, because it matches no PREFIX at all.
 *
 * The prefix rules dropped their LEADING `\b` for the same reason it is the wrong
 * instrument, not because a prefix may appear anywhere: `\b` reads as "a secret
 * starts here" and asserts only a transition, so it refuses a credential glued to
 * filler (`ffffsk-ant-…`, what a provider emits when it dumps a payload without
 * separators) while accepting one glued to an identifier's tail. Where a prefix
 * may begin is decided by the CALLER, which is the only party that can see it:
 * `widenPastCut` in decision-log.ts starts every `redactBounded` scan at the START
 * of a token, so a glued run's credential sits at position 0 of the slice and the
 * prefix still matches there. That widening is on the `redactBounded` path ONLY —
 * `redactSecrets` on a whole document does not need it, because the prefix has its
 * own left context there — so a caller that clips first and redacts second has no
 * such guarantee. That is the trade shape-with-context has always made, stated
 * rather than hidden in a metacharacter that meant something else.
 *
 * Measured, not assumed: each candidate form was run against all probe positions
 * before this shape was chosen. A negative lookbehind — the obvious spelling of
 * "not glued to a word" — is unusable on this runtime:
 * `(?<![A-Za-z0-9_:/=+-])sk-[A-Za-z0-9](?:[A-Za-z0-9-]{15,})` is FALSE for every
 * input, glued and clean alike, where the same body without it matches all of
 * them. A pattern that can never fire would have redacted nothing at all while
 * still reporting success.
 */

/**
 * "The token ends here", PER RULE: `(?![BODY])` asks only that no character THIS
 * rule's body could have continued across follows. `"`, `,` and `)` satisfy it, so
 * a key inside JSON or a sentence matches — which is what the closing `\b` used to
 * refuse (#1393).
 *
 * The class must be the rule's OWN body class and nothing wider. One shared
 * `[^A-Za-z0-9+/=]` — the previous shape here — asks a `+`, `/` or `=` NOT to
 * follow even for a rule whose body never consumes one, and a base64 tail is exactly
 * those characters: `sk-ant-…==`, `sk-ant-…+` and `sk-ant-…/seg` matched NOTHING,
 * reported `redactions: 0`, and shipped the key. Measured before the fix: count 0
 * for all three tails, unbounded, whole document, so no scan window could have
 * helped. `$` is the other way a token ends: at the end of the slice, which the
 * bounded scan reaches routinely.
 */
const tokenEndFor = (bodyClass: string) => `(?=$|[^${bodyClass}])`;

/**
 * A prefix rule. `literal` carries the prefix AND its own quantified body — each
 * token has a different minimum length and its own character class, so there is no
 * shared body shape to factor out. What is shared, and what the helper enforces,
 * is the END: the lookahead excludes exactly the characters the rule's own
 * `bodyClass` names, so a rule can never refuse a continuation its body could not
 * have consumed anyway.
 */
const token = (literal: string, bodyClass: string) =>
  new RegExp(`${literal}${tokenEndFor(bodyClass)}`);

/** A prefix rule whose own text already ends the token (`Bearer `, the PEM arm). */
const anchored = (literal: string) => new RegExp(literal);

export const SECRET_PATTERNS: readonly RegExp[] = [
  // OpenAI and Anthropic both use `sk-` with an infix segment (`sk-proj-`,
  // `sk-ant-api03-`), so the token body is NOT alphanumeric-only. Measured: the
  // previous `sk-[A-Za-z0-9]{16,}` refused a legacy key and passed both current
  // formats — including this project's own provider.
  token("sk-[A-Za-z0-9](?:[A-Za-z0-9-]{15,})", "A-Za-z0-9-"),
  token("(?:gh[pousr]_[A-Za-z0-9]{16,}|github_pat_[A-Za-z0-9_]{20,})", "A-Za-z0-9_"),
  token("xox[baprs]-[A-Za-z0-9-]{10,}", "A-Za-z0-9-"),
  token("glpat-[A-Za-z0-9_-]{16,}", "A-Za-z0-9_-"),
  token("AIza[0-9A-Za-z_-]{30,}", "0-9A-Za-z_-"),
  token("npm_[A-Za-z0-9]{30,}", "A-Za-z0-9"),
  token("AKIA[0-9A-Z]{16}", "0-9A-Z"),
  anchored("Bearer\\s+[A-Za-z0-9._-]{20,}"),
  anchored("-----BEGIN [A-Z ]*PRIVATE KEY-----"),
  // The key/value rule keeps its leading `\b` and gets no end assertion: its body
  // runs to the end of the token, so a trailing assertion could only ever be
  // satisfied by a body SHORTER than the token — the `\b` bug, relocated.
  //
  // The quote BEFORE the separator is the JSON form (#1393): `{"password":
  // "Sup3rSecretValue99"}` puts a `"` between the keyword and the `:`, and the old
  // rule allowed only `\s*` there, so the whole rule matched nothing — measured
  // count 0, unbounded, whole document, so no scan window could have caught it. It
  // sits BEFORE the `\s*` rather than only replacing the trailing `["']?`, because
  // `password : "value"` quotes the pair, not just the value. An identifier with
  // `=`/`:` inside it is still refused by the `\b`, which is the same
  // shape-with-context judgement that keeps a git SHA, a UUID, `task-list` and
  // `desk-top` out of the log — all four probe-asserted in
  // test-decision-redaction-overreach.ts. Two rules can fire on one JSON pair
  // (`{"token":"ghp_…"}` matches both the keyword rule and the `ghp_` prefix), so
  // an overlap is counted twice: over-redaction of a span that was already a
  // credential is a cosmetic count, never a leak, and the overreach probes assert
  // the zero side, which is the side that matters.
  /\b(?:api[_-]?key|secret|password|passwd|token)["']?\s*[:=]\s*["']?[A-Za-z0-9._\-/+]{12,}/i,
  // A password embedded in a URL: scheme://user:pass@host. The `://` before it is
  // already a left boundary no token continues across, so this rule needs none.
  /:\/\/[^\s/:@]+:[^\s/@]+@/,
];
