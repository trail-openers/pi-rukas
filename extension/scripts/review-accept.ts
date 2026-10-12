#!/usr/bin/env bun
/**
 * review-accept — the operator accepts one recorded review finding (#1105).
 *
 *   bun extension/scripts/review-accept.ts <branch> <row-id> --reason "<text>"
 *
 * An accepted finding is suppressed from later review rounds for as long as
 * the code it cites is unchanged; a change to that code lapses the acceptance.
 * The operator's identity is `git config user.email` — it is recorded, not
 * asked for. The reason must be at least 20 characters and must not look like
 * a secret.
 *
 * Human-only, in layers:
 *   1. This script refuses to run in agent context: PI_ENSEMBLE_ROLE set, or the
 *      child env PI_ENSEMBLE_SUBAGENT_MODE=1 / PI_ENSEMBLE_TRUST_MODE=1.
 *   2. The write path (acceptRow) lives in scripts/review-accept-row.ts, which
 *      no src/ module imports (a smoke test asserts it).
 *   3. review-accept-guard.ts refuses agent bash that names this script, the
 *      findings file or the write module, and agent edit/write of the file.
 * Layers 1 and 3 are advisory in trust mode: they are environment and string
 * checks, so an agent with a shell can still bypass them. The guard is a
 * tripwire, not a security boundary.
 *
 * Exits non-zero on any refusal and writes nothing.
 */

import { execFile } from "node:child_process";
import path from "node:path";
import { promisify } from "node:util";
import { acceptRow, reasonProblem } from "./review-accept-row.ts";

export { MIN_REASON_CHARS, reasonProblem } from "./review-accept-row.ts";

const execFileP = promisify(execFile);

export interface AcceptArgs {
  branch: string;
  rowId: string;
  reason: string;
}

/**
 * The agent context this process runs in, or undefined for an operator shell.
 * PI_ENSEMBLE_ROLE is set for every spawned role; the two child-env flags mark
 * a subagent that was not given a role. An empty value counts as unset.
 */
export function agentContext(env: NodeJS.ProcessEnv): string | undefined {
  if (env.PI_ENSEMBLE_ROLE) return `PI_ENSEMBLE_ROLE=${env.PI_ENSEMBLE_ROLE} is set`;
  if (env.PI_ENSEMBLE_SUBAGENT_MODE === "1") return "PI_ENSEMBLE_SUBAGENT_MODE=1 is set";
  if (env.PI_ENSEMBLE_TRUST_MODE === "1") return "PI_ENSEMBLE_TRUST_MODE=1 is set";
  return undefined;
}

/** Parse argv (without node/script). A string is the usage error to show. */
export function parseAcceptArgs(argv: readonly string[]): AcceptArgs | string {
  const positional: string[] = [];
  let reason: string | undefined;
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i] ?? "";
    if (a === "--reason") {
      reason = argv[++i];
      if (reason === undefined) return "--reason needs a value";
    } else if (a.startsWith("--")) {
      return `unknown option ${a}`;
    } else {
      positional.push(a);
    }
  }
  if (positional.length !== 2) return "usage: review-accept.ts <branch> <row-id> --reason <text>";
  const [branch, rowId] = positional as [string, string];
  if (!/^[0-9a-f]{8}$/.test(rowId))
    return `row id must be 8 lowercase hex characters, got "${rowId}"`;
  if (reason === undefined) return "--reason is required";
  return { branch, rowId, reason };
}

/** `git config user.email` in `cwd`, or undefined when unset. */
export async function operatorEmail(cwd: string): Promise<string | undefined> {
  try {
    const { stdout } = await execFileP("git", ["-C", cwd, "config", "user.email"], {
      maxBuffer: 8 * 1024,
    });
    return stdout.trim() || undefined;
  } catch {
    return undefined;
  }
}

/** Run the acceptance. Returns the exit code and the line to print. */
export async function runReviewAccept(
  argv: readonly string[],
  cwd: string,
  env: NodeJS.ProcessEnv = process.env,
): Promise<{ code: number; message: string }> {
  const agent = agentContext(env);
  if (agent) {
    return {
      code: 2,
      message: `refused: ${agent} — accepting a review finding is an operator act, run it from a terminal`,
    };
  }
  const args = parseAcceptArgs(argv);
  if (typeof args === "string") return { code: 2, message: args };
  const problem = reasonProblem(args.reason);
  if (problem) return { code: 2, message: problem };
  const by = await operatorEmail(cwd);
  if (!by) {
    return {
      code: 2,
      message: "git config user.email is not set — the acceptance needs an operator identity",
    };
  }
  let out: Awaited<ReturnType<typeof acceptRow>>;
  try {
    out = await acceptRow({
      cwd,
      branch: args.branch,
      rowId: args.rowId,
      reason: args.reason.trim(),
      by,
    });
  } catch (err) {
    return { code: 1, message: `not accepted: ${(err as Error).message}` };
  }
  if (!out.ok) return { code: 1, message: `not accepted: ${out.reason}` };
  return {
    code: 0,
    message: `accepted row ${args.rowId} on ${args.branch} by ${by} — it stays suppressed while the cited code is unchanged`,
  };
}

// Run only as the entry point, so tests can import runReviewAccept.
if (process.argv[1] && path.basename(process.argv[1]) === "review-accept.ts") {
  const result = await runReviewAccept(process.argv.slice(2), process.cwd());
  if (result.code === 0) console.log(result.message);
  else console.error(result.message);
  process.exit(result.code);
}
