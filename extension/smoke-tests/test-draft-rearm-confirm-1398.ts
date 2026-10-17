#!/usr/bin/env bun
/**
 * #1398 round 2, part 2 — a re-arm is recorded only when the FORGE confirms it,
 * and a state-write fault never masquerades as a failed review.
 *
 * Two adversarial findings live here. (1) `prDraft` exits 0 on a no-op, so the
 * command's own exit code is not evidence: the re-arm re-reads `isDraft` after
 * issuing it and refuses to record `draft` unless the forge says the PR is one.
 * (2) the two mid-step persists (the re-arm's own record, and the disclosure
 * fact) run AFTER work that succeeded, so a disk fault is traced and carried on
 * — it must not surface as `dispatch-failed` on a review that ran fine.
 *
 * Sibling of test-draft-rearm-1398.ts (500-line cap). Offline: fake forge, fake
 * git, no model, no network.
 */

import { FIXED_CAPS } from "../src/headless/caps.ts";
import { recordLensResidualsPosted } from "../src/work-driver-draft-disclosure.ts";
import { DRAFT_REARM_CAP } from "../src/work-driver-draft-rearm-hold.ts";
import { lastCapIsRearmFailure, rearmDraftForReview } from "../src/work-driver-draft-rearm.ts";

import {
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

// ═══════ item 2: the re-arm reads the forge back — the command is not evidence ═══════
{
  // The forge CLI exits 0 but the PR is still ready: the driver must not record
  // a `draft` it cannot see. This is the exact hole the module exists for,
  // moved from "the state says ready, the forge says draft" to "the command
  // says done, the forge says ready".
  const { forge, calls } = mkForge({ isDraft: false, isDraftAfterDraft: false });
  const out = await rearmDraftForReview(
    mkCtx(forge),
    state(ciLoop, { status: "ready", attempts: 1 }),
    Date.now(),
  );
  const last = out.state.eventLog[out.state.eventLog.length - 1];
  assert(
    last?.kind === "cap-hit" && last.cap === DRAFT_REARM_CAP && last.nextStep === "handoff",
    "a draft command that the forge does not confirm HALTS — no `draft` is recorded on the forge's say-so",
  );
  assert(
    /the forge did not confirm the draft conversion/.test(
      out.state.pipelineState.prDraft?.holdReason ?? "",
    ),
    "…the holdReason says the forge did not confirm the draft conversion",
  );
  assert(
    out.state.pipelineState.prDraft?.status === "ready-failed",
    "…and the status is a hold, so markDraftPrReady will not undo it and runMerged refuses",
  );
  assert(calls.includes("draft"), "…the command WAS issued — it is the confirmation that failed");
  assert(
    typeof out.decision === "object" && out.decision.halted === true,
    `…and the decision says HALTED, not skipped (${JSON.stringify(out.decision)}) — a needed re-arm that failed is not a no-op`,
  );

  // A read-back that will not answer is equally not a confirmation. The
  // command reported success, so the driver cannot tell "the forge is quiet"
  // from "the conversion did not take" — and a PR believed to be a draft that
  // is still ready is the hole this module exists to close, so it halts.
  const unknown = mkForge({ isDraft: false, isDraftAfterDraft: "unknown" });
  const out2 = await rearmDraftForReview(
    mkCtx(unknown.forge),
    state(ciLoop, { status: "ready", attempts: 1 }),
    Date.now(),
  );
  assert(
    lastCapIsRearmFailure(out2.state) &&
      /the forge did not confirm the draft conversion/.test(
        out2.state.pipelineState.prDraft?.holdReason ?? "",
      ),
    "a read-back that does not say whether the PR is a draft halts too — after a command that claimed success, an `undefined` is not a confirmation",
  );

  // The read-back itself throwing is a halt: the driver cannot record a
  // confirmation it could not read.
  const unreadable = mkForge({ isDraft: false, viewFailsAfterDraft: true });
  const out3 = await rearmDraftForReview(
    mkCtx(unreadable.forge),
    state(ciLoop, { status: "ready", attempts: 1 }),
    Date.now(),
  );
  assert(
    lastCapIsRearmFailure(out3.state) &&
      /could not be read back to confirm/.test(out3.state.pipelineState.prDraft?.holdReason ?? ""),
    "a read-back that throws halts with a reason naming the failed confirmation",
  );
}

{
  // item 8 — every halt path returns the `halted` shape; every skip returns
  // `skipped`. The two must never be conflated by the caller.
  const { forge } = mkForge({ isDraft: false, draftFails: "gh: HTTP 502 bad gateway" });
  const out = await rearmDraftForReview(
    mkCtx(forge),
    state(ciLoop, { status: "ready", attempts: 1 }),
    Date.now(),
  );
  assert(
    typeof out.decision === "object" && out.decision.halted === true,
    "a failed draft command returns { halted: true, reason }",
  );
  assert(
    typeof out.decision === "object" && "reason" in out.decision && !!out.decision.reason,
    "…with a reason the handoff prints",
  );
}

{
  // item 3 + adversarial (c) — the two declines are DIFFERENT shapes and are
  // judged differently:
  //  - `skipped: "forge"` (no forge at all): there is no command to run and no
  //    read to make, so a mergeable PR under a running review HALTS.
  //  - an unreadable view / a forge that will not say: the same forge read the
  //    pre-#1398 code already made, so a transient blip must not park the
  //    cycle — it PROCEEDS, with a plumb-report so the decline is visible.
  const cases: Array<{ what: string; ctx: DriverContext; halts: boolean; plumbs: number }> = [
    // No forge at all: no command to issue, no read to make, and no command to
    // hand the operator — the halt is the only honest answer.
    { what: "forge undetectable", ctx: mkCtxWithoutForge(), halts: true, plumbs: 1 },
    // A forge whose every call fails. `forgeForCycle` hard-overrides detection
    // with `PI_ENSEMBLE_FORGE=github`, so a forge-less host reaches the re-arm
    // as an adapter that cannot answer, not as `undefined` — same shape, and
    // the re-arm has no route around either.
    { what: "forge refuses every call", ctx: mkCtxWithoutForge(), halts: true, plumbs: 1 },
    {
      what: "identity refused (another branch's PR)",
      ctx: mkCtx(mkForge({ isDraft: false, headRefName: "feature/other" }).forge),
      halts: false,
      plumbs: 0,
    },
    {
      what: "prView unreadable",
      ctx: mkCtx(mkForge({ isDraft: false, viewFails: "gh: HTTP 503" }).forge),
      halts: false,
      plumbs: 1,
    },
    {
      what: "forge will not say isDraft",
      ctx: mkCtx(mkForge({ isDraft: undefined }).forge),
      halts: false,
      plumbs: 1,
    },
  ];
  for (const c of cases) {
    const ctx = c.ctx;
    const out = await rearmDraftForReview(
      ctx,
      state(ciLoop, { status: "ready", attempts: 1 }),
      Date.now(),
    );
    const plumbs = out.state.eventLog.filter((e) => e.kind === "plumb-report");
    const rows = out.state.pipelineState.plumbReports ?? [];
    assert(
      plumbs.length === c.plumbs && rows.length === c.plumbs,
      `${c.what}: ${c.plumbs} plumb-report(s) on both the event log and the rendered field (got ${plumbs.length}/${rows.length})`,
    );
    assert(
      lastCapIsRearmFailure(out.state) === c.halts,
      `${c.what}: the cycle ${c.halts ? "HALTS" : "proceeds"} (a transient forge blip is not a park; no forge at all is)`,
    );
    assert(
      out.state.pipelineState.prDraft?.status !== "draft",
      `…and ${c.what} never records a \`draft\` the forge did not confirm`,
    );
  }
}

{
  // #1398 adversarial (a) — a CRITICAL round is not turned into a re-arm
  // handoff: the CRITICAL hold outranks the draft, so the re-arm stands down
  // and issues no command.
  const { forge, draftIssued } = mkForge({ isDraft: false });
  const criticalEvents: WorkEvent[] = [
    started("commit-pr", 1),
    started("lens-review", 2),
    issuesFound(3, "CRITICAL_ISSUES_FOUND"),
    started("ci", 4),
    ciFailure(5),
    started("develop", 6),
    started("adversarial", 7),
    started("commit-pr", 8),
    started("lens-review", 9),
  ];
  const out = await rearmDraftForReview(
    mkCtx(forge),
    state(criticalEvents, { status: "ready", attempts: 1 }),
    Date.now(),
  );
  assert(
    !(typeof out.decision === "object" && out.decision.halted === true),
    "a CRITICAL tail does not halt the cycle on a re-arm cap",
  );
  assert(
    out.decision === "critical-hold",
    `a CRITICAL verdict with a ready draft stands the re-arm down (got ${JSON.stringify(out.decision)})`,
  );
  assert(
    draftIssued.n === 0,
    `…and no draft command is issued — the review is refused on the CRITICAL finding whatever the draft says (draftIssued ${draftIssued.n})`,
  );
  assert(
    lastCapIsRearmFailure(out.state) === false,
    "…and no draft-rearm-failed cap is manufactured for a cycle that was holding anyway",
  );
  assert(
    out.state === state(criticalEvents, { status: "ready", attempts: 1 }) ||
      out.state.pipelineState.prDraft?.status === "ready",
    "…and the state is left as it was (the ready is untouched; the hold lives in the ready gate)",
  );
}

{
  // A PR the driver itself opened ready (recordFallbackDraftFact's `ready`) is
  // documented as left alone — and a cycle with no draft fact records no plumb
  // report either: there is nothing the driver was ever holding.
  const { forge } = mkForge({ isDraft: false });
  const out = await rearmDraftForReview(mkCtx(forge), state(ciLoop, undefined), Date.now());
  assert(
    out.state.eventLog.filter((e) => e.kind === "plumb-report").length === 0,
    "a cycle with no draft fact is silent — no plumb-report for a hold the driver never took on",
  );
}

assert(
  (FIXED_CAPS as readonly string[]).includes(DRAFT_REARM_CAP),
  `the published fixed-cap vocabulary includes ${DRAFT_REARM_CAP} (a headless operator sees what the driver can emit)`,
);

// ═══════ item 7 (round 2): a state-write fault is never reported as a failed review ═══════
{
  // `recordLensResidualsPosted` persists the disclosure fact immediately, and
  // the successful re-arm persists its own record. Both run AFTER work that
  // succeeded (a lens dispatch that returned, a draft command the forge
  // confirmed), so a disk fault must be traced and carried on, not thrown —
  // a throw there turned a green review into a `dispatch-failed` event.
  const { forge, draftIssued } = mkForge({ isDraft: false });
  const ctx = mkCtx(forge) as Record<string, unknown>;
  // A scratch repoRoot that cannot be written to: persistCycle rejects.
  ctx.repoRoot = "/dev/null/impossible";
  const out = await rearmDraftForReview(
    ctx as never,
    state(ciLoop, { status: "ready", attempts: 1 }),
    Date.now(),
  );
  assert(
    out.decision === "re-armed" && out.state.pipelineState.prDraft?.status === "draft",
    `a persist failure does not undo a confirmed re-arm (decision ${JSON.stringify(out.decision)})`,
  );
  assert(
    !lastCapIsRearmFailure(out.state),
    "…and no cap is manufactured for a disk fault — the review still runs",
  );
  assert(draftIssued.n === 1, "…and the draft command was issued exactly once");

  const posted = await recordLensResidualsPosted(
    ctx as never,
    state([started("lens-review", 2), issuesFound(3)], undefined),
    {
      round: 1,
      prNumber: PR,
    },
  );
  assert(
    posted.eventLog.some((e) => e.kind === "lens-residuals-posted"),
    "the disclosure fact survives a failed persist in the returned state (the next step boundary persists it)",
  );
  assert(
    posted.pipelineState.prDraft?.findingsPosted?.length === 1,
    "…and on the state's own mirror — the ready gate can still see the disclosure",
  );
}

const code = status();
console.log(`\nexit ${code}`);
process.exit(code);
