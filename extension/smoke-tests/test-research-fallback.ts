#!/usr/bin/env bun
/**
 * /research wigolo fallback (#773) — offline: the classifier, the selector
 * matrix, the angle→surface map, the dispatch-time line, and the driver
 * re-dispatch loop (stubbed dispatch): a credit-exhausted angle is
 * re-dispatched ONCE wigolo-framed, its AngleRun carries `backend: wigolo`,
 * and a second failure does not loop.
 *
 * Plus: the dispatch-time line reflects the flag (enabled / disabled via
 * PI_ENSEMBLE_RESEARCH_FALLBACK=0), the flag is absent from the sandbox
 * forwarding (bin/pi-rukas blocklists `PI_ENSEMBLE_*`), and an empty
 * Parallel result NEVER falls back.
 */

import { readFileSync } from "node:fs";
import os from "node:os";
import { promises as fs } from "node:fs";
import path from "node:path";
import {
  classifyParallelOutcome,
  researchFallbackLine,
  selectFallback,
  surfaceForAngle,
  type FallbackDecision,
  type ParallelOutcome,
  type WigoloSurface,
} from "../src/research-fallback.ts";
import { runResearchPipeline, setResearchDispatch } from "../src/research-driver.ts";
import type { ExecFn } from "../src/worktree.ts";

let exit = 0;
function assert(cond: boolean, msg: string) {
  if (cond) console.log(`✓ ${msg}`);
  else {
    console.error(`✗ ${msg}`);
    exit = 1;
  }
}

// ---------------------------------------------------------------- classifier

{
  assert(
    classifyParallelOutcome("Insufficient credit") === "credit-exhausted",
    "classifier: verbatim `Insufficient credit` → credit-exhausted (the anchor)",
  );
  assert(
    classifyParallelOutcome("parallel-outcome: credit-exhausted") === "credit-exhausted",
    "classifier: token via the marker",
  );
  assert(
    classifyParallelOutcome("parallel-outcome: auth-missing") === "auth-missing",
    "classifier: auth-missing",
  );
  assert(
    classifyParallelOutcome("parallel-outcome: network-failed") === "network-failed",
    "classifier: network-failed",
  );
  assert(
    classifyParallelOutcome("blocked_by_challenge") === "network-failed",
    "classifier: wigolo blocked_by_challenge → network-failed, NOT empty",
  );
  assert(
    classifyParallelOutcome("parallel-outcome: empty-result") === "empty-result",
    "classifier: empty-result",
  );
  assert(classifyParallelOutcome("parallel-outcome: success") === "success", "classifier: success");
  assert(
    classifyParallelOutcome("parallel-outcome: success\nthe request got HTTP 401 from upstream") ===
      "success",
    "classifier: `success` marker beats a bare 401 in the prose (marker is authoritative)",
  );
  assert(
    classifyParallelOutcome("parallel-outcome: garbage-token") === "unparseable",
    "classifier: marker outside the six-token set is treated as absent",
  );
  assert(
    classifyParallelOutcome("the network latency was high but the fetch succeeded") ===
      "unparseable",
    "classifier: prose mentioning 'network latency' with no marker → unparseable",
  );
  assert(
    classifyParallelOutcome("the endpoint answered HTTP 401, retrying") === "unparseable",
    "classifier: prose mentioning 'HTTP 401' with no marker → unparseable",
  );
  assert(
    classifyParallelOutcome("a parallel task got cancelled mid-stream") === "unparseable",
    "classifier: prose mentioning the token 'parallel' is not a marker",
  );
  assert(
    classifyParallelOutcome("") === "unparseable",
    "classifier: empty → unparseable (never success)",
  );
  assert(
    classifyParallelOutcome("totally unrelated prose") === "unparseable",
    "classifier: no anchor → unparseable",
  );
  // Last occurrence wins (readMarker doctrine, #408): a musing earlier in
  // the reply must not be read as the outcome.
  const both = "parallel-outcome: success\n...\nparallel-outcome: credit-exhausted";
  assert(
    classifyParallelOutcome(both) === "credit-exhausted",
    "classifier: last parallel-outcome marker wins",
  );
  // An unanchored mention of a class word in prose is NOT a classification.
  assert(
    classifyParallelOutcome("the credit card API is fine") === "unparseable",
    "classifier: unanchored prose mentioning 'credit' → unparseable",
  );
}

