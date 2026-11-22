#!/usr/bin/env bun
/**
 * lean/command — the deriving child's cost reaches the durable record.
 *
 * `ready` is the one step that pays for a model in `derive` mode, and a cost the
 * step log does not hold is a cost no host ever sees: `leanUsage` folds the record's
 * `Outcome.dispatches` rows into `usage`/`usage.byRole`, so a run that billed an
 * `explore` child and recorded no row reports a cheaper run than it had. The
 * membership that decides this is `DISPATCH_STATES`, and `ready` was not in it —
 * which fails silently, because a state that may not hold rows simply has them
 * dropped rather than refused.
 *
 * Driven through `runLean` with the production `ready` handler and stubbed seams, so
 * what is asserted is the record on disk the engine wrote, not a return value.
 */

import { phase1Handlers } from "../src/lean/command.ts";
import type { WorkConfig } from "../src/lean/config.ts";
import type { LeanHandlers } from "../src/lean/engine.ts";
import { runLean } from "../src/lean/engine.ts";
import { setLeanCommentPoster } from "../src/lean/io.ts";
import type { DispatchResult } from "../src/types.ts";
import { withEnv } from "./lib/env-scope.ts";
import { makeAssert } from "./lib/lean-engine-fixtures.ts";
import { removeDir, tempGitRepo, worktreeCommit } from "./lib/lean-spec-intake-fixtures.ts";

const { assert, failures } = makeAssert();

const PROSE = "The engine should derive a contract for a prose ticket.";
const CHILD = {
  role: "explore",
  ok: true,
  text: "```pi-spec v1\n" +
    JSON.stringify(
      {
        problem: "a prose ticket has no contract",
        criteria: [{ id: "AC1", text: "a prose ticket gets one", verify: "test" }],
        size: "S",
      },
      null,
      2,
    ) +
    "\n```",
  toolUses: [],
  ms: 2_500,
  exitCode: 0,
  usage: { input: 40, output: 12, cacheRead: 0, cacheWrite: 0, cost: 0.02, turns: 3 },
} satisfies DispatchResult;

const AFTER_READY = [
  "specify",
  "build",
  "challenge",
  "verify",
  "publish",
  "review",
  "ci",
  "land",
] as const;

/** Drive a derive run to its first post-ready state and hand back the record. */
async function driveDerivedRun(tag: string, child: () => Promise<DispatchResult>) {
  const { dir, cleanup } = tempGitRepo(tag);
  const base = worktreeCommit(dir, { ".pi/work.json": JSON.stringify({ version: 1 }) });
  const undo = setLeanCommentPoster(async () => {});
  try {
    const deps = {
      mainlineWhy: async () => undefined,
      fetchBody: async () => PROSE,
      issueTitle: async () => "prose ticket",
      loadConfig: async (): Promise<WorkConfig> => ({
        version: 1 as const,
        autoMerge: false,
        verify: { test: "pytest {file}" },
        budgets: {},
        lean: { specIntake: "derive" as const },
      }),
      dispatch: child,
      post: async () => {},
    };
    const handlers: LeanHandlers = { ...phase1Handlers(dir, 740, {}, deps) };
    for (const state of AFTER_READY)
      handlers[state] = async () => ({ kind: "blocked", reason: `${state} is out of scope here` });
    let driven: Awaited<ReturnType<typeof runLean>> | undefined;
    await withEnv({ PI_ENSEMBLE_LEAN_SPEC_INTAKE: "derive" }, async () => {
      driven = await runLean({
        repoRoot: dir,
        issue: 740,
        handlers,
        seed: { version: "test", baseSha: base },
        now: () => 1_700_000_000_000,
      });
    });
    return { ready: driven?.run.steps.find((s) => s.state === "ready"), base };
  } finally {
    undo();
    cleanup();
  }
}

// ── A derived `ready` records ONE cost row for the child it paid for.
{
  const run = await driveDerivedRun("lean-derive-cost", async () => CHILD);
  const oc = run.ready?.outcome;
  assert(oc?.kind === "ok", `the run's ready step succeeded (got ${String(oc?.kind)})`);
  assert(oc?.derivedSpec !== undefined, "…and recorded the derived contract");
  const rows = oc?.dispatches;
  assert(rows?.length === 1, `…and exactly one dispatch row for the one child (got ${String(rows?.length)})`);
  assert(
    rows?.[0]?.role === "explore" && rows?.[0]?.usage?.input === 40 && rows?.[0]?.ms === 2_500,
    `…carrying the child's own role, cost and wall clock (got ${JSON.stringify(rows?.[0])})`,
  );
  assert(rows?.[0]?.ok === true, "…and the step's own judgement of the child");
}

// ── A child that died still cost tokens: the row rides on the failure too.
{
  const dead: DispatchResult = {
    role: "explore",
    ok: false,
    text: "",
    toolUses: [],
    ms: 4_000,
    exitCode: 1,
    killCause: "timeout",
    usage: { input: 30, output: 4, cacheRead: 0, cacheWrite: 0, cost: 0.01, turns: 2 },
  };
  const run = await driveDerivedRun("lean-derive-dead", async () => dead);
  const rows = run.ready?.outcome?.dispatches;
  assert(
    rows?.length === 1 && rows[0]?.ok === false,
    `a dead deriving child records its cost as an unsuccessful row (got ${JSON.stringify(rows)})`,
  );
  assert(
    rows?.[0]?.usage?.input === 30,
    `…naming the tokens it spent (got ${String(rows?.[0]?.usage?.input)})`,
  );
}

// ── The asymmetry, stated as a positive: a `ready` that paid for nothing records
// no key at all, so `ready` joining the set is a widening and not a wildcard.
{
  const { dir, cleanup } = tempGitRepo("lean-derive-nocost");
  const base = worktreeCommit(dir, { ".pi/work.json": JSON.stringify({ version: 1 }) });
  const undo = setLeanCommentPoster(async () => {});
  let driven: Awaited<ReturnType<typeof runLean>> | undefined;
  try {
    const deps = {
      mainlineWhy: async () => undefined,
      fetchBody: async () =>
        "```pi-spec v1\n" +
        JSON.stringify({ problem: "authored", criteria: [{ id: "AC1", text: "a", verify: "test" }], size: "S" }) +
        "\n```",
      issueTitle: async () => "authored ticket",
      loadConfig: async (): Promise<WorkConfig> => ({
        version: 1 as const,
        autoMerge: false,
        verify: { test: "pytest {file}" },
        budgets: {},
      }),
      dispatch: async () => {
        throw new Error("no child may run for an authored contract");
      },
      post: async () => {},
    };
    const handlers: LeanHandlers = { ...phase1Handlers(dir, 741, {}, deps) };
    for (const state of AFTER_READY)
      handlers[state] = async () => ({ kind: "blocked", reason: "out of scope here" });
    driven = await runLean({
      repoRoot: dir,
      issue: 741,
      handlers,
      seed: { version: "test", baseSha: base },
      now: () => 1_700_000_000_000,
    });
  } finally {
    undo();
    cleanup();
  }
  const oc = driven?.run.steps.find((s) => s.state === "ready")?.outcome;
  assert(oc?.kind === "ok", `an authored contract still gets through (got ${String(oc?.kind)})`);
  assert(
    oc?.dispatches === undefined,
    `a ready that billed no child records no rows (got ${JSON.stringify(oc?.dispatches)})`,
  );
  assert(oc?.derivedSpec === undefined, "…and no derived contract either");
}

process.exit(failures());
