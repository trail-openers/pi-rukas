#!/usr/bin/env bun
/**
 * The approved spec on the classic `/work` driver, and its `tehas:spec v1` block.
 *
 * A host checks one flag for both engines, so `work` must read the spec the
 * same way `work-lean` does and keep the block on the PR body. Covers: an
 * invalid spec stops explore before any fetch or dispatch; the approved text
 * replaces the forge read and a long issue never cuts the spec from the
 * explore prompt; the check child runs once per cycle and is accounted for;
 * the post-commit-pr repair and the attribution rewrite both leave the cached
 * block on the body, and a body that cannot carry it halts; a host path in a
 * verdict does not stop a public-repo body write; without a spec every body
 * and prompt is unchanged.
 */

import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { usageOf } from "../src/headless/result.ts";
import { renderSpecBlock, specBlockProblem } from "../src/issue-spec-block.ts";
import { APPROVED_SPEC_MARKER } from "../src/issue-spec.ts";
import type { DispatchResult } from "../src/types.ts";
import { discloseInPrBody } from "../src/work-driver-ci-verify.ts";
import type { CycleContext } from "../src/work-driver-context.ts";
import { runExplore } from "../src/work-driver-explore.ts";
import {
  inlineBody,
  specBlockOnPr,
  specBlockReady,
  specBlocked,
  specFetcher,
} from "../src/work-driver-issue-spec.ts";
import { foldVerifyAttribution } from "../src/work-driver-verify-events.ts";
import { createEmitSink } from "../src/work-state-emit.ts";
import { type WorkState, initialState } from "../src/workflow-state.ts";
import type { ExecFn } from "../src/worktree.ts";
import { withEnv } from "./lib/env-scope.ts";

let exit = 0;
function assert(cond: boolean, msg: string) {
  if (cond) console.log(`✓ ${msg}`);
  else {
    console.error(`✗ ${msg}`);
    exit = 1;
  }
}

const ISSUE = 7;
const LINK = "https://example.com/specs/7.md";
const SPEC = Buffer.from("# Spec\n\nR1: the thing works\nFR-3: it is the last line\n");
const sha = (b: Buffer) => createHash("sha256").update(b).digest("hex");
const tmp = mkdtempSync(path.join(tmpdir(), "issue-spec-classic-"));
let n = 0;

/** A manifest directory for ISSUE; `bad` pins a sha256 the spec does not hash to. */
function specDir(opts: { bad?: boolean; approvedBody?: string } = {}): string {
  const dir = path.join(tmp, `spec-${++n}`);
  mkdirSync(dir, { recursive: true });
  writeFileSync(path.join(dir, "spec.md"), SPEC);
  const m: Record<string, unknown> = {
    issue: ISSUE,
    spec: {
      file: "spec.md",
      link: LINK,
      name: "Spec 7",
      bytes: SPEC.length,
      sha256: opts.bad ? "0".repeat(64) : sha(SPEC),
      block: 1,
    },
  };
  if (opts.approvedBody !== undefined) {
    const a = Buffer.from(
      JSON.stringify({ number: ISSUE, title: "Approved T", body: opts.approvedBody }),
    );
    writeFileSync(path.join(dir, "approved.json"), a);
    m.approvedText = { file: "approved.json", bytes: a.length, sha256: sha(a) };
  }
  writeFileSync(path.join(dir, "manifest.json"), JSON.stringify(m));
  return dir;
}

function repo(): string {
  const dir = mkdtempSync(path.join(tmp, "repo-"));
  execFileSync("git", ["init", "-q", dir]);
  mkdirSync(path.join(dir, "src"));
  writeFileSync(path.join(dir, "src", "a.ts"), "export {};\n");
  return dir;
}

const reply = (text: string): DispatchResult => ({
  role: "explore",
  ok: true,
  text,
  toolUses: [],
  ms: 1,
  exitCode: 0,
  transcriptPath: "/tmp/stub.json",
  usage: { input: 10, output: 5, cacheRead: 0, cacheWrite: 0, cost: 0.01, turns: 1 },
});

function cycle(repoRoot: string, text = "stub") {
  const prompts: string[] = [];
  let fetches = 0;
  const ctx = {
    host: {},
    issue: ISSUE,
    repoRoot,
    emitSink: createEmitSink(() => {}),
    issueBodyFetcherFn: async () => {
      fetches++;
      return { stdout: "Live T\n\nlive body" };
    },
    dispatchFn: async (_h: unknown, spec: { prompt: string }) => {
      prompts.push(spec.prompt);
      return reply(text);
    },
  } as unknown as CycleContext;
  return { ctx, prompts, fetches: () => fetches };
}

const lastCap = (s: WorkState) => s.eventLog.filter((e) => e.kind === "cap-hit").at(-1);

