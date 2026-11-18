/**
 * lib/lean-review-incomplete-cap-golden — today's lean result document, frozen before the
 * `review-incomplete` cap, and the review steps the cases share.
 *
 * The off arm's promise is that `PI_ENSEMBLE_LEAN_REVIEW_INCOMPLETE_CAP=0` writes the
 * document this build wrote before the cap existed. That cannot be compared against the ON
 * arm with a key deleted: with two independent switches on the document (`gates` and this
 * one's `reviewComplete`) an arm that dropped the wrong key on both sides would still
 * compare equal to itself. So the bytes each off arm must produce are captured here, from
 * the projection BEFORE the cap existed, and
 * `test-headless-work-lean-review-incomplete-cap-switch.ts` asserts `===` against them.
 *
 * The two constants are one document over one fixed run — `goldenLog()` below, a ready PR
 * whose `review` step bought a fix wave and then stopped with lanes unjudged, so the
 * pre-change cap really is `awaiting-human-merge` — one with `gates` on (the shipped
 * default) and one with it off, which is the arm where BOTH switches are `0`. The test
 * prints each constant's length and marker count, so the file cannot go vacuously green on
 * an empty constant.
 *
 * The `*ReviewStep()` builders below are the review steps the CAP CASES share: each is one
 * answer the newest `review` step can give (stopped with lanes, pushed a wave, errored with
 * a bound, died without one, never answered, judged everything), and the result test's arms
 * table drives them through the projection so the cap and `reviewComplete` are pinned per
 * record rather than per prose.
 *
 * The log is built here from `lib/lean-result-fixture.ts` rather than borrowed from
 * `lib/lean-result-gates-fixture.ts`: this module is inside the `tsconfig.smoke-tests.json`
 * ratchet, and that fixture is not — pulling it in would land its pre-existing type-error
 * backlog in this change. The steps are the same records, written by the same `stepWith`.
 */

import type { Outcome, Step } from "../../src/lean/state.ts";
import { CLOCK } from "./lean-engine-fixtures.ts";
import { HEAD, URL, stepWith } from "./lean-result-fixture.ts";

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

/** The one fix wave the golden's review ran, with the full head it pushed. */
const WAVES = [{ wave: "fix" as const, head: `${"b".repeat(39)}2` }];

/** The stop the golden's review step recorded: a wave that never finished judging. */
export const GOLDEN_REVIEW_BOUND = {
  wave: "full" as const,
  unreviewedLanes: ["3 of 6 lenses unjudged"],
  reason: "review STEP stopped: minutes budget 20 exceeded (used 24)",
};

/** A `review` step whose OWN clock stopped it with lanes unjudged. */
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

