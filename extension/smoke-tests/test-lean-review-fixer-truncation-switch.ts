#!/usr/bin/env bun
/**
 * lean/review — a fixer cut off at the output-token limit is CONTINUED, once, in its own session.
 *
 * The field run this closes: the review fixer did six read-only turns, then one thinking block that
 * ended with `stopReason: "length"` at exactly 16384 output tokens with zero edit or write calls. Pi
 * exits 0, `ok` is true, no kill cause is stamped, so the step saw an unchanged head and handed the
 * run back at exit 10 after 20 of its 70 minutes — over a branch every gate had already verified
 * (7/7 hidden fail-to-pass tests, 0 pass-to-pass broken).
 *
 * Everything here drives the WHOLE step against a real temp repo, because the claims are git claims:
 * a continuation's edit reaching origin is the outcome, and a helper returning a head is not. The
 * resumed child is the injected `ReviewDeps.continueSession` seam — no model, no token, and the
 * assertions are on what that seam was ACTUALLY handed (captured on the call), never on what the case
 * intended to hand it: an assertion on the input passes on a bug where only the forwarded value was
 * wrong, which is the defect `test-lean-review-fixer-bound.ts` exists for.
 *
 *   (1) truncated fixer + a continuation that commits  -> kind `fixed`, origin advanced, one extra
 *       fixer row sharing the tree identity, and the re-review bought
 *   (2) truncated fixer + a continuation that changes nothing -> today's handback, with the cause
 *       naming the cut and the token count beside `CAUSE_NO_CHANGE`
 *   (3) ONE shot: the resumed child's own result never re-triggers detection — counted in dispatches,
 *       not judged by the eventual head
 *   (4) the never-re-asked arms, each asserting `dispatches === 1` for the fixer: a fixer that made a
 *       write-class call, one that ended on another stop reason, one the harness killed, and one whose
 *       stop reason was never recorded
 *   (5) the budget: a step whose ceiling already fired spends nothing on a continuation
 *   (6) both arms of the wave — the adversarial arm (`arm: "a"`) and the six-lens arm (`arm: "l"`) —
 *       buy the continuation, since both reach the same `fixRound`
 *
 * Real temp repos, stubbed models, no child spawned, no token spent.
 */

import { existsSync } from "node:fs";
import { put } from "./lib/lean-build-fixture.ts";
import path from "node:path";
import type { ContinuationOutcome } from "../src/developer-session-continuation.ts";
import { FIX_BOUND_MS } from "../src/lean/review.ts";
import { ReviewInfraError } from "../src/lean/review.ts";
import type { DispatchResult } from "../src/types.ts";
import {
  type ContinuationCall,
  TRUNCATED,
  ZERO_USAGE,
  committingContinuation,
  fixerResult,
  frozenCtx,
  spawnContinuation,
  subjects,
  waveDeps,
} from "./lib/lean-review-fix-reask-fixtures.ts";
import { makeAssert } from "./lib/lean-engine-fixtures.ts";
import {
  BRANCH,
  CAUSE_NO_CHANGE,
  type DispatchUsageRow,
  FIXER_ROLE,
  blockingFinding,
  carriedLensRound,
  git,
  cleanupRoots,
  depsWith,
  lensRoundFor,
  makeRepo,
  rejectsThenClears,
  result,
  runStep as run,
  setup,
} from "./lib/lean-review-fixtures.ts";

const { assert, failures } = makeAssert();

