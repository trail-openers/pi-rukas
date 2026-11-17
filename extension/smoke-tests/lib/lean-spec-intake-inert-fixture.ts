/**
 * lib/lean-spec-intake-inert-fixture — the rig for `test-lean-spec-intake-inert.ts`,
 * kept out of the case file so neither crosses AGENTS.md §12's 500-line gate. Sibling of
 * `lean-spec-intake-post-fixture.ts` (which counts what LEAVES the process for a PROSE
 * ticket) and `lean-spec-intake-record-fixture.ts` (which reads what STAYS on disk for
 * one); this one drives an AUTHORED ticket and reports both at once.
 *
 * Nothing here asserts. Both drives run the REAL `runLean` engine and the REAL `ready`
 * handler over a real git repo, and stub only `ready`'s five outside calls — its
 * `ReadyDeps` argument, never the handler itself, or the case judges its own stub — plus
 * every step after `ready`.
 *
 * `driveAuthoredRun` walks the whole table to `landed` (a drive that stopped at its first
 * stub ends `handed-back` with the record never saved, and an absence asserted on that
 * file would pass for the wrong reason), so its post seam is stubbed — `land` has
 * nothing to tell the author. `driveIntakeReadyDerived` stops at the first stub and
 * leaves `ready`'s `post` at production's `postDerivedSpec`: that call is what puts a
 * derived table in front of the author, so stubbing it there would make the inert case's
 * zero mean "the rig stubbed the poster".
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
import { type SpecFor, specFor } from "../../src/lean/spec-for.ts";
import type { PiSpec } from "../../src/lean/spec.ts";
import type { LeanRun, LeanState, Outcome } from "../../src/lean/state.ts";
import { leanStateFile, loadRun } from "../../src/lean/state.ts";
import type { DispatchResult } from "../../src/types.ts";
import { withEnv } from "./env-scope.ts";
import { gitTestEnv } from "./git-test-env.ts";
import { worktreeCommit } from "./lean-spec-intake-fixtures.ts";

/** The issue every arm drives. */
export const ISSUE = 743;

/** The contract the author wrote into the issue — a ready-made block carried in a fence,
 * so `parsePiSpec` really has something to parse. */
export const AUTHORED: PiSpec = {
  problem: "an authored contract must survive a derive-mode run untouched",
  criteria: [
    { id: "AC1", text: "no deriving child runs", verify: "test" },
    { id: "AC2", text: "the record holds no derived contract", verify: "test" },
  ],
  size: "S",
};

/** The issue body: prose around the block, so the block is one of the body's parts
 * rather than the whole ticket. */
export const AUTHORED_BODY = [
  "The run should quote what I wrote, not draft its own.",
  "```pi-spec v1",
  JSON.stringify(AUTHORED, null, 2),
  "```",
  "",
].join("\n");

/** The contract a child WOULD have drafted, if the mode were consulted at all. The prose
 * drive lets the child mint it for real, so nothing here imitates the shape `command.ts`
 * writes onto a derived `ready` verdict. */
export const DERIVED_SPEC: PiSpec = {
  problem: "a contract no author wrote",
  criteria: [
    { id: "AC1", text: "a machine drafted this criterion", verify: "test" },
    { id: "AC2", text: "and it is not the author's", verify: "test" },
  ],
  size: "S",
};

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

const EMPTY_CONFIG: WorkConfig = { version: 1, autoMerge: false, verify: {}, budgets: {} };

/** The prose ticket the reachability drive reads: no block anywhere, so the mode IS
 * consulted and the child, the poster and the record all have to answer for it. */
const PROSE_BODY = "The run should derive one for me, because nobody wrote a block.";

/** The eight states after `ready`, stubbed in both drives so nothing past the intake
 * runs — a real `specify`/`build`/`verify` would judge this fixture's tree, and a real
 * `land` would stamp a head off the temp repo's own commits. */
const AFTER_READY: readonly LeanState[] = [
  "specify",
  "build",
  "challenge",
  "verify",
  "publish",
  "review",
  "ci",
  "land",
];

