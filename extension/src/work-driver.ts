/**
 * /work driver — the deterministic orchestrator for compiled /work cycles.
 *
 * Replaces PM-as-orchestrator with code-as-orchestrator for /work (and ONLY
 * /work — /research, /audit, /plan, /review, /start stay prose-driven; see
 * the plan file's command taxonomy table). The driver:
 *
 *   1. owns the step transition table (walked from `pi-prompts/work.md`),
 *   2. dispatches subagents directly via `dispatchCore()` (ownerKind:driver),
 *   3. persists every transition to `.pi/work-state/<issue>.json` via
 *      `writeState()`,
 *   4. surfaces step-level progress to the user by `pi.sendUserMessage()` —
 *      PM stays as the chat-side reporter, not the loop runner.
 *
 * ## Design axioms (from the determinism research synthesis)
 *
 * - **TS owns transitions; prose owns judgement.** The driver routes on
 *   structured-output fields produced by subagents (e.g.,
 *   `adversarial_loop` returns "APPROVED"/"ISSUES_FOUND"/"CRITICAL"). Fuzzy
 *   doctrine like "findings cluster around a theme" is decided by an
 *   @explore step-back call that returns a structured spec-element
 *   identification, not by the driver inferring themes.
 *
 * - **Driver-owned dispatch.** Every dispatch uses
 *   `dispatchCore(pi, spec, { … })` which sets `ownerKind:"driver"` so the
 *   async-jobs steer back to PM is skipped. The driver awaits the
 *   completion promise and routes the result through its own state
 *   machine. PM never sees an `[ensemble:async]` it didn't ask for.
 *
 * - **Resume-on-restart, NOT resume-of-in-flight.** v1 is observational:
 *   if the Pi process dies mid-dispatch, the driver on restart detects an
 *   orphan `dispatch-started` event in the log without a matching
 *   completion and HALTS, asking the user to inspect the worktree. Auto-
 *   replay of partial dispatches is a v2 concern (would require async-jobs
 *   to durably journal too).
 *
 * - **Cap-state lives in the work-state file.** `reviewRound` and
 *   `reviewCapStartedAt` are persisted to `pipelineState`; the driver
 *   enforces caps directly without going through the legacy
 *   `check_review_cap` tool. The tool remains for PM-driven /work cycles
 *   (PI_ENSEMBLE_WORK_DRIVER=0 fallback).
 *
 * ## Feature flag
 *
 * `PI_ENSEMBLE_WORK_DRIVER=0` bypasses the driver entirely and falls back
 * to the legacy PM-driven flow (`pi.sendUserMessage(work.md)`). Default is
 * ON in v1. See `commands.ts:registerCommands` for the dispatch.
 *
 * ## Status: skeleton
 *
 * This file is the loop scaffolding + state-machine table + a small set of
 * step implementations. The full 9-step build out (concrete step templates
 * for develop, adversarial, lens-review, lens-fix, step-back, commit-pr,
 * ci, merged + the corresponding `runStep` cases) is staged in follow-up
 * commits on the same branch. Each step's `runStep` case is annotated with
 * `TODO(work-driver-pr1)` where the concrete behaviour is pending so the
 * commit landing it can grep and find every gap.
 */

import { exec } from "node:child_process";
import { createHash } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { runAdversarialLoop } from "./adversarial.ts";
import { dispatchCore } from "./dispatch.ts";
import { runLensReview } from "./lens-review.ts";
import * as lifecycle from "./lifecycle-events.ts";
import { makeRunId } from "./spawn.ts";
import { trace } from "./trace.ts";
import type { DispatchResult } from "./types.ts";
import * as workWidget from "./work-widget.ts";

const execp = promisify(exec);

/**
 * Display ordinal for the user-facing "step N/9" badge in scrollback /
 * widget output. Matches the numbering in pi-prompts/work.md verbatim.
 * `plan` collapses without a dispatch but still gets a number for
 * consistency. Internal-only steps (handoff / merged / step-back) get
 * sequence numbers past 9 so the badge stays informative without lying
 * about the doctrine's named 9.
 */
import {
  type WorkEvent,
  type WorkState,
  type WorkStep,
  appendEvent,
  detectInconsistencies,
  initialState,
  readState,
  workStateDir,
  writeDispatchArtifact,
  writeState,
} from "./workflow-state.ts";

const STEP_ORDINAL: Record<string, { num: number; total: number }> = {
  explore: { num: 1, total: 9 },
  plan: { num: 2, total: 9 },
  branch: { num: 3, total: 9 },
  develop: { num: 4, total: 9 },
  adversarial: { num: 5, total: 9 },
  "commit-pr": { num: 6, total: 9 },
  "lens-review": { num: 7, total: 9 },
  "lens-fix": { num: 7, total: 9 }, // sub-step of 7
  "step-back": { num: 7, total: 9 }, // sub-step of 7
  ci: { num: 8, total: 9 },
  merged: { num: 9, total: 9 },
  handoff: { num: 9, total: 9 }, // terminal alternative to merged
};

/**
 * Threshold above which a dispatch's text payload moves to a claim-check
 * artifact file under `.pi/work-state/<issue>/<id>.txt` instead of being
 * inlined into the event-log entry. Keeps state file scans fast (the file
 * is parsed on every driver wake).
 */
const ARTIFACT_THRESHOLD_BYTES = 4_000;

/**
 * Maximum review-fix rounds before the driver halts and routes to the
 * cap-hit handoff path (Step 7g doctrine). Mirrors the 3-round limit in
 * `pi-prompts/work.md` Step 7f.6.
 */
export const MAX_REVIEW_ROUNDS = 3;

/**
 * Maximum CI retry attempts before routing to handoff. Counts ci-status:
 * failure → develop transitions; 2 means up to 3 total CI attempts (the
 * first attempt + 2 retries). Added in PR2 after issue #553's live cycle
 * spun forever in ci → develop → adversarial → lens-review → ci when no
 * PR existed for CI to watch.
 */
export const MAX_CI_RETRIES = 2;

/**
 * Wall-clock cap for the entire fix loop (lens-review → developer-fix →
 * adversarial → re-review). 90 minutes, same as legacy review-cap.ts.
 * Persisted in `pipelineState.reviewCapStartedAt` so it survives restart.
 */
export const REVIEW_WALL_CLOCK_MS = 90 * 60 * 1000;

/**
 * Per-step failure policy (PR5 halt-cascade prevention).
 *
 * Background: PR #239 driver continued past `dispatch-failed` because
 * `nextStep()` has no branch for that event kind — the linear table just
 * advanced. On lantern #553, a developer SIGTERM at 30 min cascaded into
 * 2h31m of adversarial review against partial work, then 40 min of
 * provider-timeouting handoff. ~4 hours wasted, opaque outcome.
 *
 * The fix is a routing classifier: when a step body's tail event is
 * `dispatch-failed` (or `dispatch-failed-provider`), the driver loop
 * consults this table BEFORE calling `nextStep()`:
 *
 *  - **HALT**: synthesise a cap-hit `step-failed:<step>` (or the special
 *    `developer-timeout` shape when the errorTail matches the spawn
 *    timeout marker), set `status='aborted'`, route to handoff. There
 *    is no useful downstream past a HALT failure.
 *  - **RETRY_ONCE**: re-run the same step body once. Idempotent steps
 *    (adversarial loop against a stable diff, lens-review 6-way fanout)
 *    can absorb transient provider transport errors. Second failure
 *    HALTs via the same path.
 *  - **DEGRADED_OK**: the existing fall-through to `nextStep()` is fine.
 *    Step-back (informational) and the terminal steps (handoff, merged)
 *    fit here.
 *
 * The verdict paths (adversarial-rejected → cap-hit handoff, lens
 * round-cap → handoff) are unchanged — those route correctly already.
 * This table only governs dispatch-failed at the step level.
 */
export type StepFailurePolicy = "HALT" | "RETRY_ONCE" | "DEGRADED_OK";

export const STEP_FAILURE_POLICY: Record<WorkStep, StepFailurePolicy> = {
  // No spec foundation → plan/branch/develop run blind.
  explore: "HALT",
  // No workstreams → silent regression to single-task develop without
  // out-of-scope fences (PR3 doctrine violated).
  plan: "HALT",
  // No branch → develop edits HEAD, commit-pr has nothing to push, CI
  // has nothing to watch. Was the empirical root of issue #553's first
  // run cascade.
  branch: "HALT",
  // Partial uncommitted work after SIGTERM is not adversarial-reviewable.
  // For N>1 workstreams: HALT if ANY branch failed (runDevelop's
  // Promise.allSettled aggregate is the failure signal).
  develop: "HALT",
  // Internal 3-round loop is idempotent against a stable diff; transient
  // transport is realistic. Second failure HALTs. The
  // REJECTED-after-3-rounds verdict path already routes correctly to
  // handoff via cap-hit — unchanged.
  adversarial: "RETRY_ONCE",
  // No PR → lens-review wastes hours on uncommitted work, CI retries
  // to no purpose. Was a contributing factor in the #553 spin.
  "commit-pr": "HALT",
  // 6 lens children against a stable diff are idempotent. Cannot ship
  // code that bypassed lens-review.
  "lens-review": "RETRY_ONCE",
  // Same shape as develop — partial fix work cannot meaningfully re-
  // enter adversarial→lens.
  "lens-fix": "HALT",
  // Output is informational; an empty step-back reply still produces a
  // useful handoff.
  "step-back": "DEGRADED_OK",
  // Silently marking a cycle merged when CI was never checked is the
  // worst possible outcome. Marker-missing-but-ops-ran is already
  // handled via ciRetryCount (PR2).
  ci: "HALT",
  // Must never halt the loop — IS the loop terminator. PR5 hardens
  // handoff itself via in-process gh fallback (see runHandoff).
  handoff: "DEGRADED_OK",
  // PR10: was DEGRADED_OK while runMerged was a 0ms state mutation; now
  // it actually dispatches ops to run `gh pr merge`, which CAN fail
  // (auth, branch protection, conflicts). Silently flipping status to
  // 'merged' on dispatch failure would be exactly the bug PR10 fixes
  // (the empirical /work 561/562 case: driver reported MERGED ✓ while
  // PRs sat OPEN on GitHub). HALT routes the failure through cap-hit
  // 'step-failed:merged' → handoff so the operator merges manually.
  merged: "HALT",
};

/**
 * Project-local scratch directory for ephemeral /work artefacts (diff
 * snapshots between adversarial rounds, captured screenshots, one-off
 * verification scripts, analysis outputs).
 *
 * Background: PR #239 live-tested on lantern issue #553 left 12+ dot-
 * prefixed diff files (`.pr1_r2.diff`, `.regate-1.diff`, etc.) in the
 * repo root, plus PNG screenshots, e2e scenario scripts, a 2.3 GB ELF
 * core dump, and a scratch test_string_error.rs at root. Causes:
 * agents improvised "save diff between rounds" with arbitrary names, and
 * the project's .gitignore didn't anticipate. The next /work's branch
 * step ABORTed correctly ("working tree is not clean") — but PR #239
 * lacked B3 (ABORT detection) so the abort was swallowed.
 *
 * PR2 fold-in: driver creates `<repoRoot>/tmp/issue-<N>/` on cycle
 * start, adds `tmp/` to `.git/info/exclude` (per-clone, NOT a committed
 * `.gitignore` entry — exclusion is local tooling concern, not project
 * shape), and tells every dispatched subagent via its prompt where to
 * write scratch. Convention: this path OR /tmp; never repo root, never
 * tracked dirs unless committing.
 *
 * Cleanup policy: on `merged` (success) the driver removes the dir.
 * On `handoff` or `aborted`, KEPT so the user can inspect what the
 * agents produced when something went wrong.
 */
export function scratchDir(repoRoot: string, issue: number): string {
  return path.join(repoRoot, "tmp", `issue-${issue}`);
}

/**
 * PR10 — Resolve the active-issue list for downstream steps.
 *
 * Precedence: `pipelineState.activeIssues` (the NEEDS_WORK subset
 * populated by runExplore for multi-issue cycles) → `WorkState.issues`
 * (all issues passed to /work, populated by commands.ts) →
 * `[WorkState.issue]` (legacy single-issue path; back-compat with
 * pre-PR10 state files where neither array existed).
 *
 * Every step body that needs to know "which issues are we working on
 * right now" should call this, NOT read `state.issue` directly.
 */
export function activeIssuesOf(state: WorkState): number[] {
  return state.pipelineState.activeIssues ?? state.issues ?? [state.issue];
}

/**
 * Idempotent setup: create `<repoRoot>/tmp/issue-<N>/`, ensure
 * `.git/info/exclude` contains a `/tmp/` line so the tmp tree is hidden
 * from `git status` without touching the committed `.gitignore`.
 *
 * Failure modes return silently with a trace log — the cycle can still
 * proceed; the worst case is agents continuing to write to repo root
 * (the legacy behaviour). This is best-effort hygiene, not a hard gate.
 */
export async function setupWorkspaceTmp(repoRoot: string, issue: number): Promise<string> {
  const dir = scratchDir(repoRoot, issue);
  try {
    await fs.mkdir(dir, { recursive: true });
  } catch (err) {
    trace(`work-driver: failed to mkdir scratch dir ${dir}: ${(err as Error).message}`);
  }
  // Add `/tmp/` to .git/info/exclude if absent. The leading slash anchors
  // to repo root (subdir `node_modules/tmp/` would NOT be ignored). The
  // file may not exist on fresh clones; create with the line.
  const excludeFile = path.join(repoRoot, ".git", "info", "exclude");
  try {
    let current = "";
    try {
      current = await fs.readFile(excludeFile, "utf8");
    } catch {
      /* fresh repo or no .git/info dir — handled below */
    }
    if (!/^\/tmp\/?\s*$/m.test(current)) {
      const banner = current.includes("# pi-ensemble")
        ? ""
        : "\n# pi-ensemble: scratch dir for /work cycles (see docs/troubleshooting.md)\n";
      const next = `${current.endsWith("\n") || current.length === 0 ? current : `${current}\n`}${banner}/tmp/\n`;
      // Ensure the parent directory exists; .git/info may be missing on
      // weird clones (e.g., shallow worktrees) but mkdir -p is harmless.
      await fs.mkdir(path.dirname(excludeFile), { recursive: true });
      await fs.writeFile(excludeFile, next, "utf8");
      trace(`work-driver: added /tmp/ to ${excludeFile}`);
    }
  } catch (err) {
    trace(`work-driver: failed to update ${excludeFile}: ${(err as Error).message}`);
  }
  return dir;
}

/**
 * Remove the scratch dir for a finished /work cycle. Called only on
 * `merged` (success) — handoff/aborted preserves it for inspection.
 * Silent on failure (best-effort).
 */
export async function teardownWorkspaceTmp(repoRoot: string, issue: number): Promise<void> {
  const dir = scratchDir(repoRoot, issue);
  try {
    await fs.rm(dir, { recursive: true, force: true });
    trace(`work-driver: removed scratch dir ${dir}`);
  } catch (err) {
    trace(`work-driver: failed to rm scratch dir ${dir}: ${(err as Error).message}`);
  }
}

export interface DriverContext {
  pi: ExtensionAPI;
  /** Project root (NOT a worktree). State file lives here. */
  repoRoot: string;
  /** Primary issue number — anchors state file path + branch name. For
   * multi-issue cycles this is `issues[0]`. */
  issue: number;
  /** PR10 — full list of issue numbers passed to /work. Optional for
   * back-compat; absent means single-issue (driver treats as [issue]). */
  issues?: number[];
  /**
   * Optional injection point for tests: replace dispatchCore with a fake.
   * Production callers omit this — the default is the real dispatchCore.
   */
  dispatchFn?: (
    pi: ExtensionAPI,
    spec: { role: string; prompt: string; cwd?: string },
    opts?: { label?: string; skipDeck?: boolean; timeoutMs?: number },
  ) => Promise<DispatchResult>;
  /**
   * PR11 — optional injection point for tests: replace the `gh issue view`
   * fetch in runExplore. Production callers omit this; the default
   * shells out via `execp("gh issue view <N>")`. Tests inject a fake to
   * simulate empty bodies / rejected fetches without mocking PATH.
   * Returns `{ stdout: string }` matching the execp shape.
   */
  issueBodyFetcherFn?: (issue: number, cwd: string) => Promise<{ stdout: string }>;
  /**
   * PR12 — when true, `runWorkDriver` skips `readState` and starts from
   * `initialState(issue)`. Set by `commands.ts` when the operator
   * passes `/work N --restart` to wipe a prior terminal cycle's state
   * and run fresh (e.g., after revising the issue body via /plan).
   * Branch step's existing existing-branch detection handles worktree
   * / branch leftovers at runtime; this flag only resets the driver's
   * state file. Default behaviour (omitted / false) reads the existing
   * state if present.
   */
  restart?: boolean;
  /**
   * Optional injection point for tests: replace runAdversarialLoop with a
   * fake. Production callers omit this — runAdversarial uses the real
   * orchestrator from adversarial.ts. Mirrors `dispatchFn` for symmetry.
   * Added in PR8 alongside the per-workstream adversarial fanout so the
   * smoke tests can validate fanout shape without spawning real Pi
   * children.
   */
  adversarialLoopFn?: (
    params: { diff: string; context: string; workCwd?: string },
    signal: AbortSignal,
    orchestratorJobId: string,
  ) => Promise<DispatchResult>;
  /**
   * PR17 — optional injection point for tests: replace the shell
   * executor used by verifyStepOutcome (git status / rev-list, the
   * project's verify command, gh pr view). Production callers omit
   * this; the default is `execp`. Mirrors `issueBodyFetcherFn`.
   */
  verifyExecFn?: (
    cmd: string,
    opts?: {
      cwd?: string;
      timeout?: number;
      maxBuffer?: number;
      shell?: string;
    },
  ) => Promise<{ stdout: string; stderr?: string }>;
}

/** Decide the next step from the current step + just-appended events. */
export function nextStep(state: WorkState): WorkStep | "done" {
  const ps = state.pipelineState;
  if (ps.status !== "running") return "done";
  const lastEvent = state.eventLog[state.eventLog.length - 1];

  // Terminal short-circuits.
  if (ps.currentStep === "merged" || ps.currentStep === "handoff") return "done";

  // Cap-hit routes to either handoff or step-back regardless of which step
  // emitted the cap-hit event. The driver records the next-step decision in
  // the cap-hit event itself.
  if (lastEvent?.kind === "cap-hit") return lastEvent.nextStep;

  // Adversarial verdict routes the next step.
  if (lastEvent?.kind === "adversarial-approved") {
    // The post-adversarial transition depends on what step we came FROM,
    // not what step we ARE — by the time this check fires, `currentStep`
    // has already been clobbered to "adversarial" by runAdversarial. The
    // original PR #239 read `ps.currentStep === "develop"` which was
    // always false here and silently routed every adversarial-approved to
    // lens-review, skipping commit-pr. PR2 routes on lastCompletedStep:
    //  - From "develop" → "commit-pr" (the happy path after first dev).
    //  - From "lens-fix" → "lens-review" (re-verify the fix loop).
    return ps.lastCompletedStep === "develop" ? "commit-pr" : "lens-review";
  }
  if (lastEvent?.kind === "adversarial-rejected") {
    // adversarial_loop already did 3 internal rounds and STILL rejected →
    // this is a cap-hit. The driver emits the cap-hit event in the same
    // transition; the cap-hit branch above handles routing.
    return "handoff";
  }

  // Lens-review verdict routes.
  if (lastEvent?.kind === "lens-approved") return "ci";
  if (lastEvent?.kind === "lens-issues-found") {
    if (ps.reviewRound >= MAX_REVIEW_ROUNDS) return "handoff";
    if (ps.reviewCapStartedAt && Date.now() - ps.reviewCapStartedAt > REVIEW_WALL_CLOCK_MS) {
      return "handoff";
    }
    return "lens-fix";
  }

  // Step-back completes → emit handoff with the spec analysis attached.
  if (lastEvent?.kind === "step-back-completed") return "handoff";

  // CI outcomes.
  if (lastEvent?.kind === "ci-status") {
    if (lastEvent.status === "success") return "merged";
    if (lastEvent.status === "failure") {
      // The re-fix loop. Cap at MAX_CI_RETRIES so a permanently-failing CI
      // (e.g., branch step ABORTed and no PR exists for CI to watch — see
      // issue #553) can't spin develop → adversarial → review → ci forever.
      // The runCi step body bumps ciRetryCount when it appends the
      // ci-status event; this check just routes on the post-bump value.
      if ((ps.ciRetryCount ?? 0) >= MAX_CI_RETRIES) return "handoff";
      return "develop";
    }
    // "pending" — caller decides whether to poll again; for v1 we just stay.
    return "ci";
  }

  // Linear happy-path transitions when no special event fired.
  const linear: Record<WorkStep, WorkStep> = {
    explore: "plan",
    plan: "branch",
    branch: "develop",
    develop: "adversarial",
    adversarial: "commit-pr",
    "commit-pr": "lens-review",
    "lens-review": "ci",
    "lens-fix": "adversarial",
    "step-back": "handoff",
    handoff: "handoff",
    ci: "merged",
    merged: "merged",
  };
  return linear[ps.currentStep];
}

/**
 * Run a single step end-to-end: load template (or judge inline for PM-
 * judgment-shaped steps), dispatch via `dispatchCore`, await, append
 * event(s), update pipelineState. Returns the new state. Persistence is
 * the caller's responsibility (so multi-step transitions don't double-write).
 *
 * Per-step implementations are intentionally separated rather than
 * collapsed into one big switch — each step's prompt template, role
 * selection, and event-emission logic is distinct enough that a giant
 * switch becomes harder to read than a dispatch table.
 */
async function runStep(ctx: DriverContext, state: WorkState, step: WorkStep): Promise<WorkState> {
  const now = Date.now();
  trace(`work-driver: running step "${step}" for issue ${ctx.issue}`);

  switch (step) {
    case "explore":
      return runExplore(ctx, state, now);
    case "plan":
      return runPlan(ctx, state, now);
    case "branch":
      return runBranch(ctx, state, now);
    case "develop":
      return runDevelop(ctx, state, now);
    case "adversarial":
      return runAdversarial(ctx, state, now);
    case "commit-pr":
      return runCommitPr(ctx, state, now);
    case "lens-review":
      return runLens(ctx, state, now);
    case "lens-fix":
      return runLensFix(ctx, state, now);
    case "step-back":
      return runStepBack(ctx, state, now);
    case "ci":
      return runCi(ctx, state, now);
    case "handoff":
      return runHandoff(ctx, state, now);
    case "merged":
      return runMerged(ctx, state, now);
  }
}

/**
 * Step 1 — Read the issue and project context.
 *
 * Dispatches `@explore` with a prompt that:
 *   1. runs `gh issue view N` to get the issue body,
 *   2. discovers vipune memory types and searches relevant context,
 *   3. runs codebase_memory_search_code on key concepts,
 *   4. returns a structured summary the driver stores in the event log.
 *
 * The template file lives at `pi-prompts/work/explore.md` (added in the
 * step-template commit). For the skeleton, we inline a minimal prompt so
 * the smoke test can exercise the runStep path.
 */
