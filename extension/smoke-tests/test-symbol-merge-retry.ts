#!/usr/bin/env bun
/**
 * #1323 — merge and retry once when a workstream's verify failure names a
 * symbol a sibling workstream adds (the #1297 pair: an export added in ws a,
 * consumed in ws b; each half started from the same base, so b fails alone).
 *
 * Driven through the REAL runDevelopTopological in a live temp git repo. The
 * project's verify command (`.pi/verify-cmd`) is a shell stand-in for `tsc`:
 * it fails with a TS2305 line when b.ts imports a symbol a.ts does not have.
 *
 *   1. diff scan (no `introduces`): b's failure names `newThing`, a's diff
 *      adds `export const newThing` → a and b merge, b's worktree is reset to
 *      a's tip, ONE re-dispatch, the re-run passes, no cap-hit.
 *   2. declared `introduces` + a second failure: the merge happens on the
 *      declared symbol alone (a's diff has no export the scan reads), the
 *      retry fails again → verify-failed:develop, exactly one retry, and the
 *      handoff explanation says the split was merged and still failed.
 *   3. no sibling adds the symbol → no merge, parks as before (here the
 *      consolidation-created cap, since neither tree has the symbol).
 *   4. PI_ENSEMBLE_SYMBOL_MERGE_RETRY=0 → no merge on the case-1 shape.
 * Plus the two text scans in isolation.
 */

import { execFile } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import type { DispatchResult } from "../src/types.ts";
import { addedSymbolsInDiff, missingSymbolsIn } from "../src/work-develop-symbol-scan.ts";
import { runDevelopTopological } from "../src/work-develop-topological.ts";
import type { DriverContext } from "../src/work-driver-context.ts";
import { explainVerifyFailed } from "../src/work-driver-explain-verify.ts";
import type { Workstream } from "../src/workflow-state-schema.ts";
import { type WorkState, initialState } from "../src/workflow-state.ts";
import { realExec } from "./lib/exec-fake.ts";

const execFileP = promisify(execFile);

let exit = 0;
function assert(cond: boolean, msg: string) {
  if (cond) console.log(`✓ ${msg}`);
  else {
    console.error(`✗ ${msg}`);
    exit = 1;
  }
}

// ── the scans ────────────────────────────────────────────────────────────
{
  const tsc = [
    `src/b.ts(1,10): error TS2305: Module '"./a.ts"' has no exported member 'newThing'.`,
    `src/c.ts(4,7): error TS2339: Property 'providerRepeats' does not exist on type 'ErrorStop'.`,
    `src/d.ts(9,3): error TS2353: Object literal may only specify known properties, and 'introduces' does not exist in type 'Workstream'.`,
    `src/e.ts(2,1): error TS2307: Cannot find module './work-new-thing.ts' or its corresponding type declarations.`,
    "error[E0425]: cannot find value `max_depth` in this scope",
    "ImportError: cannot import name 'parse_contract' from 'mod'",
    "./x.go:3:2: undefined: pkg.NewWidget",
  ].join("\n");
  const got = missingSymbolsIn(tsc);
  for (const s of [
    "newThing",
    "providerRepeats",
    "introduces",
    "work-new-thing",
    "max_depth",
    "parse_contract",
    "NewWidget",
  ]) {
    assert(
      got.includes(s),
      `scan: a verify failure naming \`${s}\` is read (got ${got.join(",")})`,
    );
  }
  assert(
    missingSymbolsIn("1 test failed: expected 2, got 3").length === 0,
    "scan: a plain test failure names no symbol",
  );
  const diff = [
    "diff --git a/src/a.ts b/src/a.ts",
    "--- a/src/a.ts",
    "+++ b/src/a.ts",
    "@@ -1 +1,6 @@",
    "+export const newThing = 1;",
    "+export { helper as renamedHelper, other };",
    "+export interface ErrorStop {",
    "+  providerRepeats?: number;",
    "+}",
    " const unchanged = 2;",
    "-export const removedThing = 3;",
    "--- /dev/null",
    "+++ b/src/work-new-thing.ts",
    "+pub fn max_depth() -> u32 { 3 }",
  ].join("\n");
  const added = addedSymbolsInDiff(diff);
  for (const s of [
    "newThing",
    "renamedHelper",
    "other",
    "ErrorStop",
    "providerRepeats",
    "work-new-thing",
    "max_depth",
  ]) {
    assert(added.includes(s), `scan: a diff adding \`${s}\` is read (got ${added.join(",")})`);
  }
  for (const s of ["unchanged", "removedThing", "helper"]) {
    assert(!added.includes(s), `scan: \`${s}\` (not an added symbol) is not read`);
  }
}

// ── the driver flow ──────────────────────────────────────────────────────
const git = (cwd: string, args: string[]) => execFileP("git", args, { cwd });
const gitOut = async (cwd: string, args: string[]): Promise<string> =>
  (await git(cwd, args)).stdout.trim();

