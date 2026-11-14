#!/usr/bin/env bun
/**
 * #2261 — the `PI_ENSEMBLE_LENS_LARGE_DIFF` switch.
 *
 * One switch governs two behaviours that used to be silent: the ceiling every
 * size-sensitive git read on the base+head path shares, and the bound on the diff
 * a lens prompt inlines. Three things an operator and a later edit both need are
 * asserted here and nowhere else:
 *
 *   - the `docs/configuration.md` row (a `HEADLESS_INPUTS` entry nobody can
 *     discover is a knob that does not exist — `test-headless-inputs.ts` checks the
 *     roster against the readers and never opens `docs/`);
 *   - the truth table on the exported reader (on for unset, `"1"`, `""` and
 *     `"false"`; off for the literal `"0"` alone), asserted on BOTH readers the
 *     switch feeds — the read ceiling and the prompt bound — because a truth table
 *     pinned on one reader and drifted on the other is half a switch;
 *   - the OFF arm's byte-identical behaviour on both: the 1 MiB read verbatim, and
 *     a lens prompt that inlines the whole diff with no inventory and no notice.
 *
 * The reader is read at CALL time, so every case pins the environment with
 * `withEnv`: a pin that leaked from another file in the same run, or an operator's
 * exported `=0`, would otherwise make the ON cases measure the wrong arm.
 *
 * The field shapes — the over-ceiling range that reads, the six bounded prompts,
 * the provider refusal that is not retried — are `test-review-diff-range.ts`,
 * `test-delta-diff.ts` and `test-lens-diff-large.ts`; this file pins the switch.
 */

import { readFileSync } from "node:fs";
import path from "node:path";
import { MAX_INLINE_DIFF_CHARS } from "../src/adversarial-diff-cap.ts";
import { boundLensPromptDiff } from "../src/lens-diff-bound.ts";
import { lensLargeDiffEnabled } from "../src/lens-large-diff-switch.ts";
import {
  DIFF_MAX_BUFFER,
  REVIEW_DIFF_READ_MAX_BYTES,
  diffReadMaxBytes,
} from "../src/review-diff.ts";
import { withEnv } from "./lib/env-scope.ts";
import { makeAssert } from "./lib/lean-engine-fixtures.ts";

const { assert, failures } = makeAssert();

const docs = (file: string): string =>
  readFileSync(path.resolve(import.meta.dirname, "..", "..", "docs", file), "utf8");

/** A diff past the prompt bound, with two whole file sections. */
/**
 * A two-file diff whose LARGE section comes first.
 *
 * Shaped this way so the bounded arm has a file to NAME as omitted, and so it
 * pins the shape this switch exists for: the walker admits whole sections while
 * the budget affords them and SKIPS what it cannot pay for, so an oversized
 * first section (a generated bundle, a lockfile, a vendored file — the common
 * case in the field) costs the reviewer nothing but its own body. A walker that
 * stopped at the first oversized section would hand back an empty block here.
 */
function oversizedDiff(): string {
  const body = Array.from(
    { length: 4_000 },
    (_u, i) => `export const line_${String(i)} = "padding to make this file genuinely large";`,
  ).join("\n");
  const small = Array.from({ length: 5 }, (_u, i) => `export const small_${String(i)} = 1;`).join(
    "\n",
  );
  return (
    `diff --git a/small.ts b/small.ts\nindex 3333333..4444444 100644\n--- /dev/null\n+++ b/small.ts\n@@ -0,0 +1,5 @@\n${small}\n` +
    `diff --git a/grown.ts b/grown.ts\nindex 1111111..2222222 100644\n--- /dev/null\n+++ b/grown.ts\n@@ -0,0 +1,4000 @@\n${body}\n`
  );
}

// ── (1) the docs row exists and is understandable from the docs alone ───────
{
  const doc = docs("configuration.md");
  assert(
    doc.includes("`PI_ENSEMBLE_LENS_LARGE_DIFF`"),
    "docs/configuration.md carries a row for PI_ENSEMBLE_LENS_LARGE_DIFF",
  );
  // The row must name BOTH behaviours the switch governs and the value each one
  // uses, so an operator who sets `=0` reads the consequence — a 1 MiB read that
  // fails unnamed, and prompts that inline the whole diff — from the row rather
  // than from the source.
  assert(
    doc.includes("REVIEW_DIFF_READ_MAX_BYTES"),
    "and that row names the shared read ceiling by its constant",
  );
  assert(
    doc.includes("DIFF_MAX_BUFFER"),
    "and names the pre-fix 1 MiB cap the off arm restores, by its constant",
  );
  assert(
    doc.includes("16 MiB"),
    "and states the ceiling's size, so the row is usable without opening the source",
  );
  assert(
    doc.includes("provider context-length") && doc.includes("exit 1"),
    "and names both symptoms the fix removes: the provider refusal and the bare exit code the operator used to read",
  );
  assert(
    doc.includes("Read at call time") || doc.includes("call time"),
    "and says the value is read at call time, so an operator knows a running cycle can flip it",
  );
  // A knob whose source files are not named cannot be traced when its behaviour
  // looks wrong; the row is the operator's only pointer.
  assert(
    doc.includes("lens-diff-bound.ts") && doc.includes("review-diff.ts"),
    "and points at the sources that implement it",
  );
}