// ----------------------------------------------------------------- selector

{
  const on = true;
  assert(
    selectFallback("credit-exhausted", "search", on) === "fall-back-to-wigolo",
    "selector: credit → fall-back",
  );
  assert(
    selectFallback("auth-missing", "fetch", on) === "fall-back-to-wigolo",
    "selector: auth → fall-back",
  );
  assert(
    selectFallback("network-failed", "research", on) === "fall-back-to-wigolo",
    "selector: network → fall-back",
  );
  assert(
    selectFallback("success", "search", on) === "keep-parallel",
    "selector: success → keep (no re-dispatch of a success)",
  );
  assert(
    selectFallback("empty-result", "search", on) === "keep-parallel",
    "selector: empty result is a valid answer → keep, NEVER fall back",
  );
  assert(
    selectFallback("unparseable", "search", on) === "keep-parallel",
    "selector: unparseable → keep (never success, never a trigger)",
  );
  assert(
    selectFallback("credit-exhausted", "search", false) === "keep-parallel",
    "selector: flag 0 → never fall back",
  );
  assert(
    selectFallback("auth-missing", "search", false) === "keep-parallel",
    "selector: flag 0 → never (auth)",
  );
  assert(
    selectFallback("network-failed", "search", false) === "keep-parallel",
    "selector: flag 0 → never (network)",
  );
  for (const s of ["monitor", "findall", "enrichment"] as const) {
    assert(
      selectFallback("credit-exhausted", s, on) === "no-fallback-available",
      `selector: ${s} → no-fallback-available (no wigolo equivalent)`,
    );
  }
  assert(
    selectFallback("credit-exhausted", "monitor", false) === "keep-parallel",
    "selector: flag 0 beats even no-fallback",
  );
}

// ----------------------------------------------------------- surface map

{
  assert(surfaceForAngle("web-current") === "search", "surface: web-current → search");
  assert(surfaceForAngle("adoption-signals") === "search", "surface: adoption-signals → search");
  assert(surfaceForAngle("adoption-alternatives") === "search", "surface: alternatives → search");
  assert(surfaceForAngle("docs-depth") === "fetch", "surface: docs-depth → fetch");
  assert(surfaceForAngle("deep-dive") === "research", "surface: deep tier → research");
  assert(surfaceForAngle("codebase") === "none", "surface: codebase angle → none (no re-dispatch)");
  assert(surfaceForAngle("custom-1") === "none", "surface: custom-N angle → none");
  assert(surfaceForAngle("mystery-angle") === "none", "surface: unknown angle → none, not search");
  assert(
    selectFallback("credit-exhausted", "none", true) === "no-fallback-available",
    "selector: surface none → no-fallback-available",
  );
  assert(
    selectFallback("network-failed", "none", true) === "no-fallback-available",
    "selector: codebase failure never re-dispatches (no-fallback-available)",
  );
}

// -------------------------------------------------------- dispatch-time line

{
  assert(researchFallbackLine(true) === "research fallback: enabled\n", "line: enabled form");
  assert(researchFallbackLine(false) === "research fallback: disabled\n", "line: disabled form");
}

// ------------------------------------------------------------------ driver

interface SeenDispatch {
  label?: string;
  prompt: string;
}
const seen: SeenDispatch[] = [];
let failAngle: string | undefined;
let wigoloFails = false;
let rejectOnWigolo = false;

function claimCall(text: string, source: string) {
  return {
    name: "report_research_claim",
    arguments: {
      kind: "finding",
      text,
      source,
      sourceKind: "url",
      confidence: "high",
      staleness: "stable",
    },
  };
}

