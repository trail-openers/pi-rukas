/**
 * seams-registry-locate — the one seam entry whose production caller lives in a
 * subdirectory, and the `locate` field that lets it be judged at all.
 *
 * The gate's two importer checks (its `has production importer(s)` and its canary)
 * both match a bare basename against a flat scan of `src/`'s top-level files, so a
 * caller at `src/lean/x.ts` is invisible to them and its import spells the seam as
 * `../<seam>.ts` where the pattern expects `./`. `locate` points those checks at the
 * recursive corpus instead: the seam classifies candidates, and the gate keeps
 * asserting the real import rather than trusting the declaration. The type lives here so
 * `seams-registry.ts` does not carry it — that file sat 6 lines under the 500-line gate
 * before this entry was added, and the entry plus its field would have crossed it (AGENTS.md §12).
 */

/**
 * Classify one candidate source file (its `name` relative to `src/`, so a
 * subdirectory path carries its directory) for a seam whose caller is not at `src/`'s
 * top level. `importsSeam` is the import the file must really contain; `production`
 * names the single file carrying the canary symbol — type-only importers must answer
 * false there, or a `import type` would satisfy a reachability claim.
 */
export type SeamLocator = (source: {
  name: string;
  text: string;
}) => { production: boolean; importsSeam: boolean };

