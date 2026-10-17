/**
 * The PEM-shaped half of the bounded-redaction fixtures, split out of
 * `redaction-context-cases.ts` to keep each file under the 500-line cap. Same doctrine as
 * the file it came from: the exact-string assertions for a clipped or separator-mangled
 * private key — what must never survive, and which log lines around it must.
 *
 * Split along the fixture group rather than mid-case, so a case and its doc comment never
 * land in different files. `PEM_BODY` is declared here because both files read it, and the
 * context file imports it back, which keeps the dependency one-directional.
 */

/**
 * A base64 run shaped like a PEM key body. Used as the `body` of the PEM cases so the
 * assertion asks about the KEY and not about its header (#1393 round 5, item 3).
 * Declared before `CASES` because the cases read it in their initialiser.
 */
const PEM_BODY =
  "MIIEowIBAAKCAQEA" +
  "aB3dE5fG7hJ9kL1mN2pQ4rS6tU8vW0xY2zA4bC6dE7fG8hJ9kL0mN1pQ2rS3tU4v" +
  "W5xY6zA7bC8dE9fG0hJ1kL2mN3pQ4rS5tU6vW7xY8zA9bC0dE1fG2hJ3kL4mN5pQ6" +
  "rS7tU8vW9xY0zA1bC2dE3fG4hJ5kL6mN7pQ8rS9tU0vW1xY2zA3bC4dE5fG6hJ7kL8" +
  "mN9pQ0rS1tU2vW3xY4zA5bC6dE7fG8hJ9kL0mN1pQ2rS3tU4vW5xY6zA7bC8dE9fG0";

/**
 * The second body line of the separator cases. Two distinct lines, because the leak
 * `leaksKey` must catch is the WHOLE body: a fixture with one line cannot tell a redaction
 * that got the header and its first line from one that got the key.
 */
const PEM_BODY_2 =
  "Wm9vWXhBY0RlRmVnaGlqa2xtbm9wcXJzdHV2d3h5ejAxMjM0NTY3ODlA" +
  "QmZDeERlRmdIaUprTG1OcFBxcnN0VXZ3eFl6MDEyMzQ1Njc4OTBCQ2Q=";

const PEM_BEGIN = "-----BEGIN RSA PRIVATE KEY-----";
const PEM_END = "-----END RSA PRIVATE KEY-----";

/**
 * Exact-string assertions for the CLIPPED-PEM over-redaction (#1393 round 5, item 3
 * follow-up). The old body was `[\s\S]*?(?:-----END|$)`: with no END line the lazy span
 * ran to end-of-string and erased every log line after the header — a 1950-char error
 * tail came back as 38 chars, with the request id, the git SHA and the CI URL gone.
 * The body is a base64 class now, so prose stops it. These assert BOTH sides: the key
 * body is gone AND the tail survives, which is the half the old fixture could not see
 * (a body that consumes the tail also satisfies "the body is gone").
 *
 * The lines asserted are the ones whose first character is outside the class. The body
 * is LINE-ORIENTED — base64 runs whole-line before each newline, plus one trailing
 * base64-only line — so the most a clipped key can take past the last base64 line is a
 * single all-base64 token. Prose never looks like that: `:`, `.`, `-` and `,` all stop it
 * outright, which is why `request-id:` and the URL survive while the key body does not.
 */
export const PEM_TAIL_PRESERVES: {
  name: string;
  text: string;
  mustNotContain: string[];
  mustContain: string[];
}[] = [
  {
    name: "pem-clipped-error-tail-survives",
    text: `-----BEGIN RSA PRIVATE KEY-----\n${PEM_BODY}\n${PEM_BODY}\n${PEM_BODY}\nFATAL request-id: 7f3c-91ab exit=1 https://ci.example/run/42`,
    mustNotContain: [PEM_BODY.slice(0, 40)],
    mustContain: ["request-id: 7f3c-91ab", "https://ci.example/run/42", "exit=1"],
  },
];