/** One scripted verdict per stub, so the authored drive walks the WHOLE table to
 * `landed`. Each is the kind its state's `ok`-shaped arrow expects (`machine.ts`). */
const WALK: Partial<Record<LeanState, Outcome>> = {
  specify: { kind: "ok" },
  build: { kind: "ok" },
  challenge: { kind: "none" },
  verify: { kind: "green" },
  publish: { kind: "ok" },
  review: { kind: "done" },
  ci: { kind: "green" },
  land: { kind: "merged" },
};

/** The first state `ready + ok` routes to; its stub is the recording one. */
const AFTER_READY_FIRST: LeanState = AFTER_READY[0] as LeanState;

/** The run's own `ready` entry, and the derived contract its verdict carries — the two
 * places a leaked derivation can live, read off either the saved or the reloaded record. */
export const readyStepOf = (run: LeanRun | undefined): Step | undefined =>
  run?.steps.find((s) => s.state === "ready");
export const stepDerivedOf = (run: LeanRun | undefined) => readyStepOf(run)?.outcome?.derivedSpec;

type Step = LeanRun["steps"][number];

/** The whole step log, so a failing label names where a drive went wrong. */
function logOf(run: LeanRun | undefined): string {
  return (
    run?.steps.map((s) => `${s.state}:${s.outcome?.kind ?? "(undecided)"}`).join(",") ?? "(none)"
  );
}

/** The record's own bytes, for a claim that has to survive the validator rather than
 * merely survive the drive: `loadRun` rebuilds field by field, so "the file names it"
 * and "the reader returns it" are two different claims. */
function rawRecord(dir: string): string {
  try {
    return readFileSync(leanStateFile(dir, ISSUE), "utf8");
  } catch {
    return "";
  }
}

/** A temp git repo whose base commit carries a readable `.pi/work.json` — `ready` loads
 * the config AT the run's base, so a base that names no commit refuses the run for a
 * reason this case is not about. */
