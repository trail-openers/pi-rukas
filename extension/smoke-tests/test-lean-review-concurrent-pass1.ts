#!/usr/bin/env bun
/**
 * #2082 — pass 1's adversarial gate and lens round are BOUGHT TOGETHER.
 *
 * Review is about half of a lean run's step time and its two pass-1 children were
 * paid for one after the other: in one run the gate took 573 s and the slowest lens
 * 1024 s, with none of the gate's wall clock overlapping the lenses'. The only value
 * the pair was serialised on was `carried` — the gate's non-blocking findings,
 * printed into every lens brief — and pass 1 now passes it `undefined` (R4): those
 * findings reach the fixer's brief and the re-review, which is where the step acts
 * on them at all.
 *
 * Four properties, one case each:
 *
 *  - (a) the overlap, read off instants the CHILDREN stamped at their own dispatch
 *    (R6), with BOTH children held in flight and the release order stated — at base
 *    the second dispatch could not have happened at all while the first was held.
 *  - (b) R2: neither child is left running. A child that throws comes back as the
 *    same throw, but only once BOTH have settled.
 *  - (c) R3: one budget lever serves both children, so a lever that fires while both
 *    are in flight ends both and names itself ONCE, with both children's rows.
 *  - (d) R4: pass 1's `carried` is undefined and the gate's findings still reach the
 *    fixer's brief and the re-review, asserted through the contexts/fixBriefs capture
 *    harness (R6) rather than a fixed-return stub.
 *
 * Real temp repos, stubbed models, no child spawned, no token spent.
 */

import { ReviewInfraError } from "../src/lean/review.ts";
import { makeAssert } from "./lib/lean-engine-fixtures.ts";
import { concurrentPass1 } from "./lib/lean-review-concurrent-fixture.ts";
import {
  ADVERSARIAL_GATE_ROLE,
  BRANCH,
  FIXER_ROLE,
  LENS_ROLE,
  blockingFinding,
  cleanupRoots,
  ctxFor,
  depsWith,
  fixerThatCommits,
  lensRoundFor,
  lensRoundWith,
  makeRepo,
  result,
  parsedRound,
  runStep,
  setup,
} from "./lib/lean-review-fixtures.ts";

const { assert, failures } = makeAssert();

/**
 * Yield until the step has taken `n` turns through the harness's `exec`.
 *
 * The review harness replaces the world with a REAL git `exec` that shells out
 * through `execp`, and `execp` starts its child from a `setTimeout(0)` — so every
 * git read costs the step a macrotask, not a millisecond of wall clock. A step
 * that has to resolve a head, read a diff and open the branch before it dispatches
 * therefore needs a handful of turns to get to the dispatches at all, and a
 * wall-clock `setTimeout` of any length could burn them before the first dispatch
 * is ever reached (measured: 40 ms of wall clock bought neither child). So the
 * cases below pump the queue and then read the stamps: what is observed is
 * “dispatched by then”, not “dispatched within 40 ms”, which is the claim the
 * overlap actually makes.
 */
async function drain(n = 400): Promise<void> {
  for (let i = 0; i < n; i++)
    await new Promise((r) => {
      setTimeout(r, 0);
    });
}

/** Release the held pair once BOTH children are in flight (or `n` turns have
 * passed), and report what had been dispatched by then. Releasing on a fixed
 * turn count would let the release itself decide the observation: the step
 * resolves its head, its diff and its evidence through the harness's real `exec`
 * before either child is bought, and those reads cost an unbounded number of
 * macrotasks. */
async function releaseWhenBoth(
  stamps: { gateStart?: number; lensStart?: number },
  releaseAll: () => void,
  n = 400,
): Promise<{ gate: boolean; lens: boolean }> {
  for (let i = 0; i < n; i++) {
    if (stamps.gateStart !== undefined && stamps.lensStart !== undefined) break;
    await new Promise((r) => {
      setTimeout(r, 0);
    });
  }
  const gate = stamps.gateStart !== undefined;
  const lens = stamps.lensStart !== undefined;
  releaseAll();
  return { gate, lens };
}

