import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

async function main() {
  const dir = mkdtempSync(path.join(tmpdir(), "mech-debug-"));
  try {
    await (await import("node:fs/promises")).mkdir(path.join(dir, ".git", "info"), {
      recursive: true,
    });

    const { runWorkDriver } = await import("../src/work-driver.ts");
    const { readState } = await import("../src/workflow-state.ts");

    const calls: string[] = [];

    const mkResult = (overrides: Partial<DispatchResult> = {}): DispatchResult => ({
      role: "explore",
      ok: true,
      text: "stub",
      toolUses: [],
      ms: 100,
      exitCode: 0,
      transcriptPath: "/tmp/stub.json",
      ...overrides,
    });

    const exec = async (cmd: string, o?: { cwd?: string; maxBuffer?: number }) => {
      calls.push(cmd);
      if (cmd === "git rev-parse --abbrev-ref HEAD") return { stdout: "feature/issue-994\n" };
      if (cmd === "git rev-parse HEAD" && o?.cwd && o.cwd.endsWith("-task-a"))
        return { stdout: "aaa111aaa111aaa111aaa111aaa111aaa111aa\n" };
      if (cmd.startsWith("git rev-parse ")) return { stdout: "base123\n" };
      if (cmd.startsWith("git fetch origin")) return { stdout: "" };
      if (cmd.startsWith("git worktree add")) return { stdout: "" };
      if (cmd.startsWith("git worktree remove")) return { stdout: "" };
      if (cmd.startsWith("git status --porcelain")) {
        const worktreeAdds = calls.filter((c) => c.startsWith("git worktree add")).length;
        const cwd = o?.cwd ?? "";
        if (worktreeAdds < 1) return { stdout: "" };
        if (cwd.endsWith("-task-a")) return { stdout: " M src/a.rs\n" };
        return { stdout: "" };
      }
      if (cmd.startsWith("git rev-list --count base123")) return { stdout: "1\n" };
      if (cmd.startsWith("git cherry-pick")) return { stdout: "" };
      if (cmd.startsWith("git cat-file -p"))
        return { stdout: "tree head1deadbeefdeadbeefdeadbeefdeadbeef\nauthor T\n" };
      if (cmd.startsWith("git apply")) return { stdout: "" };
      if (cmd.startsWith("git commit")) return { stdout: "" };
      if (cmd.startsWith("git push")) return { stdout: "" };
      if (cmd.startsWith("gh pr create"))
        return { stdout: "https://github.com/owner/repo/pull/612\n" };
      if (cmd.startsWith("git symbolic-ref")) return { stdout: "main\n" };
      if (cmd.startsWith("git diff --name-only origin/")) return { stdout: "src/a.rs\n" };
      if (cmd.startsWith("gh pr view")) return { stdout: '{"state":"OPEN"}' };
      if (cmd.startsWith("git status --porcelain -z")) return { stdout: "" };
      return { stdout: "" };
    };

    const mkDispatchFn = async (
      _pi: unknown,
      spec: { role: string; prompt: string },
      dOpts?: { label?: string },
    ) => {
      const label = dOpts?.label ?? spec.role;
      if (label === "explore") return mkResult({ text: "VERDICT: NEEDS_WORK" });
      if (label === "plan")
        return mkResult({ text: "## Workstreams\n### task-a\n- paths: src/a.rs" });
      if (label === "ops")
        return mkResult({ text: `branch: feature/issue-994\n## Worktrees:\ntask-a: ${dir}/wta` });
      if (label.startsWith("developer")) return mkResult({ text: "done" });
      if (label === "ops:commit-pr") throw new Error("ops:commit-pr dispatched");
      if (label === "ops:ci") throw new Error("halt at ci");
      throw new Error(`unexpected: ${label}`);
    };

    const ctx = {
      pi: { sendUserMessage: () => {} } as unknown as ExtensionAPI,
      repoRoot: dir,
      issue: 994,
      issueBodyFetcherFn: async () => ({ stdout: "title:\ttest\nstate:\tOPEN\n\nbody" }),
      verifyExecFn: exec,
      adversarialLoopFn: async () => mkResult({ text: "APPROVED" }),
      dispatchFn: mkDispatchFn,
    };

    await runWorkDriver(ctx).catch(() => {});
    const after = await readState(dir, 994);

    console.log("=== COMMANDS ===");
    calls.forEach((c) => console.log(c));
    console.log("\n=== EVENTS ===");
    after?.eventLog.forEach((e) => console.log(`${e.kind}: ${e.step} (${e.role || "N/A"})`));
    console.log("\nprNumber:", after?.pipelineState.prNumber);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

main().catch(console.error);
