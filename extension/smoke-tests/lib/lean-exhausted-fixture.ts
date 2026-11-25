import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import type { HandlerCtx } from "../../src/lean/engine.ts";
import { runLean } from "../../src/lean/engine.ts";
import { MAX_BUILD_ATTEMPTS } from "../../src/lean/machine.ts";
import type { LeanRun, Outcome, Step } from "../../src/lean/state.ts";
import { createRun } from "../../src/lean/state.ts";
import { landedRoster } from "./lean-roster-fixture.ts";

/**
 * The real drives behind the `build + exhausted` cases, and nothing else.
 *
 * Each is a `runLean` run with scripted verdicts, returned as the log the engine actually saved — engine's
 * own keys, engine's own order — so a case asserts over a record a drive really wrote rather than a
 * hand-written shape vouching for itself. The only fact a case supplies is the gate's verdict, which is the
 * single thing the table reads when it decides what an exhausted round is worth.
 */

/** The issue every case drives, so a key or a record names one value. */
export const ISSUE = 2617;

/** The head an unverified publish names; no real repo ever held it. */
export const PUBLISHED = "d".repeat(39).concat("7");

/** The head a covered run's green certifies — the one its own publish pushes. */
export const CERTIFIED = "e".repeat(39).concat("1");

/** The verdict every walk ends on: the builder came back with an empty change set. */
export const EXHAUSTED: Outcome = { kind: "exhausted", reason: "the developer produced no change" };

/** The run's branch; the handback comment prints it verbatim. */
export const BRANCH = "lean/issue-2617";

/** Every scratch dir the drives made; `cleanupExhausted()` removes them. */
const DIRS: string[] = [];

/** Remove every drive directory. The test calls it at its end. */
export function cleanupExhausted(): void {
  for (const dir of DIRS.splice(0)) rmSync(dir, { recursive: true, force: true });
}

/** The run every case asks about: one issue, one branch, one base. */
export function seedRun(): LeanRun {
  return createRun({
    issue: ISSUE,
    version: "test",
    models: {},
    baseSha: CERTIFIED,
    branch: BRANCH,
  });
}

/** The frozen contract every walk froze, so the handback comment has a contract to list. */
export const FROZEN: Outcome = {
  kind: "ok",
  frozen: { "tests/AC1-unverified.test.sh": "a".repeat(64) },
  tests: { AC1: ["tests/AC1-unverified.test.sh"] },
};

/** The green a covered run's gate returns, naming `head` and carrying the roster the land gate reads. */
export function greenCertified(
  head = CERTIFIED,
  reason = `all frozen tests green at ${head}`,
): Outcome {
  return {
    kind: "green",
    verifiedHead: head,
    reason,
    projectRoster: landedRoster(head),
  };
}

/** The red a decided-but-never-green run's gate returns: it spoke, and did not clear the head. */
export function redVerify(): Outcome {
  return { kind: "red", reason: "AC1 exited 1 on the run's last build round" };
}

/** A publish step that pushed `head`; `draft: true` because the forge reported it that way. */
export function publishStep(head: string, n = 0): Step {
  return {
    key: `${String(ISSUE)}:publish:${String(n)}`,
    state: "publish",
    startedAt: 20,
    endedAt: 21,
    outcome: {
      kind: "ok",
      prUrl: "https://github.com/o/r/pull/9",
      publishedHead: head,
      draft: true,
      reason: `published draft PR https://github.com/o/r/pull/9 at ${head.slice(0, 12)}`,
    },
  };
}

/** The handback context over a log, on a repo path no case touches. */
export function ctxFor(steps: Step[], repoRoot = "/tmp/lean-exhausted-repo"): HandlerCtx {
  const run = { ...seedRun(), steps };
  return {
    repoRoot,
    issue: ISSUE,
    run,
    steps: run.steps,
    stepKey: `${String(ISSUE)}:handback:0`,
    now: () => 5,
  };
}

/**
 * Drive a run whose builder comes back empty, and return the log as the engine left it.
 *
 * `gate` is the case's whole input: the verdicts the run's gate gives, LAST one first, one per round the
 * build cap buys. A drive that ended before recording an exhausted build throws, rather than letting a case
 * assert on a walk it never got.
 */
export async function driveExhausted(gate: Outcome[]): Promise<Step[]> {
  const dir = mkdtempSync(path.join(tmpdir(), "lean-exhausted-"));
  DIRS.push(dir);
  const rounds = MAX_BUILD_ATTEMPTS;
  const plan: Record<string, Outcome[]> = {
    ready: [{ kind: "ok" }],
    specify: [FROZEN],
    build: [...Array.from({ length: rounds - 1 }, () => ({ kind: "ok" } as Outcome)), EXHAUSTED],
    challenge: [{ kind: "none" }],
    verify: [
      ...Array.from({ length: rounds - 1 }, () => redVerify()),
      ...(gate.length === 0 ? [redVerify()] : gate),
    ],
  };
  const queues: Record<string, Outcome[]> = {};
  for (const [state, queue] of Object.entries(plan)) queues[state] = [...queue];
  const handlers: Record<string, (ctx: HandlerCtx) => Promise<Outcome>> = {};
  for (const state of Object.keys(queues)) {
    handlers[state] = async () => {
      const next = queues[state]?.shift();
      if (next === undefined) throw new Error(`no scripted outcome for ${state}`);
      return next;
    };
  }
  const r = await runLean({
    repoRoot: dir,
    issue: ISSUE,
    handlers: handlers as never,
    maxSteps: MAX_BUILD_ATTEMPTS * 4,
    seed: { version: "test", baseSha: CERTIFIED, branch: BRANCH },
  });
  const decided = r.run.steps.filter(
    (s) => s.outcome !== undefined && s.outcome.kind !== "error" && s.state !== "handback",
  );
  if (!decided.some((s) => s.state === "build" && s.outcome?.kind === "exhausted"))
    throw new Error(
      `the drive recorded no exhausted build (${r.run.steps.map((s) => `${s.key}=${String(s.outcome?.kind ?? "?")}`).join(" ")}): ended ${r.state} (${r.run.result?.reason ?? "no result"})`,
    );
  return decided;
}

/** The never-verified walk: its gate decided nothing green, and the builder came back empty. */
export async function walkNoVerify(): Promise<Step[]> {
  return driveExhausted([]);
}
