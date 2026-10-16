#!/usr/bin/env bun
/**
 * #594 — the spec artifact's FILE lifecycle, kept apart from test-work-driver-pr12.ts.
 *
 * The precedence and element-validation assertions live in `test-work-driver-pr12.ts`,
 * which is at the §12 size limit; the parts that touch the disk (the read that must not
 * throw, the delete that must be idempotent) and the element cases whose fixtures read as
 * whole-spec rejections live here. Both files are run by the same offline loop.
 */

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import {
  deleteSpecArtifact,
  exploreSpecArtifactPath,
  parseNormalisedSpecArtifact,
  readSpecArtifact,
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

function baseSpec(): NormalisedSpec {
  return {
    intent: "Add a new endpoint",
    deliverables: [{ id: "d1", description: "Add endpoint", paths: ["src/api.ts"] }],
    acceptanceCriteria: ["Returns 200"],
    outOfScope: ["docs"],
    assumptions: [{ text: "assumption", basis: "why" }],
    openQuestions: [],
    evidence: [{ claim: "claim", source: "src/api.ts:10", verdict: "confirmed" }],
    verdict: "proceed",
    rationale: "it is clear",
  };
}

async function freshDir(label: string): Promise<string> {
  const dir = mkdtempSync(path.join(tmpdir(), `spec-artifact-files-${label}-`));
  await (await import("node:fs/promises")).mkdir(path.join(dir, ".git", "info"), {
    recursive: true,
  });
  return dir;
}

// ---------------------------------------------------------------------------
// Element-level rejection cases (the other half sits in test-work-driver-pr12.ts).
// ---------------------------------------------------------------------------

{
  // Null element in deliverables.
  const s = baseSpec();
  s.deliverables = [null as unknown as NormalisedSpec["deliverables"][number]];
  assert(
    parseNormalisedSpecArtifact(JSON.stringify(s)) === undefined,
    "parse: null deliverable element → undefined",
  );
}
{
  // Top-level shape miss.
  assert(
    parseNormalisedSpecArtifact(JSON.stringify({ foo: 1 })) === undefined,
    "parse: top-level miss → undefined",
  );
}
{
  // Bad parkReason.
  const s = baseSpec();
  s.verdict = "park";
  s.parkReason = "not-a-real-reason";
  assert(
    parseNormalisedSpecArtifact(JSON.stringify(s)) === undefined,
    "parse: parkReason outside the declared union → undefined",
  );
}

// ---------------------------------------------------------------------------
// The file lifecycle.
// ---------------------------------------------------------------------------

// readSpecArtifact returns undefined on a missing file and a malformed file.
{
  const dir = await freshDir("read");
  try {
    const missing = await readSpecArtifact(dir, 999);
    assert(missing === undefined, "readSpecArtifact: missing file → undefined (no throw)");
    const fs = await import("node:fs/promises");
    await fs.mkdir(path.dirname(exploreSpecArtifactPath(dir, 998)), { recursive: true });
    await fs.writeFile(exploreSpecArtifactPath(dir, 998), "{ not json", "utf8");
    const malformed = await readSpecArtifact(dir, 998);
    assert(malformed === undefined, "readSpecArtifact: malformed JSON → undefined (no throw)");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

// deleteSpecArtifact is idempotent (a missing file is a success).
{
  const dir = await freshDir("delete");
  try {
    await deleteSpecArtifact(dir, 1);
    await deleteSpecArtifact(dir, 1);
    assert(true, "deleteSpecArtifact: double-delete of a missing file does not throw");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

console.log(`\nexit ${exit}`);
process.exit(exit);