async function runExplore(ctx: DriverContext, state: WorkState, now: number): Promise<WorkState> {
  // Mark the step start in the log before dispatch (resume-safety).
  let next = appendEvent(
    { ...state, pipelineState: { ...state.pipelineState, currentStep: "explore" } },
    { kind: "step-started", step: "explore", at: now },
  );

  // PR10 — multi-issue: fetch + present all N issue bodies. For N=1
  // this collapses to the existing single-issue shape.
  const issues = ctx.issues ?? state.issues ?? [ctx.issue];
  const dispatch = ctx.dispatchFn ?? dispatchCore;
  const startedAt = Date.now();

  // PR13 — fetch bodies as a BARRIER before the explore dispatch (was
  // a fan-out in PR3 Pattern 1; the race caused false NEEDS_CLARIFICATION
  // cap-hits on issues with substantive bodies because the agent's
  // verdict committed before the gh fetch settled and the prompt never
  // pointed at the cached artifact path). The bodies are then inlined
  // into the explore prompt — agent has the body content directly and
  // doesn't need to read files or trust the "driver is fetching in
  // parallel" instruction. Wall-clock impact: ~1-2 s (the parallel-
  // fetch dispatch overlap was never that large).
  //
  // PR11 §C empty-body halt also moves above the dispatch — if any
  // fetch returns empty stdout, we halt BEFORE wasting tokens on the
  // explore dispatch.
  const fetchBody =
    ctx.issueBodyFetcherFn ??
    ((n: number, cwd: string) => execp(`gh issue view ${n}`, { cwd, maxBuffer: 256 * 1024 }));
  const bodySettled = await Promise.allSettled(issues.map((n) => fetchBody(n, ctx.repoRoot)));

  // PR11 — track per-issue fetch outcome. Any empty/failed body is a
  // pre-condition failure for the cycle: explore can't reliably classify
  // work that hasn't been read. Live evidence (v10r 2026-06-25 / PR #483):
  // 4 of 5 empty bodies cascaded silently into wrong-issue work landing
  // on main. Strict halt — operator gets a clear remediation message and
  // can fix gh auth / version / network before re-running.
  const emptyBodyIssues: Array<{ issue: number; reason: string }> = [];

  // PR13 — per-issue body content for inlining in the explore prompt.
  // Capped at 16 KiB per body — covers virtually every real-world issue
  // body. Larger bodies get a truncation marker pointing at the cached
  // artifact so the agent can `cat` for the rest if needed.
  const INLINE_BODY_CAP = 16 * 1024;
  const bodiesForPrompt: Array<{ issue: number; body: string; truncated: boolean }> = [];

  // Persist each issue body as a claim-check artifact (best-effort).
  // For single-issue cycles, the first body is stored under the legacy
  // "issue-body" name so back-compat readers still find it; additional
  // bodies use "issue-body-<N>" naming.
  for (let i = 0; i < issues.length; i++) {
    const n = issues[i];
    if (n === undefined) continue;
    const result = bodySettled[i];
    if (result?.status === "fulfilled") {
      const body = result.value.stdout;
      if (!body.trim()) {
        emptyBodyIssues.push({
          issue: n,
          reason:
            "gh issue view returned empty stdout (possible projectCards GraphQL deprecation, gh extension hijack, or auth lapse)",
        });
        continue;
      }
      let artifactPath: string | undefined;
      try {
        const artifactName = issues.length === 1 ? "issue-body" : `issue-body-${n}`;
        artifactPath = await writeDispatchArtifact(ctx.repoRoot, ctx.issue, artifactName, body);
        // Only set issueBodyArtifact for the PRIMARY issue (back-compat
        // path readers look for `state.pipelineState.issueBodyArtifact`).
        if (n === ctx.issue) {
          next = {
            ...next,
            pipelineState: { ...next.pipelineState, issueBodyArtifact: artifactPath },
          };
        }
      } catch (err) {
        trace(
          `work-driver: failed to persist issue-body artifact for #${n}: ${(err as Error).message}`,
        );
      }
      const truncated = body.length > INLINE_BODY_CAP;
      const inlineBody = truncated
        ? `${body.slice(0, INLINE_BODY_CAP)}\n[... truncated; full body at ${artifactPath ?? "(artifact write failed)"}]`
        : body;
      bodiesForPrompt.push({ issue: n, body: inlineBody, truncated });
    } else if (result?.status === "rejected") {
      const reason = (result.reason as Error).message?.slice(0, 200) ?? "(no error message)";
      trace(`work-driver: gh issue view ${n} failed: ${reason}`);
      emptyBodyIssues.push({ issue: n, reason: `gh issue view rejected: ${reason}` });
    }
  }

  // PR11 — halt the cycle if ANY issue body failed to fetch. Pre-condition
  // failure; the operator fixes gh and re-runs. PR13 moves this check
  // above the dispatch so we don't spend tokens on an explore that's
  // bound to halt anyway. Same routing as before.
  if (emptyBodyIssues.length > 0) {
    next = {
      ...next,
      pipelineState: { ...next.pipelineState, emptyBodyIssues },
    };
    next = appendEvent(next, {
      kind: "cap-hit",
      at: Date.now(),
      cap: "explore-bodies-empty",
      reviewRound: 0,
      nextStep: "handoff",
    });
    return next;
  }

  // PR13 — now dispatch with bodies embedded in the prompt. Verdict can
  // be sound from a single turn — no race, no agency-dependence.
  const prompt = inlineExplorePrompt(issues, scratchDir(ctx.repoRoot, ctx.issue), bodiesForPrompt);
  const dispatchSettled = await Promise.allSettled([
    dispatch(ctx.pi, { role: "explore", prompt }, { label: "explore" }),
  ]).then((arr) => arr[0]);

  if (dispatchSettled?.status === "rejected") {
    return appendEvent(next, {
      kind: "dispatch-failed",
      step: "explore",
      role: "explore",
      jobId: "unknown",
      label: "explore",
      ms: Date.now() - startedAt,
      at: Date.now(),
      errorTail: (dispatchSettled.reason as Error).message?.slice(-200),
    });
  }
  if (!dispatchSettled || dispatchSettled.status !== "fulfilled") {
    // Defensive — Promise.allSettled returns either fulfilled or rejected;
    // this branch unreachable. Synthesise a dispatch-failed so the driver
    // can route normally.
    return appendEvent(next, {
      kind: "dispatch-failed",
      step: "explore",
      role: "explore",
      jobId: "unknown",
      label: "explore",
      ms: Date.now() - startedAt,
      at: Date.now(),
      errorTail: "explore dispatch settled in an unexpected state",
    });
  }

  // dispatchSettled.value is the explore role's dispatch result
  // (single-dispatch — explore returns one report covering all issues).
  const exploreDispatch = dispatchSettled.value as DispatchResult;
  const event = await buildCompletionEvent(ctx, "explore", "explore", "explore", exploreDispatch);
  next = appendEvent(next, event);

  // PR6 + PR10 — verdict router. For N=1, the existing
  // parseExploreVerdict path is unchanged. For N>1, parse per-issue
  // verdicts and split into activeIssues (NEEDS_WORK) + droppedIssues
  // (ALREADY_COMPLETE / NEEDS_CLARIFICATION). If ALL issues are
  // dropped, synthesise an aggregate cap-hit (PR6 path); otherwise
  // continue with the activeIssues subset.
  const responseText = exploreDispatch.text ?? "";
  if (issues.length === 1) {
    const verdict = parseExploreVerdict(responseText);
    if (verdict) {
      next = {
        ...next,
        pipelineState: { ...next.pipelineState, exploreVerdict: verdict },
      };
    }
    if (verdict === "ALREADY_COMPLETE" || verdict === "NEEDS_CLARIFICATION") {
      const cap =
        verdict === "ALREADY_COMPLETE" ? "explore-already-complete" : "explore-needs-clarification";
      next = appendEvent(next, {
        kind: "cap-hit",
        at: Date.now(),
        cap,
        reviewRound: next.pipelineState.reviewRound,
        nextStep: "handoff",
      });
    }
    return next;
  }

  // N>1 path — per-issue verdicts.
  const perIssue = parsePerIssueVerdicts(responseText, issues);
  const activeIssues = perIssue.filter((p) => p.verdict === "NEEDS_WORK").map((p) => p.issue);
  const droppedIssues = perIssue.filter((p) => p.verdict !== "NEEDS_WORK");
  // Aggregate verdict for back-compat surfacing: NEEDS_WORK if any
  // active; else ALREADY_COMPLETE if every dropped is already-complete;
  // else NEEDS_CLARIFICATION.
  const aggregateVerdict: ExploreVerdict =
    activeIssues.length > 0
      ? "NEEDS_WORK"
      : droppedIssues.every((d) => d.verdict === "ALREADY_COMPLETE")
        ? "ALREADY_COMPLETE"
        : "NEEDS_CLARIFICATION";
  next = {
    ...next,
    pipelineState: {
      ...next.pipelineState,
      exploreVerdict: aggregateVerdict,
      activeIssues,
      droppedIssues,
    },
  };
  if (activeIssues.length === 0) {
    // Every issue dropped → handoff with the aggregate cap. Existing
    // PR6 routing handles both cap shapes through nextStep().
    const cap =
      aggregateVerdict === "ALREADY_COMPLETE"
        ? "explore-already-complete"
        : "explore-needs-clarification";
    next = appendEvent(next, {
      kind: "cap-hit",
      at: Date.now(),
      cap,
      reviewRound: next.pipelineState.reviewRound,
      nextStep: "handoff",
    });
  }
  return next;
}

/**
 * Step 2 — Plan / decompose into workstreams.
 *
 * PR3 restores the parallelism doctrine the PR #239 driver silently
 * dropped: the user's /work command treated "default to parallel" as a
 * first principle, exploiting up to 10 parallel slots for multi-
 * workstream issues (e.g., "fix bug X in frontend AND update docs"
 * would dispatch two developers in two worktrees concurrently).
 *
 * The decomposition prompt is cribbed from `pi-prompts/plan.md` Phase 2
 * — explore-shaped, structured output. The subagent reads the cached
 * issue body (from Step 1's `issueBodyArtifact`) plus the explore
 * report and decides whether the issue contains 1, 2, or N+
 * independent workstreams. Returns a fenced `## Workstreams` block
 * the driver parses.
 *
 * Single-workstream is `N=1` of the same code path (not a separate
 * branch): a `default` workstream is always written so downstream
 * code can iterate `Object.keys(workstreams)` uniformly.
 *
 * Failure modes:
 *  - parsing returns 0 workstreams → write the synthetic `default`
 *  - dispatch fails → treat as halt (the cycle can't proceed without
 *    knowing what to develop); event is `dispatch-failed`
 */
async function runPlan(ctx: DriverContext, state: WorkState, now: number): Promise<WorkState> {
  let next = appendEvent(
    { ...state, pipelineState: { ...state.pipelineState, currentStep: "plan" } },
    { kind: "step-started", step: "plan", at: now },
  );
  const dispatch = ctx.dispatchFn ?? dispatchCore;
  const startedAt = Date.now();
  const prompt = inlinePlanPrompt(activeIssuesOf(state), scratchDir(ctx.repoRoot, ctx.issue));
  let result: DispatchResult;
  try {
    result = await dispatch(ctx.pi, { role: "explore", prompt }, { label: "plan" });
  } catch (err) {
    return appendEvent(next, {
      kind: "dispatch-failed",
      step: "plan",
      role: "explore",
      jobId: "unknown",
      label: "plan",
      ms: Date.now() - startedAt,
      at: Date.now(),
      errorTail: (err as Error).message?.slice(-200),
    });
  }
  const event = await buildCompletionEvent(ctx, "plan", "explore", "plan", result);
  next = appendEvent(next, event);
  // Parse workstreams out of the reply. Failure or N=0 collapses to
  // `default` — never blocks the cycle.
  const workstreams = parseWorkstreams(result.text ?? "");
  if (Object.keys(workstreams).length === 0) {
    workstreams.default = {
      id: "default",
      scope: `Issue #${ctx.issue}`,
      paths: [],
      outOfScope: [],
    };
  }
  return {
    ...next,
    pipelineState: { ...next.pipelineState, workstreams },
  };
}

/**
 * PR6 — Parse the explore reply for a `VERDICT: <kind>` token.
 *
 * Lenient on shape: tolerates `VERDICT: X`, `**VERDICT:** X`, leading
 * whitespace, any case. First match wins so a verbatim quote of the
 * prompt text further down in the reply doesn't override the verdict
 * declared at the top. Returns null on missing or unknown verdicts —
 * `runExplore` treats null as "agent skipped the heading, proceed as
 * NEEDS_WORK" rather than halting. The structural fix is opt-in
 * robustness, not a hard contract break.
 *
 * Empirical case (#533 cascade): explore declared "Task complete:
 * Issue #533 — ALREADY COMPLETED" in prose at the top of its reply
 * but lacked the `VERDICT:` heading, so the driver had nothing to
 * route on. With this parser + the prompt update, future already-
 * complete declarations carry a parseable token.
 */
export type ExploreVerdict = "NEEDS_WORK" | "ALREADY_COMPLETE" | "NEEDS_CLARIFICATION";

export function parseExploreVerdict(text: string): ExploreVerdict | null {
  const m = text.match(/VERDICT:\s*\**\s*(NEEDS_WORK|ALREADY_COMPLETE|NEEDS_CLARIFICATION)\b/i);
  const tok = m?.[1];
  return tok ? (tok.toUpperCase() as ExploreVerdict) : null;
}

/**
 * PR10 — Multi-issue counterpart to parseExploreVerdict.
 *
 * For `/work N M P`, explore returns a per-issue verdict block like:
 *
 *   ## Verdict
 *   - #561: NEEDS_WORK
 *   - #562: ALREADY_COMPLETE — satisfied by PR #534
 *   - #563: NEEDS_WORK
 *
 * Parses one verdict per requested issue number. The `reason` string
 * captures the trailing prose after `—`/`-` (handoff renderers surface
 * it). When explore omitted a per-issue line for an issue, fall back
 * to the overall verdict via parseExploreVerdict; if even that is
 * absent, default to NEEDS_WORK so the driver proceeds rather than
 * silently dropping the issue.
 */
export function parsePerIssueVerdicts(
  text: string,
  issues: number[],
): Array<{ issue: number; verdict: ExploreVerdict; reason: string }> {
  const overall = parseExploreVerdict(text);
  return issues.map((n) => {
    const re = new RegExp(
      `#${n}\\s*:\\s*\\**\\s*(NEEDS_WORK|ALREADY_COMPLETE|NEEDS_CLARIFICATION)\\b\\**\\s*[—\\-]?\\s*(.*)`,
      "i",
    );
    const m = text.match(re);
    const tok = m?.[1];
    if (tok) {
      const reason = (m?.[2] ?? "").trim();
      return { issue: n, verdict: tok.toUpperCase() as ExploreVerdict, reason };
    }
    return {
      issue: n,
      verdict: (overall ?? "NEEDS_WORK") as ExploreVerdict,
      reason: overall
        ? "(no per-issue verdict; using overall)"
        : "(no verdict; defaulting to NEEDS_WORK)",
    };
  });
}

/**
 * Parse the explore-style reply for a fenced `## Workstreams` block.
 * Expected format (lenient — agents drift; only the keys matter):
 *
 *   ## Workstreams
 *
 *   ### task-a — short scope label
 *   - paths: src/foo.ts, src/bar.ts
 *   - out-of-scope: docs/, infrastructure
 *
 *   ### task-b — second scope label
 *   ...
 *
 * No `## Workstreams` heading present → returns `{}` (caller fills in
 * the synthetic `default` workstream). Designed to never throw: a
 * malformed reply collapses to single-workstream rather than aborting
 * the cycle.
 */
export function parseWorkstreams(
  text: string,
): Record<string, { id: string; scope: string; paths: string[]; outOfScope: string[] }> {
  const out: Record<string, { id: string; scope: string; paths: string[]; outOfScope: string[] }> =
    {};
  const section = sliceMarkdownSection(text, "Workstreams");
  if (section === undefined) return out;
  // Each workstream begins with a ### subheading. Slice between consecutive
  // ### lines (or to end of section). Heading shape: `### <id> — <scope>` or
  // `### <id>` (scope optional; em/en/hyphen all accepted as the separator).
  // The id matches `[a-z0-9][a-z0-9_-]*` so hyphens inside an id like
  // `task-a` work; the separator is SPACE-DASH-SPACE so we don't ambiguate.
  const headingRe = /^###\s+([a-z0-9][a-z0-9_-]*)(?:\s+[—–-]\s+(.+?))?\s*$/gim;
  const headings: Array<{ index: number; length: number; id: string; scope: string }> = [];
  let m: RegExpExecArray | null;
  // biome-ignore lint/suspicious/noAssignInExpressions: regex iteration idiom
  while ((m = headingRe.exec(section))) {
    const id = (m[1] ?? "").trim().toLowerCase().replace(/\s+/g, "-");
    if (!id) continue;
    headings.push({
      index: m.index,
      length: m[0].length,
      id,
      scope: (m[2] ?? "").trim() || id,
    });
  }
  for (let i = 0; i < headings.length; i++) {
    const h = headings[i];
    if (!h) continue;
    const bodyStart = h.index + h.length;
    const bodyEnd = headings[i + 1]?.index ?? section.length;
    const body = section.slice(bodyStart, bodyEnd);
    out[h.id] = {
      id: h.id,
      scope: h.scope,
      paths: extractListField(body, "paths"),
      outOfScope: extractListField(body, "out[- ]of[- ]scope"),
    };
  }
  return out;
}

/**
 * PR16 — Deterministic multi-issue grouping.
 *
 * For /work N M P with K > 1 activeIssues, partition them into groups
 * that will each become one worktree + one PR. The compiled driver's
 * PR10 shortcut bundled ALL K issues into ONE PR; that empirically
 * failed 3× (vipune `memory-row`). PR15 retreated to one-PR-per-issue.
 * PR16 restores the old PM-driven /work's smarts (analyze → group
 * related issues → parallelize independent ones) but codified as pure
 * code so it's deterministic and testable.
 *
 * Rules, applied first-match-wins per issue-pair, union-find into
 * groups:
 *
 *   R1 — Explicit link markers: regex on issue bodies for
 *        "depends-on: #N", "companion-to: #N", "blocks #N",
 *        "blocked-by: #N". Directed edge; both directions merge.
 *   R2 — Path-overlap ≥ 50% (Jaccard): parse file paths from body
 *        fenced code + bullet lists; ≥ 0.5 overlap → same group.
 *   R3 — Explicit SPLIT marker: "split", "separate PRs",
 *        "independent" anywhere in the body → force the containing
 *        issue into its own singleton group even if R1/R2 would have
 *        merged it.
 *   R4 — Subsystem tag prefix in title: [frontend], [docs], etc.
 *        Same-prefix issues group together, absent R3.
 *   R5 — Default: separate groups.
 *
 * Guardrails after grouping:
 *
 *   - Cap group size at MAX_ISSUES_PER_GROUP (3) — bigger groups
 *     approach the adversarial convergence wall (vipune `memory-row`
 *     empirical ceiling: > 3 issues in one bundle collapsed 3×).
 *     Excess splits into per-issue singletons.
 *   - K > MAX_PARALLEL_GROUPS (2) triggers "sequential" fanout mode
 *     for the remainder (matches worktree cherry-pick ceiling from
 *     vipune `memory-row`).
 *
 * Output shape matches `parseWorkstreams`: `Record<groupId, {id, scope,
 * paths, outOfScope, issues}>`. Each entry becomes one workstream
 * downstream — the rest of the driver iterates
 * `Object.keys(workstreams)` unchanged.
 */
export const MAX_ISSUES_PER_GROUP = 3;
export const MAX_PARALLEL_GROUPS_DEFAULT = 2;

export interface GroupingResult {
  groups: Record<
    string,
    {
      id: string;
      scope: string;
      paths: string[];
      outOfScope: string[];
      issues: number[];
    }
  >;
  fanout: { mode: "parallel" | "sequential"; concurrencyCap: number };
  /** Human-readable notes on which rules fired; surfaced in a plumb-report. */
  notes: string[];
}

