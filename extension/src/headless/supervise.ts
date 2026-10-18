/**
 * headless/supervise — a `work` run's result survives a runner that dies
 * (#1591).
 *
 * The runner writes its stdout result once, at the end. A runner that dies
 * natively — Bun aborts when it cannot create a thread, which a container at
 * its `pids.max` produces — writes nothing, so the host got an empty `--json`
 * result for a cycle that had already opened its PR. No JavaScript handler
 * runs on such an abort, so the only place that can still answer is another
 * process.
 *
 * `cli.ts` therefore runs `work` as a child of itself (marked by
 * SUPERVISED_ENV) and holds its stdout. When the child exits with a result,
 * that result is passed through unchanged with the child's exit code. When it
 * exits without one, the supervisor projects each issue from its state file —
 * which the driver persists at every step boundary and before every dispatch —
 * and reports `error.code: "crash"` with exit 30. stderr (the NDJSON progress
 * stream) is inherited and never touched.
 *
 * SIGTERM / SIGINT / SIGHUP are forwarded to the child, so the interrupt
 * contract (run.ts) is unchanged. Setting `PI_ENSEMBLE_HEADLESS_SUPERVISED=1`
 * runs `work` in-process, without a supervisor.
 */

import { spawn } from "node:child_process";
import { resourceReport } from "../resource-budget.ts";
import { isTerminalState, readState, workStateFile } from "../workflow-state.ts";
import { readBuildCommit, readBuildVersion } from "./build.ts";
import { EXIT, exitCodeForState } from "./exit-code.ts";
import { type IssueResult, notStartedResult, projectIssue, resultDocument } from "./result.ts";

export const SUPERVISED_ENV = "PI_ENSEMBLE_HEADLESS_SUPERVISED";

const FORWARDED = ["SIGTERM", "SIGINT", "SIGHUP"] as const;

export interface SuperviseOptions {
  repoRoot: string;
  issues: number[];
  json: boolean;
  /** The child's argv: `[command, ...args]`. Defaults to re-running this CLI. */
  command: string[];
  write?: (s: string) => void;
}

/** Each issue as its state file shows it; a non-terminal state exits 30. */
async function projectFromState(repoRoot: string, issues: number[]): Promise<IssueResult[]> {
  const out: IssueResult[] = [];
  for (const issue of issues) {
    const file = workStateFile(repoRoot, issue);
    const state = await readState(repoRoot, issue).catch(() => undefined);
    if (!state) {
      out.push(notStartedResult(issue, file, EXIT.crash));
      continue;
    }
    const code = isTerminalState(state) ? exitCodeForState(state) : EXIT.crash;
    out.push({ ...projectIssue(state, file), exitCode: code });
  }
  return out;
}

/** Run `work` in a child and return the exit code to use. */
export async function superviseWork(opts: SuperviseOptions): Promise<number> {
  const write = opts.write ?? ((s: string) => process.stdout.write(s));
  const [cmd, ...args] = opts.command as [string, ...string[]];
  const child = spawn(cmd, args, {
    env: { ...process.env, [SUPERVISED_ENV]: "1" },
    stdio: ["inherit", "pipe", "inherit"],
  });
  const forward = (sig: NodeJS.Signals) => () => child.kill(sig);
  const handlers = FORWARDED.map((sig) => [sig, forward(sig)] as const);
  for (const [sig, h] of handlers) process.on(sig, h);
  const chunks: Buffer[] = [];
  child.stdout.on("data", (c: Buffer) => chunks.push(c));
  const exit = await new Promise<{ code: number | null; signal: string | null; error?: Error }>(
    (resolve) => {
      child.on("error", (error) => resolve({ code: null, signal: null, error }));
      child.on("close", (code, signal) => resolve({ code, signal }));
    },
  );
  for (const [sig, h] of handlers) process.off(sig, h);
  const out = Buffer.concat(chunks).toString("utf8");
  if (out.trim() !== "") {
    write(out);
    return exit.code ?? EXIT.crash;
  }
  const how = exit.error
    ? `could not start: ${exit.error.message}`
    : exit.signal
      ? `died with ${exit.signal}`
      : `exited ${exit.code} without a result`;
  const message = `the runner process ${how}; each issue is projected from its state file`;
  const results = await projectFromState(opts.repoRoot, opts.issues);
  if (opts.json) {
    const doc = resultDocument(
      { exitCode: EXIT.crash, results, error: { code: "crash", message } },
      { commit: readBuildCommit(), version: readBuildVersion() },
    );
    write(`${JSON.stringify({ ...doc, resources: resourceReport() })}\n`);
  } else {
    const parts = results.map((r) => `#${r.issue} ${r.status} (exit ${r.exitCode})`);
    write(`pi-rukas-headless: ${parts.join(", ")}\nerror: crash — ${message}\n`);
  }
  return EXIT.crash;
}
