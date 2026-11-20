#!/usr/bin/env bun
/**
 * lib/lean-review-fix-reask-fixtures — the stubs the fixer-truncation suites share.
 *
 * Split out of `test-lean-review-fixer-truncation-switch.ts` because both wave-level suites
 * (the on-arm behaviour and the off-arm byte-identity) need the SAME truncated fixer, the same gate
 * that blocks once, and the same resumed child whose `spawn` is fake — and a second copy of the
 * stub is a second place a field can drift while both suites stay green. That drift is precisely
 * what the off-arm suite exists to catch, so the two must not hold two versions of the arm.
 *
 * Nothing here decides an expectation: every builder returns a value the CALLING case asserts on.
 */

import type { ChildProcessWithoutNullStreams } from "node:child_process";
import { PassThrough } from "node:stream";
import {
  type ContinuationOutcome,
  type DeveloperContinuationFn,
  spawnDeveloperContinuationChild,
} from "../../src/developer-session-continuation.ts";
import { sha256 } from "../../src/lean/specify-proof.ts";
import type { HandlerCtx } from "../../src/lean/engine.ts";
import type { DispatchResult } from "../../src/types.ts";
import { put } from "./lean-build-fixture.ts";
import {
  BRANCH,
  type ReviewDeps,
  ctxFor,
  depsWith,
  frozenBlob,
  git,
  lensRoundFor,
  rejectsThenClears,
  result,
} from "./lean-review-fixtures.ts";

/** A child that reported nothing, so no case's default usage can trip the step's own ceilings. */
export const ZERO_USAGE = {
  input: 0,
  output: 0,
  cacheRead: 0,
  cacheWrite: 0,
  cost: 0,
  turns: 0,
  toolCalls: 0,
  toolErrors: 0,
} as const;

/** The field run's own numbers: a truncated turn that spent the whole output cap. */
export const TRUNCATED = {
  role: "developer",
  ok: true,
  exitCode: 0,
  ms: 90_000,
  stopReason: "length",
  usage: { input: 4_000, output: 16_384, cacheRead: 0, cacheWrite: 0, cost: 0.5, turns: 7 },
  transcriptPath: "/tmp/pi-rukas-test/fixer-session.json",
} as const;

/**
 * The fixer stub: a truncated child unless `over` says otherwise.
 *
 * `over` wins FIELD BY FIELD, not by spread order: a case that passes `{ stopReason: "stop" }` must
 * get `"stop"`, and `{ ...TRUNCATED, ...over }` would put the field back. The default IS the defect
 * under test, so an arm that silently kept it would assert the truncation branch on a child that was
 * never an exception — which is how the never-re-asked arms stayed green on six cases that should
 * never have been continued.
 */
export function fixerResult(over: Partial<DispatchResult> = {}): DispatchResult {
  const base: Record<string, unknown> = {
    ...TRUNCATED,
    // A child reports its own tool calls; a case that means "it wrote nothing" leaves this empty and
    // a case that means "it wrote" passes `toolUses`.
    toolUses: [],
  };
  for (const [key, value] of Object.entries(over)) {
    if (value === undefined) delete base[key];
    else base[key] = value;
  }
  return result(base as Partial<DispatchResult>);
}

/** A run context whose `specify` froze this repo's acceptance test, so `integrate`'s frozen proof
 *  passes for a fix that did not touch it. */
export function frozenCtx(repoRoot: string, baseSha: string): HandlerCtx {
  const ctx = ctxFor(repoRoot, baseSha, BRANCH);
  ctx.run.steps.push({
    key: "7:specify:0",
    state: "specify",
    startedAt: 1,
    endedAt: 2,
    outcome: {
      kind: "ok",
      frozen: { "tests/AC1.test.ts": sha256(frozenBlob(repoRoot, "HEAD")) },
      tests: { AC1: ["tests/AC1.test.ts"] },
    },
  });
  return ctx;
}

/** One case's record of what the continuation seam was handed, and what it answered. */
export type ContinuationCall = Parameters<DeveloperContinuationFn>[0];

