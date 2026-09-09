#!/usr/bin/env bun
/**
 * Deep + adoption tiers of the compiled /research pipeline.
 *
 * Pins: deep = standard retrieval + exactly ONE entailment dispatch whose
 * CLAIM-SUPPORT verdicts annotate claims (absence stays unannotated; a
 * "none" verdict demotes the finding out of the abstention count); a failed
 * entailment dispatch marks the run "unavailable" — never silently clean.
 * Adoption = the fixed three-angle memo set + ONE synthesis dispatch whose
 * RECOMMENDATION/COMPARISON sections embed VERBATIM in the memo artifact;
 * a failed synthesis leaves the decision to the operator. Plus the
 * marker parsers in isolation (tolerant; absence ≠ verdict).
 */

import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { parseMemoSections } from "../src/research-artifact.ts";
import { runResearchPipeline, setResearchDispatch } from "../src/research-driver.ts";
import type { ResearchClaim } from "../src/research-types.ts";
import {
  ENTAILMENT_CLAIM_CAP,
  entailableClaims,
  parseClaimSupport,
} from "../src/research-verify.ts";
import type { ExecFn } from "../src/worktree.ts";

let exit = 0;
function assert(cond: boolean, msg: string) {
  if (cond) console.log(`✓ ${msg}`);
  else {
    console.error(`✗ ${msg}`);
    exit = 1;
  }
}

// -------------------------------------------------------- parsers (units)

{
  const m = parseClaimSupport(
    "CLAIM-SUPPORT: 1 — full\n**CLAIM-SUPPORT: 2 — None**\nclaim-support: 3 : partial\nCLAIM-SUPPORT: 99 — full\nprose mentioning full support does not parse\n",
    3,
  );
  assert(
    m.get(1) === "full" && m.get(2) === "none" && m.get(3) === "partial",
    "support parser: plain, bolded and colon-separated forms all parse",
  );
  assert(!m.has(99), "support parser: out-of-range claim numbers dropped");
  assert(
    parseClaimSupport("no markers at all", 3).size === 0,
    "support parser: absence is absence, never a verdict",
  );
}

{
  const rec =
    "RECOMMENDATION:\nAdopt with conditions: pin the version.\n\nCOMPARISON:\n| option | score |\n|---|---|\n| X | 9 |\n";
  const s = parseMemoSections(rec);
  assert(
    s.recommendation === "Adopt with conditions: pin the version.",
    "memo parser: recommendation sliced",
  );
  assert(s.comparison?.startsWith("| option |") === true, "memo parser: comparison sliced");
  const bold = parseMemoSections("**RECOMMENDATION:**\nDo not adopt.\n");
  assert(bold.recommendation === "Do not adopt.", "memo parser: bolded marker tolerated");
  const none = parseMemoSections("I could not synthesize anything useful.");
  assert(!none.recommendation && !none.comparison, "memo parser: absent markers → absent sections");
}

{
  const mk = (kind: string, sourceKind: string): ResearchClaim =>
    ({
      kind,
      text: "t",
      source: "s",
      sourceKind,
      confidence: "high",
      staleness: "stable",
      angle: "a",
      verification: { check: "none", status: "unchecked" },
    }) as ResearchClaim;
  const many = Array.from({ length: ENTAILMENT_CLAIM_CAP + 5 }, () => mk("finding", "url"));
  assert(entailableClaims(many).length === ENTAILMENT_CLAIM_CAP, "entailable: capped");
  assert(
    entailableClaims([mk("finding", "code"), mk("gap", "url"), mk("contradiction", "doc")])
      .length === 1,
    "entailable: only sourced findings/contradictions with url/doc sources (code claims are grounded deterministically)",
  );
}

// ------------------------------------------------------ pipeline (stubs)

interface SeenDispatch {
  label?: string;
  prompt: string;
}
const seen: SeenDispatch[] = [];
let entailReply = "CLAIM-SUPPORT: 1 — full\nCLAIM-SUPPORT: 2 — none\nchecked both.";
let entailFails = false;
let memoFails = false;

function claimCall(kind: string, text: string, source: string, sourceKind: string, angle?: string) {
  return {
    name: "report_research_claim",
    arguments: { kind, text, source, sourceKind, confidence: "high", staleness: "stable", angle },
  };
}

