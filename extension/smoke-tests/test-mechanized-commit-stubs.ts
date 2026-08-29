/**
 * Shared stubs for mechanized commit-pr smoke tests.
 * Extracted from test-work-driver-mechanized-commit.ts to keep that file
 * under the 500-line hard cap (AGENTS.md §12).
 */

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import type { DispatchResult, DriverContext } from "../src/work-driver-context.ts";

// Minimal ExtensionAPI stub — only the methods runWorkDriver actually calls.
export function makeFakePi(): { pi: ExtensionAPI; sent: string[] } {
  const sent: string[] = [];
  const pi = {
    sendUserMessage: (content: unknown) => {
      sent.push(typeof content === "string" ? content : JSON.stringify(content));
    },
  } as unknown as ExtensionAPI;
  return { pi, sent };
}

// PR11 — default issue-body fetcher for tests.
export const mockIssueBodyOk = async (issue: number, _cwd: string) => ({
  stdout: `title:\tmock issue #${issue}\nstate:\tOPEN\n\nmock body for issue #${issue} — non-empty placeholder`,
});

// Fake DispatchResult builder.
export function mkResult(overrides: Partial<DispatchResult> = {}): DispatchResult {
  return {
    role: "explore",
    ok: true,
    text: "stub explore output",
    toolUses: [],
    ms: 100,
    exitCode: 0,
    transcriptPath: "/tmp/stub-transcript.json",
    ...overrides,
  };
}

// #297 — zero inter-attempt backoff for persistent-failure tests.
process.env.PI_ENSEMBLE_TRANSIENT_RETRY_BACKOFF_MS = "0";

// Offline-suite safety net: cap accidental live spawn at 2s.
process.env.PI_ENSEMBLE_SPAWN_TIMEOUT_MS = "2000";
process.env.PI_ENSEMBLE_INACTIVITY_TIMEOUT_MS = "2000";

// Shared fixture bits for the 3-workstream shape.
export const PLAN_REPLY = `## Workstreams

### task-a — fix module a
- paths: src/a.rs
- out-of-scope: docs

### task-b — fix module b
- paths: src/b.rs
- out-of-scope: docs

### task-c — fix module c
- paths: src/c.rs
- out-of-scope: docs
`;

export const branchReplyFor = (dir: string, issue: number) =>
  [
    `branch: feature/issue-${issue}`,
    "",
    "## Worktrees",
    "",
    `- task-a: ${dir}/wta`,
    `- task-b: ${dir}/wtb`,
    `- task-c: ${dir}/wtc`,
  ].join("\n");

export const mkDispatchFn =
  (dir: string, issue: number, opts?: { allowOpsCommitPr?: boolean }) =>
  async (
    _pi: unknown,
    spec: { role: string; prompt: string },
    dOpts?: { label?: string },
  ): Promise<DispatchResult> => {
    const label = dOpts?.label ?? spec.role;
    if (label === "explore") return mkResult({ text: "VERDICT: NEEDS_WORK" });
    if (label === "plan") return mkResult({ text: PLAN_REPLY });
    if (label === "ops") return mkResult({ role: "ops", text: branchReplyFor(dir, issue) });
    if (label.startsWith("developer"))
      return mkResult({ role: "developer", text: "done — implemented" });
    if (label === "ops:commit-pr") {
      if (opts?.allowOpsCommitPr)
        return mkResult({ role: "ops", text: "Committed and pushed.\npr: 556" });
      throw new Error("ops:commit-pr dispatched — mechanized path should have handled this");
    }
    if (label === "ops:ci") throw new Error("halt at ci: integration assertion boundary");
    if (label === "ops:handoff") return mkResult({ role: "ops", text: "Posted." });
    throw new Error(`unexpected dispatch: ${label}`);
  };

// Shared setup: create the .git/info directory for the test repo.
export async function setupTestRepo(dir: string): Promise<void> {
  await (await import("node:fs/promises")).mkdir(path.join(dir, ".git", "info"), {
    recursive: true,
  });
}
