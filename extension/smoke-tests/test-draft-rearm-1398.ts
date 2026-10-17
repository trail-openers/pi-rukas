#!/usr/bin/env bun
/**
 * #1398, part 1 — the draft RE-ARMS when the review runs again.
 *
 * `markDraftPrReady`'s short-circuit (`if (!draft || draft.status === "ready")
 * return current`) made `ready` permanent, so the CI loop
 * (`ci → develop → adversarial → commit-pr → lens-review → ci`) and the lens-fix
 * loop left the PR mergeable for the whole re-review — the exact window #1292
 * exists to close, reopened by every failing CI run.
 *
 * `rearmDraftForReview` fires at lens entry and puts it back, and only when all
 * three say so: the STATE says ready, the LOG says the review is being re-run,
 * and the FORGE says the PR really is mergeable. A re-arm that is needed and
 * fails HALTS the cycle rather than reviewing a mergeable PR.
 *
 * The hold/disclosure half of the same rule is in test-draft-hold-1398.ts
 * (500-line cap). Offline: fake forge, fake git, no model, no network.
 */

import { prDraftCmd, prReadyCmd } from "../src/forge-commands.ts";
import type { Forge } from "../src/forge.ts";
import { FIXED_CAPS } from "../src/headless/caps.ts";
import {
  DRAFT_REARM_CAP,
  forgeFailureReason,
  lastCapIsRearmFailure,
  rearmDraftForReview,
  recordLensResidualsPosted,
  reviewRerunPending,
} from "../src/work-driver-draft-rearm.ts";
import { validateDiscriminants } from "../src/workflow-state-validate.ts";
import type { WorkEvent, WorkState } from "../src/workflow-state.ts";
import {
  BRANCH,
  type ForgeOpts,
  PR,
  approved,
  ciFailure,
  ciLoop,
  issuesFound,
  mkAssert,
  mkCtx,
  mkCtxWithoutForge,
  mkForge,
  started,
  state,
} from "./lib/draft-rearm-fixtures.ts";

const { assert, status } = mkAssert();

// ═══════════════ 1. the command forms are the forges' real ones ═══════════════
// Verified against the installed CLI and the upstream docs, and recorded here
// so a future reader knows which source pinned which form:
//   gh   2.102.0 `pr ready --help` → "--undo Convert a pull request to draft"
//   glab docs/source/mr/update.md  → "--draft  Mark merge request as a draft"
assert(
  prDraftCmd("github", 42) === "gh pr ready 42 --undo",
  'the GitHub draft command is `gh pr ready N --undo` (gh 2.102.0 --help: "--undo Convert a pull request to draft")',
);
assert(
  prDraftCmd("gitlab", 42) === "glab mr update 42 --draft",
  'the GitLab draft command is `glab mr update N --draft` (upstream docs/source/mr/update.md: "--draft Mark merge request as a draft")',
);
assert(
  prReadyCmd("github", 42) === "gh pr ready 42" &&
    prReadyCmd("gitlab", 42) === "glab mr update 42 --ready",
  "…and the ready direction is unchanged (the re-arm is the draft direction, not a re-run of ready)",
);

// ═══════════════ 2. the re-arm fires on the loop, and only on the loop ═══════
{
  const ready = { status: "ready" as const, attempts: 1 };
  assert(
    reviewRerunPending(state(ciLoop, ready)) === true,
    "a verdict concluded before a CI loop, entering lens-review again: the review is being re-run",
  );
  assert(
    reviewRerunPending(
      state([started("commit-pr", 1), started("lens-review", 2), issuesFound(3)], ready),
    ) === true,
    "a verdict followed immediately by the current lens-review IS a re-run — the only shape where the state can read `ready` with nothing between the verdict and this step is the lens-fix route to a second round (an `approved` verdict with a `ready` draft cannot occur: nothing marks it ready)",
  );
  assert(
    reviewRerunPending(state([started("commit-pr", 1), approved(3)], ready)) === false,
    "…and a cycle that has not entered a review step at all is not a re-run",
  );
  assert(
    reviewRerunPending(
      state(
        [started("commit-pr", 1), started("lens-review", 2), approved(3), started("handoff", 4)],
        ready,
      ),
    ) === false,
    "a handoff after the verdict does NOT count as a re-run (runHandoff appends step-started itself)",
  );
  assert(
    reviewRerunPending(
      state(
        [
          started("commit-pr", 1),
          started("lens-review", 2),
          approved(3),
          started("ci", 4),
          ciFailure(5),
          started("develop", 6),
          started("lens-fix", 7),
          started("lens-review", 8),
        ],
        ready,
      ),
    ) === true,
    "…and the lens-fix loop fires it too, not only the CI loop",
  );
}

