#!/usr/bin/env bun
/**
 * #1742 / #1695 — what a REFUSED owed lens round may and may not do.
 *
 * Split out of `test-lens-fix-budget-share.ts` for the AGENTS.md §12 500-line
 * cap (same fixtures, `lib/lens-fix-budget-share-fixture.ts`). The share file
 * keeps the arithmetic (the fixer's bound, the caller ceiling, the develop fix
 * pass's park); this one owns the ROUTE the refused round takes:
 *
 *  - adversarial approved + non-critical residuals DISCLOSED to the PR ⇒ `ci`,
 *    with the disclosure fact recorded; a failed post, a CRITICAL verdict or no
 *    approval ⇒ `handoff`.
 *  - #1742 CRITICAL — the route is bound to the HEAD. The owed round is
 *    refused after a fix commit, so a verdict written against the pre-fix head
 *    licenses nothing: it parks, posts no comment and records no
 *    `lens-residuals-posted` fact for the current patch. Same when no head was
 *    recorded at all — an unprovable comparison fails closed.
 *  - A `lens-approved` after the findings supersedes them: the loop already
 *    verified that round, so its findings are not posted as unverified.
 *  - #1742 MINOR 1 — the owed round's comment and plumb row say "the re-review
 *    was refused" and name the round; they never read "Round cap".
 *
 * Offline: scripted git/gh, no model, no network.
 */

import { rmSync } from "node:fs";
import { renderResidualFindings } from "../src/work-driver-lens-cap.ts";
import { parkLensRoundNoFit } from "../src/work-driver-lens-fix-budget.ts";
import { appendEvent } from "../src/workflow-state-update.ts";
import {
  approvedEv,
  disclosureCtx,
  FINDINGS,
  HEAD_SHA,
  issuesEv,
  lensApprovedEv,
  MIN,
  OTHER_HEAD_SHA,
  reviewStateAt,
} from "./lib/lens-fix-budget-share-fixture.ts";

let exit = 0;
function assert(cond: boolean, msg: string) {
  if (cond) console.log(`✓ ${msg}`);
  else {
    console.error(`✗ ${msg}`);
    exit = 1;
  }
}