export function groupIssues(
  activeIssues: number[],
  bodiesByIssue: Record<number, string>,
): GroupingResult {
  const notes: string[] = [];
  if (activeIssues.length === 0) {
    return { groups: {}, fanout: { mode: "parallel", concurrencyCap: 1 }, notes };
  }
  if (activeIssues.length === 1) {
    // Single-issue path: return one "default" group. Callers usually
    // shouldn't reach groupIssues for K=1, but return sanely if they do.
    const n = activeIssues[0] ?? 0;
    return {
      groups: {
        default: { id: "default", scope: `issue #${n}`, paths: [], outOfScope: [], issues: [n] },
      },
      fanout: { mode: "parallel", concurrencyCap: 1 },
      notes,
    };
  }

  // R3 — Detect SPLIT markers up-front. Issues marked SPLIT become
  // singleton groups regardless of other rules.
  const splitRe = /\b(?:split|separate\s+prs?|independent)\b/i;
  const splitIssues = new Set<number>(
    activeIssues.filter((n) => splitRe.test(bodiesByIssue[n] ?? "")),
  );
  if (splitIssues.size > 0) {
    notes.push(`R3 split: ${[...splitIssues].map((n) => `#${n}`).join(", ")}`);
  }

  // Union-find over activeIssues.
  const parent = new Map<number, number>();
  for (const n of activeIssues) parent.set(n, n);
  function find(n: number): number {
    let p = parent.get(n) ?? n;
    while (p !== parent.get(p)) {
      const next = parent.get(p) ?? p;
      const gp = parent.get(next) ?? next;
      parent.set(p, gp);
      p = parent.get(p) ?? p;
    }
    return p;
  }
  function union(a: number, b: number): void {
    if (splitIssues.has(a) || splitIssues.has(b)) return;
    const ra = find(a);
    const rb = find(b);
    if (ra !== rb) parent.set(ra, rb);
  }

  // R1 — Explicit link markers: depends-on / companion-to / blocks /
  // blocked-by. Directed edge → union both ends.
  const linkRe =
    /\b(?:depends[-\s]?on|companion[-\s]?(?:to|of)|blocks?|blocked[-\s]?by)\s*:?\s*#?(\d+)/gi;
  for (const n of activeIssues) {
    const body = bodiesByIssue[n] ?? "";
    let m: RegExpExecArray | null;
    // biome-ignore lint/suspicious/noAssignInExpressions: regex iteration idiom
    while ((m = linkRe.exec(body))) {
      const other = Number.parseInt(m[1] ?? "", 10);
      if (Number.isFinite(other) && parent.has(other) && other !== n) {
        union(n, other);
        notes.push(`R1 link: #${n} ↔ #${other}`);
      }
    }
    linkRe.lastIndex = 0;
  }

  // R2 — Path overlap. Extract path-shaped tokens from each body,
  // compute Jaccard on pairs, union if ≥ 0.5.
  const pathRe =
    /(?<![a-z0-9/])([a-z0-9._-]+\/[a-z0-9._/-]+\.(?:ts|tsx|js|jsx|py|rs|go|md|json|toml|yaml|yml|sh|css|scss|html))\b/gi;
  const pathsByIssue = new Map<number, Set<string>>();
  for (const n of activeIssues) {
    const body = bodiesByIssue[n] ?? "";
    const s = new Set<string>();
    let m: RegExpExecArray | null;
    // biome-ignore lint/suspicious/noAssignInExpressions: regex iteration idiom
    while ((m = pathRe.exec(body))) {
      const p = m[1];
      if (p) s.add(p.toLowerCase());
    }
    pathRe.lastIndex = 0;
    pathsByIssue.set(n, s);
  }
  for (let i = 0; i < activeIssues.length; i++) {
    for (let j = i + 1; j < activeIssues.length; j++) {
      const a = activeIssues[i];
      const b = activeIssues[j];
      if (a === undefined || b === undefined) continue;
      const pa = pathsByIssue.get(a);
      const pb = pathsByIssue.get(b);
      if (!pa || !pb || pa.size === 0 || pb.size === 0) continue;
      const inter = [...pa].filter((p) => pb.has(p)).length;
      const union_ = pa.size + pb.size - inter;
      const jaccard = union_ === 0 ? 0 : inter / union_;
      if (jaccard >= 0.5) {
        union(a, b);
        notes.push(`R2 path-overlap: #${a} ↔ #${b} (jaccard=${jaccard.toFixed(2)})`);
      }
    }
  }

  // R4 — Subsystem tag prefix in title. Title is expected on the first
  // non-empty line of the body (gh issue view format). Match `[tag]` at
  // the start.
  const tagByIssue = new Map<number, string>();
  for (const n of activeIssues) {
    const body = bodiesByIssue[n] ?? "";
    const firstLine = body.split("\n").find((l) => l.trim().length > 0) ?? "";
    const m = firstLine.match(/\[([a-z0-9_-]+)\]/i);
    if (m?.[1]) tagByIssue.set(n, m[1].toLowerCase());
  }
  for (let i = 0; i < activeIssues.length; i++) {
    for (let j = i + 1; j < activeIssues.length; j++) {
      const a = activeIssues[i];
      const b = activeIssues[j];
      if (a === undefined || b === undefined) continue;
      const ta = tagByIssue.get(a);
      const tb = tagByIssue.get(b);
      if (ta && tb && ta === tb) {
        union(a, b);
        notes.push(`R4 subsystem: #${a} ↔ #${b} (tag=[${ta}])`);
      }
    }
  }

  // Collect union-find components.
  const components = new Map<number, number[]>();
  for (const n of activeIssues) {
    const r = find(n);
    if (!components.has(r)) components.set(r, []);
    components.get(r)?.push(n);
  }
  // Deterministic order: sort components by their smallest issue number,
  // then sort issues within each component.
  const componentArr = [...components.values()]
    .map((c) => [...c].sort((a, b) => a - b))
    .sort((a, b) => (a[0] ?? 0) - (b[0] ?? 0));

  // Guardrail: cap group size at MAX_ISSUES_PER_GROUP. Splitting into
  // consecutive chunks keeps related issues nearby.
  const capped: number[][] = [];
  for (const c of componentArr) {
    if (c.length <= MAX_ISSUES_PER_GROUP) {
      capped.push(c);
    } else {
      notes.push(
        `guardrail split: component (${c.map((n) => `#${n}`).join(", ")}) exceeds ${MAX_ISSUES_PER_GROUP} — splitting into singletons`,
      );
      for (const n of c) capped.push([n]);
    }
  }

  // Assign group ids: group-a, group-b, ... (K > 26 falls back to
  // group-N; realistically we'll never hit that).
  const groupIdOf = (i: number): string =>
    i < 26 ? `group-${String.fromCharCode(97 + i)}` : `group-${i}`;

  const groups: GroupingResult["groups"] = {};
  for (let i = 0; i < capped.length; i++) {
    const issues = capped[i];
    if (!issues) continue;
    const id = groupIdOf(i);
    // Union of all issues' extracted path sets forms the group's `paths`.
    const pathUnion = new Set<string>();
    for (const n of issues) {
      for (const p of pathsByIssue.get(n) ?? []) pathUnion.add(p);
    }
    // Scope: enumerate issues; developer prompt fills in the details.
    const scope =
      issues.length === 1
        ? `issue #${issues[0]}`
        : `issues ${issues.map((n) => `#${n}`).join(", ")}`;
    groups[id] = {
      id,
      scope,
      paths: [...pathUnion].sort(),
      outOfScope: [],
      issues,
    };
  }

  // Fanout mode: parallel up to MAX_PARALLEL_GROUPS_DEFAULT; sequential
  // if K exceeds it (excess groups still get their own worktree, just
  // run in batches).
  const parallelCap =
    Number(process.env.PI_ENSEMBLE_PARALLEL_GROUPS) > 0
      ? Number(process.env.PI_ENSEMBLE_PARALLEL_GROUPS)
      : MAX_PARALLEL_GROUPS_DEFAULT;
  const K = Object.keys(groups).length;
  const fanout: GroupingResult["fanout"] =
    K <= parallelCap
      ? { mode: "parallel", concurrencyCap: Math.min(K, parallelCap) }
      : { mode: "sequential", concurrencyCap: parallelCap };
  if (K > parallelCap) {
    notes.push(
      `concurrency cap: K=${K} > cap=${parallelCap} → sequential mode (excess groups run in batches of ${parallelCap})`,
    );
  }

  return { groups, fanout, notes };
}

/**
 * Slice the markdown subsection following a given `## <name>` heading.
 * Returns text from the line after the heading up to (but not including)
 * the next top-level `## ` heading or end of input. Returns `undefined`
 * when the heading isn't present. JS regex has no `\Z`; this helper
 * gives the same effect with explicit string operations.
 */
function sliceMarkdownSection(text: string, name: string): string | undefined {
  const headingRe = new RegExp(`^##\\s+${name}\\s*$`, "m");
  const m = text.match(headingRe);
  if (!m || m.index === undefined) return undefined;
  const start = m.index + m[0].length;
  const after = text.slice(start);
  const nextMatch = after.match(/^##\s/m);
  if (nextMatch && nextMatch.index !== undefined) {
    return after.slice(0, nextMatch.index);
  }
  return after;
}

/** Extract `- key: a, b, c` or `- key: a` from a markdown sub-section. */
function extractListField(body: string, keyPattern: string): string[] {
  const re = new RegExp(`^\\s*[-*]\\s*${keyPattern}\\s*:\\s*(.+?)\\s*$`, "im");
  const m = body.match(re);
  if (!m) return [];
  return (m[1] ?? "")
    .split(/[,\n]/)
    .map((s) => s.trim())
    .filter(Boolean);
}

/**
 * Step 3 — Setup: ops creates the feature branch + worktrees.
 *
 * The ops subagent enforces the safety preconditions in /work.md Step 3:
 * clean working tree, fast-forward mainline, then create
 * `feature/issue-N-<brief>` branch. The driver stores the branch name in
 * pipelineState once the dispatch returns so subsequent steps can compose
 * worktree paths and the PR URL.
 *
 * v1 simplification: the driver does not parse the branch name out of the
 * ops reply — it leaves pipelineState.branchName undefined and lets the
 * subsequent steps include the issue number in their prompts, asking the
 * @developer / @ops to discover the branch via `git rev-parse --abbrev-ref HEAD`
 * in the worktree. A future version with a structured-output schema on
 * @ops can populate pipelineState.branchName explicitly.
 */
async function runBranch(ctx: DriverContext, state: WorkState, now: number): Promise<WorkState> {
  const workstreamIds = Object.keys(state.pipelineState.workstreams ?? {});
  const next = await runSingleDispatch(ctx, state, "branch", "ops", "ops", now, () =>
    inlineBranchPrompt(activeIssuesOf(state), workstreamIds, scratchDir(ctx.repoRoot, ctx.issue)),
  );
  const last = next.eventLog[next.eventLog.length - 1];
  if (last?.kind !== "dispatch-completed") return next;
  const branch = parseBranchName(last.summary);
  // Parse worktree assignments (PR3 multi-workstream). For N=1 default
  // workstream, ops doesn't create an actual worktree — driver records
  // `{default: ctx.repoRoot}` so downstream Steps 4/5/7 use the same
  // map-iteration code path uniformly. For N>1, ops returns a fenced
  // `## Worktrees` block mapping workstream id → absolute path.
  const worktrees =
    workstreamIds.length > 1
      ? parseWorktreesBlock(last.summary ?? "", ctx.repoRoot)
      : { default: ctx.repoRoot };
  const ps: typeof next.pipelineState = { ...next.pipelineState, worktrees };
  if (branch) ps.branchName = branch;
  // PR17 — record the base SHA the feature branch grew from. At this
  // point the branch was just created and has zero commits, so HEAD at
  // repoRoot IS the base. verifyStepOutcome diffs against this to prove
  // develop produced real changes. Best-effort: a git failure leaves
  // baseSha unset and the verifier falls back to porcelain-only checks.
  try {
    const execFn = ctx.verifyExecFn ?? execp;
    const { stdout } = await execFn("git rev-parse HEAD", {
      cwd: ctx.repoRoot,
      maxBuffer: 64 * 1024,
    });
    if (stdout.trim()) ps.baseSha = stdout.trim();
  } catch {
    trace("work-driver: baseSha capture failed (verify gate falls back to porcelain-only)");
  }
  return { ...next, pipelineState: ps };
}

/**
 * Parse a fenced `## Worktrees` block from ops's branch reply.
 *
 * Expected format:
 *
 *   ## Worktrees
 *
 *   - task-a: /Users/dev/projects/foo/.worktrees/issue-553-task-a
 *   - task-b: /Users/dev/projects/foo/.worktrees/issue-553-task-b
 *
 * Lenient: accepts hyphens, asterisks, optional backticks around the
 * path. Returns `{}` if no block present — caller falls back to repo
 * root for the `default` workstream.
 */
export function parseWorktreesBlock(text: string, repoRoot: string): Record<string, string> {
  const out: Record<string, string> = {};
  const section = sliceMarkdownSection(text, "Worktrees");
  if (section === undefined) return out;
  const lineRe = /^\s*[-*]\s*([a-z0-9][a-z0-9_-]*)\s*:\s*`?([^\s`]+)`?\s*$/gim;
  let m: RegExpExecArray | null;
  // biome-ignore lint/suspicious/noAssignInExpressions: regex iteration idiom
  while ((m = lineRe.exec(section))) {
    const id = (m[1] ?? "").trim();
    let p = (m[2] ?? "").trim();
    if (!path.isAbsolute(p)) p = path.resolve(repoRoot, p);
    if (id) out[id] = p;
  }
  return out;
}

/**
 * Step 4 — Implementation.
 *
 * PR3 restored multi-workstream parallelism (the original /work.md
 * "default to parallel" doctrine PR #239 silently dropped). When Step 2
 * decomposed the issue into N>1 workstreams, this step fans out N
 * developers in parallel — each in its own worktree — via Promise.all
 * over driver-owned `dispatchCore` calls (the same pattern that
 * `runLensReview` uses for its 6 lens children).
 *
 * For N=1 (the `default` workstream synthesised by Step 2), the existing
 * `runSingleDispatch` path runs unchanged — N=1 isn't a special case,
 * just the degenerate one. Both paths populate the SAME event log shape;
 * downstream Steps 5 (adversarial) and 7 (lens-review) see a single
 * coherent diff via `fetchDiff` whether N=1 or N>1.
 *
 * Partial failures don't abort the join: each branch is try/catch'd
 * inside the `Promise.all`. Adversarial sees the aggregate; the
 * `branches-converged` event records which branches succeeded.
 */
async function runDevelop(ctx: DriverContext, state: WorkState, now: number): Promise<WorkState> {
  const ids =
    Object.keys(state.pipelineState.workstreams ?? {}).length > 0
      ? Object.keys(state.pipelineState.workstreams ?? {})
      : ["default"];
  // PR11 — thread the ACTIVE issue list (NEEDS_WORK subset after
  // explore) into developer + speculative-explore prompts, not the
  // primary cycle issue. activeIssuesOf falls back to [ctx.issue] for
  // single-issue cycles so existing behaviour is preserved.
  const activeIssues = activeIssuesOf(state);

  let next: WorkState = {
    ...state,
    pipelineState: { ...state.pipelineState, currentStep: "develop" },
  };
  next = appendEvent(next, { kind: "step-started", step: "develop", at: now });
  // Only emit branches-fanned-out for N>1 (N=1 stays terse in scrollback).
  if (ids.length > 1) {
    next = appendEvent(next, {
      kind: "branches-fanned-out",
      step: "develop",
      workstreams: ids,
      at: now,
    });
  }

  const dispatch = ctx.dispatchFn ?? dispatchCore;
  const scratchAbs = scratchDir(ctx.repoRoot, ctx.issue);
  // PR4 Pattern 3: speculative just-in-time explore alongside each developer.
  // Wall-clock cost is the developer's elapsed (always longer than explore);
  // token cost is one extra explore per workstream. Opt-out via env var for
  // budget-sensitive users.
  const speculativeOn = process.env.PI_ENSEMBLE_SKIP_SPECULATIVE_EXPLORE !== "1";
  const verdicts: Array<{ id: string; ok: boolean }> = [];
  const branchEvents: typeof next.eventLog = [];
  const results = await Promise.all(
    ids.map(async (id) => {
      const ws = state.pipelineState.workstreams?.[id];
      const cwd = state.pipelineState.worktrees?.[id] ?? ctx.repoRoot;
      const startedAt = Date.now();
      const developerLabel = ids.length > 1 ? `developer[${id}]` : "developer";
      const speculativeContextPath = path.join(scratchAbs, `speculative-${id}.md`);
      try {
        // Fire developer + (optional) speculative explore CONCURRENTLY.
        // The explore writes its findings to a scratch file before
        // returning so the developer can consult it mid-flight (the
        // developer prompt names the path explicitly). Promise.allSettled
        // ensures one failing doesn't abort the other.
        const [developerSettled, speculativeSettled] = await Promise.allSettled([
          dispatch(
            ctx.pi,
            {
              role: "developer",
              prompt: inlineDevelopPrompt(
                activeIssues,
                scratchAbs,
                ws,
                ids.length > 1 ? id : undefined,
                speculativeOn ? speculativeContextPath : undefined,
              ),
              cwd,
            },
            { label: developerLabel },
          ),
          speculativeOn
            ? dispatch(
                ctx.pi,
                {
                  role: "explore",
                  prompt: inlineSpeculativeExplorePrompt(
                    activeIssues,
                    ws,
                    speculativeContextPath,
                    scratchAbs,
                  ),
                  cwd,
                },
                { label: ids.length > 1 ? `explore:speculative[${id}]` : "explore:speculative" },
              )
            : Promise.resolve(null),
        ]);
        // Record the speculative outcome (best-effort observability;
        // failure is non-fatal — the developer ran on whatever context
        // Step 1's explore + the scratch file provided).
        if (speculativeSettled.status === "fulfilled" && speculativeSettled.value !== null) {
          const specEvent = await buildCompletionEvent(
            ctx,
            "develop",
            "explore",
            ids.length > 1 ? `explore:speculative[${id}]` : "explore:speculative",
            speculativeSettled.value,
          );
          branchEvents.push(specEvent);
        } else if (speculativeSettled.status === "rejected") {
          trace(
            `work-driver: speculative explore for workstream ${id} threw: ${(speculativeSettled.reason as Error).message?.slice(-200)}`,
          );
        }
        if (developerSettled.status === "rejected") {
          throw developerSettled.reason;
        }
        const res = developerSettled.value;
        const ok = res.ok && !res.errorStop;
        const completionEvent = await buildCompletionEvent(
          ctx,
          "develop",
          "developer",
          developerLabel,
          res,
        );
        branchEvents.push(completionEvent);
        if (ids.length > 1) {
          branchEvents.push({
            kind: "branch-completed",
            step: "develop",
            workstreamId: id,
            ok,
            ms: Date.now() - startedAt,
            at: Date.now(),
          });
        }
        verdicts.push({ id, ok });
        return { id, ok };
      } catch (err) {
        const errMsg = (err as Error).message?.slice(0, 200);
        branchEvents.push({
          kind: "dispatch-failed",
          step: "develop",
          role: "developer",
          jobId: "unknown",
          label: developerLabel,
          ms: Date.now() - startedAt,
          at: Date.now(),
          errorTail: errMsg,
        });
        if (ids.length > 1) {
          branchEvents.push({
            kind: "branch-completed",
            step: "develop",
            workstreamId: id,
            ok: false,
            ms: Date.now() - startedAt,
            at: Date.now(),
            error: errMsg,
          });
        }
        verdicts.push({ id, ok: false });
        return { id, ok: false };
      }
    }),
  );
  void results;
  next = appendEvent(next, ...branchEvents);
  if (ids.length > 1) {
    next = appendEvent(next, {
      kind: "branches-converged",
      step: "develop",
      verdicts,
      at: Date.now(),
    });
  }
  // PR17 — outcome verification gate. Only when every branch claims
  // success (failed branches already route through the dispatch-failed
  // HALT machinery); the gate exists to catch the OTHER case, where all
  // claims are green but the evidence isn't: no diff anywhere, or the
  // project's verify command (typecheck/test) fails on the produced
  // code. Catching a broken build here saves the full adversarial →
  // lens → CI round-trip that would otherwise discover it post-PR.
  if (verdicts.every((v) => v.ok)) {
    const gate = await verifyStepOutcome(ctx, next, "develop");
    if (!gate.ok) {
      trace(`work-driver: verify-failed:develop — ${gate.failures.join(" | ")}`);
      next = {
        ...next,
        pipelineState: {
          ...next.pipelineState,
          verifyEvidence: { step: "develop", failures: gate.failures, at: Date.now() },
        },
      };
      next = appendEvent(next, {
        kind: "cap-hit",
        at: Date.now(),
        cap: "verify-failed:develop",
        reviewRound: next.pipelineState.reviewRound,
        nextStep: "handoff",
      });
    }
  }
  return next;
}

/**
 * Step 5 — Adversarial gate.
 *
 * Calls `runAdversarialLoop` directly (exported from adversarial.ts). The
 * loop does its own 3-round internal cycle; the driver wraps the whole
 * thing in one dispatch event and routes on the synthesized verdict in the
 * result text.
 *
 * The driver-owned adversarial dispatch goes through async-jobs's startJob
 * with `ownerKind:"driver"` + `skipDeck:true` so the per-round dispatch
 * deck entries owned by `runAdversarialLoop` remain the user-visible UI.
 * No double-deck.
 */
/** PR8 — extract round count from adversarial_loop's reply text. */
function parseAdversarialRounds(text: string): number {
  if (text.includes("after round 1")) return 1;
  if (text.includes("after round 2")) return 2;
  return 3;
}

async function runAdversarial(
  ctx: DriverContext,
  state: WorkState,
  now: number,
): Promise<WorkState> {
  // PR8 — adversarial is the developer's tight-loop reviewer; it belongs
  // INSIDE each workstream's worktree, not on a merged fanout diff. The
  // pre-PR8 single-dispatch path computed the diff via fetchAllDiffs
  // (per-workstream sections concatenated with `## workstream:` headers)
  // and routed adversarial_loop's internal fix-developers to a single cwd.
  // For N>1 this caused two failures empirically (/work 553 2026-06-24):
  //   1. Reviewer flagged phantom CRITICALs that were cross-workstream
  //      merge artifacts (e.g., "uses undefined setView" — defined in
  //      sibling workstream's diff fragment).
  //   2. Internal fix-loop's developer dispatched into ONE worktree,
  //      fragmenting state further across the others — the loop spun 3
  //      rounds chasing phantoms.
  // PR8 fans out adversarial per workstream: N parallel adversarial_loop
  // runs, each scoped to one worktree's diff + cwd. Mirrors the develop
  // fanout structure (PR3). Aggregated verdict is the conjunction —
  // any per-workstream rejection routes to handoff via the existing
  // adversarial-rejected + cap-hit pattern.
  const ids =
    Object.keys(state.pipelineState.workstreams ?? {}).length > 0
      ? Object.keys(state.pipelineState.workstreams ?? {})
      : ["default"];

  let next: WorkState = {
    ...state,
    pipelineState: { ...state.pipelineState, currentStep: "adversarial" },
  };
  next = appendEvent(next, { kind: "step-started", step: "adversarial", at: now });
  if (ids.length > 1) {
    next = appendEvent(next, {
      kind: "branches-fanned-out",
      step: "adversarial",
      workstreams: ids,
      at: now,
    });
  }

  type Outcome = {
    id: string;
    ok: boolean;
    rounds: number;
    rejectionText?: string;
    completionEvent?: WorkEvent;
    failureEvent?: WorkEvent;
    branchEvent?: WorkEvent;
  };
  const outcomes: Outcome[] = await Promise.all(
    ids.map(async (id): Promise<Outcome> => {
      const cwd = state.pipelineState.worktrees?.[id] ?? ctx.repoRoot;
      const label = ids.length > 1 ? `adversarial[${id}]` : "adversarial_loop";
      const startedAt = Date.now();
      const orchestratorJobId = makeRunId();
      // Per-workstream diff: a single `git diff HEAD` from this worktree.
      // Coherent because it captures exactly what ONE developer wrote on
      // ONE branch. The cross-workstream merge happens later in
      // commit-pr where ops integrates the per-workstream branches; this
      // adversarial pass gates each workstream independently.
      const diff = await fetchDiff(cwd);
      const loopFn = ctx.adversarialLoopFn ?? runAdversarialLoop;
      let result: DispatchResult;
      try {
        result = await loopFn(
          {
            diff,
            context:
              ids.length > 1
                ? `/work issue #${ctx.issue}: gating diff for workstream "${id}" before commit (Step 5).`
                : `/work issue #${ctx.issue}: gating diff before commit (Step 5).`,
            workCwd: cwd,
          },
          // No AbortController plumbing in v1 — spawn-level timeouts
          // in spawn.ts (per-role) bound the work.
          new AbortController().signal,
          orchestratorJobId,
        );
      } catch (err) {
        const errMsg = (err as Error).message?.slice(-200);
        return {
          id,
          ok: false,
          rounds: 0,
          failureEvent: {
            kind: "dispatch-failed",
            step: "adversarial",
            role: "adversarial-loop",
            jobId: orchestratorJobId,
            label,
            ms: Date.now() - startedAt,
            at: Date.now(),
            errorTail: errMsg,
          },
          branchEvent:
            ids.length > 1
              ? {
                  kind: "branch-completed",
                  step: "adversarial",
                  workstreamId: id,
                  ok: false,
                  ms: Date.now() - startedAt,
                  at: Date.now(),
                  error: errMsg,
                }
              : undefined,
        };
      }
      const completionEvent = await buildCompletionEvent(
        ctx,
        "adversarial",
        "adversarial-loop",
        label,
        result,
      );
      const ok = result.ok && !result.errorStop;
      const rounds = parseAdversarialRounds(result.text);
      return {
        id,
        ok,
        rounds,
        rejectionText: ok ? undefined : result.text,
        completionEvent,
        branchEvent:
          ids.length > 1
            ? {
                kind: "branch-completed",
                step: "adversarial",
                workstreamId: id,
                ok,
                ms: Date.now() - startedAt,
                at: Date.now(),
              }
            : undefined,
      };
    }),
  );

  // Append per-workstream events in deterministic order (dispatch-completed
  // / dispatch-failed, then branch-completed for N>1).
  const events: WorkEvent[] = [];
  for (const o of outcomes) {
    if (o.completionEvent) events.push(o.completionEvent);
    if (o.failureEvent) events.push(o.failureEvent);
    if (o.branchEvent) events.push(o.branchEvent);
  }
  next = appendEvent(next, ...events);

  if (ids.length > 1) {
    next = appendEvent(next, {
      kind: "branches-converged",
      step: "adversarial",
      verdicts: outcomes.map((o) => ({ id: o.id, ok: o.ok })),
      at: Date.now(),
    });
  }

  // Aggregate verdict. ALL approved → adversarial-approved (nextStep routes
  // to commit-pr). ANY rejected → adversarial-rejected + cap-hit (nextStep
  // routes to handoff via the cap-hit). Synthesised here so the existing
  // nextStep verdict-routing branches still work without modification.
  const maxRounds = outcomes.reduce((acc, o) => Math.max(acc, o.rounds), 0);
  const aggregateJobId = makeRunId();
  if (outcomes.every((o) => o.ok)) {
    next = appendEvent(next, {
      kind: "adversarial-approved",
      at: Date.now(),
      jobId: aggregateJobId,
      rounds: maxRounds,
    });
  } else {
    // Concatenate per-workstream rejection text (or dispatch-failure
    // marker) into findings so the handoff renderer surfaces all of them.
    const findings = outcomes
      .filter((o) => !o.ok)
      .map((o) => {
        const tag = ids.length > 1 ? `[workstream ${o.id}] ` : "";
        return `${tag}${o.rejectionText ?? "(dispatch failed — see dispatch-failed event)"}`;
      })
      .join("\n\n---\n\n");
    next = appendEvent(
      next,
      {
        kind: "adversarial-rejected",
        at: Date.now(),
        jobId: aggregateJobId,
        rounds: maxRounds || 3,
        findings,
      },
      {
        kind: "cap-hit",
        at: Date.now(),
        cap: "adversarial-loop",
        reviewRound: state.pipelineState.reviewRound,
        nextStep: "handoff",
      },
    );
  }

  return next;
}

/**
 * Step 6 — Commit + PR. ops commits the diff, pushes, opens a PR with
 * `Fixes #N` in the body. PR4 captures the `pr: <N>` line ops's prompt
 * asks for into pipelineState.prNumber so the handoff step (7g) can
 * target the right PR for `gh pr comment` instead of falling back to
 * `gh issue comment`.
 */
async function runCommitPr(ctx: DriverContext, state: WorkState, now: number): Promise<WorkState> {
  let next = await runSingleDispatch(ctx, state, "commit-pr", "ops", "ops:commit-pr", now, () =>
    // PR14 — thread worktrees + workstreams + branchName into the prompt
    // so ops knows to consolidate every worktree's uncommitted changes
    // (not just whichever one its dispatch landed in). Pre-PR14 the
    // prompt was single-tree shaped; multi-workstream cycles silently
    // committed only one worktree's slice (v0.12.13 /work 577 incident).
    inlineCommitPrPrompt(
      activeIssuesOf(state),
      state.pipelineState.droppedIssues ?? [],
      state.pipelineState.worktrees ?? {},
      state.pipelineState.workstreams ?? {},
      state.pipelineState.branchName ?? "(branch not captured — set in Step 3)",
      scratchDir(ctx.repoRoot, ctx.issue),
    ),
  );
  const last = next.eventLog[next.eventLog.length - 1];
  if (last?.kind !== "dispatch-completed") return next;
  const prNumber = parsePrNumber(last.summary);
  if (prNumber !== undefined) {
    next = {
      ...next,
      pipelineState: { ...next.pipelineState, prNumber },
    };
  }
  // PR14 — post-dispatch consolidation gate. For N>1 cycles, verify the
  // committed diff includes files from EVERY workstream's `paths` list.
  // If any workstream's paths are entirely absent from the diff, ops
  // committed a partial slice — halt with cap-hit so the operator can
  // investigate before the merge step ships the partial work.
  //
  // Defense in depth: the new prompt instructions explicitly tell ops
  // to consolidate all worktrees and verify before committing, but
  // doctrine alone isn't enough — the v0.12.13 incident merged 1 of 3
  // workstreams as a "successful" cycle.
  const consolidationCheck = await verifyConsolidation(ctx, next);
  if (consolidationCheck.missing.length > 0) {
    trace(
      `work-driver: commit-pr partial-consolidation detected — missing workstreams: ${consolidationCheck.missing.map((m) => m.id).join(", ")}`,
    );
    next = {
      ...next,
      pipelineState: {
        ...next.pipelineState,
        incompleteConsolidation: consolidationCheck.missing,
      },
    };
    next = appendEvent(next, {
      kind: "cap-hit",
      at: Date.now(),
      cap: "commit-pr-incomplete-consolidation",
      reviewRound: next.pipelineState.reviewRound,
      nextStep: "handoff",
    });
    return next;
  }
  // PR17 — outcome verification gate: prove the "committed + opened PR"
  // claim with executed evidence (commits ahead of origin/<base>, PR
  // number resolving via gh). Runs only when the consolidation gate
  // passed — one cap per failure, most-specific wins. Bonus repair: when
  // ops forgot the `pr: <N>` marker but the PR exists, the gate adopts
  // the number resolved via `gh pr list --head` so handoff/ci target
  // the right PR (pre-PR17 a missing marker silently degraded both).
  const gate = await verifyStepOutcome(ctx, next, "commit-pr");
  if (gate.adoptedPrNumber !== undefined) {
    next = {
      ...next,
      pipelineState: { ...next.pipelineState, prNumber: gate.adoptedPrNumber },
    };
  }
  if (!gate.ok) {
    trace(`work-driver: verify-failed:commit-pr — ${gate.failures.join(" | ")}`);
    next = {
      ...next,
      pipelineState: {
        ...next.pipelineState,
        verifyEvidence: { step: "commit-pr", failures: gate.failures, at: Date.now() },
      },
    };
    next = appendEvent(next, {
      kind: "cap-hit",
      at: Date.now(),
      cap: "verify-failed:commit-pr",
      reviewRound: next.pipelineState.reviewRound,
      nextStep: "handoff",
    });
  }
  return next;
}

/**
 * PR14 — Verify the integration branch's committed diff (vs origin/main)
 * includes files from EVERY active workstream's `paths` list. Used as
 * the post-dispatch safety gate in runCommitPr. Returns missing
 * workstreams (those whose paths are entirely absent from the diff)
 * so the cap-hit message can name them.
 *
 * Best-effort: any git-shell failure returns no-missing (don't false-
 * alarm on a transient git issue). The N=1 case short-circuits since
 * there's only one workstream and partial-commit doesn't apply.
 */
async function verifyConsolidation(
  ctx: DriverContext,
  state: WorkState,
): Promise<{ missing: Array<{ id: string; paths: string[] }> }> {
  const workstreams = state.pipelineState.workstreams ?? {};
  const ids = Object.keys(workstreams);
  if (ids.length <= 1) return { missing: [] };
  // Resolve the mainline branch to diff against.
  let base = "main";
  try {
    const { stdout } = await execp(
      "git symbolic-ref refs/remotes/origin/HEAD 2>/dev/null | sed 's@^refs/remotes/origin/@@'",
      { cwd: ctx.repoRoot, shell: "/bin/bash" },
    );
    if (stdout.trim()) base = stdout.trim();
  } catch {
    // Use 'main' default.
  }
  let diffNames = "";
  try {
    const { stdout } = await execp(`git diff --name-only origin/${base}..HEAD`, {
      cwd: ctx.repoRoot,
      maxBuffer: 1024 * 1024,
    });
    diffNames = stdout;
  } catch (err) {
    trace(
      `work-driver: verifyConsolidation diff failed (treating as no-missing): ${(err as Error).message?.slice(0, 120)}`,
    );
    return { missing: [] };
  }
  const changedFiles = new Set(diffNames.split("\n").filter((s) => s.trim().length > 0));
  const missing: Array<{ id: string; paths: string[] }> = [];
  for (const id of ids) {
    const ws = workstreams[id];
    if (!ws || ws.paths.length === 0) {
      // No paths declared → can't verify; skip (don't false-alarm).
      continue;
    }
    const anyPresent = ws.paths.some((p) =>
      Array.from(changedFiles).some((f) => f === p || f.startsWith(`${p}/`)),
    );
    if (!anyPresent) {
      missing.push({ id, paths: ws.paths });
    }
  }
  return { missing };
}

