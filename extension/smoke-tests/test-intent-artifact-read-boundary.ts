#!/usr/bin/env bun
/**
 * #1187 fix round 4 — the spec artifact's READ boundary.
 *
 * The artifact is a file a prior cycle (or a truncated write) produced, and every restored
 * string reaches the handoff or the public PR body. Round 2 bounded two fields; round 4
 * bounds and redacts EVERY restored string — `intent`, `rationale`, each element of the
 * string lists, `deliverables[].id/description/paths`, the evidence strings — caps the
 * `assumptions` COUNT at the number the writer can produce, and accepts `gateVersion` only
 * as the exact integer this build writes. Lives apart from `test-intent-open-point-gate.ts`
 * because that file is at the §12 size limit; same offline loop.
 */

import { OPEN_POINT_CHAR_CAP, OPEN_POINT_ENTRY_CAP } from "../src/open-points-reader.ts";
import {
  SPEC_ARTIFACT_GATE_VERSION,
  parseNormalisedSpecArtifact,
} from "../src/work-driver-intent-artifact.ts";
import type { NormalisedSpec } from "../src/work-driver-intent.ts";

let exit = 0;
function assert(cond: boolean, msg: string) {
  if (cond) console.log(`✓ ${msg}`);
  else {
    console.error(`✗ ${msg}`);
    exit = 1;
  }
}

/** Capture `trace` output while running `fn` (trace writes `[pi-rukas] …` to stderr). */
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
    process.env.PI_ENSEMBLE_DEBUG = prior;
  }
}

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

/** What `persistSpecArtifact` writes, so these assertions read the real bytes. */
const artifactJson = (spec: NormalisedSpec): string =>
  JSON.stringify({ ...spec, gateVersion: SPEC_ARTIFACT_GATE_VERSION });

// Every RESTORED string is bounded and redacted, not only the two fields the round-2 fix
// covered (#1187 fix round 4). `rationale` and `intent` and each element of the string lists
// reach the handoff and the PR body, and the artifact is a file a prior cycle wrote — so a
// token stored in any of them used to come back verbatim.
{
  const token = "sk-ant-api03-AbCdEfGhIjKlMnOpQrStUvWxYz0123";
  const leaky = complete({
    intent: `wire ${token} through the retry config`,
    rationale: `the resolver quotes ${token} as the reason`,
    acceptanceCriteria: [`accepts ${token} as a fixture`],
    outOfScope: [`do not touch ${token}`],
    openQuestions: [`is ${token} the right key?`],
    deliverables: [
      {
        id: `d-${token}`,
        description: `load ${token} from env`,
        paths: [`src/${token}.ts`],
      },
    ],
    evidence: [
      { claim: `the token ${token} is read`, source: `src/${token}.ts:1`, verdict: "confirmed" },
    ],
  });
  const back = parseNormalisedSpecArtifact(artifactJson(leaky));
  // A refused artifact serialises to "undefined", which contains neither marker — so the
  // shape assertion below is what makes these two mean "restored AND scrubbed".
  const seen = JSON.stringify(back);
  assert(back !== undefined, "a leaky artifact still validates on shape");
  assert(
    seen.includes("sk-ant-api03") === false,
    "no credential survives the artifact read in ANY restored string (rationale, intent, criteria, outOfScope, questions, deliverables, evidence)",
  );
  assert(
    seen.includes("[REDACTED]"),
    "the restored strings carry the redaction marker rather than the token",
  );
  const huge = complete({
    intent: "i".repeat(6000),
    rationale: "r".repeat(6000),
    acceptanceCriteria: ["a".repeat(6000)],
    outOfScope: ["o".repeat(6000)],
    openQuestions: ["q".repeat(6000)],
    deliverables: [
      { id: "d".repeat(6000), description: "e".repeat(6000), paths: ["p".repeat(6000)] },
    ],
  });
  const hugeBack = parseNormalisedSpecArtifact(artifactJson(huge));
  const longest = [
    hugeBack?.intent ?? "",
    hugeBack?.rationale ?? "",
    ...(hugeBack?.acceptanceCriteria ?? []),
    ...(hugeBack?.outOfScope ?? []),
    ...(hugeBack?.openQuestions ?? []),
    ...(hugeBack?.deliverables[0]
      ? [
          hugeBack.deliverables[0].id,
          hugeBack.deliverables[0].description,
          ...hugeBack.deliverables[0].paths,
        ]
      : []),
  ].map((s) => Array.from(s).length);
  assert(
    hugeBack !== undefined && longest.every((n) => n <= OPEN_POINT_CHAR_CAP),
    `every restored string is bounded to ${OPEN_POINT_CHAR_CAP} code points on read`,
  );
  // The assumptions COUNT is bounded too: the writer caps the list it can produce, so a
  // longer one was not written by this gate and is refused rather than rendered.
  const tooManyAssumptions = complete({
    assumptions: Array.from({ length: OPEN_POINT_ENTRY_CAP + 2 }, (_, i) => ({
      text: `a${i}`,
      basis: `b${i}`,
    })),
  });
  const { result: refused, traced: refusedTrace } = await withTrace(() =>
    parseNormalisedSpecArtifact(artifactJson(tooManyAssumptions)),
  );
  assert(
    refused === undefined &&
      refusedTrace.includes("assumptions") &&
      refusedTrace.includes("refused"),
    "an assumptions list above the cap the gate writes is refused, with a trace naming the field",
  );
  assert(
    parseNormalisedSpecArtifact(
      artifactJson({
        ...complete(),
        assumptions: Array.from({ length: OPEN_POINT_ENTRY_CAP + 1 }, (_, i) => ({
          text: `a${i}`,
          basis: `b${i}`,
        })),
      }),
    )?.assumptions.length ===
      OPEN_POINT_ENTRY_CAP + 1,
    "the cap plus the one note is the count the reader accepts",
  );
}

// gateVersion accepts ONLY the integer this build writes (#1187 fix round 4): the old
// lower-bound comparison read `2.5` and any larger number as satisfying the floor, so a
// payload this gate never wrote restored a decision it would not have made.
for (const bad of [2.5, 20, "2", Number.NaN, Number.POSITIVE_INFINITY]) {
  const { result, traced } = await withTrace(() =>
    parseNormalisedSpecArtifact(JSON.stringify({ ...complete(), gateVersion: bad })),
  );
  assert(
    result === undefined && traced.includes("gateVersion") && traced.includes("refused"),
    `a gateVersion of ${String(bad)} is refused (only the integer ${SPEC_ARTIFACT_GATE_VERSION} this build writes is accepted), with a trace`,
  );
}

console.log(`\nexit ${exit}`);
process.exit(exit);
