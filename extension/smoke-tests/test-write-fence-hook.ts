#!/usr/bin/env bun
/**
 * #1655 — the write fence's `tool_call` hook (write-fence.ts), driven through a
 * fake pi, plus the two places it must be registered from.
 *
 *   A. the hook refuses write / edit / multiedit / bash to a repo-root path, and
 *      allows the same inside the worktree, the scratch dir and temp;
 *   B. a codemode-routed call (carrying `parentToolCallId`, the way Pi's session
 *      emits a script's `tools.write`) is refused by the same rule;
 *   C. each refusal is logged to the scratch dir and counted by the driver's
 *      reader — the channel the cycle state's counter is built from;
 *   D. the companion registers the fence in BOTH trust mode and
 *      PI_ENSEMBLE_SUBAGENT_MODE=1, and registers nothing without a root;
 *   E. the fence is inert without PI_ENSEMBLE_WRITE_ROOT and with
 *      PI_ENSEMBLE_WRITE_FENCE=0.
 */

import { readFileSync, readdirSync, rmSync } from "node:fs";
import path from "node:path";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import childGuards from "../src/child-guards.ts";
import { countWriteFenceRefusals } from "../src/write-fence-log.ts";
import { registerWriteFence } from "../src/write-fence.ts";
import { buildFenceFixture } from "./lib/write-fence-fixture.ts";

let exit = 0;
function assert(cond: boolean, msg: string) {
  if (cond) console.log(`✓ ${msg}`);
  else {
    console.error(`✗ ${msg}`);
    exit = 1;
  }
}

type Handler = (event: unknown, ctx: unknown) => unknown;

/** A fake pi that records every handler by event name. */
function fakePi() {
  const handlers: Record<string, Handler[]> = {};
  return {
    handlers,
    on(name: string, fn: Handler) {
      handlers[name] = [...(handlers[name] ?? []), fn];
    },
  } as unknown as ExtensionAPI & { handlers: Record<string, Handler[]> };
}

async function toolCall(
  pi: { handlers: Record<string, Handler[]> },
  event: Record<string, unknown>,
) {
  const results = await Promise.all(
    (pi.handlers.tool_call ?? []).map((h) => h({ type: "tool_call", ...event }, {})),
  );
  return results.find((r) => r !== undefined) as { block: true; reason: string } | undefined;
}

const ENV_KEYS = [
  "PI_ENSEMBLE_WRITE_ROOT",
  "PI_ENSEMBLE_WRITE_SCRATCH",
  "PI_ENSEMBLE_WRITE_FENCE",
  "PI_ENSEMBLE_SUBAGENT_MODE",
] as const;
const savedEnv = Object.fromEntries(ENV_KEYS.map((k) => [k, process.env[k]]));
const savedCwd = process.cwd();
function restore() {
  for (const k of ENV_KEYS) {
    const v = savedEnv[k];
    if (v === undefined) Reflect.deleteProperty(process.env, k);
    else process.env[k] = v;
  }
  process.chdir(savedCwd);
}

const fx = buildFenceFixture("hook");
const REPO_BIN_KEEP = path.join(fx.repo, "bin", "keep");
process.env.PI_ENSEMBLE_WRITE_ROOT = fx.wt;
process.env.PI_ENSEMBLE_WRITE_SCRATCH = fx.scratch;
Reflect.deleteProperty(process.env, "PI_ENSEMBLE_WRITE_FENCE");
Reflect.deleteProperty(process.env, "PI_ENSEMBLE_SUBAGENT_MODE");
// The hook resolves relative paths against the child's working directory, which is the worktree.
process.chdir(fx.wt);

// ============================================================
// A. The write tools and bash, direct.
// ============================================================
const pi = fakePi();
registerWriteFence(pi);
assert(
  (pi.handlers.tool_call ?? []).length === 1,
  "A: the fence registers exactly one tool_call hook",
);

const directRefusals: Array<[string, Record<string, unknown>]> = [
  ["write", { path: "../../bin/keep", content: "x" }],
  ["write", { path: REPO_BIN_KEEP, content: "x" }],
  ["edit", { path: "../../bin/keep", edits: [] }],
  ["multiedit", { path: REPO_BIN_KEEP, edits: [] }],
  ["bash", { command: `cp a ${fx.repo}/bin/b` }],
  ["bash", { command: "echo x > ../../bin/foo" }],
];
for (const [tool, input] of directRefusals) {
  const block = await toolCall(pi, { toolName: tool, toolCallId: "t1", input });
  assert(block?.block === true, `A: refuses ${tool} ${JSON.stringify(input).slice(0, 70)}`);
}

const directAllowed: Array<[string, Record<string, unknown>]> = [
  ["write", { path: "src/new.ts", content: "x" }],
  ["edit", { path: "src/a.ts", edits: [] }],
  ["multiedit", { path: "node_modules/pkg/new.js", edits: [] }],
  ["write", { path: path.join(fx.scratch, "notes.md"), content: "x" }],
  ["write", { path: "/tmp/fence-check", content: "x" }],
  ["bash", { command: "echo x > out.txt && tee -a out.txt" }],
  ["read", { path: `${fx.repo}/bin/keep` }],
  ["bash", { command: "git status --porcelain" }],
];
for (const [tool, input] of directAllowed) {
  const block = await toolCall(pi, { toolName: tool, toolCallId: "t2", input });
  assert(block === undefined, `A: allows ${tool} ${JSON.stringify(input).slice(0, 70)}`);
}