{
  // The three gates: state, log, forge.
  const cases: Array<{
    what: string;
    events: WorkEvent[];
    prDraft: WorkState["pipelineState"]["prDraft"];
    forge: ForgeOpts;
    want: string;
    drafts: boolean;
  }> = [
    {
      what: "a ready PR re-entering the review is made a draft",
      events: ciLoop,
      prDraft: { status: "ready", attempts: 1 },
      forge: { isDraft: false },
      want: "re-armed",
      drafts: true,
    },
    {
      what: "a PR the driver never marked ready is left alone",
      events: ciLoop,
      prDraft: { status: "draft" },
      forge: { isDraft: false },
      want: "no-draft-fact",
      drafts: false,
    },
    {
      what: "no draft fact at all is left alone (interactive /work, an ops PR opened ready)",
      events: ciLoop,
      prDraft: undefined,
      forge: { isDraft: false },
      want: "no-draft-fact",
      drafts: false,
    },
    {
      what: "a verdict that concluded with NO review step in progress pays nothing (the ci/merged mark points)",
      events: [
        started("commit-pr", 1),
        started("lens-review", 2),
        issuesFound(3),
        started("ci", 4),
      ],
      prDraft: { status: "ready", attempts: 1 },
      forge: { isDraft: false },
      want: "review-open",
      drafts: false,
    },
    {
      what: "the FORGE says it is already a draft — the cached ready is stale, nothing is touched",
      events: ciLoop,
      prDraft: { status: "ready", attempts: 1 },
      forge: { isDraft: true },
      want: "forge-says-draft",
      drafts: false,
    },
    {
      what: "the forge did not say — `undefined` is not evidence of a mergeable PR",
      events: ciLoop,
      prDraft: { status: "ready", attempts: 1 },
      forge: { isDraft: undefined },
      want: "draft-unknown",
      drafts: false,
    },
  ];
  for (const c of cases) {
    const { forge, calls } = mkForge(c.forge);
    const out = await rearmDraftForReview(mkCtx(forge), state(c.events, c.prDraft), Date.now());
    const got = typeof out.decision === "string" ? out.decision : JSON.stringify(out.decision);
    assert(got === c.want, `${c.what} (decision ${got}, want ${c.want})`);
    assert(
      calls.includes("draft") === c.drafts,
      `…and the draft command ${c.drafts ? "was" : "was NOT"} issued`,
    );
  }
}

{
  // Identity before command: another branch's PR is never re-armed.
  const { forge, calls } = mkForge({ isDraft: false, headRefName: "feature/someone-else" });
  const out = await rearmDraftForReview(
    mkCtx(forge),
    state(ciLoop, { status: "ready", attempts: 1 }),
    Date.now(),
  );
  assert(
    typeof out.decision === "object" && out.decision.skipped === "identity",
    `a PR whose head is another branch is not re-armed (${JSON.stringify(out.decision)})`,
  );
  assert(
    !calls.includes("draft"),
    "…and no draft command was issued for it — someone else's PR is untouched",
  );
}

{
  // A CLOSED PR (a stale number from a previous cycle) is never re-armed.
  const { forge, calls } = mkForge({ isDraft: false, state: "CLOSED" });
  const out = await rearmDraftForReview(
    mkCtx(forge),
    state(ciLoop, { status: "ready", attempts: 1 }),
    Date.now(),
  );
  assert(
    typeof out.decision === "object" && out.decision.skipped === "identity",
    "a CLOSED PR does not pass the identity gate either",
  );
  assert(!calls.includes("draft"), "…and no command runs against it");
}

{
  // An unreadable PR before any command: the cycle PROCEEDS (item 3, and the
  // adversarial's judgement that a transient `gh` blip must not park a review
  // that would otherwise run). Nothing is issued and the cached fact is not
  // rewritten — only the disclosure row is added.
  const forge = {
    forge: "github",
    prView: async () => {
      throw new Error("gh: HTTP 503 service unavailable");
    },
    prDraft: async () => assert(false, "no draft command runs on an unreadable PR"),
  } as unknown as Forge;
  const before = state(ciLoop, { status: "ready", attempts: 1 });
  const out = await rearmDraftForReview(mkCtx(forge), before, Date.now());
  assert(
    typeof out.decision === "object" && out.decision.skipped === "unreadable",
    `an unreadable PR skips (${JSON.stringify(out.decision)})`,
  );
  assert(
    out.state.pipelineState.prDraft === before.pipelineState.prDraft,
    "…and the cached draft fact is not rewritten on a read that failed",
  );
  assert(
    !lastCapIsRearmFailure(out.state),
    "…and a blip on the pre-command read does not park the cycle",
  );
}

