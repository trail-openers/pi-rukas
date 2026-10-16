#!/usr/bin/env bun
/**
 * A bounded redaction keeps every pattern its CONTEXT (#1393).
 *
 * `SECRET_PATTERNS` are keyed on shape WITH context: the URL rule needs the
 * `://` before it and the `@` after, the Bearer rule needs the literal
 * `Bearer `, the key-value rule needs the `password=` prefix. So a scan window
 * that merely starts where the kept window starts does not scan what the
 * whole-value pass would — the credential's body sits in the kept half and its
 * context in the dropped half, no pattern matches, and the count reports ZERO
 * while the plaintext ships to the model and into the log.
 *
 * The fixtures are the shapes the review lens reproduced, kept verbatim rather
 * than swapped for shapes that happen to pass:
 *
 *   - `https://user:hunter2Sup3rSecretValue@origin.internal/x` at the END of a
 *     2 KB run (a provider error tail, where the failure is the last thing said);
 *   - `Bearer <token>` at the same boundary;
 *   - the `sk-` key and the `password=` pair, which the earlier fixtures covered;
 *
 * each placed at the `from: "end"` boundary and at the `from: "start"` boundary.
 *
 * Two claims, kept separate because a fix can satisfy one and not the other: no
 * plaintext survives in the BACKEND PROMPT, and none in the LOG LINE. The count
 * is asserted separately in test-decision-log.ts, where the record is the unit
 * under test.
 *
 * FIXTURE VALIDITY. Every case is first redacted UNBOUNDED, and a case that
 * survives that is a `SECRET_PATTERNS` GAP, not a clip bug — the difference
 * matters, because "clip then redact" and "a shape nobody matches" look
 * identical in a leak report. A gap is reported under its own label rather than
 * silently dropped or quietly re-cut into a shape that passes.
 *
 * Offline: the backend is a closure and the log is a temp file.
 */

import { readFileSync } from "node:fs";
import path from "node:path";
import { redactBounded, redactSecrets } from "../src/decision-log.ts";
import { SEAMS, type SeamSpec } from "../src/decision-seam-registry.ts";
import { decide } from "../src/decision-seam.ts";
import {
  STUB_MODEL,
  leaksKey,
  llmReply,
  makeAssert,
  records,
  stubRegistry,
  tmpDir,
} from "./lib/decision-fixtures.ts";

const { assert, state } = makeAssert();

/**
 * The lens's shapes, verbatim. `body` is what must never survive: `Bearer `,
 * `https://user:` and `password=` are CONTEXT the caller legitimately ships, so
 * asking whether THOSE survived would test the wrong thing — the credential half
 * is what has to be gone.
 */
const CASES: { name: string; secret: string; body: string }[] = [
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
    name: "sk-key",
    secret: "sk-ant-api03-aB3dE5fG7hJ9kL1mN2pQ4rS6tU8vW0xY2zA4bC6d",
    body: "sk-ant-api03-aB3dE5fG7hJ9kL1mN2pQ4rS6tU8vW0xY2zA4bC6d",
  },
  {
    name: "key-value",
    secret: "password=Sup3rSecretValue99",
    body: "Sup3rSecretValue99",
  },
];

const MAX = 600;

/** The lens's fixture: a 2 KB run with the secret AT ITS END, then a tail. */
const tailOf = (secret: string, after: string) =>
  `${"f".repeat(2048)} ${secret}${after ? ` ${after}` : ""}`;
/** The mirror image: the secret at the START of the text, a long run after it. */
const headOf = (secret: string, before: string) =>
  `${before ? `${before} ` : ""}${secret}${" g".repeat(1500)}`;

const words = (n: number, tag: string) =>
  Array.from({ length: n }, (_, i) => `${tag}${i}`).join(" ");

// ------------------------------------------------- fixture validity, before anything

for (const { name, secret, body } of CASES) {
  const whole = redactSecrets(`prefix ${secret} suffix`);
  assert(
    whole.count >= 1 && !leaksKey(whole.text, body),
    `fixture ${name} is a real credential shape: the UNBOUNDED pass matches it (${whole.count})`,
  );
  if (whole.count === 0) {
    // Not a clip bug. Reported as its own failure so nobody reads it as one.
    console.error(
      `✗ PATTERN GAP (not a clip bug): SECRET_PATTERNS does not match '${name}' even unbounded — file a pattern issue, do not re-cut this fixture`,
    );
    state.exit = 1;
  }
}

