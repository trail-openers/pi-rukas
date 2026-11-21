/**
 * lib/lean-review-incomplete-cap-golden — the review steps the lean result cases share.
 *
 * One fixed run — `goldenLog()` below: a ready PR whose `review` step bought a fix wave and
 * then stopped with lanes unjudged, so the head-binding arm really has something to say. The
 * steps are named here rather than typed per case because the cap and the `reviewComplete`
 * field are read off the SAME record, and two cases that hand-wrote their own `review` rows
 * could disagree about what that record said.
 *
 * The two constants are one document over one fixed run — `goldenLog()` below, a ready PR
 * whose `review` step bought a fix wave and then stopped with lanes unjudged, so the
 * pre-change cap really is `awaiting-human-merge` — one with `gates` on (the shipped
 * default) and one with it off, which is the arm where BOTH switches are `0`. The test
 * prints each constant's length and marker count, so the file cannot go vacuously green on
 * an empty constant.
 *
 * Provenance, stated because it bounds what the off-arm check proves: these bytes are only
 * evidence while they come from the pre-cap build — capture them by printing
 * `JSON.stringify(leanResultDocument(run, 10).doc)` for `goldenLog()`'s run under the commit
 * before the cap landed, and NEVER re-capture them from the current off arm, which would
 * make the off-arm comparison self-referential. The ON-arm check in
 * `test-headless-work-lean-review-incomplete-cap-switch.ts` is NOT a second opinion about
 * that: it compares the on-arm document to the SAME two constants (with the cap renamed), so
 * a re-capture from the current build would keep it green too. What it does guarantee is
 * narrower and worth pinning: the two arms differ ONLY in the cap text and the one new key,
 * so a field neither switch owns cannot change on one arm alone — and it fails there with
 * both lengths in the message.
 *
 * The `*ReviewStep()` builders below are the review steps the CAP CASES share: each is one
 * answer the newest `review` step can give (stopped with lanes, pushed a wave, errored with
 * a bound, errored with a bound naming no lane, died without one, never answered, judged
 * everything), and the result test's arms table drives them through the projection so the
 * cap and `reviewComplete` are pinned per record rather than per prose.
 *
 * The log is built here from `lib/lean-result-fixture.ts` rather than borrowed from
 * `lib/lean-result-gates-fixture.ts`: this module is inside the `tsconfig.smoke-tests.json`
 * ratchet, and that fixture is not — pulling it in would land its pre-existing type-error
 * backlog in this change. The steps are the same records, written by the same `stepWith`.
 */

import type { ReviewRecord } from "../../src/lean/state-outcome-gates.ts";
import type { Outcome, Step } from "../../src/lean/state.ts";
import { CLOCK } from "./lean-engine-fixtures.ts";
import { HEAD, URL, leanLog, stepWith } from "./lean-result-fixture.ts";

/** The frozen contract the golden's `specify` step recorded. */
const FROZEN: Record<string, string> = {
  "tests/AC1-retry.test.sh": "a".repeat(64),
  "tests/AC2-backoff.test.sh": "b".repeat(64),
};

/** The same contract as the criterion record. */
const TESTS: Record<string, string[]> = {
  AC1: ["tests/AC1-retry.test.sh"],
  AC2: ["tests/AC2-backoff.test.sh"],
};

/** The full head the fixed-wave arm's review pushes with its own `integrate`. */
export const FIX_HEAD = `${"b".repeat(39)}2`;
/** The full head a genuine CI-fix round pushes AFTER the review — a commit that
 * review never judged. Distinct from every head the review record can name. */
export const CI_FIX_HEAD = `${"c".repeat(39)}3`;

/** The one fix wave the golden's review ran, with the full head it pushed. */
const WAVES = [{ wave: "fix" as const, head: FIX_HEAD }];

/** The stop the golden's review step recorded: a wave that never finished judging. */
export const GOLDEN_REVIEW_BOUND = {
  wave: "full" as const,
  unreviewedLanes: ["3 of 6 lenses unjudged"],
  reason: "review STEP stopped: minutes budget 20 exceeded (used 24)",
};

/** A `review` step whose OWN clock stopped it with lanes unjudged.
 *
 * SYNTHETIC PAIRING, stated so no reader takes it for a production shape: `kind:
 * "done"` CARRIED WITH a `reviewBound` is written by no writer — `review.ts`'s two
 * stops that let the step RETURN both hand back a `fixed` pass, and its only `done`
 * return precedes any `noteStop`, so a returned `done` carries no bound and a bound
 * reaches an outcome only beside `fixed` or `error`. The fixture is a worst-case
 * probe of the predicate (does a bound outrank a lane-less verdict), not a record a
 * run can leave behind. */