// ═══════════════ 3. a re-arm that is needed and fails HALTS ═══════════════
for (const [raw, want] of [
  ["gh: HTTP 401 Bad credentials", "the forge refused the request (authentication or permission)"],
  [
    "GraphQL: Could not resolve to a PullRequest with the number of 42.",
    "the forge could not find the pull request",
  ],
  ["connect ETIMEDOUT 140.82.113.3:443", "the forge could not be reached (network or outage)"],
  ["something unrecognised", "the forge command failed"],
] as const) {
  assert(forgeFailureReason(raw) === want, `a failed forge call reads as "${want}"`);
  assert(
    !/401|140\.82|Bad credentials|GraphQL/.test(want),
    "…and the public reason never carries the raw text (a URL, path or token fragment stays in the trace)",
  );
}

{
  const { forge } = mkForge({ isDraft: false, draftFails: "gh: HTTP 502 bad gateway" });
  const out = await rearmDraftForReview(
    mkCtx(forge),
    state(ciLoop, { status: "ready", attempts: 1 }),
    Date.now(),
  );
  const last = out.state.eventLog[out.state.eventLog.length - 1];
  assert(
    last?.kind === "cap-hit" && last.cap === DRAFT_REARM_CAP && last.nextStep === "handoff",
    `a failed re-arm records a ${DRAFT_REARM_CAP} cap routed to handoff (got ${JSON.stringify(last)})`,
  );
  assert(
    lastCapIsRearmFailure(out.state),
    "…and the router's predicate recognises it as the last event",
  );
  assert(
    out.state.pipelineState.prDraft?.status === "ready-failed" &&
      /back to a draft failed/.test(out.state.pipelineState.prDraft?.holdReason ?? ""),
    "…the draft is held as ready-failed with the reason, so runMerged refuses and the handoff explains",
  );
  assert(
    last?.kind === "cap-hit" && /network or outage/.test(last.evidence ?? ""),
    "…the evidence carries a short public reason",
  );
  const findings = validateDiscriminants(out.state);
  assert(
    findings.length === 0,
    `…and the halted state validates clean (got ${JSON.stringify(findings)})`,
  );
}

{
  // #1398 round 2 (item 4) — the draft direction has its OWN counter, so
  // spending the ready budget never blocks a re-arm, and a re-arm never drains
  // the budget the merge needs.
  const { forge, calls } = mkForge({ isDraft: false });
  const out = await rearmDraftForReview(
    mkCtx(forge),
    // `attempts: 6` = the whole per-cycle ready budget spent (markDraftPrReady
    // would refuse a ready). The re-arm still runs and the ready count is
    // untouched, so the merge's arithmetic is exactly as it was.
    state(ciLoop, { status: "ready", attempts: 6 }),
    Date.now(),
  );
  assert(
    !lastCapIsRearmFailure(out.state) && out.state.pipelineState.prDraft?.status === "draft",
    "a re-arm is NOT bounded by the ready budget — a cycle that spent its pr ready attempts still re-arms",
  );
  assert(
    out.state.pipelineState.prDraft?.attempts === 6,
    "…and the re-arm leaves the ready counter alone (the merge's retries are not drained)",
  );
  assert(calls.includes("draft"), "…and the draft command is issued");

  // The draft bound itself: past MAX_DRAFT_REARM_ATTEMPTS the cycle parks
  // rather than keep issuing commands that have not taken.
  const spent = mkForge({ isDraft: false });
  const outSpent = await rearmDraftForReview(
    mkCtx(spent.forge),
    state(ciLoop, { status: "ready", attempts: 1, draftAttempts: 3 }),
    Date.now(),
  );
  assert(
    lastCapIsRearmFailure(outSpent.state),
    "a cycle that has spent its draft re-arm attempts parks on a named cap",
  );
  assert(!spent.calls.includes("draft"), "…and no draft command is issued past the bound");
  assert(
    /3 draft re-arm attempts/.test(outSpent.state.eventLog.at(-1)?.evidence ?? ""),
    "…and the reason names the DRAFT bound, not the ready attempts (the reason a capped cycle is handed off with)",
  );
}

{
  // A successful re-arm counts the attempt it made — on the draft counter.
  const { forge } = mkForge({ isDraft: false });
  const out = await rearmDraftForReview(
    mkCtx(forge),
    state(ciLoop, { status: "ready", attempts: 1, draftAttempts: 1 }),
    Date.now(),
  );
  assert(
    out.state.pipelineState.prDraft?.status === "draft" &&
      out.state.pipelineState.prDraft?.draftAttempts === 2 &&
      out.state.pipelineState.prDraft?.attempts === 1,
    `a successful re-arm records draft + the DRAFT attempt it spent, ready unchanged (got ${JSON.stringify(out.state.pipelineState.prDraft)})`,
  );
}

const code = status();
console.log(`\nexit ${code}`);
process.exit(code);