export const SEAMS_CONTINUATION: import("./seams-registry.ts").Seam[] = [
  {
    // The whole pure decision about a fixer cut off at the output-token limit: the switch, the
    // detector, the continuation's bound, its prompt, its cost row and the cause's clause. Its
    // callers are the review step's own files under `src/lean/`, so it is judged against the
    // recursive corpus like `developer-session-continuation.ts` below.
    file: "fixer-truncation.ts",
    pending: {},
    testOnly: {
      // Read at call time by the detector, and pinned directly by the off/on-arm suites — a step
      // never calls the switch itself, the detector does.
      leanFixerTruncationReaskEnabled:
        "the switch's ONE reader; test-lean-review-fixer-truncation-off-arm.ts and test-headless-work-lean-gates-switch.ts pin the off arm",
      // The stop reason the detector compares against, named by no caller outside this module.
      TRUNCATED_STOP_REASON:
        "the literal the detector compares the child's recorded stop reason against; test-lean-review-fix-reask-pure.ts pins every arm of that comparison",
      // The refusal table's shape: read as a whole by the step, and arm by arm by the pure suite.
      fixerWasTruncated:
        "the detector; test-lean-review-fix-reask-pure.ts pins the refusal table and the arm order",
      continuationRow:
        "the continuation's cost row; test-lean-review-fix-reask-pure.ts (10) pins that unreported usage costs zero, and test-lean-review-fixer-truncation-rows.ts (2) pins every child-authored field normalised so a malformed report cannot delete its own row",
      truncatedFixerOutputTokens:
        "the token count the clause quotes; test-lean-review-fixer-truncation-rows.ts (1) pins the forward scan names the CUT child, and pins the reversed array answering the continuation's count so a back-scan cannot pass silently",
    },
    canary: {
      symbol: "fixerWasTruncated",
      importer: "lean/review-fix-child.ts",
    },
    locate: (source: { name: string; text: string }) => ({
      // The one file that turns a truncated fixer into a second child — the arm that pays for it.
      // `review-fix-child.ts`: the detector and the ask are one function, in the file that already owns
      // the fixer's dispatch.
      production: source.name === "lean/review-fix-child.ts",
      importsSeam: /from "\.\.\/fixer-truncation\.ts"/.test(source.text),
    }),
  },
  {
    // A second prompt on a truncated fixer's OWN session: the review step paid for
    // the first child, got a turn back that ended at the provider's output cap with
    // no edit, and asks that same child once more before handing back "no change".
    file: "developer-session-continuation.ts",
    pending: {},
    testOnly: {
      // The trace tag every continuation line carries, named by no caller.
      CONTINUATION_SOURCE_TAG:
        "the trace prefix the child's failure lines carry; test-lean-review-fixer-truncation-switch.ts pins the arms that trace under it",
      // The resumed child's argv: the resume flags, the role's OWN exclusion list
      // (empty for a developer, so `edit`/`write` survive), and the guard companion.
      continuationChildArgs:
        "the continuation child's argv; test-lean-review-fixer-bound.ts pins the resume flags and that a reviewer role keeps its exclusions",
      // The RPC-stream reply extractor, and the per-turn usage reader. A resumed
      // session REPLAYS the truncated turn, so both must read the LAST agent_end —
      // reading the first child's text or its token count as the continuation's is
      // the shape of a wave that reports a fix nobody made.
      continuationReplyText:
        "the RPC-stream reply extractor; test-lean-review-fixer-bound.ts pins that only the last turn answers",
      lastAgentEndFinalTurn:
        "the last turn's own stopReason and usage, never summed across a replayed session; test-lean-review-fixer-bound.ts pins the replay arms",
    },
    canary: {
      symbol: "spawnDeveloperContinuationChild",
      importer: "lean/review-deps.ts",
    },
    locate: (source: { name: string; text: string }) => ({
      // The one file that imports this module as a VALUE — the others reach it for types only, so
      // a first subdirectory match would name a type-only importer as the caller.
      production: source.name === "lean/review-deps.ts",
      importsSeam: /from "\.\.\/developer-session-continuation\.ts"/.test(source.text),
    }),
  },
  {
    // #2661 — the ONE continuation a build turn that bought nothing is allowed: the detector of the
    // two wasted shapes, its prompt, its clause and its switch. At `src/`'s top level because it is a
    // judgement over fields the caller hands in, not engine state (the `request-stall-policy.ts`
    // precedent), so its importer is under `src/lean/` and it is judged against the recursive corpus
    // like its siblings above.
    file: "build-reask.ts",
    pending: {},
    testOnly: {
      // The switch's ONE reader. No step calls it — the detector does — so only the truth table and
      // the headless-inputs registry can pin `0` as the sole off value.
      leanBuildReaskEnabled:
        "the switch's ONE reader; test-lean-build-reask-pure.ts pins the truth table and test-headless-inputs.ts pins its default",
      // The second wasted shape, named by no caller outside this module: a clean stop that acted never.
      CLEAN_STOP_REASON:
        "the literal the detector compares a no-change turn's stop reason against; test-lean-build-reask-pure.ts pins every arm of that comparison",
      // The ask's own bound, which the ask clamps to the armed budget. Read only by the ask, whose
      // bound the step-level suites drive through the seam rather than directly.
      BUILD_REASK_BOUND_MS:
        "the continuation's own bound before the armed budget clamps it; test-lean-build-reask-pure.ts pins the clamp against the literal",
      // The detector's refusal table, and which of the two shapes decided the ask.
      buildTurnWasWasted:
        "the detector; test-lean-build-reask-pure.ts pins the refusal table and the arm order",
      // The resumed child's instruction, one of two by trigger.
      buildReaskPrompt:
        "the continuation's prompt; test-lean-build-reask-pure.ts pins both shapes' text and the tokens a cut turn quotes",
      // The suffix appended LAST to the exhausted reason, which every downstream consumer clips.
      buildReaskClause:
        "the clause appended to the exhausted reason; test-lean-build-reask-pure.ts pins it inside the reason clip and test-lean-build-reask.ts pins it only on the spent-ask arm",
    },
    canary: {
      symbol: "buildTurnWasWasted",
      importer: "lean/build.ts",
    },
    locate: (source: { name: string; text: string }) => ({
      // The step that asks: the one file that reads the detector, as opposed to the ask's own file,
      // which imports only the prompt, the bound and the trigger type.
      production: source.name === "lean/build.ts",
      importsSeam: /from "\.\.\/build-reask\.ts"/.test(source.text),
    }),
  },
  {
    // #2661 — the ask itself: the continuation a wasted build turn is allowed, its refusal trace and
    // the row it bills. Top level beside the detector it serves; the step hands it the clamped bound,
    // the prompt and the row builder, so the ask takes no runtime code from the lean tree. Its one
    // production caller is `src/lean/build.ts` importing `../build-reask-child.ts`, invisible to the
    // flat top-level scan, and three smoke tests import it, so it is judged against the recursive
    // corpus like the modules above.
    file: "build-reask-child.ts",
    pending: {},
    testOnly: {
      // The ask, and the two refusals that keep a child from being paid for nothing. Reached in
      // production only by the step's spent-ask arm; the pure suite drives each arm directly.
      askBuildReask:
        "the continuation call, its seam/path refusals and its billed row; test-lean-build-reask-pure.ts (7) pins the argv, both refusals and the failed-child row, test-lean-build-reask.ts pins the arms through the real step",
    },
    canary: {
      symbol: "askBuildReask",
      importer: "lean/build.ts",
    },
    locate: (source: { name: string; text: string }) => ({
      // The step that asks. Type-only importers of this module answer false, so an `import type`
      // cannot satisfy the reachability claim.
      production: source.name === "lean/build.ts",
      importsSeam: /from "\.\.\/build-reask-child\.ts"/.test(source.text),
    }),
  },
  {
    // #2644 — the child-supervision half of the hung-request bound: the switch, the derived window,
    // the frozen arms and the inertness line. It sits at `src/`'s top level because it is spawn
    // policy, not engine state, and takes the lean reserve as a PARAMETER so it never imports the
    // lean tree. Both of its production callers are `src/lean/` files — `step-budget.ts` arms the
    // lever, `lean-step-bound.ts`'s `stepDispatchArms` supplies the reserve, the deadline and the
    // step's start — so the flat
    // top-level scan that
    // the orphan check and both importer checks use cannot see them, and the module's three
    // smoke-tests importers make it look test-only. `locate` points the checks at the recursive corpus.
    file: "request-stall-policy.ts",
    pending: {},
    testOnly: {
      // The switch's ONE reader. No step calls it — `requestStallWindowMs` consults it — so only the
      // truth table can pin `0` as the sole off value.
      leanRequestStallEnabled:
        "the switch's ONE reader; test-lean-request-stall-switch.ts pins the whole truth table and test-headless-inputs.ts pins its default",
      // The disclosure the step traces when the lever armed nothing. `armBudget` forwards its args to
      // it and never inspects the answer, so only the step's own trace line can pin the four causes.
      requestStallUnarmed:
        "the inertness disclosure; test-lean-request-stall.ts (d) pins the step traces it rather than reporting a bound that held",
      // The whole minutes a verdict prints. Read only through `stallLever`, so the rounding rule a
      // handback quotes needs the direct pin.
      stallMinutes:
        "the whole minutes a stall verdict prints; test-lean-request-stall.ts (a) pins the trio's `used` against the measured silence",
      // The freeze from ms to the verdict's minutes, and the refusal of a window of 0 or less. No step
      // calls it — `armBudget` does — so the refusal is pinned directly.
      stallLever:
        "the arms the lever freezes, and the refusal of a window of 0 or less; test-lean-request-stall.ts (c) pins no-zero-timer",
      // The ONE decider of a stall, asked only by the spawn's poll: the in-flight exemption, the ms
      // window, and that nothing here reads the child's turns or tokens (the arm that did ended only
      // a child that hung before its first turn). The poll suite pins it through the real timer.
      stallBreach:
        "the poll's own stall decision — in-flight exemption, ms window, no turns/tokens reading; test-lean-request-stall-poll.ts (1)(2)(3)(8) and test-lean-request-stall-worked.ts (b4) pin it through the real poll",
      // The arithmetic from (deadline, start, reserve) to the window. `stallLever` is its only
      // production caller — a step hands over the deadline and the reserve, never a window — so the
      // clamping near the line and the no-room refusal are pinned by the direct calls.
      requestStallWindowMs:
        "the derived window: the reserve with room to spare, the remainder near the line, nothing at all with no room; test-lean-request-stall.ts (c) pins all three",
      // The ONE composer of a step's inertness line. `armBudget` is its only production caller and
      // never inspects the answer, so the join order and the both-silent `undefined` need the direct pin.
      inertWarning:
        "the join of the two inertness halves, and no warning at all when both are silent; test-lean-request-stall.ts (e) pins the composition directly",
    },
    canary: {
      symbol: "stallLever",
      importer: "lean/step-budget.ts",
    },
    locate: (source: { name: string; text: string }) => ({
      // The one file that ARMS the lever — it imports the module as a value and calls `stallLever`.
      // `lean-step-bound.ts` also imports it, but only for the arms' type and the reserve.
      production: source.name === "lean/step-budget.ts",
      importsSeam: /from "\.\.\/request-stall-policy\.ts"/.test(source.text),
    }),
  },
  {
    // #2660 — the wall clock a lean step's CHILD may be given, read against the run's deadline.
    // Top level because it is spawn policy, not engine state, and it takes the deadline and the
    // step's start as PARAMETERS so it never imports the lean tree. Every production caller is a
    // `src/lean/` file importing `../lean-step-bound.ts`, which the flat top-level scan cannot see.
    file: "lean-step-bound.ts",
    pending: {},
    testOnly: {
      // The floor below which a deadline-derived grace stops being worth writing. Read only by
      // the derivation itself; the pair it protects is pinned by the tight-room rows of
      // test-lean-deadline-step-bound.ts (e), which build their rows FROM this constant.
      MIN_DEADLINE_GRACE_MS:
        "the derivation's own floor; test-lean-deadline-step-bound.ts (a)/(e) pin the pair it guards",
      // The sibling floor, on the kill's placement rather than the clamp's worth. Pinned by
      // literal beside its sibling in (a), which is the only reason it is exported: the two
      // are separate constants and a change to one must show up as a red assertion.
      MIN_KILL_GRACE_MS:
        "the floor a deadline-derived grace never sits below; test-lean-deadline-step-bound.ts (a) pins it by literal beside its sibling",
      // The deadline's own words, reached only through `verdictReasonClause`.
      deadlineReasonClause:
        "the clause a stopped step prints; test-lean-deadline-step-bound.ts (c) pins build's verdict, test-lean-step-deadline-bound-reasons.ts pins the other three callers",
      // The reason wrapper every stopped site calls; it composes the clause above. Each caller is
      // pinned at its own site — build by (c), challenge and both specify arms by the reasons suite
      // — so no caller is claimed on another's strength.
      verdictReasonClause:
        "the wrapper the build/challenge/specify stop arms call; the reasons suite pins the clause in each site's reason",
      // Re-derives the site's bound for the reason wrapper, clock-free. Its one production caller
      // is challenge's stop arm, reached only through the reason that round prints — no case calls
      // it directly, which is why the claim names the reason rather than a call.
      stepBoundOf:
        "the arm site's bound re-read for the stop reason; pinned through the site tests' verdict text",
      // The arm sites' entry: both levers from one read of the step log.
      stepDispatchArms:
        "the single arms call every dispatching site makes; test-lean-deadline-step-bound.ts (a)/(b) pin what it hands the spawn",
      // The warning-composing wrapper around armBudget for the four engine sites.
      armsStepBudget:
        "armBudget with the outside warning; pinned by the budget warning cases in test-lean-budgets.ts",
      // The pure derivation, asked directly so the arithmetic is the case's and not the arm's.
      leanStepBound:
        "the derivation; test-lean-deadline-step-bound.ts (a)/(d)/(e) pin the clamped, inert and no-room arms",
      // The one reader of the step log behind both levers; the sites call `stepDispatchArms`.
      stepChildBound:
        "the bound alone; test-lean-step-deadline-bound-off-arm.ts arms it directly to compare with the golden",
    },
    canary: { symbol: "stepDispatchArms", importer: "lean/build.ts" },
    locate: (source: { name: string; text: string }) => ({
      // The step that arms the panel-row build child: the file carrying the canary. Its siblings
      // (`challenge`, `review`, `specify`, `step-budget`) import the module too, and the type-only
      // importer must answer false here or an `import type` would satisfy a reachability claim.
      production: source.name === "lean/build.ts",
      importsSeam: /from "\.\.\/lean-step-bound\.ts"/.test(source.text),
    }),
  },
];
