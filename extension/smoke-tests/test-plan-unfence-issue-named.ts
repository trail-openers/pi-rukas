#!/usr/bin/env bun
/**
 * #1167 — a plan must not fence out what the issue itself requires.
 *
 * The motivating cycle: /work #1020 (Headless S2 — DriverHost seam). Its plan
 * put `extension/src/dispatch.ts` in the single workstream's `out-of-scope:`
 * line, while the issue's own `## Resolved decisions` require `dispatchCore`
 * (defined in `dispatch.ts`) to take a `DispatchHost`. Develop then parked on
 * `workstream default touched out-of-scope path extension/src/dispatch.ts —
 * declared fence violated (issue-fenced)`, and the correct change shipped as
 * PR #1159 by hand. Nothing between the planner's reply and the plan being
 * accepted had ever compared a fence to the issue.
 *
 * The develop gate is NOT touched by this issue (its `issue-fenced` failure is
 * correct for a file no one owns). What changed is that the plan step now
 * repairs issue-contradicting fences before the plan is accepted, and the
 * plan-quality gate rejects the contradictions the issue does not speak to.
 *
 * The #1020 case is replayed from a committed fixture rather than a live
 * dispatch — the failure is deterministic given the plan and the body, and a
 * live plan step would make this test depend on a model.
 */

import { readFileSync } from "node:fs";
import {
  type UnfenceResult,
  placeUnplacedPath,
  unfenceIssueNamedPaths,
} from "../src/work-driver-plan-unfence.ts";
import {
  decisionSectionsOf,
  definesSymbol,
  issueNamedTokens,
  resolveDefiningFile,
} from "../src/work-driver-plan-unfence-extract.ts";
import { runPlan } from "../src/work-driver-plan.ts";
import type { Workstream } from "../src/workflow-state-schema.ts";
import { initialState } from "../src/workflow-state.ts";

let exit = 0;
function assert(cond: boolean, msg: string) {
  if (cond) console.log(`✓ ${msg}`);
  else {
    console.error(`✗ ${msg}`);
    exit = 1;
  }
}

const HERE = new URL(".", import.meta.url).pathname;

/** A grep/read stub: `dispatchCore` is defined in exactly one source file. */
function stubExec(definitions: Record<string, string[]>, calls: Array<{ argv: string[] }> = []) {
  return async (_cmd: string, opts?: { argv?: string[] }) => {
    const argv = opts?.argv ?? [];
    calls.push({ argv });
    if (argv[0] === "grep") {
      const name = argv[4] ?? "";
      return { stdout: (definitions[name] ?? []).map((f) => `${f}\n`).join("") };
    }
    if (argv[0] === "show") {
      const file = (argv[1] ?? "").split(":")[1] ?? "";
      const defining = Object.entries(definitions).find(([, files]) => files.includes(file))?.[0];
      return {
        stdout: defining
          ? `export function ${defining}(opts: unknown) {\n  return 1;\n}\n`
          : "//\n",
      };
    }
    return { stdout: "" };
  };
}

const WS = (id: string, paths: string[], outOfScope: string[]): Workstream => ({
  id,
  scope: id,
  paths,
  outOfScope,
});

const OPTS = {
  execFn: stubExec({ dispatchCore: ["extension/src/dispatch.ts"] }),
  repoRoot: "/repo",
  ref: "origin/main",
};

// ------------------------------------------------- the #1020 replay (AC #1)

{
  const fixture = JSON.parse(readFileSync(`${HERE}fixtures/plan-unfence/1020.json`, "utf8")) as {
    issue: number;
    issueBody: string;
    plan: Record<string, Workstream>;
  };
  assert(fixture.issue === 1020, "the fixture is #1020's plan");
  assert(
    fixture.plan.default.outOfScope.includes("extension/src/dispatch.ts"),
    "canary: the recorded plan really did fence extension/src/dispatch.ts (the parked cycle's cause)",
  );

  const result = await unfenceIssueNamedPaths(fixture.plan, fixture.issueBody, {
    ...OPTS,
    defaultToSingle: true,
  });
  assert(
    !result.workstreams.default.outOfScope.includes("extension/src/dispatch.ts"),
    "AC: replaying #1020's plan with its issue body yields NO fence on extension/src/dispatch.ts",
  );
  assert(
    result.notes.some((n) => n === "unfenced extension/src/dispatch.ts: named by the issue"),
    "the removal is recorded as a plan note naming the issue as its authority",
  );
  assert(
    result.workstreams.default.paths.includes("extension/src/dispatch.ts"),
    "the removed path lands in the workstream's paths, so the develop gate has an owner for it",
  );
  // The rest of the fence survives — this is a surgical repair, not a wipe.
  assert(
    result.workstreams.default.outOfScope.includes("extension/src/spawn.ts"),
    "fences the issue never named are untouched (the fix does not weaken the fence)",
  );
  assert(
    result.workstreams.default.outOfScope.length === fixture.plan.default.outOfScope.length - 1,
    "exactly one fence entry was removed from #1020's plan",
  );
}

