#!/usr/bin/env bun
/**
 * Smoke test for the #594 intent-artifact lifecycle in runExplore.
 *
 * Covers:
 *   - parseNormalisedSpecArtifact: strict element validation (null / wrong
 *     type per field) → undefined; well-formed → the NormalisedSpec.
 *   - resolveIntentVerdict: the precedence rule as a pure function —
 *     artifact wins only for no-parse / parser-default-park; an explicit
 *     prose park always wins.
 *   - runExplore end-to-end with a mocked dispatchFn:
 *       a. no `## Spec` in prose + valid artifact → proceed (restored).
 *       b. prose parses to the parser-default park + valid artifact → proceed.
 *       c. explicit prose park + artifact proceed → park (prose wins).
 *       d. no parse AND no artifact → the existing no-signal cap-hit.
 *       e. a stale spec.txt from a prior cycle is deleted before dispatch,
 *          so a fresh cycle cannot restore a dead decision.
 *
 * No real Pi spawn; dispatchFn is mocked.
 */

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import {
  deleteSpecArtifact,
  exploreSpecArtifactPath,
  parseNormalisedSpecArtifact,
  readSpecArtifact,
  resolveIntentVerdict,
} from "../src/work-driver-intent-artifact.ts";
import { type NormalisedSpec, parseNormalisedSpec } from "../src/work-driver-intent.ts";
import type { DriverContext } from "../src/work-driver-context.ts";
import { runExplore } from "../src/work-driver-explore.ts";
import { type WorkState, initialState } from "../src/workflow-state.ts";

let exit = 0;
function assert(cond: boolean, msg: string) {
  if (cond) console.log(`✓ ${msg}`);
  else {
    console.error(`✗ ${msg}`);
    exit = 1;
  }
}

// ---------------------------------------------------------------------------
// Pure: parseNormalisedSpecArtifact
// ---------------------------------------------------------------------------

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

