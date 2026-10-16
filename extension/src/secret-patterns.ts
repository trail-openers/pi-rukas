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
 * `widenToTokenStart` in decision-log.ts starts every bounded scan at the START of
 * a token, so a glued run's credential sits at position 0 of the slice and the
 * prefix still matches there. That is the trade shape-with-context has always
 * made, stated rather than hidden in a metacharacter that meant something else.
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
 * "The token ends here." `[^A-Za-z0-9+/=]` asks only that no character the token
 * continues across follow, so `"` and `,` satisfy it. `$` is the other way a token
 * ends: at the end of the slice, which the bounded scan reaches routinely.
 */
const TOKEN_END = "(?=$|[^A-Za-z0-9+/=])";

/** A prefix rule whose body consumes the whole token, so `TOKEN_END` is its edge. */
const token = (literal: string) => new RegExp(`${literal}${TOKEN_END}`);

/** A prefix rule whose own text already ends the token (`Bearer `, the PEM arm). */
const anchored = (literal: string) => new RegExp(literal);

export const SECRET_PATTERNS: readonly RegExp[] = [
  // OpenAI and Anthropic both use `sk-` with an infix segment (`sk-proj-`,
  // `sk-ant-api03-`), so the token body is NOT alphanumeric-only. Measured: the
  // previous `sk-[A-Za-z0-9]{16,}` refused a legacy key and passed both current
  // formats — including this project's own provider.
  token("sk-[A-Za-z0-9](?:[A-Za-z0-9-]{15,})"),
  token("(?:gh[pousr]_[A-Za-z0-9]{16,}|github_pat_[A-Za-z0-9_]{20,})"),
  token("xox[baprs]-[A-Za-z0-9-]{10,}"),
  token("glpat-[A-Za-z0-9_-]{16,}"),
  token("AIza[0-9A-Za-z_-]{30,}"),
  token("npm_[A-Za-z0-9]{30,}"),
  token("AKIA[0-9A-Z]{16}"),
  anchored("Bearer\\s+[A-Za-z0-9._-]{20,}"),
  anchored("-----BEGIN [A-Z ]*PRIVATE KEY-----"),
  // The key/value rule keeps its leading `\b` and gets no `TOKEN_END`: its body
  // runs to the end of the token, so a trailing assertion could only ever be
  // satisfied by a body SHORTER than the token — the `\b` bug, relocated.
  /\b(?:api[_-]?key|secret|password|passwd|token)\s*[:=]\s*["']?[A-Za-z0-9._\-/+]{12,}/i,
  // A password embedded in a URL: scheme://user:pass@host. The `://` before it is
  // already a left boundary no token continues across, so this rule needs none.
  /:\/\/[^\s/:@]+:[^\s/@]+@/,
];
