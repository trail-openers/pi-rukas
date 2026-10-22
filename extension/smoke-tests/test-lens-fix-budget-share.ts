#!/usr/bin/env bun
/**
 * #1742 / #1644 / #1695 — a lens-fix cannot eat the review loop.
 *
 * Measured on the #1742 cycle: the lens-fix dispatch took the ENTIRE remaining
 * review budget, the owed re-review round was then refused by this module's
 * own start gate (`lens-review round 2 not started`), and the cycle capped
 * with the fix unverified. Three defects, three groups of assertions here:
 *
 *  1. #1742 — the fixer's bound is what the budget leaves MINUS the owed
 *     lens round's reserve (`lensRoundReserveMs()`, default 10 min), so a
 *     committed fix can never be dispatched by spending the re-review's floor;
 *     and one fixer is additionally capped by the caller ceiling
 *     `PI_ENSEMBLE_LENS_FIX_BOUND_MS` (45 min default).
 *  2. #1742/#1695 — a REFUSED owed round routes like the round cap when the
 *     adversarial gate approved the fix and the residuals are disclosed to
 *     the PR (`ci`), and parks (`handoff`) on CRITICAL findings, a failed
 *     disclosure, or a missing approval. The cap evidence names the refused
 *     step and `PI_ENSEMBLE_REVIEW_WALL_CLOCK_MS`.
 *  3. #1644 — the develop fix pass the adversarial gate requests is PARKED
 *     (zero dispatches) when the loop has less than `MIN_USEFUL_MS.develop`
 *     left; it used to dispatch under the 60-second floor and be killed to
 *     produce nothing.
 *
 * `PI_ENSEMBLE_REVIEW_ENFORCE=0` must stay byte-identical to the pre-cap
 * shape: no bound, no park, no cap — asserted last.
 *
 * Offline: git fixtures in tmp dirs, scripted dispatch/exec, no model, no
 * network. Fixtures live in lib/lens-fix-budget-share-fixture.ts (500-line
 * cap, AGENTS.md §12).
 */