const root = mkdtempSync(path.join(tmpdir(), "pi-ens-1323-"));

// The tsc stand-in: b.ts names a symbol on its first line (`import { X }`);
// fail with TS2305 unless a.ts mentions it.
const CHECK = `#!/bin/sh
[ -f b.ts ] || exit 0
sym=$(sed -n 's/.*import { \\([A-Za-z]*\\) }.*/\\1/p' b.ts)
if [ -n "$sym" ] && ! grep -q "$sym" a.ts 2>/dev/null; then
  echo "b.ts(1,10): error TS2305: Module '\\"./a.ts\\"' has no exported member '$sym'."
  exit 1
fi
exit 0
`;

async function fixture(name: string): Promise<{ repo: string; baseSha: string }> {
  const repo = path.join(root, name);
  mkdirSync(path.join(repo, ".pi"), { recursive: true });
  writeFileSync(path.join(repo, "check.sh"), CHECK);
  writeFileSync(path.join(repo, ".pi", "verify-cmd"), "sh check.sh\n");
  await git(repo, ["init", "-q", "--initial-branch=main"]);
  await git(repo, ["config", "user.email", "t@example.com"]);
  await git(repo, ["config", "user.name", "T"]);
  await git(repo, ["add", "-A"]);
  await git(repo, ["commit", "-q", "-m", "base"]);
  return { repo, baseSha: await gitOut(repo, ["rev-parse", "HEAD"]) };
}

async function commitFile(cwd: string, file: string, body: string, msg: string) {
  writeFileSync(path.join(cwd, file), body);
  await git(cwd, ["add", file]);
  await git(cwd, ["commit", "-q", "-m", msg]);
}

type Call = { role: string; cwd?: string; prompt?: string };

function recordingDispatch(
  calls: Call[],
  onCall: (spec: Call) => Promise<void>,
): NonNullable<DriverContext["dispatchFn"]> {
  const fn = async (_pi: unknown, spec: Call): Promise<DispatchResult> => {
    calls.push({ role: spec.role, cwd: spec.cwd, prompt: spec.prompt });
    await onCall(spec);
    return {
      role: spec.role,
      ok: true,
      text: "done",
      toolUses: [],
      ms: 1,
      exitCode: 0,
      usage: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0 },
      transcriptPath: "/tmp/x.json",
    };
  };
  return fn as unknown as NonNullable<DriverContext["dispatchFn"]>;
}

/**
 * Two worktrees from base: a commits a.ts (`aBody`), b commits b.ts
 * importing `newThing`. `retryBody` is what the merge re-dispatch writes to
 * b.ts in the merged worktree (undefined: no re-dispatch expected).
 */
async function run(
  name: string,
  aBody: string,
  opts: { introduces?: string[]; retryBody?: string } = {},
): Promise<{ after: WorkState; calls: Call[]; wt: Record<string, string>; aSha: string }> {
  const { repo, baseSha } = await fixture(name);
  const wt: Record<string, string> = {};
  for (const id of ["a", "b"]) {
    wt[id] = path.join(repo, ".worktrees", `issue-1323-${id}`);
    await git(repo, ["worktree", "add", "-q", "--detach", wt[id] as string, baseSha]);
  }
  await commitFile(wt.a as string, "a.ts", aBody, "a");
  await commitFile(wt.b as string, "b.ts", 'import { newThing } from "./a.ts";\n', "b");
  const aSha = await gitOut(wt.a as string, ["rev-parse", "HEAD"]);
  const calls: Call[] = [];
  const dispatchFn = recordingDispatch(calls, async (spec) => {
    if (spec.cwd === wt.b && (spec.prompt ?? "").includes("SIBLING-SYMBOL MERGE-AND-RETRY")) {
      await commitFile(spec.cwd as string, "b.ts", opts.retryBody ?? "", "b-retry");
    }
  });
  const ctx = {
    host: {},
    issue: 1323,
    issues: [1323],
    repoRoot: repo,
    verifyExecFn: realExec,
    stateRef: { current: initialState(1323) },
    dispatchFn,
  } as unknown as DriverContext;
  const workstreams: Record<string, Workstream> = {
    a: {
      id: "a",
      scope: "a",
      paths: ["a.ts"],
      outOfScope: ["b.ts"],
      ...(opts.introduces ? { introduces: opts.introduces } : {}),
    },
    b: { id: "b", scope: "b", paths: ["b.ts"], outOfScope: ["a.ts"] },
  };
  const base = initialState(1323);
  base.pipelineState.baseSha = baseSha;
  base.pipelineState.worktrees = { ...wt };
  base.pipelineState.workstreamBaseShas = { a: baseSha, b: baseSha };
  base.pipelineState.workstreams = workstreams;
  base.pipelineState.currentStep = "develop";
  const after = await runDevelopTopological(
    ctx,
    base,
    ["a", "b"],
    workstreams,
    [1323],
    dispatchFn,
    realExec,
    Date.now(),
    `job-1323-${name}`,
  );
  return { after, calls, wt, aSha };
}