/**
 * PR17 — Discover the project's verify command (typecheck/test) for the
 * driver-side outcome-verification gate.
 *
 * Precedence (PR18/R6 shape):
 *   1. `.pi/verify-cmd` file at the target repo root — first non-empty,
 *      non-comment line is the command verbatim. The explicit escape
 *      valve for projects whose gate isn't derivable.
 *   2. `package.json` `typecheck` script — an intentional project-level
 *      signal; wins even next to a Cargo.toml. Runner detected from
 *      lockfile: bun.lock(b) → bun, pnpm-lock.yaml → pnpm, yarn.lock →
 *      yarn, else npm.
 *   3. `Cargo.toml` → `cargo check --quiet`. Beats a bare package.json
 *      `test` script — a Rust repo with a tooling package.json (docs
 *      build, hooks) must not run `npm run test` as its gate.
 *   4. `package.json` `test` script (non-Rust repos only).
 *   5. Nothing found → undefined; the gate skips command verification
 *      and checks diff/commit/PR evidence only (note emitted).
 */
export async function verifyCmdFor(repoRoot: string): Promise<string | undefined> {
  const has = async (f: string) =>
    fs
      .access(path.join(repoRoot, f))
      .then(() => true)
      .catch(() => false);
  try {
    const raw = await fs.readFile(path.join(repoRoot, ".pi", "verify-cmd"), "utf8");
    const line = raw
      .split("\n")
      .map((l) => l.trim())
      .find((l) => l.length > 0 && !l.startsWith("#"));
    if (line) return line;
  } catch {
    // No explicit file — try derivation.
  }
  // PR18 (R6 fix) — Cargo.toml wins over package.json UNLESS package.json
  // has an explicit `typecheck` script. Pre-PR18 package.json won
  // unconditionally, so a Rust repo with any tooling package.json (docs
  // build, git hooks, frontend fragment) discovered `npm run test`
  // instead of `cargo check` and ran the wrong build in every worktree —
  // guaranteed spurious verify-failures on Rust projects. A `typecheck`
  // script is treated as an intentional project-level signal; a bare
  // `test` script next to a Cargo.toml is almost always tooling.
  const isRust = await has("Cargo.toml");
  try {
    const pkgRaw = await fs.readFile(path.join(repoRoot, "package.json"), "utf8");
    const pkg = JSON.parse(pkgRaw) as { scripts?: Record<string, string> };
    const script = pkg.scripts?.typecheck
      ? "typecheck"
      : !isRust && pkg.scripts?.test
        ? "test"
        : undefined;
    if (script) {
      let runner = "npm run";
      if ((await has("bun.lock")) || (await has("bun.lockb"))) runner = "bun run";
      else if (await has("pnpm-lock.yaml")) runner = "pnpm run";
      else if (await has("yarn.lock")) runner = "yarn";
      return `${runner} ${script}`;
    }
  } catch {
    // No package.json or malformed — fall through.
  }
  if (isRust) return "cargo check --quiet";
  return undefined;
}

/** PR17 — bounded wall-clock for the verify command (default 10 min). */
function verifyTimeoutMs(): number {
  const env = Number(process.env.PI_ENSEMBLE_VERIFY_TIMEOUT_MS);
  if (Number.isFinite(env) && env > 0) return env;
  return 10 * 60_000;
}

/** PR17 — escape hatch: PI_ENSEMBLE_VERIFY=0 disables the outcome gate. */
function verifyGateEnabled(): boolean {
  const v = process.env.PI_ENSEMBLE_VERIFY;
  return v !== "0" && v !== "false";
}

/**
 * PR17 — Driver-side outcome verification gate.
 *
 * Every quality gate before this PR was LLM judgment (adversarial + six
 * lenses reading diffs/transcripts); nothing driver-side ever EXECUTED
 * anything until post-PR CI. Agents claim "done" and the driver trusted
 * the claim — the documented silent-merge (#245/#253) and phantom-
 * handoff incidents are exactly this failure class (MAST: verification
 * failures = 21.3% of multi-agent failures). This gate checks executed
 * evidence, costs zero LLM tokens, and shortens the failure loop from
 * post-PR CI churn to pre-commit.
 *
 * Checks by step:
 *
 *   develop —
 *     (a) at least one worktree has real changes (uncommitted porcelain
 *         entries, or commits ahead of baseSha when the developer
 *         committed locally). ALL worktrees empty = the claim was
 *         hollow.
 *     (b) the project's verify command (verifyCmdFor) exits 0 in each
 *         changed worktree. Non-zero exit = broken build/tests would
 *         have burned adversarial+lens+CI cycles downstream.
 *
 *   commit-pr —
 *     (a) commits exist on the branch: `git rev-list --count
 *         origin/<base>..HEAD` > 0 at repoRoot.
 *     (b) the parsed PR number resolves via `gh pr view`. When ops
 *         forgot the `pr: <N>` marker, fall back to `gh pr list
 *         --head <branch>` and ADOPT the number into pipelineState
 *         (bonus repair — pre-PR17 a missing marker degraded handoff
 *         targeting). No PR found at all = the "opened a PR" claim was
 *         hollow.
 *
 * Failure semantics: returns `{ok: false, failures}` — the caller emits
 * cap-hit `verify-failed:<step>` → handoff with evidence in
 * pipelineState.verifyEvidence. Infra errors on OUR side (git itself
 * erroring at repoRoot) are notes, not failures — same no-false-alarm
 * stance as verifyConsolidation.
 */
export async function verifyStepOutcome(
  ctx: DriverContext,
  state: WorkState,
  step: "develop" | "commit-pr",
): Promise<{ ok: boolean; failures: string[]; notes: string[]; adoptedPrNumber?: number }> {
  const failures: string[] = [];
  const notes: string[] = [];
  if (!verifyGateEnabled()) {
    return { ok: true, failures, notes: ["PI_ENSEMBLE_VERIFY=0 — outcome gate skipped"] };
  }
  const execFn = ctx.verifyExecFn ?? execp;

  if (step === "develop") {
    const worktrees =
      Object.keys(state.pipelineState.worktrees ?? {}).length > 0
        ? (state.pipelineState.worktrees ?? {})
        : { default: ctx.repoRoot };
    const baseSha = state.pipelineState.baseSha;
    const changedWorktrees: string[] = [];
    // PR18 (R1 fix) — track whether each worktree was actually ASSESSABLE
    // (git status or rev-list gave a definitive answer). Pre-PR18 the
    // hollow-diff failure was suppressed whenever notes was non-empty —
    // one worktree's git-status error (e.g., a mis-parsed worktree path)
    // silently disabled the check for ALL worktrees, letting a hollow
    // develop claim pass. Now: fail on zero changed worktrees whenever
    // at least ONE worktree was assessed; degrade to a note only when
    // NO worktree could be assessed at all (no evidence either way).
    let assessedCount = 0;
    for (const [id, cwd] of Object.entries(worktrees)) {
      let changed = false;
      let assessed = false;
      try {
        const { stdout } = await execFn("git status --porcelain", {
          cwd,
          maxBuffer: 1024 * 1024,
        });
        assessed = true;
        if (stdout.trim().length > 0) changed = true;
      } catch (err) {
        notes.push(`git status failed in ${id} (${(err as Error).message?.slice(0, 100)})`);
      }
      if (!changed && baseSha) {
        try {
          const { stdout } = await execFn(`git rev-list --count ${baseSha}..HEAD`, {
            cwd,
            maxBuffer: 64 * 1024,
          });
          if (Number.parseInt(stdout.trim(), 10) > 0) changed = true;
          assessed = true;
        } catch {
          // baseSha may not exist in this worktree's history — not evidence
          // either way.
        }
      }
      if (assessed) assessedCount++;
      if (changed) changedWorktrees.push(cwd);
    }
    if (changedWorktrees.length === 0) {
      if (assessedCount > 0) {
        failures.push(
          "developer claimed done but every assessed worktree has an empty diff (no uncommitted changes, no commits ahead of base) — the claim is not backed by any code change",
        );
      } else {
        notes.push(
          "no worktree could be assessed (git status / rev-list failed everywhere) — diff evidence unavailable, gate degrading to pass-with-note",
        );
      }
    }
    // (b) verify command in each changed worktree.
    const cmd = await verifyCmdFor(ctx.repoRoot);
    if (!cmd) {
      notes.push(
        "no verify command discoverable (.pi/verify-cmd, package.json scripts, Cargo.toml) — diff evidence only",
      );
    } else {
      for (const cwd of changedWorktrees) {
        try {
          await execFn(cmd, {
            cwd,
            timeout: verifyTimeoutMs(),
            maxBuffer: 4 * 1024 * 1024,
          });
        } catch (err) {
          const e = err as Error & { stdout?: string; stderr?: string; killed?: boolean };
          const tail = `${e.stdout ?? ""}\n${e.stderr ?? ""}`.trim().slice(-1500);
          failures.push(
            e.killed
              ? `verify command \`${cmd}\` exceeded its ${Math.round(verifyTimeoutMs() / 60000)}-min timeout in ${cwd}`
              : `verify command \`${cmd}\` failed in ${cwd}: ${tail || e.message?.slice(0, 300)}`,
          );
        }
      }
    }
    return { ok: failures.length === 0, failures, notes };
  }

  // step === "commit-pr"
  let base = "main";
  try {
    const { stdout } = await execFn(
      "git symbolic-ref refs/remotes/origin/HEAD 2>/dev/null | sed 's@^refs/remotes/origin/@@'",
      { cwd: ctx.repoRoot, shell: "/bin/bash" },
    );
    if (stdout.trim()) base = stdout.trim();
  } catch {
    // Use 'main' default.
  }
  try {
    const { stdout } = await execFn(`git rev-list --count origin/${base}..HEAD`, {
      cwd: ctx.repoRoot,
      maxBuffer: 64 * 1024,
    });
    if (Number.parseInt(stdout.trim(), 10) === 0) {
      failures.push(
        `ops claimed commit+PR done but the branch has zero commits ahead of origin/${base} — nothing was committed`,
      );
    }
  } catch (err) {
    notes.push(
      `git rev-list failed (${(err as Error).message?.slice(0, 100)}) — commit evidence unavailable`,
    );
  }
  let adoptedPrNumber: number | undefined;
  let prToCheck = state.pipelineState.prNumber;
  if (prToCheck === undefined) {
    // Ops forgot the `pr: <N>` marker. Try to resolve by branch name
    // before declaring failure (bonus repair for handoff targeting).
    const branch = state.pipelineState.branchName;
    if (branch) {
      try {
        const { stdout } = await execFn(
          `gh pr list --head ${JSON.stringify(branch)} --json number --jq '.[0].number'`,
          { cwd: ctx.repoRoot, maxBuffer: 64 * 1024 },
        );
        const n = Number.parseInt(stdout.trim(), 10);
        if (Number.isFinite(n) && n > 0) {
          adoptedPrNumber = n;
          prToCheck = n;
          notes.push(`ops omitted the pr: marker; resolved PR #${n} via gh pr list --head`);
        }
      } catch {
        // gh unavailable or no PR — the check below reports it.
      }
    }
    if (prToCheck === undefined) {
      failures.push(
        "ops claimed a PR was opened but no `pr: <N>` marker was parsed and no PR exists for the branch — the claim is not backed by an actual PR",
      );
    }
  }
  if (prToCheck !== undefined) {
    try {
      await execFn(`gh pr view ${prToCheck} --json state`, {
        cwd: ctx.repoRoot,
        maxBuffer: 256 * 1024,
      });
    } catch (err) {
      const e = err as Error & { stderr?: string };
      failures.push(
        `PR #${prToCheck} does not resolve via \`gh pr view\`: ${(e.stderr ?? e.message ?? "").slice(0, 200)}`,
      );
    }
  }
  return { ok: failures.length === 0, failures, notes, adoptedPrNumber };
}

/**
 * Parse `pr: <N>` from an ops commit-pr reply. Lenient — accepts
 * surrounding markdown emphasis (`**pr**: 556`), backticks (`pr: #556`,
 * `pr: \`#556\``), and the bare-or-`#`-prefixed number. Returns
 * `undefined` when no marker line is present (the dispatch may have
 * succeeded but ops forgot the marker — that's fine, runHandoff will
 * fall back to `gh issue comment`).
 */
export function parsePrNumber(text: string | undefined): number | undefined {
  if (!text) return undefined;
  const m = text.match(/^[ \t]*\*{0,2}pr\*{0,2}\s*:\s*`?#?(\d+)`?\s*$/im);
  if (!m) return undefined;
  const n = Number.parseInt(m[1] ?? "", 10);
  return Number.isFinite(n) && n > 0 ? n : undefined;
}

/**
 * Step 7 — Six-pass lens review.
 *
 * Calls `runLensReview` (exported from lens-review.ts) directly. The
 * function returns a structured LensReviewSummary with `verdict` we route
 * on. Bumps `reviewRound` and seeds `reviewCapStartedAt` on first entry.
 */
async function runLens(ctx: DriverContext, state: WorkState, now: number): Promise<WorkState> {
  const ps = state.pipelineState;
  const round = ps.reviewRound + 1;
  let next: WorkState = {
    ...state,
    pipelineState: {
      ...ps,
      currentStep: "lens-review",
      reviewRound: round,
      reviewCapStartedAt: ps.reviewCapStartedAt ?? now,
    },
  };
  next = appendEvent(next, { kind: "step-started", step: "lens-review", at: now });

  // PR11 — lens-review runs POST-commit, when the developer's work is
  // already committed on the feature branch. `git diff HEAD` (what
  // fetchAllDiffs uses) is empty at this point — the changes are IN
  // HEAD, not against it. Pre-PR11 the empty-diff guard fired on every
  // successful cycle (34 ms lens-review skip → code merged without six-
  // pass review). fetchAllMergedDiffs uses `git diff origin/<base>..HEAD`
  // which correctly returns the integrated diff. runAdversarial still
  // uses fetchAllDiffs because adversarial runs PRE-commit (uncommitted
  // diff in the worktree is the right input there).
  const diff = await fetchAllMergedDiffs(ps.worktrees ?? {}, ctx.repoRoot);

  // PR6 — empty-diff guard. Lens children hallucinate findings against
  // unrelated files when given empty context: on #533 (a devDep bump
  // already merged 5 days earlier) develop committed nothing, then
  // lens-review found PERFORMANCE issues in `src/web/sweep_stats.rs`.
  // PR11 narrows the failure mode the guard fires for: the integration
  // branch has no commits ahead of mainline (genuinely nothing to
  // review), not "git diff HEAD is empty after commit" (post-PR11 the
  // diff is base..HEAD, not HEAD).
  if (!diff.trim()) {
    next = appendEvent(
      next,
      { kind: "lens-skipped-empty-diff", at: Date.now(), round },
      { kind: "lens-approved", at: Date.now(), jobId: makeRunId(), round },
    );
    return next;
  }

  const cwd =
    ps.worktrees?.default ??
    ps.worktrees?.[Object.keys(ps.worktrees ?? {})[0] ?? ""] ??
    ctx.repoRoot;
  const startedAt = Date.now();
  const jobId = makeRunId();
  let summary: import("./lens-review.ts").LensReviewSummary;
  try {
    summary = await runLensReview({
      diff,
      context: `/work issue #${ctx.issue}, lens-review round ${round}`,
      cwd,
    });
  } catch (err) {
    return appendEvent(next, {
      kind: "dispatch-failed",
      step: "lens-review",
      role: "code-review-specialist",
      jobId,
      label: `lens-review×6 (round ${round})`,
      ms: Date.now() - startedAt,
      at: Date.now(),
      errorTail: (err as Error).message?.slice(-200),
    });
  }

  next = appendEvent(next, {
    kind: "dispatch-completed",
    step: "lens-review",
    role: "code-review-specialist",
    jobId,
    label: `lens-review×6 (round ${round})`,
    ok: true,
    ms: Date.now() - startedAt,
    at: Date.now(),
    summary: `verdict=${summary.verdict}; findings=${summary.totalFindings}`,
  });

  if (summary.verdict === "APPROVED") {
    next = appendEvent(next, { kind: "lens-approved", at: Date.now(), jobId, round });
  } else if (summary.verdict === "ISSUES_FOUND" || summary.verdict === "CRITICAL_ISSUES_FOUND") {
    next = appendEvent(next, {
      kind: "lens-issues-found",
      at: Date.now(),
      jobId,
      round,
      findings: JSON.stringify(summary.findings.slice(0, 50)),
      verdict: summary.verdict,
    });
  } else {
    // REVIEW_INCOMPLETE — at least one lens failed all retries. Treat as a
    // halt that needs human attention rather than continuing the fix loop
    // against a partial review. /work.md doctrine: never silently downgrade
    // a six-pass to a five-pass.
    next = appendEvent(next, {
      kind: "cap-hit",
      at: Date.now(),
      cap: "adversarial-loop",
      reviewRound: round,
      nextStep: "handoff",
    });
  }

  return next;
}

/**
 * Step 7f — Lens fix loop iteration. Dispatches @developer with the
 * findings from the last lens-issues-found event. The driver's transition
 * table routes lens-fix → adversarial → lens-review (or to handoff on cap-
 * hit per nextStep()).
 */
async function runLensFix(ctx: DriverContext, state: WorkState, now: number): Promise<WorkState> {
  // Find the most recent lens-issues-found in the log to extract findings.
  const lastFinding = [...state.eventLog]
    .reverse()
    .find(
      (e): e is Extract<(typeof state.eventLog)[number], { kind: "lens-issues-found" }> =>
        e.kind === "lens-issues-found",
    );
  const findings = lastFinding?.findings ?? "(no prior findings recorded)";
  return runSingleDispatch(
    ctx,
    state,
    "lens-fix",
    "developer",
    `developer:lens-fix-${state.pipelineState.reviewRound}`,
    now,
    () => inlineLensFixPrompt(findings, scratchDir(ctx.repoRoot, ctx.issue)),
  );
}

/**
 * Step 7h — Step-back when findings cluster around a theme. Dispatches
 * @explore with the SDD-six-element step-back prompt from /work.md Step 7h.
 *
 * v1: the driver does NOT cluster findings itself (that's fuzzy judgement).
 * It dispatches step-back unconditionally when the cap-hit nextStep routes
 * here, includes the prior lens-findings as input, and lets @explore
 * decide which SDD element is underspecified.
 */
/**
 * PR12 — Parse the @explore step-back reply for the structured fields
 * `sddElement:`, `diagnosis:`, `proposedRevision:`. Lenient: tolerates
 * markdown emphasis around the keys, leading whitespace, multi-line
 * values (everything from the colon to the next `^<key>:` line or the
 * end of the reply). All three fields fall back to empty strings when
 * absent — the renderer surfaces what's present and the cap-hit fires
 * regardless so the handoff still happens.
 */
export function parseStepBackReply(text: string): {
  sddElement: string;
  diagnosis: string;
  proposedRevision: string;
} {
  const extract = (key: string): string => {
    // Anchor key at start-of-line (input start OR after newline). Capture
    // is non-greedy + multi-line ([\s\S]*?) and terminates at the next
    // recognised key OR end-of-input. `$` without `m` flag matches end-
    // of-input only — `m` would terminate at the first newline and lose
    // multi-line values like proposedRevision.
    const re = new RegExp(
      String.raw`(?:^|\n)\s*[*_\x60]*${key}[*_\x60]*\s*:\s*([\s\S]*?)(?=\n\s*[*_\x60]*(?:sddElement|diagnosis|proposedRevision|alternativeApproach)[*_\x60]*\s*:|$)`,
      "i",
    );
    const m = text.match(re);
    return (m?.[1] ?? "").trim();
  };
  return {
    sddElement: extract("sddElement"),
    diagnosis: extract("diagnosis"),
    proposedRevision: extract("proposedRevision"),
  };
}

async function runStepBack(ctx: DriverContext, state: WorkState, now: number): Promise<WorkState> {
  const allFindings = state.eventLog
    .filter(
      (e): e is Extract<(typeof state.eventLog)[number], { kind: "lens-issues-found" }> =>
        e.kind === "lens-issues-found",
    )
    .map((e) => e.findings)
    .join("\n---\n");
  let next = await runSingleDispatch(
    ctx,
    state,
    "step-back",
    "explore",
    "explore:step-back",
    now,
    () => inlineStepBackPrompt(ctx.issue, allFindings, scratchDir(ctx.repoRoot, ctx.issue)),
  );
  // PR12 — parse the structured reply + emit step-back-completed and
  // cap-hit so the handoff renderer can branch on cap='step-back-revise-spec'.
  // Pre-PR12 the routing fell through the generic linear table
  // (step-back → handoff) and the handoff renderer had no cap to switch
  // on, surfacing the wrong recovery commands ("git push what's there"
  // etc.) for a spec-revision workflow.
  const last = next.eventLog[next.eventLog.length - 1];
  if (last?.kind === "dispatch-completed") {
    const parsed = parseStepBackReply(last.summary ?? "");
    next = appendEvent(
      next,
      {
        kind: "step-back-completed",
        at: Date.now(),
        jobId: last.jobId,
        sddElement: parsed.sddElement || "(not specified)",
        diagnosis: parsed.diagnosis || "(not specified)",
        proposedRevision: parsed.proposedRevision || "(not specified)",
      },
      {
        kind: "cap-hit",
        at: Date.now(),
        cap: "step-back-revise-spec",
        reviewRound: next.pipelineState.reviewRound,
        nextStep: "handoff",
      },
    );
  }
  return next;
}

/**
 * Step 8 — CI monitoring. ops runs `gh run watch` and reports the outcome.
 * The driver parses the result text for "ci-status: success/failure" so
 * routing is deterministic.
 */
/**
 * PR15 — resolve the ci-step ops timeout. `gh run watch` blocks until
 * CI completes; real project CI runs regularly exceed the ops role's
 * 10-min default (spawn.ts:141). Ci-specific override lifts the cap
 * to 30 min by default, env-tunable via
 * `PI_ENSEMBLE_CI_WATCH_TIMEOUT_MS`. Empirical: 3× ops-CI-poll
 * timeouts this session before PR15 forced cycles to false-halt on
 * `step-failed:ci`.
 */
function ciWatchTimeoutMs(): number {
  const envRaw = process.env.PI_ENSEMBLE_CI_WATCH_TIMEOUT_MS;
  const env = Number(envRaw);
  if (Number.isFinite(env) && env > 0) return env;
  return 30 * 60_000; // 30 min default
}

async function runCi(ctx: DriverContext, state: WorkState, now: number): Promise<WorkState> {
  let next = await runSingleDispatch(
    ctx,
    state,
    "ci",
    "ops",
    "ops:ci",
    now,
    () => inlineCiPrompt(ctx.issue, scratchDir(ctx.repoRoot, ctx.issue)),
    { timeoutMs: ciWatchTimeoutMs() },
  );
  // Parse the just-appended dispatch-completed event for a structured status
  // line. The ops prompt asks the agent to end with `ci-status: success` or
  // `ci-status: failure`. If parsing fails (no marker line), we treat as
  // "failure" rather than "pending" — that way the ci-retry cap engages
  // when the ops agent didn't follow the protocol (the empirical failure
  // mode on issue #553 was the ops agent reporting "no PR exists" without
  // emitting the marker, leaving status="pending" → driver stayed at ci
  // → safety-break would eventually fire).
  const last = next.eventLog[next.eventLog.length - 1];
  if (last?.kind === "dispatch-completed") {
    const text = last.summary ?? "";
    const status: "success" | "failure" | "pending" = text.includes("ci-status: success")
      ? "success"
      : text.includes("ci-status: failure")
        ? "failure"
        : // No marker line — treat as failure so the retry cap fires.
          // Logged via the event payload so the user can see this happened
          // on inspection. ops doctrine should still emit the marker; this
          // is the safety net.
          "failure";
    // Bump ciRetryCount BEFORE appending the event so nextStep's
    // `ciRetryCount >= MAX_CI_RETRIES` check reflects this attempt.
    const nextCount = (next.pipelineState.ciRetryCount ?? 0) + (status === "failure" ? 1 : 0);
    next = {
      ...next,
      pipelineState: { ...next.pipelineState, ciRetryCount: nextCount },
    };
    if (status === "failure" && nextCount > MAX_CI_RETRIES) {
      // Cap hit — emit cap-hit AND ci-status (the cap-hit is the routing
      // signal; ci-status is the audit trail). Driver loop reads the
      // cap-hit branch in nextStep and routes to handoff.
      next = appendEvent(
        next,
        { kind: "ci-status", at: Date.now(), status },
        {
          kind: "cap-hit",
          at: Date.now(),
          cap: "ci-retry",
          reviewRound: next.pipelineState.reviewRound,
          nextStep: "handoff",
        },
      );
    } else {
      next = appendEvent(next, { kind: "ci-status", at: Date.now(), status });
    }
  }
  return next;
}

/**
 * Resolve a diff for the given working directory.
 *
 * PR2 (post-#553 live test): the v1 stub returned "" unconditionally,
 * which meant adversarial-developer reviewed nothing and trivially
 * approved every cycle ("VERDICT: APPROVED — no code changes to review"
 * was the literal text from the live transcript). The fix shells out to
 * `git -C <cwd> diff` for both staged and unstaged changes (`git diff
 * HEAD` covers both) so the orchestrator's subagents work against the
 * actual worktree state.
 *
 * Failure modes return "":
 *  - cwd is undefined (no worktree resolved yet — early steps before
 *    branch creation)
 *  - cwd isn't a git repo
 *  - `git diff` returned non-zero or threw (e.g., permissions)
 *
 * The subagent prompts already include the cwd; an empty-diff result
 * lets adversarial / lens-review hint correctly ("nothing changed, no
 * review needed"). The hard cap on diff size (1 MiB) prevents a runaway
 * worktree state from bloating the dispatch prompt — pi-ai providers
 * have their own context limits and a 1 MB diff is already a red flag.
 */
async function fetchDiff(cwd: string | undefined): Promise<string> {
  if (!cwd) return "";
  try {
    const { stdout } = await execp("git diff HEAD", {
      cwd,
      maxBuffer: 1024 * 1024, // 1 MiB cap
    });
    return stdout;
  } catch (err) {
    trace(`work-driver: fetchDiff(${cwd}) failed: ${(err as Error).message?.slice(0, 200)}`);
    return "";
  }
}

