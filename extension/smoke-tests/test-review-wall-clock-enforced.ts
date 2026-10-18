#!/usr/bin/env bun
/**
 * #1416 — the 90-minute review-loop cap is ENFORCED, not just printed.
 *
 * Measured on janit/tehas cycle 261-261016-054337: the status line carried the
 * budget every second (`cap 93m21s/90m` … `cap 100m11s/90m`) and the driver
 * never acted on it. The stream keeps ticking ten minutes past its own limit
 * and stops only when the operator quits Pi — `session_shutdown … aborted 2
 * in-flight async jobs — work-driver, developer:lens-fix-1`. No `cap-hit`
 * anywhere, no handoff, `cycle.json` records `"cap": null, "capReason": null`.
 *
 * The cause was structural: the only check (`appendReviewCapHit`) runs after a
 * lens review has RETURNED, and the lens-fix step — the dispatch that actually
 * burned the 100 minutes — checked nothing at all. So every assertion here
 * drives the real `runLensFix` and inspects what it emits / what it hands the
 * dispatch, rather than feeding `nextStep` a fabricated state.
 */

import { execFile } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import type { DispatchResult } from "../src/types.ts";
import type { DriverContext } from "../src/work-driver-context.ts";
import {
  MIN_FIX_DISPATCH_MS,
  parkLensFixOverrun,
  reviewElapsedMs,
  reviewFixDispatchBoundMs,
  reviewLoopActive,
} from "../src/work-driver-lens-fix-budget.ts";
import { runLensFix } from "../src/work-driver-lens-fix.ts";
import { createEmitSink } from "../src/work-state-emit.ts";
import { appendEvent } from "../src/workflow-state-update.ts";
import { type WorkState, initialState } from "../src/workflow-state.ts";

const execFileP = promisify(execFile);

let exit = 0;
function assert(cond: boolean, msg: string) {
  if (cond) console.log(`✓ ${msg}`);
  else {
    console.error(`✗ ${msg}`);
    exit = 1;
  }
}

const MIN = 60_000;
const CAP = 90 * MIN;
/** Fixed epoch for the pure-arithmetic block; a live Date.now() drifts across
 *  assertions and turns an exact `=== undefined` into a flake. */
const NOW = 1_800_000_000_000;
const git = (cwd: string, args: string[]) =>
  execFileP("git", ["-c", "user.email=t@t", "-c", "user.name=t", ...args], { cwd });

/** A repo on a feature branch with one commit, so the reposition gate reports
 *  `already-at-tip` and runLensFix reaches its dispatch. */
async function fixture(name: string): Promise<{ repo: string; branch: string }> {
  const repo = mkdtempSync(path.join(tmpdir(), `pi-ens-1416-${name}-`));
  writeFileSync(path.join(repo, "a.txt"), "base\n");
  await git(repo, ["init", "-q", "--initial-branch=main"]);
  await git(repo, ["add", "a.txt"]);
  await git(repo, ["commit", "-qm", "base"]);
  await git(repo, ["update-ref", "refs/remotes/origin/main", "HEAD"]);
  await git(repo, ["symbolic-ref", "refs/remotes/origin/HEAD", "refs/remotes/origin/main"]);
  const branch = "feature/issue-1416";
  await git(repo, ["checkout", "-qb", branch]);
  writeFileSync(path.join(repo, "b.txt"), "feature\n");
  await git(repo, ["add", "b.txt"]);
  await git(repo, ["commit", "-qm", "feature"]);
  await git(repo, ["update-ref", `refs/remotes/origin/${branch}`, "HEAD"]);
  return { repo, branch };
}

function stateFor(repo: string, branch: string, reviewCapStartedAt: number): WorkState {
  let s = initialState(1416);
  s = {
    ...s,
    pipelineState: {
      ...s.pipelineState,
      currentStep: "lens-fix",
      lastCompletedStep: "lens-review",
      worktrees: { default: repo },
      branchName: branch,
      prNumber: 14160,
      reviewRound: 1,
      reviewCapStartedAt,
    },
  };
  return appendEvent(s, {
    kind: "lens-issues-found",
    at: Date.now(),
    jobId: "j-1",
    round: 1,
    findings: JSON.stringify([{ severity: "MEDIUM", path: "b.txt", title: "naming drift" }]),
    verdict: "ISSUES_FOUND",
  });
}

