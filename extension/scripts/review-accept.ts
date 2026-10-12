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
 * Human-only by construction: this is not a Pi tool, not in agents.json, and
 * the permission layer refuses agent-run invocations (review-accept-guard.ts).
 * It exits non-zero on any refusal and writes nothing.
 */

import { execFile } from "node:child_process";
import path from "node:path";
import { promisify } from "node:util";
import { acceptRow } from "../src/review-findings-store.ts";
import { looksLikeSecret } from "../src/vipune.ts";

const execFileP = promisify(execFile);

/** The shortest reason the operator may give. */
export const MIN_REASON_CHARS = 20;

export interface AcceptArgs {
  branch: string;
  rowId: string;
  reason: string;
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

/** The reason's refusal, or undefined when it is acceptable. */
export function reasonProblem(reason: string): string | undefined {
  const trimmed = reason.trim();
  if (trimmed.length < MIN_REASON_CHARS) {
    return `--reason must be at least ${MIN_REASON_CHARS} characters (got ${trimmed.length})`;
  }
  if (looksLikeSecret(trimmed)) return "--reason looks like a secret; refusing to record it";
  return undefined;
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
): Promise<{ code: number; message: string }> {
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
  const out = await acceptRow({
    cwd,
    branch: args.branch,
    rowId: args.rowId,
    reason: args.reason.trim(),
    by,
  });
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