// ── (a) AC1/AC5: both pass-1 dispatches start before either finishes ────────
{
  const { repoRoot, baseSha } = makeRepo();
  await setup({ repoRoot, baseSha, branch: BRANCH, feature: "export const f = 2082;\n" });
  const pair = concurrentPass1({ gateReply: () => result({ loopOutcome: "approved" }) });
  const step = runStep(ctxFor(repoRoot, baseSha, BRANCH), pair.deps);
  // Observed BEFORE anything is released: at base the lens dispatch had not
  // happened while the gate was held, so `lensStart` could not be stamped and the
  // pair could not both be waiting.
  const inFlight = await releaseWhenBoth(pair.stamps, pair.releaseAll);
  const { outcome, threw } = await step;
  assert(
    inFlight.gate && inFlight.lens,
    `(a) the step had bought BOTH pass-1 children before either answered — gate ${inFlight.gate ? "in flight" : "never dispatched"}, lenses ${inFlight.lens ? "in flight" : "never dispatched"} while the other was still held; at base the lenses were not dispatched until the gate had settled`,
  );
  assert(
    threw === undefined && outcome?.kind === "done",
    `(a) and the concurrent pair still ends the same clean pass (${threw?.message ?? `kind ${String(outcome?.kind)}`})`,
  );
  assert(
    pair.stamps.gateWaves.join() === "full" && pair.stamps.lensWaves.join() === "full",
    `(a) and neither child was bought twice — one gate pass and one lens round (gates ${JSON.stringify(pair.stamps.gateWaves)}, lenses ${JSON.stringify(pair.stamps.lensWaves)})`,
  );
  const rows = outcome?.dispatches ?? [];
  assert(
    rows.filter((r) => r.role === ADVERSARIAL_GATE_ROLE).length === 1 &&
      rows.filter((r) => r.role === LENS_ROLE).length === 6,
    `(a) and both children are on the cost record: one gate row plus six lens rows (got ${JSON.stringify(rows.map((r) => r.role))})`,
  );
}

// ── (b) R2: a child that throws is raised only after BOTH have settled ──────
{
  const { repoRoot, baseSha } = makeRepo();
  await setup({ repoRoot, baseSha, branch: BRANCH, feature: "export const f = 2082;\n" });
  const pair = concurrentPass1({ gateReply: () => result({ loopOutcome: "approved" }) });
  // The gate's seam dies — the shape `adversarialGate` wraps as
  // "the adversarial loop threw". The child settles on its own after a moment, so
  // the case can watch the lens round from here without releasing anything.
  pair.deps.adversarial = async () => {
    pair.stamps.gateStart = Date.now();
    await new Promise((r) => setTimeout(r, 10));
    pair.stamps.gateEnd = Date.now();
    throw new Error("the adversarial child died");
  };
  const step = runStep(ctxFor(repoRoot, baseSha, BRANCH), pair.deps);
  await drain();
  assert(
    pair.stamps.gateEnd !== undefined &&
      pair.stamps.lensStart !== undefined &&
      pair.stamps.lensEnd === undefined,
    `(b) precondition: the gate had already thrown while the lens round the step paid for was STILL in flight (gate end ${String(pair.stamps.gateEnd)}, lens start ${String(pair.stamps.lensStart)}, lens end ${String(pair.stamps.lensEnd)})`,
  );
  pair.releaseAll();
  const { outcome, threw } = await step;
  assert(
    pair.stamps.lensEnd !== undefined && pair.stamps.lensEnd >= (pair.stamps.gateEnd ?? 0),
    `(b) R2: the step awaited the child it had already paid for instead of handing back around it (lens end ${String(pair.stamps.lensEnd)}, gate end ${String(pair.stamps.gateEnd)})`,
  );
  assert(
    outcome === undefined &&
      threw instanceof ReviewInfraError &&
      /the adversarial loop threw/.test(threw.message),
    `(b) and the gate's own cause still reaches the operator, as the step's infra error (${threw?.message ?? `kind ${String(outcome?.kind)}`})`,
  );
  const rows = (threw as ReviewInfraError | undefined)?.dispatches ?? [];
  assert(
    rows.length === 0,
    `(b) and the rows on the throw are the children the step MEASURED: the dead gate reported no cost and the lens rows are appended by the adapter that never completed (got ${JSON.stringify(rows.map((r) => r.role))})`,
  );
}