const mergeEvents = (s: WorkState) => s.eventLog.filter((e) => e.kind === "fence-recovery-started");
const retries = (calls: Call[]) =>
  calls.filter((c) => (c.prompt ?? "").includes("SIBLING-SYMBOL MERGE-AND-RETRY"));

// ── case 1: diff scan → merge → clean re-run ─────────────────────────────
{
  const { after, calls, wt, aSha } = await run("diff-scan", "export const newThing = 1;\n", {
    retryBody: 'import { newThing } from "./a.ts";\n',
  });
  const ev = mergeEvents(after)[0];
  assert(
    ev?.kind === "fence-recovery-started" &&
      ev.cause === "sibling-symbol" &&
      ev.workstreamId === "a" &&
      ev.owners.includes("b") &&
      (ev.symbols ?? []).includes("newThing"),
    `case 1: the merge event names both workstreams (a ← b) and the symbol (got ${JSON.stringify(ev)})`,
  );
  const r = retries(calls);
  assert(
    r.length === 1 && r[0]?.cwd === wt.b && (r[0]?.prompt ?? "").includes("`newThing`"),
    `case 1: exactly one merged re-dispatch, in b's worktree, naming the symbol (got ${r.length})`,
  );
  const bHead = await gitOut(wt.b as string, ["rev-parse", "HEAD"]);
  const aInB = await git(wt.b as string, ["merge-base", "--is-ancestor", aSha, bHead])
    .then(() => true)
    .catch(() => false);
  assert(aInB, "case 1: the merged worktree builds on a's commit");
  const cap = after.eventLog.find((e) => e.kind === "cap-hit");
  assert(
    cap === undefined,
    `case 1: the clean re-run proceeds — no park (got ${JSON.stringify(cap)})`,
  );
  assert(
    Object.keys(after.pipelineState.workstreams ?? {}).join(",") === "a",
    "case 1: b is folded into a",
  );
}

// ── case 2: declared introduces, second failure parks naming the merge ──
{
  const { after, calls } = await run("declared", "// built by a factory elsewhere\n", {
    introduces: ["a.newThing"],
    retryBody: 'import { otherThing } from "./a.ts";\n',
  });
  const ev = mergeEvents(after)[0];
  assert(
    ev?.kind === "fence-recovery-started" && (ev.symbols ?? []).includes("newThing"),
    "case 2: the declared `introduces` alone couples the pair",
  );
  assert(retries(calls).length === 1, `case 2: one retry only (got ${retries(calls).length})`);
  const caps = after.eventLog.filter((e) => e.kind === "cap-hit");
  assert(
    caps.length === 1 && caps[0]?.kind === "cap-hit" && caps[0].cap === "verify-failed:develop",
    `case 2: a second failure parks as verify-failed:develop (got ${JSON.stringify(caps)})`,
  );
  const text = explainVerifyFailed("verify-failed:develop", after);
  assert(
    /already merged the split workstreams b into a/.test(text) && /still failed/.test(text),
    `case 2: the handoff says the split was merged and still failed (got: ${text.slice(-300)})`,
  );
}

// ── case 3: no sibling adds the symbol → park as today ──────────────────
{
  const { after, calls } = await run("unrelated", "export const somethingElse = 1;\n");
  assert(
    mergeEvents(after).length === 0 && retries(calls).length === 0,
    "case 3: no merge, no retry",
  );
  const caps = after.eventLog.filter((e) => e.kind === "cap-hit");
  assert(
    caps.length === 1 && caps[0]?.kind === "cap-hit" && caps[0].nextStep === "handoff",
    `case 3: parks exactly as before the change (got ${JSON.stringify(caps)})`,
  );
  assert(
    !/already merged/.test(explainVerifyFailed("verify-failed:develop", after)),
    "case 3: the handoff does not claim a merge",
  );
}

// ── case 4: the kill switch ─────────────────────────────────────────────
{
  process.env.PI_ENSEMBLE_SYMBOL_MERGE_RETRY = "0";
  const { after, calls } = await run("off", "export const newThing = 1;\n");
  delete process.env.PI_ENSEMBLE_SYMBOL_MERGE_RETRY;
  assert(
    mergeEvents(after).length === 0 && retries(calls).length === 0,
    "case 4: PI_ENSEMBLE_SYMBOL_MERGE_RETRY=0 parks without merging",
  );
}

rmSync(root, { recursive: true, force: true });
console.log(`\nexit ${exit}`);
process.exit(exit);