// ── (1) A CUT FIXER WHOSE CONTINUATION COMMITS IS A FIX, NOT A HAND-BACK ──────
{
  const { repoRoot, baseSha } = makeRepo();
  const head = await setup({ repoRoot, baseSha, branch: BRANCH, feature: "export const f = 1;\n" });
  const calls: ContinuationCall[] = [];
  const { outcome, threw } = await run(
    frozenCtx(repoRoot, baseSha),
    waveDeps({ fixer: {}, answer: committingContinuation("land"), onCalls: calls }),
  );
  const origin = git(repoRoot, "rev-parse", `origin/${BRANCH}`);
  assert(
    threw === undefined && outcome?.kind === "fixed",
    `(1) the run the field handed back now completes as a fix (${threw?.message ?? `kind ${String(outcome?.kind)}`})`,
  );
  assert(origin !== head, `(1) and origin holds a head beyond the reviewed ${head.slice(0, 12)}`);
  const gained = subjects(repoRoot, head, origin);
  assert(
    gained.some((s) => s.includes("after the cut")),
    `(1) the fix that landed is the CONTINUATION's commit, not the truncated turn's silence (got ${JSON.stringify(gained)})`,
  );
  assert(
    calls.length === 1,
    `(1) and exactly one continuation was asked for (${String(calls.length)})`,
  );
  // The executed-evidence assertions: what the seam was ACTUALLY handed.
  const call = calls[0] as ContinuationCall;
  assert(
    call?.transcriptPath === TRUNCATED.transcriptPath,
    `(1) the continuation resumed the FIXER's own session file — a fresh child is a second opinion, not a follow-up (${JSON.stringify(call?.transcriptPath)})`,
  );
  assert(
    call?.role === FIXER_ROLE,
    `(1) and it ran as the fixer's role, so it keeps the developer's write tools (${JSON.stringify(call?.role)})`,
  );
  assert(
    typeof call?.cwd === "string" && call.cwd.includes(".worktrees") && call.cwd.includes("-fix-"),
    `(1) and it started in the FIX TREE, not this process's directory — a resumed child elsewhere edits a checkout nobody integrates (${JSON.stringify(call?.cwd)})`,
  );
  const fence = call?.writeFence as { root?: string; repo?: string; scratch?: string } | undefined;
  assert(
    fence?.root === call?.cwd && typeof fence?.repo === "string" && fence.repo.length > 0,
    `(1) and it carries the SAME fence the fixer ran behind — root is its own tree (${JSON.stringify(fence)})`,
  );
  assert(
    typeof fence?.scratch === "string" && fence.scratch.includes("tmp/"),
    `(1) and the fence still names the run's scratch, so the continuation is not fenced more narrowly than the child (${JSON.stringify(fence?.scratch)})`,
  );
  assert(
    call?.boundMs > 0 && call?.boundMs <= FIX_BOUND_MS,
    `(1) and it ran under a bound no looser than the fixer's own ceiling (${String(call?.boundMs)})`,
  );
  assert(
    typeof call?.prompt === "string" && call.prompt.includes("output-token limit"),
    "(1) and the prompt names the cut, so the resumed child is told why it is being asked again",
  );
  // One extra row, the fixer's role, and the tree identity SHARED with the first child — the field
  // that a resumed attempt matches on, and the one #1930 silently dropped.
  const rows = outcome?.dispatches ?? [];
  const fixers = rows.filter((r) => r.role === FIXER_ROLE);
  assert(
    fixers.length === 2,
    `(1) the continuation is ONE extra fixer cost row in the same wave — the wave is still one wave (${String(fixers.length)})`,
  );
  assert(
    fixers.length === 2 && fixers[0]?.runId === fixers[1]?.runId,
    `(1) and both rows share the fix tree's identity, so the loader's grammar still accepts them (${JSON.stringify(fixers.map((r) => r.runId))})`,
  );
  assert(
    existsSync(path.join(repoRoot, ".worktrees")) === false ||
      git(repoRoot, "worktree", "list").includes(".worktrees/lean-7") === true,
    "(1) precondition: the run's own tree is intact after the wave",
  );
}

// ── (2) A CONTINUATION THAT CHANGES NOTHING IS TODAY'S HANDBACK, WITH THE CUT NAMED ─
{
  const { repoRoot, baseSha } = makeRepo();
  const head = await setup({ repoRoot, baseSha, branch: BRANCH, feature: "export const f = 2;\n" });
  const calls: ContinuationCall[] = [];
  const { outcome, threw } = await run(
    frozenCtx(repoRoot, baseSha),
    waveDeps({
      fixer: {},
      answer: { ok: true, text: "I looked and left it alone" },
      onCalls: calls,
    }),
  );
  assert(
    outcome === undefined && threw instanceof ReviewInfraError,
    `(2) a continuation that moved nothing is still the handback it always was (${threw?.message ?? `kind ${String(outcome?.kind)}`})`,
  );
  const message = threw?.message ?? "";
  assert(
    message.includes(CAUSE_NO_CHANGE),
    `(2) the cause is still the named no-change one — three surfaces match on it and it must stay the head of the sentence (${message})`,
  );
  assert(
    message.includes("output-token limit") && message.includes("16384"),
    `(2) and it names the truncation and the tokens, so an operator is not told "it fixed nothing" about a cut-off child (${message})`,
  );
  assert(
    message.includes("one continuation changed nothing"),
    `(2) and it says the continuation was spent, so the handback is not read as an untried one (${message})`,
  );
  assert(calls.length === 1, `(2) and it was tried exactly once (${String(calls.length)})`);
  assert(
    git(repoRoot, "rev-parse", `origin/${BRANCH}`) === head,
    "(2) and nothing reached origin — the branch still holds the head the gates read",
  );
  // The absence rule, on the failure arm too: a continuation that never answered is the SAME handback,
  // and must never collapse into "fixed" or into a different cause.
  const silent: ContinuationCall[] = [];
  const s = await run(
    frozenCtx(repoRoot, baseSha),
    waveDeps({ fixer: {}, answer: { ok: false, reason: "no-answer" }, onCalls: silent }),
  );
  assert(
    s.threw instanceof ReviewInfraError &&
      s.threw.message.includes(CAUSE_NO_CHANGE) &&
      s.threw.message.includes("output-token limit"),
    `(2) and a continuation that never replied is the same named handback — silence is never a pass, in either direction (${s.threw?.message})`,
  );
  assert(
    s.threw === undefined || (s.threw as ReviewInfraError).dispatches.length > 0,
    "(2) and the children the step paid for are still billed on the throw",
  );
}

