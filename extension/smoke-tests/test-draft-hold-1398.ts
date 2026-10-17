#!/usr/bin/env bun
/**
 * #1398, part 2 — the ready is held on a disclosure FACT, not a cap name.
 *
 * `readyHoldReason` inferred "were the findings disclosed?" from which cap NAME
 * had appeared after the verdict (`round-cap` / `wall-clock` with
 * `nextStep: "handoff"`, the one route that does not disclose). That held in
 * exactly one shape: an `ISSUES_FOUND` followed by anything ELSE that stopped
 * the cycle before the disclosure — `dispatch-failed`, `verify-failed:*`, a kill
 * cause, `ci-retry` — read as "nothing to hold for", and `markDraftPrReady`
 * marked the PR ready over findings nobody ever posted.
 *
 * The rule is now positive: an `ISSUES_FOUND` may go ready only when the PR
 * itself carries the merge guard's disclosure marker for the CURRENT patch.
 * Keyed on the patch identity because a disclosed finding is not a fix — pushing
 * a fix produces a new patch the old disclosure does not describe.
 *
 * The re-arm half of the same rule is in test-draft-rearm-1398.ts (500-line
 * cap). Offline: fake forge, fake git, no model, no network.
 */

import { lensResidualsMarker } from "../src/merge-guard-round-cap.ts";
import { prCarriesDisclosure, readyHoldReason } from "../src/work-driver-draft-hold.ts";
import { markDraftPrReady } from "../src/work-driver-draft-pr.ts";
import type { WorkEvent } from "../src/workflow-state.ts";
import {
  BRANCH,
  OTHER_PATCH,
  PATCH,
  issuesFound,
  mkAssert,
  mkCtx,
  mkForge,
  posted,
  started,
  state,
} from "./lib/draft-rearm-fixtures.ts";

const { assert, status } = mkAssert();

assert(
  readyHoldReason([started("lens-review", 2), issuesFound(3, "CRITICAL_ISSUES_FOUND")]) !==
    undefined,
  "a CRITICAL verdict is still never marked ready over (unchanged by this fix)",
);

// ═══════════ THE bug: ISSUES_FOUND followed by a NON-round-cap failure ═══════
{
  const events: WorkEvent[] = [
    started("lens-review", 2),
    issuesFound(3),
    {
      kind: "dispatch-failed",
      at: 1_000_004,
      jobId: "j",
      role: "developer",
      error: "provider timeout",
    },
  ];
  assert(
    readyHoldReason(events, { patchId: PATCH, branch: BRANCH }) !== undefined,
    'an ISSUES_FOUND followed by a non-round-cap failure no longer reads as "nothing to hold for" — that was the bug',
  );
  assert(
    readyHoldReason(events) === undefined,
    "…with no patch identity it keeps the shipped (#1292) shape, so a driver that cannot compute an identity does not block a review it cannot examine",
  );
  assert(
    readyHoldReason([...events, posted(5)], { patchId: PATCH, branch: BRANCH }) === undefined,
    "…and once the disclosure fact for THIS patch exists, the hold lifts",
  );
  assert(
    readyHoldReason([...events, posted(5, OTHER_PATCH)], { patchId: PATCH, branch: BRANCH }) !==
      undefined,
    "a disclosure for a DIFFERENT patch does not license marking this patch ready (a disclosed finding is not a fix, so a fix push does not clear it)",
  );
  assert(
    readyHoldReason([...events, posted(5)], { patchId: PATCH, branch: "feature/other" }) !==
      undefined,
    "…and neither does a disclosure recorded on another branch",
  );
  const mirror = readyHoldReason(events, {
    patchId: PATCH,
    branch: BRANCH,
    findingsPosted: [{ patchId: PATCH, at: 1, round: 1 }],
  });
  assert(
    mirror === undefined,
    "…the `prDraft.findingsPosted` mirror counts on its own (the resume shape)",
  );
}