// ------------------------------------------------------- section extraction

{
  const body = [
    "## Context",
    "- We must change src/context.ts because reasons.",
    "## DECISIONS",
    "- Use src/dec.ts.",
    "## Resolved decisions",
    "- Use src/resolved.ts.",
    "## ACCEPTANCE CRITERIA",
    "- src/ac.ts is updated.",
    "## Out of scope",
    "- src/oos.ts is untouched by anyone.",
    "## Open questions about decisions",
    "- src/notdecisions.ts is merely adjacent prose.",
  ].join("\n");
  const toks = issueNamedTokens(body);
  assert(
    toks.includes("src/dec.ts"),
    "the DECISIONS section is read (any case, any heading level)",
  );
  assert(toks.includes("src/resolved.ts"), "the Resolved decisions section is read");
  assert(toks.includes("src/ac.ts"), "the ACCEPTANCE CRITERIA section is read");
  assert(
    !toks.includes("src/context.ts"),
    "the Context section is not a decision section — its paths are not requirements",
  );
  assert(
    !toks.includes("src/oos.ts"),
    "the issue's own Out of scope section does not unfence anything",
  );
  assert(
    !toks.includes("src/notdecisions.ts"),
    "a heading that merely CONTAINS the word decisions is not the decisions section",
  );
  assert(decisionSectionsOf(body).length === 3, "exactly the three named sections are collected");
  assert(
    issueNamedTokens("## Context\n- src/lonely.ts").length === 0,
    "no matching section → nothing extracted, nothing unfenced, no plan note",
  );
}

// -------------------------------------------------- prohibitions stay fenced

{
  const body = [
    "## Resolved decisions",
    "- Reuse src/helper.ts for the new path.",
    "- Do not touch src/protected.ts, it is owned by another team.",
  ].join("\n");
  const plan = {
    default: WS("default", ["src/new.ts"], ["src/helper.ts", "src/protected.ts"]),
  };
  const r = await unfenceIssueNamedPaths(plan, body, OPTS);
  assert(
    !r.workstreams.default.outOfScope.includes("src/helper.ts"),
    "a path a decision REQUIRES is unfenced",
  );
  assert(
    r.workstreams.default.outOfScope.includes("src/protected.ts"),
    "AC/decision prose that PROHIBITS touching a file keeps that fence (the issue asked for it)",
  );
  assert(
    !r.notes.some((n) => n.includes("src/protected.ts")),
    "a prohibition never produces an unfence note",
  );
}

// ------------------------------------------- sibling ownership keeps the fence

{
  const body = "## Decisions\n- dispatchCore lives in extension/src/dispatch.ts and gains a host.";
  const plan = {
    a: WS("a", ["src/a.ts"], ["extension/src/dispatch.ts"]),
    // The sibling OWNS the file the issue names.
    b: WS("b", ["extension/src/dispatch.ts"], []),
  };
  const r = await unfenceIssueNamedPaths(plan, body, OPTS);
  assert(
    r.workstreams.a.outOfScope.includes("extension/src/dispatch.ts"),
    "an issue-named path owned by a SIBLING stays fenced for the non-owner (operator resolution)",
  );
  assert(
    !r.workstreams.b.outOfScope.includes("extension/src/dispatch.ts"),
    "the owning workstream is never fenced on its own file",
  );
  assert(
    r.placed.length === 0,
    "a path its owner already declares is never added to a second workstream (that would be an overlap)",
  );
}

// ------------------------------------------------------ self-fence, no owner

{
  const body = "## Decisions\n- extension/src/dispatch.ts is where the seam lands.";
  const r = await unfenceIssueNamedPaths(
    { default: WS("default", ["extension/src/other.ts"], ["extension/src/dispatch.ts"]) },
    body,
    OPTS,
  );
  assert(
    !r.workstreams.default.outOfScope.includes("extension/src/dispatch.ts") &&
      r.workstreams.default.paths.includes("extension/src/dispatch.ts"),
    "an unowned removed path is placed in the sole workstream (N=1)",
  );
  assert(
    r.notes.some((n) => n.includes("placed in workstream default")),
    "the note names the workstream the path was placed into",
  );
}

// --------------------------------------------- placement: prefix, tie, none

