/**
 * lib/lean-review-incomplete-head-golden — the OFF-arm golden of #2667, in one place.
 *
 * `test-lean-review-incomplete-head-off-arm.ts` compares the run at
 * `PI_ENSEMBLE_LEAN_REVIEW_INCOMPLETE_HEAD=0` against
 * `fixtures/lean-state/review-incomplete-head-2667.json`, captured ONCE from the
 * commit this feature branched from, by
 * `fixtures/lean-state/capture-review-incomplete-head-off.ts`, which calls THIS
 * same `driveReviewThrowArm`. Both sides must build the run the same way, so the
 * recipe lives here — and it resolves every `src/` import inside the tree that
 * captured it, which is why the capture is run from a worktree of the base commit
 * with this file and the capture script copied in.
 *
 * The run it captures is the defect's own shape, driven through the REAL engine:
 * `verify` goes green naming a real head, `publish` ships it, and `review` THROWS
 * (a child the operator's minutes ceiling stopped — the shape of
 * `test-lean-review-budget-stop.ts`). The engine's error path ended the run where
 * it stood, so `handback` never ran and no head field was written: that is the
 * baseline the on arm is allowed to differ from.
 *
 * What the byte-identity covers, and why each surface is here:
 *
 *   - **the step log** — every record of the run, key by key. The handback step's
 *     record is the one the feature grows head fields on; an off arm that grew one
 *     is a leak. A new key on ANY record fails the comparison.
 *   - **the handback comment body** — captured from the real reporting step's post
 *     seam. The feature adds a reason line and head lines; the off body must be the
 *     bytes the pre-feature build posted.
 *   - **the host document's `issues` entries** — the projection the host switches on.
 *
 * Values that cannot repeat across runs are masked, and only these: full and
 * 12-char shas (the fixture repo is built afresh, so every commit id is new) and
 * the version stamp `publish` prints. Keys are never masked, so a key that appeared
 * on the off arm fails rather than passing a looser check.
 */

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { execp } from "../../src/exec.ts";
import { defaultConfig } from "../../src/lean/config.ts";
import type { LeanHandlers } from "../../src/lean/engine.ts";
import { runLean } from "../../src/lean/engine.ts";
import { handbackOutcome } from "../../src/lean/handback.ts";
import type { ReviewDeps } from "../../src/lean/review.ts";
import { reviewOutcome } from "../../src/lean/review.ts";
import type { Outcome } from "../../src/lean/state.ts";
import { leanResultDocument } from "../../src/headless/work-lean-result.ts";
import type { Budget } from "../../src/lean/config.ts";
import {
  depsWith,
  git,
  makeRepo,
  result,
  setup,
  stepGitEnv,
} from "./lean-review-fixtures.ts";
import { landedRoster } from "./lean-roster-fixture.ts";

/** The issue every side drives; its number is in every step key. */
export const GOLDEN_ISSUE = 2667;
/** The committed path of the golden, relative to `smoke-tests/`. */
export const REVIEW_INCOMPLETE_HEAD_FIXTURE =
  "fixtures/lean-state/review-incomplete-head-2667.json";
/** The branch the run pushes — `specifyBranch` prints a non-empty branch verbatim. */
export const GOLDEN_BRANCH = "lean/issue-2667";
/** The frozen clock both sides run under, so no wall clock reaches the record. */
export const FIXED_NOW = 1700000000000;

/** Every full sha, its 12-char prefix and the version stamp, in every printed surface. */
export function mask(s: string): string {
  return s
    .replace(/\b[0-9a-f]{40}\b/g, "<sha>")
    .replace(/\b[0-9a-f]{12}\b/g, "<sha12>")
    .replace(/- pi-rukas [^\n]*/, "- pi-rukas <version>");
}

/** The record the three compared surfaces produce, for one run of the recipe. */
export interface ReviewIncompleteHeadGolden {
  /** Each step's masked record, in log order, key included. */
  steps: { key: string; state: string; outcome?: unknown }[];
  /** The body the handback step handed its post seam, masked; null when none was posted. */
  handbackBody: string | null;
  /** The host document's `issues` entries, masked. */
  issues: unknown;
  /** The run's terminal stamp. */
  state: string;
  code: number;
  /** The engine's own reason line for the terminal stamp. */
  reason: string;
}

/** `budgets.review` with only the minutes lever the case wants. */
function cfgWith(budget: Partial<Budget>) {
  const cfg = defaultConfig();
  cfg.budgets.review = { turns: 0, tokens: 0, minutes: 0, ...budget };
  return cfg;
}

/** The review deps of a child the operator's minutes ceiling stopped. */
export function minutesStopDeps(minutes = 15): ReviewDeps {
  return depsWith({
    loadConfig: async () => cfgWith({ minutes }),
    adversarial: async () =>
      result({ loopOutcome: "approved", killCause: "child-bound", ms: (minutes + 1) * 60_000 }),
  });
}

/** The review deps of a pass where neither gate blocked — the control arm. */
export function cleanReviewDeps(): ReviewDeps {
  return depsWith({
    loadConfig: async () => cfgWith({ turns: 400, tokens: 60_000_000, minutes: 30 }),
    adversarial: async () => result({ loopOutcome: "approved" }),
  });
}