// The PR's own bytes are the last word — the marker the merge guard reads.
assert(
  prCarriesDisclosure([`body\n${lensResidualsMarker(BRANCH, PATCH)}`], BRANCH, PATCH) === true,
  "the disclosure check looks for the merge guard's own marker, so the driver never licenses a ready the guard then refuses",
);
assert(
  prCarriesDisclosure(["body with no marker"], BRANCH, PATCH) === false,
  "…a comment without the marker is not a disclosure",
);
assert(
  prCarriesDisclosure([lensResidualsMarker(BRANCH, PATCH)], undefined, PATCH) === false,
  "…and with no branch to compare against it is a hold, not a pass",
);
assert(
  prCarriesDisclosure(
    [`innocent text <!-- pi-rukas:lens-residuals branch=${BRANCH} patch=${PATCH} -->`],
    BRANCH,
    PATCH,
  ) === true,
  "the marker is matched as the renderer's own literal, so a body quoting it satisfies the check — which is why a lens TITLE reaches the post through neutraliseMarkdownField (lens-review-residuals.ts) and this is not a second line of defence",
);

{
  // markDraftPrReady end to end: an undisclosed ISSUES_FOUND is held even
  // though every forge call succeeds — the hold is the point, not a retry.
  const { forge, calls } = mkForge({ isDraft: true, comments: [] });
  const out = await markDraftPrReady(
    mkCtx(forge),
    state([started("lens-review", 2), issuesFound(3)], { status: "draft" }),
    async () => undefined,
  );
  assert(
    !calls.includes("ready"),
    "an undisclosed ISSUES_FOUND never calls pr ready, however the forge behaves",
  );
  assert(
    out.pipelineState.prDraft?.status === "draft" &&
      /never posted to the PR/.test(out.pipelineState.prDraft?.holdReason ?? ""),
    `…and the reason is recorded on the state (${out.pipelineState.prDraft?.holdReason})`,
  );
}

{
  // …and with the marker on the PR, it goes ready. The disclosure is read from
  // the PR, so a state that claims one the PR cannot show does not pass.
  const marked = mkForge({
    isDraft: true,
    comments: [`findings\n\n${lensResidualsMarker(BRANCH, PATCH)}`],
  });
  const out = await markDraftPrReady(
    mkCtx(marked.forge),
    state([started("lens-review", 2), issuesFound(3)], { status: "draft" }),
    async () => undefined,
  );
  assert(
    marked.calls.includes("ready") && out.pipelineState.prDraft?.status === "ready",
    `…but a PR that carries this patch's disclosure is marked ready (${out.pipelineState.prDraft?.status})`,
  );

  const stale = mkForge({
    isDraft: true,
    comments: [`findings\n\n${lensResidualsMarker(BRANCH, OTHER_PATCH)}`],
  });
  const out2 = await markDraftPrReady(
    mkCtx(stale.forge),
    state([started("lens-review", 2), issuesFound(3)], { status: "draft" }),
    async () => undefined,
  );
  assert(
    !stale.calls.includes("ready") && out2.pipelineState.prDraft?.status === "draft",
    "…and a marker for an OLDER patch holds it as a draft — the guard would refuse that merge too",
  );
}

{
  // The comment read is the source of truth, so a read that fails holds: an
  // unreadable condition is a refusal, never a pass (the merge guard's rule).
  const forge = {
    forge: "github",
    prView: async () => ({ number: 42, state: "OPEN", headRefName: BRANCH, isDraft: true }),
    prReady: async () => assert(false, "no ready is issued when the comment read fails"),
    prComments: async () => {
      throw new Error("gh: HTTP 503");
    },
  } as unknown as Parameters<typeof mkCtx>[0];
  const out = await markDraftPrReady(
    mkCtx(forge),
    state([started("lens-review", 2), issuesFound(3)], { status: "draft" }),
    async () => undefined,
  );
  assert(
    out.pipelineState.prDraft?.status === "draft",
    "a PR whose comments cannot be read stays a draft — an unreadable disclosure is not a disclosed one",
  );
}