const driverStub = ((_pi: unknown, spec: { prompt: string }, opts?: { label?: string }) => {
  const label = opts?.label ?? "";
  const isWigolo = spec.prompt.includes("WIGOLO CLI") || spec.prompt.includes("wigolo fallback");
  seen.push({ label, prompt: spec.prompt, isWigolo } as SeenDispatch);
  const failedLabel = `research-${failAngle ?? ""}`.slice(0, 24);
  const failed = label === failedLabel && (isWigolo ? wigoloFails || rejectOnWigolo : true);
  if (failed) {
    if (isWigolo && rejectOnWigolo)
      return Promise.reject(new Error("stub: wigolo dispatch exploded"));
    return Promise.resolve({
      role: "explore",
      ok: true,
      text: "parallel failed\nparallel-outcome: credit-exhausted",
      toolUses: [],
    });
  }
  return Promise.resolve({
    role: "explore",
    ok: true,
    text: isWigolo ? "found it via wigolo\nbackend: wigolo" : "found it via parallel",
    toolUses: [claimCall("the claim holds", "https://a/live")],
  });
}) as never;

const execStub: ExecFn = async (cmd) => {
  if (cmd.startsWith("git rev-parse")) return { stdout: "feedbeef12345\n" };
  return { stdout: "" };
};
const fetchStub = (async () => ({ status: 200 })) as never;
const searchStub = (async () => ({ kind: "hits", hits: [] })) as never;
const memoryStub = (async () => ({ outcome: "written" as const, id: "m1" })) as never;
const FAKE_PI = { registerTool: () => {} } as never;
const deps = {
  execFn: execStub,
  fetchFn: fetchStub,
  vipuneSearchFn: searchStub,
  memoryWriteFn: memoryStub,
};

async function freshRepo(): Promise<string> {
  const tmp = await fs.mkdtemp(path.join(os.tmpdir(), "research-fb-"));
  await fs.mkdir(path.join(tmp, ".git"), { recursive: true });
  return tmp;
}

{
  // credit-exhausted angle → re-dispatched ONCE wigolo-framed, backend wigolo.
  setResearchDispatch(driverStub);
  const tmp = await freshRepo();
  seen.length = 0;
  failAngle = "web-current";
  const r = await runResearchPipeline(
    FAKE_PI,
    { topic: "what is a thing", tier: "quick" },
    tmp,
    deps,
  );
  const webDispatches = seen.filter((s) => s.label === "research-web-current");
  assert(
    webDispatches.length === 2,
    `credit-exhausted angle re-dispatched once (got ${webDispatches.length} dispatches)`,
  );
  assert(!/WIGOLO/.test(webDispatches[0]?.prompt ?? ""), "first attempt uses the Parallel recipe");
  assert(
    /WIGOLO CLI/.test(webDispatches[1]?.prompt ?? "") &&
      /wigolo search/.test(webDispatches[1]?.prompt ?? ""),
    "second attempt is wigolo-framed (search surface)",
  );
  assert(
    r.angles[0]?.backend === "wigolo",
    `AngleRun carries backend: wigolo (got ${r.angles[0]?.backend})`,
  );
  assert(r.angles[0]?.ok === true, "angle is ok after the wigolo re-dispatch succeeds");
  assert(r.claims.length === 1, "claim from the wigolo attempt extracted");
  const body = await fs.readFile(r.artifactPath as string, "utf8");
  assert(body.includes("· wigolo"), "artifact angle summary renders the backend");
  await fs.rm(tmp, { recursive: true, force: true });
}

{
  // Second failure does NOT loop: wigolo fails too → still 2 dispatches only.
  const tmp = await freshRepo();
  seen.length = 0;
  failAngle = "web-current";
  wigoloFails = true;
  const r = await runResearchPipeline(
    FAKE_PI,
    { topic: "what is a thing", tier: "quick" },
    tmp,
    deps,
  );
  const webDispatches = seen.filter((s) => s.label === "research-web-current");
  assert(
    webDispatches.length === 2,
    `a second failure does not loop (got ${webDispatches.length} dispatches)`,
  );
  assert(r.angles[0]?.ok === false, "angle stays failed after wigolo also fails");
  assert(r.halt?.reason === "no-structured-claims", "all-angles-failed → the infra halt");
  wigoloFails = false;
  await fs.rm(tmp, { recursive: true, force: true });
}

