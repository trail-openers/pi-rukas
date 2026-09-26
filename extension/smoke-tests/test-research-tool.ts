#!/usr/bin/env bun
/**
 * start_research_driver — registration, the three-edits grant, and the
 * compiled pipeline end-to-end through injected seams (no git, no HTTP, no
 * vipune binary, dispatch stubbed).
 *
 * Pins: the TypeBox schema; the agents.json PM grant; tier→angle counts
 * (standard derives web+docs+codebase-iff-code-named, quick = 1, custom
 * angles win); every dispatch bounded + cwd-pinned + carrying the
 * research-reporter extension; claims extracted from tool calls only;
 * artifact + provenance land under <repoRoot>/outputs/ with the
 * info/exclude write; the all-angles-empty halt; the abstention path; and
 * per-phase timings.
 */

import { promises as fs } from "node:fs";
import { readFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  RESEARCH_DISPATCH_TIMEOUT_MS,
  runResearchPipeline,
  setResearchDispatch,
} from "../src/research-driver.ts";
import { registerResearchTool } from "../src/research-tool.ts";
import type { ExecFn } from "../src/worktree.ts";

let exit = 0;
function assert(cond: boolean, msg: string) {
  if (cond) console.log(`✓ ${msg}`);
  else {
    console.error(`✗ ${msg}`);
    exit = 1;
  }
}

// ---------------------------------------------------------- registration

interface Registered {
  name: string;
  description: string;
  parameters: { properties?: Record<string, unknown> };
}
const tools: Registered[] = [];
// biome-ignore lint/suspicious/noExplicitAny: minimal stub; only registerTool is used
registerResearchTool({ registerTool: (d: Registered) => void tools.push(d) } as any);

{
  const t = tools.find((x) => x.name === "start_research_driver");
  assert(!!t, "start_research_driver registers");
  const props = Object.keys(t?.parameters.properties ?? {});
  assert(
    props.join(",") === "topic,tier,angles,context",
    `exact TypeBox schema: ${props.join(", ")}`,
  );
  assert(
    /artifact/.test(t?.description ?? "") && /abstention|verified/i.test(t?.description ?? ""),
    "description names the artifact and the abstention behaviour",
  );
}

{
  // Three-edits rule: the agents.json PM grant (test-pm-tool-permissions
  // enforces the general invariant; this pins the specific grant).
  const agents = JSON.parse(
    readFileSync(path.resolve(import.meta.dirname, "..", "..", "agents.json"), "utf8"),
  ) as { agent?: Record<string, { permission?: Record<string, unknown> }> };
  const perm = agents.agent?.["project-manager"]?.permission ?? {};
  assert(
    perm.start_research_driver === "allow",
    "agents.json: start_research_driver granted to PM",
  );
}

// ------------------------------------------------------------- pipeline

interface SeenDispatch {
  role: string;
  prompt: string;
  cwd?: string;
  label?: string;
  timeoutMs?: number;
  extraArgs?: string[];
}
const seen: SeenDispatch[] = [];
let claimMode: "normal" | "empty" | "schema-invalid" | "gaps-only" = "normal";

function claimCall(kind: string, text: string, source: string, sourceKind: string) {
  return {
    name: "report_research_claim",
    arguments: { kind, text, source, sourceKind, confidence: "high", staleness: "stable" },
  };
}

setResearchDispatch(((
  _pi: unknown,
  spec: { role: string; prompt: string; cwd?: string },
  opts?: { label?: string; timeoutMs?: number; extraArgs?: string[] },
) => {
  seen.push({ role: spec.role, prompt: spec.prompt, cwd: spec.cwd, ...opts });
  const toolUses =
    claimMode === "empty"
      ? []
      : claimMode === "schema-invalid"
        ? [{ name: "report_research_claim", arguments: { kind: "finding", text: "" } }]
        : claimMode === "gaps-only"
          ? [claimCall("gap", "could not answer", "none", "none")]
          : [
              claimCall("finding", "the scoring is RRF", "https://a/live", "url"),
              claimCall("finding", "seam exists", "src/x.ts#seamFn", "code"),
              claimCall("finding", "URL mislabelled as code", "https://a/mislabeled", "code"),
              claimCall("contradiction", "A says 1, B says 2", "https://a/bot", "url"),
              { name: "report_research_claim", arguments: { kind: "finding", text: "" } }, // invalid → dropped
              { name: "other_tool", arguments: {} }, // foreign → ignored
            ];
  return Promise.resolve({
    role: "explore",
    ok: true,
    text: "short prose summary of the angle",
    toolUses,
    ms: 1,
    exitCode: 0,
  });
}) as never);