/** The green the gate records: the head the run's `verify` certified. */
let baseShaOf: (head: string) => string = () => "0".repeat(40);
function green(head: string): Outcome {
  return {
    kind: "green",
    verifiedHead: head,
    reason: `all frozen tests green at ${head}`,
    // The roster the land gate reads off the record, spelled by the one fixture that
    // spells it (`lib/lean-roster-fixture.ts`), at the run's own base.
    projectRoster: landedRoster(baseShaOf(head)),
  };
}

/**
 * The two arms the golden pins, and nothing else.
 *
 * `throw` is the defect's own shape: the gate certified a head, `publish` shipped it, and
 * the review threw. `done` is the control the issue demands — a review that COMPLETED, on
 * the same log — because a feature that leaked onto the completed arm would change the
 * bytes of every ordinary run, and the only evidence it did not is a second capture.
 */
export type GoldenArm = "throw" | "done";

/**
 * The step the golden's walk stops at.
 *
 * The `throw` arm stops where the throw ends it — the engine stamps `handed-back` on the
 * error path, so the run reaches its terminal state by itself. The `done` arm must NOT
 * follow the table to its merge: the control's subject is the log and the reporting step of
 * a run whose review completed, and a run that lands never runs the report at all. So the
 * `done` arm's `ci` and `land` refuse, which routes the walk to the reporting step — and
 * `handback` is the one step whose verdict must still be the step's own `done`.
 */
function stopsAtReview(arm: GoldenArm): boolean {
  return arm === "done";
}

/**
 * Drive the golden's run once through the REAL engine, with the REAL review step, and read
 * the three compared surfaces.
 *
 * Only the model children are stubbed (`ReviewDeps`): the engine, the step's own entry gate
 * and head reads, the error outcome and the reporting step all run. On the `throw` arm the
 * step's child is stopped at its minutes ceiling, which is the shape that made the step
 * throw; on the `done` arm both gates come back clean and the step returns `done`.
 */
export async function driveReviewThrowArm(
  arm: GoldenArm = "throw",
): Promise<{
  golden: ReviewIncompleteHeadGolden;
  heads: { verifiedHead: string };
}> {
  const { repoRoot, baseSha } = makeRepo();
  await setup({ repoRoot, baseSha, branch: GOLDEN_BRANCH, feature: "export const f = 2;\n" });
  const verifiedHead = git(repoRoot, "rev-parse", `origin/${GOLDEN_BRANCH}`);
  baseShaOf = () => baseSha;
  const bodies: string[] = [];
  const handlers: LeanHandlers = {
    ready: async () => ({ kind: "ok" }),
    specify: async () => ({
      kind: "ok",
      frozen: { "tests/AC1-review-head.test.sh": "a".repeat(64) },
      tests: { AC1: ["tests/AC1-review-head.test.sh"] },
    }),
    build: async () => ({ kind: "ok" }),
    challenge: async () => ({ kind: "none" }),
    verify: async () => green(verifiedHead),
    publish: async () => ({
      kind: "ok",
      prUrl: "https://forge.invalid/o/r/pull/1",
      publishedHead: verifiedHead,
      draft: true,
    }),
    // The review that COMPLETED is the control: same log, same reporting step, and every
    // byte of the pre-feature build. It walks past its `ci` refusal on purpose — the
    // handback is the surface under comparison, so the walk has to reach it. Neither
    // scripted verdict carries a reason line: a cause this file wrote would be the very
    // prose the golden is supposed to pin.
    review: async (ctx) =>
      reviewOutcome(ctx, arm === "throw" ? minutesStopDeps() : cleanReviewDeps()),
    ci: async () => (stopsAtReview(arm) ? { kind: "red" } : { kind: "green" }),
    land: async () => ({ kind: "merged" }),
    // The real reporting step, over the real repo, with the post captured. The
    // rewind seam is production's own default (no move), so the off arm records what
    // it records and the on arm's rewind is pinned by the panel suite instead.
    handback: (ctx) => handbackOutcome(ctx, async (_r, _i, body) => void bodies.push(body)),
    decline: async () => ({ kind: "done" }),
  };
  const r = await runLean({
    repoRoot,
    issue: GOLDEN_ISSUE,
    handlers,
    now: () => FIXED_NOW,
    seed: { baseSha, branch: GOLDEN_BRANCH },
  });
  const { doc } = leanResultDocument(r.run, r.code);
  const golden: ReviewIncompleteHeadGolden = {
    steps: r.run.steps.map((s) => ({
      key: s.key,
      state: s.state,
      ...(s.outcome === undefined ? {} : { outcome: JSON.parse(mask(JSON.stringify(s.outcome))) }),
    })),
    handbackBody: bodies[0] === undefined ? null : mask(bodies[0]),
    issues: JSON.parse(mask(JSON.stringify(doc.issues))),
    state: r.state,
    code: r.code,
    reason: mask(r.run.result?.reason ?? ""),
  };
  rmSync(repoRoot, { recursive: true, force: true });
  return { golden, heads: { verifiedHead } };
}

/** The executor a case drives the real rewind with: the real one on an isolated git view. */
export const execNet = ((cmd, opts) =>
  execp(cmd, { ...(opts ?? {}), env: stepGitEnv() })) as typeof execp;

/** A scratch directory for a case that needs a repo of its own. */
export function scratchDir(): string {
  return mkdtempSync(path.join(tmpdir(), "lean-review-head-"));
}