// ------------------------------------------------------- unit: the bounded pass itself

for (const { name, secret, body } of CASES) {
  const atEnd = tailOf(secret, words(60, "t"));
  const rEnd = redactBounded(atEnd, MAX, "end");
  assert(
    !leaksKey(rEnd.text, body),
    `${name} at the END of a 2 KB run (from="end"): no 12-char window of the credential survives`,
  );
  assert(
    rEnd.text.length <= MAX,
    `${name} from="end": the shipped text is bounded by the field bound, not by the scan slack (${rEnd.text.length} <= ${MAX})`,
  );
  // The count describes the text that shipped, so a redaction inside the window
  // must appear in it — a scan that silently skipped the window is the same bug
  // seen from the other side.
  assert(
    rEnd.count >= 1,
    `${name} from="end": the bounded pass itself counted the redaction it made (${rEnd.count})`,
  );

  const atStart = headOf(secret, words(60, "t"));
  const rStart = redactBounded(atStart, MAX, "start");
  assert(
    !leaksKey(rStart.text, body),
    `${name} at the START of the text (from="start"), with a long run after: no 12-char window survives`,
  );
  assert(
    rStart.text.length <= MAX && rStart.count >= 1,
    `${name} from="start": bounded and counted (${rStart.text.length} chars, ${rStart.count} redaction(s))`,
  );

  // The pattern's CONTEXT alone sits on the dropped side — the exact position
  // the pre-fix cut amputated, and the case that separates a widened scan from a
  // lucky match. The fixture is checked against the unbounded pass first.
  const split =
    name === "url-credentials"
      ? `${"f".repeat(2048)} https://user:${secret.slice("https://user:".length)} ${words(60, "t")}`
      : name === "bearer"
        ? `${"f".repeat(2048)} Bear${secret.slice("Bear".length)} ${words(60, "t")}`
        : name === "key-value"
          ? `${"f".repeat(2048)} passwor${secret.slice("passwor".length)} ${words(60, "t")}`
          : `${"f".repeat(2048)} ${secret} ${words(60, "t")}`;
  const splitWhole = redactSecrets(split);
  assert(
    splitWhole.count >= 1 && !leaksKey(splitWhole.text, body),
    `${name} split-context fixture is a real credential shape (unbounded: ${splitWhole.count})`,
  );
  if (splitWhole.count > 0) {
    const rCtx = redactBounded(split, MAX, "end");
    assert(
      !leaksKey(rCtx.text, body),
      `${name} with its pattern CONTEXT across the cut: still no credential window in the kept text`,
    );
  }
}

// A window with nothing to redact ships exactly `max` — the slack is scanned,
// never shipped. Without this, "widen the scan" could be quietly "ship the slack".
{
  const plain = words(2000, "w");
  assert(
    redactBounded(plain, MAX, "end").text.length === MAX &&
      redactBounded(plain, MAX, "start").text.length === MAX,
    "a window with no secret ships exactly `max` characters, so the widening is scan-only",
  );
}

// --------------------------- glued credentials: no separator on EITHER side (#1393)

/**
 * The lens's second shape, and the one that was a `SECRET_PATTERNS` gap rather
 * than a clip bug: the credential welded directly onto a run of non-whitespace,
 * with more non-whitespace after it, so no token boundary exists anywhere near
 * it and the only whitespace in the document is megabytes away.
 *
 * The check that settles which kind it is runs FIRST — the same string through
 * `redactSecrets` with no bound at all. A shape that survives THAT is not
 * something any scan window could have caught, and labelling it a clip bug sends
 * the next reader to widen a window that was never the problem. Measured before
 * the fix: an unbounded pass returned `count: 0` for all four shapes here, and
 * the log recorded `redactions: 0` while shipping the key.
 *
 * Both directions, at both cut edges, at bounds small enough that the secret sits
 * deep inside the kept half and large enough that the scan reaches it: an
 * assertion at one bound would have passed while the other leaked.
 */
const GLUE = 2048;

