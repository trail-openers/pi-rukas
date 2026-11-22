#!/usr/bin/env bun
/**
 * lean/ready-setup — a setup refusal is its own signal, and only setup causes carry it.
 *
 * A host falls back to another driver on `failure.kind: "setup"` alone, so each setup cause is
 * driven through `runLean` with the production `ready` handler and the REAL config loader at a
 * real base, in `derive` mode, and must end handed-back (exit 10) with that kind — before the
 * issue was read, before any child ran, with no reporting step and nothing posted. Each issue cause
 * is driven the same way over a usable config and must never carry the kind.
 */

import { leanIssueResult } from "../src/headless/work-lean-result.ts";
import { phase1Handlers } from "../src/lean/command.ts";
import { type ConfigExec, loadWorkConfig } from "../src/lean/config.ts";
import { type LeanHandlers, runLean } from "../src/lean/engine.ts";
import { setLeanCommentPoster } from "../src/lean/io.ts";
import { readySetup } from "../src/lean/ready-setup.ts";
import type { DispatchResult } from "../src/types.ts";
import { withEnv } from "./lib/env-scope.ts";
import { makeAssert } from "./lib/lean-engine-fixtures.ts";
import { tempGitRepo, worktreeCommit } from "./lib/lean-spec-intake-fixtures.ts";

const { assert, failures } = makeAssert();

const USABLE = JSON.stringify({ version: 1, verify: { test: "pytest {file}" } });
const block = (spec: object): string => `\`\`\`pi-spec v1\n${JSON.stringify(spec)}\n\`\`\``;
const SPEC = { problem: "p", criteria: [{ id: "AC1", text: "a", verify: "test" }], size: "S" };
const NO_BLOCK_REPLY: DispatchResult = {
  role: "explore",
  ok: true,
  text: "no contract here",
  toolUses: [],
  ms: 1,
  exitCode: 0,
};

/** Drive one run to its end; `config` is committed at the base, or nothing is when undefined. */
async function drive(
  tag: string,
  config: string | undefined,
  body: () => Promise<string>,
  intake = "derive",
) {
  const { dir, cleanup } = tempGitRepo(tag);
  const base = worktreeCommit(
    dir,
    config === undefined ? { README: "x\n" } : { ".pi/work.json": config },
  );
  const calls = { fetches: 0, children: 0, posts: 0 };
  const undo = setLeanCommentPoster(async () => {
    calls.posts++;
  });
  try {
    const handlers: LeanHandlers = phase1Handlers(
      dir,
      2511,
      {},
      {
        fetchBody: async () => {
          calls.fetches++;
          return body();
        },
        issueTitle: async () => "t",
        dispatch: async () => {
          calls.children++;
          return NO_BLOCK_REPLY;
        },
        mainlineWhy: async () => undefined,
        post: async () => {
          calls.posts++;
        },
      },
    );
    // Nothing past `ready` belongs to this case: a run that got there is already wrong.
    handlers.specify = async () => ({ kind: "budget", reason: "out of scope" });
    let result: Awaited<ReturnType<typeof runLean>> | undefined;
    await withEnv(
      { PI_ENSEMBLE_LEAN_SPEC_INTAKE: intake, PI_ENSEMBLE_LEAN_PROJECT_ROSTER: undefined },
      async () => {
        result = await runLean({
          repoRoot: dir,
          issue: 2511,
          handlers,
          seed: { version: "t", baseSha: base },
        });
      },
    );
    if (result === undefined) throw new Error("no run");
    return { result, doc: leanIssueResult(result.run, result.code), calls };
  } finally {
    undo();
    cleanup();
  }
}

// ── Every setup cause: handed-back, `failure.kind: "setup"`, nothing read, billed or posted.
for (const [tag, config, names] of [
  ["absent", undefined, "verify.test is unset"],
  ["invalid-json", "{not json", "not valid JSON"],
  ["loader-refused", JSON.stringify({ version: 1, lean: { specIntake: "derve" } }), "specIntake"],
  ["no-test", JSON.stringify({ version: 1 }), "verify.test is unset"],
  [
    "roster",
    JSON.stringify({ version: 1, verify: { test: "cargo test {file}" } }),
    "verify.roster",
  ],
] as const) {
  const { result, doc, calls } = await drive(`setup-${tag}`, config, async () => block(SPEC));
  const label = `setup cause ${tag}`;
  assert(
    result.state === "handed-back" && result.code === 10,
    `${label}: the run hands back at exit 10 (${result.state}/${result.code})`,
  );
  assert(
    doc.failure?.kind === "setup" && doc.status === "handoff",
    `${label}: the result carries failure.kind "setup" (${JSON.stringify(doc.failure)})`,
  );
  assert(
    (doc.failure?.message ?? "").includes(names),
    `${label}: the message names the fault (${doc.failure?.message})`,
  );
  assert(
    calls.fetches === 0 && calls.children === 0,
    `${label}: refused before the issue was read or a child ran (${JSON.stringify(calls)})`,
  );
  assert(
    calls.posts === 0 && result.run.steps.length === 1,
    `${label}: no reporting step ran and nothing was posted (${calls.posts} posts, ${result.run.steps.length} steps)`,
  );
}

// ── Every issue cause over a usable setup: never `setup`, and the issue causes still decline.
for (const [tag, body, state, intake] of [
  ["unreadable", () => Promise.reject(new Error("gh: not found")), "not-ready", "derive"],
  ["malformed-block", async () => "```pi-spec v1\n{nope\n```", "not-ready", "derive"],
  ["unready", async () => block({ ...SPEC, size: "L" }), "not-ready", "derive"],
  ["no-block", async () => "prose with no block", "not-ready", "require"],
  ["derive-failed", async () => "prose with no block", "handed-back", "derive"],
] as const) {
  const { result, doc } = await drive(`issue-${tag}`, USABLE, body, intake);
  assert(
    result.state === state &&
      result.run.steps[0]?.outcome?.kind !== "setup" &&
      doc.failure?.kind !== "setup",
    `issue cause ${tag}: ends ${state} without the setup kind (${result.state}, ${JSON.stringify(doc.failure)})`,
  );
}

// ── A git that never answered is not "no config": a timed-out read propagates as a crash.
for (const failing of ["cat-file", "show"]) {
  const timedOut: ConfigExec = async (_cmd, opts) => {
    const argv = (opts as { argv?: string[] }).argv ?? [];
    if (argv[0] === failing)
      throw Object.assign(new Error("command timed out"), { code: null, killed: true });
    return { stdout: argv[0] === "cat-file" ? "blob\n" : "{}", stderr: "" };
  };
  const verdict = await readySetup(() => loadWorkConfig(timedOut, "/nowhere", "0".repeat(40))).then(
    (v) => JSON.stringify(v),
    (err: Error) => `threw ${err.name}`,
  );
  assert(verdict === "threw Error", `a timed-out git ${failing} is no setup verdict (${verdict})`);
}

process.exit(failures());
