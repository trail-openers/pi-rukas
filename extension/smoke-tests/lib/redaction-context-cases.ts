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
    // A base64 TAIL: `=`, `+` and `/` are not in any prefix rule's body class, so the
    // old SHARED `TOKEN_END` refused the match outright. Measured: count 0,
    // unbounded, whole document — a pattern gap no scan window could reach.
    //
    // These three used to be byte-identical (`PROBE_KEY` alone, three times), so the
    // file claimed to test `+` and `/` while testing `=` three times. Each now really
    // ends in its own tail: three names for one tail left two of the three classes
    // unobserved, which is a gate never observed to fail.
    name: "sk-key-base64-pad",
    secret: `${PROBE_KEY}==`,
    body: `${PROBE_KEY}==`,
  },
  {
    name: "sk-key-base64-plus",
    secret: `${PROBE_KEY}+`,
    body: `${PROBE_KEY}+`,
  },
  {
    name: "sk-key-base64-slash",
    secret: `${PROBE_KEY}/seg`,
    body: `${PROBE_KEY}/seg`,
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
  // ---- one positive fixture per SECRET_PATTERNS arm.
  //
  // The cases above cover sk-, the Bearer rule, the URL rule and the key/value rule.
  // These cover the rest, and test-decision-secret-pattern-coverage.ts fails the gate
  // if any ARM of SECRET_PATTERNS matches none of them unbounded — the shape that let
  // a provider-alphabet gap (ghp_..._E, npm_..._0) sit in the set with every test
  // green. Each carries a base64url `_`/`-` tail where its provider emits one, since
  // that tail is exactly what a class narrowed below the provider's alphabet refuses.
  {
    name: "ghp-base64url",
    secret: "ghp_aB3dE5fG7hJ9kL1mN2pQ4rS6tU8vW0xY2zA4bC6d_E",
    body: "ghp_aB3dE5fG7hJ9kL1mN2pQ4rS6tU8vW0xY2zA4bC6d_E",
  },
  {
    name: "github-pat",
    secret: "github_pat_11AABBB0aB3dE5fG7hJ9kL_1mN2pQ4rS6tU8vW0xY2zA4bC6dE",
    body: "github_pat_11AABBB0aB3dE5fG7hJ9kL_1mN2pQ4rS6tU8vW0xY2zA4bC6dE",
  },
  {
    name: "xox-slack",
    // Deliberately NOT a well-formed bot token. A realistic `xoxb-<digits>-<digits>-…`
    // shape trips GitHub's push-protection secret scanner even though it is not a live
    // credential, and this file's whole purpose is to PLACE a credential where the
    // redactor must find it. The arm is keyed on `xox[baprs]-` plus ten body
    // characters, so an unmistakably synthetic tail still exercises the provider's
    // base64url alphabet (`_`) — the fixture tests the pattern, not the scanner.
    secret: "xoxb-placeholder-token-value_with_url",
    body: "placeholder-token-value_with_url",
  },
  {
    name: "glpat-gitlab",
    secret: "glpat-aB3dE5fG7hJ9kL1m_N2pQ",
    body: "glpat-aB3dE5fG7hJ9kL1m_N2pQ",
  },
  {
    name: "aiza-google",
    secret: "AIzaSy_aB3dE5fG7hJ9kL1mN2pQ4rS6tU8vW0xY2zA4bC",
    body: "AIzaSy_aB3dE5fG7hJ9kL1mN2pQ4rS6tU8vW0xY2zA4bC",
  },
  {
    name: "npm-base64url",
    secret: "npm_aB3dE5fG7hJ9kL1mN2pQ4rS6tU8v_0",
    body: "npm_aB3dE5fG7hJ9kL1mN2pQ4rS6tU8v_0",
  },
  {
    name: "akia-aws",
    secret: "AKIAIOSFODNN7EXAMPLE",
    body: "AKIAIOSFODNN7EXAMPLE",
  },
  {
    name: "akia-glued",
    // The fixed-length 16-char body plus the end assertion refused a key welded onto
    // the run after it; a permissive minimum redacts it. Its own case rather than a
    // fold into akia-aws, because the two fail for different reasons.
    secret: "AKIAIOSFODNN7EXAMPLEX",
    body: "AKIAIOSFODNN7EXAMPLEX",
  },
  {
    name: "bearer-padded-jwt",
    // A padded JWT: `=` terminates segment two, and the old body class stopped on it,
    // so [REDACTED]=.c2ln... shipped the signature.
    secret: "Bearer eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0=.c2lnbmF0dXJlYmFzZTY0",
    body: "eyJzdWIiOiIxMjM0NTY3ODkwIn0=.c2lnbmF0dXJlYmFzZTY0",
  },
  {
    name: "pem-private-key",
    // The WHOLE key, not its header (#1393 round 5, item 3). `body` used to be
    // "PRIVATE KEY" — the delimiter line every PEM on earth shares — so the assertion
    // passed while the base64 key body, which IS the secret, shipped verbatim. The
    // longest run here is what a real RSA block looks like, and it is the string that
    // must not survive.
    secret: `-----BEGIN RSA PRIVATE KEY-----\n${PEM_BODY}\n-----END RSA PRIVATE KEY-----`,
    body: PEM_BODY,
  },
  {
    name: "pem-private-key-clipped",
    // A clipped PEM — the scan window ended before the `-----END` delimiter. The lazy
    // body runs to `$` in that case, because a truncated PEM is still a leaked PEM.
    secret: `-----BEGIN OPENSSH PRIVATE KEY-----\n${PEM_BODY}`,
    body: PEM_BODY,
  },
  {
    name: "key-value-base64-pad",
    // The body class used to stop at the first `=`, so a base64 key whose padding (or
    // internal `=`) sits past the 12-character floor shipped whole — the same defect the
    // Bearer arm carried for the same reason (#1393 round 5, item 4). `=` is in the class
    // now. The tail is `…8vW0=Q4rS`: every 12-char window of it contains an `=`, so it
    // survives redaction ONLY when the class carries `=`, which is what makes this case
    // break-proof. The first draft of this fixture (`…U8vW0==`) was NOT: with `=` out of
    // the class the match stopped at the final `=` and the leaked tail was two characters,
    // shorter than the `leaksKey` window, so every 12-char window of the body was gone and
    // the case passed while shipping `client_[REDACTED]==`. A body that merely ENDS in `=`
    // can never catch that arm — the leak has to be ≥ 12 chars long.
    secret: "client_secret=aB3dE5fG7hJ9kL1mN2pQ4rS6tU8vW0=Q4rS",
    body: "aB3dE5fG7hJ9kL1mN2pQ4rS6tU8vW0=Q4rS",
  },
  {
    name: "key-value-base64-pad-exact",
    secret: "client_secret=aB3dE5fG7hJ9kL1mN2pQ4rS6tU8vW0=Q4rS",
    body: "aB3dE5fG7hJ9kL1mN2pQ4rS6tU8vW0=Q4rS",
  },
  {
    name: "key-value-base64-pad-double",
    secret: "api_key=QUJDREVGR0hJSktMTU5PUA==",
    body: "QUJDREVGR0hJSktMTU5PUA==",
  },
  {
    name: "url-credentials-slash-pass",
    secret: "https://user:hunt/er2Sup3rSecretValue@origin.internal/x",
    body: "hunt/er2Sup3rSecretValue",
  },
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

// The PEM-shaped groups live in `redaction-pem-cases.ts` (the split is the file-size cap,
// nothing else) and are re-exported here so the consumers keep one import site for the
// fixture set. `PEM_BODY` flows the other way — declared there, read below.
import { PEM_BODY } from "./redaction-pem-cases.ts";

export {
  BODY_CLASS_OVERREACH,
  MUST_NOT_REDACT,
  PADDING_LEAKS,
  PEM_AFTER_KEY,
  PEM_BODY,
  PEM_BODY_2,
  PEM_BEGIN,
  PEM_END,
  PEM_LONG_CLIPPED,
  PEM_PROSE_END,
  PEM_SEPARATORS,
  PEM_TAIL_PRESERVES,
} from "./redaction-pem-cases.ts";
