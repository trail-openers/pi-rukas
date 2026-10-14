#!/usr/bin/env bun
/**
 * #1151 review — open-point edge cases for the intent gate.
 *
 * A bare `- [CRITICAL]` bullet is still a point (it must not vanish from the
 * gate), and assumption text is clipped by code point so an emoji run never
 * leaves a lone surrogate. The round trip and authorization canaries live in
 * test-intent-criticality.ts.
 */

import { applyOpenPointGate, criticalOpenPoints } from "../src/work-driver-intent-criticality.ts";
import type { NormalisedSpec } from "../src/work-driver-intent.ts";

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

// A bare `- [CRITICAL]` is still a point; it must not vanish from the gate.
{
  const bare = criticalOpenPoints(
    "## Open points (unresolved at the gap-gate cap)\n\n- [CRITICAL]\n- [CRITICAL] \n",
  );
  assert(
    bare.length === 2 && bare.every((p) => p === "(empty CRITICAL open point)"),
    `empty CRITICAL bullet counts as a point (${bare.length})`,
  );
  const gated = applyOpenPointGate(spec({ verdict: "proceed" }), bare);
  assert(
    gated.verdict === "proceed-with-assumptions",
    "an empty CRITICAL bullet caps a proceed rather than being dropped",
  );
}

// Clipping counts code points, so an emoji run is never split into a lone surrogate.
{
  const emoji = "\u{1F600}".repeat(400);
  const capped = applyOpenPointGate(spec({ verdict: "proceed" }), [emoji]);
  const text = capped.assumptions.at(-1)?.text ?? "";
  const span = text.match(/`([^`]*)`$/)?.[1] ?? "";
  const codePoints = Array.from(span);
  assert(
    codePoints.length === 300 && span.endsWith("\u2026"),
    `clip: an emoji point is clipped to 300 code points (${codePoints.length})`,
  );
  assert(
    codePoints.slice(0, -1).every((c) => c === "\u{1F600}"),
    "clip: no lone surrogate is left before the ellipsis",
  );
}

process.exit(exit);