const execStub: ExecFn = async (cmd) => {
  if (cmd.startsWith("git rev-parse")) return { stdout: "feedbeef12345\n" };
  if (cmd.startsWith("git cat-file")) return { stdout: "" };
  if (cmd.startsWith("git grep")) {
    if (cmd.includes("seamFn") && cmd.includes("src/x.ts")) return { stdout: "hit\n" };
    throw new Error("exit 1");
  }
  throw new Error(`unexpected: ${cmd}`);
};
const fetchStub = (async (url: string) => ({
  status: url.includes("bot") ? 403 : url.includes("dead") ? 404 : 200,
})) as never;
const searchStub = (async () => ({ kind: "hits", hits: [] })) as never;
let memoryCalls = 0;
let lastTakeaway: string | undefined;
const memoryStub = (async (args: { takeaway: string }) => {
  memoryCalls++;
  lastTakeaway = args.takeaway;
  return { outcome: "written" as const, id: "m1" };
}) as never;

const FAKE_PI = { registerTool: () => {} } as never;
const deps = {
  execFn: execStub,
  fetchFn: fetchStub,
  vipuneSearchFn: searchStub,
  memoryWriteFn: memoryStub,
};

async function freshRepo(): Promise<string> {
  const tmp = await fs.mkdtemp(path.join(os.tmpdir(), "research-tool-"));
  await fs.mkdir(path.join(tmp, ".git"), { recursive: true });
  return tmp;
}