// ── (3) ONE SHOT — the resumed child's own result never re-triggers the detector ─
{
  // A resumed session REPLAYS the truncated turn, so a detector that saw the second child's result
  // would read the same "length" and ask again forever. The guarantee is a wave-local flag, so it is
  // measured in DISPATCHES — an eventual-head assertion could be satisfied by an unbounded loop that
  // happened to commit on its ninth pass.
  const { repoRoot, baseSha } = makeRepo();
  await setup({ repoRoot, baseSha, branch: BRANCH, feature: "export const f = 3;\n" });
  const calls: ContinuationCall[] = [];
  let fixerDispatches = 0;
  const deps = depsWith({
    adversarial: rejectsThenClears("1. the finding the fixer must answer", 1),
    lens: async (a) => lensRoundFor(a, "APPROVED", []),
    dispatch: async () => {
      fixerDispatches++;
      // The fixer never writes and always reports itself truncated.
      return fixerResult({});
    },
    continueSession: async (args) => {
      calls.push(args);
      // The resumed child also reports "length" (a replay would) and changes nothing.
      return { ok: true, text: "still thinking" };
    },
  });
  const { threw } = await run(frozenCtx(repoRoot, baseSha), deps);
  assert(
    threw instanceof ReviewInfraError,
    `(3) the wave still hands back when neither turn changed anything (${threw?.message ?? "no throw"})`,
  );
  assert(
    calls.length === 1,
    `(3) ONE continuation per wave even though the resumed child also reported "length" — a re-detection on a replayed turn is an unbounded loop of paid children (${String(calls.length)})`,
  );
  assert(
    fixerDispatches === 1,
    `(3) and no second fixer was dispatched either (${String(fixerDispatches)})`,
  );
  const rows = (threw as ReviewInfraError | undefined)?.dispatches ?? [];
  assert(
    rows.filter((r) => r.role === FIXER_ROLE).length === 2,
    `(3) and the rows say what really happened: the original child plus one continuation, no more (${String(rows.filter((r) => r.role === FIXER_ROLE).length)})`,
  );
}

