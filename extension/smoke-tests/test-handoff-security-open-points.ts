#!/usr/bin/env bun
/**
 * Security open points are a typed field, not a string prefix (#1171).
 *
 * The gate writes `securityOpenPoints`; both handoff surfaces render that list
 * under one heading; the artifact reader round-trips it and reads a legacy
 * artifact (no field) as none. `openQuestions` stays the resolver's own questions.
 */

import { renderHandoffMarkdown } from "../src/work-driver-handoff-markdown.ts";
import { renderHandoffUserMessage } from "../src/work-driver-handoff-message.ts";
import {
  SECURITY_OPEN_POINTS_HEADING,
  securityOpenPointsChat,
  securityOpenPointsMarkdown,
} from "../src/work-driver-handoff-open-points.ts";
import { parseNormalisedSpecArtifact } from "../src/work-driver-intent-artifact.ts";
import { finaliseSpecVerdict } from "../src/work-driver-intent-finalise.ts";
import type { NormalisedSpec } from "../src/work-driver-intent.ts";
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
  intent: "Preserve the requested intent while applying the change.",
  deliverables: [{ id: "d1", description: "apply the requested change", paths: [] }],
  acceptanceCriteria: ["the requested behavior is preserved"],
  outOfScope: [],
  assumptions: [],
  openQuestions: [],
  evidence: [],
  verdict: "proceed",
  rationale: "the requested change is actionable",
  ...over,
});

const HEADING = SECURITY_OPEN_POINTS_HEADING;

// The gate writes the typed field and leaves openQuestions to the resolver.
{
  const gated = finaliseSpecVerdict(
    spec(),
    "## Open points (unresolved at the gap-gate cap)\n\n- [CRITICAL] Who may call the endpoint \u2014 authentication is undecided\n",
  );
  assert(gated.parkReason === "security-open-point", "gate: a security point parks");
  assert(
    gated.securityOpenPoints?.length === 1 && gated.openQuestions.length === 0,
    "gate: the point is typed in securityOpenPoints, openQuestions stays empty",
  );
  assert(
    !gated.openQuestions.some((q) => q.startsWith("Security open point")),
    "gate: no string-prefixed side channel in openQuestions",
  );
}

// Renderers: one heading, one bullet per point, nothing when there are none.
{
  const withPoints = spec({ securityOpenPoints: ["`Who may call the endpoint`"] });
  const md = securityOpenPointsMarkdown(withPoints).join("\n");
  assert(md.includes(`### ${HEADING}`), "markdown: the heading is rendered");
  assert(md.includes("- `Who may call the endpoint`"), "markdown: each point is a bullet");
  const chat = securityOpenPointsChat(withPoints).join("\n");
  assert(chat.startsWith(`${HEADING}:`), "chat: the heading is rendered");
  assert(chat.includes("  - `Who may call the endpoint`"), "chat: each point is a bullet");
  assert(
    securityOpenPointsMarkdown(spec()).length === 0 &&
      securityOpenPointsChat(spec()).length === 0 &&
      securityOpenPointsMarkdown(undefined).length === 0,
    "renderers: no points, no section",
  );
}

// Both handoff surfaces show the points on a parked cycle.
{
  const state = {
    schemaVersion: 1,
    resumable: false,
    issue: 1171,
    createdAt: 1,
    updatedAt: 2,
    pipelineState: {
      status: "handoff",
      currentStep: "handoff",
      lastCompletedStep: "explore",
      reviewRound: 0,
      ciRetryCount: 0,
      inFlightJobIds: [],
      normalisedSpec: spec({
        verdict: "park",
        parkReason: "security-open-point",
        parkReasonSource: "default",
        securityOpenPoints: ["`Whether db_password is read from env`"],
      }),
    },
    eventLog: [{ kind: "cap-hit", at: 3, cap: "intent-park", reviewRound: 0, nextStep: "handoff" }],
  } as unknown as WorkState;
  const body = renderHandoffMarkdown(state);
  assert(body.includes(`### ${HEADING}`), "handoff body: renders the security open points heading");
  assert(
    body.includes("`Whether db_password is read from env`"),
    "handoff body: renders the point text",
  );
  const chat = renderHandoffUserMessage(state, "/repo", "/repo/tmp/issue-1171");
  assert(chat.includes(`${HEADING}:`), "in-chat handoff: renders the security open points heading");
}

// Artifact round trip: the field survives; a legacy artifact reads as none.
{
  const written = spec({
    verdict: "park",
    parkReason: "security-open-point",
    securityOpenPoints: ["`x`"],
  });
  const back = parseNormalisedSpecArtifact(JSON.stringify(written));
  assert(
    back?.securityOpenPoints?.length === 1 && back.securityOpenPoints[0] === "`x`",
    "artifact: securityOpenPoints round-trips",
  );
  // spec() never sets the field: it is the artifact shape written before the field existed.
  assert(
    parseNormalisedSpecArtifact(JSON.stringify(spec()))?.securityOpenPoints === undefined,
    "artifact: a legacy artifact without the field reads as no security open points",
  );
  assert(
    parseNormalisedSpecArtifact(JSON.stringify({ ...spec(), securityOpenPoints: [1] })) ===
      undefined,
    "artifact: a non-string securityOpenPoints is refused",
  );
}

process.exit(exit);
