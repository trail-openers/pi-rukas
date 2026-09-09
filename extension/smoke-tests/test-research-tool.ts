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
let claimMode: "normal" | "empty" | "gaps-only" = "normal";

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
      : claimMode === "gaps-only"
        ? [claimCall("gap", "could not answer", "none", "none")]
        : [
            claimCall("finding", "the scoring is RRF", "https://a/live", "url"),
            claimCall("finding", "seam exists", "src/x.ts#seamFn", "code"),
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
  if (cmd.startsWith("git ls-files"))
    return { stdout: cmd.includes("src/x.ts") ? "src/x.ts\n" : "" };
  if (cmd.startsWith("git grep")) {
    if (cmd.includes("seamFn")) return { stdout: "src/x.ts\n" };
    throw new Error("exit 1");
  }
  throw new Error(`unexpected: ${cmd}`);
};
const fetchStub = (async (url: string) => ({
  status: url.includes("bot") ? 403 : url.includes("dead") ? 404 : 200,
})) as never;
const searchStub = (async () => ({ kind: "hits", hits: [] })) as never;
let memoryCalls = 0;
const memoryStub = (async () => {
  memoryCalls++;
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
    r.claims.length === 9,
    `claims extracted, invalid + foreign dropped (got ${r.claims.length})`,
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
    "code claim grounded against the pinned tree",
  );
  assert(!r.abstained && !r.halt, "verified findings → no abstention, no halt");
  assert(!!r.artifactPath && !!r.provenancePath, "artifact + provenance paths returned");
  const body = await fs.readFile(r.artifactPath as string, "utf8");
  assert(body.includes("the scoring is RRF"), "artifact written with the findings");
  const exclude = await fs.readFile(path.join(tmp, ".git", "info", "exclude"), "utf8");
  assert(exclude.includes("outputs/"), "outputs/ excluded per-clone");
  assert(memoryCalls === 1 && r.memory.outcome === "written", "memory row written via seam");
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
  // All angles empty → halt, no artifact file.
  const tmp = await freshRepo();
  claimMode = "empty";
  const r = await runResearchPipeline(FAKE_PI, { topic: "t", tier: "quick" }, tmp, deps);
  claimMode = "normal";
  assert(
    r.halt?.reason === "no-structured-claims",
    "all-angles-empty halts with the discriminated reason",
  );
  assert(!r.artifactPath, "no artifact on the infra halt (nothing to record)");
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