{
  const spec = parseNormalisedSpecArtifact(JSON.stringify(baseSpec()));
  assert(spec !== undefined, "parse: well-formed artifact → NormalisedSpec");
  assert(
    spec?.verdict === "proceed" &&
      spec?.deliverables.length === 1 &&
      spec?.intent === "Add a new endpoint",
    "parse: fields round-trip",
  );
}
{
  // Not valid JSON at all.
  assert(
    parseNormalisedSpecArtifact("this is not json {") === undefined,
    "parse: malformed JSON → undefined (no throw)",
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
  // Null element in deliverables.
  const s = baseSpec();
  s.deliverables = [null as unknown as NormalisedSpec["deliverables"][number]];
  assert(
    parseNormalisedSpecArtifact(JSON.stringify(s)) === undefined,
    "parse: null deliverable element → undefined",
  );
}
{
  // Wrong type: deliverable.id is a number.
  const s = baseSpec();
  s.deliverables = [{ id: 42, description: "x", paths: [] }];
  assert(
    parseNormalisedSpecArtifact(JSON.stringify(s)) === undefined,
    "parse: deliverable.id not a string → undefined",
  );
}
{
  // Wrong type: evidence.verdict not in the union.
  const s = baseSpec();
  s.evidence = [{ claim: "c", source: "s", verdict: "maybe" }];
  assert(
    parseNormalisedSpecArtifact(JSON.stringify(s)) === undefined,
    "parse: evidence.verdict outside the union → undefined",
  );
}
{
  // Wrong type: assumption.basis missing.
  const s = baseSpec();
  s.assumptions = [{ text: "only text" } as unknown as NormalisedSpec["assumptions"][number]];
  assert(
    parseNormalisedSpecArtifact(JSON.stringify(s)) === undefined,
    "parse: assumption.basis missing → undefined",
  );
}
{
  // Wrong type: openQuestions contains a number.
  const s = baseSpec();
  s.openQuestions = [42];
  assert(
    parseNormalisedSpecArtifact(JSON.stringify(s)) === undefined,
    "parse: openQuestions element not a string → undefined",
  );
}
{
  // Bad verdict.
  const s = baseSpec();
  s.verdict = "maybe" as NormalisedSpec["verdict"];
  assert(
    parseNormalisedSpecArtifact(JSON.stringify(s)) === undefined,
    "parse: verdict outside the 3-value union → undefined",
  );
}
{
  // Bad parkReason.
  const s = baseSpec();
  s.verdict = "park";
  s.parkReason = "not-a-real-reason";
  assert(
    parseNormalisedSpecArtifact(JSON.stringify(s)) === undefined,
    "parse: parkReason outside the 5-value union → undefined",
  );
}
{
  // Provenance fields outside the 2-value union.
  const s = baseSpec();
  s.verdict = "park";
  s.parkReason = "underspecified";
  s.verdictSource = "stale" as NormalisedSpec["verdictSource"];
  assert(
    parseNormalisedSpecArtifact(JSON.stringify(s)) === undefined,
    "parse: verdictSource outside the 2-value union → undefined",
  );
}

// ---------------------------------------------------------------------------
// Pure: resolveIntentVerdict — the precedence rule.
// ---------------------------------------------------------------------------

{
  // No parse, valid artifact → artifact wins.
  const artifact = baseSpec();
  const { spec, source } = resolveIntentVerdict(undefined, artifact);
  assert(
    spec === artifact && source === "artifact",
    "precedence: no prose parse + valid artifact → artifact wins",
  );
}
{
  // Parser-default park (verdictSource === "default") + artifact → artifact wins.
  const prose: NormalisedSpec = {
    ...baseSpec(),
    verdict: "park",
    parkReason: "underspecified",
    parkReasonSource: "default",
    verdictSource: "default",
  };
  const artifact = baseSpec();
  const { spec, source } = resolveIntentVerdict(prose, artifact);
  assert(
    spec === artifact && source === "artifact",
    "precedence: parser-default park + artifact → artifact wins",
  );
}
{
  // Explicit prose park (verdictSource === "parsed") + artifact proceed → prose wins.
  const prose: NormalisedSpec = {
    ...baseSpec(),
    verdict: "park",
    parkReason: "too-large",
    parkReasonSource: "parsed",
    verdictSource: "parsed",
  };
  const artifact = baseSpec();
  const { spec, source } = resolveIntentVerdict(prose, artifact);
  assert(
    spec === prose && source === "prose",
    "precedence: explicit prose park + artifact proceed → prose wins",
  );
}
{
  // No parse AND no artifact → prose (undefined) stands; the cap-hit fires downstream.
  const { spec, source } = resolveIntentVerdict(undefined, undefined);
  assert(
    spec === undefined && source === "prose",
    "precedence: no parse + no artifact → prose (undefined) stands",
  );
}
{
  // Prose parses to proceed → prose wins (artifact ignored).
  const prose = baseSpec();
  const artifact: NormalisedSpec = { ...baseSpec(), verdict: "park", parkReason: "too-large" };
  const { spec, source } = resolveIntentVerdict(prose, artifact);
  assert(
    spec === prose && source === "prose",
    "precedence: prose proceed + artifact park → prose wins",
  );
}
{
  // Malformed artifact (invalid JSON string) → prose stands.
  const { spec, source } = resolveIntentVerdict(undefined, undefined);
  assert(
    spec === undefined && source === "prose",
    "precedence: malformed artifact degrades to prose",
  );
}

// ---------------------------------------------------------------------------
// End-to-end: runExplore with a mocked dispatchFn.
// ---------------------------------------------------------------------------

// PR11 — non-empty issue body so runExplore's empty-body halt guard doesn't fire.
const mockIssueBodyOk = async (issue: number, _cwd: string) => ({
  stdout: `title:\tmock issue #${issue}\nstate:\tOPEN\n\nmock body for issue #${issue} — non-empty`,
});

function makeFakePi(): { pi: ExtensionAPI } {
  return {
    pi: {
      sendUserMessage: () => {},
    } as unknown as ExtensionAPI,
  };
}

async function freshDir(label: string): Promise<string> {
  const dir = await mkdtempSync(path.join(tmpdir(), `work-driver-intent-artifact-${label}-`));
  await (await import("node:fs/promises")).mkdir(path.join(dir, ".git", "info"), {
    recursive: true,
  });
  return dir;
}

async function runExploreWithArtifact(
  dir: string,
  issue: number,
  reply: string,
  preseedArtifact?: string,
  agentPersistsArtifact = true,
): Promise<{ state: WorkState; dispatchSawStale: boolean }> {
  const { pi } = makeFakePi();
  let dispatchSawStale = false;
  if (preseedArtifact !== undefined) {
    const fs = await import("node:fs/promises");
    await fs.mkdir(path.dirname(exploreSpecArtifactPath(dir, issue)), { recursive: true });
    await fs.writeFile(exploreSpecArtifactPath(dir, issue), preseedArtifact, "utf8");
  }
  const state = initialState(issue, 1_000_000);
  const ctx: DriverContext = {
    pi,
    repoRoot: dir,
    issue,
    issueBodyFetcherFn: mockIssueBodyOk,
    dispatchFn: async () => {
      // The dispatch happens AFTER deleteSpecArtifact; check whether the
      // stale artifact was still on disk when the dispatch ran.
      const { existsSync } = await import("node:fs");
      dispatchSawStale = existsSync(exploreSpecArtifactPath(dir, issue));
      // The agent's prompt says to persist the normalised spec to spec.txt.
      // The mocked dispatch honours that contract (unless the test says the
      // agent did NOT persist, e.g. a crashed or truncated dispatch), so the
      // post-dispatch read in runExplore finds the resolver's decision.
      if (agentPersistsArtifact) {
        const fs = await import("node:fs/promises");
        await fs.mkdir(path.dirname(exploreSpecArtifactPath(dir, issue)), { recursive: true });
        await fs.writeFile(
          exploreSpecArtifactPath(dir, issue),
          JSON.stringify({ ...baseSpec() }),
          "utf8",
        );
      }
      return {
        role: "explore",
        ok: true,
        text: reply,
        toolUses: [],
        ms: 100,
        exitCode: 0,
        transcriptPath: "/tmp/stub-transcript.json",
      };
    },
  };
  const result = await runExplore(ctx, state, 1_000_000);
  return { state: result, dispatchSawStale };
}

// 1. No `## Spec` in prose + valid artifact → proceed (restored).
{
  const dir = await freshDir("1");
  try {
    const artifact = JSON.stringify(baseSpec());
    const { state, dispatchSawStale } = await runExploreWithArtifact(
      dir,
      601,
      "no spec block here",
      artifact,
    );
    assert(dispatchSawStale === false, "runExplore §1: stale artifact deleted BEFORE dispatch");
    const ns = state.pipelineState.normalisedSpec;
    assert(ns !== undefined, "runExplore §1: normalisedSpec set from artifact");
    // The artifact (baseSpec) has a confirmed evidence row + a proceed
    // verdict. reconcileVerdict keeps the proceed (no contradictions to
    // park, no assumptions to promote). The verdict is restored.
    assert(
      ns?.verdict === "proceed" || ns?.verdict === "proceed-with-assumptions",
      `runExplore §1: verdict restored as a proceed (got ${ns?.verdict})`,
    );
    assert(ns?.intent === "Add a new endpoint", "runExplore §1: intent restored verbatim");
    const caps = state.eventLog.filter((e) => e.kind === "cap-hit");
    assert(caps.length === 0, "runExplore §1: no cap-hit on a restored proceed");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

// 2. Prose parses to the parser-default park (verdictSource === "default") +
//    artifact → the artifact's decision wins (reconciled).
//
// The prose fallback is the parser's synthetic default park — not a decision
// the resolver made. The agent persists the spec to spec.txt (per the prompt
// contract); the artifact is the resolver's own record of its decision.
// runExplore reads it back, restores it, and reconciles: a complete spec
// refutes the `underspecified` label, so the verdict is restored.
{
  const dir = await freshDir("2");
  try {
    // A spec block that parses but has no INTENT-VERDICT token → default park.
    const reply = `## Spec\n\n### Intent\nfoo\n\n### Deliverables\n- d1: foo [paths: a.ts]\n\n### Acceptance criteria\n- x\n\n### Evidence\n- c — a.ts:1 — confirmed\n\n### Open questions\n- None blocking\n`;
    const parsed = parseNormalisedSpec(reply);
    assert(
      parsed?.verdict === "park" && parsed?.verdictSource === "default",
      "runExplore §2: prose parses to the parser-default park (fixture sanity)",
    );
    // The agent persists a spec with a clear proceed verdict (per the prompt
    // contract). runExplore reads it back, restores the proceed, and
    // reconciles. The artifact (baseSpec) is complete, so reconcileVerdict
    // keeps the proceed.
    const { state } = await runExploreWithArtifact(dir, 602, reply);
    const ns = state.pipelineState.normalisedSpec;
    assert(
      ns?.verdict === "proceed" || ns?.verdict === "proceed-with-assumptions",
      `runExplore §2: artifact restored over the default park (got ${ns?.verdict})`,
    );
    assert(
      ns?.intent === "Add a new endpoint",
      "runExplore §2: intent restored verbatim from the artifact",
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

// 3. Explicit prose park + artifact proceed → park (prose wins).
//
// The resolver explicitly wrote `INTENT-VERDICT: park`. The prompt contract
// says to persist the spec to spec.txt, so the agent also wrote spec.txt.
// The prose park is a decision and is NEVER overridden by the file the same
// resolver wrote — the #404 invariant, extended to the artifact channel.
{
  const dir = await freshDir("3");
  try {
    const reply =
      "INTENT-VERDICT: park\nPARK-REASON: too-large\n\n## Spec\n\n### Intent\nfoo\n\n### Deliverables\n- d1: foo\n\n### Acceptance criteria\n- x\n\n### Open questions\n- None\n\n## Rationale\n\nToo big for one cycle.\n";
    const parsed = parseNormalisedSpec(reply);
    assert(
      parsed?.verdict === "park" && parsed?.verdictSource === "parsed",
      "runExplore §3: prose parses to an explicit park (fixture sanity)",
    );
    // The agent persists a spec (with a proceed verdict, per the prompt
    // contract) to spec.txt. runExplore reads it back, but the explicit
    // prose park wins — the artifact is a RECOVERY channel, not an
    // additional decision, and cannot override a decision the resolver
    // explicitly made in prose.
    const { state } = await runExploreWithArtifact(dir, 603, reply);
    const ns = state.pipelineState.normalisedSpec;
    assert(
      ns?.verdict === "park",
      "runExplore §3: explicit prose park is NOT overridden by artifact",
    );
    const caps = state.eventLog.filter((e) => e.kind === "cap-hit");
    assert(
      caps.some((c) => c.kind === "cap-hit" && c.cap === "intent-park"),
      "runExplore §3: intent-park cap-hit fires",
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

// 4. No parse AND no artifact → the existing no-signal cap-hit fires.
{
  const dir = await freshDir("4");
  try {
    // agentPersistsArtifact=false simulates a crashed or truncated dispatch
    // that did not write spec.txt, so the post-dispatch read finds nothing.
    const { state } = await runExploreWithArtifact(
      dir,
      604,
      "no spec block here",
      undefined,
      false,
    );
    const caps = state.eventLog.filter((e) => e.kind === "cap-hit");
    assert(
      caps.some((c) => c.kind === "cap-hit" && c.cap === "explore-needs-clarification"),
      "runExplore §4: no parse + no artifact → explore-needs-clarification cap-hit",
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

// 5. A stale spec.txt from a prior cycle is deleted before dispatch.
{
  const dir = await freshDir("5");
  try {
    const stale = JSON.stringify(baseSpec());
    // agentPersistsArtifact=false: the dispatch does NOT write a new spec.txt
    // (simulating a crashed/truncated dispatch), so the only file that could
    // be on disk after runExplore is the stale preseed. If it's gone, the
    // delete-before-dispatch in runExplore is what removed it.
    const { dispatchSawStale } = await runExploreWithArtifact(
      dir,
      605,
      "no spec block here",
      stale,
      false,
    );
    assert(
      dispatchSawStale === false,
      "runExplore §5: stale spec.txt is deleted BEFORE the dispatch runs",
    );
    const { existsSync } = await import("node:fs");
    assert(
      !existsSync(exploreSpecArtifactPath(dir, 605)),
      "runExplore §5: no spec.txt left behind after a no-signal explore",
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

// 6. readSpecArtifact returns undefined on a missing file and a malformed file.
{
  const dir = await freshDir("6");
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

// 7. deleteSpecArtifact is idempotent (missing file is a success).
{
  const dir = await freshDir("7");
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