{
  const plan = {
    alpha: WS("alpha", ["extension/src/a.ts"], []),
    beta: WS("beta", ["docs/b.md"], []),
    gamma: WS("gamma", ["extension/smoke-tests/g.ts"], []),
  };
  assert(
    placeUnplacedPath("extension/src/z.ts", plan) === "alpha",
    "placement follows the longest shared directory prefix",
  );
  assert(
    placeUnplacedPath("top-level/z.ts", plan) === undefined,
    "a path sharing no directory with any workstream is not placed anywhere (N>1 stays conservative)",
  );
  const tie = {
    "task-b": WS("task-b", ["src/b.ts"], []),
    "task-a": WS("task-a", ["src/a.ts"], []),
  };
  assert(
    placeUnplacedPath("src/z.ts", tie) === "task-b",
    "a tie goes to the earliest workstream in PLAN ORDER, not alphabetical order",
  );
}

// ------------------------------------------- unresolved identifiers never unfence

{
  const body = "## Decisions\n- dispatchCore and mysterySymbol both matter.\n- absentSymbol too.";
  const plan = {
    default: WS("default", ["src/a.ts"], ["src/ambiguous.ts", "src/nonexistent.ts"]),
  };
  const r: UnfenceResult = await unfenceIssueNamedPaths(plan, body, {
    execFn: async (_c: string, o?: { argv?: string[] }) => {
      const argv = o?.argv ?? [];
      if (argv[0] === "grep") {
        if (argv[4] === "mysterySymbol") {
          return { stdout: "src/ambiguous.ts\nsrc/also.ts\n" };
        }
        return { stdout: "" };
      }
      return { stdout: "// no definition here\n" };
    },
    repoRoot: "/repo",
    ref: "origin/main",
    defaultToSingle: true,
  });
  assert(
    r.workstreams.default.outOfScope.includes("src/ambiguous.ts"),
    "an identifier matching SEVERAL source files unfences nothing (ambiguity is never resolved on a guess)",
  );
  assert(
    r.workstreams.default.outOfScope.includes("src/nonexistent.ts"),
    "an identifier matching NOTHING unfences nothing",
  );
  assert(
    r.warnings.some((w) => w.startsWith("unresolved identifier mysterySymbol:")),
    "the ambiguous name is recorded as a plan note rather than silently ignored",
  );
  assert(
    r.warnings.some((w) => w.startsWith("unresolved identifier absentSymbol:")),
    "a name with no defining file is recorded too",
  );
}

// ------------------------------------------------------ globs are not paths

{
  const plan = { default: WS("default", ["src/a.ts"], ["src/keep.ts"]) };
  const r = await unfenceIssueNamedPaths(
    plan,
    "## ACCEPTANCE CRITERIA\n- test-work-driver-plan* and test-work-driver-scope* pass.",
    OPTS,
  );
  assert(
    r.workstreams.default.outOfScope.includes("src/keep.ts"),
    "a glob in the acceptance criteria names no file and unfences nothing",
  );
  assert(r.removed.length === 0, "no fence was removed by a glob-only criteria list");
}

// ------------------------------------------------- identifier resolution rules

{
  assert(
    definesSymbol("export function dispatchCore(\n  pi: unknown,\n) {}\n", "dispatchCore"),
    "a declaration line counts as a definition",
  );
  assert(
    !definesSymbol("  // the driver calls dispatchCore once\n", "dispatchCore"),
    "a comment mentioning the name is not a definition (that is how a test file would win)",
  );
  assert(
    !definesSymbol("const dispatchCorey = 1;\n", "dispatchCore"),
    "a name that merely starts with the symbol is not the symbol",
  );
  const files: string[] = [];
  const sole = await resolveDefiningFile("thing", ["src/a.ts", "src/b.ts"], async (f) => {
    files.push(f);
    return f === "src/a.ts" ? "export function thing() {}\n" : "//\n";
  });
  assert(sole === "src/a.ts", "exactly one candidate carries a definition → that file resolves");
  assert(
    (await resolveDefiningFile("thing", ["src/a.ts", "src/b.ts"], async () => "//\n")) ===
      undefined,
    "zero definitions → ambiguous → nothing resolves",
  );
  assert(
    (await resolveDefiningFile(
      "thing",
      ["src/a.ts", "test/a.ts", "AGENTS.md"],
      async () => "export function thing() {}\n",
    )) === "src/a.ts",
    "test and prose candidates never own a symbol even when they contain the same text",
  );
  assert(files.length === 2, "every source candidate is read before deciding (no early win)");
}

// --------------------------- the plan step runs the pass and keeps the plan