// A. An invalid spec stops explore before any fetch or dispatch.
await withEnv({ PI_ENSEMBLE_EXTRA_IMAGE_DIRS: specDir({ bad: true }) }, async () => {
  const c = cycle(repo());
  const s = await runExplore(c.ctx, initialState(ISSUE), Date.now());
  const cap = lastCap(s);
  assert(
    cap?.kind === "cap-hit" &&
      cap.cap === "step-failed:explore" &&
      /^approved spec/.test(cap.evidence ?? ""),
    "an invalid spec halts explore with step-failed:explore and `approved spec …` evidence",
  );
  assert(c.fetches() === 0 && c.prompts.length === 0, "and nothing was fetched or dispatched");
});

// B. The approved text replaces the forge read; a long issue never cuts the spec.
await withEnv(
  { PI_ENSEMBLE_EXTRA_IMAGE_DIRS: specDir({ approvedBody: "x".repeat(20 * 1024) }) },
  async () => {
    const c = cycle(repo());
    const s = await runExplore(c.ctx, initialState(ISSUE), Date.now());
    const art = readFileSync(s.pipelineState.issueBodyArtifact ?? "", "utf8");
    assert(c.fetches() === 0, "the approved text replaces the forge read");
    assert(s.pipelineState.specSha === sha(SPEC), "explore records the sha256 it read");
    assert(
      art.startsWith("Approved T\n\n") && art.includes(APPROVED_SPEC_MARKER),
      "the issue-body artifact is the approved title and body with the spec appended",
    );
    assert(
      c.prompts[0]?.includes("FR-3: it is the last line") === true,
      "a 20 KiB issue body does not cut the spec from the explore prompt",
    );
  },
);

// C. The check child: one per cycle, accounted for, and a spec that stopped verifying halts.
await withEnv({ PI_ENSEMBLE_EXTRA_IMAGE_DIRS: specDir() }, async () => {
  const c = cycle(repo(), "- R1 met: src/a.ts\n- FR-3 not met: nothing measures it");
  const first = await specBlockReady(c.ctx, initialState(ISSUE));
  const block = first.state.pipelineState.specBlock ?? "";
  assert(
    specBlockProblem(block) === undefined && block.includes(`sha256:${sha(SPEC)}`),
    "the cached block is readable and carries the manifest's sha256",
  );
  assert(
    block.includes("- R1 met: src/a.ts"),
    "an untracked file in the develop tree counts as evidence",
  );
  assert(
    usageOf(first.state).byRole.explore !== undefined,
    "the check child's cost is in usage.byRole.explore",
  );
  await specBlockReady(c.ctx, first.state);
  assert(c.prompts.length === 1, `the check runs once per cycle (dispatches=${c.prompts.length})`);
});
await withEnv({ PI_ENSEMBLE_EXTRA_IMAGE_DIRS: specDir({ bad: true }) }, async () => {
  const c = cycle(repo());
  const r = await specBlockReady(c.ctx, initialState(ISSUE));
  const cap = lastCap(r.state);
  assert(
    r.halted === true &&
      cap?.kind === "cap-hit" &&
      cap.cap === "step-failed:commit-pr" &&
      c.prompts.length === 0,
    "a spec that no longer verifies at commit-pr halts with no dispatch",
  );
});

await withEnv({ PI_ENSEMBLE_EXTRA_IMAGE_DIRS: specDir() }, async () => {
  const c = cycle(repo());
  const base = initialState(ISSUE);
  const r = await specBlockReady(c.ctx, {
    ...base,
    pipelineState: { ...base.pipelineState, specSha: "0".repeat(64) },
  });
  assert(
    r.halted === true && c.prompts.length === 0,
    "a spec that is not the one explore read halts with no dispatch",
  );
});

// C2. A host path in a verdict: the block is cached as published, so a public-repo write keeps it.
await withEnv({ PI_ENSEMBLE_EXTRA_IMAGE_DIRS: specDir() }, async () => {
  const root = repo();
  const c = cycle(
    root,
    `- R1 met: src/a.ts\n- FR-3 not met: nothing under ${root}/src measures it`,
  );
  const ready = await specBlockReady(c.ctx, initialState(ISSUE));
  const block = ready.state.pipelineState.specBlock ?? "";
  assert(!block.includes(root), "the cached block carries no host path");
  const s = foldVerifyAttribution(
    { ...ready.state, pipelineState: { ...ready.state.pipelineState, prNumber: 5 } },
    { flaky: ["smoke-tests/test-flaky-a.ts"], baselineRed: [] },
  );
  const edits: string[] = [];
  const r = await discloseInPrBody(c.ctx, s, forgeSpy("a body", edits));
  assert(
    r.ok && edits[0]?.endsWith(block) === true,
    "a body write on a repo not known to be private keeps that block",
  );
});