export function unjudgedReviewStep(n = 0, lanes = GOLDEN_REVIEW_BOUND.unreviewedLanes): Step {
  return stepWith(
    "review",
    {
      kind: "done",
      reason: "the step's own clock stopped it mid-wave",
      reviewBound: { ...GOLDEN_REVIEW_BOUND, unreviewedLanes: [...lanes] },
    },
    n,
  );
}

/** A `review` step that judged every lens it was bought and said so — with the judged
 * round ON THE RECORD, the way `review.ts`'s clean arm writes it: `noteRound` folds
 * pass 1 before the step returns, and no fixer was bought, so `waves` is empty and
 * `attach` still prints the `review` key. The projection refuses a record that names
 * no round, so the suite's "fully judged review" has to show one. */
export function judgedReviewStep(n = 0): Step {
  return stepWith(
    "review",
    {
      kind: "done",
      reason: "adversarial and six-lens review clean",
      review: { rounds: [{ CRITICAL: 0, HIGH: 0, MEDIUM: 0, LOW: 0 }], waves: [] },
    },
    n,
  );
}

/** A `done` review record that names no `review` at all — no round, no wave. No
 * production writer leaves one behind: `review.ts`'s only `done` return folds pass 1
 * into the tally with `noteRound` before it returns, and `attach` prints the `review`
 * key whenever a round was folded. The loader validates a `review` that is present
 * and never asks for one (`reviewRecordProblem`), so this is the probe of the shape
 * that can reach the projection by another route: a returned kind with no judged
 * round on record certifies nothing, whichever arm would otherwise read it. */
export function passNoRecordReviewStep(n = 0): Step {
  return stepWith("review", { kind: "done", reason: "adversarial and six-lens review clean" }, n);
}

/** A `fixed` review record whose `review` is present but EMPTY on both sides —
 * `rounds: []` names no judged round and `waves: []` names no head, so position is
 * the only rule left that could answer `true`, and it answers wrongly for a record
 * no lens vouches for. Same provenance as `waveNoRoundReviewStep`: the production
 * writer folds pass 1 before any return, and `attach` omits an all-empty record
 * rather than printing it — only a record from another route looks like this. */
export function emptyRecordReviewStep(n = 0): Step {
  return stepWith(
    "review",
    {
      kind: "fixed",
      reason: "adversarial and six-lens review clean on the fix",
      review: { rounds: [], waves: [] },
    },
    n,
  );
}

/** A `done` review record whose `rounds` array is present and non-empty but holds one
 * entry that is NOT a round tally — `null`, `"x"`, `7`, or a round naming one of the four
 * severities. Array-ness and length alone satisfied the projection's precondition, so each
 * of these read as a judged round and handed the host `awaiting-human-merge` with
 * `reviewComplete: true` on evidence that is not a round at all — the defect this cap
 * exists to refuse, reintroduced one level down by the precondition meant to close it. No
 * production writer leaves one behind (`review.ts` folds `roundCounts`, which always names
 * all four keys), and the loader's `reviewRecordProblem` refuses the record upstream — but
 * the precondition is the last line of defence precisely because a `Step[]` need not have
 * passed through the loader, so it asks the loader's own per-round question rather than a
 * second, weaker one of its own. */
export function malformedRoundsReviewStep(rounds: unknown[], n = 0): Step {
  return stepWith(
    "review",
    {
      kind: "done",
      reason: "adversarial and six-lens review clean",
      review: { rounds, waves: [] } as unknown as ReviewRecord,
    },
    n,
  );
}

/** A `review` step that ran one fix wave, cleared it, and RETURNED `fixed` with no
 * `reviewBound`: pass 1 judged the pre-fix head, the fixer's `integrate` pushed
 * `FIX_HEAD`, and `reviewedPass` refused the wave until the re-review had
 * `assertRangedOverTheFix` proof over it and the second adversarial pass had read the
 * fix range. Its own record therefore names the full head it certified — the head its
 * `integrate` pushed, which is the head `machine.ts` routes `review + fixed → verify
 * → publish` back through. */
export function fixedWaveReviewStep(n = 0): Step {
  return stepWith(
    "review",
    {
      kind: "fixed",
      reason: "adversarial and six-lens review clean on the fix",
      review: {
        rounds: [
          { CRITICAL: 1, HIGH: 2, MEDIUM: 0, LOW: 0 },
          { CRITICAL: 0, HIGH: 0, MEDIUM: 0, LOW: 0 },
        ],
        waves: [{ wave: "fix", head: FIX_HEAD }],
      },
    },
    n,
  );
}