{
  // item 5 — with NO patch identity to key on, an ISSUES_FOUND HOLDS. The
  // pre-#1398 rule (fall back to the cap-name shape) is what let
  // `dispatch-failed` / `verify-failed:*` / a kill cause after a verdict read
  // as "nothing to hold for". A driver that cannot name the patch it is
  // marking ready cannot claim that patch's findings were disclosed.
  const events: WorkEvent[] = [started("lens-review", 2), issuesFound(3)];
  assert(
    readyHoldReason(events, { failClosedWithoutPatchId: true, branch: BRANCH }) !== undefined,
    "no patch identity + ISSUES_FOUND + fail-closed ⇒ HOLD (the shipped bug was the opposite)",
  );
  assert(
    readyHoldReason(events, {
      failClosedWithoutPatchId: true,
      branch: BRANCH,
      findingsPosted: [{ patchId: "whatever", at: 1, round: 1 }],
    }) !== undefined,
    "…a disclosure fact for an UNKNOWN patch does not lift it — with no identity there is nothing to match it against",
  );
  assert(
    readyHoldReason([...events, posted(5)], { patchId: PATCH, branch: BRANCH }) === undefined,
    "…with an identity and its disclosure, the ready is still allowed (the hold is not a blanket refusal)",
  );
  {
    // End to end: the ready path itself fails closed when git cannot compute
    // the identity (no remote, no mainline, an unreadable merge-base).
    const { forge, calls } = mkForge({ isDraft: true, comments: ["nothing here"] });
    const noIdentity = mkCtx(forge) as Record<string, unknown>;
    noIdentity.verifyExecFn = (async (cmd: string) => {
      // Answer the remote/config probes, then fail the merge-base: that is the
      // shape of a clone whose refs the fetch never landed.
      if (cmd.startsWith("git merge-base")) throw new Error("fatal: not something we can merge");
      return { stdout: cmd.startsWith("git symbolic-ref") ? "main\n" : "" };
    }) as never;
    const out = await markDraftPrReady(
      noIdentity as never,
      state([started("lens-review", 2), issuesFound(3)], { status: "draft" }),
      async () => undefined,
    );
    assert(
      !calls.includes("ready") && out.pipelineState.prDraft?.status === "draft",
      `an uncomputable patch identity holds the PR as a draft rather than falling back to the cap-name rule (${out.pipelineState.prDraft?.holdReason})`,
    );
    assert(
      /could not be identified/.test(out.pipelineState.prDraft?.holdReason ?? ""),
      "…and the holdReason says the patch could not be identified, so the handoff does not blame the reviewer",
    );
  }
}

{
  // item 6a — a comment read that THROWS falls back to the persisted fact for
  // the same patch, and says in the holdReason that the read failed.
  const events: WorkEvent[] = [started("lens-review", 2), issuesFound(3)];
  const ok = mkForge({ isDraft: true, comments: [] });
  ok.forge.prComments = async () => {
    throw new Error("gh: HTTP 503 service unavailable");
  };
  const out = await markDraftPrReady(
    mkCtx(ok.forge),
    state(events, { status: "draft", findingsPosted: [{ patchId: PATCH, at: 1, round: 1 }] }),
    async () => undefined,
  );
  assert(
    out.pipelineState.prDraft?.status === "ready",
    `a persisted disclosure fact for the CURRENT patch survives a failed comment read (got ${out.pipelineState.prDraft?.status})`,
  );

  // …and when no such fact exists, the hold names the failed read.
  const out2 = await markDraftPrReady(
    mkCtx(ok.forge),
    state(events, { status: "draft" }),
    async () => undefined,
  );
  assert(
    out2.pipelineState.prDraft?.status === "draft" &&
      /could not be completed/.test(out2.pipelineState.prDraft?.holdReason ?? ""),
    `a failed read with no fact to fall back on holds, and the reason says the READ failed rather than blaming the reviewer (${out2.pipelineState.prDraft?.holdReason})`,
  );

  // item 6b — the comment read is SKIPPED when the fact already carries the
  // current patch: the cheaper already-verified answer, no forge round-trip.
  const counted = mkForge({ isDraft: true, comments: [] });
  const out3 = await markDraftPrReady(
    mkCtx(counted.forge),
    state(events, { status: "draft", findingsPosted: [{ patchId: PATCH, at: 1, round: 1 }] }),
    async () => undefined,
  );
  assert(
    !counted.calls.includes("comments") && out3.pipelineState.prDraft?.status === "ready",
    `…and no comment read is made at all when the fact covers the patch (calls: ${counted.calls.join(",")})`,
  );
}

const code = status();
console.log(`\nexit ${code}`);
process.exit(code);