{
  // empty-result → NEVER falls back, even when the flag is on.
  const tmp = await freshRepo();
  seen.length = 0;
  const emptySeen: SeenDispatch[] = [];
  setResearchDispatch(((_pi: unknown, spec: { prompt: string }, opts?: { label?: string }) => {
    emptySeen.push({ label: opts?.label, prompt: spec.prompt });
    return Promise.resolve({
      role: "explore",
      ok: true,
      text: "nothing found\nparallel-outcome: empty-result",
      toolUses: [],
      ms: 1,
      exitCode: 0,
    });
  }) as never);
  await runResearchPipeline(FAKE_PI, { topic: "what is a thing", tier: "quick" }, tmp, deps);
  const webDispatches = emptySeen.filter((s) => s.label === "research-web-current");
  assert(
    webDispatches.length === 1,
    `empty-result never falls back (got ${webDispatches.length} dispatches)`,
  );
  assert(!webDispatches[0]?.prompt.includes("WIGOLO"), "no wigolo framing on an empty result");
  await fs.rm(tmp, { recursive: true, force: true });
  setResearchDispatch(null);
}

{
  // A REJECTING wigolo retry (web-current angle): the angle is a failed
  // AngleRun (ok false, claims [], backend wigolo, a failure naming the
  // rejection) — the single-angle pipeline halts with the failure recorded.
  setResearchDispatch(driverStub);
  const tmp = await freshRepo();
  seen.length = 0;
  failAngle = "web-current";
  rejectOnWigolo = true;
  const r = await runResearchPipeline(
    FAKE_PI,
    { topic: "what is a thing", tier: "quick" },
    tmp,
    deps,
  );
  assert(r.halt !== undefined, "single angle: pipeline halts when the only angle rejects");
  const rejected = r.angles[0];
  assert(rejected?.name === "web-current", "angle is web-current");
  assert(rejected?.ok === false, "rejection angle is not ok");
  assert((rejected?.claims.length ?? 1) === 0, "rejection angle has no claims");
  assert(rejected?.backend === "wigolo", "rejection angle keeps its wigolo backend");
  assert(
    rejected?.failure === "stub: wigolo dispatch exploded",
    `failure names the rejection (got ${rejected?.failure})`,
  );
  rejectOnWigolo = false;
  await fs.rm(tmp, { recursive: true, force: true });
}

{
  // Long-reply marker: a 2,000-char prose reply whose LAST line carries the
  // credit-exhausted marker must still trigger the wigolo re-dispatch — the
  // classifier runs on the full reply, not the 500-char summary (#773 fix).
  const tmp = await freshRepo();
  const longSeen: SeenDispatch[] = [];
  const longStub = ((_pi: unknown, spec: { prompt: string }, opts?: { label?: string }) => {
    const label = opts?.label ?? "";
    const isWigolo = spec.prompt.includes("WIGOLO CLI") || spec.prompt.includes("wigolo fallback");
    const fail = label === "research-web-current" && !isWigolo;
    longSeen.push({ label, prompt: spec.prompt } as SeenDispatch);
    const prose = "the parallel search returned a plausible result set but credit ran out; ".repeat(
      35,
    );
    const text = fail
      ? `${prose.slice(0, 1990)} parallel-outcome: credit-exhausted`
      : isWigolo
        ? "found it via wigolo\nbackend: wigolo"
        : "found it via parallel";
    return Promise.resolve({
      role: "explore",
      ok: true,
      text,
      toolUses: fail ? [] : [claimCall("the claim holds", "https://a/live")],
    });
  }) as never;
  setResearchDispatch(longStub);
  const rLong = await runResearchPipeline(
    FAKE_PI,
    { topic: "what is a thing", tier: "quick" },
    tmp,
    deps,
  );
  const webDispatches = longSeen.filter((s) => s.label === "research-web-current");
  assert(
    webDispatches.length === 2,
    `long reply with trailing marker still re-dispatches (got ${webDispatches.length} dispatches)`,
  );
  assert(
    /WIGOLO CLI/.test(webDispatches[1]?.prompt ?? ""),
    "second attempt is wigolo-framed after the long credit-exhausted reply",
  );
  assert(rLong.angles[0]?.backend === "wigolo", "long-reply angle carries backend: wigolo");
  setResearchDispatch(null);
  await fs.rm(tmp, { recursive: true, force: true });
}