/**
 * PR3 multi-worktree variant of `fetchDiff`. Resolves the diff(s) for
 * the current /work cycle's workstreams:
 *
 *  - N=1 (default workstream): single `git diff HEAD` from the recorded
 *    worktree path, OR `ctx.repoRoot` as fallback when the worktrees
 *    map is empty (the B2 cwd-fallback, restored to working order by
 *    populating the map in Step 3 — single-task /work writes
 *    `{default: ctx.repoRoot}`).
 *
 *  - N>1: one diff per worktree, concatenated with `## workstream: <id>`
 *    headers so reviewers (adversarial-developer + lens code-review-
 *    specialists) see one merged document with provenance. Per-branch
 *    fetch failures contribute an empty section rather than aborting
 *    the whole gather.
 *
 * Total budget capped at 1 MiB cumulative; once exceeded the function
 * returns what it has plus a `[... truncated for size]` marker so
 * downstream prompts don't silently lose context.
 */
async function fetchAllDiffs(worktrees: Record<string, string>, repoRoot: string): Promise<string> {
  const ids = Object.keys(worktrees);
  // N=1 path — the structural fix for B2. With Step 3 populating the
  // worktrees map (default → repoRoot for single-task), `worktrees[id]`
  // is always a string, never undefined.
  if (ids.length <= 1) {
    const cwd = ids.length === 1 ? worktrees[ids[0] ?? ""] : repoRoot;
    return fetchDiff(cwd ?? repoRoot);
  }
  // N>1: gather all per-workstream diffs FIRST, then decide whether to
  // emit headers. PR7 — when every body is empty (e.g., all three
  // developer workstreams provider-errored mid-stream without committing
  // anything), return "" so PR6's `!diff.trim()` guard in runLens fires.
  // Pre-PR7, the `## workstream: <id>\n` headers alone made the returned
  // string non-empty and lens-review ran against header-only "diffs",
  // hallucinating findings against unrelated files (the /work 553
  // 2026-06-24 re-test cascade).
  const fetched: Array<{ id: string; body: string }> = [];
  for (const id of ids) {
    const wt = worktrees[id];
    if (!wt) continue;
    fetched.push({ id, body: await fetchDiff(wt) });
  }
  if (fetched.every((f) => !f.body.trim())) return "";

  // Mixed-or-full diff: emit headers + bodies with the same budget rules
  // as before. Header preserved even for empty bodies in this branch so
  // reviewers see "task-a had no changes" alongside "task-b had X".
  const TOTAL_CAP = 1024 * 1024;
  const sections: string[] = [];
  let totalBytes = 0;
  let truncated = false;
  for (const { id, body: piece } of fetched) {
    if (truncated) break;
    const header = `## workstream: ${id}\n`;
    const remaining = TOTAL_CAP - totalBytes - header.length;
    if (remaining <= 0) {
      truncated = true;
      break;
    }
    const body = piece.length > remaining ? `${piece.slice(0, remaining)}\n[... truncated]` : piece;
    sections.push(header + body);
    totalBytes += header.length + body.length;
  }
  if (truncated) sections.push("\n[... merged diff truncated at 1 MiB total]");
  return sections.join("\n");
}

/**
 * PR11 — Resolve the integration-branch-vs-mainline diff from inside a
 * worktree. Used by `runLens` POST-commit; the changes are committed on
 * the feature branch by the time lens-review fires, so `git diff HEAD`
 * (what `fetchDiff` does) is empty. Pre-PR11 this caused PR6's empty-
 * diff guard to fire on EVERY successful cycle (34 ms lens-review skip).
 *
 * Mainline resolution mirrors what ops's branch step does:
 *   `git symbolic-ref refs/remotes/origin/HEAD` → fallback "main".
 * Then `git diff origin/<base>..HEAD` returns the integrated diff that
 * lens-review actually wants. Best-effort: any shell failure returns
 * empty (caller's empty-diff guard handles cleanly).
 */
async function fetchMergedDiff(cwd: string | undefined): Promise<string> {
  if (!cwd) return "";
  try {
    const { stdout: head } = await execp(
      "git symbolic-ref refs/remotes/origin/HEAD 2>/dev/null | sed 's@^refs/remotes/origin/@@'",
      { cwd, shell: "/bin/bash" },
    );
    const base = head.trim() || "main";
    const { stdout } = await execp(`git diff origin/${base}..HEAD`, {
      cwd,
      maxBuffer: 1024 * 1024,
    });
    return stdout;
  } catch (err) {
    trace(`work-driver: fetchMergedDiff(${cwd}) failed: ${(err as Error).message?.slice(0, 200)}`);
    return "";
  }
}

/**
 * PR11 — Multi-worktree counterpart to `fetchMergedDiff`. Same N=1
 * vs N>1 shape as `fetchAllDiffs`, same headers + 1 MiB cap + empty-
 * aware return — just uses `fetchMergedDiff` instead of `fetchDiff` so
 * post-commit lens-review sees the integrated diff against mainline.
 */
async function fetchAllMergedDiffs(
  worktrees: Record<string, string>,
  repoRoot: string,
): Promise<string> {
  const ids = Object.keys(worktrees);
  if (ids.length <= 1) {
    const cwd = ids.length === 1 ? worktrees[ids[0] ?? ""] : repoRoot;
    return fetchMergedDiff(cwd ?? repoRoot);
  }
  const fetched: Array<{ id: string; body: string }> = [];
  for (const id of ids) {
    const wt = worktrees[id];
    if (!wt) continue;
    fetched.push({ id, body: await fetchMergedDiff(wt) });
  }
  if (fetched.every((f) => !f.body.trim())) return "";

  const TOTAL_CAP = 1024 * 1024;
  const sections: string[] = [];
  let totalBytes = 0;
  let truncated = false;
  for (const { id, body: piece } of fetched) {
    if (truncated) break;
    const header = `## workstream: ${id}\n`;
    const remaining = TOTAL_CAP - totalBytes - header.length;
    if (remaining <= 0) {
      truncated = true;
      break;
    }
    const body = piece.length > remaining ? `${piece.slice(0, remaining)}\n[... truncated]` : piece;
    sections.push(header + body);
    totalBytes += header.length + body.length;
  }
  if (truncated) sections.push("\n[... merged diff truncated at 1 MiB total]");
  return sections.join("\n");
}

/**
 * Count prior `step-started` events for this step in the event log.
 * Used by the driver loop (PR4) to compute a `(round N)` suffix for the
 * scrollback lifecycle line on steps that iterate during a fix loop
 * (adversarial / lens-review / lens-fix / re-entered develop). First
 * entry returns 0 — the emit sites add 1 and pass `round` to lifecycle;
 * `formatLine` suppresses the suffix for `round <= 1` so single-entry
 * steps stay terse.
 */
function countPriorStepStarts(state: WorkState, step: WorkStep): number {
  let n = 0;
  for (const e of state.eventLog) {
    if (e.kind === "step-started" && e.step === step) n++;
  }
  return n;
}

/** Hash a diff for change-detection across rounds. SHA1 is fine — not a security boundary. */
function hashDiff(diff: string): string {
  return createHash("sha1").update(diff, "utf8").digest("hex").slice(0, 16);
}

/**
 * Detect subagent ABORT markers.
 *
 * Ops's branch and commit-pr step prompts instruct the subagent to write
 * `ABORT: <reason>` (or `**ABORT...**` for markdown emphasis) when a
 * precondition fails (dirty working tree, --ff-only refusal, etc). The
 * subagent's PROCESS still exits 0 — it ran successfully, just refused
 * the requested action — so the driver can't rely on exit code. This
 * scans the LAST ~800 chars of the reply for the marker; that's the
 * "verdict zone" where ops doctrine places it.
 *
 * Returns the matched abort line trimmed if found, or undefined.
 *
 * On issue #553's live cycle: ops's branch step replied with
 * "**ABORT: Working tree is not clean**" but PR #239 recorded ok:true
 * and the driver continued develop without a feature branch. The fix:
 * treat an ABORT marker as a dispatch-failed regardless of exit code.
 */
export function parseAbort(text: string | undefined): string | undefined {
  if (!text) return undefined;
  const tail = text.slice(-800);
  // Multiline scan — markers may be in their own paragraph or inside a
  // markdown ** bold ** wrapper. Match conservative: must START with the
  // word "ABORT" (or **ABORT) and be a fresh line, to avoid false
  // positives on prose discussing aborts.
  const m = tail.match(/^[ \t]*\*{0,2}ABORT[:\s].*$/m);
  return m ? m[0].replace(/^\*+|\*+$/g, "").trim() : undefined;
}

/**
 * Parse a `branch: <name>` line from an ops reply (Step 3 doctrine asks
 * for this verbatim). Used by runBranch to capture the feature branch
 * into pipelineState.branchName so downstream step prompts can reference
 * it without re-discovering via `git rev-parse`.
 *
 * Lenient: accepts surrounding whitespace, optional backticks, optional
 * `**branch**` markdown emphasis. Returns undefined if no marker line.
 */
export function parseBranchName(text: string | undefined): string | undefined {
  if (!text) return undefined;
  const m = text.match(/^[ \t]*\*{0,2}branch\*{0,2}\s*:\s*`?([^\s`]+)`?\s*$/m);
  return m?.[1]?.trim();
}

/**
 * Step 7g — Emit cap-hit handoff artifact.
 *
 * Dispatches @ops to:
 *  - render the handoff body (referencing the work-state file)
 *  - post `gh pr comment` (or `gh issue comment` if no PR yet)
 *  - apply `needs-human-attention` label
 *
 * After the dispatch, set status=handoff to terminate the loop.
 */
async function runHandoff(ctx: DriverContext, state: WorkState, now: number): Promise<WorkState> {
  let next: WorkState = {
    ...state,
    pipelineState: { ...state.pipelineState, currentStep: "handoff" },
  };
  next = appendEvent(next, { kind: "step-started", step: "handoff", at: now });

  // PR5: capture the worktree snapshot FIRST so handoff surfaces (in-chat
  // sendUserMessage, GitHub body, /work-status terminal) can answer
  // WHERE the work is without re-shelling git. Snapshot persists into
  // pipelineState even if subsequent steps in runHandoff fail.
  const snap = await captureWorktreeSnapshot(ctx.repoRoot, state.pipelineState.branchName);
  next = {
    ...next,
    pipelineState: { ...next.pipelineState, handoffSnapshot: snap },
  };

  // Build the handoff markdown body. Now consumes handoffSnapshot via
  // the additive sections in renderHandoffMarkdown (PR5 refinements).
  const handoffMd = renderHandoffMarkdown(next);
  const handoffBodyPath = path.join(scratchDir(ctx.repoRoot, ctx.issue), "handoff-comment.md");
  try {
    await fs.mkdir(path.dirname(handoffBodyPath), { recursive: true });
    await fs.writeFile(handoffBodyPath, handoffMd, "utf8");
  } catch (err) {
    trace(`work-driver: failed to write handoff body file: ${(err as Error).message}`);
  }

  // Dispatch @ops to post the comment + apply the label. PR5: pass a
  // TIGHT 3-min timeout — the body file is already on disk, ops just runs
  // two `gh` invocations. Overrides the ops 10-min default and prevents
  // the #553 40-min provider-spin. If the ops dispatch fails OR the
  // commentUrl doesn't parse out, the in-process gh fallback below takes
  // over so the user never silently loses the artefact.
  const dispatch = ctx.dispatchFn ?? dispatchCore;
  const startedAt = Date.now();
  const prNumber = state.pipelineState.prNumber;
  const target = prNumber ? `pr #${prNumber}` : `issue #${ctx.issue}`;
  const prompt = inlineHandoffOpsPrompt(
    ctx.issue,
    prNumber,
    handoffBodyPath,
    scratchDir(ctx.repoRoot, ctx.issue),
  );
  let opsReplyText = "";
  let dispatchOk = false;
  try {
    const res = await dispatch(
      ctx.pi,
      { role: "ops", prompt },
      { label: "ops:handoff", timeoutMs: 3 * 60_000 },
    );
    opsReplyText = res.text ?? "";
    dispatchOk = res.ok && !res.errorStop;
    const completionEvent = await buildCompletionEvent(ctx, "handoff", "ops", "ops:handoff", res);
    next = appendEvent(next, completionEvent);
  } catch (err) {
    trace(`work-driver: handoff ops dispatch threw: ${(err as Error).message}`);
    next = appendEvent(next, {
      kind: "dispatch-failed",
      step: "handoff",
      role: "ops",
      jobId: "unknown",
      label: "ops:handoff",
      ms: Date.now() - startedAt,
      at: Date.now(),
      errorTail: (err as Error).message?.slice(-200),
    });
  }

  let commentUrl = parseHandoffCommentUrl(opsReplyText);
  let labelApplied = dispatchOk && /label.*needs-human-attention/i.test(opsReplyText);

  // PR5 in-process fallback. When the ops dispatch failed OR the
  // commentUrl didn't parse out, the driver itself shells out `gh` —
  // the body file is already on disk and no LLM is needed for two
  // mechanical CLI invocations. Best-effort; if gh is missing / unauth'd
  // / network down, the in-chat HANDOFF DISPATCH INCOMPLETE banner
  // surfaces the failure with the verbatim recovery command.
  if (!commentUrl || !labelApplied) {
    try {
      const targetId = String(prNumber ?? ctx.issue);
      const objType = prNumber ? "pr" : "issue";
      if (!commentUrl) {
        const { stdout } = await execp(
          `gh ${objType} comment ${targetId} --body-file ${JSON.stringify(handoffBodyPath)}`,
          { cwd: ctx.repoRoot, timeout: 60_000 },
        );
        const parsedUrl = parseHandoffCommentUrl(stdout) ?? stdout.trim();
        if (parsedUrl) commentUrl = parsedUrl;
      }
      if (!labelApplied) {
        // Create the label first (idempotent — ignore "already exists" error).
        try {
          await execp(
            "gh label create needs-human-attention --color FFAA00 " +
              '--description "Agent loop hit a cap; human review required"',
            { cwd: ctx.repoRoot, timeout: 15_000 },
          );
        } catch {
          /* already exists or no perms; continue */
        }
        await execp(`gh ${objType} edit ${targetId} --add-label needs-human-attention`, {
          cwd: ctx.repoRoot,
          timeout: 30_000,
        });
        labelApplied = true;
      }
    } catch (err) {
      trace(`work-driver: in-process gh fallback failed: ${(err as Error).message?.slice(0, 200)}`);
    }
  }

  next = appendEvent(next, {
    kind: "handoff-emitted",
    at: Date.now(),
    commentUrl,
    labelApplied,
    handoffBodyPath,
  });
  // Set terminal status from the most recent cap-hit's cap shape:
  //   - step-failed:<step> or developer-timeout → 'aborted' (the
  //     halt-cascade router synthesised this; mid-flight failure)
  //   - any other cap (adversarial-loop, round-cap, wall-clock,
  //     ci-retry) → 'handoff' (cycle reached handoff via the verdict
  //     path, not via dispatch-failure)
  const lastCapHit = [...next.eventLog].reverse().find((e) => e.kind === "cap-hit");
  const capShape = lastCapHit?.kind === "cap-hit" ? lastCapHit.cap : ("adversarial-loop" as const);
  const isMidFlightHalt = capShape === "developer-timeout" || capShape.startsWith("step-failed:");
  next = {
    ...next,
    pipelineState: {
      ...next.pipelineState,
      status: isMidFlightHalt ? "aborted" : "handoff",
    },
  };
  trace(
    `work-driver: handoff for issue #${ctx.issue} (${target}) — commentUrl=${commentUrl ?? "?"} label=${labelApplied}`,
  );
  return next;
}

/**
 * Build the cap-hit handoff markdown body per /work.md Step 7g shape.
 * Walks state.eventLog for: which cap fired (cap-hit event's `cap` field),
 * how many lens-review rounds ran, last lens-issues-found findings (for
 * the recurring-pattern paragraph), any plumb-reports, transcript paths
 * the user can grep through.
 *
 * Pure function — no I/O, no Pi calls — so it's testable from a smoke
 * with a synthetic state file.
 */
export function renderHandoffMarkdown(state: WorkState): string {
  const ps = state.pipelineState;
  const issue = state.issue;
  const capHit = [...state.eventLog].reverse().find((e) => e.kind === "cap-hit");
  const capDescription = capHit
    ? (capHit as Extract<WorkEvent, { kind: "cap-hit" }>).cap
    : "review-round (3 of 3)";
  const lastFindings = [...state.eventLog]
    .reverse()
    .find(
      (e): e is Extract<WorkEvent, { kind: "lens-issues-found" }> => e.kind === "lens-issues-found",
    );
  const reviewRound = ps.reviewRound;
  const branch = ps.branchName ?? "(branch not captured)";
  // Pull transcript paths from the most recent dispatch-completed events
  // (last 5) so the user can drill into specific subagent runs.
  const transcripts = [...state.eventLog]
    .reverse()
    .filter(
      (e): e is Extract<WorkEvent, { kind: "dispatch-completed" }> =>
        e.kind === "dispatch-completed" && Boolean(e.transcriptPath),
    )
    .slice(0, 5)
    .map((e) => `- \`${e.label}\` — \`${e.transcriptPath}\``);
  const stepDurations = state.eventLog
    .filter(
      (e): e is Extract<WorkEvent, { kind: "dispatch-completed" }> =>
        e.kind === "dispatch-completed",
    )
    .map((e) => `- ${e.step.padEnd(14)} ${(e.ms / 1000).toFixed(1)}s · ${e.label}`);
  const branches = state.eventLog
    .filter(
      (e): e is Extract<WorkEvent, { kind: "branch-completed" }> => e.kind === "branch-completed",
    )
    .map((e) => `- ${e.workstreamId}: ${e.ok ? "ok" : "FAIL"}`);

  // PR5: explainCap provides the operator-readable WHY sentence used
  // across all three handoff surfaces (in-chat, GitHub body, /work-status).
  const capForExplain = capHit?.kind === "cap-hit" ? capHit.cap : ("adversarial-loop" as const);
  const explain = explainCap(capForExplain, state);

  // PR10 — multi-issue header + per-issue verdict block.
  const allIssues = state.issues ?? [issue];
  const issuesHeader = allIssues.length === 1 ? `\`#${issue}\`` : `\`#${allIssues.join("`, `#")}\``;
  const lines: string[] = [
    "## ⏸ Cap hit — needs human attention",
    "",
    `**Cap**: ${capDescription}`,
    `**Rounds**: ${reviewRound} of 3 review rounds`,
    `**Branch**: \`${branch}\``,
    `**Issues**: ${issuesHeader}`,
    `**State file**: \`.pi/work-state/${issue}.json\``,
    "",
    "### What this cap means",
    "",
    explain,
    "",
    "### What was attempted",
    ...stepDurations.map((s) => s),
    "",
  ];
  if (allIssues.length > 1) {
    const active = ps.activeIssues ?? allIssues;
    const dropped = ps.droppedIssues ?? [];
    lines.push("### Issues in this cycle", "");
    for (const n of allIssues) {
      if (active.includes(n)) {
        lines.push(`- **#${n}** — NEEDS_WORK (active in this PR)`);
      } else {
        const d = dropped.find((x) => x.issue === n);
        lines.push(`- #${n} — ${d?.verdict ?? "UNKNOWN"}${d?.reason ? ` (${d.reason})` : ""}`);
      }
    }
    lines.push("");
  }

  // PR5: Worktree state at handoff (from handoffSnapshot).
  if (ps.handoffSnapshot) {
    const snap = ps.handoffSnapshot;
    lines.push(
      "### Worktree state at handoff",
      "",
      `- HEAD: \`${snap.headSha || "(unknown)"}\``,
      `- branch exists locally: ${snap.branchExists ? "yes" : "no"}`,
      `- branch pushed to origin: ${snap.branchPushed ? "yes" : "no (local only)"}`,
      `- uncommitted: ${snap.unstagedCount + snap.stagedCount} files (${snap.stagedCount} staged, ${snap.unstagedCount} unstaged)`,
    );
    if (snap.modifiedFiles.length > 0) {
      const shown = snap.modifiedFiles.slice(0, 10);
      lines.push(
        `- modified files (first ${shown.length} of ${snap.modifiedFiles.length}):`,
        ...shown.map((f) => `    - \`${f}\``),
      );
    }
    lines.push("");
  }

  if (branches.length > 0) {
    lines.push("### Workstream verdicts (Step 4 fanout)", ...branches, "");
  }
  if (lastFindings) {
    const verdict = lastFindings.verdict;
    lines.push(
      `### Recurring finding pattern (last round: ${verdict})`,
      "",
      "Review the JSON findings in the state file's most recent `lens-issues-found` event.",
      "Patterns to look for:",
      "  - Same lens flagging the same shape across rounds → spec-level problem (MAST 41.77%)",
      "  - Orthogonal local bugs → genuine work remains, not a doctrine failure",
      "",
    );
  }

  // PR11 — when explore halted on empty issue bodies, list the failed
  // fetches above the recovery commands so the operator sees exactly
  // which `gh issue view N` calls broke (and can target the actual fix
  // — gh auth, gh version, network, or an extension hijack).
  if (capForExplain === "explore-bodies-empty" && (ps.emptyBodyIssues ?? []).length > 0) {
    lines.push(
      "### Empty / failed issue-body fetches",
      "",
      ...(ps.emptyBodyIssues ?? []).map((f) => `- **#${f.issue}** — ${f.reason}`),
      "",
    );
  }
  // PR12 — surface the step-back analysis (sddElement / diagnosis /
  // proposedRevision) above the recovery commands when the cap is
  // step-back-revise-spec. This is what the operator needs to actually
  // revise the issue — the recovery commands below just point at /plan.
  if (capForExplain === "step-back-revise-spec") {
    const sb = [...state.eventLog]
      .reverse()
      .find(
        (e): e is Extract<WorkEvent, { kind: "step-back-completed" }> =>
          e.kind === "step-back-completed",
      );
    if (sb) {
      lines.push(
        "### Step-back analysis (which SDD element is underspecified?)",
        "",
        `**SDD element**: ${sb.sddElement}`,
        "",
        `**Diagnosis**: ${sb.diagnosis}`,
        "",
        "**Proposed revision** (paste into the issue body or rephrase via /plan):",
        "",
        "```",
        sb.proposedRevision,
        "```",
        "",
      );
    }
  }

  // PR5: Concrete recovery commands (was prose "Suggested next steps").
  // The four named shell commands map to the four decisions an operator
  // faces at handoff time — same shape as renderHandoffUserMessage's
  // in-chat list, so the GitHub body and the chat agree on next actions.
  // PR6: explore-* caps halt before any branch/develop ran; surface
  // cap-shaped recovery commands rather than the wrong "git push what's
  // there" / "longer cap" set.
  const branchForCmd = ps.branchName ?? "<branch>";
  lines.push("### Concrete recovery commands", "", "Pick one:", "", "```bash");
  if (capForExplain === "explore-already-complete") {
    lines.push(
      "# 1. Verify by reading the issue + the explore report:",
      `gh issue view ${issue} && cat tmp/issue-${issue}/handoff-comment.md`,
      "",
      "# 2. If you agree the issue is done, close it:",
      `gh issue close ${issue} --comment "Verified complete by /work — see prior PR"`,
      "",
      "# 3. If you disagree, add context and re-run /work:",
      `gh issue comment ${issue} --body "Additional context: <what /work missed>"`,
      `rm .pi/work-state/${issue}.json && pi`,
      "",
      "# 4. Abandon the handoff entry (no code was written; safe to discard):",
      `rm .pi/work-state/${issue}.json`,
    );
  } else if (capForExplain === "explore-needs-clarification") {
    lines.push(
      "# 1. Read what explore couldn't determine:",
      `cat tmp/issue-${issue}/handoff-comment.md`,
      "",
      "# 2. Edit the issue body to add the missing acceptance criteria / scope:",
      `gh issue edit ${issue}`,
      "",
      "# 3. Re-run /work once the issue is clearer:",
      `rm .pi/work-state/${issue}.json && pi`,
      "",
      "# 4. Abandon the handoff entry:",
      `rm .pi/work-state/${issue}.json`,
    );
  } else if (capForExplain === "explore-bodies-empty") {
    const failed = ps.emptyBodyIssues ?? [];
    const probeIssue = failed[0]?.issue ?? issue;
    const failedList = failed.map((f) => `#${f.issue}`).join(", ") || `#${issue}`;
    lines.push(
      "# 1. Confirm gh auth + version (most common cause: projectCards GraphQL deprecation in older gh):",
      "gh auth status && gh --version",
      "",
      "# 2. Probe a failing issue via REST (works when `gh issue view` is broken):",
      `gh api repos/<owner>/<repo>/issues/${probeIssue} --jq .body | head`,
      "",
      "# 3. If gh issue view is hijacked, check for a misbehaving gh extension:",
      "gh extension list",
      "",
      `# 4. Once fixed, re-run /work — the cycle halts cleanly with no code written for ${failedList}:`,
      `rm .pi/work-state/${issue}.json && pi`,
    );
  } else if (capForExplain === "step-back-revise-spec") {
    lines.push(
      "# 1. Read the proposed revision above and the rich handoff body:",
      `cat tmp/issue-${issue}/handoff-comment.md`,
      "",
      "# 2. Revise the issue body via /plan (or gh issue edit) — apply the proposed wording:",
      `/plan ${issue}    # or: gh issue edit ${issue}`,
      "",
      "# 3. Restart /work from scratch against the revised spec:",
      `/work ${issue} --restart`,
      "",
      "# 4. Abandon this cycle entirely:",
      `rm .pi/work-state/${issue}.json`,
    );
  } else if (capForExplain === "commit-pr-incomplete-consolidation") {
    const missing = ps.incompleteConsolidation ?? [];
    lines.push(
      "# 1. Inspect each missing workstream's worktree — the developer's work is still there uncommitted:",
      ...missing.map((m) => `git -C .worktrees/issue-${issue}-${m.id} status --porcelain`),
      "",
      "# 2. Apply the missing diffs to the integration branch:",
      ...missing.map(
        (m) =>
          `git -C .worktrees/issue-${issue}-${m.id} diff HEAD | git apply --index    # in the integration tree`,
      ),
      "",
      "# 3. Verify all workstreams' files now appear, then commit + push:",
      "git diff --name-only --cached",
      "git commit -m '<concise>' && git push",
      "",
      "# 4. Or: abandon + restart from scratch:",
      `rm .pi/work-state/${issue}.json && /work ${issue} --restart`,
    );
  } else {
    lines.push(
      "# 1. Inspect what survived before deciding:",
      "git status && git diff --stat",
      "",
      "# 2. Retry with a longer per-spawn cap (use if dispatches kept timing out):",
      `export PI_ENSEMBLE_SPAWN_TIMEOUT_MS_DEVELOPER=5400000 && rm .pi/work-state/${issue}.json && pi`,
      "",
      "# 3. Abandon the cycle, keep the worktree changes for manual takeover:",
      `rm .pi/work-state/${issue}.json`,
      "",
      "# 4. Take over manually — commit + push what's there, open the PR yourself:",
      `git add -p && git commit && git push -u origin ${branchForCmd}`,
    );
  }
  lines.push("```", "");

  if (transcripts.length > 0) {
    lines.push("### Transcripts (last 5)", ...transcripts, "");
  }

  // PR5: pointer footer.
  lines.push(
    "### Inspect further",
    "",
    `- Rich state + full event log: \`.pi/work-state/${issue}.json\``,
    `- Per-subagent transcripts (preserved on handoff): \`tmp/issue-${issue}/\``,
    `- This body file: \`tmp/issue-${issue}/handoff-comment.md\``,
  );

  return lines.join("\n");
}

