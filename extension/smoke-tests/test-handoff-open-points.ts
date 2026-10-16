#!/usr/bin/env bun
/**
 * #1187 — the handoff's open-points list: both renderers show each blocking line in a
 * code span that the issue text cannot break out of, and state the way out.
 * The gate writes `openPoints` (flattenIssueText output); the renderers only quote it.
 */

import {
  OPEN_POINTS_HANDOFF_HEADING,
  codeSpan,
  openPointsChat,
  openPointsMarkdown,
} from "../src/work-driver-handoff-open-points.ts";
import {
  SPEC_ARTIFACT_GATE_VERSION,
  parseNormalisedSpecArtifact,
} from "../src/work-driver-intent-artifact.ts";
import { type NormalisedSpec, finaliseSpecVerdict } from "../src/work-driver-intent-finalise.ts";

let exit = 0;
function assert(cond: boolean, msg: string) {
  if (cond) console.log(`✓ ${msg}`);
  else {
    console.error(`✗ ${msg}`);
    exit = 1;
  }
}

const spec = (over: Partial<NormalisedSpec> = {}): NormalisedSpec => ({
  intent: "x",
  deliverables: [{ id: "d1", description: "d", paths: [] }],
  acceptanceCriteria: ["c"],
  outOfScope: [],
  assumptions: [],
  openQuestions: [],
  evidence: [],
  verdict: "park",
  parkReason: "unresolved-critical-open-point",
  rationale: "",
  ...over,
});

// A code span is longer than the longest backtick run in its text.
{
  const span = codeSpan("a `b` and ``c``");
  assert(
    span.startsWith("```") && span.endsWith("```"),
    "codeSpan: the fence is longer than the longest run",
  );
  assert(span.slice(3, -3).trim() === "a `b` and ``c``", "codeSpan: the text is carried verbatim");
  const edge = codeSpan("`tick`");
  assert(edge === "`` `tick` ``", "codeSpan: a text that starts or ends with a backtick is padded");
}

// Both renderers name each point, in a code span, under the heading, with the escape.
{
  const withPoints = spec({ openPoints: ["[CRITICAL] Which `timeout` wins"] });
  const md = openPointsMarkdown(withPoints, 42).join("\n");
  assert(
    md.includes(`### ${OPEN_POINTS_HANDOFF_HEADING}`),
    "markdown: the open-points heading is rendered",
  );
  assert(
    md.includes("``[CRITICAL] Which `timeout` wins``"),
    "markdown: the point is a code span that the backticks cannot break",
  );
  assert(
    md.includes("[RESOLVED]") && md.includes("/work 42 --restart"),
    "markdown: the [RESOLVED] + --restart escape is stated",
  );
  const chat = openPointsChat(withPoints, 42).join("\n");
  assert(
    chat.includes("``[CRITICAL] Which `timeout` wins``"),
    "chat: the point is the same code span",
  );
  assert(chat.includes("/work 42 --restart"), "chat: the escape is stated");
}

// No points, no section.
assert(
  openPointsMarkdown(spec(), 42).length === 0 &&
    openPointsChat(spec(), 42).length === 0 &&
    openPointsMarkdown(undefined, 42).length === 0,
  "no openPoints: both renderers render nothing",
);

// The gate records the flattened, unclipped text, and the handoff quotes it.
{
  const long = `- [CRITICAL] ${"w".repeat(500)} tail`;
  const gated = finaliseSpecVerdict(
    spec({ verdict: "proceed", parkReason: undefined, evidence: [] }),
    `## Open points (unresolved at the gap-gate cap)\n\n${long}\n`,
  );
  assert(gated.parkReason === "unresolved-critical-open-point", "gate: an unresolved point parks");
  const md = openPointsMarkdown(gated, 7).join("\n");
  assert(
    md.includes("tail") && md.includes("w".repeat(500)),
    "handoff: the point text is unclipped",
  );
}

// A credential must not reach the public handoff, even from a `openPoints` list written by
// an older cycle that stored it verbatim (#1187 fix round 2).
{
  const token = "sk-ant-api03-AbCdEfGhIjKlMnOpQrStUvWxYz0123";
  const leaky = spec({ openPoints: [`[CRITICAL] rotate the ${token} key now`] });
  const md = openPointsMarkdown(leaky, 9).join("\n");
  const chat = openPointsChat(leaky, 9).join("\n");
  assert(
    md.includes("sk-ant-api03") === false && chat.includes("sk-ant-api03") === false,
    "handoff: neither surface posts the credential, whatever the stored field contains",
  );
  assert(
    md.includes("[REDACTED]") && chat.includes("[REDACTED]"),
    "handoff: the point is still shown, with the token replaced by the redaction marker",
  );
  const viaGate = finaliseSpecVerdict(
    spec({ verdict: "proceed", parkReason: undefined }),
    `## Open points (unresolved at the gap-gate cap)\n\n- [CRITICAL] rotate the ${token} key now\n`,
  );
  assert(
    viaGate.openPoints?.[0]?.includes("sk-ant-api03") === false &&
      viaGate.openPoints?.[0]?.includes("[REDACTED]") === true,
    "gate: the stored openPoints are redacted at write time, not only at render time",
  );
}

// The persisted artifact keeps the field and drops the retired one.
{
  const kept = JSON.stringify({
    ...spec({ openPoints: ["[CRITICAL] x"] }),
    gateVersion: SPEC_ARTIFACT_GATE_VERSION,
  });
  assert(
    parseNormalisedSpecArtifact(kept)?.openPoints?.[0] === "[CRITICAL] x",
    "artifact: openPoints round-trips",
  );
  assert(
    parseNormalisedSpecArtifact(
      JSON.stringify({
        ...spec(),
        gateVersion: SPEC_ARTIFACT_GATE_VERSION,
        securityOpenPoints: ["`x`"],
      }),
    ) === undefined,
    "artifact: the retired securityOpenPoints field is refused",
  );
  assert(
    parseNormalisedSpecArtifact(JSON.stringify(spec())) === undefined,
    "artifact: an artifact without the current gateVersion is refused, so an old-gate proceed cannot come back",
  );
}

console.log(`\nexit ${exit}`);
process.exit(exit);
