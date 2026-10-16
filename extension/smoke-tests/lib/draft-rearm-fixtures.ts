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
export type Step = "lens-review" | "develop" | "ci" | "commit-pr" | "adversarial" | "lens-fix" | "handoff";
export const started = (step: Step, n: number): WorkEvent => ({ kind: "step-started", step, at: at(n) });
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
  /** The PR's state field — "OPEN" unless a test wants a stale/closed number. */
  state?: string;
  headRefName?: string;
  /** The PR's comment bodies — what the disclosure check reads. */
  comments?: string[];
};

export function mkForge(opts: ForgeOpts = {}) {
  const calls: string[] = [];
  const forge = {
    forge: "github",
    prView: async () => {
      calls.push("prView");
      return {
        number: PR,
        state: opts.state ?? "OPEN",
        headRefName: opts.headRefName ?? BRANCH,
        isDraft: opts.isDraft,
      };
    },
    prReady: async () => void calls.push("ready"),
    prDraft: async () => {
      calls.push("draft");
      if (opts.draftFails) throw new Error(opts.draftFails);
    },
    prComments: async () => {
      calls.push("comments");
      return (opts.comments ?? []).map((body) => ({ body }));
    },
  } as unknown as Forge;
  return { forge, calls };
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
