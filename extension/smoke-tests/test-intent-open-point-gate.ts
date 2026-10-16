#!/usr/bin/env bun
/**
 * #1187 — the topic-neutral open-point gate, end to end at the verdict.
 *
 * Covers: any unresolved CRITICAL point parks (no classifier); [RESOLVED] answers it
 * and is recorded as an assumption whose text is the flattened point; an existing park
 * keeps its reason and gains the points; a blank body parks with its own reason that the
 * #397 override cannot lift; a retired artifact is refused and never yields proceed; and
 * the park/handoff text carries the escape.
 */

import { OPEN_POINT_CHAR_CAP, OPEN_POINT_ENTRY_CAP } from "../src/open-points-reader.ts";
import { openPointsSection } from "../src/plan-gap-disclosure.ts";
import { GAP_RESOLUTION_PLACEHOLDER } from "../src/plan-gap-parse.ts";
import type { PlanGap } from "../src/plan-types.ts";
import {
  SPEC_ARTIFACT_GATE_VERSION,
  parseNormalisedSpecArtifact,
  resolveIntentVerdict,
} from "../src/work-driver-intent-artifact.ts";
import { finaliseSpecVerdict } from "../src/work-driver-intent-finalise.ts";
import {
  type NormalisedSpec,
  PARK_REASONS,
  explainPark,
  parkAction,
} from "../src/work-driver-intent.ts";

let exit = 0;
function assert(cond: boolean, msg: string) {
  if (cond) console.log(`✓ ${msg}`);
  else {
    console.error(`✗ ${msg}`);
    exit = 1;
  }
}

/**
 * Capture `trace` output while running `fn` (trace writes `[pi-rukas] …` to stderr).
 *
 * The gate's diagnostics are load-bearing here — "the artifact was refused" and "there
 * was no artifact" look identical downstream — so these assertions read the actual stderr
 * rather than trusting a comment. `trace()` consults the env var per call, so toggling it
 * around `fn` is enough; no import-order dance (the `bun:test` mock in
 * test-adversarial-reread-failure.ts exists for a different harness).
 */
async function withTrace<T>(fn: () => Promise<T> | T): Promise<{ result: T; traced: string }> {
  const prior = process.env.PI_ENSEMBLE_DEBUG;
  process.env.PI_ENSEMBLE_DEBUG = "1";
  const write = process.stderr.write.bind(process.stderr);
  let captured = "";
  process.stderr.write = ((chunk: string | Uint8Array) => {
    captured += chunk.toString();
    return true;
  }) as typeof process.stderr.write;
  try {
    const result = await fn();
    return { result, traced: captured };
  } finally {
    process.stderr.write = write;
    // Assign, do not `delete`: biome's noDelete refuses the operator and assigning
    // undefined makes the `=== "1"` comparison false, which is the state we restore to.
    process.env.PI_ENSEMBLE_DEBUG = prior;
  }
}
const HEADING = "## Open points (unresolved at the gap-gate cap)";
const body = (...lines: string[]) => [HEADING, "", ...lines, ""].join("\n");

/** What `persistSpecArtifact` writes, so artifact assertions read the real bytes. */
const artifactJson = (spec: NormalisedSpec): string =>
  JSON.stringify({ ...spec, gateVersion: SPEC_ARTIFACT_GATE_VERSION });

const complete = (over: Partial<NormalisedSpec> = {}): NormalisedSpec => ({
  intent: "Keep the retry timeout configurable.",
  deliverables: [
    { id: "d1", description: "make the timeout configurable", paths: ["src/retry.ts"] },
  ],
  acceptanceCriteria: ["the timeout is read from configuration"],
  outOfScope: [],
  assumptions: [],
  openQuestions: [],
  evidence: [{ claim: "the timeout is hard-coded", source: "retry.ts:1", verdict: "confirmed" }],
  verdict: "proceed",
  rationale: "actionable",
  ...over,
});

// Topic-neutral: a retry timeout is as much a park as an authorization point.
{
  const gated = finaliseSpecVerdict(
    complete(),
    body("- [CRITICAL] Which timeout wins when both are set"),
  );
  assert(
    gated.verdict === "park" && gated.parkReason === "unresolved-critical-open-point",
    "a topic-neutral CRITICAL point (a retry timeout) parks as unresolved-critical-open-point",
  );
  assert(
    gated.parkReasonSource === "default" &&
      JSON.stringify(gated.openPoints) ===
        JSON.stringify(["[CRITICAL] Which timeout wins when both are set"]),
    "the park records each point as flattened text, with default provenance",
  );
}