// ============================================================
// B. A codemode-routed call: the session emits the nested call with parentToolCallId.
// ============================================================
{
  const block = await toolCall(pi, {
    toolName: "write",
    toolCallId: "nested-1",
    parentToolCallId: "codemode-1",
    input: { path: REPO_BIN_KEEP, content: "x" },
  });
  assert(block?.block === true, "B: a codemode tools.write to the repo root is refused");
  const ok = await toolCall(pi, {
    toolName: "write",
    toolCallId: "nested-2",
    parentToolCallId: "codemode-1",
    input: { path: "src/from-script.ts", content: "x" },
  });
  assert(ok === undefined, "B: a codemode tools.write inside the worktree is allowed");
}

// ============================================================
// C. The refusal is named and logged for the driver to count.
// ============================================================
{
  const block = await toolCall(pi, {
    toolName: "write",
    toolCallId: "t3",
    input: { path: "../../bin/keep", content: "x" },
  });
  assert(
    block?.reason.includes("../../bin/keep") === true && block.reason.includes(fx.wt),
    "C: the refusal reason names the attempted path and the write root",
  );
  const logs = readdirSync(fx.scratch).filter((n) => /^write-fence-\d+\.jsonl$/.test(n));
  assert(logs.length === 1, "C: refusals land in one write-fence-<pid>.jsonl in the scratch dir");
  const entries = readFileSync(path.join(fx.scratch, logs[0] ?? ""), "utf8")
    .trim()
    .split("\n");
  const last = JSON.parse(entries[entries.length - 1] ?? "{}") as { tool: string; path: string };
  assert(
    last.tool === "write" && last.path === "../../bin/keep",
    "C: the log line names the tool and the path",
  );
  const total = await countWriteFenceRefusals(fx.scratch);
  // The refusals so far: 6 direct refusals (4 write-tool + 2 bash) + 1 codemode + 1 here.
  assert(
    total === 8,
    `C: the driver's reader sums every refusal across the scratch dir (got ${total}, want 8)`,
  );
}

// ============================================================
// D. The companion carries the fence in both trust and subagent mode.
// ============================================================
{
  Reflect.deleteProperty(process.env, "PI_ENSEMBLE_SUBAGENT_MODE");
  const trust = fakePi();
  childGuards(trust);
  assert(
    (trust.handlers.tool_call ?? []).length === 6,
    `D: trust mode: the five mode-independent guards plus the fence (got ${trust.handlers.tool_call?.length ?? 0}, want 6)`,
  );
  const refusal = await toolCall(trust, {
    toolName: "write",
    toolCallId: "t4",
    input: { path: REPO_BIN_KEEP, content: "x" },
  });
  assert(refusal?.block === true, "D: trust mode: the companion's fence refuses a repo-root write");

  process.env.PI_ENSEMBLE_SUBAGENT_MODE = "1";
  const strict = fakePi();
  childGuards(strict);
  assert(
    (strict.handlers.tool_call ?? []).length === 1,
    `D: PI_ENSEMBLE_SUBAGENT_MODE=1: the fence is the only hook (the guards no-op there; got ${strict.handlers.tool_call?.length ?? 0})`,
  );
  const strictRefusal = await toolCall(strict, {
    toolName: "write",
    toolCallId: "t5",
    input: { path: REPO_BIN_KEEP, content: "x" },
  });
  assert(
    strictRefusal?.block === true,
    "D: PI_ENSEMBLE_SUBAGENT_MODE=1: the fence still refuses a repo-root write",
  );
  Reflect.deleteProperty(process.env, "PI_ENSEMBLE_SUBAGENT_MODE");
}

// ============================================================
// E. Inert without a root, and under the escape hatch.
// ============================================================
{
  const savedRoot = process.env.PI_ENSEMBLE_WRITE_ROOT;
  Reflect.deleteProperty(process.env, "PI_ENSEMBLE_WRITE_ROOT");
  const unfenced = fakePi();
  registerWriteFence(unfenced);
  assert(
    !unfenced.handlers.tool_call,
    "E: no PI_ENSEMBLE_WRITE_ROOT → the fence registers nothing",
  );
  const bare = fakePi();
  childGuards(bare);
  assert(
    (bare.handlers.tool_call ?? []).length === 5,
    "E: no root: the companion keeps its five guards and no fence",
  );
  process.env.PI_ENSEMBLE_WRITE_ROOT = savedRoot;

  process.env.PI_ENSEMBLE_WRITE_FENCE = "0";
  const hatch = fakePi();
  registerWriteFence(hatch);
  assert(!hatch.handlers.tool_call, "E: PI_ENSEMBLE_WRITE_FENCE=0 → the fence registers nothing");
  Reflect.deleteProperty(process.env, "PI_ENSEMBLE_WRITE_FENCE");
}

// ============================================================
// F. The fence is registered from the companion, not the full extension — a canary.
// ============================================================
{
  const src = readFileSync(path.join(import.meta.dir, "..", "src", "child-guards.ts"), "utf8");
  assert(
    src.includes("registerWriteFence(failClosedPi(pi))"),
    "F: canary: the companion registers the fence through the fail-closed wrapper",
  );
  const fenceAt = src.indexOf("registerWriteFence(failClosedPi(pi))");
  const noopAt = src.indexOf('if (process.env.PI_ENSEMBLE_SUBAGENT_MODE === "1")');
  assert(
    fenceAt > 0 && fenceAt < noopAt,
    "F: canary: the fence is registered BEFORE the subagent-mode no-op",
  );
}

restore();
rmSync(fx.base, { recursive: true, force: true });
if (exit === 0) console.log("✓ all write-fence hook assertions passed");
process.exit(exit);