// ── (c) R3: one lever fires while BOTH children are in flight ───────────────
//
// `armBudget` returns ONE BudgetArms for the step: one AbortController, one frozen
// `hit`. So a turns breach seen while the pair runs aborts both children and both
// report their own kill cause. What the step owes the operator is the lever named
// ONCE, with both children's rows on it.
{
  const { repoRoot, baseSha } = makeRepo();
  await setup({ repoRoot, baseSha, branch: BRANCH, feature: "export const f = 2082;\n" });
  const CEILING = 40;
  const pair = concurrentPass1({
    gateReply: () => result({ loopOutcome: "approved", killCause: "abort" }),
  });
  pair.deps.lens = async (a) => {
    pair.stamps.lensStart = Date.now();
    // The lens round's own child ticks past the ceiling on the step's ONE armed
    // hook, which is what aborts the signal both children were given.
    a.budget.opts.onProgress?.({
      role: LENS_ROLE,
      turns: CEILING + 6,
      toolUses: CEILING + 6,
      totalTokens: 1_000,
      usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0, turns: CEILING + 6 },
    } as never);
    await new Promise((r) => setTimeout(r, 10));
    pair.stamps.lensEnd = Date.now();
    return {
      ...lensRoundWith("APPROVED", []),
      lenses: lensRoundWith("APPROVED", []).lenses.map((lens) => ({
        ...lens,
        // A child the abort ended reports its own kill cause and is not a review
        // that happened.
        killCause: "abort" as const,
      })),
    };
  };
  pair.deps.loadConfig = async () => {
    const { defaultConfig } = await import("../src/lean/config.ts");
    const cfg = defaultConfig();
    cfg.budgets.review = { turns: CEILING, tokens: 0, minutes: 0 };
    return cfg;
  };
  const step = runStep(ctxFor(repoRoot, baseSha, BRANCH), pair.deps);
  await drain();
  // The gate is still held when the lens round trips the lever: read the gate's
  // state now, before anything is released.
  const gateInFlight = pair.stamps.gateStart !== undefined && pair.stamps.gateEnd === undefined;
  pair.releaseAll();
  const { outcome, threw } = await step;
  assert(gateInFlight, "(c) precondition: the gate child was still in flight when the lens round tripped the turns lever");
  assert(
    pair.stamps.gateEnd !== undefined,
    `(c) R3: the shared abort ended BOTH children — the gate settled at ${String(pair.stamps.gateEnd)} after the lever fired (start ${String(pair.stamps.gateStart)})`,
  );
  assert(
    outcome === undefined && threw instanceof ReviewInfraError,
    `(c) and a lever that fires mid-pair stops the step rather than merging an unreviewed head (${threw?.message ?? `kind ${String(outcome?.kind)}`})`,
  );
  assert(
    /turns/.test(String(threw?.message)),
    `(c) and the cause names the turns lever that ended them (${threw?.message})`,
  );
  assert(
    (String(threw?.message).match(/turns budget/g) ?? []).length === 1,
    `(c) R3: the lever is named ONCE for the pair, not once per child (${threw?.message})`,
  );
  const rows = (threw as ReviewInfraError | undefined)?.dispatches ?? [];
  assert(
    rows.some((r) => r.role === LENS_ROLE) && rows.some((r) => r.role === ADVERSARIAL_GATE_ROLE),
    `(c) and both children's rows ride on the throw, so the handback prices what the step paid (${JSON.stringify(rows.map((r) => r.role))})`,
  );
}