// [RESOLVED] answers the point: proceed, recorded as an assumption whose text is the flattened point.
{
  const answered = finaliseSpecVerdict(
    complete(),
    body("- [CRITICAL][RESOLVED] Which timeout wins \u2014 the shorter one"),
  );
  assert(answered.verdict === "proceed", "a [RESOLVED] CRITICAL point yields proceed");
  assert(
    answered.assumptions.some(
      (a) =>
        a.text ===
        "resolved open point: [CRITICAL][RESOLVED] Which timeout wins \u2014 the shorter one",
    ),
    "a resolved point is recorded as an assumption: the flattened text, prefixed so the meaning survives rendering",
  );
  assert(answered.openPoints === undefined, "a resolved point is not a blocking open point");
}

// An emphasised [RESOLVED] does not count: the point still parks (the escape documented in parkAction).
{
  const emphasised = finaliseSpecVerdict(
    complete(),
    body("- [CRITICAL] **[RESOLVED]** Which timeout wins"),
  );
  assert(
    emphasised.verdict === "park",
    "an emphasised **[RESOLVED]** does not resolve; the point parks",
  );
  assert(
    /mark it \[RESOLVED\] right after its severity tag, unemphasised/.test(
      parkAction("unresolved-critical-open-point", 42),
    ),
    "parkAction documents the unemphasised, immediately-after-the-tag rule",
  );
}

// An existing park keeps its reason; the points are appended and provenance becomes default.
{
  const parked = finaliseSpecVerdict(
    complete({ verdict: "park", parkReason: "too-large", parkReasonSource: "parsed" }),
    body("- [CRITICAL] Which timeout wins"),
  );
  assert(
    parked.verdict === "park" && parked.parkReason === "too-large",
    "an existing park keeps its reason",
  );
  assert(
    parked.parkReasonSource === "default" && parked.openPoints?.length === 1,
    "an existing park gains the points and its provenance becomes default",
  );
}

// The gap gate's OWN section, once every point is answered, must proceed (#1187 fix round 1).
// The writer put a non-bullet intro sentence under the heading and the reader parked on it,
// so a gap-gate-filed issue could never be cleared by [RESOLVED].
{
  const gaps: PlanGap[] = [
    {
      severity: "CRITICAL",
      description: "Which timeout wins when both are set",
      resolution: "the shorter one",
    } as PlanGap,
    {
      severity: "CRITICAL",
      description: "Who may change the retry timeout",
      resolution: GAP_RESOLUTION_PLACEHOLDER,
    } as PlanGap,
  ];
  const filed = openPointsSection(gaps);
  assert(
    finaliseSpecVerdict(complete(), filed).verdict === "park",
    "the gap gate's own section parks while its points are open",
  );
  const answered = filed.replace(/^- \[CRITICAL\] /gm, "- [CRITICAL][RESOLVED] ");
  const cleared = finaliseSpecVerdict(complete(), answered);
  assert(
    cleared.verdict === "proceed" && cleared.openPoints === undefined,
    "marking every point of the gap gate's rendered section [RESOLVED] clears the park (the intro no longer parks)",
  );
  assert(
    cleared.assumptions.length === 2 &&
      cleared.assumptions.every((a) => a.text.startsWith("resolved open point: ")),
    "both answered points reach the PR body as prefixed assumptions",
  );
}

// A blank or whitespace-only body parks with its own reason (not underspecified), and #397 cannot lift it.
for (const blank of ["", "   \n\t ", "\u200B\u200B"]) {
  const gated = finaliseSpecVerdict(
    complete({
      verdict: "park",
      parkReason: "underspecified",
      parkReasonSource: "parsed",
      verdictSource: "default",
    }),
    blank,
  );
  assert(
    gated.verdict === "park" &&
      gated.parkReason === "blank-issue-body" &&
      gated.parkReasonSource === "default",
    `a blank body (${JSON.stringify(blank)}) parks as blank-issue-body, source default, not lifted by #397`,
  );
}
{
  const gated = finaliseSpecVerdict(complete(), undefined);
  assert(
    gated.parkReason === "blank-issue-body",
    "an unread body (undefined) parks as blank-issue-body",
  );
}

// A credential in a RESOLVED point must not reach the PR body through the assumption
// either (#1187 fix round 2): assumptions are rendered publicly, so redaction is on the
// stored text, not only on the blocking list.
{
  const token = "sk-ant-api03-AbCdEfGhIjKlMnOpQrStUvWxYz0123";
  const answered = finaliseSpecVerdict(
    complete(),
    body(`- [CRITICAL][RESOLVED] rotate the ${token} key, owners only`),
  );
  assert(
    answered.verdict === "proceed" &&
      answered.assumptions.some(
        (a) => a.text.includes("[REDACTED]") && a.text.includes("sk-ant-api03") === false,
      ),
    "a resolved point's assumption is redacted too",
  );
}