/**
 * The separator forms the PEM arm must tolerate (#1393 round 6). The arm carried
 * `\r?\n` as its ONLY line separator, so every form below failed to match past the header:
 * `redactSecrets` reported `redactions: 1` — the `-----BEGIN` line gone — and shipped both
 * base64 lines whole. Each case therefore asserts on BOTH lines through `leaksKey`, which
 * is what distinguishes "the header matched" from "the key was redacted".
 *
 * Not in `CASES`: that list wraps each secret in kilobytes of filler and drives it through
 * the clip sweep, which is the wrong axis here — these leak identically bounded and
 * unbounded, at every window, because no pattern matches the body at all. The claim under
 * test is the arm's SEPARATOR, so the fixture is the bare key in each of the six shapes a
 * key is actually written in.
 */
export const PEM_SEPARATORS: { name: string; text: string; bodies: string[] }[] = [
  {
    name: "pem-trailing-space",
    text: `${PEM_BEGIN}\n${PEM_BODY} \n${PEM_BODY_2} \n${PEM_END}`,
    bodies: [PEM_BODY, PEM_BODY_2],
  },
  {
    name: "pem-trailing-tab",
    text: `${PEM_BEGIN}\n${PEM_BODY}\t\n${PEM_BODY_2}\t`,
    bodies: [PEM_BODY, PEM_BODY_2],
  },
  {
    // The separator a base64 blob actually carries when it passes through a shell variable,
    // a `tr` invocation, or a copy out of an editor's single-line view: TABS, and no newline
    // at all. Every other shape in this list keeps `\n` somewhere, so all of them stayed
    // green on the `\r?\n`-only arm while this one shipped both body lines whole at
    // `redactions: 1` — unbounded, `from: "start"` and `from: "end"` alike. It is the shape
    // the `\t` branch of `SEP` exists for, and the reason the list carries it separately from
    // `pem-trailing-tab` above: there the tab sits BEFORE the newline, so the newline branch
    // still crosses the line and the case passes without the fix.
    name: "pem-tab-separated",
    text: `${PEM_BEGIN}\t${PEM_BODY}\t${PEM_BODY_2}\t${PEM_END}`,
    bodies: [PEM_BODY, PEM_BODY_2],
  },
  {
    name: "pem-bare-cr",
    text: `${PEM_BEGIN}\r${PEM_BODY}\r${PEM_BODY_2}\r${PEM_END}`,
    bodies: [PEM_BODY, PEM_BODY_2],
  },
  {
    name: "pem-crlf",
    text: `${PEM_BEGIN}\r\n${PEM_BODY}\r\n${PEM_BODY_2}\r\n${PEM_END}`,
    bodies: [PEM_BODY, PEM_BODY_2],
  },
  {
    // The YAML block-scalar / pasted-into-a-comment shape: every line indented.
    name: "pem-indented",
    text: `${PEM_BEGIN}\n    ${PEM_BODY}\n    ${PEM_BODY_2}\n    ${PEM_END}`,
    bodies: [PEM_BODY, PEM_BODY_2],
  },
  {
    // A key that was `JSON.stringify`-ed into a log field: the line breaks in the stored
    // string are a literal backslash then `n` — TWO characters — and `\r?\n` is neither.
    name: "pem-json-escaped",
    text: `{"key":"${PEM_BEGIN}\\n${PEM_BODY}\\n${PEM_BODY_2}\\n${PEM_END}"}`,
    bodies: [PEM_BODY, PEM_BODY_2],
  },
];

/**
 * What must survive the span AFTER a key, and what must not (#1393 round 6). The arm's body
 * reaches the first character its base64 class cannot hold, so on a clipped key it used to
 * take the newline ending the last base64 line AND the first token of the line after it —
 * removing the `Bearer ` / `://` context the prefix rules need, which then matched nothing
 * and shipped the credential sitting right behind the key. The arm is LAST in
 * `SECRET_PATTERNS` for exactly this. `armOnlyMustNotContain` asserts it BEFORE the other rules
 * run, so nothing downstream can mask the arm's own over-reach — which is the property that
 * makes it break-proof. Measured by splicing HEAD's arm and HEAD's ordering back in: the bearer
 * probe leaks `c2lnbmF0dXJl` under HEAD and is redacted under the shipped arm, so that case
 * fails RED on the pre-fix shape. `pem-then-url-credentials` is the mirror image that HEAD
 * already handled (its `https` token is not base64, so HEAD's `*` stopped before it): the
 * assertion holds, and it is kept because it is the case the ordering exists to protect.
 */