import { rmSync } from "node:fs";
import { lensFixBoundMs } from "../src/review-budget.ts";
import {
  developFixPassFits,
  lensRoundReserveMs,
  MIN_FIX_DISPATCH_MS,
  parkLensRoundNoFit,
  reviewFixDispatchBoundMs,
} from "../src/work-driver-lens-fix-budget.ts";
import { runLensFix } from "../src/work-driver-lens-fix.ts";
import { appendEvent } from "../src/workflow-state-update.ts";
import { initialState } from "../src/workflow-state.ts";
import {
  approvedEv,
  developCtx,
  disclosureCtx,
  dispatchCtx,
  fixture,
  issuesEv,
  MIN,
  NOW,
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

  // ───────────────── 1. #1742 — the fixer's bound reserves the owed round ─────────────────
  {
    process.env.PI_ENSEMBLE_REVIEW_WALL_CLOCK_MS = String(180 * MIN);
    try {
      assert(
        lensRoundReserveMs() === 10 * MIN,
        "the reserve defaults to MIN_USEFUL_MS[lens-review] (10m)",
      );
      // 150m into a 180m budget: 30m remains. The fixer gets 30m − 10m
      // reserve, floored at the minimum, capped by nothing above it.
      const at = reviewStateAt(NOW - 150 * MIN);
      const bound = reviewFixDispatchBoundMs(at, "lens-fix", NOW, lensFixBoundMs());
      assert(
        bound === 20 * MIN,
        `the fixer's bound is the remaining budget minus the owed round's reserve (30m left → ${bound === undefined ? "unbounded" : `${bound / MIN}m`})`,
      );
      assert(
        bound !== undefined && bound <= 30 * MIN - lensRoundReserveMs(),
        "…and never spends the reserve — that is the #1742 rule",
      );
      assert(
        reviewFixDispatchBoundMs(reviewStateAt(NOW - 20 * MIN), "lens-fix", NOW) ===
          180 * MIN -
            20 * MIN -
            lensRoundReserveMs(),
        "a fixer dispatched while 160m remain is bound to 160m (the reserve is withheld, the rest is usable)",
      );
      assert(
        reviewFixDispatchBoundMs(reviewStateAt(NOW - 175 * MIN), "lens-fix", NOW) ===
          MIN_FIX_DISPATCH_MS,
        "with 5m left (under the fixer's 15m + 10m reserve) the bound floors at the minimum — and the start gate refuses it",
      );

      // The invariant the reserve exists for: after a fixer that consumes its
      // full bound, the owed round still FITS its own start gate.
      const { ctx, repoRoot } = disclosureCtx();
      try {
        const state = reviewStateAt(NOW - 150 * MIN);
        assert(
          (await parkLensRoundNoFit(ctx, state, NOW + (bound ?? 0))) === state,
          "after a fixer that ran its FULL bound, the owed lens round still starts (the budget it needs survived)",
        );
        const spent = await parkLensRoundNoFit(ctx, state, NOW + 30 * MIN);
        const tail = spent.eventLog[spent.eventLog.length - 1];
        assert(
          spent !== state &&
            tail?.kind === "cap-hit" &&
            tail.cap === "lens-review-timeout" &&
            tail.nextStep === "handoff",
          "…and once the whole budget (reserve included) is gone, the round is refused and routes to handoff with no approval to lean on",
        );
        assert(
          tail?.kind === "cap-hit" &&
            /lens-review round 2 not started/.test(tail.evidence ?? "") &&
            /PI_ENSEMBLE_REVIEW_WALL_CLOCK_MS/.test(tail.evidence ?? ""),
          "…and the evidence names the REFUSED step and the knob (#1695)",
        );
      } finally {
        rmSync(repoRoot, { recursive: true, force: true });
      }
    } finally {
      delete process.env.PI_ENSEMBLE_REVIEW_WALL_CLOCK_MS;
    }
  }

  // ─────────────── 2. #1742 — the caller ceiling: PI_ENSEMBLE_LENS_FIX_BOUND_MS ───────────────
  {
    assert(lensFixBoundMs() === 45 * MIN, "the lens-fix caller ceiling defaults to 45m");
    process.env.PI_ENSEMBLE_LENS_FIX_BOUND_MS = "1500000";
    assert(lensFixBoundMs() === 25 * MIN, "…the knob overrides it (25m)");
    process.env.PI_ENSEMBLE_LENS_FIX_BOUND_MS = "5";
    assert(lensFixBoundMs() === 45 * MIN, "…and a below-floor value falls back to the default");
    delete process.env.PI_ENSEMBLE_LENS_FIX_BOUND_MS;

    // The ceiling binds a real runLensFix dispatch: a fresh 180m budget would
    // leave 170m for the fixer; the ceiling cuts it to 45m. One fixer cannot
    // outlive the loop's memory of why it started.
    process.env.PI_ENSEMBLE_REVIEW_WALL_CLOCK_MS = String(180 * MIN);
    const { repo } = await fixture("ceiling");
    try {
      let seen: { timeoutMs?: number } | undefined;
      const ctx = dispatchCtx(repo, (o) => {
        seen = o;
      });
      const nowAt = Date.now();
      const st = reviewStateAt(nowAt);
      await runLensFix(
        ctx,
        { ...st, pipelineState: { ...st.pipelineState, worktrees: { default: repo } } },
        nowAt,
      );
      assert(
        seen?.timeoutMs === 45 * MIN,
        `runLensFix arms the dispatch at the caller ceiling when the budget leaves more (got ${seen?.timeoutMs})`,
      );
    } finally {
      delete process.env.PI_ENSEMBLE_REVIEW_WALL_CLOCK_MS;
      rmSync(repo, { recursive: true, force: true });
    }
  }

  // ────────────── 3. #1695 — the refused owed round routes like the round cap ──────────────
  {
    // Adversarial approved the fix, findings are non-critical, the post lands:
    // the refused round takes the round cap's `ci` route with the disclosure
    // fact recorded.
    const { ctx, repoRoot, gh, notices } = disclosureCtx();
    try {
      const base = appendEvent(
        reviewStateAt(Date.now() - 85 * MIN),
        approvedEv,
        issuesEv("ISSUES_FOUND"),
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
        reviewStateAt(Date.now() - 85 * MIN),
        approvedEv,
        issuesEv("ISSUES_FOUND"),
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
        reviewStateAt(Date.now() - 85 * MIN),
        approvedEv,
        issuesEv("CRITICAL_ISSUES_FOUND"),
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

  // ─────────────── 4. #1644 — the develop fix pass is parked, not dispatched ───────────────
  {
    const { repo } = await fixture("fixpass");
    try {
      const seen: Array<{ label?: string; timeoutMs?: number }> = [];
      const passWorkstreams = {
        default: {
          id: "default",
          scope: "fix pass",
          paths: ["b.txt"],
          outOfScope: [],
          fixFindings: "MEDIUM: naming drift in b.txt",
        },
      };
      // 80m into a 90m budget: 10m left, under the fix pass's 15m floor.
      const st = reviewStateAt(Date.now() - (90 * MIN - 10 * MIN));
      const withClock = {
        ...st,
        pipelineState: {
          ...st.pipelineState,
          currentStep: "develop" as const,
          worktrees: { default: repo },
          workstreams: passWorkstreams,
        },
      };
      assert(
        developFixPassFits(withClock, Date.now()) === false,
        "developFixPassFits says no: 10m left is under MIN_USEFUL_MS.develop (15m)",
      );
      const { runDevelopTopological } = await import("../src/work-develop-topological.ts");
      const ctx = developCtx(repo, seen);
      const out = await runDevelopTopological(
        ctx,
        withClock,
        ["default"],
        passWorkstreams,
        [1742],
        ctx.dispatchFn as never,
        async () => ({ stdout: "", stderr: "" }) as never,
        Date.now(),
        "job-1742-fixpass",
      );
      const tail = out.eventLog[out.eventLog.length - 1];
      assert(
        seen.filter((s) => s.label === "developer").length === 0,
        `#1644: with no budget left the fix pass dispatches NOTHING (got ${seen.length} dispatches)`,
      );
      assert(
        tail?.kind === "cap-hit" &&
          tail.cap === "lens-review-timeout" &&
          tail.nextStep === "handoff",
        `…and the step's tail is the lens-review-timeout cap routed to handoff (got ${tail?.kind})`,
      );
      assert(
        tail?.kind === "cap-hit" &&
          /develop/i.test(tail.evidence ?? "") &&
          /PI_ENSEMBLE_REVIEW_WALL_CLOCK_MS/.test(tail.evidence ?? ""),
        "…and the evidence names the refused step and the knob (#1695)",
      );
      assert(
        out.pipelineState.currentStep === "handoff",
        "…and the step moves to handoff (the fan-out short-circuits; no gates run after the cap)",
      );

      // Canary: an ORDINARY first develop pass is untouched by the gate, even
      // with the clock near the cap — the park keys on fixFindings, not on
      // develop.
      seen.length = 0;
      const firstPass = {
        default: { id: "default", scope: "impl", paths: ["b.txt"], outOfScope: [] },
      };
      const fresh = initialState(1742);
      const freshState = {
        ...fresh,
        pipelineState: {
          ...fresh.pipelineState,
          currentStep: "develop" as const,
          worktrees: { default: repo },
          workstreams: firstPass,
          reviewCapStartedAt: Date.now() - (90 * MIN - 5 * MIN),
        },
      };
      const ctx2 = developCtx(repo, seen);
      await runDevelopTopological(
        ctx2,
        freshState,
        ["default"],
        firstPass,
        [1742],
        ctx2.dispatchFn as never,
        async () => ({ stdout: "", stderr: "" }) as never,
        Date.now(),
        "job-1742-first",
      );
      const first = seen.find((s) => s.label === "developer");
      assert(
        first !== undefined,
        "canary: a FIRST develop pass dispatches anyway (the park is a fix-loop rule, not a develop rule)",
      );
    } finally {
      rmSync(repo, { recursive: true, force: true });
    }
  }

  // ─────────────── 5. ENFORCE=0 stays byte-identical to the pre-cap shape ───────────────
  {
    const { repo } = await fixture("optout");
    try {
      process.env.PI_ENSEMBLE_REVIEW_ENFORCE = "0";
      let seen: { timeoutMs?: number } | undefined;
      const ctx = dispatchCtx(repo, (o) => {
        seen = o;
      });
      const nowAt = Date.now();
      const out = await runLensFix(ctx, reviewStateAt(nowAt - 100 * MIN), nowAt);
      const tail = out.eventLog[out.eventLog.length - 1];
      assert(
        tail?.kind === "dispatch-completed" && seen !== undefined,
        "PI_ENSEMBLE_REVIEW_ENFORCE=0 dispatches as before the cap",
      );
      assert(
        seen?.timeoutMs === undefined,
        "…and the dispatch carries NO timeoutMs — the caller ceiling rides the enforcement switch and does not leak past it",
      );
      const noFit = reviewStateAt(nowAt - 100 * MIN);
      assert(
        (await parkLensRoundNoFit(ctx, noFit, nowAt)) === noFit &&
          reviewFixDispatchBoundMs(noFit, "lens-fix", nowAt) === undefined,
        "…and the pure bound is undefined and the round gate parks nothing with enforcement off",
      );
    } finally {
      delete process.env.PI_ENSEMBLE_REVIEW_ENFORCE;
      rmSync(repo, { recursive: true, force: true });
    }
  }

  process.exit(exit);
}

await main();