/**
 * The deps for one case: a gate that blocks once, a fixer stub recording nothing to the tree, and a
 * `continueSession` that captures its arguments and answers as `answer` says.
 *
 * The gate blocks ONCE because the step dispatches exactly one fix wave and then RE-GATES, and a
 * re-gate that blocks again is the `blocking finding not addressed` handback rather than the outcome
 * the wave is about — the shape `rejectsThenClears` gives the other review suites. A case that wants
 * the wave itself to fail gets that from the fixer and the continuation, not from a gate that never
 * stopped blocking.
 *
 * `lens` stamps the range the step named on the re-review, which is what lets a wave that fixed
 * anything reach the re-review rather than being refused for an un-stamped round.
 */
export function waveDeps(opts: {
  fixer: Partial<DispatchResult>;
  answer: ContinuationOutcome | undefined;
  /** The lens arm's re-review verdict; default clears, so a landed fix reaches the pass. */
  reReview?: (args: { wave: string; since?: string; head: string }) => ReturnType<
    ReviewDeps["lens"]
  >;
  onCalls: ContinuationCall[];
}): ReviewDeps {
  const gate = rejectsThenClears("1. the finding the fixer must answer", 1);
  return depsWith({
    adversarial: gate,
    lens: async (a) =>
      a.wave === "fix"
        ? await (opts.reReview ?? ((x) => lensRoundFor(x, "APPROVED", [])))(a)
        : lensRoundFor(a, "APPROVED", []),
    dispatch: async () => fixerResult(opts.fixer),
    continueSession: async (args) => {
      // The seam delegates to the PRODUCTION continuation child, whose own spawn is injected, so the
      // row this wave bills is one `continuationRow` built from a real child's reported numbers rather
      // than one the case typed by hand.
      opts.onCalls.push(args);
      const answer = opts.answer ?? ({ ok: false, reason: "no-answer" } as ContinuationOutcome);
      await answer.fn?.(args);
      return await spawnContinuation(args, answer);
    },
  });
}

/** The subjects a branch gained over `base`. */
export const subjects = (repoRoot: string, base: string, ref: string): string[] =>
  git(repoRoot, "log", "--format=%s", `${base}..${ref}`)
    .split("\n")
    .filter((s) => s !== "");

/**
 * The continuation child, with its SPAWN injected.
 *
 * The seam delegates here rather than returning the case's hand-written outcome, so the cost row the
 * wave bills is one the PRODUCTION `continuationRow` built from what a child reported — a case that
 * returned `{ ok: true, text: "fixed" }` itself would assert the wave bills a row and never prove the
 * row is the child's own. Only `spawn` is fake: it answers a canned rpc stream, exactly as a real
 * resumed child would.
 */
export async function spawnContinuation(
  args: ContinuationCall,
  answer: ContinuationOutcome,
): Promise<ContinuationOutcome> {
  const reply = {
    type: "agent_end",
    messages: [
      {
        role: "assistant",
        ...(answer.stopReason === undefined ? {} : { stopReason: answer.stopReason }),
        content: [{ type: "text", text: answer.text ?? "" }],
        usage: { input: 900, output: 4_096, cacheRead: 0, cacheWrite: 0, cost: 0.25 },
      },
    ],
  };
  const fake = () => {
    const stdout = new PassThrough();
    (stdout as unknown as { write: (s: string) => void }).write(`${JSON.stringify(reply)}\n`);
    return {
      stdout,
      stderr: new PassThrough(),
      stdin: new PassThrough(),
      kill: () => true,
      on: (event: string, cb: (arg: never) => void) => {
        if (event === "exit") queueMicrotask(() => cb(0 as never));
        return fakeChild;
      },
    } as unknown as ChildProcessWithoutNullStreams;
  };
  const fakeChild = fake();
  return await spawnDeveloperContinuationChild(args, { spawn: () => fake as never });
}

/** A continuation that does its job: edits the tree it was GIVEN (not the one the case assumed) and
 * commits it, so the fold has real bytes to integrate. Returned as an ANSWER carrying the side effect,
 * because `waveDeps` is the one place that holds the seam's arguments — an answer built anywhere else
 * would write into a tree the case only guessed at.
 */
export const committingContinuation = (tag: string): ContinuationOutcome => ({
  ok: true,
  text: "fixed",
  fn: async (args) => {
    put(args.cwd, `continued-${tag}.ts`, "export const continued = true;\n");
    git(args.cwd, "add", "-A");
    git(args.cwd, "commit", "-q", "-m", `fix: the finding, after the cut (${tag})`);
    return { ok: true, text: "fixed" };
  },
});
