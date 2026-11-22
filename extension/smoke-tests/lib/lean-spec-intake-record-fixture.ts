/**
 * lib/lean-spec-intake-record-fixture — the rig for the derived contract's POST-READY
 * LIFE on the run record (`test-lean-spec-intake-record.ts`).
 *
 * Sibling of `lean-spec-intake-post-fixture.ts`, and deliberately a separate file: the
 * two are both capped by AGENTS.md §12's 500-line gate, and the claims differ. That rig
 * counts what LEAVES the process (posts, children); this one reads what STAYS on disk —
 * the record `loadRun` returns, plus what the next step's handler was actually handed.
 *
 * Nothing here asserts. The rig drives the REAL `runLean` engine and the REAL `ready`
 * handler over a real git repo, and stubs only `ready`'s outside calls (its `ReadyDeps`
 * argument, never the handler itself — a case that swapped `ready` wholesale would be
 * judging its own stub) plus every step after it.
 *
 * Two witnesses, both read off disk rather than from a return value: the engine's own
 * save path writes `<repoRoot>/.pi/lean-state/<issue>.json`, and `loadRun` is the only
 * reader of it, so what the case asserts is what a resume would get.
 */

import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { type ReadyDeps, phase1Handlers } from "../../src/lean/command.ts";
import type { WorkConfig } from "../../src/lean/config.ts";
import type { HandlerCtx, LeanHandlers } from "../../src/lean/engine.ts";
import { runLean } from "../../src/lean/engine.ts";
import { setLeanCommentPoster } from "../../src/lean/io.ts";
import type { LeanRun, LeanState, Outcome } from "../../src/lean/state.ts";
import { leanStateFile, loadRun } from "../../src/lean/state.ts";
import type { PiSpec } from "../../src/lean/spec.ts";
import type { DispatchResult } from "../../src/types.ts";
import { withEnv } from "./env-scope.ts";
import { gitTestEnv } from "./git-test-env.ts";
import { worktreeCommit } from "./lean-spec-intake-fixtures.ts";

/** The prose ticket: no `pi-spec v1` block anywhere, so `ready` must derive. */
export const PROSE = "The engine must carry its derived contract to the steps after ready.";

/** The contract the stubbed child drafts. Mutable, because `Step`'s outcome holds a
 * `PiSpec` and a `readonly` array is not assignable to one. */
export const DERIVED_SPEC: PiSpec = {
  problem: "a derived contract that never reaches the record is no contract at all",
  criteria: [
    { id: "AC1", text: "the record carries the derived contract", verify: "test" },
    { id: "AC2", text: "the next step reads it from the record", verify: "test" },
  ],
  size: "S",
};

/** The child's reply: that contract, fenced as the brief tells it to answer. */
const DERIVE_REPLY = [
  "Here is the contract.",
  "```pi-spec v1",
  JSON.stringify(DERIVED_SPEC, null, 2),
  "```",
].join("\n");

const CHILD_ROW: DispatchResult = {
  role: "explore",
  ok: true,
  text: DERIVE_REPLY,
  toolUses: [],
  ms: 1,
  exitCode: 0,
  usage: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0, cost: 0, turns: 1 },
};

// `verify.test` is the least `ready`'s setup check admits.
const EMPTY_CONFIG: WorkConfig = {
  version: 1,
  autoMerge: false,
  verify: { test: "pytest {file}" },
  budgets: {},
};

/** The state `ready + ok` routes to, and the one handler this rig lets run on. */
const AFTER_READY: LeanState = "specify";

/** The issue every case drives. */
export const ISSUE = 742;

/** A temp git repo whose base commit carries a readable `.pi/work.json`. */
function tempRepo(tag: string): { dir: string; base: string; cleanup: () => void } {
  const dir = mkdtempSync(path.join(tmpdir(), `lean-intake-record-${tag}-`));
  const git = (args: string[]): void => {
    const r = spawnSync("git", ["-C", dir, ...args], {
      encoding: "utf8",
      env: { ...gitTestEnv(), GIT_AUTHOR_NAME: "t", GIT_AUTHOR_EMAIL: "t@t" },
    });
    if (r.status !== 0) throw new Error(`git ${args.join(" ")}: ${r.stderr ?? ""}`);
  };
  git(["init", "-q", "-b", "main"]);
  git(["config", "user.email", "t@t"]);
  git(["config", "user.name", "t"]);
  const base = worktreeCommit(dir, { ".pi/work.json": JSON.stringify({ version: 1 }) });
  return { dir, base, cleanup: () => rmSync(dir, { recursive: true, force: true }) };
}

