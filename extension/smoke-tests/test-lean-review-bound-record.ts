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
import { HEAD_SHA } from "./lib/lens-fix-budget-share-fixture.ts";
import { handoffAllowanceMs } from "../src/lean/deadline.ts";
import {
  MAX_REASON_CHARS,
  REVIEW_DEADLINE_RESERVE_MS,
  reviewBoundRecord,
  unjudgedLenses,
} from "../src/lean/review-bound.ts";
import type { StepStop } from "../src/lean/review-bound.ts";
import type { LensRunResult } from "../src/lens-review-types.ts";
import { LENSES_PER_PASS } from "../src/lean/review-waves.ts";import { loadRun, saveRun } from "../src/lean/state-store.ts";
import { ReviewInfraError } from "../src/lean/review.ts";
import { leanIssueResult, leanResultDocument } from "../src/headless/work-lean-result.ts";
import { makeAssert } from "./lib/lean-engine-fixtures.ts";
import { tempDir } from "./lib/lean-engine-fixtures.ts";
import { createRun } from "../src/lean/state.ts";
import {
  BRANCH,
  cleanupRoots,
  fixerThatCommits,
  lensRowResult,
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
  reReviewRound,
  slowDeps,
  waveDeps,
} from "./lib/lean-review-bound-fixtures.ts";
import type { Posts } from "./lib/lean-review-bound-fixtures.ts";

const { assert, failures } = makeAssert();
/** The roster's six names, so a case builds a round that ran FIVE of them and says
 * which one the duplicate or the dead row stands in for. */
const LENSES_NAMES = [
  "SECURITY",
  "PERFORMANCE",
  "SIMPLICITY",
  "ARCHITECTURE",
  "ERROR_HANDLING",
  "TYPE_SAFETY",
];
const SHIPPED = defaultConfig().budgets.review?.minutes ?? 30;
// The surfaces one stop must reach — the durable record, the ungated log, the host's
// document (R3, AC5) and the count-bounded PR disclosure (R7). Each is ONE conjunction:
// a surface that stopped being written is a red case, not a sub-assertion read as colour.
const onRecord = (r: { kind?: string; reviewBound?: unknown } | undefined): boolean =>
  r?.kind === "error" && typeof r.reviewBound === "object";
const onLog = (w: string[]): boolean => w.length > 0 && w.every((x) => /STEP stopped/.test(x));
const onDocument = (p: Record<string, unknown>): boolean =>
  typeof p.reviewBound === "string" && /STEP stopped/.test(p.reviewBound) && /wave/.test(p.reviewBound);
/**
 * The whole document holds no credential-shaped byte, on EITHER of the two surfaces that
 * print the bound's child-authored strings: the object inside `gates` and the string-valued
 * `issues[].reviewBound` beside it.
 *
 * A secret placed in the record by a child that printed one before its clock fired (the
 * jsdoc's own scenario for this field) must not reach the host contract, so this is asserted
 * as an absence on the serialised document rather than a shape on one field. `JSON.stringify`
 * of the document excludes this call's own assertion message — which is why a scan of the
 * document is meaningful where a scan of the test's output would not be.
 */
const documentClean = (doc: string, secret: string): boolean =>
  doc.includes("[REDACTED]") && !doc.includes(secret);
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
  // The clock crosses the ceiling only after the fixer's integrate has pushed. It
  // counts the step's CLOCK READS, not wall time: #2082 made pass 1 ask once before
  // the pair is bought (R1) instead of once per child, so a positional script that
  // counted the old two pass-1 reads would trip the bound in the middle of pass 1
  // and the case would measure a handback rather than the post-push stop it names.
  // Slots: pair (pre-1), fixer (pre-fix), re-review (pre-re-review), and thereafter.
  const times = [0, 0, 0, 24 * MIN, 24 * MIN];
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