// ── (4) THE NEVER-RE-ASKED ARMS — each asserts one fixer dispatch and no seam call ─
{
  // The arms that end the wave BEFORE it is judged, asserted apart from the four that reach the
  // no-change predicate: a fixer pi-rukas killed is routed by `runFixer` (`throwIfDispatchFailed`),
  // and the step's own ceiling by `fixRound`'s `stop.fired` — neither reaches the detector's answer
  // because the detector's `killed`/`budget-fired` refusals happen to sit behind a route that already
  // fired. What matters here is that neither spends a continuation.
  const routed: Array<[string, Partial<DispatchResult>, string]> = [
    [
      "was killed by the bound",
      { killCause: "child-bound", usage: ZERO_USAGE },
      "a child pi-rukas ended is a budget/infra stop, never a provider fault",
    ],
    [
      "was aborted",
      { killCause: "abort", usage: ZERO_USAGE },
      "same for a cancel: the kill branch must run before the stop-reason branch",
    ],
  ];
  for (const [label, over, why] of routed) {
    const { repoRoot, baseSha } = makeRepo();
    await setup({ repoRoot, baseSha, branch: BRANCH, feature: "export const f = 4;\n" });
    const calls: ContinuationCall[] = [];
    const { threw } = await run(
      frozenCtx(repoRoot, baseSha),
      waveDeps({ fixer: over, answer: committingContinuation(label), onCalls: calls }),
    );
    assert(
      threw instanceof ReviewInfraError,
      `(4) a fixer that ${label} still ends the step as an infra stop, on the arm it always ended it on — ${why} (${threw?.message ?? "no throw"})`,
    );
    assert(
      calls.length === 0,
      `(4) and no continuation was bought for a child this harness ended (seam calls ${String(calls.length)})`,
    );
  }

  const arms: Array<[string, Partial<DispatchResult>, string]> = [
    [
      "made a write call",
      { toolUses: [{ type: "toolCall", id: "1", name: "edit" }] },
      "a fixer that edited and never committed is the fold's problem, not this one — re-asking pays twice for bytes that exist",
    ],
    [
      "ended on another stop reason",
      { stopReason: "stop" },
      "a fixer that finished its turn and chose to change nothing is not a cut-off one",
    ],
    [
      "recorded no stop reason at all",
      { stopReason: undefined },
      "a result nobody watched finish is not vouchable as truncated — the absence must not become a guess",
    ],
    [
      "carried a tool-call record its live counter contradicts",
      { observedToolCalls: 3 },
      "an empty replay beside a live counter of 3 is a child whose writes nobody saw",
    ],
  ] as const;
  for (const [label, over, why] of arms) {
    const { repoRoot, baseSha } = makeRepo();
    const head = await setup({
      repoRoot,
      baseSha,
      branch: BRANCH,
      feature: "export const f = 4;\n",
    });
    const calls: ContinuationCall[] = [];
    const { threw } = await run(
      frozenCtx(repoRoot, baseSha),
      waveDeps({
        fixer: { ...over, killCause: over.killCause },
        answer: committingContinuation(label),
        onCalls: calls,
      }),
    );
    assert(
      threw instanceof ReviewInfraError && threw.message.includes(CAUSE_NO_CHANGE),
      `(4) a fixer that ${label} still gets today's no-change handback (${threw?.message ?? "no throw"})`,
    );
    assert(
      calls.length === 0,
      `(4) and it was NEVER continued — ${why} (seam calls ${String(calls.length)})`,
    );
    assert(
      (threw as ReviewInfraError | undefined)?.dispatches.filter((r) => r.role === FIXER_ROLE)
        .length === 1,
      `(4) and the fixer was dispatched exactly once (${JSON.stringify((threw as ReviewInfraError | undefined)?.dispatches.map((r) => r.role))})`,
    );
    assert(
      !(threw?.message ?? "").includes("output-token limit"),
      `(4) and nothing names a truncation this arm never saw (${threw?.message})`,
    );
    assert(
      git(repoRoot, "rev-parse", `origin/${BRANCH}`) === head,
      "(4) and no fix reached origin on an arm that was never continued",
    );
  }
}

// ── (5) A STEP WHOSE BUDGET ALREADY FIRED SPENDS NOTHING ON A CONTINUATION ────
{
  const { repoRoot, baseSha } = makeRepo();
  await setup({ repoRoot, baseSha, branch: BRANCH, feature: "export const f = 5;\n" });
  const calls: ContinuationCall[] = [];
  const { defaultConfig } = await import("../src/lean/config.ts");
  const cfg = defaultConfig();
  // The TURNS lever, and not the minutes one: the step's own minute ceiling is read before the wave
  // is judged at all (`clock()` → a stop), so arming it would test that route rather than the
  // detector's `budget-fired` refusal. The turns lever is the breach the armed budget measures per
  // child turn and reports afterwards off `killCause`, which is why the stub below carries
  // "child-bound" — without it `fired()` answers nothing and the case would assert a refusal the step
  // never had to make.
  cfg.budgets.review = { turns: 1, tokens: 0, minutes: 0 };
  const deps = depsWith({
    loadConfig: async () => cfg,
    adversarial: rejectsThenClears("1. the finding the fixer must answer", 1),
    lens: async (a) => lensRoundFor(a, "APPROVED", []),
    // A child the turns lever aborted: its own bound cause, which is how `fired()` learns the ceiling
    // fired, and the only reading a real aborted child gives the step.
    dispatch: async () => fixerResult({ killCause: "child-bound" }),
    continueSession: async (args) => {
      calls.push(args);
      return { ok: true, text: "should never be asked" };
    },
  });
  const { threw } = await run(frozenCtx(repoRoot, baseSha), deps);
  assert(
    threw !== undefined,
    `(5) the armed budget stops the step (${threw?.message ?? "no throw"})`,
  );
  assert(
    calls.length === 0,
    `(5) and no continuation is dispatched after the ceiling fired — it would be born aborted (seam calls ${String(calls.length)})`,
  );
}