setResearchDispatch(((
  _pi: unknown,
  spec: { role: string; prompt: string },
  opts?: { label?: string },
) => {
  seen.push({ label: opts?.label, prompt: spec.prompt });
  if (opts?.label === "research-entailment") {
    if (entailFails)
      return Promise.resolve({
        role: "explore",
        ok: false,
        text: "",
        toolUses: [],
        ms: 1,
        exitCode: 1,
      });
    return Promise.resolve({
      role: "explore",
      ok: true,
      text: entailReply,
      toolUses: [],
      ms: 1,
      exitCode: 0,
    });
  }
  if (opts?.label === "research-memo-synthesis") {
    if (memoFails)
      return Promise.resolve({
        role: "explore",
        ok: false,
        text: "",
        toolUses: [],
        ms: 1,
        exitCode: 1,
      });
    return Promise.resolve({
      role: "explore",
      ok: true,
      text: "RECOMMENDATION:\nAdopt with conditions: wait out the 4-day embargo.\n\nCOMPARISON:\n| option | cadence |\n|---|---|\n| candidate | weekly |\n",
      toolUses: [],
      ms: 1,
      exitCode: 0,
    });
  }
  // Retrieval angles: two url findings (one whose source the reviewer will
  // refute) — plus signal/alternative claims for the adoption run.
  const isAdoption = (opts?.label ?? "").startsWith("research-adoption");
  const toolUses = isAdoption
    ? [
        claimCall("signal", "scorecard 7.2", "https://a/score", "url", "adoption-signals"),
        claimCall(
          "finding",
          "alt B trades speed for size",
          "https://a/alt",
          "url",
          "adoption-alternatives",
        ),
        claimCall(
          "finding",
          "would replace src/x.ts usage",
          "https://a/fit",
          "url",
          "adoption-fit",
        ),
      ]
    : [
        claimCall("finding", "claim one", "https://a/one", "url"),
        claimCall("finding", "claim two", "https://a/two", "url"),
      ];
  return Promise.resolve({
    role: "explore",
    ok: true,
    text: "summary",
    toolUses,
    ms: 1,
    exitCode: 0,
  });
}) as never);

const execStub: ExecFn = async (cmd) => {
  if (cmd.startsWith("git rev-parse")) return { stdout: "feedbeef\n" };
  return { stdout: "" };
};
const deps = {
  execFn: execStub,
  fetchFn: (async () => ({ status: 200 })) as never,
  vipuneSearchFn: (async () => ({ kind: "hits", hits: [] })) as never,
  memoryWriteFn: (async () => ({ outcome: "written" as const, id: "m1" })) as never,
};
const FAKE_PI = { registerTool: () => {} } as never;

async function freshRepo(): Promise<string> {
  const tmp = await fs.mkdtemp(path.join(os.tmpdir(), "research-deep-"));
  await fs.mkdir(path.join(tmp, ".git"), { recursive: true });
  return tmp;
}

{
  // Deep tier: retrieval angles + exactly one entailment dispatch; verdicts
  // annotate; "none" demotes.
  const tmp = await freshRepo();
  seen.length = 0;
  const r = await runResearchPipeline(
    FAKE_PI,
    { topic: "some deep topic", tier: "deep" },
    tmp,
    deps,
  );
  const entailDispatches = seen.filter((s) => s.label === "research-entailment");
  assert(
    entailDispatches.length === 1,
    `deep: exactly ONE entailment dispatch (got ${entailDispatches.length})`,
  );
  assert(
    seen.filter(
      (s) =>
        (s.label ?? "").startsWith("research-web") || (s.label ?? "").startsWith("research-docs"),
    ).length === 2,
    "deep: retrieval width equals standard (depth pays in verification, not fan-out)",
  );
  assert(r.entailment === "ran", "deep: entailment marked ran");
  const one = r.claims.find((c) => c.text === "claim one");
  const two = r.claims.find((c) => c.text === "claim two");
  assert(one?.support === "full", "deep: full verdict annotated");
  assert(two?.support === "none", "deep: none verdict annotated");
  assert(!r.abstained, "deep: one supported finding remains → not abstained");
  const body = await fs.readFile(r.artifactPath as string, "utf8");
  assert(body.includes("support: none"), "deep: support annotation reaches the artifact rows");
  await fs.rm(tmp, { recursive: true, force: true });
}