// The entry cap keeps the park readable and says what it dropped (#1187 fix round 2).
{
  const lines = Array.from({ length: 25 }, (_, i) => `- [CRITICAL] point ${i}`);
  const gated = finaliseSpecVerdict(complete(), body(...lines));
  assert(
    gated.verdict === "park" &&
      gated.openPoints?.length === OPEN_POINT_ENTRY_CAP + 1 &&
      gated.openPoints[OPEN_POINT_ENTRY_CAP] === "…and 5 more open-point lines",
    "openPoints caps at 20 entries plus one '…and N more open-point lines' note",
  );
}
{
  const huge = `- [CRITICAL] ${"z".repeat(4000)} tail`;
  const gated = finaliseSpecVerdict(complete(), body(huge));
  const stored = gated.openPoints?.[0] ?? "";
  assert(
    gated.verdict === "park" && stored.endsWith("…(clipped)") && Array.from(stored).length <= 2000,
    "each entry is capped at 2000 characters with the '…(clipped)' marker",
  );
}

// The park reasons are declared in one place and carry their text.
assert(
  PARK_REASONS.includes("unresolved-critical-open-point") &&
    PARK_REASONS.includes("blank-issue-body") &&
    !(PARK_REASONS as readonly string[]).includes("security-open-point"),
  "PARK_REASONS: the two new reasons are declared and the retired security reason is gone",
);
for (const reason of ["unresolved-critical-open-point", "blank-issue-body"] as const) {
  assert(
    explainPark(reason, 42).includes("#42") && parkAction(reason, 42).includes("--restart"),
    `${reason}: explainPark and parkAction name the issue and the --restart escape`,
  );
}

// A retired artifact is refused, so its verdict is never restored; a rejected artifact never yields proceed.
{
  const legacy = JSON.stringify({
    ...complete(),
    verdict: "park",
    parkReason: "underspecified",
    gateVersion: SPEC_ARTIFACT_GATE_VERSION,
    securityOpenPoints: ["`x`"],
  });
  assert(
    parseNormalisedSpecArtifact(legacy) === undefined,
    "an artifact carrying securityOpenPoints is refused",
  );
  const legacyReason = JSON.stringify({
    ...complete(),
    verdict: "park",
    parkReason: "security-open-point",
    gateVersion: SPEC_ARTIFACT_GATE_VERSION,
  });
  assert(
    parseNormalisedSpecArtifact(legacyReason) === undefined,
    "an artifact with the retired security-open-point reason is refused",
  );
  const prose = complete({
    verdict: "park",
    parkReason: "underspecified",
    parkReasonSource: "default",
    verdictSource: "default",
  });
  const restored = resolveIntentVerdict(prose, parseNormalisedSpecArtifact(legacy));
  assert(
    restored.spec?.verdict === "park",
    "a refused artifact cannot turn a default park into proceed (intent re-runs from the issue body)",
  );
}

// The rejections are TRACED with the reason, so "refused artifact" and "no artifact" are
// distinguishable downstream (#1187 fix round 2).
{
  const legacy = JSON.stringify({
    ...complete(),
    gateVersion: SPEC_ARTIFACT_GATE_VERSION,
    securityOpenPoints: ["x"],
  });
  const { result, traced } = await withTrace(() => parseNormalisedSpecArtifact(legacy));
  assert(
    result === undefined && traced.includes("securityOpenPoints") && traced.includes("refused"),
    "a retired-field artifact is refused AND the trace names the field that caused it",
  );
  const legacyReason = JSON.stringify({
    ...complete(),
    gateVersion: SPEC_ARTIFACT_GATE_VERSION,
    verdict: "park",
    parkReason: "security-open-point",
  });
  const second = await withTrace(() => parseNormalisedSpecArtifact(legacyReason));
  assert(
    second.result === undefined &&
      second.traced.includes("parkReason") &&
      second.traced.includes("security-open-point"),
    "an artifact with a retired park reason is refused AND the trace quotes the reason",
  );
}

// The blank-body trace reports the RAW LENGTH of a body that flattened to nothing, which is
// how an operator tells "no issue body" from "a body of invisible characters" (#1187 fix
// round 2): a boolean would report the same `true` for one zero-width character and for a
// megabyte of them, which is exactly the case this trace exists to separate.
{
  const { traced } = await withTrace(() => finaliseSpecVerdict(complete(), "\u200B\u200B"));
  assert(
    traced.includes("open-point-gate-unchecked") &&
      traced.includes("raw length 2, flattened empty"),
    "the blank-body trace prints the raw length of a body that flattened to nothing",
  );
  const undef = await withTrace(() => finaliseSpecVerdict(complete(), undefined));
  assert(
    undef.traced.includes("unread (undefined)"),
    "the blank-body trace says an unread body is undefined rather than blank",
  );
}