{
  // Standard tier, topic naming code → web + docs + codebase angles.
  const tmp = await freshRepo();
  seen.length = 0;
  const r = await runResearchPipeline(
    FAKE_PI,
    { topic: "how vipune scoring reaches src/x.ts in this repo" },
    tmp,
    deps,
  );
  assert(
    seen.map((s) => s.label).join(",") ===
      "research-web-current,research-docs-depth,research-codebase",
    `standard tier derives web+docs+codebase when the topic names code (got ${seen.map((s) => s.label).join(",")})`,
  );
  for (const s of seen) {
    assert(s.timeoutMs === RESEARCH_DISPATCH_TIMEOUT_MS, `bounded dispatch: ${s.label}`);
    assert(s.cwd === tmp, `cwd pinned: ${s.label}`);
    assert(
      (s.extraArgs ?? []).includes("--no-skills") && (s.extraArgs ?? []).includes("--extension"),
      `reporter extension + --no-skills: ${s.label}`,
    );
    assert(s.role === "explore", `explore role: ${s.label}`);
  }
  assert(
    r.claims.length === 4,
    `claims extracted + deduplicated across angles (12 raw → 4 unique; got ${r.claims.length})`,
  );
  // #896 — dedup: the four unique claims keep their angle attribution,
  // and the surviving claim's angles carry every contributor.
  const rrf = r.claims.find((c) => c.text === "the scoring is RRF");
  assert(
    rrf?.angles?.join(",") === "web-current,docs-depth,codebase",
    `dedup: merged claim attributes all three angles (got ${rrf?.angles?.join(",")})`,
  );
  assert(
    rrf?.angle === "web-current",
    "dedup: angle field stays the survivor's (first encountered)",
  );
  assert(rrf?.confidence === "high", "dedup: survivor's confidence kept");
  // The raw/unique count line lands in the artifact + provenance headers.
  const bodyAfterCount = await fs.readFile(r.artifactPath as string, "utf8");
  assert(
    bodyAfterCount.includes("**Claims:** 12 reported, 4 unique after deduplication"),
    `count line: artifact body (header: ${bodyAfterCount.split("\n").slice(0, 6).join(" | ")})`,
  );
  const prov = await fs.readFile(r.provenancePath as string, "utf8");
  assert(
    prov.includes("**Claims:** 12 reported, 4 unique after deduplication"),
    "count line: provenance sidecar header reports raw vs unique",
  );
  assert(
    prov.includes("angles: web-current, docs-depth, codebase"),
    "provenance rows show merged angles",
  );
  // The codebase-tools decision (ACCEPT all-angle forwarding): the research
  // dispatches carry no discovery-disabling flag, and the codebase/adoption-fit
  // angle prompts are conditional ("if available") rather than promising the
  // tools unconditionally.
  assert(
    seen.every(
      (s) =>
        !s.extraArgs?.includes("--no-extensions") &&
        !s.extraArgs?.includes("PI_ENSEMBLE_DISABLE_EXTENSION_FORWARD"),
    ),
    "codebase tools: dispatches carry no discovery-disabling flag (installed extensions still forwarded)",
  );
  const codebasePrompt = seen.find((s) => s.label === "research-codebase")?.prompt ?? "";
  assert(
    /codebase_memory_search_code/.test(codebasePrompt) &&
      /if.*available/i.test(codebasePrompt) &&
      /fall back to grep\/read/i.test(codebasePrompt),
    "codebase tools: codebase angle prompt is conditional (if available / grep-read fallback)",
  );
  assert(r.pinnedCommit === "feedbeef12345", "pinned commit from exec stub");
  const live = r.claims.find((c) => c.source === "https://a/live");
  assert(
    live?.verification.check === "url-liveness" && live.verification.status === "live",
    "url claim verified live",
  );
  const code = r.claims.find((c) => c.source === "src/x.ts#seamFn");
  assert(
    code?.verification.check === "code-grounding" && code.verification.status === "grounded",
    "code claim grounded at the pinned commit (cat-file + scoped grep)",
  );
  // End-to-end: an https URL the child labelled "code" is liveness-checked
  // (content classification beats the child's label), not code-grounded.
  const mislabeled = r.claims.find((c) => c.source === "https://a/mislabeled");
  assert(
    mislabeled?.verification.check === "url-liveness" && mislabeled.verification.status === "live",
    "https URL labelled 'code' is liveness-checked end-to-end (driver classification)",
  );
  assert(!r.abstained && !r.halt, "verified findings → no abstention, no halt");
  assert(!!r.artifactPath && !!r.provenancePath, "artifact + provenance paths returned");
  const body = await fs.readFile(r.artifactPath as string, "utf8");
  assert(body.includes("the scoring is RRF"), "artifact written with the findings");
  const exclude = await fs.readFile(path.join(tmp, ".git", "info", "exclude"), "utf8");
  assert(exclude.includes("outputs/"), "outputs/ excluded per-clone");
  assert(memoryCalls === 1 && r.memory.outcome === "written", "memory row written via seam");
  // #895 — the vipune takeaway: the new format, captured via the stub, and
  // ≤400 chars. Four unique claims, of which 3 are verified findings (the
  // contradiction verifies unreachable → not a finding).
  assert(
    lastTakeaway ===
      "3 verified of 4 claims across 3 angles — top findings: the scoring is RRF | seam exists | URL mislabelled as code",
    `memory: takeaway in the new format (got ${lastTakeaway})`,
  );
  assert((lastTakeaway ?? "").length <= 400, "memory: takeaway within the 400-char bound");
  // #895 — Run metrics: the written artifact carries the section (per-phase
  // wall times, total, per-angle rows) and the provenance sidecar carries
  // the machine-readable mirror.
  assert(body.includes("## Run metrics"), "#895: artifact carries the Run metrics section");
  assert(body.includes("- **inventory**:"), "#895: artifact metric row: inventory phase");
  assert(body.includes("- **total**:"), "#895: artifact metric row: total");
  assert(
    body.includes("- **web-current**: 4 claims reported · backend: parallel · ok"),
    "#895: artifact per-angle row (pre-dedup count, backend, ok)",
  );
  assert(body.includes("verification: "), "#895: artifact verification mix row");
  assert(prov.includes("phase.inventory.ms: "), "#895: provenance machine-readable phase line");
  assert(prov.includes("total.ms: "), "#895: provenance machine-readable total line");
  assert(
    prov.includes("angle.web-current: claims=4 backend=parallel ok=true"),
    "#895: provenance machine-readable per-angle line",
  );
  assert(prov.includes("verify.url.live: "), "#895: provenance machine-readable mix line");
  const phases = r.timings.map((t) => t.phase);
  for (const p of ["inventory", "retrieve", "verify", "artifact", "memory", "total"]) {
    assert(phases.includes(p), `timings: phase "${p}" recorded`);
  }
  await fs.rm(tmp, { recursive: true, force: true });
}

