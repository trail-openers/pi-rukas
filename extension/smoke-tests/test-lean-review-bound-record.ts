#!/usr/bin/env bun
/**
 * #2066 — what a bound stop RECORDS, where it ROUTES, and where it becomes visible
 * (AC2, AC3, AC5, R1, R2, R3, R5, R7). The step bound itself and its non-vacuity
 * pair live in `test-lean-review-step-bound.ts`; the rigs are shared from
 * `lib/lean-review-bound-fixtures.ts`.
 *
 * One lever, three readings — the three the issue's open points fought over: a stop
 * in pass 1 has judged nothing, so it hands back unconditionally (R1); a stop after
 * the fixer PUSHED can neither hand back over a moved head nor be `done`, so it
 * routes `fixed` (R2); and a stop under the caps master switch stops nothing and must
 * say so rather than report a bound that held (R5). AC2's second lever — the deadline
 * reserve the engine's between-steps check cannot protect while a step runs — is (c).
 *
 * One record shape is shared by all of them (R3): an ungated `traceWarn`, a
 * `reviewBound` field the state loader validates, and a projection into the headless
 * result. The PR comment is the only forge surface, because `publish` precedes
 * `review` (R7). One assertion per reading, and each is a conjunction over the
 * surfaces that reading touches — a surface that stopped being written is a red
 * case, not a sub-assertion. Real temp repos, stubbed models, no child spawned.
 */

import { defaultConfig } from "../src/lean/config.ts";
import { runLean } from "../src/lean/engine.ts";
import { handoffAllowanceMs } from "../src/lean/deadline.ts";
import { REVIEW_DEADLINE_RESERVE_MS } from "../src/lean/review-bound.ts";
import { ReviewInfraError } from "../src/lean/review.ts";
import { leanIssueResult } from "../src/headless/work-lean-result.ts";
import { makeAssert } from "./lib/lean-engine-fixtures.ts";
import {
  BRANCH,
  cleanupRoots,
  fixerThatCommits,
  makeRepo,
  runStep,
  setup,
} from "./lib/lean-review-fixtures.ts";
import {
  MIN,
  boundHandlers,
  captureWarns,
  cfg,
  ctxWithPr,
  slowDeps,
  waveDeps,
} from "./lib/lean-review-bound-fixtures.ts";
import type { Posts } from "./lib/lean-review-bound-fixtures.ts";

const { assert, failures } = makeAssert();
const SHIPPED = defaultConfig().budgets.review?.minutes ?? 30;
// The surfaces one stop must reach — the durable record, the ungated log, the host's
// document (R3, AC5) and the count-bounded PR disclosure (R7). Each is ONE conjunction:
// a surface that stopped being written is a red case, not a sub-assertion read as colour.
const onRecord = (r: { kind?: string; reviewBound?: unknown } | undefined): boolean =>
  r?.kind === "error" && typeof r.reviewBound === "object";
const onLog = (w: string[]): boolean => w.length > 0 && w.every((x) => /STEP stopped/.test(x));
const onDocument = (p: Record<string, unknown>): boolean =>
  typeof p.reviewBound === "string" && /STEP stopped/.test(p.reviewBound) && /wave/.test(p.reviewBound);
const disclosed = (posts: Posts): boolean =>
  posts.length === 1 &&
  posts[0]?.pr === 42 &&
  /adversarial re-review/.test(posts[0]?.body ?? "") &&
  (posts[0]?.body.match(/^-/gm) ?? []).length <= 8;
// A review past its budget while the RUN's clock stands still: the field shape that
// starved publish, ci and land, and the between-steps exemption the bound closes.
const runNow = () => 60 * MIN;
const pastItsBudget = () => runNow() + 61 * MIN;

// ── (c) AC2: the deadline reserve stops the step with its minutes UNSPENT, before
// it buys anyone — the time publish, ci and land still need.
{
  const { repoRoot, baseSha } = makeRepo();
  await setup({ repoRoot, baseSha, branch: BRANCH, feature: "export const f = 2;\n" });
  const now = 1_700_000_000_000;
  const bought = slowDeps();
  const { threw } = await runStep(
    ctxWithPr(repoRoot, baseSha, BRANCH, {
      startedAt: now - 2 * MIN,
      now: () => now,
      deadlineMs: now + handoffAllowanceMs() + REVIEW_DEADLINE_RESERVE_MS - MIN,
    }),
    { ...bought, loadConfig: async () => cfg(0) },
  );
  assert(
    threw instanceof ReviewInfraError &&
      /cycle deadline left/.test(String(threw.message)) &&
      /reserve/.test(String(threw.message)) &&
      !/minutes budget/.test(String(threw.message)) &&
      bought.gates + bought.lenses === 0,
    `(c) the step stops inside the reserve with its budget unspent — the cause names the DEADLINE and the reserve it stopped for, and NO child was bought (${String(bought.gates)} gate, ${String(bought.lenses)} lens; ${threw?.message ?? "no throw"})`,
  );
}