for (const { name, secret, body } of CASES) {
  for (const max of [600, 1000, 4000]) {
    // Bounded so the credential sits INSIDE the window each `from` keeps. A
    // credential the clip discards cannot leak, and asserting a redaction for it
    // would test the cut rather than the pattern — which is the distinction this
    // whole file exists to keep. The filler on the NEAR side is what the clip
    // drops, so it stays short; the run on the FAR side is what pushes the
    // credential toward the middle and is what makes `from` matter.
    const pad = Math.max(8, Math.floor(max / 8));
    const near = "f".repeat(pad);
    const far = "t".repeat(4 * max);
    // Glued BEFORE, glued AFTER: `fff…fsk-ant-…ttt…`, the shape a provider emits
    // when it dumps a payload with no separators at all.
    const both = `${near}${secret}${far}`;
    // Glued before, whitespace after — the half the original repro used.
    const preOnly = `${near}${secret} ${far}`;
    // Glued after, whitespace before — the mirror, which fails on its own when
    // only the trailing boundary of a pattern is wrong.
    const postOnly = `${near} ${secret}${far}`;
    // The same three with the credential toward the TAIL, so `from: "end"` keeps
    // it: the leading run is the long one and the short run trails. A glued
    // prefix is glued on BOTH sides by construction, so `postOnly` is the same
    // string as `both` for any prefix rule whose token begins at the prefix — it
    // is kept because a rule that ends its own token (`Bearer `, the PEM arm)
    // differs there, and the two must not be collapsed into one fixture.
    const bothEnd = `${"f".repeat(4 * max)}${secret}${near}`;
    // Only a rule whose keyword may sit mid-token — a key/value pair pasted into
    // a URL path or a JSON blob — has a "whitespace before, glued after" shape
    // distinct from "glued both sides"; for a prefix rule the two coincide, and
    // counting the duplicate would report four fixtures where there are three.
    const postEnd = `${"f".repeat(4 * max)}${secret} ${near}`;

    // The key/value rule is the one shape whose LEFT context the pattern itself
    // does not constrain: `password=` is the credential's own context, and a
    // keyword welded onto a run of filler (`fffpassword=`) is a substring of an
    // identifier, not a credential. `\b` refusing it is the shape-with-context
    // rule working — the same judgement that keeps a git SHA out of the log — so
    // the glued-before half is a pattern gap that is CORRECT here, and asserting
    // it would demand the pattern eat identifiers. The mirror image (whitespace
    // before the keyword, filler after the value) is the one it must match, does
    // match, and is asserted instead. For a prefix rule the two coincide, so its
    // glued-before shapes stand and the duplicate is not counted twice.
    const shapes: [string, string][] =
      name === "key-value"
        ? [
            ["glued after", postOnly],
            ["glued after, at the tail", `${"f".repeat(4 * max)} ${secret}${near}`],
          ]
        : [
            ["glued both sides", both],
            ["glued before", preOnly],
            ["glued after", postOnly],
            ["glued both sides at the tail", bothEnd],
          ];

    for (const [shape, text] of shapes) {
      const unb = redactSecrets(text);
      if (unb.count === 0) {
        console.error(
          `\u2717 PATTERN GAP (not a clip bug): SECRET_PATTERNS does not match '${name}' ${shape} even unbounded — file a pattern issue, do not re-cut this fixture`,
        );
        state.exit = 1;
        continue;
      }
      for (const from of ["start", "end"] as const) {
        const r = redactBounded(text, max, from);
        // The claim is that no credential window SHIPS. Whether the scan also
        // COUNTED it is asserted where the count is the unit under test
        // (test-decision-log.ts) and above, in the unbounded pass: a bounded scan
        // that redacts a secret its kept half then drops has done its job, and
        // demanding a count for a replacement the clip discarded would make the
        // bound itself a failure.
        assert(
          !leaksKey(r.text, body),
          `${name} ${shape} (from="${from}", max ${max}): no 12-char window of the credential survives`,
        );
        assert(
          r.text.length <= max,
          `${name} ${shape} (from="${from}", max ${max}): still bounded by the field bound (${r.text.length})`,
        );
        // And when the credential IS in the kept half, the scan that produced that
        // half must have seen it — the count describing the text that shipped.
        assert(
          !r.text.includes(body.slice(0, 6)) || r.count >= 1,
          `${name} ${shape} (from="${from}", max ${max}): a credential still in the kept half was counted (${r.count})`,
        );
      }
    }
  }
}

// The lens's exact repro, verbatim: a 2 KB run, the credential welded to its
// end, and a whitespace tail — reported as `count: 0` with the key intact.
for (const { name, secret, body } of CASES) {
  if (name === "key-value") continue; // see the glued-before note above
  for (const max of [600, 1000, 4000]) {
    for (const k of [0, 40, 2000]) {
      const text = `${"f".repeat(2048)}${secret}${" ".repeat(k)}${"t".repeat(4 * max)}`;
      const r = redactBounded(text, max, "start");
      assert(
        !leaksKey(r.text, body),
        `${name} lens repro @ max ${max}, ${k}-char tail (from="start"): no credential window in the kept half`,
      );
    }
  }
}