// ── (e2) the bounded line is a HOST surface, so a credential the child printed before its
// clock fired is scrubbed from it — the shape the run above records, with a token in each of
// its two free-text strings. The record's own field bounds (`reviewBoundProblem`) accept
// these bytes: an 80-char printable lane and a 320-char reason say nothing about what is in
// them, so the only thing between a token and the host contract is the projection's redaction
// seam — and it has to be applied on BOTH surfaces that print the two strings, not one.
{
  const SECRET = `ghp_${"a".repeat(36)}`;
  const { repoRoot, baseSha } = makeRepo();
  await setup({ repoRoot, baseSha, branch: BRANCH, feature: "export const f = 4;\n" });
  const warns: string[] = [];
  const projected: Record<string, unknown> = {};
  let doc = "";
  await captureWarns("STEP stopped", warns, async () => {
    const run = await runLean({
      repoRoot,
      issue: 7,
      handlers: boundHandlers(pastItsBudget, SHIPPED),
      now: runNow,
      seed: { baseSha, branch: BRANCH },
    });
    // The stop's own record, then the two strings the child authored, with a token written
    // into each — exactly the bytes the projection receives when a lens prints a credential
    // before the bound fires. No fixture hands them over already scrubbed.
    const step = run.run.steps.find((s) => s.state === "review");
    if (step?.outcome?.reviewBound !== undefined)
      step.outcome.reviewBound = {
        wave: "full",
        reason: `review STEP stopped: a child printed ${SECRET} before its bound`,
        unreviewedLanes: [`lens child ${SECRET} in its summary`],
      };
    Object.assign(projected, leanIssueResult(run.run, run.code) as unknown as Record<string, unknown>);
    doc = JSON.stringify(leanResultDocument(run.run, run.code).doc);
  });
  assert(
    typeof projected.reviewBound === "string" &&
      projected.reviewBound.includes("[REDACTED]") &&
      !projected.reviewBound.includes(SECRET),
    `(e2) the top-level issues[].reviewBound line redacts the child-authored strings, not only the gates object beside it (${JSON.stringify(projected.reviewBound)})`,
  );
  assert(
    documentClean(doc, SECRET),
    `(e2) no credential-shaped byte reaches the host document from either reviewBound surface (${doc.includes(SECRET) ? "the token is published" : "scrubbed"})`,
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

// ── (f) R3: the writer CLIPS the reason, so the loader can never refuse a record the
// step wrote. The two bounds are written in different files (`MAX_REASON_CHARS` here,
// `isLine` in `state-dispatches.ts`), and a step whose deadline sentence outgrew the
// validator would lose its WHOLE record on the next resume — the one permanent account
// that a head reached `ci` with lanes nobody judged.
{
  const long: StepStop = {
    live: true,
    inert: false,
    limit: "cycle-deadline",
    usedMinutes: 61,
    value: 23,
    reason: `review STEP stopped: ${"deadline ".repeat(80)}`,
  };
  const rec = reviewBoundRecord(long, "fix", ["adversarial re-review", "SECURITY"]);
  const { dir, cleanup } = tempDir();
  const run = createRun({
    issue: 7,
    version: "test",
    models: {},
    baseSha: HEAD_SHA,
    branch: BRANCH,
  });
  run.steps.push({ key: "7:review:0", state: "review", startedAt: 0, outcome: { kind: "fixed" } });
  run.steps[0]!.outcome!.reviewBound = rec;
  saveRun(dir, run);
  const loaded = loadRun(dir, 7);
  assert(
    rec.reason.length === MAX_REASON_CHARS &&
      loaded?.steps[0]?.outcome?.reviewBound?.reason === rec.reason &&
      loaded?.steps[0]?.outcome?.reviewBound?.unreviewedLanes.join(",") ===
        rec.unreviewedLanes.join(","),
    `(f) a reason longer than the record's bound is clipped AT THE WRITER and the durable record round-trips the loader intact (${String(rec.reason.length)} chars, loaded ${JSON.stringify(loaded?.steps[0]?.outcome?.reviewBound?.reason?.slice(0, 40))})`,
  );
  cleanup();
}

// ── (g) AC3: lanes are counted by DISTINCT name, and a row that never judged is not a
// lane that ran. Two rows for one lens, or a cap-killed row, must not let a row count
// stand in for six judged lanes and name no missing lane at all.
{
  const judged = (over: Partial<LensRunResult>[]) =>
    reReviewRound({ wave: "fix", head: HEAD_SHA }, over);
  const five = (skip: number): LensRunResult[] =>
    Array.from({ length: LENSES_NAMES.length - 1 }, (_unused, i) =>
      lensRowResult(i, { lens: LENSES_NAMES[i >= skip ? i + 1 : i] }),
    );
  const dup = judged([...five(1), lensRowResult(1, { lens: "SECURITY" })]);
  const killed = judged([
    ...five(1),
    lensRowResult(1, { lens: "PERFORMANCE", killCause: "token-budget" }),
  ]);
  const dead = judged([
    ...five(1),
    lensRowResult(5, { lens: "TYPE_SAFETY", parseError: "no VERDICT block" }),
  ]);
  const full = judged(LENSES_NAMES.map((lens, i) => lensRowResult(i, { lens })));
  assert(
    unjudgedLenses(full).length === 0 &&
      unjudgedLenses(dup, true).join(",") === "adversarial re-review,1 of 6 lenses unjudged" &&
      unjudgedLenses(killed).join(",") === "1 of 6 lenses unjudged" &&
      unjudgedLenses(dead).join(",") === "1 of 6 lenses unjudged" &&
      unjudgedLenses(undefined).join(",") === "6 of 6 lenses unjudged",
    `(g) a round whose rows repeat one lens name, or carry a cap-killed or unparsable row, is counted SHORT of the roster — a row count would have called all six judged (${JSON.stringify(unjudgedLenses(dup, true))}, ${JSON.stringify(unjudgedLenses(killed))}, ${JSON.stringify(unjudgedLenses(dead))})`,
  );
}

// ── (h) R7 on the host channel: the step posts NOTHING to the forge, and still records
// and logs the stop. `PI_ENSEMBLE_HANDOFF_CHANNEL=host` makes the host the only
// deliverer (the two reporting steps already refuse their posts the same way), and the
// host reads `issues[].reviewBound`, not a comment it never posted.
{
  const { repoRoot, baseSha } = makeRepo();
  await setup({ repoRoot, baseSha, branch: BRANCH, feature: "export const f = 8;\n" });
  const posts: Posts = [];
  const warns: string[] = [];
  let outcome: { kind?: string; reviewBound?: unknown } | undefined;
  const saved = process.env.PI_ENSEMBLE_HANDOFF_CHANNEL;
  process.env.PI_ENSEMBLE_HANDOFF_CHANNEL = "host";
  try {
    const times = [0, 0, 0, 24 * MIN, 24 * MIN];
    let tick = 0;
    const r = await captureWarns("STEP stopped", warns, async () => {
      outcome = (await runStep(
        ctxWithPr(repoRoot, baseSha, BRANCH, {
          startedAt: 0,
          now: () => times[Math.min(tick++, times.length - 1)] ?? 0,
        }),
        waveDeps(fixerThatCommits("host-bound"), 20, posts),
      )).outcome;
    });
    void r;
  } finally {
    if (saved === undefined) delete process.env.PI_ENSEMBLE_HANDOFF_CHANNEL;
    else process.env.PI_ENSEMBLE_HANDOFF_CHANNEL = saved;
  }
  assert(
    outcome?.kind === "fixed" &&
      posts.length === 0 &&
      warns.length > 0 &&
      outcome?.reviewBound !== undefined,
    `(h) on the host channel the step posts NO disclosure comment (the host owns every post) and still hands back the same record and the same ungated warn line (${posts.length} post(s), ${warns.length} warn line(s), ${JSON.stringify(outcome?.reviewBound)})`,
  );
}

cleanupRoots();
process.exit(failures());