async function main() {
  process.env.PI_ENSEMBLE_VERIFY = "0";
  delete process.env.PI_ENSEMBLE_REVIEW_ENFORCE;
  delete process.env.PI_ENSEMBLE_LENS_FIX_BOUND_MS;

  // ────────────── 3. #1695 — the refused owed round routes like the round cap ──────────────
  {
    // Adversarial approved the fix, findings are non-critical, the post lands:
    // the refused round takes the round cap's `ci` route with the disclosure
    // fact recorded.
    const { ctx, repoRoot, gh, notices } = disclosureCtx();
    try {
      const base = appendEvent(
        reviewStateAt(Date.now() - 85 * MIN, HEAD_SHA),
        approvedEv,
        issuesEv("ISSUES_FOUND", HEAD_SHA),
      );
      const out = await parkLensRoundNoFit(ctx, base, Date.now());
      const tail = out.eventLog[out.eventLog.length - 1];
      assert(
        tail?.kind === "cap-hit" && tail.cap === "lens-review-timeout" && tail.nextStep === "ci",
        `an approved, disclosed, non-critical refused round routes to ci (got ${JSON.stringify({ kind: tail?.kind, nextStep: (tail as { nextStep?: string }).nextStep })})`,
      );
      assert(
        out.eventLog.some((e) => e.kind === "lens-residuals-posted"),
        "…and the disclosure fact is recorded — the ci route is the disclosed route",
      );
      assert(
        gh.some((c) => /^gh pr comment /.test(c)),
        "…the residuals were actually posted to the PR (the disclosure is the precondition, not a courtesy)",
      );
      assert(
        notices.some((n) => /carries on to CI/.test(n)),
        "…and the operator notice says which route it took and why",
      );
    } finally {
      rmSync(repoRoot, { recursive: true, force: true });
    }
  }
  {
    // A failed disclosure parks: findings silently swallowed beat nothing.
    const { ctx, repoRoot, gh } = disclosureCtx({ ghFails: "gh: HTTP 502 bad gateway" });
    try {
      const base = appendEvent(
        reviewStateAt(Date.now() - 85 * MIN, HEAD_SHA),
        approvedEv,
        issuesEv("ISSUES_FOUND", HEAD_SHA),
      );
      const out = await parkLensRoundNoFit(ctx, base, Date.now());
      const tail = out.eventLog[out.eventLog.length - 1];
      assert(
        tail?.kind === "cap-hit" && tail.nextStep === "handoff",
        "a refused round whose disclosure FAILED parks — no findings ride to CI under an unposted comment",
      );
      assert(
        !out.eventLog.some((e) => e.kind === "lens-residuals-posted"),
        "…and no disclosure fact is recorded for a comment that never landed",
      );
      assert(
        (out.pipelineState.plumbReports ?? []).some((r) =>
          /could not post them to the PR/.test(r.body),
        ),
        "…and the handoff will explain the disclosure failure to the operator",
      );
      assert(
        gh.length > 0,
        "…and the post was attempted (the failure is the scripted one, not a skip)",
      );
    } finally {
      rmSync(repoRoot, { recursive: true, force: true });
    }
  }
  {
    // CRITICAL findings never take the ci route, disclosure or not.
    const { ctx, repoRoot, gh } = disclosureCtx();
    try {
      const base = appendEvent(
        reviewStateAt(Date.now() - 85 * MIN, HEAD_SHA),
        approvedEv,
        issuesEv("CRITICAL_ISSUES_FOUND", HEAD_SHA),
      );
      const out = await parkLensRoundNoFit(ctx, base, Date.now());
      const tail = out.eventLog[out.eventLog.length - 1];
      assert(
        tail?.kind === "cap-hit" && tail.nextStep === "handoff",
        "CRITICAL_ISSUES_FOUND parks — the round being refused is the round that would have caught it",
      );
      assert(
        !gh.some((c) => /^gh pr comment/.test(c)),
        "…and no disclosure is attempted for a round that parks anyway",
      );
    } finally {
      rmSync(repoRoot, { recursive: true, force: true });
    }
  }

  // ─────── 3b. #1742 CRITICAL — an H1 verdict never licenses a route over H2 ───────
  {
    // The owed round is refused AFTER a fix commit, so the findings in hand
    // were written against the pre-fix head while the disclosure, the ready
    // gate and the merge all key on the post-fix one. Routing on them would
    // merge a head no lens ever read — so this parks, posts nothing, and
    // records no disclosure fact for the current patch.
    const { ctx, repoRoot, gh } = disclosureCtx({ headSha: OTHER_HEAD_SHA });
    try {
      const base = appendEvent(
        reviewStateAt(Date.now() - 85 * MIN, HEAD_SHA),
        approvedEv,
        issuesEv("ISSUES_FOUND", HEAD_SHA),
      );
      const out = await parkLensRoundNoFit(ctx, base, Date.now());
      const tail = out.eventLog[out.eventLog.length - 1];
      assert(
        tail?.kind === "cap-hit" && tail.cap === "lens-review-timeout" && tail.nextStep === "handoff",
        `#1742: a verdict produced on a head the branch no longer carries parks — no ci route (got ${JSON.stringify({ kind: tail?.kind, nextStep: (tail as { nextStep?: string }).nextStep })})`,
      );
      assert(
        !out.eventLog.some((e) => e.kind === "lens-residuals-posted"),
        "…and NO disclosure fact is recorded for the current patch — the ready gate must not read this as a disclosed review",
      );
      assert(
        !gh.some((c) => /^gh pr comment/.test(c)),
        "…and no comment was posted: findings that never saw this head are not disclosed as though they had",
      );
      assert(
        tail?.kind === "cap-hit" &&
          /not disclosed/.test(tail.evidence ?? "") &&
          /never verified against this head/.test(tail.evidence ?? ""),
        "…and the cap evidence says WHY, in the handoff rather than only in the trace",
      );
    } finally {
      rmSync(repoRoot, { recursive: true, force: true });
    }
  }
  {
    // No recorded head at all (a pre-#1742 state file, or a review that never
    // resolved one) is the same case: nothing proves the verdict still
    // describes the head, so nothing may be disclosed on its strength.
    const { ctx, repoRoot, gh } = disclosureCtx();
    try {
      const base = appendEvent(
        reviewStateAt(Date.now() - 85 * MIN),
        approvedEv,
        issuesEv("ISSUES_FOUND"),
      );
      const out = await parkLensRoundNoFit(ctx, base, Date.now());
      const tail = out.eventLog[out.eventLog.length - 1];
      assert(
        tail?.kind === "cap-hit" && tail.nextStep === "handoff",
        "a headless verdict fails closed to a park — an unreadable comparison is never a pass",
      );
      assert(
        !gh.some((c) => /^gh pr comment/.test(c)),
        "…and nothing is posted on an unprovable verdict",
      );
    } finally {
      rmSync(repoRoot, { recursive: true, force: true });
    }
  }
  {
    // #1774 — the verdict's OWN head is the only thing that may license the
    // route. `pipelineState.lensReviewedHead` equal to the current tip must
    // NOT vouch for a verdict that recorded no head: the stamp moves when a
    // later round reads a different head, so the fallback could pass while
    // the findings described an entirely different commit.
    const { ctx, repoRoot, gh } = disclosureCtx({ headSha: HEAD_SHA });
    try {
      const base = appendEvent(
        reviewStateAt(Date.now() - 85 * MIN, HEAD_SHA), // state-level stamp == tip
        approvedEv,
        issuesEv("ISSUES_FOUND"), // the EVENT records no head
      );
      const out = await parkLensRoundNoFit(ctx, base, Date.now());
      const tail = out.eventLog[out.eventLog.length - 1];
      assert(
        tail?.kind === "cap-hit" && tail.nextStep === "handoff",
        "#1774: a verdict with no head of its own parks even when lensReviewedHead matches the tip — the state stamp cannot vouch for a verdict that never recorded one",
      );
      assert(
        !gh.some((c) => /^gh pr comment/.test(c)),
        "…and nothing is posted on the strength of that stamp",
      );
      assert(
        tail?.kind === "cap-hit" && /no full commit head/.test(tail.evidence ?? ""),
        "…and the evidence says WHY: the verdict recorded no head to compare",
      );
    } finally {
      rmSync(repoRoot, { recursive: true, force: true });
    }
  }
  {
    // A round that came back CLEAN supersedes the earlier findings: the fix was
    // verified, and posting the older round's findings as "unverified" would
    // resurrect what the loop already resolved.
    const { ctx, repoRoot, gh } = disclosureCtx();
    try {
      const base = appendEvent(
        reviewStateAt(Date.now() - 85 * MIN, HEAD_SHA),
        approvedEv,
        issuesEv("ISSUES_FOUND", HEAD_SHA),
        lensApprovedEv(2),
      );
      const out = await parkLensRoundNoFit(ctx, base, Date.now());
      const tail = out.eventLog[out.eventLog.length - 1];
      assert(
        tail?.kind === "cap-hit" && tail.nextStep === "handoff",
        "findings a later lens-approved superseded are NOT disclosed — the loop already verified them",
      );
      assert(
        !gh.some((c) => /^gh pr comment/.test(c)),
        "…and the PR is not polluted with a resolved round's findings",
      );
    } finally {
      rmSync(repoRoot, { recursive: true, force: true });
    }
  }
  {
    // #1742 MINOR 1 — this route must not read like the round cap. The comment
    // names the round the findings came from and the budget the refusal had
    // left; the plumb report names the gate that actually refused.
    const owed = renderResidualFindings(FINDINGS, 1, "ISSUES_FOUND", undefined, {
      owedRound: true,
      budgetLeftMin: 4,
    });
    assert(
      owed.includes("The re-review of round 1's fix was refused with 4m of review") &&
        owed.includes("unverified against the current") &&
        owed.includes("Decide them before merging"),
      "the owed-round comment says the re-review was refused, names the round, and says the findings are unverified against the current head",
    );
    assert(
      !owed.includes("round cap"),
      "…and does not call this a round cap — the operator reads this line to find the gate",
    );
    const cap = renderResidualFindings(FINDINGS, 3, "ISSUES_FOUND");
    assert(
      cap.includes("findings still open at the round cap") && cap.includes("its 3-round fix loop"),
      "…while the round cap's own wording is unchanged (the existing round-cap tests ride on it)",
    );
    const { ctx, repoRoot, gh } = disclosureCtx({ ghFails: "gh: HTTP 502 bad gateway" });
    try {
      const base = appendEvent(
        reviewStateAt(Date.now() - 85 * MIN, HEAD_SHA),
        approvedEv,
        issuesEv("ISSUES_FOUND", HEAD_SHA),
      );
      const out = await parkLensRoundNoFit(ctx, base, Date.now());
      const row = (out.pipelineState.plumbReports ?? []).find((r) =>
        /could not post them to the PR/.test(r.body),
      );
      assert(
        row !== undefined &&
          row.body.startsWith("Refused lens re-review with non-critical findings:") &&
          !/^Round cap/.test(row.body),
        `and the handoff's plumb row says "Refused lens re-review", never "Round cap" (got ${JSON.stringify(row?.body?.slice(0, 48))})`,
      );
      assert(
        gh.some((c) => /^gh pr comment/.test(c)),
        "…on a route that did attempt the post (the failure is the scripted one, not a skip)",
      );
    } finally {
      rmSync(repoRoot, { recursive: true, force: true });
    }
  }

  process.exit(exit);
}

await main();