{
  process.env.PI_ENSEMBLE_RESUME = "0";
  process.env.PI_ENSEMBLE_CROSS_GROUP_CONFLICTS = "0";
  const body = [
    "# Title",
    "",
    "## Resolved decisions",
    "- The seam lives in extension/src/dispatch.ts.",
    "",
    "## Out of scope",
    "- nothing else",
  ].join("\n");
  const planReply = [
    "## Workstreams",
    "",
    "### default — the seam",
    "- paths: extension/src/host.ts",
    "- out-of-scope: extension/src/dispatch.ts, docs/",
    "",
  ].join("\n");
  const tmp = `${process.env.TMPDIR ?? "/tmp"}/plan-unfence-${process.pid}.md`;
  await Bun.write(tmp, body);
  const state0 = {
    ...initialState(1167, 1_000_000),
    pipelineState: { ...initialState(1167, 1_000_000).pipelineState, issueBodyArtifact: tmp },
  };
  const ctx = {
    // biome-ignore lint/suspicious/noExplicitAny: the host is unused on this path
    host: {} as any,
    repoRoot: "/repo",
    issue: 1167,
    dispatchFn: async () => ({
      role: "explore" as const,
      ok: true,
      text: planReply,
      toolUses: [],
      ms: 1,
      exitCode: 0,
    }),
    // The step's grep seam is stubbed so the test never touches a real repo.
    verifyExecFn: stubExec({}),
  };
  const next = await runPlan(ctx, state0, 1_000_000);
  const ws = next.pipelineState.workstreams?.default;
  assert(ws !== undefined, "runPlan produced the default workstream");
  assert(
    !(ws?.outOfScope ?? []).includes("extension/src/dispatch.ts"),
    "runPlan removes the issue-named fence from the plan it hands develop",
  );
  assert(
    (ws?.paths ?? []).includes("extension/src/dispatch.ts"),
    "runPlan places the removed path in the workstream's paths",
  );
  assert(
    (ws?.outOfScope ?? []).includes("docs/"),
    "the untouched part of the fence still reaches develop",
  );
  assert(
    !(next.eventLog ?? []).some((e) => e.kind === "cap-hit"),
    "an unfenced plan is not a capped plan",
  );
  await Bun.write(tmp, "");
}

// ---------------------------- a contradiction the issue does not name re-dispatches

{
  // AC #2, narrowed per the operator resolution: the corrective re-dispatch is
  // for a self-contradictory fence the ISSUE never mentioned. The issue-named
  // case above is repaired silently and must NOT burn the one-shot budget.
  process.env.PI_ENSEMBLE_RESUME = "0";
  process.env.PI_ENSEMBLE_CROSS_GROUP_CONFLICTS = "0";
  const first = [
    "## Workstreams",
    "",
    "### task-a — the fix",
    "- paths: src/a.ts",
    "- out-of-scope: src/a.ts, docs/",
    "",
    "### task-b — the other half",
    "- paths: src/b.ts",
    "- out-of-scope: src/a.ts",
    "",
  ].join("\n");
  const second = [
    "## Workstreams",
    "",
    "### task-a — the fix",
    "- paths: src/a.ts",
    "- out-of-scope: docs/",
    "",
    "### task-b — the other half",
    "- paths: src/b.ts",
    "- out-of-scope: src/a.ts",
    "",
  ].join("\n");
  const prompts: string[] = [];
  const ctx = {
    // biome-ignore lint/suspicious/noExplicitAny: the host is unused on this path
    host: {} as any,
    repoRoot: "/repo",
    issue: 1167,
    dispatchFn: async (_pi: unknown, spec: { prompt: string }) => {
      prompts.push(spec.prompt);
      return {
        role: "explore" as const,
        ok: true,
        text: prompts.length === 1 ? first : second,
        toolUses: [],
        ms: 1,
        exitCode: 0,
      };
    },
    verifyExecFn: stubExec({}),
  };
  const next = await runPlan(ctx, initialState(1167, 1_000_000), 1_000_000);
  assert(
    prompts.length === 2,
    "a self-contradictory fence triggers exactly one corrective re-dispatch",
  );
  assert(
    /out-of-scope/.test(prompts[1] ?? "") && /src\/a\.ts/.test(prompts[1] ?? ""),
    "the corrective prompt names the file the plan contradicts itself about",
  );
  assert(
    next.pipelineState.planQuality?.reason === "contradictory-fence",
    "the recorded reason is contradictory-fence, not a stale or defaulted one",
  );
  assert(
    next.pipelineState.planQuality?.redispatched === true,
    "the state records that the one-shot corrective was spent",
  );
  assert(
    !(next.pipelineState.workstreams?.["task-a"]?.outOfScope ?? []).includes("src/a.ts"),
    "the corrected plan the cycle keeps has no self-contradictory fence",
  );
}

console.log(exit === 0 ? "\nAll plan-unfence assertions passed." : "\nFAILURES above.");
process.exit(exit);
