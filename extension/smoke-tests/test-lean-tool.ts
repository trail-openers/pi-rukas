#!/usr/bin/env bun
/**
 * `start_lean_driver` (#2392): it launches the lean engine in the background and returns at
 * once, delivers the outcome as one steer naming the issue and its state, refuses a second launch
 * while a run holds the issue's lock, answers a finished run from its state file, validates its
 * three arguments as the headless verb does, carries `specIntake` as a value for its run only, and
 * has no way to reach merge authority. The run seam is a fake: nothing here spawns a child.
 */
import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { clearJobsForTesting } from "../src/async-jobs.ts";
import { type RunLean, registerLeanTool } from "../src/lean-tool.ts";
import { phase1Handlers } from "../src/lean/command.ts";
import { runLean } from "../src/lean/engine.ts";
import { acquireLock } from "../src/lean/lock.ts";
import { resolveSpecIntake } from "../src/lean/spec-intake-switch.ts";
import { loadRun, saveRun } from "../src/lean/state.ts";
import { withEnv } from "./lib/env-scope.ts";
import { jobSteerInbox, makeJobDeliverer, waitForJobReport } from "./plan-test-stubs.ts";

let failures = 0;
function check(cond: boolean, msg: string) {
  console.log(`${cond ? "✓" : "✗"} ${msg}`);
  if (!cond) failures++;
}

interface Tool {
  name: string;
  parameters: { properties?: Record<string, unknown> };
  execute: (
    ...a: unknown[]
  ) => Promise<{ content: Array<{ text: string }>; details: Record<string, unknown> }>;
}

const repo = mkdtempSync(path.join(tmpdir(), "pi-ens-2392-"));
spawnSync("git", ["init", "-q", repo]);

/** A run the test settles by hand, recording what the tool passed it. */
const calls: Array<{ issue: number; opts: Record<string, unknown> }> = [];
let settle:
  | { resolve: (v: Awaited<ReturnType<RunLean>>) => void; reject: (e: unknown) => void }
  | undefined;
const fakeRun = ((_root: string, issue: number, opts: Record<string, unknown> = {}) => {
  calls.push({ issue, opts });
  return new Promise((resolve, reject) => {
    settle = { resolve, reject };
  });
}) as unknown as RunLean;

const tools: Tool[] = [];
registerLeanTool(
  { registerTool: (t: Tool) => void tools.push(t), ...makeJobDeliverer() } as never,
  fakeRun,
);
const tool = tools[0] as Tool;
const call = (params: Record<string, unknown>, hasUI = false) =>
  tool.execute("id", params, undefined, undefined, { cwd: repo, hasUI });