// ── (d) R4: pass 1's carried is undefined; the gate's findings still reach the
// fixer's brief and the re-review ─────────────────────────────────────────────
//
// Through the capture of what the children were ACTUALLY dispatched with (R6): a
// stub that returned a fixed value could not tell the step's argument from its own
// constant.
{
  const GATE_TEXT = "1. the non-blocking finding the gate reported";
  const lensFindings = "- [HIGH] SECURITY a.ts:1: the leak the six-lens round blocked on";
  const contexts: string[] = [];
  const fixBriefs: string[] = [];
  const { repoRoot, baseSha } = makeRepo();
  await setup({ repoRoot, baseSha, branch: BRANCH, feature: "export const f = 2082;\n" });
  let gateCalls = 0;
  const { outcome, threw } = await runStep(
    ctxFor(repoRoot, baseSha, BRANCH),
    depsWith({
      // The gate reaches its terminal round on a NON-BLOCKING verdict with
      // findings still open — `PASSED WITH FINDINGS`. That is the reading R4 is
      // about: `openFromPass` hands its text back as the gate's findings while
      // `blockingRecord` says the run was never stopped for them, so the step
      // owes the operator a disclosure and owes the gate no demand. The second
      // call is the re-review's own pass, which clears.
      adversarial: async () => {
        gateCalls++;
        return result({
          loopOutcome: "approved",
          text: gateCalls === 1 ? `Adversarial PASSED WITH FINDINGS: ${GATE_TEXT}` : "",
          ...(gateCalls === 1 ? {} : { adversarialRounds: parsedRound("APPROVED") }),
        });
      },
      lens: async (a) => {
        contexts.push(a.context);
        if (a.wave === "fix") return lensRoundFor(a, "APPROVED", []);
        // The row the layer REPORTED and the rendered line it hands the fixer are
        // built together in production; a stub that set only one would make the
        // fixer's brief say something the round never reported.
        const round = lensRoundWith("CRITICAL_ISSUES_FOUND", [blockingFinding()]);
        return { ...round, findings: lensFindings };
      },
      dispatch: async (spec) => {
        fixBriefs.push(spec.prompt);
        return fixerThatCommits("concurrent-wave")(spec);
      },
    }),
  );
  assert(
    threw === undefined && outcome?.kind === "fixed",
    `(d) precondition: the lenses blocked, the wave ran, and the re-review cleared it (${threw?.message ?? `kind ${String(outcome?.kind)}`})`,
  );
  assert(contexts.length === 2, `(d) and both lens rounds were captured (${String(contexts.length)})`);
  assert(
    (contexts[0] ?? "").includes("full review of the branch") &&
      !(contexts[0] ?? "").includes("OUTSTANDING FROM THE ADVERSARIAL GATE"),
    `(d) R4: pass 1's lenses were dispatched with NO carried block — the gate had not answered when the round was bought (${JSON.stringify((contexts[0] ?? "").slice(0, 70))})`,
  );
  assert(
    (contexts[1] ?? "").includes("re-review of the fix") &&
      (contexts[1] ?? "").includes(GATE_TEXT),
    `(d) and the gate's non-blocking findings still reach the re-review, exactly as a blocking gate's do today (${JSON.stringify((contexts[1] ?? "").slice(-110))})`,
  );
  assert(
    fixBriefs.length === 1 && (fixBriefs[0] ?? "").includes(lensFindings),
    `(d) and the blocking row the six-lens round raised is in the fixer's brief (${JSON.stringify((fixBriefs[0] ?? "").match(/## The findings[\s\S]{0,120}/)?.[0] ?? "")})`,
  );
  // R4, stated honestly. A NON-BLOCKING gate contributes neither its name nor its
  // prose to the wave's brief — true before this change and after it, because only
  // a blocking verdict is a demand. What the overlap removes is pass 1's lens block
  // (asserted above), and what carries the gate's text now is the re-review's
  // brief: the value named `carried` below is the FULL pass's findings, which is
  // what R4 keeps. The case asserts the step's own reading rather than a
  // disclosure it never made.
  assert(
    gateCalls === 2,
    `(d) and the gate was paid for exactly twice — the full pass and the re-review's own pass (${String(gateCalls)})`,
  );
  assert(
    gateCalls === 2 && (contexts[1] ?? "").includes(GATE_TEXT),
    `(d) and the findings the FULL pass left open are what the re-review was carried with — the value survived the wave rather than being recomputed from the second pass (${String(gateCalls)} gate calls)`,
  );
  assert(
    fixBriefs.length === 1 && !(fixBriefs[0] ?? "").includes("adversarial pass"),
    `(d) and the non-blocking gate still contributes NEITHER its name nor a demand — the brief names the six-lens round that blocked (${JSON.stringify((fixBriefs[0] ?? "").match(/gate: [^\n]*/)?.[0] ?? "")})`,
  );
  // The fixer's role is on the record, so (d) cannot be green on a wave that never
  // dispatched anyone.
  assert(
    (outcome?.dispatches ?? []).some((r) => r.role === FIXER_ROLE),
    `(d) and the fixer is billed on the cost record (${JSON.stringify((outcome?.dispatches ?? []).map((r) => r.role))})`,
  );
}

cleanupRoots();
process.exit(failures());
