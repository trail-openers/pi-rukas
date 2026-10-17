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
 *
 * THE BODY CLASS IS WHAT THE PROVIDER EMITS, NOT WHAT LOOKED TIDY (#1393, round 2).
 * `ghp_aB3dE5fG7hJ9kL1mN2pQ4rS6tU8v_0` and `npm_…_E` both returned `count: 0`
 * unbounded: GitHub and npm base64url-encode their token bytes, so `_` and `-` are
 * in the alphabet, and a body class without them stops one character short of the
 * key — the end assertion then refuses the very character the body could not reach,
 * so the rule matches NOTHING rather than a prefix of it. A class narrower than the
 * provider's alphabet is a leak, not a conservative choice, which is why each arm
 * below names the set its provider actually emits and `tokenEndFor` is derived from
 * that same class so the two cannot disagree.
 *
 * THE KEY/VALUE RULE'S LEADING `\b` WAS THE SECOND SILENT GAP (#1393, round 2, item 9).
 * It is gone. The assertion is meant to refuse a keyword that is only a substring of a
 * longer identifier, and it does that job — `aws_secret_access_key=…`, `token_count: …`
 * and `tokenizer=…` all match nothing with or without it. What it ALSO refused was the
 * shape this fix round exists for: a keyword welded onto a run of non-whitespace, which
 * is exactly what a clipped scan window hands a pattern. Repro, verbatim:
 * `"t".repeat(2047) + "password=Sup3rSecretValue99" + "t".repeat(3000)` returned
 * `count: 0` from `redactSecrets`, from `redactBounded(…, 2600|4000, "start")`, and from
 * `redactDeep({evidence}, counter, 4000)` — the password shipped whole and every count
 * read zero. The keyword IS present; the left context the pattern demanded was cut off
 * by the clip, so no scan window of any width could have matched it. Dropping the `\b`
 * costs nothing on the zero side, which is the side the overreach probes assert, and it
 * is the only spelling that works here: `\b` is also false at the start of a slice, and
 * a widened scan hands the pattern exactly such a slice, so a bounded pass can never be
 * made to see what an unbounded one sees while the assertion stands.
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
  // GitHub's token bytes are base64url: `_` and `-` both occur in a real `ghp_`
  // / `github_pat_` key, and the old `A-Za-z0-9_` class stopped at the first `-`
  // with the end assertion refusing it — measured `count: 0` for a `ghp_…_E` key
  // unbounded, whole document. npm does the same, so its arm carries `_` too.
  token("(?:gh[pousr]_[A-Za-z0-9_-]{16,}|github_pat_[A-Za-z0-9_-]{20,})", "A-Za-z0-9_-"),
  token("xox[baprs]-[A-Za-z0-9_-]{10,}", "A-Za-z0-9_-"),
  token("glpat-[A-Za-z0-9_-]{16,}", "A-Za-z0-9_-"),
  token("AIza[0-9A-Za-z_-]{30,}", "0-9A-Za-z_-"),
  token("npm_[A-Za-z0-9_-]{30,}", "A-Za-z0-9_-"),
  // `{16,}` and not `{16}`: an AKIA key welded onto the following run
  // (`AKIAIOSFODNN7EXAMPLEX`, a payload dump with no separators) has seventeen
  // uppercase characters after the prefix, and the fixed length plus the end
  // assertion refused the whole thing — measured `count: 0`. The key is still at
  // least sixteen, so widening the minimum loses nothing and the glued form is
  // redacted rather than shipped.
  token("AKIA[0-9A-Z]{16,}", "0-9A-Z"),
  // The body is JWT base64url *with its padding*: `.` separates the segments and
  // `=` terminates a padded one. `[A-Za-z0-9._-]{20,}` stopped at the `=`, so a
  // padded bearer leaked its tail — measured `Bearer eyJ…=.sig` → `[REDACTED]=.sig`.
  // `~`, `+` and `/` are the remaining base64url/base64 digits (`_` and `-` are
  // already in there), so the class is the alphabet a bearer token is written in
  // rather than one character short of it.
  anchored("Bearer\\s+[A-Za-z0-9._~=+/-]{20,}"),
  // The PEM arm spans the WHOLE key, not just its header (#1393 round 5, item 3). The
  // header alone was redacted and the base64 body — the actual secret — shipped in
  // clear. The body is a base64 class and the END delimiter is OPTIONAL; every part of
  // that shape is load-bearing:
  //
  // * NOT `[\s\S]`: an any-character body over a CLIPPED key (no END, which is what a
  //   scan-window cut produces) runs the lazy span to end-of-string and erases every
  //   log line after the header. Measured: a 1950-char error tail after a clipped key
  //   came back as 38 chars — the request id, the git SHA and the CI URL were gone.
  //   A base64-alphabet body stops where prose begins, because `.`, `:`, `-` and `,`
  //   are not in the class, so the tail after the key survives. The class carries no
  //   `-`, so it cannot run past an `-----END` line either — which is what lets the
  //   delimiter be optional rather than required.
  // * NOT `\s` IN THE BODY CLASS AT ALL: a greedy class that carries `\s` backtracks
  //   across newlines to keep going, so it eats the token welded to the body's last
  //   newline. Measured with `[A-Za-z0-9+/=\s]*` verbatim: `…\nFATAL request-id: 7f3c-91ab`
  //   → `[REDACTED]-id: 7f3c-91ab` — `FATAL request` gone with the newline. The body is
  //   therefore LINE-ORIENTED: base64 characters run whole-line (`[A-Za-z0-9+/=]*` before
  //   each `\n`), and the trailing line is admitted by its own `+`, so at most one token
  //   past the last base64 line can be taken, and only when it is entirely base64. The
  //   class carries no `-`, so no part of it can cross an `-----END` line — which is what
  //   makes the delimiter optional rather than required.
  // * LINEAR: the body is a star over base64-with-newline, the tail is a `+` over base64,
  //   and neither can match a character the other cannot extend across, so a failed
  //   continuation backtracks in one step rather than re-exploring the span. The
  //   any-character body was lazy precisely because a greedy `\s\S` span re-explores the
  //   tail at every start position; restricting the class removes the need for laziness.
  //   `test-decision-secret-regex-linear.ts` measures both shapes at 200 KB and 1.6 MB and
  //   carries the greedy any-character variant as its TRAP.
  anchored(
    "-----BEGIN [A-Z ]*PRIVATE KEY-----[A-Za-z0-9+/=]*(?:\\r?\\n[A-Za-z0-9+/=]*)*(?:\\r?\\n[A-Za-z0-9+/=]+)?(?:-----END [A-Z ]*PRIVATE KEY-----)?",
  ),
  // The key/value rule has NO leading `\b` (see the header: that is the item-9 gap) and
  // no end assertion: its body runs to the end of the token, so a trailing assertion
  // could only ever be satisfied by a body SHORTER than the token — the `\b` bug,
  // relocated.
  //
  // The quote BEFORE the separator is the JSON form (#1393): `{"password":
  // "Sup3rSecretValue99"}` puts a `"` between the keyword and the `:`, and the old
  // rule allowed only `\s*` there, so the whole rule matched nothing — measured
  // count 0, unbounded, whole document, so no scan window could have caught it. It
  // sits BEFORE the `\s*` rather than only replacing the trailing `["']?`, because
  // `password : "value"` quotes the pair, not just the value. An identifier is still
  // refused, by the separator and the 12-character body rather than by an assertion:
  // `aws_secret_access_key=abcdef1234567890`, `token_count: 1234567890123`,
  // `tokenizer=abcdefghijklmn` and `tokens=1234567890123` all match nothing, because
  // what follows the keyword is `_`, not `[:=]` — the same shape-with-context judgement
  // that keeps a git SHA, a UUID, `task-list` and `desk-top` out of the log, all
  // probe-asserted in test-decision-redaction-overreach.ts. Two rules can fire on one JSON pair
  // (`{"token":"ghp_…"}` matches both the keyword rule and the `ghp_` prefix), so
  // an overlap is counted twice: over-redaction of a span that was already a
  // credential is a cosmetic count, never a leak, and the overreach probes assert
  // the zero side, which is the side that matters.
  //
  // The body quantifier is BOUNDED ABOVE, and the upper bound is not a style
  // preference. `String.replace` explores alternatives for an open-ended `{12,}`
  // over a multi-megabyte keyword-first run, which was observed to exhaust the
  // stack — a throw out of `redactSecrets`, which every caller reads as "not
  // JSON" and takes its non-serialisable path. 4096 is past any credential in
  // service: the longest real key here is a `github_pat_` at ~90 characters, and
  // the PEM arm does not use this rule at all.
  // The body class carries `=` (#1393 round 5, item 4). Base64 pads with it, so
  // `client_secret=…A-Q==` stopped at the first `=` and shipped the padding — measured
  // `client_[REDACTED]==`, the same tail-leak the Bearer arm carried for the same reason
  // and for the same fix. The class is still a CREDENTIAL alphabet, not `\S`: `@`, `,`,
  // `"` and whitespace stay out, so a key still stops at the delimiter that ends it and
  // the `kv-identifier` / `kv-token-count` overreach probes keep matching nothing.
  /(?:api[_-]?key|secret|password|passwd|token)["']?\s*[:=]\s*["']?[A-Za-z0-9._\-/+=]{12,4096}/i,
  // A password embedded in a URL: scheme://user:pass@host. The `://` before it is
  // already a left boundary no token continues across, so this rule needs none.
  //
  // WHAT CHANGED (item 8): the classes no longer exclude `/`. A userinfo component may
  // hold one (RFC 3986 leaves `user` and `password` permissive, and real connection
  // strings use it — a namespace or key separated by `/`, a path-ish secret), and the
  // old `[^\s/:@]+:[^\s/@]+@` stopped at the first `/`: measured `count: 0` unbounded,
  // whole document, for both `https://us/er:pw@host` and `https://user:hunt/er2Sup3r@host`.
  //
  // The shapes each half excludes are NOT symmetric, and that asymmetry is load-bearing
  // rather than tidy. The USER half excludes `:` and whitespace but allows `/`; the PASS
  // half additionally excludes `@` — it has to, or `https://:@host` is read as an empty
  // credential — while the user half does not, which is what lets the `@` that terminates
  // the match fall inside the user class and reach a credential whose password itself
  // ends in base64 padding. Excluding `@` from BOTH halves, which is the tempting
  // symmetric spelling, silently loses `https://user:hunt/er2Sup3r@…`-shaped keys.
  //
  // No class is starred over a run it can also terminate on. `[^\s@]*:[^\s@]*@` over a
  // long run of `:` was measured at 4.3 SECONDS — a denial of service on the decision
  // path, since redaction runs on untrusted text — where this shape takes under 1 ms on
  // every input in test-decision-secret-regex-linear.ts. That file is the guard, and its
  // TRAP (a nested-quantifier variant over the same input) proves the harness can see
  // the difference: a guard never observed to fail is worthless.
  /:\/\/[^:@\s]*:[^@\s]+@/,
];
