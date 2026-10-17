/**
 * Shared fixtures for the #1398 draft-rearm tests (split from
 * test-draft-rearm-1398.ts for the 500-line cap, AGENTS.md §12).
 *
 * Everything here is offline: a fake forge whose draft/ready/comment reads are
 * scripted, and a fake git exec answering exactly the four commands
 * `currentPatchIdentity` runs. The point of the fakes is that they let a test
 * state what the FORGE says independently of what the STATE says — the
 * divergence between those two is the whole defect #1398 fixes.
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import type { Forge } from "../../src/forge.ts";
import { lensResidualsMarker } from "../../src/merge-guard-round-cap.ts";
import type { DriverContext } from "../../src/work-driver-context.ts";
import {
  type WorkEvent,
  type WorkState,
  appendEvent,
  initialState,
} from "../../src/workflow-state.ts";

export const ISSUE = 1398;
export const BRANCH = "fix/issue-1398-draft-rearm";
export const PR = 42;
const MERGE_BASE = "1111111111111111111111111111111111111111";
/** The patch-id the fake git computes for the branch — the disclosure's key. */
export const PATCH = "3f2a9c1e0b7d4a58f6c1e0d9b8a7c6d5e4f3a2b1";
export const OTHER_PATCH = "aaaa111122223333444455556666777788889999";
export const at = (n: number) => 1_000_000 + n;
export const fakePi = { sendUserMessage: () => undefined } as unknown as ExtensionAPI;

export function mkAssert(): { assert: (cond: boolean, msg: string) => void; status: () => number } {
  let failed = 0;
  return {
    assert: (cond, msg) => {
      if (cond) console.log(`✓ ${msg}`);
      else {
        console.error(`✗ ${msg}`);
        failed = 1;
      }
    },
    status: () => failed,
  };
}

// ── the event shapes, in the order `nextStep` actually routes them ──────────
export type Step =
  | "lens-review"
  | "develop"
  | "ci"
  | "commit-pr"
  | "adversarial"
  | "lens-fix"
  | "handoff";
export const started = (step: Step, n: number): WorkEvent => ({
  kind: "step-started",
  step,
  at: at(n),
});
export const approved = (n: number): WorkEvent => ({
  kind: "lens-approved",
  at: at(n),
  jobId: "j",
  round: 1,
});
export const issuesFound = (n: number, verdict = "ISSUES_FOUND"): WorkEvent => ({
  kind: "lens-issues-found",
  at: at(n),
  jobId: "j",
  round: 1,
  verdict,
  findings: "- [MEDIUM] src/a.ts:1 — title (SIMPLICITY)",
  totalFindings: 1,
});
export const ciFailure = (n: number): WorkEvent => ({
  kind: "ci-status",
  at: at(n),
  status: "failure",
});
export const posted = (n: number, patchId = PATCH): WorkEvent => ({
  kind: "lens-residuals-posted",
  at: at(n),
  round: 1,
  prNumber: PR,
  branch: BRANCH,
  patchId,
  // #1398 round 3 — the marker the disclosure comment carries. Required on the
  // event: the fact must never license a ready the PR cannot show, and the row
  // states the bytes the PR was supposed to carry
  // (test-draft-disclosure-carries-marker-1398.ts audits it).
  marker: lensResidualsMarker(BRANCH, patchId),
  target: "pr",
});
export const dispatchFailed = (n: number): WorkEvent => ({
  kind: "dispatch-failed",
  at: at(n),
  jobId: "j",
  role: "developer",
  error: "provider timeout",
});

export function state(
  events: WorkEvent[],
  prDraft?: WorkState["pipelineState"]["prDraft"],
): WorkState {
  const s = initialState(ISSUE, at(0));
  return appendEvent(
    {
      ...s,
      pipelineState: {
        ...s.pipelineState,
        prNumber: PR,
        branchName: BRANCH,
        currentStep: "lens-review",
        prDraft,
      },
    },
    ...events,
  );
}

/**
 * The same state with `reviewRound` set — the round the draft re-arm's bound
 * keys on (#1398 round 3). A test of the bound has to name the round it is in,
 * because the counter is per round rather than per cycle.
 */
export function withRound(s: WorkState, reviewRound: number): WorkState {
  return { ...s, pipelineState: { ...s.pipelineState, reviewRound } };
}

/** The CI loop, ended where the review is about to run again. */
export const ciLoop: WorkEvent[] = [
  started("commit-pr", 1),
  started("lens-review", 2),
  approved(3),
  started("ci", 4),
  ciFailure(5),
  started("develop", 6),
  started("adversarial", 7),
  started("commit-pr", 8),
  started("lens-review", 9),
];

/** The four commands `currentPatchIdentity` runs, all answered. */
export function gitFake(patchId = PATCH) {
  const seen: string[] = [];
  const execFn = (async (cmd: string) => {
    seen.push(cmd);
    if (cmd.startsWith("git symbolic-ref")) return { stdout: "main\n" };
    if (cmd.startsWith("git config --get remote.origin.url"))
      return { stdout: "https://github.com/o/r\n" };
    if (cmd.startsWith("git merge-base")) return { stdout: `${MERGE_BASE}\n` };
    if (cmd.includes("git patch-id")) return { stdout: `${patchId} (stdin)\n` };
    return { stdout: "" };
  }) as unknown as NonNullable<DriverContext["verifyExecFn"]>;
  return { execFn, seen };
}