// A heading the reader cannot read is a gate that silently did not run. The settlement says
// a mangled heading opens no section and does NOT park — behaviour unchanged — but the
// operator is told, because "clean" and "never scanned" look identical downstream (#1187
// fix round 2).
{
  // The heading text appears in the body but NOT as an ATX heading — here as a fence info
  // string. No section opens, so the gate does not park (settlement: no cross-section scan)
  // and the trace says the section was not read.
  const fenceInfo = "``` Open points (unresolved at the gap-gate cap)\ncode\n```\n";
  const { result, traced } = await withTrace(() => finaliseSpecVerdict(complete(), fenceInfo));
  assert(
    result.verdict === "proceed",
    "a heading text that is not an ATX heading opens no section and does not park (settled behaviour)",
  );
  assert(
    traced.includes("no Open points section was read") &&
      traced.includes("Open points (unresolved at the gap-gate cap)"),
    "the trace says no Open points section was read while naming the heading the body mentioned",
  );
  const clean = await withTrace(() =>
    finaliseSpecVerdict(complete(), "## Open questions\n\n- plain\n"),
  );
  assert(
    !clean.traced.includes("no Open points section was read"),
    "a body that never mentions the heading produces no misleading trace",
  );
  const read = await withTrace(() => finaliseSpecVerdict(complete(), body("- [HIGH] fine")));
  assert(
    !read.traced.includes("no Open points section was read"),
    "a body with an EXACT heading produces no not-read trace, even when nothing parks",
  );
}

// The openPoints field round-trips through the artifact.
{
  const kept = complete({
    verdict: "park",
    parkReason: "unresolved-critical-open-point",
    openPoints: ["[CRITICAL] x"],
  });
  const back = parseNormalisedSpecArtifact(artifactJson(kept));
  assert(back?.openPoints?.[0] === "[CRITICAL] x", "openPoints round-trips through the artifact");
  assert(
    parseNormalisedSpecArtifact(artifactJson({ ...kept, openPoints: [1] })) === undefined,
    "a non-string openPoints is refused",
  );
  // The write-side bound is a READ-side check too (#1187 fix round 2): the reader used to
  // validate elements and not length, so a list the gate could never have written was
  // restored verbatim into the handoff.
  const tooMany = Array.from({ length: 22 }, (_, i) => `[CRITICAL] point ${i}`);
  const { result: over, traced: overTrace } = await withTrace(() =>
    parseNormalisedSpecArtifact(artifactJson({ ...kept, openPoints: tooMany })),
  );
  assert(
    over === undefined && overTrace.includes("openPoints") && overTrace.includes("refused"),
    "an openPoints list longer than the write-side cap plus its note is refused, with a trace",
  );
  assert(
    parseNormalisedSpecArtifact(
      artifactJson({
        ...kept,
        openPoints: Array.from({ length: OPEN_POINT_ENTRY_CAP + 1 }, (_, i) => `p${i}`),
      }),
    )?.openPoints?.length ===
      OPEN_POINT_ENTRY_CAP + 1,
    "the cap plus one '…and N more' note is exactly what the reader accepts",
  );
  // Assumption text reaches the PR body, so both fields are bounded and redacted on READ,
  // not only on the gate's write path (#1187 fix round 2).
  const token = "sk-ant-api03-AbCdEfGhIjKlMnOpQrStUvWxYz0123";
  const leaky = complete({
    assumptions: [{ text: `rotate the ${token} key`, basis: `via ${token}` }],
  });
  const scrubbed = parseNormalisedSpecArtifact(artifactJson(leaky));
  assert(
    scrubbed?.assumptions[0]?.text.includes("sk-ant-api03") === false &&
      scrubbed?.assumptions[0]?.basis.includes("sk-ant-api03") === false &&
      scrubbed?.assumptions[0]?.text.includes("[REDACTED]") === true,
    "artifact assumptions have their credential redacted on read, in text and in basis",
  );
  const longAssumption = complete({
    assumptions: [{ text: "z".repeat(6000), basis: "b".repeat(6000) }],
  });
  const bounded = parseNormalisedSpecArtifact(artifactJson(longAssumption));
  assert(
    (bounded?.assumptions[0]?.text.length ?? 0) <= OPEN_POINT_CHAR_CAP &&
      (bounded?.assumptions[0]?.basis.length ?? 0) <= OPEN_POINT_CHAR_CAP,
    "artifact assumption text and basis are both bounded on read",
  );
}

console.log(`\nexit ${exit}`);
process.exit(exit);
