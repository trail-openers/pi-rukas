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
    // #2644 — the child-supervision half of the hung-request bound: the switch, the derived window,
    // the frozen arms and the inertness line. It sits at `src/`'s top level because it is spawn
    // policy, not engine state, and takes the lean reserve as a PARAMETER so it never imports the
    // lean tree. Both of its production callers are `src/lean/` files — `step-budget.ts` arms the
    // lever, `request-stall.ts` supplies the reserve and the clock — so the flat top-level scan that
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
      // The arithmetic from (deadline, start, reserve) to the window. `stallLever` is its only
      // production caller — a step hands over the deadline and the reserve, never a window — so the
      // clamping near the line and the no-room refusal are pinned by the direct calls.
      requestStallWindowMs:
        "the derived window: the reserve with room to spare, the remainder near the line, nothing at all with no room; test-lean-request-stall.ts (c) pins all three",
    },
    canary: {
      symbol: "stallLever",
      importer: "lean/step-budget.ts",
    },
    locate: (source: { name: string; text: string }) => ({
      // The one file that ARMS the lever — it imports the module as a value and calls `stallLever`.
      // `lean/request-stall.ts` also imports it, but only for the arms' type and the reserve.
      production: source.name === "lean/step-budget.ts",
      importsSeam: /from "\.\.\/request-stall-policy\.ts"/.test(source.text),
    }),
  },
];
