/**
 * Fixtures for `test-headless-work-lean.ts` and its lock/trust companion,
 * split out so neither file carries the whole verb's surface (AGENTS.md §12).
 *
 * The three shapes here are the ones a test of the `work-lean` verb needs and
 * cannot get from the shared `headless-verb-harness.ts`:
 *
 *   - `fakeRun` / `step` — a `RunLeanResult` whose step log is whatever the case
 *     is about, with everything else the record has to carry filled in.
 *   - `verbRun` — the verb driven with an injected `run`, plus the mode the verb
 *     handed that run (the headless thread is observable only there).
 *   - `spawnProbe` — the verb run in a REAL child. The harness captures stdout
 *     and leaves stderr alone, so a `traceWarn` the verb writes is invisible to
 *     it; a child with nothing captured shows what the runner really puts on
 *     stderr, which is what a host diagnosing a crash reads.
 */

import { writeFileSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { spawnSync } from "node:child_process";
import os from "node:os";
import path from "node:path";
import { runWorkLeanVerb } from "../../src/headless/work-lean.ts";
import type { RunLeanResult } from "../../src/lean/engine.ts";
import type { LeanState, Step } from "../../src/lean/state.ts";
import { runVerb } from "../headless-verb-harness.ts";

export const REPO = "/tmp/pi-rukas-work-lean-verb";
export const SRC = path.resolve(import.meta.dirname, "..", "..", "src");

/** A run whose step log is `steps` and whose stamp is `code`/`state`. */
export function fakeRun(overrides: {
  code: number;
  state: LeanState;
  reason?: string;
  steps?: Step[];
}): RunLeanResult {
  return {
    code: overrides.code,
    state: overrides.state,
    run: {
      schema: 1,
      issue: 7,
      version: "0.0.0-test",
      models: {},
      baseSha: "feedbeef1234567890feedbeef1234567890abcd",
      branch: "feature/issue-7-thing",
      state: overrides.state,
      counters: {
        buildAttempts: 1,
        challengeDone: true,
        reviewDone: false,
        ciFixUsed: false,
        draft: false,
      },
      steps: overrides.steps ?? [],
      result: { code: overrides.code, reason: overrides.reason ?? "because" },
    },
  };
}

export function step(state: Step["state"], outcome: Step["outcome"] = { kind: "ok" }): Step {
  return { key: `7:${state}:0`, state, startedAt: 1, endedAt: 2, outcome };
}

/** What an injected `run` was asked to do, and what it was asked with. */
export interface InjectedRun {
  /** What the verb handed the engine as this run's mode. */
  mode?: { headless?: boolean };
  /** Whether the injected run was called at all (argv refusals must not call it). */
  ran: boolean;
}

export type VerbRun = Awaited<ReturnType<typeof runVerb>> & InjectedRun;

/**
 * Run the verb with an injected `run`, checking the shared output contract.
 *
 * `reply` is what the engine would have returned; it sees the opts the verb
 * passed, which is the only place the headless thread can be observed without
 * starting the real engine.
 */
export async function verbRun(
  argv: string[],
  reply: (opts: {
    headless?: boolean;
  }) => Promise<{ summary: string; result: RunLeanResult } | undefined>,
): Promise<VerbRun> {
  const asked: { headless?: boolean }[] = [];
  let ran = false;
  const r = await runVerb("work-lean", argv, REPO, (_argv, ctx) =>
    runWorkLeanVerb(argv, ctx, async (_root, _issue, opts) => {
      ran = true;
      asked.push(opts ?? {});
      return (await reply(opts ?? {})) as never;
    }),
  );
  return { ...r, mode: asked[0], ran };
}

/** Run the verb with a `run` that throws `err`. */
export async function verbThrowing(argv: string[], err: unknown): Promise<VerbRun> {
  return verbRun(argv, async () => {
    throw err;
  });
}

/**
 * Run the verb in a real child whose injected `run` is `runSource`, and return
 * the child's stderr.
 *
 * `echoMessages` mirrors the host's `sendUserMessage` onto stderr so a case can
 * see what the verb TOLD the host, which the harness swallows.
 */
export async function spawnProbe(runSource: string, echoMessages = false): Promise<string> {
  const dir = await mkdtemp(path.join(os.tmpdir(), "work-lean-probe-"));
  const probe = path.join(dir, "probe.ts");
  writeFileSync(
    probe,
    `import { runWorkLeanVerb } from ${JSON.stringify(path.join(SRC, "headless", "work-lean.ts"))};\n` +
      `import { LeanLockError } from ${JSON.stringify(path.join(SRC, "lean", "lock.ts"))};\n` +
      `const host = { sendUserMessage: (t: string) => { if (${String(echoMessages)}) process.stderr.write(t + "\\n"); }, emit: () => {} };\n` +
      `${runSource}\n` +
      `const out = await runWorkLeanVerb(["7"], { repoRoot: ${JSON.stringify(dir)}, host }, run);\n` +
      `process.exit(out.exitCode);\n`,
  );
  const r = spawnSync(process.execPath, [probe], { encoding: "utf8" });
  await rm(dir, { recursive: true, force: true });
  return r.stderr;
}

/** A child whose injected run throws one Error with a two-frame stack. */
export function spawnCrash(): Promise<string> {
  return spawnProbe(
    `const run = async () => { const e = new Error("git exploded"); e.stack = "Error: git exploded\\n" + " ".repeat(3) + "at runWorkLeanVerb (/x/work-lean.ts:1:1)"; throw e; };`,
  );
}