export const PEM_AFTER_KEY: {
  name: string;
  text: string;
  mustNotContain: string[];
  armOnlyMustNotContain?: string[];
}[] = [
  {
    name: "pem-then-bearer",
    text: `${PEM_BEGIN}\n${PEM_BODY}\n${PEM_BODY_2}\nBearer eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxIn0.c2lnbmF0dXJl`,
    mustNotContain: ["c2lnbmF0dXJl", PEM_BODY.slice(0, 40)],
    // Measured against HEAD, where the arm sat FIRST in the set: it ate the `\nBearer ` and
    // left the prefix rules nothing to match, so the JWT signature shipped. Asserted on the
    // arm's own output, because through the full redactor the later rules mask it — verified
    // RED with HEAD's arm spliced back in ahead of the prefix rules (see the file header).
    armOnlyMustNotContain: ["c2lnbmF0dXJl"],
  },
  {
    name: "pem-then-url-credentials",
    text: `${PEM_BEGIN}\n${PEM_BODY}\n${PEM_BODY_2}\nhttps://user:Hunt2rSecret@db.internal/x`,
    mustNotContain: ["Hunt2rSecret", PEM_BODY.slice(0, 40)],
    armOnlyMustNotContain: ["Hunt2rSecret"],
  },
];

/**
 * Prose that QUOTES an END delimiter, and the line a clipped key is followed by. Both rest on
 * the arm's separator and on where the arm sits in the set.
 *
 * `pem-header-then-prose-end` is a REGRESSION GUARD for the same reason. Both prose cases are
 * guards, not break-proof probes: measured with HEAD's arm spliced back in as the LAST rule,
 * each produced byte-identical output to the shipped arm, because the body class already
 * carried no `-` so the arm never reached a delimiter on its own line. They earn their place by
 * being the assertions a future widening of the body class would break.
 */
export const PEM_PROSE_END: { name: string; text: string; mustContain: string }[] = [
  {
    name: "pem-end-in-prose",
    text: `FATAL failed to parse ${PEM_END}`,
    mustContain: "FATAL failed to parse",
  },
];

/**
 * A key LONGER than the scan window. `redactBounded(text, 2000, "end")` opens the window
 * thousands of characters INTO the base64, so the `-----BEGIN` anchor the arm needs is
 * behind the cut and `widenPastCut` — which walks to a whitespace token boundary and caps at
 * `SCAN_CAP` — stops inside the body, which is one unbroken token. The result was `count: 0`
 * and the whole visible body shipped. The scan now backs up to a `-----BEGIN` within
 * `PEM_HEADER_REACH`. Asserted at the window the repro used.
 */
export const PEM_LONG_CLIPPED: {
  name: string;
  text: string;
  body: string;
  max: number;
  /** Present on the sweep case: assert every window from `sweepFrom` to `sweepTo`. */
  sweepFrom?: number;
  sweepTo?: number;
  sweepStep?: number;
}[] = [
  {
    name: "pem-longer-than-window",
    text: `${PEM_BEGIN}\n${PEM_BODY.repeat(14)}`,
    body: PEM_BODY.repeat(14),
    max: 2000,
  },
  {
    // A key whose body is LONGER than `PEM_HEADER_REACH`, asserted at the window the repro used.
    //
    // 145 lines of 186 base64 characters puts the header 27 030 characters behind a 600-char
    // window — far past the 16 384 reach — so the backup is declined and no arm anchors: the scan
    // opens inside the body, where nothing matches, and only the fail-closed net stands between
    // the clip and the key. Asserted over a SWEEP rather than one window, because the leak depends
    // on where the cut falls inside the body and a single `max` picks one geometry and stays green
    // while its neighbours leak.
    //
    // DEFERRED, and stated here so the next round does not rediscover it: the FINAL line of this
    // shape is 40 characters, under the net's 64 floor, and a 40-character line of base64 is
    // character-for-character identical to a 40-character word — so no rule over the window's own
    // contents can tell them apart, and every such rule tried this round ate the prose line that
    // `test-decision-redaction-failclosed-window.ts` requires to survive. The measurement that
    // would separate them has to come from outside the window, which is the open design question
    // for #1439 rather than a fix to bolt on here. This case asserts the body lines, which the
    // net does take.
    name: "pem-past-reach-sweep",
    text: `${PEM_BEGIN}\n${Array.from({ length: 145 }, () => PEM_BODY_2.padEnd(186, "Q")).join("\n")}`,
    body: PEM_BODY_2.padEnd(186, "Q"),
    max: 150,
    sweepFrom: 150,
    sweepTo: 4000,
    sweepStep: 50,
  },
];