function ctxFor(repo: string, onDispatch: (opts?: { timeoutMs?: number }) => void): DriverContext {
  return {
    // notifyAgent sends the park notification through sendUserMessage — the
    // same shape the rest of the driver tests stub (see #408: it must always
    // carry deliverAs: "steer", so a stub records rather than throws).
    host: { sendUserMessage: (text: unknown) => notices.push(String(text)) } as never,
    repoRoot: repo,
    issue: 1416,
    emitSink: createEmitSink(() => undefined),
    // The dispatch records the bound it was handed and returns an ok reply —
    // no child is ever spawned (the offline suite forbids live spawns).
    dispatchFn: (async (_pi: unknown, _spec: unknown, opts?: { timeoutMs?: number }) => {
      onDispatch(opts);
      return {
        role: "developer",
        ok: true,
        text: "fixed",
        toolUses: [],
        ms: 1,
        exitCode: 0,
      } as DispatchResult;
    }) as never,
    issueBodyFetcherFn: async () => ({
      stdout: "title:\tmock\nstate:\tOPEN\n\nbody — non-empty so the guard does not fire",
    }),
  } as unknown as DriverContext;
}

const notices: string[] = [];

async function main() {
  process.env.PI_ENSEMBLE_VERIFY = "0";
  delete process.env.PI_ENSEMBLE_REVIEW_ENFORCE;

  // ------------------------------------------------ 1. pure bound arithmetic
  {
    const base = initialState(1416);
    const at = (elapsed: number): WorkState => ({
      ...base,
      pipelineState: {
        ...base.pipelineState,
        // Pinned to a fixed epoch so the arithmetic below is exact rather than
        // drifting by the ms consumed by the preceding assertions.
        reviewCapStartedAt: NOW - elapsed,
      },
    });
    const now = NOW;
    assert(
      reviewFixDispatchBoundMs(base, "lens-fix", now) === undefined,
      "no review clock → no bound (a cycle that never reviewed has no budget to enforce)",
    );
    const early = reviewFixDispatchBoundMs(at(20 * MIN), "lens-fix", now);
    assert(
      early !== undefined && early === CAP - 20 * MIN,
      `20m into the budget → bound to what remains, never beyond it (got ${early})`,
    );
    assert(
      reviewFixDispatchBoundMs(at(20 * MIN), "develop", now) === undefined,
      "canary: the cap does NOT leak to other steps — a develop dispatch stays uncapped",
    );
    const tight = reviewFixDispatchBoundMs(at(CAP - 10 * MIN), "lens-fix", now);
    assert(
      typeof tight === "number" && tight > 0 && tight <= 10 * MIN,
      `80m in → the fixer is bound to what remains (got ${tight})`,
    );
    assert(
      reviewFixDispatchBoundMs(at(CAP - 2 * MIN), "lens-fix", now) === undefined,
      "88m in → inside the handoff grace, so no fresh fix is started",
    );
    assert(
      reviewFixDispatchBoundMs(at(100 * MIN), "lens-fix", now) === MIN_FIX_DISPATCH_MS,
      "100m in → bounded, never unbounded (unbounded is the bug)",
    );
    assert(
      reviewFixDispatchBoundMs(at(CAP - 10 * MIN), "lens-fix", now, 30 * MIN) === 10 * MIN,
      "the cap only ever SHORTENS a dispatch the caller already bounded",
    );
    assert(
      reviewFixDispatchBoundMs(at(CAP - 10 * MIN), "lens-fix", now, 3 * MIN) === 3 * MIN,
      "…and never lengthens the caller's own bound",
    );
    assert(
      reviewLoopActive(at(MIN)) === true && reviewLoopActive(base) === false,
      "reviewLoopActive keys on the persisted clock, not the current step",
    );
    assert(reviewElapsedMs(base, now) === undefined, "reviewElapsedMs is undefined with no clock");
  }

  // ------------------------------------- 2. runLensFix: budget intact → dispatch, uncapped
  {
    const { repo, branch } = await fixture("under");
    try {
      let seen: { timeoutMs?: number } | undefined = undefined;
      const ctx = ctxFor(repo, (o) => {
        seen = o;
      });
      // 60m into a 90m budget: comfortably clear of both the MIN floor and the
      // handoff grace, so the dispatch must run under the backstop it already had.
      const nowAt = Date.now();
      const out = await runLensFix(ctx, stateFor(repo, branch, nowAt - 60 * MIN), nowAt);
      assert(
        seen !== undefined,
        "canary: with budget left the fixer IS dispatched (a cap that never dispatches is not a cap, it is a halt)",
      );
      assert(
        seen?.timeoutMs === CAP - 60 * MIN,
        `…and bound to the budget that remains (60m in → ${seen?.timeoutMs / MIN}m, expected 30m)`,
      );
      const tail = out.eventLog[out.eventLog.length - 1];
      assert(
        out.pipelineState.currentStep === "lens-fix" && tail?.kind === "dispatch-completed",
        "the fix loop continues normally (dispatch-completed tail, step unchanged)",
      );
    } finally {
      rmSync(repo, { recursive: true, force: true });
    }
  }

  // --------------------------- 3. runLensFix: budget blown → park, never dispatch
  {
    const { repo, branch } = await fixture("overrun");
    try {
      let dispatched = 0;
      const ctx = ctxFor(repo, () => {
        dispatched++;
      });
      const nowAt = Date.now();
      const out = await runLensFix(ctx, stateFor(repo, branch, nowAt - 100 * MIN), nowAt);
      const tail = out.eventLog[out.eventLog.length - 1];
      assert(dispatched === 0, "over the cap: the fixer is NEVER dispatched");
      assert(
        tail?.kind === "cap-hit" && tail.cap === "lens-review-timeout",
        `over the cap: the cycle records a lens-review-timeout cap-hit (got ${tail?.kind})`,
      );
      assert(
        tail?.kind === "cap-hit" && tail.nextStep === "handoff",
        "…routed to handoff, so the comment, label and notification run",
      );
      assert(
        tail?.kind === "cap-hit" && typeof tail.evidence === "string" && /100m/.test(tail.evidence),
        "…and the evidence names the elapsed time the operator was shown",
      );
      assert(
        out.pipelineState.currentStep === "handoff",
        "the step moves to handoff (the driver does not await a fixer it refused to start)",
      );
      assert(
        notices.some((n) => /review-loop cap|wall-clock/.test(n) && /#1416/.test(n)),
        "…and the operator is notified, which the capped-but-unenforced cycle never did",
      );
    } finally {
      rmSync(repo, { recursive: true, force: true });
    }
  }

  // --------------------------------- 4. runLensFix: close to the cap → dispatch IS bound
  {
    const { repo, branch } = await fixture("bound");
    try {
      let seen: { timeoutMs?: number } | undefined;
      const ctx = ctxFor(repo, (o) => {
        seen = o;
      });
      const nowAt = Date.now();
      await runLensFix(ctx, stateFor(repo, branch, nowAt - (CAP - 10 * MIN)), nowAt);
      assert(
        seen?.timeoutMs !== undefined && seen.timeoutMs <= 10 * MIN && seen.timeoutMs > 0,
        `80m in: the fixer IS dispatched but bound to the remaining budget (got ${seen?.timeoutMs})`,
      );
    } finally {
      rmSync(repo, { recursive: true, force: true });
    }
  }

  // ---------------------------------------- 5. escape hatch restores old behaviour
  {
    const { repo, branch } = await fixture("optout");
    try {
      process.env.PI_ENSEMBLE_REVIEW_ENFORCE = "0";
      let dispatched = 0;
      const ctx = ctxFor(repo, () => {
        dispatched++;
      });
      const nowAt = Date.now();
      const out = await runLensFix(ctx, stateFor(repo, branch, nowAt - 100 * MIN), nowAt);
      assert(dispatched === 1, "PI_ENSEMBLE_REVIEW_ENFORCE=0 dispatches as before the cap");
      const tail = out.eventLog[out.eventLog.length - 1];
      assert(
        tail?.kind === "dispatch-completed",
        "…and appends no cap-hit (the opt-out is byte-identical to the previous shape)",
      );
    } finally {
      delete process.env.PI_ENSEMBLE_REVIEW_ENFORCE;
      rmSync(repo, { recursive: true, force: true });
    }
  }

  // ---------------------------------- 6. parkLensFixOverrun is a no-op when not over
  {
    const { repo, branch } = await fixture("noop");
    try {
      const ctx = ctxFor(repo, () => undefined);
      const nowAt = Date.now();
      const st = stateFor(repo, branch, nowAt - 5 * MIN);
      const out = await parkLensFixOverrun(ctx, st, Date.now());
      assert(out === st, "under the cap the park helper returns the state untouched");
      const noClock = initialState(1416);
      assert(
        (await parkLensFixOverrun(ctx, noClock, Date.now())) === noClock,
        "no clock → no cap (a cycle that has not reviewed has no budget)",
      );
    } finally {
      rmSync(repo, { recursive: true, force: true });
    }
  }

  // ------------------------- 7. canary: a killed fixer produces the structured dispatch-failed
  //
  // The bound is only real if a child that exceeds it lands as an event the
  // router routes. buildCompletionEvent is the mapper that decides that.
  {
    const { buildCompletionEvent } = await import("../src/work-driver-merged.ts");
    const ev = await buildCompletionEvent(
      { repoRoot: "/tmp", issue: 1416 } as never,
      "lens-fix",
      "developer",
      "developer:lens-fix-1",
      {
        role: "developer",
        ok: false,
        text: "",
        toolUses: [],
        ms: 1000,
        exitCode: null,
        killCause: "timeout",
        killBudgetMs: 60_000,
      } as DispatchResult,
    );
    assert(
      ev.kind === "dispatch-failed" && ev.killCause === "timeout",
      "a fixer killed at the bound is a dispatch-failed with the structured timeout cause",
    );
    assert(
      ev.kind === "dispatch-failed" && /PI_ENSEMBLE_SPAWN_TIMEOUT_MS/.test(ev.errorTail ?? ""),
      "…naming the knob, so the operator can tell a bound kill from a crash",
    );
  }

  // ---------------- 8. canary: the develop FIX-PASS dispatch shares the same budget
  //
  // The fix loop has two dispatch sites: lens-fix, and the develop pass the
  // adversarial gate requests after a lens-fix (#1114 shape). Both print the
  // same `cap .../90m` line, so both must honour it — a cap that stops one
  // child of a two-child loop is half a cap.
  {
    const { repo, branch } = await fixture("fixpass");
    try {
      const seen: Array<{ label?: string; timeoutMs?: number }> = [];
      const mk = (state: WorkState) =>
        ({
          host: { sendUserMessage: () => undefined } as never,
          repoRoot: repo,
          issue: 1416,
          emitSink: createEmitSink(() => undefined),
          dispatchFn: (async (_pi: unknown, _spec: unknown, o?: { label?: string }) => {
            seen.push({ label: o?.label, timeoutMs: o?.timeoutMs });
            return {
              role: "developer",
              ok: true,
              text: "fixed",
              toolUses: [],
              ms: 1,
              exitCode: 0,
            } as DispatchResult;
          }) as never,
          verifyExecFn: async () => ({ stdout: "", stderr: "" }),
        }) as unknown as DriverContext;

      const passWorkstreams = {
        default: {
          id: "default",
          scope: "fix pass",
          paths: ["b.txt"],
          outOfScope: [],
          fixFindings: "MEDIUM: naming drift in b.txt",
        },
      };
      const withClock = {
        ...stateFor(repo, branch, Date.now() - (CAP - 10 * MIN)),
        pipelineState: {
          ...stateFor(repo, branch, Date.now() - (CAP - 10 * MIN)).pipelineState,
          workstreams: passWorkstreams,
        },
      };
      const { runDevelopTopological } = await import("../src/work-develop-topological.ts");
      await runDevelopTopological(
        mk(withClock),
        withClock,
        ["default"],
        passWorkstreams,
        [1416],
        (await mk(withClock)).dispatchFn as never,
        async () => ({ stdout: "", stderr: "" }) as never,
        Date.now(),
        "job-1416-fixpass",
      );
      const dev = seen.find((s) => s.label === "developer");
      assert(
        dev !== undefined && dev.timeoutMs !== undefined && dev.timeoutMs <= 10 * MIN,
        `a develop fix pass under the review clock is bound to the remaining budget (got ${dev?.timeoutMs})`,
      );

      // A first develop pass (no fixFindings) must NOT inherit the review cap.
      seen.length = 0;
      const firstPass = {
        default: { id: "default", scope: "impl", paths: ["b.txt"], outOfScope: [] },
      };
      const freshState = {
        ...initialState(1416),
        pipelineState: {
          ...initialState(1416).pipelineState,
          currentStep: "develop" as const,
          worktrees: { default: repo },
          workstreams: firstPass,
        },
      };
      await runDevelopTopological(
        mk(freshState),
        freshState,
        ["default"],
        firstPass,
        [1416],
        (await mk(freshState)).dispatchFn as never,
        async () => ({ stdout: "", stderr: "" }) as never,
        Date.now(),
        "job-1416-first",
      );
      const first = seen.find((s) => s.label === "developer");
      assert(
        first !== undefined && first.timeoutMs === undefined,
        "canary: a FIRST develop pass is untouched by the review cap (no false cap on ordinary work)",
      );
    } finally {
      rmSync(repo, { recursive: true, force: true });
    }
  }

  process.exit(exit);
}

await main();