/**
 * Parse the GitHub comment URL the @ops handoff agent should have
 * surfaced in its reply. Looks for any github.com URL matching the
 * `*#issuecomment-<id>` shape (the canonical PR/issue comment URL).
 * Returns the first hit, or undefined when ops failed / didn't surface it.
 */
export function parseHandoffCommentUrl(text: string | undefined): string | undefined {
  if (!text) return undefined;
  const m = text.match(/https:\/\/github\.com\/[^\s)>]+#issuecomment-\d+/);
  return m?.[0];
}

/**
 * PR5 — capture a snapshot of the worktree at handoff time. Lets the
 * operator-facing surfaces (in-chat sendUserMessage, /work-status
 * terminal renderer, GitHub renderHandoffMarkdown) answer WHERE the
 * work is without re-shelling git on every call.
 *
 * Best-effort: every git invocation is try/catch'd so a missing branch /
 * gh-auth / network issue degrades gracefully — the snapshot's
 * `branchPushed: false` and empty `modifiedFiles` is meaningful by
 * itself; absence of the snapshot field is not.
 *
 * Caps file list at 50 entries to keep state-file readable; the
 * `unstagedCount + stagedCount` totals are always accurate even when
 * the per-file list is truncated.
 */
export async function captureWorktreeSnapshot(
  repoRoot: string,
  branchName: string | undefined,
): Promise<NonNullable<WorkState["pipelineState"]["handoffSnapshot"]>> {
  const snapshot: NonNullable<WorkState["pipelineState"]["handoffSnapshot"]> = {
    modifiedFiles: [],
    unstagedCount: 0,
    stagedCount: 0,
    branchExists: false,
    branchPushed: false,
    headSha: "",
    capturedAt: Date.now(),
  };
  // git status --porcelain (XY format: column 1 = staged tier, column 2 = unstaged tier).
  try {
    const { stdout } = await execp("git status --porcelain", {
      cwd: repoRoot,
      maxBuffer: 256 * 1024,
    });
    const lines = stdout.split("\n").filter((l) => l.length > 0);
    for (const line of lines) {
      const x = line[0] ?? " ";
      const y = line[1] ?? " ";
      if (x !== " " && x !== "?") snapshot.stagedCount += 1;
      if (y !== " ") snapshot.unstagedCount += 1;
      const filePath = line.slice(3);
      if (snapshot.modifiedFiles.length < 50) snapshot.modifiedFiles.push(filePath);
    }
  } catch (err) {
    trace(
      `work-driver: captureWorktreeSnapshot git status failed: ${(err as Error).message?.slice(0, 200)}`,
    );
  }
  // HEAD short SHA.
  try {
    const { stdout } = await execp("git rev-parse --short HEAD", { cwd: repoRoot });
    snapshot.headSha = stdout.trim();
  } catch (err) {
    trace(
      `work-driver: captureWorktreeSnapshot git rev-parse failed: ${(err as Error).message?.slice(0, 200)}`,
    );
  }
  if (branchName) {
    // Local branch existence.
    try {
      await execp(`git rev-parse --verify ${JSON.stringify(branchName)}`, { cwd: repoRoot });
      snapshot.branchExists = true;
    } catch {
      snapshot.branchExists = false;
    }
    // Remote tracking (best-effort; network may be down). 10s timeout
    // because ls-remote can hang on unreachable remotes.
    try {
      const { stdout } = await execp(`git ls-remote --heads origin ${JSON.stringify(branchName)}`, {
        cwd: repoRoot,
        timeout: 10_000,
      });
      snapshot.branchPushed = stdout.trim().length > 0;
    } catch {
      snapshot.branchPushed = false;
    }
  }
  return snapshot;
}

/**
 * PR5 — single source of truth mapping a cap-hit `cap` value to an
 * operator-readable sentence. Used by every handoff surface (in-chat
 * sendUserMessage, /work-status terminal renderer, GitHub
 * renderHandoffMarkdown) so the WHY explanation stays consistent.
 *
 * Exhaustive switch — adding a new cap value to the WorkEvent union
 * forces a typecheck error here, which is the design intent.
 */
export function explainCap(
  cap: Extract<WorkEvent, { kind: "cap-hit" }>["cap"],
  state: WorkState,
): string {
  const snap = state.pipelineState.handoffSnapshot;
  const fileCount = snap ? snap.unstagedCount + snap.stagedCount : undefined;
  const fileBlurb =
    fileCount !== undefined ? `${fileCount} file(s) modified-but-uncommitted` : "uncommitted work";
  switch (cap) {
    case "adversarial-loop":
      return "adversarial gate ran its 3-round internal loop and could not reach APPROVED — the diff still has issues the adversarial-developer flagged";
    case "round-cap":
      return `lens-review hit its ${MAX_REVIEW_ROUNDS}-round cap with findings still open — the lens reviewers and the developer's fixes did not converge`;
    case "wall-clock":
      return "lens-review fix loop exceeded its 90-minute wall-clock cap — total time spent in review/fix iterations is past the budget";
    case "ci-retry":
      return `CI failed ${MAX_CI_RETRIES} times in a row (each retry re-entered develop → adversarial → lens-review → ci) — CI is permanently broken for this branch, or the develop step keeps producing the same failure`;
    case "developer-timeout":
      return `developer subagent hit its wall-clock cap (PI_ENSEMBLE_SPAWN_TIMEOUT_MS_DEVELOPER, default 90 min) with ${fileBlurb} in the worktree — work needs different decomposition (split issue into smaller workstreams), a longer cap, or manual takeover`;
    case "explore-already-complete":
      return "explore concluded this issue is already done (e.g., satisfied by a prior PR or merged earlier). The driver halted before branch/develop ran — no code was written. Close the issue if you agree, or re-run /work with additional context if you believe there IS work to do";
    case "explore-needs-clarification":
      return "explore could not determine concrete work to do — the issue may be ambiguous, missing acceptance criteria, or contradictory. The driver halted before plan ran. Clarify the issue body and re-run /work";
    case "explore-bodies-empty": {
      const failed = state.pipelineState.emptyBodyIssues ?? [];
      const which =
        failed.length > 0 ? failed.map((f) => `#${f.issue}`).join(", ") : "one or more issues";
      return `\`gh issue view\` returned empty/error for ${which} — the driver cannot reliably classify work that hasn't been read. Most likely causes: gh version with projectCards GraphQL deprecation, gh extension hijacking stdout, expired auth (\`gh auth status\`), or network. Fix the gh setup and re-run /work; the body fetch is a load-bearing pre-condition`;
    }
    case "step-back-revise-spec": {
      const sb = [...state.eventLog]
        .reverse()
        .find(
          (e): e is Extract<WorkEvent, { kind: "step-back-completed" }> =>
            e.kind === "step-back-completed",
        );
      const elem = sb?.sddElement ?? "(spec element not specified)";
      return `explore stepped back and identified a spec-level gap in **${elem}** — the lens-review fix loop kept flagging the same shape across rounds (MAST 41.77% — spec-level problem fingerprint). The handoff body includes a proposed revision. After updating the issue (via /plan or \`gh issue edit\`), re-run with \`/work N --restart\` to start a fresh cycle against the revised spec`;
    }
    case "commit-pr-incomplete-consolidation": {
      const missing = state.pipelineState.incompleteConsolidation ?? [];
      const which =
        missing.length > 0 ? missing.map((m) => m.id).join(", ") : "one or more workstreams";
      return `commit-pr's post-dispatch consolidation gate detected that the committed diff is missing files from these workstreams: ${which}. Ops committed a partial slice — the developers' work in the missing worktrees is uncommitted on disk. Pre-PR14 this would have merged silently (v0.12.13 /work 577 closed an issue with 1 of 3 workstreams' changes shipped). The driver halted before merge; recover by collecting the missing diffs from \`.worktrees/issue-N-<id>\` and re-running, or take over the integration manually`;
    }
  }
  // PR17 — `verify-failed:<step>`: the driver-side outcome gate found
  // the step's claimed result isn't backed by executed evidence. The
  // per-check findings live in pipelineState.verifyEvidence.
  if (cap.startsWith("verify-failed:")) {
    const step = cap.slice("verify-failed:".length);
    const evidence = state.pipelineState.verifyEvidence;
    const findings =
      evidence && evidence.failures.length > 0
        ? `\n${evidence.failures.map((f) => `  - ${f}`).join("\n")}`
        : " (evidence detail missing from state)";
    return `the driver's outcome-verification gate rejected the ${step} step's "done" claim — the claimed result is not backed by executed evidence:${findings}\nNo LLM judged this; the driver ran the checks itself (git diff/rev-list, the project's verify command, gh pr view). Inspect the worktree(s), fix or re-dispatch, and re-run. Set PI_ENSEMBLE_VERIFY=0 to disable the gate (not recommended)`;
  }
  // Template-literal `step-failed:<step>` values land here. Switch on the
  // step suffix to produce a tailored sentence.
  if (cap.startsWith("step-failed:")) {
    const step = cap.slice("step-failed:".length) as WorkStep;
    // PR7 — for multi-workstream halts (PR3 fanout steps: develop +
    // lens-review), append a parenthetical with the per-branch verdict
    // count. The branches-converged event already carries the granular
    // verdicts; explainCap surfaces the count so the operator can tell
    // "all 3 branches failed" from "1 of 3 failed" without reading the
    // event log.
    const lastConverged = [...state.eventLog]
      .reverse()
      .find(
        (e): e is Extract<WorkEvent, { kind: "branches-converged" }> =>
          e.kind === "branches-converged" && e.step === step,
      );
    const fanoutTag = lastConverged
      ? ` (${lastConverged.verdicts.filter((v) => !v.ok).length}/${lastConverged.verdicts.length} workstream branches failed)`
      : "";
    switch (step) {
      case "explore":
        return "the explore step dispatch failed before producing a usable spec — cycle cannot continue without recon context";
      case "plan":
        return "the plan step dispatch failed before decomposing the issue into workstreams — cycle would silently regress to single-task develop without out-of-scope fences";
      case "branch":
        return "the branch step dispatch failed before creating the feature branch — develop would edit HEAD (likely main), commit-pr has nothing to push, CI has nothing to watch";
      case "develop":
        return `the develop step dispatch failed with ${fileBlurb} on disk${fanoutTag} — adversarial review of partial work is not meaningful, halting cleanly`;
      case "adversarial":
        return "the adversarial gate dispatch failed twice (retry exhausted) — cannot commit code that has not passed the adversarial gate";
      case "commit-pr":
        return "the commit-pr step dispatch failed before pushing the PR — lens-review of uncommitted work would waste hours, CI has nothing to watch";
      case "lens-review":
        return `the lens-review dispatch failed twice (retry exhausted)${fanoutTag} — cannot ship code that has not passed the six-pass review`;
      case "lens-fix":
        return "the lens-fix step dispatch failed mid-fix — re-running adversarial on a partial fix is not meaningful";
      case "ci":
        return "the CI monitoring step dispatch failed — cannot mark a cycle merged without confirming CI passed";
      case "merged":
        // PR10 — merged step is now HALT (was DEGRADED_OK pre-PR10
        // when runMerged was a 0ms state mutation). The actual
        // `gh pr merge` invocation in ops can fail on auth, branch
        // protection, conflicts, or a missing required review.
        return "the merge step dispatch failed — the PR was approved and CI passed, but `gh pr merge` did not succeed (auth / branch protection / conflicts / missing required review). Merge manually via `gh pr merge <PR-N> --squash --delete-branch` or per project policy";
      case "step-back":
      case "handoff":
        // These remain DEGRADED_OK in STEP_FAILURE_POLICY and should never
        // produce a step-failed:<step> cap. Render generic if it ever happens.
        return `step "${step}" failed unexpectedly — see state-file event log`;
    }
  }
  // Should be unreachable when the WorkEvent union is exhaustively
  // covered above; if we land here, surface the raw cap so the user
  // can still grep the state file.
  return `step failed: ${String(cap)} — see state-file event log`;
}

/**
 * PR5 — operator-facing in-chat handoff message. Multi-line; produced
 * by `runWorkDriver` to replace the PR4-and-earlier terse ~150-char
 * pointer-to-JSON. Sections:
 *
 *   1. Banner (HANDOFF DISPATCH INCOMPLETE when GitHub posting failed)
 *   2. Why (explainCap)
 *   3. Worktree state (from handoffSnapshot)
 *   4. GitHub handoff (comment URL + label status)
 *   5. Artefacts (body file, state file, scratch dir)
 *   6. Recovery commands — four concrete shell snippets keyed to
 *      common decisions (retry with longer cap, inspect, abandon,
 *      take over manually)
 *
 * Pure function for testability; no I/O. The caller already has the
 * latest state, repoRoot, and scratchDir to pass.
 */
export function renderHandoffUserMessage(
  state: WorkState,
  repoRoot: string,
  scratchDirAbs: string,
): string {
  const ps = state.pipelineState;
  const issue = state.issue;
  const capHit = [...state.eventLog].reverse().find((e) => e.kind === "cap-hit");
  const handoffEvt = [...state.eventLog].reverse().find((e) => e.kind === "handoff-emitted");
  const cap = capHit?.kind === "cap-hit" ? capHit.cap : ("adversarial-loop" as const);
  const why = explainCap(cap, state);
  const snap = ps.handoffSnapshot;
  const commentUrl = handoffEvt?.kind === "handoff-emitted" ? handoffEvt.commentUrl : undefined;
  const labelApplied = handoffEvt?.kind === "handoff-emitted" ? handoffEvt.labelApplied : false;
  const handoffBodyPath =
    (handoffEvt?.kind === "handoff-emitted" ? handoffEvt.handoffBodyPath : undefined) ??
    `${scratchDirAbs}/handoff-comment.md`;
  const branchName = ps.branchName ?? "(branch not captured)";
  const branchPushedTag = snap
    ? snap.branchPushed
      ? " (pushed)"
      : " (NOT pushed — local only)"
    : "";
  const headTag = snap?.headSha ? ` · HEAD ${snap.headSha}` : "";
  const fileCount = snap ? snap.unstagedCount + snap.stagedCount : 0;
  const prTag = ps.prNumber ? `PR #${ps.prNumber}` : "no PR created";
  const target = ps.prNumber ? `pr ${ps.prNumber}` : `issue ${issue}`;

  const lines: string[] = [];

  // 1. Banner when GitHub posting failed.
  if (!commentUrl || !labelApplied) {
    lines.push(
      `⚠ pi-ensemble /work for issue #${issue} — HANDOFF DISPATCH INCOMPLETE`,
      "",
      "The handoff body was generated but the GitHub-side post FAILED:",
      `  - comment posted: ${commentUrl ? `[ok] ${commentUrl}` : "[FAILED] NOT posted"}`,
      `  - label applied:  ${labelApplied ? "[ok]" : "[FAILED] NOT applied"}`,
      "",
      "Post manually now:",
      `  gh ${ps.prNumber ? "pr" : "issue"} comment ${ps.prNumber ?? issue} --body-file ${handoffBodyPath}`,
      `  gh ${ps.prNumber ? "pr" : "issue"} edit ${ps.prNumber ?? issue} --add-label needs-human-attention`,
      "",
      "---",
      "",
    );
  }

  // PR10 — multi-issue: surface all requested + active + dropped issues.
  // For single-issue cycles the header collapses to the original
  // `issue #N` shape; multi-issue cycles get a richer header + extra
  // section listing the per-issue verdicts and reasons.
  const allIssues = state.issues ?? [issue];
  const headerIssues =
    allIssues.length === 1 ? `issue #${issue}` : `issues #${allIssues.join(", #")}`;
  // 2. Standard handoff sections.
  lines.push(
    `pi-ensemble /work for ${headerIssues} — HANDOFF (needs human attention)`,
    "",
    `Why: ${why}`,
    `Last step: ${ps.lastCompletedStep ?? ps.currentStep}${ps.reviewRound > 0 ? ` · review round ${ps.reviewRound}/${MAX_REVIEW_ROUNDS}` : ""}`,
    `Cycle: ${ps.status}${ps.status === "aborted" ? " (mid-flight failure, not a cap-hit)" : ""}`,
    "",
    "Worktree state:",
    `  branch: ${branchName}${branchPushedTag}${headTag}`,
    `  ${prTag}`,
    `  ${fileCount} file(s) modified${snap && snap.stagedCount > 0 ? ` (${snap.stagedCount} staged, ${snap.unstagedCount} unstaged)` : ""}`,
  );
  // PR10 — per-issue verdict surface for multi-issue cycles. Shows
  // active (NEEDS_WORK) + dropped (ALREADY_COMPLETE / NEEDS_CLARIFICATION)
  // with the per-issue reason explore provided.
  if (allIssues.length > 1) {
    const active = ps.activeIssues ?? allIssues;
    const dropped = ps.droppedIssues ?? [];
    lines.push("", "Issues in this cycle:");
    for (const n of allIssues) {
      if (active.includes(n)) {
        lines.push(`  #${n}: NEEDS_WORK (active in this PR)`);
      } else {
        const d = dropped.find((x) => x.issue === n);
        lines.push(`  #${n}: ${d?.verdict ?? "UNKNOWN"}${d?.reason ? ` — ${d.reason}` : ""}`);
      }
    }
  }
  if (snap && snap.modifiedFiles.length > 0) {
    const shown = snap.modifiedFiles.slice(0, 5);
    lines.push(
      `  modified: ${shown.join(", ")}${snap.modifiedFiles.length > 5 ? ` ... and ${snap.modifiedFiles.length - 5} more` : ""}`,
    );
  }
  // PR7 — surface per-workstream verdicts when the cycle hit a
  // multi-workstream halt (PR3 fanout). renderHandoffMarkdown already
  // emits this section for GitHub; mirror to chat so the operator
  // doesn't have to click into the PR body to see which branch failed.
  const lastConverged = [...state.eventLog]
    .reverse()
    .find(
      (e): e is Extract<WorkEvent, { kind: "branches-converged" }> =>
        e.kind === "branches-converged",
    );
  if (lastConverged && lastConverged.verdicts.length > 0) {
    const okN = lastConverged.verdicts.filter((v) => v.ok).length;
    lines.push(
      "",
      `Workstream verdicts (${lastConverged.step} fanout, ${okN}/${lastConverged.verdicts.length} ok):`,
      ...lastConverged.verdicts.map((v) => `  ${v.id}: ${v.ok ? "ok" : "FAIL"}`),
    );
  }
  if (commentUrl) {
    lines.push(
      "",
      `GitHub handoff: ${commentUrl}`,
      `  label ${labelApplied ? "applied to" : "NOT applied to"} ${target}`,
    );
  }
  lines.push(
    "",
    "Artefacts:",
    `  rich body:   ${handoffBodyPath}`,
    `  state + log: ${repoRoot}/.pi/work-state/${issue}.json`,
    `  scratch:     ${scratchDirAbs}/  (preserved on handoff for inspection)`,
    "",
    "What to do next — pick one:",
  );
  // PR6 — explore-* caps halt before any branch/develop ran; the
  // "retry with longer cap" + "git push what's there" commands are
  // wrong (nothing was written; no work to push). Surface cap-shaped
  // recovery commands instead.
  if (cap === "explore-already-complete") {
    lines.push(
      "",
      "  # 1. Verify by reading the issue + the explore report:",
      `     gh issue view ${issue}  &&  cat ${handoffBodyPath}`,
      "",
      "  # 2. If you agree the issue is done, close it:",
      `     gh issue close ${issue} --comment "Verified complete by /work — see prior PR"`,
      "",
      "  # 3. If you disagree, add context and re-run /work:",
      `     gh issue comment ${issue} --body "Additional context: <what /work missed>"`,
      `     rm ${repoRoot}/.pi/work-state/${issue}.json && pi`,
      "",
      "  # 4. Abandon the handoff entry (no code was written; safe to discard):",
      `     rm ${repoRoot}/.pi/work-state/${issue}.json`,
    );
  } else if (cap === "explore-needs-clarification") {
    lines.push(
      "",
      "  # 1. Read what explore couldn't determine:",
      `     cat ${handoffBodyPath}`,
      "",
      "  # 2. Edit the issue body to add the missing acceptance criteria / scope:",
      `     gh issue edit ${issue}`,
      "",
      "  # 3. Re-run /work once the issue is clearer:",
      `     rm ${repoRoot}/.pi/work-state/${issue}.json && pi`,
      "",
      "  # 4. Abandon the handoff entry:",
      `     rm ${repoRoot}/.pi/work-state/${issue}.json`,
    );
  } else if (cap === "explore-bodies-empty") {
    const failed = ps.emptyBodyIssues ?? [];
    const failedList = failed.map((f) => `#${f.issue}`).join(", ") || `#${issue}`;
    const probeIssue = failed[0]?.issue ?? issue;
    lines.push(
      "",
      "Empty/error body fetches:",
      ...failed.map((f) => `  #${f.issue} — ${f.reason}`),
      "",
      "  # 1. Confirm gh auth + version (most common cause: projectCards GraphQL deprecation in older gh):",
      "     gh auth status && gh --version",
      "",
      "  # 2. Probe a failing issue via REST (works when `gh issue view` is broken):",
      `     gh api repos/<owner>/<repo>/issues/${probeIssue} --jq .body | head`,
      "",
      "  # 3. If gh issue view is hijacked, check for a misbehaving gh extension:",
      "     gh extension list",
      "",
      `  # 4. Once fixed, re-run /work — the cycle halts cleanly with no code written for ${failedList}:`,
      `     rm ${repoRoot}/.pi/work-state/${issue}.json && pi`,
    );
  } else if (cap === "step-back-revise-spec") {
    const sb = [...state.eventLog]
      .reverse()
      .find(
        (e): e is Extract<WorkEvent, { kind: "step-back-completed" }> =>
          e.kind === "step-back-completed",
      );
    lines.push(
      "",
      "Step-back analysis:",
      `  SDD element underspecified: ${sb?.sddElement ?? "(not parsed)"}`,
      `  Diagnosis: ${sb?.diagnosis ?? "(not parsed)"}`,
      "",
      "Proposed revision (preview — full text in the GitHub handoff body):",
      `  ${(sb?.proposedRevision ?? "(not parsed)").slice(0, 160)}${(sb?.proposedRevision?.length ?? 0) > 160 ? "..." : ""}`,
      "",
      "  # 1. Read the proposed revision + handoff context:",
      `     cat ${handoffBodyPath}`,
      "",
      "  # 2. Revise the issue body via /plan (or gh issue edit):",
      `     /plan ${issue}    # or: gh issue edit ${issue}`,
      "",
      "  # 3. Restart /work from scratch against the revised spec:",
      `     /work ${issue} --restart`,
      "",
      "  # 4. Abandon this cycle entirely:",
      `     rm ${repoRoot}/.pi/work-state/${issue}.json`,
    );
  } else if (cap === "commit-pr-incomplete-consolidation") {
    const missing = ps.incompleteConsolidation ?? [];
    lines.push(
      "",
      "Missing workstreams from the committed diff:",
      ...missing.map(
        (m) =>
          `  ${m.id} — paths not in diff: ${m.paths.slice(0, 3).join(", ")}${m.paths.length > 3 ? "..." : ""}`,
      ),
      "",
      "  # 1. Inspect each missing workstream's worktree:",
      ...missing.map(
        (m) => `     git -C ${repoRoot}/.worktrees/issue-${issue}-${m.id} status --porcelain`,
      ),
      "",
      "  # 2. Apply each missing diff to the integration branch:",
      ...missing.map(
        (m) =>
          `     git -C ${repoRoot}/.worktrees/issue-${issue}-${m.id} diff HEAD | git -C ${repoRoot} apply --index`,
      ),
      "",
      "  # 3. Verify, commit, push:",
      `     git -C ${repoRoot} diff --name-only --cached`,
      `     git -C ${repoRoot} commit -m '<concise>' && git -C ${repoRoot} push`,
      "",
      "  # 4. Or: abandon + restart from scratch:",
      `     rm ${repoRoot}/.pi/work-state/${issue}.json && /work ${issue} --restart`,
    );
  } else {
    lines.push(
      "",
      "  # 1. Inspect what survived before deciding:",
      `     git -C ${repoRoot} status && git -C ${repoRoot} diff --stat`,
      "",
      "  # 2. Retry with a longer per-spawn cap (use if dispatches kept timing out):",
      `     export PI_ENSEMBLE_SPAWN_TIMEOUT_MS_DEVELOPER=5400000 && rm ${repoRoot}/.pi/work-state/${issue}.json && pi`,
      "",
      "  # 3. Abandon the cycle, keep the worktree changes for manual takeover:",
      `     rm ${repoRoot}/.pi/work-state/${issue}.json`,
      "",
      `  # 4. Take over manually — commit + push what's there, open the PR yourself:`,
      `     cd ${repoRoot} && git add -p && git commit && git push -u origin ${branchName}`,
    );
  }
  return lines.join("\n");
}