/**
 * Exact-string assertions for the base64-`=` arm of the key/value body class
 * (#1393 round 5, item 4). These are NOT in `CASES`: the looped fixtures wrap the
 * secret in kilobytes of filler and assert through `leaksKey`, whose 12-character
 * window is blind to a leak tail shorter than that. The adversarial review proved the
 * `=` had never been in the class while every looped assertion stayed green, because
 * the `key-value-base64-pad` leak tail is 5 characters. Here the leaked substring is
 * compared literally, so the class has to carry `=` for these to pass.
 */
export const PADDING_LEAKS: {
  name: string;
  text: string;
  mustNotContain: string[];
}[] = [
  {
    name: "key-value-base64-pad-tail",
    text: "client_secret=aB3dE5fG7hJ9kL1mN2pQ4rS6tU8vW0=Q4rS",
    mustNotContain: ["=Q4rS"],
  },
  {
    name: "key-value-base64-pad-double",
    text: "api_key=QUJDREVGR0hJSktMTU5PUA==",
    mustNotContain: ["=="],
  },
];

/**
 * Overreach probes for the key/value BODY CLASS: shapes that name a credential
 * keyword but carry something that is not a credential after it. Each must leave
 * `redactSecrets` with `count: 0`.
 *
 * `token={"a":1}` is the reason the body class is a CREDENTIAL alphabet and not
 * `\S`: a JSON object literal welded to a keyword. With a stray `{` admitted into
 * the class the arm matches the whole object and reports a redaction that redacted
 * nothing secret (#1393).
 *
 * The `{`'s effect is gated by the class's own `{12,4096}`: after the `=` the regex
 * must still find 12 body characters, so a SHORT object reports zero either way and
 * cannot discriminate. `json-object-braced-12` is the minimal shape that can — the
 * braces themselves only satisfy the run while `{` sits in the class.
 */
export const BODY_CLASS_OVERREACH: { name: string; text: string }[] = [
  { name: "json-object-literal", text: 'token={"a":1}' },
  { name: "json-object-braced-12", text: "token={abcdefghijkl}" },
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
  // Prose that CARRIES a provider prefix as a word rather than as a key. Each names
  // the arm it sits next to, and each is refused because what follows the prefix is a
  // separator or a short tail rather than a credential body — the judgement the widened
  // base64url classes must not disturb.
  { name: "prose-ghp-like", text: "a ghp-like-word and a ghp_ prefix in prose" },
  { name: "prose-npm-install", text: "npm_install runs before npm_test in CI" },
  { name: "prose-xox", text: "the xox- prefixed labels sort oddly" },
  { name: "prose-glpat", text: "a glpat- placeholder stands in for the real key" },
  // An `@` with no `:` before it, and an unqualified clone URL: the URL rule's `:`
  // separates a password from a username, and neither of these has one.
  { name: "url-at-in-path", text: "see https://example.com/issue#comment@1234 for that" },
  { name: "url-ssh-git", text: "clone ssh://git@github.com/trail-openers/pi-rukas" },
  { name: "mailto", text: "write to dev@example.com about it" },
  // Identifiers that merely CONTAIN a key/value keyword: refused because what follows
  // the keyword is `_`, not `:` or `=`. These are the zero side of dropping the word
  // boundary from the key/value rule (#1393 item 9) — the assertion never refused them.
  { name: "kv-identifier", text: "aws_secret_access_key=abcdef1234567890 is the field name" },
  { name: "kv-token-count", text: "token_count: 1234567890123 and tokenizer=abcdefghijklmn" },
];