// ── (2) the truth table, on both readers the switch feeds ───────────────────
// A case per arm: unset, "1", "" and "false" are ON; "0" is the only OFF value.
for (const [value, want] of [
  [undefined, true],
  ["1", true],
  ["", true],
  ["false", true],
  ["0", false],
] as const) {
  await withEnv({ PI_ENSEMBLE_LENS_LARGE_DIFF: value }, async () => {
    assert(
      lensLargeDiffEnabled() === want,
      `PI_ENSEMBLE_LENS_LARGE_DIFF=${JSON.stringify(value)} reads ${String(want)}`,
    );
    // The READ ceiling follows the same truth table. An operator who set `=0` and
    // got the bound but not the ceiling (or the reverse) has a switch that is two
    // switches.
    assert(
      diffReadMaxBytes() === (want ? REVIEW_DIFF_READ_MAX_BYTES : DIFF_MAX_BUFFER),
      `and at ${JSON.stringify(value)} the size-sensitive reads get ${want ? "the shared ceiling" : "the pre-fix 1 MiB cap"}`,
    );
    // The PROMPT bound likewise: off means the diff is handed back whole, with no
    // note and no inventory, at any size.
    const bound = boundLensPromptDiff({ diff: oversizedDiff(), context: "ctx" });
    assert(
      bound.mode === (want ? "bounded" : "whole") &&
        (want ? bound.diff.length < oversizedDiff().length : bound.diff === oversizedDiff()),
      `and at ${JSON.stringify(value)} the lens prompt is ${want ? "bounded to the files it affords" : "the whole diff, verbatim"}`,
    );
    assert(
      want || bound.note === undefined,
      `and with the switch off no truncation notice is printed at ${JSON.stringify(value)} — the prompt is the pre-#2261 one`,
    );
  });
}

// ── (3) call-time read: the SAME call site sees both arms ───────────────────
// A module-load read would let one file's pin disable the rule for the next, and
// would make an operator's exported `=0` unfixable from inside a cycle. Pinned by
// reading the same reader on both arms in one process, in both orders.
{
  for (const order of [
    ["0", undefined],
    [undefined, "0"],
  ] as const) {
    const seen: boolean[] = [];
    for (const value of order) {
      await withEnv({ PI_ENSEMBLE_LENS_LARGE_DIFF: value }, async () => {
        seen.push(lensLargeDiffEnabled());
      });
    }
    assert(
      seen[0] !== seen[1],
      `(3) reading the switch twice in one process, in order ${JSON.stringify(order)}, sees both arms (${String(seen[0])} then ${String(seen[1])}) — a load-time read would answer with whichever arm was seen first`,
    );
  }
}

// ── (4) the OFF arm's byte identity, stated against the ON arm ──────────────
// The range/delta ceiling's off arm — the 1 MiB failure verbatim — is proved on a
// real over-1-MiB synthetic range in `test-review-diff-range.ts` (which asserts the
// exact reason string `exceeded the limit DIFF_MAX_BUFFER (1048576 bytes)`) and in
// `test-delta-diff.ts` for the delta arm. What is proved here is the other half,
// the prompt: `lensPromptFor`'s fenced block is the whole diff when the switch is
// off, and bounded when it is not, for the SAME input.
{
  const big = oversizedDiff();
  assert(
    big.length > MAX_INLINE_DIFF_CHARS,
    `(4) precondition: the fixture diff is past the prompt bound (${String(big.length)} > ${String(MAX_INLINE_DIFF_CHARS)})`,
  );
  let on: ReturnType<typeof boundLensPromptDiff> | undefined;
  let off: ReturnType<typeof boundLensPromptDiff> | undefined;
  await withEnv({ PI_ENSEMBLE_LENS_LARGE_DIFF: undefined }, async () => {
    on = boundLensPromptDiff({ diff: big, context: "ctx" });
  });
  await withEnv({ PI_ENSEMBLE_LENS_LARGE_DIFF: "0" }, async () => {
    off = boundLensPromptDiff({ diff: big, context: "ctx" });
  });
  assert(on !== undefined && off !== undefined, "(4) both arms ran");
  assert(
    off?.diff === big && off?.note === undefined,
    '(4) "0" hands the prompt the WHOLE diff and no notice — byte-identical to the pre-#2261 prompt',
  );
  assert(
    (on?.diff.length ?? 0) < big.length && (on?.diff.length ?? 0) > 0,
    `(4) unset bounds the same diff to the files it affords (${String(on?.diff.length)} of ${String(big.length)} characters)`,
  );
  assert(
    (on?.diff ?? "").includes("small.ts") && !(on?.diff ?? "").includes("line_3999"),
    "(4) and it is the SMALL file that survives: whole sections, never one cut in half — and it survives DESPITE the oversized file coming first",
  );
  assert(
    (on?.diff.length ?? 0) <= MAX_INLINE_DIFF_CHARS,
    `(4) and never past the bound itself (${String(on?.diff.length)} <= ${String(MAX_INLINE_DIFF_CHARS)})`,
  );
  assert(
    (on?.note ?? "").includes("diff truncated") && (on?.note ?? "").includes("grown.ts"),
    "(4) and the bounded arm's notice names the omission and the file whose body was cut",
  );
  assert(
    off?.context === "ctx" && on?.context === "ctx",
    "(4) and neither arm touches the caller's context when there is no full-branch block to share the budget with",
  );
}

console.log(`\nswitch ${failures() === 0 ? "green" : "RED"} (${String(failures())} failing)`);
process.exit(failures());