// ── (6) BOTH ARMS OF THE WAVE BUY IT — the adversarial arm and the six-lens arm ─
{
  // The adversarial arm (`arm: "a"`) is covered by (1)–(3). The lens arm reaches the same `fixRound`
  // with `arm: "l"` and was never covered by a no-change case, so a continuation wired only into the
  // adversarial path would have stayed green.
  const { repoRoot, baseSha } = makeRepo();
  const head = await setup({ repoRoot, baseSha, branch: BRANCH, feature: "export const f = 6;\n" });
  const calls: ContinuationCall[] = [];
  const seenTrees: string[] = [];
  const deps = depsWith({
    // The gate approves: the blocking rows come from the six-lens round alone.
    adversarial: async () => result({ loopOutcome: "approved" }),
    lens: async (a) =>
      a.wave === "fix"
        ? lensRoundFor(a, "APPROVED", [])
        : lensRoundFor(a, "ISSUES_FOUND", [blockingFinding()]),
    dispatch: async (spec) => {
      seenTrees.push(path.basename(spec.cwd as string));
      return fixerResult({});
    },
    continueSession: async (args) => {
      calls.push(args);
      put(args.cwd, "continued-lens.ts", "export const continued = true;\n");
      git(args.cwd, "add", "-A");
      git(args.cwd, "commit", "-q", "-m", "fix: the lens finding after the cut");
      return { ok: true, text: "fixed" };
    },
  });
  const { outcome, threw } = await run(frozenCtx(repoRoot, baseSha), deps);
  assert(
    threw === undefined && outcome?.kind === "fixed",
    `(6) the LENS arm's wave continues too (${threw?.message ?? `kind ${String(outcome?.kind)}`})`,
  );
  assert(
    seenTrees.some((t) => /-l-full-/.test(t)),
    `(6) precondition: this was the six-lens arm's tree (${JSON.stringify(seenTrees)})`,
  );
  assert(
    calls.length === 1,
    `(6) and one continuation was asked for on this arm (${String(calls.length)})`,
  );
  assert(
    git(repoRoot, "rev-parse", `origin/${BRANCH}`) !== head,
    "(6) and the lens arm's fix reached origin",
  );
}

// ── (7) the truncated arm's ROW TOTAL, stated against the wave's budget ───────
{
  // `test-lean-review-bound.ts` (e4) pins `PASS_ROWS * REVIEW_PASSES + 1` for the arms that were never
  // truncated, and that count must not move. This is the sibling case R5 asks for: the truncated arm
  // states its OWN total, +1, so a second continuation (or a second wave) goes red here and nowhere
  // else.
  const { repoRoot, baseSha } = makeRepo();
  await setup({ repoRoot, baseSha, branch: BRANCH, feature: "export const f = 7;\n" });
  const calls: ContinuationCall[] = [];
  const deps = depsWith({
    adversarial: rejectsThenClears("1. the finding the fixer must answer", 1),
    // The re-review reports the row carried, so the step hands back on the row rather than on the
    // empty wave — which is what lets the truncated arm's rows be counted on a `fixed`-shaped wave.
    lens: async (a) =>
      a.wave === "fix" ? carriedLensRound(a, [blockingFinding()]) : lensRoundFor(a, "APPROVED", []),
    dispatch: async () => fixerResult({}),
    continueSession: async (args) => {
      calls.push(args);
      put(args.cwd, "counted.ts", "export const counted = 1;\n");
      git(args.cwd, "add", "-A");
      git(args.cwd, "commit", "-q", "-m", "fix: counted");
      return { ok: true, text: "fixed" };
    },
  });
  const { threw } = await run(frozenCtx(repoRoot, baseSha), deps);
  const rows: DispatchUsageRow[] = (threw as ReviewInfraError | undefined)?.dispatches ?? [];
  assert(calls.length === 1, `(7) precondition: the continuation ran (${String(calls.length)})`);
  assert(
    rows.filter((r) => r.role === FIXER_ROLE).length === 2,
    `(7) the truncated arm bills TWO fixer rows — the wave's one plus its continuation (${String(rows.filter((r) => r.role === FIXER_ROLE).length)})`,
  );
  assert(
    rows.filter((r) => r.role === "code-review-specialist").length === 12,
    `(7) and every lens child is still its own row, unchanged by the continuation (${String(rows.filter((r) => r.role === "code-review-specialist").length)} for two rounds)`,
  );
  // Recording is not behaviour and is not behind the switch: each row carries its own stop reason, so
  // the step record — not only the transcript — shows a cut child.
  const cut = rows.filter((r) => r.role === FIXER_ROLE)[0];
  assert(
    cut?.stopReason === "length",
    `(7) and the fixer's row records the cut, so the record shows it after the session file is gone (${JSON.stringify(cut?.stopReason)})`,
  );
  assert(
    cut?.usage.output === 16_384,
    `(7) and its output-token count, which is the number the handback quotes (${String(cut?.usage.output)})`,
  );
}

cleanupRoots();
process.exit(failures());
