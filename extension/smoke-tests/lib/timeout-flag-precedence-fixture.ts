#!/usr/bin/env bun
/**
 * lib/timeout-flag-precedence-fixture — the rig for the two halves of the #2362 gate:
 * `test-work-driver-timeout-flag-precedence-switch.ts` (the switch's truth table, the
 * arms it resolves, the warning it costs, and the host contract) and
 * `test-work-driver-timeout-flag-precedence-off-arm.ts` (the off arm pinned against a
 * golden captured at the base commit).
 *
 * Both halves need the same things and must not each keep a private copy: a way to
 * scope the switch and the two env arms without leaking them into the next case, a way
 * to capture "this run's stderr, and only the line this rule owns", and a single
 * structural reader of that line. The structural reader is the load-bearing piece — a
 * `warns[0].includes("PI_ENSEMBLE_CYCLE_BUDGET_MS")` cannot tell a correct line from one
 * that names the wrong winner, because the line's tail names the budget whatever the
 * loser was.
 */

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { MINUTE_MS } from "../../src/lean/deadline.ts";
import { type RunLeanOpts, runLean } from "../../src/lean/engine.ts";
import {
  type CycleBudgetMs,
  flagBudgetMs,
  resolveCycleDeadline,
} from "../../src/work-driver-deadline.ts";
import { makeAssert } from "./lean-engine-fixtures.ts";
import { captureWarns } from "./lean-review-bound-fixtures.ts";
import { WALK, recording, withEnv } from "./lean-host-contract-fixture.ts";

export { makeAssert, withEnv };

/** The switch this rule pins, and the two env arms it re-orders. */
export const SWITCH = "PI_ENSEMBLE_TIMEOUT_FLAG_PRECEDENCE";
export const BUDGET = "PI_ENSEMBLE_CYCLE_BUDGET_MS";
export const ABSOLUTE = "PI_ENSEMBLE_CYCLE_DEADLINE";
/** How the warning spells the flag — the same spelling the operator typed. */
export const FLAG_NAME = "--timeout";
/** The needle that selects this rule's line out of a run's stderr. */
export const WARN_NEEDLE = "--timeout";

/** An injected clock, so every resolved epoch in either half is a number we chose. */
export const T0 = 1_800_000_000_000;
/** `--timeout 165`, as the engine receives it: a VALUE, never an env write. */
export const FLAG = flagBudgetMs(165 * MINUTE_MS) as CycleBudgetMs;
/** The exported budget the defect is about: 60 minutes. */
export const BUDGET_MS = 60 * MINUTE_MS;

/** Scratch trees for the drives of either half, all removed by `cleanScratch`. One root
 *  per process, so the two halves cannot collide while `bun test` runs them in parallel. */
const ROOT = mkdtempSync(path.join(tmpdir(), "pi-2362-"));
export function scratch(name: string): string {
  return mkdtempSync(path.join(ROOT, `${name}-`));
}
export function cleanScratch(): void {
  rmSync(ROOT, { recursive: true, force: true });
}

/** A drive's identity: the handler set and seed every case shares, so a case owns
 *  nothing but its scratch tree and its issue number. */
export const DRIVE = {
  handlers: (calls: string[]) => recording(calls, WALK),
  seed: { version: "0.0.0-test", baseSha: "" },
} as const;

/** The engine's answer for one drive under one env scope: the arm the RUN persisted and
 *  every stderr line this rule's needle caught. The arm compared is the one the run
 *  wrote, not the one a direct reader call returned — which is what makes the warning
 *  assertions tests of the PERSIST SITE rather than of the reader. */
export async function driveOnce(opts: {
  name: string;
  issue: number;
  env: Record<string, string | undefined>;
  budgetMs?: CycleBudgetMs;
}): Promise<{ arm: number | undefined; warns: string[]; optsSeen: RunLeanOpts }> {
  const calls: string[] = [];
  const warns: string[] = [];
  const engineOpts: RunLeanOpts = {
    repoRoot: scratch(opts.name),
    issue: opts.issue,
    handlers: DRIVE.handlers(calls),
    seed: DRIVE.seed,
    ...(opts.budgetMs === undefined ? {} : { budgetMs: opts.budgetMs }),
  };
  let arm: number | undefined;
  await withEnv(opts.env, async () => {
    await captureWarns(WARN_NEEDLE, warns, async () => {
      arm = (await runLean(engineOpts)).run.deadlineMs;
    });
  });
  return { arm, warns, optsSeen: engineOpts };
}

/** The warning line's shape, structurally: the flag's arm, the loser named after
 *  `against`, the winner named after the dash, and the deadline the line closes with.
 *  A line that names a different winner, or drops a value, has no match. */
export function shapeOf(line: string): RegExpExecArray | null {
  return new RegExp(
    `^\\[pi-rukas\\] WARN work-lean #\\d+: ${FLAG_NAME}=(\\d+) against (\\S+) \\S+ (\\S+) wins ` +
      `\\(the run's deadline is (\\d+)\\); `,
  ).exec(line);
}

/** A precedence line: the shape above, and a tail that offers the switch back. */
export function isPrecedenceWarning(line: string): boolean {
  return shapeOf(line) !== null && line.includes(`${SWITCH}=0`);
}

/** The pure reader's warning count for one input: a warning emitted INSIDE the reader
 *  is a second line for the same disagreement, which R2 forbids. */
export async function warnsOfReader(
  env: Record<string, string | undefined>,
  flag: CycleBudgetMs | undefined,
): Promise<number> {
  const warns: string[] = [];
  await withEnv({ [BUDGET]: undefined, [ABSOLUTE]: undefined, [SWITCH]: undefined }, async () => {
    await captureWarns(WARN_NEEDLE, warns, async () => {
      resolveCycleDeadline(env, undefined, T0, flag);
    });
  });
  return warns.length;
}

/** Capture EVERY physical stderr line a block writes, not just the ones a needle
 *  matches: the off-arm golden pins the whole stream, so a line this rule does not own
 *  still shows up as a difference against the capture. */
export async function captureAll<T>(fn: () => Promise<T>): Promise<{ result: T; lines: string[] }> {
  const lines: string[] = [];
  const write = process.stderr.write.bind(process.stderr);
  process.stderr.write = ((chunk: string | Uint8Array): boolean => {
    lines.push(typeof chunk === "string" ? chunk : new TextDecoder().decode(chunk));
    return write(chunk as string | Uint8Array);
  }) as typeof process.stderr.write;
  try {
    return { result: await fn(), lines };
  } finally {
    process.stderr.write = write;
  }
}