{
  // codebase angle: NO wigolo equivalent → no re-dispatch, stays parallel,
  // summary records the no-fallback decision, other angle and artifact intact.
  setResearchDispatch(driverStub);
  const tmp = await freshRepo();
  seen.length = 0;
  failAngle = "custom-1";
  const r2 = await runResearchPipeline(
    FAKE_PI,
    {
      topic: "what is a thing",
      tier: "standard",
      angles: ["codebase: establish the current state", "web-current: establish the docs depth"],
    },
    tmp,
    deps,
  );
  assert(r2.halt === undefined, "pipeline completed when codebase angle fails (no re-dispatch)");
  const codebase = r2.angles.find((x) => x.name === "custom-1");
  assert(codebase !== undefined, "codebase angle present");
  assert(codebase?.ok === false, "codebase angle is not ok");
  assert((codebase?.claims.length ?? 1) === 0, "codebase angle has no claims");
  assert(codebase?.backend === "parallel", "codebase angle stays on parallel (no re-dispatch)");
  assert(
    codebase?.summary.includes("no-fallback-available"),
    `summary records the no-fallback decision (got ${codebase?.summary.slice(0, 100)})`,
  );
  const other = r2.angles.find((x) => x.ok);
  assert(other !== undefined && other?.claims.length === 1, "the other angle is intact");
  assert(r2.claims.length === 1, "the surviving claim reached the result");
  const body = await fs.readFile(r2.artifactPath as string, "utf8");
  assert(body.includes("no-fallback-available"), "artifact renders the no-fallback decision");
  assert(/\*\*custom-2\*\* \(ok\):/.test(body), "artifact renders the other angle's summary");
  await fs.rm(tmp, { recursive: true, force: true });
}

// ------------------------------------------------------- dispatch-time flag

{
  const tmp = await freshRepo();
  const seenOn: SeenDispatch[] = [];
  setResearchDispatch(((_pi: unknown, spec: { prompt: string }) => {
    seenOn.push({ prompt: spec.prompt });
    return Promise.resolve({
      role: "explore",
      ok: true,
      text: "ok",
      toolUses: [claimCall("c", "https://a/live")],
      ms: 1,
      exitCode: 0,
    });
  }) as never);
  delete process.env.PI_ENSEMBLE_RESEARCH_FALLBACK;
  await runResearchPipeline(FAKE_PI, { topic: "t", tier: "quick" }, tmp, deps);
  assert(
    seenOn.every((s) => s.prompt.startsWith("research fallback: enabled\n")),
    "dispatch-time line `research fallback: enabled` (flag unset = on)",
  );

  process.env.PI_ENSEMBLE_RESEARCH_FALLBACK = "0";
  seenOn.length = 0;
  await runResearchPipeline(FAKE_PI, { topic: "t", tier: "quick" }, tmp, deps);
  assert(
    seenOn.every((s) => s.prompt.startsWith("research fallback: disabled\n")),
    "dispatch-time line `research fallback: disabled` (flag 0)",
  );
  delete process.env.PI_ENSEMBLE_RESEARCH_FALLBACK;
  setResearchDispatch(null);
  await fs.rm(tmp, { recursive: true, force: true });
}

{
  // The flag is host-side only: bin/pi-rukas blocklists PI_ENSEMBLE_* from
  // the wholesale sandbox env passthrough, so the flag never crosses the
  // boundary (the recipe stays static, the line is the only per-run diff).
  const bin = readFileSync(
    path.resolve(import.meta.dirname, "..", "..", "bin", "pi-rukas"),
    "utf8",
  );
  assert(
    /PI_ENSEMBLE_\*/.test(bin) && /continue/.test(bin),
    "bin/pi-rukas: PI_ENSEMBLE_* is on the blocklist (host-side flag never forwarded)",
  );
  assert(
    !/PI_ENSEMBLE_RESEARCH_FALLBACK/.test(bin),
    "bin/pi-rukas: no special-casing of PI_ENSEMBLE_RESEARCH_FALLBACK (it rides the pattern)",
  );
}

console.log(`\nexit ${exit}`);
process.exit(exit);