// A pathological run: no whitespace at all, so the walk can only stop at its cap.
{
  const blob = `https://user:hunter2Sup3rSecretValue@origin.internal/${"z".repeat(400_000)}`;
  const t0 = Date.now();
  const r = redactBounded(blob, MAX, "end");
  const ms = Date.now() - t0;
  // What is at the kept END of this text is 400 KB of filler, so shipping it is
  // correct; the question is whether the scan stayed bounded and whether anything
  // credential-shaped came out. A `+ shrunk` term here would have dragged the
  // whole credential into the output to "compensate" for a redaction the kept
  // window never contained.
  assert(
    !leaksKey(r.text, "hunter2Sup3rSecretValue") && !leaksKey(r.text, "://user:"),
    "a 400 KB whitespace-free run keeps no credential-shaped span at the cut",
  );
  assert(
    r.text.length <= MAX && ms < 500,
    `...and the bounded pass stays inside the bound in ${ms}ms rather than scanning the document`,
  );
  // The same credential shape, one token away from the kept edge, IS found at
  // the `from: "start"` boundary — proof the scan reaches it rather than the
  // filler happening to be clean.
  const atHead = redactBounded(blob, MAX, "start");
  assert(
    atHead.count >= 1 && !leaksKey(atHead.text, "hunter2Sup3rSecretValue"),
    `the same credential at the from="start" edge is redacted and counted (${atHead.count})`,
  );
}

// ------------------------------------------------- end to end: backend prompt and log

/**
 * A tests-only seam per clip direction, at a realistic bound: `lastOutput` keeps
 * the tail (a provider's failure is its last words), `openPoint` the head.
 */
const tailSeam = "fixture-clip-context-end";
const headSeam = "fixture-clip-context-start";
const fixture = (id: string, fields: SeamSpec["fields"]): SeamSpec => ({
  id,
  kind: "choice",
  instructions: "Is the thing ok?",
  labels: { ok: "fine", flag: "needs a human" },
  ruleDefault: "flag",
  passing: ["ok"],
  composition: "advisory",
  defaultMode: "shadow",
  evidence: "none",
  owner: "test-decision-shadow-redaction-context.ts",
  timeoutMs: 2000,
  tokenBudget: 8000,
  fields,
});
(SEAMS as Record<string, SeamSpec>)[tailSeam] = fixture(tailSeam, {
  lastOutput: { max: MAX, from: "end" },
});
(SEAMS as Record<string, SeamSpec>)[headSeam] = fixture(headSeam, { openPoint: { max: MAX } });

for (const { name, secret, body } of CASES) {
  const root = tmpDir(`clip-${name}`);
  const prompts: string[] = [];
  const { registry } = stubRegistry({
    llm: (ctx) => {
      prompts.push(`${ctx.systemPrompt ?? ""}${String(ctx.messages[0]?.content ?? "")}`);
      return llmReply(JSON.stringify({ label: "ok", justification: "stub" }));
    },
  });
  await decide(
    tailSeam as never,
    { state: { lastOutput: tailOf(secret, words(60, "t")) }, question: "q", rule: "ok" },
    { repoRoot: root, modelRegistry: registry, model: STUB_MODEL },
  );
  await decide(
    headSeam as never,
    { state: { openPoint: headOf(secret, words(60, "t")) }, question: "q", rule: "ok" },
    { repoRoot: root, modelRegistry: registry, model: STUB_MODEL },
  );

  const raw = readFileSync(path.join(root, ".pi", "decisions.jsonl"), "utf8");
  assert(
    prompts.length === 2 && prompts.every((p) => !leaksKey(p, body)),
    `${name}: no 12-char window of the credential reaches the BACKEND PROMPT (${prompts.length} prompt(s))`,
  );
  assert(!leaksKey(raw, body), `${name}: no 12-char window of the credential reaches the LOG LINE`);
  const recs = records(path.join(root, ".pi", "decisions.jsonl"));
  assert(
    recs.length === 2 && recs.every((r) => Number(r.redactions) >= 1),
    `${name}: each shipped record counts the redaction its own text carries (${recs.map((r) => r.redactions).join(", ")})`,
  );
}

console.log(`\nexit ${state.exit}`);
process.exit(state.exit);