// ── (d) AC3/R2/R7: a stop after the fixer pushed routes `fixed`, records the wave
// and the unjudged re-review, and posts the disclosure on the publish-recorded PR.
{
  const { repoRoot, baseSha } = makeRepo();
  await setup({ repoRoot, baseSha, branch: BRANCH, feature: "export const f = 3;\n" });
  const posts: Posts = [];
  // The clock crosses the ceiling only after the fixer's integrate has pushed.
  const times = [0, 0, 0, 0, 24 * MIN, 24 * MIN];
  let tick = 0;
  const { outcome, threw } = await runStep(
    ctxWithPr(repoRoot, baseSha, BRANCH, {
      startedAt: 0,
      now: () => times[Math.min(tick++, times.length - 1)] ?? 0,
      prUrl: "https://github.com/o/r/pull/42",
    }),
    waveDeps(fixerThatCommits("bound-fix"), 20, posts),
  );
  const rec = outcome?.reviewBound;
  assert(
    threw === undefined &&
      outcome?.kind === "fixed" &&
      rec?.wave === "fix" &&
      rec.unreviewedLanes.includes("adversarial re-review") &&
      disclosed(posts),
    `(d) a stop after the pushed fix routes \`fixed\` — not \`done\` over a head the gate never re-read — records the wave and the unjudged re-review, and posts ONE count-bounded comment on the PR \`publish\` recorded (${threw?.message ?? `kind ${String(outcome?.kind)}, ${JSON.stringify(rec)}, PRs ${JSON.stringify(posts.map((p) => p.pr))}`})`,
  );
}

// ── (e) R1/R3 + AC5: one pass-1 stop, read off all three surfaces of the record.
{
  const { repoRoot, baseSha } = makeRepo();
  await setup({ repoRoot, baseSha, branch: BRANCH, feature: "export const f = 4;\n" });
  let stepRecord: { kind?: string; reviewBound?: unknown } | undefined;
  const warns: string[] = [];
  const projected: Record<string, unknown> = {};
  await captureWarns("STEP stopped", warns, async () => {
    const run = await runLean({
      repoRoot,
      issue: 7,
      handlers: boundHandlers(pastItsBudget, SHIPPED),
      now: runNow,
      seed: { baseSha, branch: BRANCH },
    });
    stepRecord = run.run.steps.find((s) => s.state === "review")?.outcome;
    Object.assign(projected, leanIssueResult(run.run, run.code) as unknown as Record<string, unknown>);
  });
  assert(
    onRecord(stepRecord) && onLog(warns) && onDocument(projected),
    `(e) a pass-1 stop hands back on the engine's error path, records its bound THERE (the only place a stop with no verdict can be read), logs it UNGATED, and the host's document projects the bounded line (${String(stepRecord?.kind)}, ${JSON.stringify(stepRecord?.reviewBound)}, ${warns.length} warn line(s), ${JSON.stringify(projected.reviewBound)})`,
  );
}

// ── (e2) R5: the caps master switch off, on a clock past BOTH levers — a bound the
// runtime disabled must never be reported as one that held.
{
  const { repoRoot, baseSha } = makeRepo();
  await setup({ repoRoot, baseSha, branch: BRANCH, feature: "export const f = 5;\n" });
  const capsOff = slowDeps();
  let outcome: { kind?: string } | undefined;
  let threw: Error | undefined;
  const inert: string[] = [];
  await captureWarns("inert", inert, async () => {
    process.env.PI_ENSEMBLE_DISPATCH_CAPS = "0";
    try {
      const r = await runStep(
        ctxWithPr(repoRoot, baseSha, BRANCH, { startedAt: 0, now: () => 10 * MIN, deadlineMs: 11 * MIN }),
        { ...capsOff, loadConfig: async () => cfg(SHIPPED) },
      );
      outcome = r.outcome;
      threw = r.threw;
    } finally {
      delete process.env.PI_ENSEMBLE_DISPATCH_CAPS;
    }
  });
  assert(
    threw === undefined &&
      outcome?.kind === "done" &&
      capsOff.gates === 1 &&
      inert.some((w) => /inert/.test(w)),
    `(e2) with PI_ENSEMBLE_DISPATCH_CAPS=0 the step bound stops NOTHING past its minutes and inside the reserve, and the run carries the same inert disclosure the child lever prints (${threw?.message ?? `kind ${String(outcome?.kind)}, ${String(capsOff.gates)} gate, ${JSON.stringify(inert)}`})`,
  );
}

cleanupRoots();
process.exit(failures());