{
  // Quick tier → exactly one angle; custom angles win over derivation.
  const tmp = await freshRepo();
  seen.length = 0;
  await runResearchPipeline(FAKE_PI, { topic: "what is a thing", tier: "quick" }, tmp, deps);
  assert(
    seen.length === 1 && seen[0]?.label === "research-web-current",
    "quick tier = 1 web angle",
  );

  seen.length = 0;
  await runResearchPipeline(FAKE_PI, { topic: "t", angles: ["compare A", "compare B"] }, tmp, deps);
  assert(
    seen.map((s) => s.label).join(",") === "research-custom-1,research-custom-2",
    "PM-supplied angles dispatch verbatim as custom-N",
  );
  assert(
    seen.every((s) => s.prompt.includes("UNTRUSTED DATA")),
    "every angle prompt carries the data framing",
  );
  await fs.rm(tmp, { recursive: true, force: true });
}

{
  // #893 — all angles with 0 raw report_research_claim calls → reporter-silent.
  const tmp = await freshRepo();
  claimMode = "empty";
  const r = await runResearchPipeline(FAKE_PI, { topic: "t", tier: "quick" }, tmp, deps);
  claimMode = "normal";
  assert(
    r.halt?.reason === "reporter-silent",
    "all-angles-silent (0 raw calls) halts with reporter-silent",
  );
  assert(
    r.halt?.detail.includes("reporting channel appears broken"),
    "reporter-silent detail names the broken channel",
  );
  assert(!r.artifactPath, "no artifact on the reporter-silent halt");
  assert(
    await fs
      .access(path.join(tmp, "outputs"))
      .then(() => false)
      .catch(() => true),
    "outputs/ not created on the halt",
  );
  await fs.rm(tmp, { recursive: true, force: true });
}

{
  // #893 — schema-invalid calls (raw > 0, valid = 0) → no-structured-claims (unchanged).
  const tmp = await freshRepo();
  claimMode = "schema-invalid";
  const r = await runResearchPipeline(FAKE_PI, { topic: "t", tier: "quick" }, tmp, deps);
  claimMode = "normal";
  assert(
    r.halt?.reason === "no-structured-claims",
    "schema-invalid calls (raw>0, valid=0) → no-structured-claims",
  );
  assert(r.halt?.reason !== "reporter-silent", "schema-invalid is distinct from reporter-silent");
  await fs.rm(tmp, { recursive: true, force: true });
}

{
  // Gaps only → abstention: artifact IS written, banner present.
  const tmp = await freshRepo();
  claimMode = "gaps-only";
  const r = await runResearchPipeline(FAKE_PI, { topic: "t", tier: "quick" }, tmp, deps);
  claimMode = "normal";
  assert(r.abstained === true && !r.halt, "gaps-only run abstains without halting");
  const body = await fs.readFile(r.artifactPath as string, "utf8");
  assert(
    body.includes("No reliably verified findings"),
    "abstention artifact written with the honest banner",
  );
  await fs.rm(tmp, { recursive: true, force: true });
}

setResearchDispatch(null);

console.log(`\nexit ${exit}`);
process.exit(exit);