// D. The post-commit-pr repair, and its fail-closed halts.
const BLOCK = renderSpecBlock({ link: LINK, sha256: sha(SPEC) }, ["- R1 met: src/a.ts"]);
const root = mkdtempSync(path.join(tmp, "pr-"));
const withPr = (s: WorkState, specBlock: string): WorkState => ({
  ...s,
  pipelineState: { ...s.pipelineState, prNumber: 5, specBlock },
});
const prCtx = { repoRoot: root, issue: ISSUE } as unknown as CycleContext;
/** gh/glab answering a PR view with `body`, recording every body written. */
function forgeSpy(body: string, edits: string[]): ExecFn {
  return (async (cmd: string, opts?: { argv?: string[] }) => {
    const argv = opts?.argv ?? [];
    if (cmd.startsWith("gh pr view"))
      return { stdout: JSON.stringify({ number: 5, body, state: "OPEN" }) };
    if (cmd.startsWith("glab mr view"))
      return { stdout: JSON.stringify({ iid: 5, description: body, state: "opened" }) };
    if (cmd === "gh" && argv[1] === "view") return { stdout: JSON.stringify({ body }) };
    if (cmd === "gh" && argv[1] === "edit") {
      edits.push(readFileSync(argv[argv.indexOf("--body-file") + 1] ?? "", "utf8"));
      return { stdout: "" };
    }
    throw new Error(`unexpected ${cmd} ${argv.join(" ")}`);
  }) as unknown as ExecFn;
}
await withEnv({ PI_ENSEMBLE_FORGE: "github" }, async () => {
  const edits: string[] = [];
  const s = withPr(initialState(ISSUE), BLOCK);
  const out = await specBlockOnPr(prCtx, forgeSpy("an LLM-written body", edits), s);
  assert(
    out === undefined &&
      edits.length === 1 &&
      specBlockProblem(edits[0] ?? "") === undefined &&
      edits[0]?.endsWith(BLOCK) === true,
    "a body without the block is rewritten once, ending in the cached block",
  );
  const kept: string[] = [];
  await specBlockOnPr(prCtx, forgeSpy(`body\n\n${BLOCK}`, kept), s);
  assert(kept.length === 0, "a body already ending in the block is not edited");
  const bad: string[] = [];
  const halted = await specBlockOnPr(
    prCtx,
    forgeSpy("body", bad),
    withPr(initialState(ISSUE), "<!-- tehas:spec v1 -->\nbroken\n<!-- /tehas:spec -->"),
  );
  const cap = halted ? lastCap(halted) : undefined;
  assert(
    cap?.kind === "cap-hit" && cap.cap === "step-failed:commit-pr" && bad.length === 0,
    "a malformed cached block halts with step-failed:commit-pr and writes nothing",
  );
});
await withEnv({ PI_ENSEMBLE_FORGE: "gitlab" }, async () => {
  const edits: string[] = [];
  const halted = await specBlockOnPr(
    prCtx,
    forgeSpy("no block", edits),
    withPr(initialState(ISSUE), BLOCK),
  );
  const cap = halted ? lastCap(halted) : undefined;
  assert(
    cap?.kind === "cap-hit" &&
      /^approved spec block:/.test(cap.evidence ?? "") &&
      edits.length === 0,
    "a GitLab body without the block halts, since the driver has no body edit there",
  );
});

// E. The attribution rewrite keeps the cached block.
{
  const s = foldVerifyAttribution(withPr(initialState(ISSUE), BLOCK), {
    flaky: ["smoke-tests/test-flaky-a.ts"],
    baselineRed: [],
  });
  const edits: string[] = [];
  const r = await discloseInPrBody(prCtx, s, forgeSpy("a body that lost its block", edits));
  assert(
    r.ok &&
      edits.length === 1 &&
      specBlockProblem(edits[0] ?? "") === undefined &&
      edits[0]?.includes(BLOCK) === true,
    "the attribution rewrite re-appends the cached block with the same sha256",
  );
}

// F. Without a spec, bodies and prompts are exactly as before.
{
  const x = "body\n\n";
  assert(specBlocked(x, undefined) === x, "with no block, a body is not touched");
  const live = async () => ({ stdout: "T\n\nlive" });
  assert(
    (await specFetcher(live, new Map())(ISSUE, ".")).stdout === "T\n\nlive",
    "with no spec, the issue read is the forge read",
  );
  const body = "y".repeat(10);
  for (const cap of [9, 10, 11])
    assert(
      JSON.stringify(inlineBody(body, cap)) ===
        JSON.stringify({ text: body.slice(0, cap), truncated: body.length > cap }),
      `with no spec, the inline cut at ${cap} is the plain one`,
    );
  assert(
    specBlockProblem(specBlocked("Run:\n```bash\nfoo", BLOCK)) === undefined,
    "a fence left open in the body is closed before the block",
  );
}

rmSync(tmp, { recursive: true, force: true });
console.log(exit === 0 ? "\nAll classic issue-spec checks passed." : "\nFAILED");
process.exit(exit);