/**
 * PR10 — Parse a `merge-commit: <sha>` marker line from ops's merge reply.
 * Lenient: accepts surrounding markdown (`**merge-commit:**`), backticks,
 * and the 7+ hex-char SHA shape `gh pr merge` prints. Returns undefined
 * when no marker is present (the merge still succeeded; we just lost the
 * SHA for the merged event payload).
 */
export function parseMergeCommit(text: string | undefined): string | undefined {
  if (!text) return undefined;
  // Lenient: anchor on `merge-commit`, then allow ANY non-hex characters
  // (markdown emphasis, colons, backticks, whitespace) up to the SHA.
  // The SHA itself is the only required structural element. Per-line
  // (multiline mode) so a multi-line ops reply can have the marker
  // anywhere on its own line.
  const m = text.match(/^[ \t]*[*_`]*\s*merge-commit\b[^0-9a-f\n]*([0-9a-f]{7,40})[^0-9a-f\n]*$/im);
  return m?.[1];
}

/**
 * Step 9 — Merge the PR. PR10: was a 0ms state mutation pre-fix; now
 * actually dispatches ops to run `gh pr merge` per project policy.
 *
 * Empirical bug fixed: pre-PR10 the driver reported "MERGED ✓" while
 * the GitHub PR sat OPEN (live evidence /work 561 + /work 562 on
 * lantern). The doctrine in pi-prompts/work.md:277 ("On green CI +
 * APPROVED review: merge per project merge policy") declared the
 * intent; nothing executed it. runMerged now closes that gap.
 *
 * On dispatch failure: STEP_FAILURE_POLICY[merged] is HALT (changed
 * from DEGRADED_OK), so the post-step dispatch-failed router (PR5)
 * intercepts → cap-hit 'step-failed:merged' → handoff. Operator
 * merges manually with the recovery command in the handoff body.
 *
 * On dispatch success: capture the merge-commit SHA (if ops emits the
 * marker line); flip status='merged'.
 */
async function runMerged(ctx: DriverContext, state: WorkState, now: number): Promise<WorkState> {
  const prNumber = state.pipelineState.prNumber ?? 0;
  const issues = activeIssuesOf(state);
  const next = await runSingleDispatch(ctx, state, "merged", "ops", "ops:merge", now, () =>
    inlineMergePrompt(issues, prNumber, scratchDir(ctx.repoRoot, state.issue)),
  );
  const last = next.eventLog[next.eventLog.length - 1];
  if (last?.kind !== "dispatch-completed") return next;
  const mergeCommit = parseMergeCommit(last.summary);
  return {
    ...next,
    pipelineState: { ...next.pipelineState, currentStep: "merged", status: "merged" },
    eventLog: [...next.eventLog, { kind: "merged", at: Date.now(), prNumber, mergeCommit }],
  };
}

/**
 * Build a dispatch-completed (or dispatch-failed-provider / dispatch-
 * failed) event from a DispatchResult. Handles the claim-check threshold
 * for large summaries.
 */
async function buildCompletionEvent(
  ctx: DriverContext,
  step: WorkStep,
  role: string,
  label: string,
  result: DispatchResult,
): Promise<
  Extract<
    Parameters<typeof appendEvent>[1],
    {
      kind: "dispatch-completed" | "dispatch-failed-provider" | "dispatch-failed";
    }
  >
> {
  const at = Date.now();
  const jobId = result.transcriptPath ? path.basename(result.transcriptPath, ".json") : "unknown";

  if (result.errorStop) {
    return {
      kind: "dispatch-failed-provider",
      step,
      role,
      jobId,
      label,
      ms: result.ms,
      at,
      providerMessage: result.errorStop.message,
      transcriptPath: result.transcriptPath,
    };
  }
  if (!result.ok) {
    return {
      kind: "dispatch-failed",
      step,
      role,
      jobId,
      label,
      ms: result.ms,
      at,
      exitCode: result.exitCode ?? null,
      errorTail: result.text?.slice(-200),
    };
  }

  // ABORT detection (PR2): the subagent's PROCESS exited 0 but it
  // refused the requested action (dirty worktree, --ff-only refusal, etc).
  // Without this check, branch step's "**ABORT: Working tree is not
  // clean**" on issue #553 was recorded as success and the driver
  // continued develop on main with 41 untracked files. Treat the abort
  // as dispatch-failed so the driver's existing fail-path halts cleanly.
  const abortLine = parseAbort(result.text);
  if (abortLine) {
    return {
      kind: "dispatch-failed",
      step,
      role,
      jobId,
      label,
      ms: result.ms,
      at,
      exitCode: result.exitCode ?? null,
      errorTail: abortLine.slice(0, 500),
    };
  }

  // Successful completion. Spill large text bodies to a claim-check
  // artifact under .pi/work-state/<issue>/<jobId>.txt so the state file
  // stays small.
  const text = result.text ?? "";
  let summary: string | undefined;
  let artifactPath: string | undefined;
  if (Buffer.byteLength(text, "utf8") > ARTIFACT_THRESHOLD_BYTES) {
    artifactPath = await writeDispatchArtifact(ctx.repoRoot, ctx.issue, jobId, text);
  } else {
    summary = text;
  }
  return {
    kind: "dispatch-completed",
    step,
    role,
    jobId,
    label,
    ok: true,
    ms: result.ms,
    at,
    transcriptPath: result.transcriptPath,
    summary,
    artifactPath,
  };
}

/**
 * Generic single-dispatch helper used by every step body whose shape is
 * "append step-started → dispatch one subagent → append completion event".
 * Steps that need to emit additional events (adversarial verdicts, lens
 * verdicts, CI status) implement their own runX and call dispatchCore
 * directly.
 */
async function runSingleDispatch(
  ctx: DriverContext,
  state: WorkState,
  step: WorkStep,
  role: string,
  label: string,
  now: number,
  buildPrompt: () => string,
  opts?: { timeoutMs?: number },
): Promise<WorkState> {
  const next = appendEvent(
    { ...state, pipelineState: { ...state.pipelineState, currentStep: step } },
    { kind: "step-started", step, at: now },
  );
  const dispatch = ctx.dispatchFn ?? dispatchCore;
  const startedAt = Date.now();
  let result: DispatchResult;
  try {
    // PR15 — per-call timeout override (routed through dispatchCore's
    // existing timeoutMs support that PR5 added for the 3-min handoff-ops
    // path). runCi uses this to lift the 10-min ops default up to 30 min
    // (env-overridable) since `gh run watch` blocks until CI completes
    // and CI runs regularly exceed 10 min. Empirical: 3× ops-CI-poll
    // timeouts this session before PR15.
    result = await dispatch(
      ctx.pi,
      { role, prompt: buildPrompt() },
      { label, timeoutMs: opts?.timeoutMs },
    );
  } catch (err) {
    return appendEvent(next, {
      kind: "dispatch-failed",
      step,
      role,
      jobId: "unknown",
      label,
      ms: Date.now() - startedAt,
      at: Date.now(),
      errorTail: (err as Error).message?.slice(-200),
    });
  }
  const event = await buildCompletionEvent(ctx, step, role, label, result);
  return appendEvent(next, event);
}

/**
 * Boilerplate appended to every inline prompt. Tells the subagent where
 * the project-local scratch dir is so they don't drop diffs, screenshots,
 * capture scripts, analysis files at the repo root (the empirical pollution
 * pattern from lantern issue #553 — 12 dot-prefixed diff files, 2 PNG
 * screenshots at root, scratch test_string_error.rs, etc).
 *
 * Both `./tmp/` (project-local, gitignored via .git/info/exclude) and
 * `/tmp/` (host-level) are acceptable. The driver creates and points at
 * the project-local path by default because it survives /tmp cleanup
 * policies and stays alongside the worktree for inspection on handoff.
 */
function scratchHygieneSection(scratchDirAbs: string): string {
  return [
    "",
    "## Scratch files",
    "",
    "Write any ephemeral artefacts (diff snapshots between adversarial rounds,",
    "captured screenshots, analysis outputs, one-off verification scripts) under:",
    "",
    `  ${scratchDirAbs}`,
    "",
    "Do NOT write scratch to the repo root or any tracked directory. Acceptable",
    "alternatives are `/tmp/pi-ensemble/...` (host-level). When this dispatch",
    "ends, leave the scratch dir in place — the work-driver removes it on a",
    "successful merge and keeps it on handoff for the user to inspect.",
  ].join("\n");
}

/**
 * Step 1 explore prompt. PR3 Pattern 1 fetched the body in PARALLEL
 * with the explore dispatch — but the prompt never inlined the body
 * content or pointed at the cached artifact path, so the agent's
 * verdict committed BEFORE the fetch settled and the agent never had
 * the body to read. Empirical false-NEEDS_CLARIFICATION cap-hits on
 * v0.12.12's `/work 563 565` (and prior #561) had verdict reasons
 * literally "Issue body not provided - awaiting driver to deliver
 * issue content".
 *
 * PR13 fixes the race: driver fetches bodies as a BARRIER before this
 * prompt is built, and the bodies are EMBEDDED inline below. The
 * agent reads them directly — no race, no agency-dependence, no
 * "trust the driver to deliver" footgun.
 */
function inlineExplorePrompt(
  issues: number[],
  scratchDirAbs: string,
  bodies: Array<{ issue: number; body: string; truncated: boolean }> = [],
): string {
  const headline = issues.length === 1 ? `issue #${issues[0]}` : `issues #${issues.join(", #")}`;
  const verdictBlock =
    issues.length === 1
      ? [
          "  - a verdict (heading: `## Verdict`), one line, EXACTLY one of:",
          "      `VERDICT: NEEDS_WORK`           — issue is open and has real work to do",
          "      `VERDICT: ALREADY_COMPLETE`     — issue is closed, merged, or already satisfied by a prior PR",
          "      `VERDICT: NEEDS_CLARIFICATION`  — issue is ambiguous, contradictory, or missing acceptance criteria",
        ]
      : [
          "  - a per-issue verdict block (heading: `## Verdict`), ONE line per issue with EXACTLY one verdict and an optional reason after `—`:",
          "      ```",
          "      ## Verdict",
          ...issues.map(
            (n) =>
              `      - #${n}: NEEDS_WORK | ALREADY_COMPLETE | NEEDS_CLARIFICATION  — <optional one-line reason>`,
          ),
          "      ```",
          "    The driver parses each line and routes per-issue. NEEDS_WORK issues proceed into plan/branch/develop; ALREADY_COMPLETE / NEEDS_CLARIFICATION are dropped (surfaced in the PR body + handoff). If EVERY issue is dropped, the cycle halts at handoff before any code is written.",
        ];
  const verdictDoctrine =
    issues.length === 1
      ? "The `## Verdict` block is LOAD-BEARING. If you conclude the issue is already done (e.g., a prior PR addressed it), say `VERDICT: ALREADY_COMPLETE` even if the issue is still technically open in the tracker — the driver routes on your verdict, not on the issue's status. On ALREADY_COMPLETE or NEEDS_CLARIFICATION the driver halts immediately and hands off to the operator; no plan/branch/develop will run."
      : "The `## Verdict` block is LOAD-BEARING per issue. Mark each issue with the verdict you'd give if it were the only one in scope; the driver merges the active subset and runs ONE bundled PR with `Fixes #N` for each active issue.";
  // PR13 — embed each issue body inline. This is the agent's source of
  // truth for what each issue needs; reading these BEFORE answering the
  // verdict prevents the false NEEDS_CLARIFICATION cap-hit pattern.
  const bodyBlock =
    bodies.length > 0
      ? [
          "",
          "---",
          "## Issue bodies (read these to determine your verdict)",
          "",
          ...bodies.flatMap(({ issue, body, truncated }) => [
            `### Issue #${issue}${truncated ? " (truncated — full body cached on disk; see scratch dir if needed)" : ""}`,
            "",
            "```",
            body,
            "```",
            "",
          ]),
        ].join("\n")
      : "";

  return [
    `/work ${headline} — Step 1 (Reconnaissance). The driver has fetched and embedded each issue body below — read those to determine the verdict; you do NOT need to re-fetch via \`gh issue view\`.`,
    "",
    `Gather context relevant to executing ${issues.length === 1 ? "this issue" : "these issues together"}:`,
    "  1. `vipune list --json | jq -r '.[] | .memory_type' | sort -u` to discover project memory types,",
    "  2. `vipune search '<keywords-from-issue-title-or-body>' --hybrid --recency 0.3 --limit 8` for prior decisions,",
    "  3. `codebase_memory_search_code({query: '<concept>'})` for existing relevant code.",
    "",
    "Return a STRUCTURED summary the work-driver can route on:",
    ...verdictBlock,
    "  - parallel-workstream candidates (heading: `## Workstreams`),",
    "  - relevant prior decisions (heading: `## Prior decisions`),",
    "  - touchpoint files (heading: `## Touchpoints`).",
    "",
    verdictDoctrine,
    bodyBlock,
    scratchHygieneSection(scratchDirAbs),
  ].join("\n");
}

/**
 * Step 2 (plan) prompt. PR3: explicitly asks for `## Workstreams` —
 * matches the parser in `parseWorkstreams`. Single-workstream issues
 * return one `### default` entry (or zero, which the driver synthesises).
 * Cribbed from `pi-prompts/plan.md` Phase 2's type-conditional
 * decomposition philosophy.
 */
function inlinePlanPrompt(issues: number[], scratchDirAbs: string): string {
  const headline = issues.length === 1 ? `issue #${issues[0]}` : `issues #${issues.join(", #")}`;
  return [
    `/work ${headline} — Step 2 (Decomposition).`,
    "",
    `The driver has already cached ${issues.length === 1 ? "the issue body" : "each issue body"} and Step 1's explore report. Read ${issues.length === 1 ? "both" : "all of them"}, then decide:`,
    "",
    "  1. Does this issue decompose into 2+ INDEPENDENT workstreams that could run in parallel worktrees?",
    "  2. Workstreams are independent when they touch DISJOINT files / subsystems / concerns. A frontend fix + a docs update = independent. Two changes to the same module = NOT independent.",
    "  3. Bias toward SINGLE-WORKSTREAM when in doubt. Parallelism is for genuinely separable work; over-decomposition compounds review cost.",
    "",
    "Return your reasoning, then a fenced workstreams block. Format MUST match exactly:",
    "",
    "```markdown",
    "## Workstreams",
    "",
    "### default — <one-line scope label>",
    "- paths: <comma-separated touchpoint files>",
    "- out-of-scope: <comma-separated explicit exclusions — what NOT to touch>",
    "```",
    "",
    "For N>1 workstreams, repeat the `###` subheading per workstream (use short ids like `task-a`, `task-b`). The `out-of-scope` line is LOAD-BEARING — issue #553 polluted PR #556 with off-scope files because nothing told the developer what was OUT. Fence the scope explicitly even when you think it's obvious.",
    "",
    "If single-workstream, ALWAYS use `### default` so the driver routes through the same code path uniformly.",
    scratchHygieneSection(scratchDirAbs),
  ].join("\n");
}

function inlineBranchPrompt(
  issues: number[],
  workstreamIds: string[],
  scratchDirAbs: string,
): string {
  const multi = workstreamIds.length > 1;
  const multiIssue = issues.length > 1;
  const primary = issues[0] ?? 0;
  const headline = multiIssue ? `issues #${issues.join(", #")}` : `issue #${primary}`;
  const branchHint = multiIssue
    ? `feature/issues-${issues.join("-")}-<brief-description>`
    : `feature/issue-${primary}-<brief-description>`;
  const worktreePrefix = multiIssue
    ? `.worktrees/issues-${issues.join("-")}`
    : `.worktrees/issue-${primary}`;
  const lines = [
    `/work ${headline} — Step 3 (Setup). Create the feature branch under the safety preconditions below.`,
    "",
    "  1. Identify the mainline branch (default `main`; detect via `git symbolic-ref refs/remotes/origin/HEAD | sed 's@^refs/remotes/origin/@@'`).",
    "  2. Verify clean working tree (`git status --porcelain` must be empty). If dirty, ABORT and surface the failure verbatim — do NOT branch off uncommitted work.",
    "  3. Fetch + fast-forward mainline (`git fetch origin && git checkout <mainline> && git pull --ff-only origin <mainline>`). If --ff-only fails, ABORT.",
    `  4. Create branch \`${branchHint}\` from the fresh mainline tip.`,
    "  5. End your reply with a single line `branch: <branch-name>` so the driver can capture it.",
  ];
  if (multi) {
    lines.push(
      "",
      `  6. **Multi-workstream cycle** — Step 2 decomposed the active issue${multiIssue ? "s" : ""} into ${workstreamIds.length} workstreams (${workstreamIds.join(", ")}). Create one git worktree per workstream off the feature branch:`,
      "",
      ...workstreamIds.map(
        (id) =>
          `       git worktree add ${worktreePrefix}-${id} ${branchHint.replace("<brief-description>", "<brief>")}`,
      ),
      "",
      "  7. End your reply with an additional fenced `## Worktrees` block mapping each workstream id to its absolute path:",
      "",
      "       ```markdown",
      "       ## Worktrees",
      "",
      ...workstreamIds.map((id) => `       - ${id}: <absolute-path-to-worktree>`),
      "       ```",
      "",
      "       Use `git rev-parse --show-toplevel` from inside each worktree to get the absolute path. The driver parses this block to wire up Step 4's per-workstream developer dispatches.",
    );
  } else {
    lines.push(
      "",
      "Single-workstream cycle — do NOT create worktrees. The driver records the repo root as the `default` workstream's path automatically.",
    );
  }
  lines.push(scratchHygieneSection(scratchDirAbs));
  return lines.join("\n");
}

function inlineDevelopPrompt(
  issues: number[],
  scratchDirAbs: string,
  workstream?: { id: string; scope: string; paths: string[]; outOfScope: string[] },
  workstreamId?: string,
  speculativeContextPath?: string,
): string {
  // PR11 — multi-issue cycles must show the developer the ACTIVE issues
  // (NEEDS_WORK subset after explore), not the primary cycle issue. The
  // pre-PR11 hardcoded `ctx.issue` told developers to fetch + work on
  // `issues[0]` even when activeIssues = [different]; on the v10r
  // incident this is how PR #483 ended up implementing #479's --config
  // work while labelled `fix(#476)`.
  const headline = issues.length === 1 ? `issue #${issues[0]}` : `issue(s) #${issues.join(", #")}`;
  const lines = [`/work ${headline} — Step 4 (Implementation).`, ""];
  if (workstream && workstreamId && workstreamId !== "default") {
    // Multi-workstream branch — anchor scope explicitly so this developer
    // doesn't drift into another workstream's territory. The out-of-scope
    // fence addresses the issue #553 scope-contamination pattern.
    lines.push(
      `**Workstream: \`${workstream.id}\`** — one of multiple developers running in parallel for this ${issues.length === 1 ? "issue" : "set of issues"}.`,
      `Scope: ${workstream.scope}`,
      workstream.paths.length > 0
        ? `In-scope files: ${workstream.paths.join(", ")}`
        : "In-scope files: derive from the scope description above.",
      workstream.outOfScope.length > 0
        ? `**OUT OF SCOPE — do NOT touch**: ${workstream.outOfScope.join(", ")}`
        : "Stay tightly focused on the scope; other workstreams handle the rest.",
      "",
    );
  }
  const fetchInstr =
    issues.length === 1
      ? `\`gh issue view ${issues[0]}\` to re-fetch the issue body (acceptance criteria, DoD).`
      : `Re-fetch each active issue body — run \`gh issue view <N>\` for each of: ${issues.map((n) => `#${n}`).join(", ")}.`;
  lines.push(
    `  1. ${fetchInstr}`,
    "  2. Implement the change end-to-end in the current branch. Run local quality gates (typecheck, lint, tests as the project defines them).",
    "  3. Do NOT commit. Do NOT push. Leave the changes uncommitted in the working directory — ops commits in Step 6 after the adversarial gate.",
    "  4. End your reply with a `## Touched files` section listing every file you changed and a one-line `## Summary`.",
    "",
    "Discourage drive-by edits; only touch files in scope.",
  );
  if (speculativeContextPath) {
    lines.push(
      "",
      "## Speculative context — read when you reach a decision point",
      "",
      "An explore subagent ran in parallel with this dispatch to surface context Step 1 may have missed (test patterns at the touchpoints, related API surface, similar prior fixes). When it lands it writes to:",
      "",
      `  ${speculativeContextPath}`,
      "",
      "Consult this file when you hit a decision point you're unsure about (test framework conventions, API shape, prior-art patterns). It's CONTEXT, not instructions — your scope is unchanged. Absent or empty file = the parallel explore had nothing new to surface; proceed without it.",
    );
  }
  lines.push(scratchHygieneSection(scratchDirAbs));
  return lines.join("\n");
}

/**
 * Step 4 speculative explore prompt (PR4 Pattern 3 restoration). Runs in
 * Promise.all alongside the developer; writes its findings to a scratch
 * file the developer's prompt names. Returns a brief one-liner so the
 * dispatch event has a useful summary; the heavy content goes to the
 * scratch file so the dispatch report stays small.
 */
function inlineSpeculativeExplorePrompt(
  issues: number[],
  workstream: { id: string; scope: string; paths: string[]; outOfScope: string[] } | undefined,
  contextPath: string,
  scratchDirAbs: string,
): string {
  const headline = issues.length === 1 ? `issue #${issues[0]}` : `issue(s) #${issues.join(", #")}`;
  const scopeBlurb = workstream
    ? `Workstream \`${workstream.id}\` scope: ${workstream.scope}. In-scope files: ${workstream.paths.join(", ") || "(derive from scope)"}.`
    : `${headline}.`;
  return [
    `/work ${headline} — Step 4 speculative context.`,
    "",
    "You are running IN PARALLEL with a developer working on the change. Your job is to surface context the developer may benefit from:",
    "  - test patterns at the touchpoints (how does the project structure its tests for this area?)",
    "  - related API surface (what functions/types nearby will the change interact with?)",
    "  - similar prior fixes (vipune / git log for the same module — what did past changes look like?)",
    "  - non-obvious constraints (rate limits, perf budgets, doctrine notes)",
    "",
    scopeBlurb,
    "",
    `Write your findings to: \`${contextPath}\` (overwrite if it exists).`,
    "Keep it under 200 lines — terse, actionable, with file:line references. NOT a tutorial; the developer is competent.",
    "",
    "End your reply with a one-line summary (e.g., `wrote 14 KB of context covering test fixtures + auth flow`). Do NOT include the full content in your reply — it goes to the file.",
    "",
    "Speculative: if there's genuinely nothing useful to surface (the developer already has full context from Step 1), write a one-line `(no additional context worth surfacing)` to the file and return.",
    scratchHygieneSection(scratchDirAbs),
  ].join("\n");
}

function inlineCommitPrPrompt(
  issues: number[],
  droppedIssues: Array<{ issue: number; verdict: string; reason: string }>,
  worktrees: Record<string, string>,
  workstreams: Record<string, { id: string; scope: string; paths: string[]; outOfScope: string[] }>,
  branchName: string,
  scratchDirAbs: string,
): string {
  const headline = issues.length === 1 ? `issue #${issues[0]}` : `issues #${issues.join(", #")}`;
  const fixesLines = issues.map((n) => `Fixes #${n}`).join("\\n");
  const fixesNote =
    issues.length === 1
      ? `body MUST include \`Fixes #${issues[0]}\` so merge auto-closes the issue.`
      : `body MUST include ONE \`Fixes #N\` line per active issue (\`${issues.map((n) => `Fixes #${n}`).join("\\n")}\`) so merge auto-closes them all.`;
  const droppedNote =
    droppedIssues.length > 0
      ? [
          "",
          "  Multi-issue cycle: include a `Companion to` line in the PR body for each issue dropped by explore (these will NOT auto-close on merge — the operator handles them separately):",
          ...droppedIssues.map(
            (d) =>
              `    - Companion to #${d.issue} (${d.verdict}: ${d.reason || "no reason given"}; left untouched).`,
          ),
        ]
      : [];

  // PR14 — multi-workstream cycles need explicit consolidation. Each
  // worktree has its own uncommitted slice of the work (developer prompt
  // Step 3 says "Do NOT commit"); ops's job here is to gather ALL of
  // them onto the integration branch before pushing. Pre-PR14 the prompt
  // was single-tree shaped, ops only committed the cwd's slice, and
  // sibling worktrees' changes were silently lost.
  const ids = Object.keys(worktrees).filter((id) => id !== "default" || worktrees[id]);
  const isMultiWorktree = ids.length > 1;

  if (isMultiWorktree) {
    const worktreeLines = ids.flatMap((id) => {
      const ws = workstreams[id];
      const path = worktrees[id] ?? "(no path)";
      const scope = ws?.scope ?? "(no scope captured)";
      const paths = ws?.paths.length ? ws.paths.join(", ") : "(no paths declared)";
      return [
        `  - **${id}** at \`${path}\``,
        `      scope: ${scope}`,
        `      in-scope paths: ${paths}`,
      ];
    });
    return [
      `/work ${headline} — Step 6 (Commit + PR). **Multi-workstream cycle** — ${ids.length} workstreams.`,
      "",
      "Each developer worked in its own worktree and left changes UNCOMMITTED per Step 4 doctrine. Your job is to consolidate every worktree's slice onto the integration branch BEFORE pushing — otherwise the sibling workstreams' work is silently dropped (the v0.12.13 /work 577 failure mode).",
      "",
      `Integration branch: \`${branchName}\``,
      "",
      "Workstream worktrees (each contains uncommitted developer work):",
      ...worktreeLines,
      "",
      `  1. **Verify each worktree has uncommitted work.** Run \`git -C <path> status --porcelain | head\` for each of the ${ids.length} worktrees. If any worktree shows clean status (no uncommitted changes), the developer didn't write — STOP, report which workstream, and DO NOT proceed.`,
      "",
      `  2. **Consolidate each worktree's diff onto the integration branch.** Capture each worktree's diff and apply it on the integration branch's working tree (the repo root if it's checked out on \`${branchName}\`, else \`cd\` into a worktree that is). Concrete recipe per workstream:`,
      "       ```",
      `       git -C <worktree-path> diff HEAD > tmp/issue-${issues[0]}/<workstream-id>.patch`,
      `       git apply --index tmp/issue-${issues[0]}/<workstream-id>.patch`,
      "       ```",
      `     Repeat for ALL ${ids.length} workstreams. Use \`git apply --check\` first if you want to dry-run.`,
      "",
      `  3. **Verify the staged set includes files from ALL ${ids.length} workstreams.** Run \`git diff --name-only --cached\` and confirm each workstream's in-scope paths appear. The driver re-runs this check after your dispatch via \`git diff --name-only origin/<base>..HEAD\` — if any workstream's paths are entirely absent, the cycle halts with cap \`commit-pr-incomplete-consolidation\` and the operator has to investigate. Catch it here first to save the round-trip.`,
      "",
      `  4. \`git commit -m "<concise subject>"\` with a meaningful message. Body should reference all active issues + summarise the ${ids.length} workstreams' contributions.`,
      `  5. \`git push -u origin ${branchName}\`.`,
      `  6. \`gh pr create --title "<title>" --body "...\\n\\n${fixesLines}"\` — ${fixesNote}`,
      "  7. End your reply with `pr: <PR-number>` so the driver can capture it.",
      ...droppedNote,
      "",
      "If you need a longer PR body, write it to a file under the scratch dir and pass via `gh pr create --body-file <path>` — DO NOT write the body file to the repo root.",
      scratchHygieneSection(scratchDirAbs),
    ].join("\n");
  }

  // N=1 (or no worktrees populated): existing single-tree flow. No churn
  // for the common case.
  return [
    `/work ${headline} — Step 6 (Commit + PR).`,
    "",
    "  1. `git status --porcelain` to confirm the developer left uncommitted changes.",
    "  2. `git add` the changed files (avoid `git add -A` — keep the staged set explicit).",
    '  3. `git commit -m "<concise subject>"` with a meaningful message. Body should reference the active issue(s).',
    `  4. \`git push -u origin ${branchName}\`.`,
    `  5. \`gh pr create --title \"<title>\" --body \"...\\n\\n${fixesLines}\"\` — ${fixesNote}`,
    "  6. End your reply with `pr: <PR-number>` so the driver can capture it.",
    ...droppedNote,
    "",
    "If you need a longer PR body, write it to a file under the scratch dir and pass via `gh pr create --body-file <path>` — DO NOT write the body file to the repo root.",
    scratchHygieneSection(scratchDirAbs),
  ].join("\n");
}

function inlineLensFixPrompt(findings: string, scratchDirAbs: string): string {
  return [
    "Address the six-pass review findings below against the diff currently on this worktree.",
    "",
    "  - Make the minimal change per finding. Group by file.",
    "  - Run local quality gates before declaring complete.",
    "  - Do NOT touch unrelated code.",
    "  - Do NOT commit. Leave the changes uncommitted.",
    "",
    "Findings (JSON-encoded array of {path, line, severity, title, suggestion}):",
    "```json",
    findings,
    "```",
    scratchHygieneSection(scratchDirAbs),
  ].join("\n");
}

/**
 * PR10 — Step 9 (Merge) ops prompt. The merge step was a 0ms no-op
 * pre-PR10; this prompt finally drives ops to execute `gh pr merge`.
 *
 * Doctrine: target project's `AGENTS.md` / `CONTRIBUTING.md` is the
 * source of truth for merge method (--squash / --merge / --rebase) and
 * branch-cleanup policy. Driver doesn't try to second-guess. Default
 * is `--squash --delete-branch` because that's the most common policy
 * in the projects pi-ensemble runs against (verified in lantern's
 * AGENTS.md §7); ops overrides per project doc when present.
 */
function inlineMergePrompt(issues: number[], prNumber: number, scratchDirAbs: string): string {
  const issueList = issues.map((n) => `#${n}`).join(", ");
  const issueLines = issues
    .map((n) => `  - issue #${n} (auto-closes via the PR's Fixes line)`)
    .join("\n");
  return [
    `/work issue(s) ${issueList} — Step 9 (Merge).`,
    "",
    "CI is green and lens-review APPROVED. Merge the PR per project policy:",
    "",
    "  1. Read `AGENTS.md` / `CONTRIBUTING.md` at repo root for the project's merge method (`--squash`, `--merge`, or `--rebase`) and whether to delete the branch.",
    `  2. \`gh pr merge ${prNumber} --squash --delete-branch\` is the DEFAULT — adjust the flags to match the project's policy if it differs.`,
    "  3. On success, `gh pr merge` prints the merge commit SHA. End your reply with `merge-commit: <sha>` so the driver captures it on the merged event.",
    "  4. If the merge fails (auth, branch protection, conflicts, missing required review), report the gh error verbatim and end with `merge-commit: FAILED — <one-line reason>` — DO NOT retry. The driver routes failures through cap-hit handoff.",
    "",
    "Active issues that will auto-close on merge:",
    issueLines,
    "",
    "After the merge succeeds, the driver runs no further steps — the cycle terminates with status='merged'.",
    scratchHygieneSection(scratchDirAbs),
  ].join("\n");
}

function inlineStepBackPrompt(issue: number, findings: string, scratchDirAbs: string): string {
  return [
    `Don't review THIS diff. Take a step back and consider whether the SPEC for issue #${issue} has a problem.`,
    "",
    `Original issue: gh issue view ${issue} (read it).`,
    "Recurring rejection pattern across multiple lens-review rounds:",
    "```",
    findings.slice(0, 4000),
    "```",
    "",
    "Which of these six SDD spec elements appears underspecified?",
    '  1. Outcomes — acceptance criteria, what "done" looks like',
    "  2. Scope boundaries — what's in / out of scope",
    "  3. Constraints — technical / system / invariants",
    "  4. Prior decisions — why X was chosen over Y; what previous decisions this depends on",
    "  5. Task breakdown — sub-task structure, ordering, dependencies",
    "  6. Verification criteria — what proves it's done",
    "",
    "Return:",
    "  - `sddElement:` <one of the six>",
    "  - `diagnosis:` <one-sentence>",
    "  - `proposedRevision:` <verbatim text to add to the issue body>",
    "  - `alternativeApproach:` <optional>",
    scratchHygieneSection(scratchDirAbs),
  ].join("\n");
}

/**
 * Step 7g handoff dispatch prompt. PR4 completes the v1 skeleton: the
 * driver builds the handoff markdown body (renderHandoffMarkdown) and
 * writes it to a scratch file; ops invokes `gh pr comment` / `gh issue
 * comment` against that file, applies the `needs-human-attention` label
 * (creating it if absent), and returns the comment URL.
 */
function inlineHandoffOpsPrompt(
  issue: number,
  prNumber: number | undefined,
  bodyPath: string,
  scratchDirAbs: string,
): string {
  const target = prNumber ? `pr ${prNumber}` : `issue ${issue}`;
  const commentCmd = prNumber
    ? `gh pr comment ${prNumber} --body-file ${bodyPath}`
    : `gh issue comment ${issue} --body-file ${bodyPath}`;
  const editCmd = prNumber
    ? `gh pr edit ${prNumber} --add-label needs-human-attention`
    : `gh issue edit ${issue} --add-label needs-human-attention`;
  return [
    `/work issue #${issue} — Step 7g (Cap-hit handoff). The driver hit a deterministic loop cap and is handing off to the user. Post the structured comment + apply the label.`,
    "",
    "  1. Ensure the `needs-human-attention` label exists in this repo. If not, create it:",
    '     `gh label create needs-human-attention --color FFAA00 --description "Agent loop hit a cap; human review required"`',
    '     (skip if already exists; ignore the "already exists" error)',
    "",
    `  2. Post the handoff comment on ${target}:`,
    `     \`${commentCmd}\``,
    "",
    "  3. Apply the label:",
    `     \`${editCmd}\``,
    "",
    `  4. The body file is at: \`${bodyPath}\` (already populated by the driver — DO NOT modify or regenerate).`,
    "",
    "  5. End your reply with the GitHub URL of the comment you just created (the canonical `…#issuecomment-<id>` form `gh` prints when posting succeeds). The driver parses this to surface it in the final scrollback line.",
    "",
    "On any failure (gh auth, network, label-create), surface the error verbatim and continue with whatever steps are still possible.",
    scratchHygieneSection(scratchDirAbs),
  ].join("\n");
}

function inlineCiPrompt(issue: number, scratchDirAbs: string): string {
  return [
    `/work issue #${issue} — Step 8 (CI monitoring).`,
    "",
    "  1. Find the latest workflow run for the feature branch — `gh run list --branch <branch> --limit 1 --json status,conclusion,databaseId,url`.",
    '  2. If the run is still in progress: prefer `gh run watch <id>` (blocks until CI completes). PR15 — the driver now allows this dispatch up to 30 min by default (env-tunable via `PI_ENSEMBLE_CI_WATCH_TIMEOUT_MS`); pre-PR15 the ops 10-min cap SIGTERM\'d `gh run watch` mid-stream for real CI runs. If `gh run watch` fails or the run needs longer than the cap, fall back to a bounded poll: `while true; do status=$(gh run view <id> --json status,conclusion --jq \'.status + ":" + (.conclusion // "")\'); case $status in completed:success|completed:failure|completed:cancelled) break;; esac; sleep 30; done`.',
    "  3. On success: end your reply with the line `ci-status: success` (driver routes to merge).",
    "  4. On failure: end your reply with `ci-status: failure` AND include the failing-job summary so the developer round that follows has the failure context.",
    "",
    "The driver parses the last line of your reply for the `ci-status:` token — keep it exact.",
    scratchHygieneSection(scratchDirAbs),
  ].join("\n");
}

/**
 * Error thrown by `runStep` when the step's body is staged for a later
 * commit. The smoke test asserts these are thrown for the unimplemented
 * steps; the live /work handler catches them and falls back to legacy
 * PM-driven flow until the step body lands.
 */
export class DriverNotImplementedError extends Error {
  constructor(public readonly step: WorkStep) {
    super(`work-driver: step "${step}" is not yet implemented in this build`);
    this.name = "DriverNotImplementedError";
  }
}

/**
 * Run the driver loop for one /work cycle. Reads / creates the state file,
 * loops over steps via `nextStep()`, persists after every transition,
 * surfaces final outcome (handoff or merged) to the user via
 * `pi.sendUserMessage`.
 *
 * Fire-and-forget contract: callers in `commands.ts` start this via
 * `void runWorkDriver(...).catch(reportFatal)`. The handler returns
 * immediately; the loop runs in the background.
 *
 * Status: skeleton — only `explore`, `plan`, `handoff`, and `merged` are
 * wired today. Other steps throw `DriverNotImplementedError`; the handler
 * catches and falls back to the legacy work.md flow until the rest of the
 * step bodies land.
 */
export async function runWorkDriver(ctx: DriverContext): Promise<void> {
  // PR12 — `/work N --restart`: skip readState and start fresh from
  // `initialState(issue)`. Used after the operator revises the issue
  // body via /plan (or gh issue edit) following a prior terminal cycle
  // (handoff / aborted / merged). Branch step's existing-branch logic
  // handles worktree leftovers at runtime; this flag only wipes the
  // driver's state file.
  let state =
    ctx.restart === true
      ? initialState(ctx.issue)
      : ((await readState(ctx.repoRoot, ctx.issue)) ?? initialState(ctx.issue));
  if (ctx.restart === true) {
    trace(`work-driver: --restart wiped state for issue #${ctx.issue} (fresh cycle)`);
  }
  // PR10 — persist the full multi-issue list on first run. On resume,
  // honour what's already in the file (the user may have continued a
  // single-issue cycle by re-invoking /work N; we don't widen scope
  // silently). Only fresh state files (issues===undefined) take the
  // ctx.issues list. On --restart, the freshly-initialised state has
  // issues===undefined so the ctx.issues list flows through.
  if (ctx.issues && ctx.issues.length > 0 && state.issues === undefined) {
    state = { ...state, issues: ctx.issues };
  }

  // PR12 — surface a clear notify when /work re-invocation finds the
  // state already terminal (handoff / aborted / merged) and the
  // operator didn't pass --restart. Pre-PR12 this silently fell
  // through to the end of the function — the operator saw nothing
  // and PM ended up recommending /do as a workaround.
  if (state.pipelineState.status !== "running" && ctx.restart !== true) {
    const terminalStatus = state.pipelineState.status;
    ctx.pi.sendUserMessage(
      `pi-ensemble: /work for issue #${ctx.issue} already terminated as ${terminalStatus}. To start a fresh cycle (e.g., after revising the issue via /plan), re-run with --restart:\n  /work ${ctx.issue} --restart\nOr rm ${workStateDir(ctx.repoRoot)}/${ctx.issue}.json manually. The prior cycle's event log is preserved in the state file until you restart or remove it.`,
    );
    return;
  }

  // Detect a half-written state (resume hazard). v1 policy: refuse to
  // resume cleanly; surface to user and halt.
  const inconsistencies = detectInconsistencies(state);
  if (inconsistencies.length > 0) {
    const detail = inconsistencies.join("\n  - ");
    trace(`work-driver: state inconsistencies detected for issue ${ctx.issue}:\n  - ${detail}`);
    ctx.pi.sendUserMessage(
      `pi-ensemble /work driver halted on issue #${ctx.issue}: state-file inconsistencies detected.\n  - ${detail}\nInspect ${workStateDir(ctx.repoRoot)}/${ctx.issue}.json or rm to start fresh (your git work is unaffected; only the workflow tracker state is removed).`,
    );
    return;
  }

  // Persist the initial state on first run so the user can see the file
  // appear and PI_ENSEMBLE_WORK_DRIVER=0 fallback knows a cycle exists.
  await writeState(ctx.repoRoot, state);

  // PR2 fold-in (post-#553 cleanup): set up the project-local scratch
  // dir + ensure tmp/ is in .git/info/exclude so subagents have a known
  // hygienic place to write diff snapshots, screenshots, capture
  // scripts, analysis outputs. The inline prompts thread the absolute
  // path into each subagent's instructions.
  const tmpDir = await setupWorkspaceTmp(ctx.repoRoot, ctx.issue);
  trace(`work-driver: scratch dir for issue #${ctx.issue}: ${tmpDir}`);

  let safety = 0;
  while (state.pipelineState.status === "running") {
    safety++;
    if (safety > 64) {
      // Defence against an unbounded transition loop — never expected to
      // fire under normal use (each step settles or escalates to handoff).
      // If it does fire, the state file captures the path so the user can
      // inspect.
      trace(`work-driver: safety break after 64 iterations for issue ${ctx.issue}`);
      state = {
        ...state,
        pipelineState: { ...state.pipelineState, status: "aborted" },
      };
      await writeState(ctx.repoRoot, state);
      ctx.pi.sendUserMessage(
        `pi-ensemble /work driver aborted on issue #${ctx.issue}: transition safety limit reached. ` +
          `Inspect ${workStateDir(ctx.repoRoot)}/${ctx.issue}.json for the state.`,
      );
      return;
    }
    const step = state.pipelineState.currentStep;
    // Step-level lifecycle event (PR2 O1): emits "▶ step N/9 X started"
    // to scrollback BEFORE the step body runs. Adversarial and lens-
    // review steps that bypass dispatchCore (and therefore don't fire
    // per-dispatch lifecycle events) become visible here.
    const stepOrd = STEP_ORDINAL[step] ?? { num: 0, total: 9 };
    const stepStartedAt = Date.now();
    // PR4 sub-round labels: steps that iterate (adversarial / lens-review /
    // lens-fix / re-entered develop) get a `(round N)` suffix in scrollback
    // so the user can distinguish first-pass from third-pass at a glance.
    // First entry (round=1) shows no suffix — formatLine suppresses it.
    const stepRound = countPriorStepStarts(state, step) + 1;
    lifecycle.emitStepStarted(step, stepOrd.num, stepOrd.total, stepRound);
    // PR2 O2: update the footer status cursor — distinct from the deck,
    // which shows individual subagent children. The cursor shows the
    // driver's step-level position with live-tick elapsed.
    workWidget.update(state, stepStartedAt);
    try {
      state = await runStep(ctx, state, step);
    } catch (err) {
      if (err instanceof DriverNotImplementedError) {
        trace(
          `work-driver: ${err.message} — falling back to PM-driven flow not yet implemented; halting`,
        );
        state = {
          ...state,
          pipelineState: { ...state.pipelineState, status: "aborted" },
        };
        await writeState(ctx.repoRoot, state);
        lifecycle.emitStepFailed(
          step,
          stepOrd.num,
          stepOrd.total,
          Date.now() - stepStartedAt,
          "step not implemented",
          stepRound,
        );
        ctx.pi.sendUserMessage(
          `pi-ensemble /work driver halted: step "${err.step}" not yet implemented in this build. Run with PI_ENSEMBLE_WORK_DRIVER=0 to use the legacy PM-driven flow.`,
        );
        return;
      }
      // Spawn-level / unexpected error — mark aborted with the error.
      trace(`work-driver: step "${step}" threw: ${(err as Error).message}`);
      state = {
        ...state,
        pipelineState: { ...state.pipelineState, status: "aborted" },
      };
      await writeState(ctx.repoRoot, state);
      lifecycle.emitStepFailed(
        step,
        stepOrd.num,
        stepOrd.total,
        Date.now() - stepStartedAt,
        (err as Error).message?.slice(0, 80),
        stepRound,
      );
      ctx.pi.sendUserMessage(
        `pi-ensemble /work driver aborted on step "${step}" for issue #${ctx.issue}: ` +
          `${(err as Error).message}`,
      );
      return;
    }
    // Step completed — figure out if it ended in a step-failure-shaped
    // event so the lifecycle line marks failure even though runStep
    // didn't throw. Most-recent event drives the decision.
    {
      const lastEvent = state.eventLog[state.eventLog.length - 1];
      const elapsed = Date.now() - stepStartedAt;
      if (lastEvent?.kind === "dispatch-failed" || lastEvent?.kind === "dispatch-failed-provider") {
        const reason =
          lastEvent.kind === "dispatch-failed-provider"
            ? "provider error"
            : (lastEvent.errorTail?.slice(0, 60) ?? "subagent failed");
        lifecycle.emitStepFailed(step, stepOrd.num, stepOrd.total, elapsed, reason, stepRound);
      } else if (lastEvent?.kind === "cap-hit") {
        lifecycle.emitStepFailed(
          step,
          stepOrd.num,
          stepOrd.total,
          elapsed,
          `cap-hit: ${lastEvent.cap}`,
          stepRound,
        );
      } else {
        // Sum tokens from any dispatch-completed events that fired during
        // this step. Approximate but useful — exact accounting per step
        // would require time-window filtering of usage events.
        let totalTokens: number | undefined;
        if (lastEvent?.kind === "dispatch-completed" && lastEvent.summary !== undefined) {
          // Driver-owned dispatches don't surface usage on the completion
          // event; leave undefined and let the per-dispatch line carry it.
          totalTokens = undefined;
        }
        lifecycle.emitStepCompleted(
          step,
          stepOrd.num,
          stepOrd.total,
          elapsed,
          totalTokens,
          stepRound,
        );
      }
    }
    await writeState(ctx.repoRoot, state);

    // PR5 halt-cascade router. Intercept dispatch-failed at HALT-class
    // steps BEFORE nextStep() — the existing linear table has no
    // dispatch-failed branch and would silently advance the cycle into
    // wasted downstream work (the #553 cascade root).
    {
      const tail = state.eventLog[state.eventLog.length - 1];
      const isDispatchFail =
        tail?.kind === "dispatch-failed" || tail?.kind === "dispatch-failed-provider";
      if (isDispatchFail) {
        const policy = STEP_FAILURE_POLICY[step];
        if (policy === "HALT") {
          // Recognise SIGTERM-on-developer as a distinct cap shape so
          // explainCap() can produce the right operator-facing sentence.
          const errorTail = tail.kind === "dispatch-failed" ? (tail.errorTail ?? "") : "";
          const isTimeout = /killed after \d+ms timeout/.test(errorTail);
          const cap =
            step === "develop" && isTimeout
              ? ("developer-timeout" as const)
              : (`step-failed:${step}` as const);
          state = appendEvent(state, {
            kind: "cap-hit",
            at: Date.now(),
            cap,
            reviewRound: state.pipelineState.reviewRound,
            nextStep: "handoff",
          });
          // Set currentStep='handoff' but LEAVE status='running' so the
          // loop re-enters and runs runHandoff. runHandoff's final block
          // sets status based on the cap shape (mid-flight failure →
          // 'aborted', cap-hit verdict → 'handoff').
          state = {
            ...state,
            pipelineState: { ...state.pipelineState, currentStep: "handoff" },
          };
          await writeState(ctx.repoRoot, state);
          trace(
            `work-driver: HALT on step="${step}" → cap="${cap}" → handoff (status set in runHandoff)`,
          );
          continue;
        }
        if (policy === "RETRY_ONCE") {
          const attempts = state.pipelineState.retryAttempts ?? {};
          const used = attempts[step] ?? 0;
          if (used < 1) {
            state = {
              ...state,
              pipelineState: {
                ...state.pipelineState,
                retryAttempts: { ...attempts, [step]: used + 1 },
              },
            };
            await writeState(ctx.repoRoot, state);
            const reason =
              tail.kind === "dispatch-failed-provider"
                ? "provider error"
                : (tail.errorTail?.slice(0, 60) ?? "subagent failed");
            lifecycle.emitStepRetry(step, stepOrd.num, stepOrd.total, used + 2, reason);
            trace(`work-driver: RETRY_ONCE on step="${step}" (attempt ${used + 2})`);
            continue; // re-run same step on next loop iteration
          }
          // Retry exhausted → HALT via the same cap shape. Same
          // pattern as the HALT branch above — leave status='running'
          // so the loop runs runHandoff next; runHandoff sets the
          // terminal status based on the cap shape.
          state = appendEvent(state, {
            kind: "cap-hit",
            at: Date.now(),
            cap: `step-failed:${step}` as const,
            reviewRound: state.pipelineState.reviewRound,
            nextStep: "handoff",
          });
          state = {
            ...state,
            pipelineState: { ...state.pipelineState, currentStep: "handoff" },
          };
          await writeState(ctx.repoRoot, state);
          trace(
            `work-driver: RETRY_ONCE exhausted on step="${step}" → handoff (status set in runHandoff)`,
          );
          continue;
        }
        // DEGRADED_OK: existing fall-through is correct (no-op here).
      }
    }

    // PR7 — multi-workstream halt-cascade router. PR3 emits
    // `branches-converged` for N>1 fanouts (develop, lens-review).
    // The PR5 dispatch-failed router above only watches single-dispatch
    // tails, so all-branches-failed silently advanced into wasted
    // adversarial + lens-review (the /work 553 2026-06-24 re-test:
    // 3-of-3 develop branches provider-errored mid-stream, driver
    // advanced into adversarial APPROVAL of empty diff and lens-review
    // against header-only "diff").
    //
    // Doctrine: ANY failed branch on a HALT-class step routes to
    // handoff. Partial success on multi-workstream is not a meaningful
    // input downstream — /work.md's out-of-scope fence doctrine implies
    // a failed branch leaves the broader decomposition incoherent.
    {
      const tail = state.eventLog[state.eventLog.length - 1];
      if (tail?.kind === "branches-converged" && tail.verdicts.length > 0) {
        const anyFailed = tail.verdicts.some((v) => !v.ok);
        const policy = STEP_FAILURE_POLICY[step];
        if (anyFailed && policy === "HALT") {
          state = appendEvent(state, {
            kind: "cap-hit",
            at: Date.now(),
            cap: `step-failed:${step}` as const,
            reviewRound: state.pipelineState.reviewRound,
            nextStep: "handoff",
          });
          state = {
            ...state,
            pipelineState: { ...state.pipelineState, currentStep: "handoff" },
          };
          await writeState(ctx.repoRoot, state);
          const failedCount = tail.verdicts.filter((v) => !v.ok).length;
          trace(
            `work-driver: HALT on step="${step}" — ${failedCount}/${tail.verdicts.length} branches failed → handoff`,
          );
          continue;
        }
        // RETRY_ONCE doesn't apply to multi-workstream fanouts (no step
        // in STEP_FAILURE_POLICY that fans out is RETRY_ONCE — develop
        // is HALT, lens-review N>1 path uses the same N>1 fanout but
        // its retry semantics are handled internally by runLensReview).
        // DEGRADED_OK: fall-through.
      }
    }

    // Capture which step just completed BEFORE the nextStep transition
    // clobbers currentStep. This is the routing input the adversarial-
    // approved branch needs to distinguish "from develop" vs "from
    // lens-fix" (PR #239 routed on currentStep which was already wrong).
    const completedStep = state.pipelineState.currentStep;
    const decision = nextStep(state);
    if (decision === "done") break;
    if (decision !== state.pipelineState.currentStep) {
      state = {
        ...state,
        pipelineState: {
          ...state.pipelineState,
          lastCompletedStep: completedStep,
          currentStep: decision,
        },
      };
      await writeState(ctx.repoRoot, state);
    }
  }

  // Clear the footer status cursor (PR2 O2). Stale cursors after a
  // cycle ends are worse than no cursor — the user might think a /work
  // is still running when it isn't.
  workWidget.clear();

  // Cleanup scratch dir on success only — handoff/aborted KEEP the dir
  // so the user can inspect what the agents produced when something
  // went wrong. Failure modes (no dir, perm error) log via trace and
  // continue silently — final user message is the priority.
  const final = state.pipelineState.status;
  if (final === "merged") {
    await teardownWorkspaceTmp(ctx.repoRoot, ctx.issue);
  }

  // PR5: rich operator handoff message. Replaces the PR4-and-earlier
  // ~150-char pointer-to-JSON. The aborted status (set by the halt-
  // cascade router in the post-step block) routes through the SAME
  // renderer as handoff — the cap-hit event already encodes whether
  // this was a mid-flight failure or a cap-hit, and renderHandoffUserMessage
  // distinguishes them.
  if (final === "merged") {
    ctx.pi.sendUserMessage(`pi-ensemble /work for issue #${ctx.issue} — MERGED ✓`);
  } else if (final === "handoff" || final === "aborted") {
    ctx.pi.sendUserMessage(
      renderHandoffUserMessage(state, ctx.repoRoot, scratchDir(ctx.repoRoot, ctx.issue)),
    );
  }
}