/** A `review` step that judged every lens it was bought and said so. */
export function judgedReviewStep(n = 0): Step {
  return stepWith("review", { kind: "done", reason: "adversarial and six-lens review clean" }, n);
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

/** The pre-change document over the golden's run, `gates` ON (the shipped default).
 * Typed `string`, not the literal: the switch test's anti-vacuity guard compares the two
 * goldens for difference, and a literal-typed pair makes that comparison statically
 * always-true (TS2367), i.e. a guard that can never fail. */
export const GOLDEN_GATES_ON: string =
  '{"schemaVersion":5,"issues":[{"issue":7,"status":"handoff","stateFile":".pi/lean-state/7.json","durationMs":7,"steps":[{"step":"ready","startedAt":"2023-11-14T22:13:20.001Z","endedAt":"2023-11-14T22:13:20.002Z"},{"step":"specify","startedAt":"2023-11-14T22:13:20.002Z","endedAt":"2023-11-14T22:13:20.003Z"},{"step":"build","startedAt":"2023-11-14T22:13:20.003Z","endedAt":"2023-11-14T22:13:20.004Z"},{"step":"verify","startedAt":"2023-11-14T22:13:20.004Z","endedAt":"2023-11-14T22:13:20.005Z"},{"step":"publish","startedAt":"2023-11-14T22:13:20.005Z","endedAt":"2023-11-14T22:13:20.006Z"},{"step":"review","startedAt":"2023-11-14T22:13:20.006Z","endedAt":"2023-11-14T22:13:20.007Z"},{"step":"handback","startedAt":"2023-11-14T22:13:20.007Z","endedAt":"2023-11-14T22:13:20.008Z"}],"exitCode":10,"resumable":false,"driver":"lean","usage":{"input":0,"output":0,"cacheRead":0,"cacheWrite":0,"cost":0,"turns":0,"toolCalls":0,"toolErrors":0,"dispatches":0,"byRole":{}},"branch":"feature/issue-7-thing","prState":"ready","cap":"awaiting-human-merge","reviewBound":"review STEP stopped: minutes budget 20 exceeded (used 24); wave full; unreviewed: 3 of 6 lenses unjudged","prUrl":"https://example.test/pull/7","handoff":{"channel":"forge","marker":"<!-- pi-rukas:handoff issue=7 cap=awaiting-human-merge -->","labelApplied":false,"body":"<!-- pi-rukas:handoff issue=7 cap=awaiting-human-merge -->\\n\\nhandback comment posted"},"gates":{"specify":{"frozen":{"tests/AC1-retry.test.sh":"aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa","tests/AC2-backoff.test.sh":"bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb"},"tests":{"AC1":["tests/AC1-retry.test.sh"],"AC2":["tests/AC2-backoff.test.sh"]}},"challenge":null,"verify":[{"state":"verify","kind":"green","tiers":null,"tiersTotal":null,"criteria":null,"criteriaTotal":null}],"review":{"kind":"fixed","rounds":[{"CRITICAL":1,"HIGH":2,"MEDIUM":3,"LOW":4},{"CRITICAL":0,"HIGH":0,"MEDIUM":0,"LOW":1}],"waves":[{"wave":"fix","head":"bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb2"}],"wavesTotal":1,"reviewBound":{"wave":"full","reason":"review STEP stopped: minutes budget 20 exceeded (used 24)","unreviewedLanes":["3 of 6 lenses unjudged"],"unreviewedLanesTotal":1}},"handback":{"reason":"handback comment posted","head":"aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa1","verified":true,"unshipped":null}}}]}';

/** The pre-change document over the same run with BOTH switches at `"0"` — `string` for
 * the same reason as above. */
export const GOLDEN_GATES_OFF: string =
  '{"schemaVersion":5,"issues":[{"issue":7,"status":"handoff","stateFile":".pi/lean-state/7.json","durationMs":7,"steps":[{"step":"ready","startedAt":"2023-11-14T22:13:20.001Z","endedAt":"2023-11-14T22:13:20.002Z"},{"step":"specify","startedAt":"2023-11-14T22:13:20.002Z","endedAt":"2023-11-14T22:13:20.003Z"},{"step":"build","startedAt":"2023-11-14T22:13:20.003Z","endedAt":"2023-11-14T22:13:20.004Z"},{"step":"verify","startedAt":"2023-11-14T22:13:20.004Z","endedAt":"2023-11-14T22:13:20.005Z"},{"step":"publish","startedAt":"2023-11-14T22:13:20.005Z","endedAt":"2023-11-14T22:13:20.006Z"},{"step":"review","startedAt":"2023-11-14T22:13:20.006Z","endedAt":"2023-11-14T22:13:20.007Z"},{"step":"handback","startedAt":"2023-11-14T22:13:20.007Z","endedAt":"2023-11-14T22:13:20.008Z"}],"exitCode":10,"resumable":false,"driver":"lean","usage":{"input":0,"output":0,"cacheRead":0,"cacheWrite":0,"cost":0,"turns":0,"toolCalls":0,"toolErrors":0,"dispatches":0,"byRole":{}},"branch":"feature/issue-7-thing","prState":"ready","cap":"awaiting-human-merge","reviewBound":"review STEP stopped: minutes budget 20 exceeded (used 24); wave full; unreviewed: 3 of 6 lenses unjudged","prUrl":"https://example.test/pull/7","handoff":{"channel":"forge","marker":"<!-- pi-rukas:handoff issue=7 cap=awaiting-human-merge -->","labelApplied":false,"body":"<!-- pi-rukas:handoff issue=7 cap=awaiting-human-merge -->\\n\\nhandback comment posted"}}]}';