function tempRepo(tag: string): { dir: string; base: string; cleanup: () => void } {
  const dir = mkdtempSync(path.join(tmpdir(), `lean-intake-inert-${tag}-`));
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

/** What one drive reports: the four witnesses the case asserts on, plus the log and
 * state that make a failing label say where the drive went wrong. */
export interface DrivenRun {
  dir: string;
  base: string;
  /** How many children the intake paid for. */
  derives: number;
  /** Every comment the run asked the forge for, at the single post seam. */
  posted: string[];
  /** The derived acceptance table specifically — the comment `derive` mode mints. */
  derivedPosts: string[];
  readyOutcome?: string;
  /** `ready`'s verdict in full — an authored contract's is the bare `{kind:"ok"}`. */
  readyVerdict?: Outcome;
  /** The state the drive ended in, as the engine reported it. */
  state: string;
  log: string;
  /** What `specFor` returned on the body the ticket carries and the run the engine
   * handed the step after `ready` — the read the nine later steps perform. */
  read: SpecFor;
  ctxRun?: LeanRun;
  /** The record as the engine wrote it, and as the only reader a resume can have rebuilds it. */
  saved?: LeanRun;
  reloaded?: LeanRun;
  raw: string;
  cleanup: () => void;
}

/**
 * Drive one authored-contract ticket through the real engine to `landed`.
 *
 * `intake` pins the knob; `undefined` leaves it at its shipped `require` default, which
 * is the control arm. The handoff channel is pinned to `forge` so a comment this run owed
 * really reaches the recorder, which is what makes its absence (rather than a stubbed
 * sink) a witness.
 */
export async function driveAuthoredRun(opts: {
  tag: string;
  intake?: "derive" | "require";
}): Promise<DrivenRun> {
  const { dir, base, cleanup } = tempRepo(opts.tag);
  const posted: string[] = [];
  const undo = setLeanCommentPoster(async (_issue, body) => {
    posted.push(body);
  });
  let derives = 0;
  let ctxRun: LeanRun | undefined;
  let read: SpecFor = { ok: false, reason: "the step after ready never ran" };
  try {
    const deps: Partial<ReadyDeps> = {
      fetchBody: async () => AUTHORED_BODY,
      issueTitle: async () => "authored ticket",
      loadConfig: async () => EMPTY_CONFIG,
      dispatch: async () => {
        derives++;
        return CHILD_ROW;
      },
      post: async () => {},
    };
    const handlers: LeanHandlers = { ...phase1Handlers(dir, ISSUE, {}, deps) };
    // Every state past `ready` is stubbed BEFORE the recording one is installed, so
    // `land`'s stub is this rig's rather than production's (see `AFTER_READY`).
    for (const state of AFTER_READY) handlers[state] = async () => WALK[state] as Outcome;
    handlers[AFTER_READY_FIRST] = (ctx: HandlerCtx) => {
      ctxRun = ctx.run;
      read = specFor(AUTHORED_BODY, ctx.run);
      return Promise.resolve(WALK[AFTER_READY_FIRST] as Outcome);
    };
    let driven: Awaited<ReturnType<typeof runLean>> | undefined;
    await withEnv(
      {
        PI_ENSEMBLE_FORGE: "none",
        PI_ENSEMBLE_HANDOFF_CHANNEL: "forge",
        ...(opts.intake === undefined ? {} : { PI_ENSEMBLE_LEAN_SPEC_INTAKE: opts.intake }),
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
    return {
      dir,
      base,
      derives,
      posted,
      derivedPosts: posted.filter((body) => body.includes("derived by")),
      readyOutcome: readyStepOf(driven?.run)?.outcome?.kind,
      readyVerdict: readyStepOf(driven?.run)?.outcome,
      state: driven?.state ?? "(no drive)",
      log: logOf(driven?.run),
      read,
      ctxRun,
      saved: driven?.run,
      reloaded: loadRun(dir, ISSUE),
      raw: rawRecord(dir),
      cleanup,
    };
  } catch (err) {
    cleanup();
    throw err;
  } finally {
    undo();
  }
}

/**
 * Drive `ready` over a ticket whose body carries NO block, in the same wiring as
 * {@link driveAuthoredRun}. This is the arm that proves the case's counters can report a
 * one: the deriving child really is reachable, its table really reaches the post seam,
 * and its document really reaches the record.
 *
 * Every state past `ready` answers `blocked`, which is the cheapest way to end the run
 * after one step; it is not a claim about `specify`, and this drive asserts nothing about
 * the saved record.
 */
export async function driveIntakeReadyDerived(): Promise<{
  derives: number;
  derivedPosts: string[];
  state: string;
  log: string;
  record?: LeanRun;
}> {
  const { dir, base, cleanup } = tempRepo("derive-prose");
  const posted: string[] = [];
  const undo = setLeanCommentPoster(async (_issue, body) => {
    posted.push(body);
  });
  let derives = 0;
  try {
    const deps: Partial<ReadyDeps> = {
      fetchBody: async () => PROSE_BODY,
      issueTitle: async () => "prose ticket",
      loadConfig: async () => EMPTY_CONFIG,
      dispatch: async () => {
        derives++;
        return CHILD_ROW;
      },
    };
    const handlers: LeanHandlers = { ...phase1Handlers(dir, ISSUE, {}, deps) };
    for (const state of AFTER_READY)
      handlers[state] = async () => ({ kind: "blocked", reason: `${state} is out of scope here` });
    let driven: Awaited<ReturnType<typeof runLean>> | undefined;
    await withEnv(
      {
        PI_ENSEMBLE_FORGE: "none",
        PI_ENSEMBLE_HANDOFF_CHANNEL: "forge",
        PI_ENSEMBLE_LEAN_SPEC_INTAKE: "derive",
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
    return {
      derives,
      derivedPosts: posted.filter((body) => body.includes("derived by")),
      state: driven?.state ?? "(no drive)",
      log: logOf(driven?.run),
      record: driven?.run,
    };
  } finally {
    undo();
    cleanup();
  }
}
