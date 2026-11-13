#!/usr/bin/env bun
/**
 * #1187 — the handoff's open-points list: both renderers show each blocking line in a
 * code span that the issue text cannot break out of, and state the way out.
 * The gate writes `openPoints` (flattenIssueText output); the renderers only quote it.
 */

import { explainPrSteps, resolverVerdictLine } from "../src/work-driver-explain-pr-steps.ts";
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
import { parseNormalisedSpec } from "../src/work-driver-intent.ts";
import type { WorkState } from "../src/workflow-state.ts";

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
  // Canary for what the render boundary has to defend against: codeSpan neutralises
  // backticks but NOT newlines — its fence still closes on one — which is exactly why
  // `renderablePoints` flattens before spanning the text. The assertions below check the
  // rendered output; this one pins the property that makes the flattening load-bearing.
  const forged = codeSpan("benign\n### Injected heading\n- injected bullet");
  assert(
    forged.startsWith("`") && forged.endsWith("`") && forged.split("\n").length > 1,
    "codeSpan: the fence wraps a newline rather than removing it — which is what makes the renderer's flatten load-bearing",
  );
}

// The render boundary flattens, so a stored newline can never forge markdown (#1187 round 4).
// codeSpan alone does not neutralise a newline — its fence still closes on one — so the
// flattening happens in renderablePoints and this asserts the rendered output, not the helper.
{
  const forged = spec({
    openPoints: ["benign point\n### Injected heading\n- injected bullet", "   ", "\t  \u200B"],
  });
  const md = openPointsMarkdown(forged, 42).join("\n");
  const chat = openPointsChat(forged, 42).join("\n");
  const forgedNeedle = "benign point ### Injected heading - injected bullet";
  // The canary for the flattening: the point appears in one inert form and never in the
  // form a stored newline would have produced. `md.includes("### Injected heading")` is
  // deliberately NOT asserted false — the flat form is a substring of it — so these read
  // line structure instead of substring presence.
  assert(
    md.includes(forgedNeedle) && chat.includes(forgedNeedle),
    "handoff: a forged `### heading` in a stored point renders flattened, inside one code span",
  );
  assert(
    md.split("\n").some((l) => l.includes("### Injected heading") && l.trim().startsWith("- ")) &&
      chat.split("\n").some((l) => l.includes("### Injected heading") && l.trim().startsWith("-")),
    "handoff: the forged heading sits inside a bullet line, never at a line start as markdown",
  );
  assert(
    md
      .split("\n")
      .filter((l) => l.startsWith("### "))
      .every((l) => l === `### ${OPEN_POINTS_HANDOFF_HEADING}`),
    "handoff: the only ### line in the body is the renderers' own heading",
  );
  // The canary: the point text reaches the output in one line, with its newlines flattened,
  // where codeSpan alone would have carried them. `- injected bullet` at a line start is
  // what a stored newline would have minted, and a line-leading `### ` is a real heading.
  assert(
    md.includes("\n### ") === false &&
      chat.includes("\n### ") === false &&
      md
        .split("\n")
        .filter((l) => l.trim() !== "")
        .every(
          (l) => l.trim().startsWith("-") || l.startsWith("### ") || l.startsWith("Answer each"),
        ) &&
      chat.split("\n").every((l) => l.startsWith("  ") || l.startsWith("Open points")),
    "handoff: a stored newline cannot mint a heading or a bullet line of its own",
  );
  assert(
    md.includes(forgedNeedle),
    "handoff: the point is still shown, flattened onto one line inside its code span",
  );
  assert(
    chat.split("\n").filter((l) => l.trim().startsWith("-")).length === 1,
    "handoff: whitespace-only points are dropped, so no empty bullet renders",
  );
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

// The park's handoff names the resolver's own verdict and the rule that parked.
{
  const reply = (v: string) => `${v}\n\n## Spec\n\n### Intent\nx\n\n## Rationale\nclear\n`;
  assert(
    parseNormalisedSpec(reply("INTENT-VERDICT: proceed-with-assumptions"))?.resolverVerdict ===
      "proceed-with-assumptions",
    "parse: the resolver's verdict is recorded as stated",
  );
  assert(
    parseNormalisedSpec(reply(""))?.resolverVerdict === undefined,
    "parse: no verdict token leaves resolverVerdict absent, not a default",
  );
  const body = "## Open points (unresolved at the gap-gate cap)\n\n- [CRITICAL] pick a name\n";
  const gated = finaliseSpecVerdict(
    spec({
      verdict: "proceed-with-assumptions",
      resolverVerdict: "proceed-with-assumptions",
      parkReason: undefined,
      evidence: [{ claim: "c", source: "s", verdict: "confirmed" }],
    }),
    body,
  );
  const line = resolverVerdictLine(gated);
  assert(
    gated.verdict === "park" && gated.verdictRule === "open-point-gate",
    "gate: an open-point park records the open-point gate as the rule",
  );
  assert(
    line.includes("Resolver verdict: proceed-with-assumptions — parked by: open-point gate") &&
      line.includes("called the issue buildable"),
    "handoff: the line shows the resolver's proceed, the gate that parked, and that the resolver called it buildable",
  );
  const parkState = { issue: 7, eventLog: [], pipelineState: { normalisedSpec: gated } };
  assert(
    explainPrSteps("intent-park", parkState as unknown as WorkState).includes(line),
    "handoff: the intent-park explanation carries the resolver-verdict line",
  );
  const declared = finaliseSpecVerdict(
    spec({ parkReason: "too-large", resolverVerdict: "park", verdictSource: "parsed" }),
    body,
  );
  const declaredLine = resolverVerdictLine(declared);
  assert(
    declared.verdictRule === undefined &&
      declaredLine.startsWith("Resolver verdict: park — parked by the resolver; no rule") &&
      !declaredLine.includes("buildable"),
    "handoff: a resolver-declared park shows its verdict and no override",
  );
  assert(
    resolverVerdictLine(spec()).startsWith("Resolver verdict: not parsed"),
    "handoff: an absent resolver verdict is said to be unparsed",
  );
  const withFields = (over: Record<string, unknown>) =>
    parseNormalisedSpecArtifact(
      JSON.stringify({ ...spec(), gateVersion: SPEC_ARTIFACT_GATE_VERSION, ...over }),
    );
  const kept = withFields({ resolverVerdict: "proceed", verdictRule: "open-point-gate" });
  assert(
    kept?.resolverVerdict === "proceed" && kept.verdictRule === "open-point-gate",
    "artifact: resolverVerdict and verdictRule round-trip",
  );
  assert(
    withFields({}) !== undefined && withFields({})?.resolverVerdict === undefined,
    "artifact: an artifact without the new fields still loads",
  );
  assert(
    withFields({ resolverVerdict: "build-it" }) === undefined &&
      withFields({ verdictRule: "vibes" }) === undefined,
    "artifact: an undeclared resolverVerdict or verdictRule is refused",
  );
}

console.log(`\nexit ${exit}`);
process.exit(exit);