{
  // Every finding refuted → abstention (annotation demotes, never upgrades).
  // Both retrieval angles return the same two findings, so FOUR claims reach
  // the entailment pass — all four must be refuted.
  const tmp = await freshRepo();
  entailReply =
    "CLAIM-SUPPORT: 1 — none\nCLAIM-SUPPORT: 2 — none\nCLAIM-SUPPORT: 3 — none\nCLAIM-SUPPORT: 4 — none";
  const r = await runResearchPipeline(FAKE_PI, { topic: "refuted topic", tier: "deep" }, tmp, deps);
  entailReply = "CLAIM-SUPPORT: 1 — full\nCLAIM-SUPPORT: 2 — none\nchecked both.";
  assert(r.abstained === true, "deep: all findings refuted by their own sources → abstained");
  await fs.rm(tmp, { recursive: true, force: true });
}

{
  // Entailment dispatch fails → run completes, marked unavailable, claims unannotated.
  const tmp = await freshRepo();
  entailFails = true;
  const r = await runResearchPipeline(FAKE_PI, { topic: "unlucky topic", tier: "deep" }, tmp, deps);
  entailFails = false;
  assert(
    r.entailment === "unavailable" && !r.halt,
    "deep: failed entailment → unavailable, run completes",
  );
  assert(
    r.claims.every((c) => c.support === undefined),
    "deep: no annotations fabricated",
  );
  const body = await fs.readFile(r.artifactPath as string, "utf8");
  assert(
    body.includes("Entailment pass unavailable"),
    "deep: the artifact discloses the unavailable pass",
  );
  await fs.rm(tmp, { recursive: true, force: true });
}

{
  // Adoption tier: fixed trio + one synthesis dispatch; memo layout with the
  // verbatim recommendation; signals/alternatives/fit sectioned by angle.
  const tmp = await freshRepo();
  seen.length = 0;
  const r = await runResearchPipeline(
    FAKE_PI,
    { topic: "adopt libfoo?", tier: "adoption" },
    tmp,
    deps,
  );
  assert(
    seen
      .filter((s) => (s.label ?? "").startsWith("research-adoption"))
      .map((s) => s.label)
      // Labels are clipped to 24 chars at the dispatch site.
      .join(",") === "research-adoption-signal,research-adoption-altern,research-adoption-fit",
    `adoption: the fixed three-angle set dispatched (got ${seen.map((s) => s.label).join(",")})`,
  );
  assert(
    seen.filter((s) => s.label === "research-memo-synthesis").length === 1,
    "adoption: exactly one synthesis dispatch",
  );
  const body = await fs.readFile(r.artifactPath as string, "utf8");
  assert(body.startsWith("# Adoption memo: adopt libfoo?"), "adoption: memo-titled artifact");
  assert(
    body.includes("Adopt with conditions: wait out the 4-day embargo."),
    "adoption: synthesis recommendation embedded verbatim",
  );
  assert(body.includes("| candidate | weekly |"), "adoption: comparison table embedded");
  assert(
    body.includes("## Signals") && body.includes("scorecard 7.2"),
    "adoption: signals sectioned",
  );
  assert(
    body.includes("## Alternatives") && body.includes("alt B trades speed"),
    "adoption: alternatives sectioned by angle",
  );
  assert(
    body.includes("## Integration fit") && body.includes("would replace src/x.ts"),
    "adoption: fit sectioned by angle",
  );
  await fs.rm(tmp, { recursive: true, force: true });
}

{
  // Synthesis fails → memo says so; the driver never fabricates a recommendation.
  const tmp = await freshRepo();
  memoFails = true;
  const r = await runResearchPipeline(
    FAKE_PI,
    { topic: "adopt libbar?", tier: "adoption" },
    tmp,
    deps,
  );
  memoFails = false;
  const body = await fs.readFile(r.artifactPath as string, "utf8");
  assert(
    body.includes(
      "(synthesis unavailable — decide from the signals, alternatives and fit findings below)",
    ),
    "adoption: failed synthesis leaves the decision to the operator",
  );
  assert(!r.halt, "adoption: failed synthesis does not halt the run");
  await fs.rm(tmp, { recursive: true, force: true });
}

setResearchDispatch(null);

console.log(`\nexit ${exit}`);
process.exit(exit);