/**
 * Drive a derive-mode run through the real engine to the first post-`ready` state.
 *
 * The `ready` handler is production's, with its five outside calls stubbed; every state
 * after `ready` is stubbed too, and the stub for `afterReady` RECORDS the `run` it is
 * handed so a case can see what the engine passed to the next step — which is the same
 * object the next step's own `specFor(body, ctx.run)` reads.
 */
export async function driveDerivedRun(opts: {
  tag: string;
  afterReady?: LeanState;
  /** The stubbed verdict of the step after `ready`.
   *
   * `blocked` is deliberately NOT available to an arm that asserts on the saved
   * record: the machine routes it with no transition out of `specify`, so the run ends
   * `handed-back` and the engine writes nothing — which reads as "the record is missing"
   * for a reason that has nothing to do with the field under test. Omit it (the default
   * below) and the run parks at a real terminal state with its record saved. */
  outcome?: Outcome;
  /** `require` is the default mode and the arm a `derive` case must state against:
   * without it, a green `derivedSpec` could be the fixture's own mode leak. */
  intake?: "derive" | "require";
}): Promise<{
  dir: string;
  base: string;
  run?: Awaited<ReturnType<typeof runLean>>;
  ctxRun?: LeanRun;
  /** Remove the temp repo. The record the case asserts on lives INSIDE it, so the rig
   * cannot clean up on the way out — a fixture that rm -rf'd its own repo handed the case
   * a missing file and an absent `derivedSpec` for the same reason. */
  cleanup: () => void;
}> {
  const { dir, base, cleanup } = tempRepo(opts.tag);
  const after = opts.afterReady ?? AFTER_READY;
  const undo = setLeanCommentPoster(async () => {});
  let ctxRun: LeanRun | undefined;
  try {
    const deps: Partial<ReadyDeps> = {
      fetchBody: async () => PROSE,
      issueTitle: async () => "prose ticket",
      loadConfig: async () => EMPTY_CONFIG,
      dispatch: async () => CHILD_ROW,
      post: async () => {},
    };
    const handlers: LeanHandlers = { ...phase1Handlers(dir, ISSUE, {}, deps) };
    handlers[after] = async (ctx: HandlerCtx) => {
      ctxRun = ctx.run;
      return opts.outcome ?? { kind: "no-red-test", failedRules: ["the build is not part of this case"] };
    };
    let driven: Awaited<ReturnType<typeof runLean>> | undefined;
    await withEnv(
      {
        PI_ENSEMBLE_FORGE: "none",
        PI_ENSEMBLE_LEAN_SPEC_INTAKE: opts.intake ?? "derive",
      },
      async () => {
        driven = await runLean({
          repoRoot: dir,
          issue: ISSUE,
          handlers,
          seed: { version: "test", baseSha: base },
          now: () => 1_700_000_000_000,
        });
      },
    );
    return { dir, base, run: driven, ctxRun, cleanup };
  } catch (err) {
    cleanup();
    throw err;
  } finally {
    undo();
  }
}

/** The durable record, read back off disk through the only reader a resume has. */
export function recordOf(dir: string, issue: number = ISSUE): LeanRun | undefined {
  return loadRun(dir, issue);
}

/** The record's own bytes, for a claim that has to survive the validator rather than
 * merely survive the drive: `loadRun` rebuilds field by field, so a reader that wants
 * to say "the file on disk carries it" asks for this. */
export function rawRecordOf(dir: string, issue: number = ISSUE): string {
  try {
    return readFileSync(leanStateFile(dir, issue), "utf8");
  } catch {
    return "";
  }
}
