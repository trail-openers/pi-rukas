import type { DispatchResult } from "../src/types.ts";
import type { DriverContext } from "../src/work-driver-context.ts";

// The branch-step exec stub: answers the git probes the mechanized branch
// setup + merge gate need, in the shapes those call sites expect.
export async function branchExecStub(cmd: string): Promise<{ stdout: string }> {
  if (cmd.includes("mergeStateStatus,mergeable,state"))
    return { stdout: '{"mergeStateStatus":"CLEAN","state":"OPEN"}' };
  if (cmd.includes("gh pr checks")) return { stdout: '[{"name":"ci","bucket":"pass"}]' };
  if (cmd.includes("gh pr view")) return { stdout: "MERGED\n" };
  if (cmd.includes("gh repo view"))
    return {
      stdout: '{"squashMergeAllowed":true,"mergeCommitAllowed":false,"rebaseMergeAllowed":false}',
    };
  if (cmd.includes("gh pr merge")) return { stdout: "Merged" };
  if (cmd.includes("symbolic-ref")) return { stdout: "origin/main\n" };
  if (cmd.includes("git diff")) return { stdout: "diff --git a/src/a.ts b/src/a.ts\n+line\n" };
  if (cmd.includes("git rev-parse")) return { stdout: "feature/issue-838\n" };
  return { stdout: "" };
}

// The parseable explore reply (INTENT-VERDICT + Spec) the driver's explore
// step routes on (bare prose would park the cycle — no-signal guard).
export const EXPLORE_REPLY = [
  "INTENT-VERDICT: proceed",
  "",
  "## Spec",
  "",
  "### Intent",
  "Implement the issue.",
  "",
  "### Deliverables",
  "- d1: implement the change [paths: src/a.ts]",
].join("\n");

export function mkDispatchResult(
  spec: { role: string },
  opts?: { label?: string },
): DispatchResult {
  const label = opts?.label ?? spec.role;
  return {
    role: spec.role,
    ok: true,
    text: spec.role === "explore" && label !== "plan" ? EXPLORE_REPLY : `mock ${spec.role} output`,
    toolUses: [],
    ms: 10,
    exitCode: 0,
    transcriptPath: "/tmp/stub.json",
  };
}

export function mkCycleCtx(
  dir: string,
  issue: number,
  dispatch: (
    pi: unknown,
    spec: { role: string; prompt: string },
    opts?: { label?: string },
  ) => Promise<DispatchResult>,
): DriverContext {
  return {
    repoRoot: dir,
    issue,
    pi: { sendUserMessage: () => {} } as unknown as DriverContext["pi"],
    dispatchFn: dispatch,
    issueBodyFetcherFn: async (i: number) => ({
      stdout: `title:\ttest #${i}\nstate:\tOPEN\n\nmock body for issue #${i} — non-empty placeholder`,
    }),
    mergeGrant: true,
  } as DriverContext;
}