try {
  // ── The surface: one tool, three inputs, none of which can reach merge authority.
  check(tool.name === "start_lean_driver", "registers start_lean_driver");
  const props = Object.keys(tool.parameters.properties ?? {});
  check(
    props.join(",") === "issue,specIntake,timeoutMinutes",
    `takes issue, specIntake, timeoutMinutes (${props})`,
  );
  check(
    !props.some((p) => /merge|protected|grant/i.test(p)),
    "no parameter reaches merge authority",
  );

  // ── Argument validation, refused before any launch.
  for (const [params, why] of [
    [{ issue: 0 }, "issue must be a positive integer"],
    [{ issue: 7, specIntake: "derve" }, "specIntake must be one of require, derive"],
    [{ issue: 7, timeoutMinutes: 0 }, "timeoutMinutes needs minutes > 0"],
    [{ issue: 7, timeoutMinutes: Number.NaN }, "timeoutMinutes needs minutes > 0"],
  ] as const) {
    const r = await call(params);
    check(
      r.details.started === false && (r.content[0]?.text ?? "").includes(why),
      `refuses ${JSON.stringify(params)}: ${why}`,
    );
  }
  check(calls.length === 0, "no refused call reached the engine");

  // ── Launch: returns at once, the run still pending, with the session's trust mode.
  const envBefore = process.env.PI_ENSEMBLE_LEAN_SPEC_INTAKE;
  const launch = await call({ issue: 7, specIntake: "derive", timeoutMinutes: 2 });
  const jobId = String(launch.details.jobId);
  check(
    launch.details.started === true && launch.details.async === true,
    "launch returns started + async at once",
  );
  check(calls.length === 1 && settle !== undefined, "the engine was called and is still running");
  check(
    JSON.stringify(calls[0]?.opts) ===
      JSON.stringify({ headless: true, specIntake: "derive", timeoutMs: 120_000 }),
    `the run gets the session's trust mode, its specIntake and the deadline, nothing else (${JSON.stringify(calls[0]?.opts)})`,
  );
  check(process.env.PI_ENSEMBLE_LEAN_SPEC_INTAKE === envBefore, "specIntake never writes the env");

  // ── A second launch while the first holds the issue.
  const again = await call({ issue: 7 });
  const againText = again.content[0]?.text ?? "";
  check(
    again.details.started === false &&
      againText.includes(`job ${jobId}`) &&
      againText.includes(".pi/lean-state/7.json.lock"),
    "a second launch names this session's run and the lock path",
  );
  check(calls.length === 1, "…and starts nothing");

  // ── The outcome arrives as one steer naming the issue and its state.
  settle?.resolve({
    summary: "work-lean #7: landed (exit 0) — merged",
    result: { state: "landed" },
  } as never);
  const steer = await waitForJobReport(jobId);
  check(
    steer.includes("lean run #7: landed"),
    `the steer names the issue and the state (${steer.split("\n")[2]})`,
  );

  // ── A crash is reported as crashed, naming the error, and frees the issue for the next launch.
  const crash = await call({ issue: 7 }, true);
  check(
    calls.at(-1)?.opts.headless === false,
    "an interactive session's run is not stamped headless",
  );
  settle?.reject(new Error("git exploded"));
  const crashSteer = await waitForJobReport(String(crash.details.jobId));
  check(
    crashSteer.includes("lean run #7: crashed — git exploded"),
    "a rejected run is reported as crashed with its error",
  );

  // ── A lock this tool did not take (the slash command, another session) refuses too.
  const release = acquireLock(repo, 8);
  const foreign = await call({ issue: 8 });
  release();
  check(
    foreign.details.started === false &&
      (foreign.content[0]?.text ?? "").includes("a run this tool did not start"),
    "a lock held by another run is refused as one this tool did not start",
  );

  // ── A finished run is answered from its state file; nothing starts. The record is the
  // engine's own (a handler error ends it handed-back), so its step log earns its result.
  await runLean({
    repoRoot: repo,
    issue: 9,
    handlers: {
      ready: async () => {
        throw new Error("no forge here");
      },
    },
  });
  const before = calls.length;
  const finished = await call({ issue: 9 });
  check(
    finished.details.started === false &&
      (finished.content[0]?.text ?? "").includes(
        "already finished: handed-back (exit 10) — handler error at ready: no forge here",
      ),
    "a recorded result is answered, not relaunched",
  );
  check(calls.length === before, "…and the engine is not called");

  // ── A record whose stamp its own log does not give is the engine's to refuse, so the tool
  // launches it rather than repeating the claim: a wrong exit code, and a snapshot state the
  // log does not replay to.
  for (const [n, tamper, label] of [
    [
      12,
      { result: { code: 0, reason: "merged" } },
      "a stamped code the log's state does not exit with",
    ],
    [
      13,
      { state: "not-ready", result: { code: 11, reason: "declined" } },
      "a snapshot state the log does not replay to",
    ],
  ] as const) {
    await runLean({
      repoRoot: repo,
      issue: n,
      handlers: { ready: async () => Promise.reject(new Error("x")) },
    });
    const real = loadRun(repo, n);
    if (real !== undefined) saveRun(repo, { ...real, ...tamper } as never);
    const claimed = await call({ issue: n });
    check(claimed.details.started === true, `${label} is launched, not reported as finished`);
    settle?.resolve({ summary: "s", result: { state: "handed-back" } } as never);
    await waitForJobReport(String(claimed.details.jobId));
  }

  // ── The override outranks env and config, and reaches the run's `ready` step.
  await withEnv({ PI_ENSEMBLE_LEAN_SPEC_INTAKE: "require" }, async () => {
    check(
      resolveSpecIntake({ lean: { specIntake: "require" } } as never, "derive") === "derive",
      "the override outranks env and config",
    );
    check(resolveSpecIntake(undefined) === "require", "no override resolves as before");
  });
  const drafted = async (specIntake?: "derive") => {
    let dispatched = false;
    const handlers = phase1Handlers(repo, 10, specIntake ? { specIntake } : {}, {
      fetchBody: async () => "a prose ticket with no block",
      issueTitle: async () => "t",
      loadConfig: async () => ({}) as never,
      dispatch: async () => {
        dispatched = true;
        throw new Error("stop here");
      },
    });
    await withEnv({ PI_ENSEMBLE_LEAN_SPEC_INTAKE: undefined }, async () => {
      await handlers.ready?.({ run: { baseSha: "" } } as never).catch(() => undefined);
    });
    return dispatched;
  };
  check((await drafted("derive")) === true, "a derive override makes ready draft a contract");
  check((await drafted()) === false, "without it ready drafts nothing (require)");

  // ── The docs name the tool.
  const lean = readFileSync(path.join(import.meta.dir, "..", "..", "docs", "lean.md"), "utf8");
  check(
    /## Running it[\s\S]*`start_lean_driver`/.test(lean),
    'docs/lean.md "Running it" names start_lean_driver',
  );
} finally {
  clearJobsForTesting();
  jobSteerInbox.length = 0;
  rmSync(repo, { recursive: true, force: true });
}

if (failures > 0) {
  console.error(`FAIL test-lean-tool: ${failures} check(s) failed`);
  process.exit(1);
}
console.log("PASS test-lean-tool");