/** A `fixed` review record whose `waves` name the head its `integrate` pushed while its
 * `rounds` is EMPTY — a head no lens is on record as having judged. The production
 * writer cannot produce it: `review.ts` folds pass 1 into the tally with `noteRound`
 * before either verdict is read, and its only `noteWave` sits below that fold, so every
 * wave it records stands behind a judged round. The LOADER, though, bounds `rounds`
 * from above and never asks for one (`reviewRecordProblem` accepts an empty array), so
 * a record that reaches the projection by any other route can carry a wave's head with
 * nothing vouching for it — and identity against the published head must not certify it. */
export function waveNoRoundReviewStep(n = 0): Step {
  return stepWith(
    "review",
    {
      kind: "fixed",
      reason: "adversarial and six-lens review clean on the fix",
      review: { rounds: [], waves: [{ wave: "fix", head: FIX_HEAD }] },
    },
    n,
  );
}

/** The reviewer's reproduction, whole: a ready PR at `HEAD`, a `review` that returned
 * a clean fix wave (no bound — nothing stopped it), and the re-`verify` and re-`publish`
 * that `review + fixed → verify → publish` buys for it, ending `ci` green. With
 * `ciFixRound` the pipeline goes red on the reviewed head instead and a genuine CI-fix
 * round moves the PR to `CI_FIX_HEAD` — a commit the review never judged — before its
 * own green `ci`. With `reviewStep` the case swaps the record the wave arm reads. */
export function fixedWaveLog(
  ciFixRound = false,
  reviewStep: Step = fixedWaveReviewStep(1),
): Step[] {
  const base = leanLog({ prUrl: URL, draft: false });
  const handback = base[base.length - 1];
  if (handback?.state !== "handback") {
    throw new Error("fixedWaveLog: the fixture log must end at its `handback` step");
  }
  const republish = (head: string, n: number): Step =>
    stepWith(
      "publish",
      {
        kind: "ok",
        prUrl: URL,
        draft: false,
        publishedHead: head,
        reason: `re-published PR ${URL} at ${head.slice(0, 12)}`,
      },
      n,
    );
  const extra: Step[] = [
    reviewStep,
    stepWith("verify", { kind: "green", verifiedHead: FIX_HEAD }, 1),
    republish(FIX_HEAD, 1),
  ];
  if (ciFixRound) {
    extra.push(
      stepWith("ci", { kind: "red", reason: "pipeline red on the reviewed head" }, 1),
      stepWith("build", { kind: "ok" }, 1),
      stepWith("verify", { kind: "green", verifiedHead: CI_FIX_HEAD }, 2),
      republish(CI_FIX_HEAD, 2),
    );
  }
  extra.push(stepWith("ci", { kind: "green" }, ciFixRound ? 2 : 1));
  return [...base.slice(0, -1), ...extra, handback];
}

/** A `review` step that pushed a fix wave and then stopped before the re-review ran. */
export function pushedFixReviewStep(n = 0): Step {
  return stepWith(
    "review",
    {
      kind: "fixed",
      reason: "fix wave pushed; the re-review never ran",
      reviewBound: {
        wave: "fix",
        unreviewedLanes: ["adversarial re-review"],
        reason: "review STEP stopped: minutes budget 20 exceeded (used 24)",
      },
    },
    n,
  );
}

/** A `review` step that ERRORED mid-wave but still recorded its stop, so the lanes that
 * never ran are named. The predicate reads the newest `review` step regardless of kind. */
export function erroredMidWaveReviewStep(n = 0): Step {
  return stepWith(
    "review",
    {
      kind: "error",
      reason: "reviewer child errored; the re-review never ran",
      reviewBound: {
        wave: "full",
        unreviewedLanes: ["security lens", "performance lens"],
        reason: "review STEP stopped: lens child errored",
      },
    },
    n,
  );
}

/** A `review` step that ERRORED with a bound whose lane list is EMPTY. A writer does
 * produce it: `review.ts` reads its step clock once more between pass 1 and the fix wave
 * (`if (preFix.live) handback(preFix, unjudgedLenses(review))`), and a pass 1 that judged
 * all six lenses leaves `unjudgedLenses` with nothing to name — so the stop is recorded
 * with `unreviewedLanes: []` and then THROWS, which is the outcome kind here. It is a real
 * record on a real arm (the fixer was never bought), not a loader loophole, and the
 * question it pins is whether an empty list outranks the step's own verdict: a stopped
 * review is not a finished one, whatever its lane list says. */
