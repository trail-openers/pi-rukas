#!/usr/bin/env bun
/**
 * /research wigolo fallback (#773) — driver-level blocks: the
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
  // #893 — the stub returns toolUses: [] (0 raw report_research_claim calls)
  // for the failed angle, so the all-silent distinction fires: the halt
  // reason is reporter-silent, not no-structured-claims.
  assert(r.halt?.reason === "reporter-silent", "all-angles-silent (0 raw calls) → reporter-silent halt");
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
    const prose = "the parallel search returned a plausible result set but credit ran out; ".repeat(35);
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
  const rLong = await runResearchPipeline(FAKE_PI, { topic: "what is a thing", tier: "quick" }, tmp, deps);
  const webDispatches = longSeen.filter((s) => s.label === "research-web-current");
  assert(webDispatches.length === 2, `long reply with trailing marker still re-dispatches (got ${webDispatches.length} dispatches)`);
  assert(/WIGOLO CLI/.test(webDispatches[1]?.prompt ?? ""), "second attempt is wigolo-framed after the long credit-exhausted reply");
  assert(rLong.angles[0]?.backend === "wigolo", "long-reply angle carries backend: wigolo");
  setResearchDispatch(null);
  await fs.rm(tmp, { recursive: true, force: true });
}

{
  // codebase angle: NO wigolo equivalent → no re-dispatch, stays parallel,
  // summary records the no-fallback decision, other angle and artifact intact.
  // (A PM-supplied angle gets a custom-N name, which is now web-capable; to
  // pin the no-fallback path we use the codebase derivation — topic naming
  // code triggers the codebase angle, and codebase maps to `none`.)
  setResearchDispatch(driverStub);
  const tmp = await freshRepo();
  seen.length = 0;
  failAngle = "codebase";
  const r2 = await runResearchPipeline(
    FAKE_PI,
    {
      topic: "what is a thing in src/x.ts",
      tier: "standard",
    },
    tmp,
    deps,
  );
  assert(r2.halt === undefined, "pipeline completed when codebase angle fails (no re-dispatch)");
  const codebase = r2.angles.find((x) => x.name === "codebase");
  assert(codebase !== undefined, `codebase angle present (angles: ${r2.angles.map((x) => x.name).join(",")})`);
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
  assert(/\*\*docs-depth\*\* \(ok\):/.test(body), "artifact renders the other angle's summary");
  await fs.rm(tmp, { recursive: true, force: true });
}

{
  // #896 — custom-N angle: web-capable → a credit-exhausted failure is
  // re-dispatched ONCE wigolo-framed (search surface), like the derived
  // web angles. A non-web classified failure (unparseable) never triggers.
  setResearchDispatch(driverStub);
  const tmp = await freshRepo();
  seen.length = 0;
  failAngle = "custom-1";
  const r3 = await runResearchPipeline(
    FAKE_PI,
    {
      topic: "what is a thing",
      tier: "standard",
      angles: ["a custom angle: investigate X", "another: investigate Y"],
    },
    tmp,
    deps,
  );
  const customDispatches = seen.filter((s) => s.label === "research-custom-1");
  assert(
    customDispatches.length === 2,
    `#896: custom-N credit-exhausted re-dispatched once (got ${customDispatches.length})`,
  );
  assert(
    /WIGOLO CLI/.test(customDispatches[1]?.prompt ?? "") &&
      /wigolo search/.test(customDispatches[1]?.prompt ?? ""),
    "#896: second attempt is wigolo-framed (search surface) for the custom angle",
  );
  assert(r3.angles.find((x) => x.name === "custom-1")?.backend === "wigolo", "#896: custom angle carries backend: wigolo");
  assert(r3.angles.find((x) => x.name === "custom-1")?.ok === true, "#896: custom angle ok after wigolo re-dispatch");

  // Non-web classified failure (unparseable) → no wigolo re-dispatch, even
  // for a web-capable custom angle (selectFallback keeps parallel).
  seen.length = 0;
  let unparseableSeen: string[] = [];
  setResearchDispatch(((_pi: unknown, spec: { prompt: string }, opts?: { label?: string }) => {
    const label = opts?.label ?? "";
    const isWigolo = spec.prompt.includes("WIGOLO CLI");
    unparseableSeen.push(`${label}:${isWigolo ? "w" : "p"}`);
    if (label === "research-custom-1" && !isWigolo)
      return Promise.resolve({
        role: "explore",
        ok: true,
        text: "totally unrelated prose with no markers at all",
        toolUses: [],
      });
    return Promise.resolve({
      role: "explore",
      ok: true,
      text: isWigolo ? "found via wigolo\nbackend: wigolo" : "found via parallel",
      toolUses: [claimCall("a claim", "https://a/live")],
    });
  }) as never);
  const r4 = await runResearchPipeline(
    FAKE_PI,
    {
      topic: "what is a thing",
      tier: "standard",
      angles: ["a custom angle: investigate X", "another: investigate Y"],
    },
    tmp,
    deps,
  );
  assert(
    r4.angles.find((x) => x.name === "custom-1")?.backend === "parallel",
    "#896: custom angle unparseable → stays parallel (no wigolo re-dispatch)",
  );
  assert(unparseableSeen.filter((s) => s.includes("research-custom-1")).length === 1, "#896: exactly one custom-N dispatch (no loop)");
  assert(
    r4.angles.find((x) => x.name === "custom-1")?.summary.includes("keep-parallel"),
    "#896: summary records the keep-parallel decision",
  );
  setResearchDispatch(driverStub);
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