export type ForgeOpts = {
  isDraft?: boolean;
  draftFails?: string;
  /**
   * What the forge reports AFTER the draft command — the read-back. Defaults to
   * the post-command truth (`true` when the command succeeded, `undefined` when
   * it failed), which is what makes the re-arm's confirmation step testable:
   * a CLI that exits 0 without converting the PR reports `false` here.
   */
  isDraftAfterDraft?: boolean | "unknown";
  /** The PR's state field — "OPEN" unless a test wants a stale/closed number. */
  state?: string;
  headRefName?: string;
  /** The PR's comment bodies — what the disclosure check reads. */
  comments?: string[];
  /** Throw from `prView` — an unreadable PR, before any command runs. */
  viewFails?: string;
  /**
   * Throw from the `prView` that runs AFTER the draft command — the read that
   * is supposed to confirm the conversion. Distinct from `viewFails` because
   * the pre-command read succeeding is what lets the command run at all.
   */
  viewFailsAfterDraft?: boolean;
};

export function mkForge(opts: ForgeOpts = {}) {
  const calls: string[] = [];
  // What the NEXT `prView` answers. The draft command flips it, the way the
  // forge's own state does — so a test that wants the read-back to disagree
  // with the command sets `isDraftAfterDraft`.
  let viewIsDraft = opts.isDraft;
  // How many draft commands have been issued. A test asserting "no command ran"
  // reads this rather than `calls.includes("draft")`: the draft direction is
  // the inverse of `prReady`, so the ready path's own commands are counted too
  // and an earlier phase's `ready` would otherwise read as a re-arm having run.
  const draftIssued: { n: number } = { n: 0 };
  // The whole Forge surface is not scripted — only what the draft family
  // reads — so the stub is asserted against the interface rather than cast
  // through `unknown` (item 10): if one of these five signatures drifts, tsc
  // says so here instead of the test quietly calling a method that no longer
  // exists. Everything the tests never call is an explicit rejecting stub.
  const stub = (name: string) => async () => {
    throw new Error(`draft-rearm fixture: ${name} is not scripted`);
  };
  const forge = {
    forge: "github",
    host: "github.com",
    owner: "o",
    repo: "r",
    cwd: "/nonexistent",
    issueView: stub("issueView"),
    issueCreate: stub("issueCreate"),
    issueEdit: stub("issueEdit"),
    issueComment: stub("issueComment"),
    issueComments: stub("issueComments"),
    issueSearch: stub("issueSearch"),
    prList: stub("prList"),
    prCreate: stub("prCreate"),
    prMerge: stub("prMerge"),
    prDiff: stub("prDiff"),
    prChecks: stub("prChecks"),
    prComment: stub("prComment"),
    ciWatch: stub("ciWatch"),
    ciRun: stub("ciRun"),
    mergeReadiness: stub("mergeReadiness"),
    labels: stub("labels"),
    prView: async () => {
      calls.push("prView");
      if (opts.viewFails) throw new Error(opts.viewFails);
      // The read-back is the second view of a re-arm: the first answers the
      // pre-command question, every later one the confirmation.
      if (opts.viewFailsAfterDraft && calls.filter((c) => c === "prView").length > 1) {
        throw new Error("gh: HTTP 503 service unavailable");
      }
      return {
        number: PR,
        state: opts.state ?? "OPEN",
        headRefName: opts.headRefName ?? BRANCH,
        isDraft: viewIsDraft,
      };
    },
    prReady: async () => {
      calls.push("ready");
      viewIsDraft = false;
    },
    prDraft: async () => {
      calls.push("draft");
      draftIssued.n++;
      if (opts.draftFails) throw new Error(opts.draftFails);
      // "unknown" models the forge CLI that exits 0 and whose view then omits
      // the draft field entirely — the read-back says nothing.
      viewIsDraft =
        opts.isDraftAfterDraft === undefined
          ? true
          : opts.isDraftAfterDraft === "unknown"
            ? undefined
            : opts.isDraftAfterDraft;
    },
    prComments: async () => {
      calls.push("comments");
      return (opts.comments ?? []).map((body) => ({ body }));
    },
  } satisfies Partial<Forge> as Forge;
  return { forge, calls, draftIssued };
}

/**
 * A context whose forge cannot be resolved — the `skipped: "forge"` shape the
 * re-arm HALTS on.
 *
 * Why it is shaped this way: `forgeForCycle` hard-overrides detection with
 * `PI_ENSEMBLE_FORGE=github`, so a fake `verifyExecFn` cannot make detection
 * return "unknown" — it always builds an adapter. The real forge-less cycle is
 * one where resolving the adapter THROWS (`createForge` refuses an unknown
 * detection, and any detection failure lands in `resolveForge`'s catch and
 * yields `undefined`). A throwing `forge` getter reproduces exactly that: the
 * read throws inside `resolveForge`, it returns `undefined`, and the re-arm is
 * left with no adapter, no read and no command to hand the operator — which is
 * why that decline halts rather than proceeding.
 */
export function mkCtxWithoutForge(): DriverContext {
  const { execFn } = gitFake();
  const ctx = {
    host: fakePi,
    repoRoot: "/nonexistent",
    issue: ISSUE,
    verifyExecFn: execFn,
  } as Record<string, unknown>;
  Object.defineProperty(ctx, "forge", {
    get(): never {
      throw new Error("no forge configured for this repository");
    },
    enumerable: true,
  });
  return ctx as unknown as DriverContext;
}

export function mkCtx(forge: Forge, patchId = PATCH): DriverContext {
  const { execFn } = gitFake(patchId);
  return {
    host: fakePi,
    repoRoot: "/nonexistent",
    issue: ISSUE,
    forge,
    verifyExecFn: execFn,
  } as unknown as DriverContext;
}