export function erroredEmptyLaneReviewStep(n = 0): Step {
  return stepWith(
    "review",
    {
      kind: "error",
      message: "review child errored before naming a lane",
      reviewBound: {
        wave: "full",
        unreviewedLanes: [],
        reason: "review STEP stopped: lens child errored",
      },
    },
    n,
  );
}

/** A `review` step that died by THROW having recorded nothing at all. Only ONE of the
 * review step's exit routes — its own step clock — carries a bound on the error it throws
 * (`review.ts`'s `stopped()`), so the rest (a head that moved before pass 1 was bought, a
 * child the operator's budget stopped) land here: `kind: "error"` with no `reviewBound`.
 * That silence is NOT "every lens judged", and the cap must not say it is. */
export function diedReviewStep(n = 0): Step {
  return stepWith("review", { kind: "error", message: "review child died: forge unreachable" }, n);
}

/** A `review` step the engine started and never got an answer from — no outcome at all, the
 * same crash-mid-step shape the result fixture builds for `verify`/`ci`. An unanswered
 * review is not an answered one. */
export function unansweredReviewStep(n = 0): Step {
  return {
    key: `7:review:${String(n)}`,
    state: "review",
    startedAt: 1_000 + n,
    endedAt: 2_000 + n,
  };
}

/** The review steps of one run, inserted where the engine buys them: after publish,
 * before the reporting step that closes the log. */
export function withReviews(steps: Step[], reviews: Step[]): Step[] {
  const last = steps[steps.length - 1];
  if (last?.state !== "handback") {
    throw new Error("withReviews: the fixture log must end at its `handback` step");
  }
  return [...steps.slice(0, -1), ...reviews, last];
}

/** The same log with a SECOND `publish` step AFTER the newest `review` — the shape
 * `machine.ts` produces when a CI-fix round sends the run back through build and
 * `publish` again (`publish` → `review` the first time, `publish` → `ci` once
 * `reviewDone` is set). The PR's head therefore moved AFTER the review read it, and the
 * newest `review` step — still the newest `review` — judged bytes the forge no longer
 * holds. `undecided` puts the same step where it died mid-push, recording nothing: a push
 * whose outcome nobody wrote cannot be shown to have moved nothing, so it fails closed the
 * same way. */
export function republishedAfterReview(steps: Step[], undecided = false): Step[] {
  const last = steps.length - 1;
  if (steps[last]?.state !== "handback") {
    throw new Error("republishedAfterReview: the fixture log must end at its `handback` step");
  }
  let review = -1;
  for (let i = last; i >= 0; i -= 1) {
    if (steps[i]?.state === "review") {
      review = i;
      break;
    }
  }
  if (review < 0) {
    throw new Error("republishedAfterReview: the log holds no `review` step to overtake");
  }
  const again = stepWith(
    "publish",
    {
      kind: "ok",
      prUrl: URL,
      draft: false,
      publishedHead: HEAD,
      reason: `re-published PR ${URL} at ${HEAD.slice(0, 12)}`,
    },
    steps.length,
  );
  const moved = undecided
    ? { key: again.key, state: again.state, startedAt: 1_000, endedAt: 2_000 }
    : again;
  return [...steps.slice(0, review + 1), moved, ...steps.slice(review + 1)];
}

/** The whole log the goldens were captured over. Both arms of the switch test drive THIS
 * record, so a golden and an arm can differ only in the bytes the switches own. */
export function goldenLog(): Step[] {
  const review: Outcome = {
    kind: "fixed",
    reason: "adversarial and six-lens review clean",
    review: {
      rounds: [
        { CRITICAL: 1, HIGH: 2, MEDIUM: 3, LOW: 4 },
        { CRITICAL: 0, HIGH: 0, MEDIUM: 0, LOW: 1 },
      ],
      waves: WAVES.map((w) => ({ wave: w.wave, head: w.head })),
    },
    reviewBound: { ...GOLDEN_REVIEW_BOUND },
  };
  const entries: [Step["state"], Outcome][] = [
    ["ready", { kind: "ok" }],
    ["specify", { kind: "ok", frozen: FROZEN, tests: TESTS }],
    ["build", { kind: "ok" }],
    ["verify", { kind: "green", verifiedHead: HEAD }],
    ["publish", { kind: "ok", prUrl: URL, draft: false, publishedHead: HEAD }],
    ["review", review],
    ["handback", { kind: "done", reason: "handback comment posted", posted: true }],
  ];
  let n = 0;
  return entries.map(([state, outcome]) => {
    n += 1;
    return {
      key: `7:${state}:${String(n - 1)}`,
      state,
      startedAt: CLOCK + n,
      endedAt: CLOCK + n + 1,
      outcome,
    };
  });
}
