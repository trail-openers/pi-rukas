/**
 * Shared fixtures for the two bounded-redaction files (#1393): the credential
 * shapes, the filler builders that place one at a clip edge, and the probe list
 * of text that must NEVER redact. Both consumers need the same `CASES` — one
 * drives the `decide()` round trip, the other the over-redaction probes — and
 * the whole file exists only to keep each under the 500-line cap, so the
 * fixture edits stay in one place.
 */

import { PROBE_KEY } from "./decision-fixtures.ts";

/**
 * The lens's shapes, verbatim. `body` is what must never survive: `Bearer `,
 * `https://user:` and `password=` are CONTEXT the caller legitimately ships, so
 * asking whether THOSE survived would test the wrong thing — the credential half
 * is what has to be gone.
 */
export const CASES: { name: string; secret: string; body: string }[] = [
  {
    // The URL rule's match is `://user:pass@` -- it ENDS at the `@`, so the
    // host and path after it legitimately survive and only the credential half
    // (with its `://user:` context) may not. Asking for more would demand the
    // pattern redact text it does not claim.
    name: "url-credentials",
    secret: "https://user:hunter2Sup3rSecretValue@origin.internal/x",
    body: "hunter2Sup3rSecretValue",
  },
  {
    name: "bearer",
    secret: "Bearer abcdef.1234567890_gfedcba-9876543210",
    body: "abcdef.1234567890_gfedcba",
  },
  {
    name: "bearer-json",
    // The JSON form of the same shape: quotes around the whole pair, so the
    // credential's own context sits behind a `"` no pattern may refuse to cross.
    secret: String.raw`{"authorization":"Bearer abcdef.1234567890_gfedcba-9876543210"}`,
    body: "abcdef.1234567890_gfedcba",
  },
  {
    name: "sk-key",
    secret: "sk-ant-api03-aB3dE5fG7hJ9kL1mN2pQ4rS6tU8vW0xY2zA4bC6d",
    body: "sk-ant-api03-aB3dE5fG7hJ9kL1mN2pQ4rS6tU8vW0xY2zA4bC6d",
  },
  {
    // A base64 TAIL: `=` and `+` are not in any prefix rule's body class, so the
    // old SHARED `TOKEN_END` refused the match outright. Measured: count 0,
    // unbounded, whole document — a pattern gap no scan window could reach.
    name: "sk-key-base64-pad",
    secret: `${PROBE_KEY}`,
    body: PROBE_KEY,
  },
  {
    name: "sk-key-base64-plus",
    secret: `${PROBE_KEY}`,
    body: PROBE_KEY,
  },
  {
    name: "sk-key-base64-slash",
    secret: `${PROBE_KEY}`,
    body: PROBE_KEY,
  },
  {
    name: "sk-key-json-quoted",
    secret: String.raw`{"key": "${PROBE_KEY}"}`,
    body: PROBE_KEY,
  },
  {
    name: "key-value",
    secret: "password=Sup3rSecretValue99",
    body: "Sup3rSecretValue99",
  },
  {
    // The JSON form, which the key/value rule missed outright: a `"` between the
    // keyword and the separator left `\s*[:=]` unsatisfiable, so the rule matched
    // NOTHING and the record shipped `{"password":"Sup3rSecretValue99"}` intact
    // with `redactions: 0`. This is the shape the `PATTERN GAP` gate raises, and
    // why it is a gate rather than a warning.
    name: "key-value-json",
    secret: String.raw`{"password":"Sup3rSecretValue99"}`,
    body: "Sup3rSecretValue99",
  },
  {
    name: "key-value-json-quoted-key",
    secret: String.raw`{"api_key" : "Sup3rSecretValue99"}`,
    body: "Sup3rSecretValue99",
  },
];

/**
 * Text that must keep matching NOTHING, at every pattern position. Each entry is
 * a shape a widened character class could plausibly have swallowed: the per-rule
 * token-end rewrite had to keep the base64 tail matchable for a PREFIX it owns
 * while still refusing `…<sha>==`; a wider key/value keyword would reach
 * `task-list`/`desk-top` through the `-`. A log that eats git SHAs, UUIDs and
 * ordinary hyphenated words is worse than one that leaks a key — the operator
 * stops trusting it.
 */
export const MUST_NOT_REDACT: { name: string; text: string }[] = [
  { name: "git-sha", text: "commit 0123456789abcdef0123456789abcdef01234567 built" },
  // A SHA with the very tail that used to defeat the shared `TOKEN_END`: the
  // hex body is 40 chars and matches no PREFIX, so `==` after it is still not a
  // credential — the end assertion has nothing to be wrong about here.
  {
    name: "git-sha-base64-tail",
    text: "commit 0123456789abcdef0123456789abcdef01234567== built",
  },
  {
    name: "git-sha-json",
    text: String.raw`{"commit":"0123456789abcdef0123456789abcdef01234567"}`,
  },
  { name: "uuid", text: "request 123e4567-e89b-12d3-a456-426614174000 accepted" },
  { name: "uuid-json", text: String.raw`{"id":"123e4567-e89b-12d3-a456-426614174000"}` },
  { name: "task-list", text: "the task-list panel renders three rows" },
  { name: "desk-top", text: "the desk-top widget sits on the desk-top bar" },
  {
    name: "base64-blob",
    text: "payload SGVsbG8gV29ybGQgZnJvbSB0aGUgZ3JvdXAxMjM0NTY3ODk= trailing",
  },
  { name: "hyphen-words", text: "a task-list of desk-top items, with an on-call rota" },
];

/** The fixture bound every clip assertion is run at. */
export const MAX = 600;

/** The lens's fixture: a 2 KB run with the secret AT ITS END, then a tail. */
export const tailOf = (secret: string, after: string) =>
  `${"f".repeat(2048)} ${secret}${after ? ` ${after}` : ""}`;

/** The mirror image: the secret at the START of the text, a long run after it. */
export const headOf = (secret: string, before: string) =>
  `${before ? `${before} ` : ""}${secret}${" g".repeat(1500)}`;

export const words = (n: number, tag: string) =>
  Array.from({ length: n }, (_, i) => `${tag}${i}`).join(" ");
