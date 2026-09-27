/**
 * merge-target — what a PR/MR merge command would actually merge, and the
 * identity facts the merge guard (merge-guard.ts) needs to check.
 *
 * #912. The guard resolves the merge target with `gh`/`glab` (NOT git):
 *
 *   1. The PR number — from the command, or from `gh pr view --json number`
 *      on the current branch when the command omits it.
 *   2. The PR's identity — `gh pr view N --json headRefName,headRefOid,
 *      baseRefName,author,labels` (GitHub) or `glab mr view N --output json`
 *      (GitLab, the repo's canonical form; the head OID comes from
 *      `diff_refs.head_sha`).
 *
 * Every fault is fail-closed: an unreadable `gh` AND an unreadable `glab`
 * both refuse (the refusal text names the escape hatch). A partial JSON
 * response (e.g. `headOid` present but `headBranch` absent) also refuses.
 *
 * The exec seam is injectable so tests stub `gh`/`glab` offline, exactly the
 * fakeGh pattern in test-merge-authority.ts.
 */

import { detectForge } from "./forge-detect.ts";
import { trace } from "./trace.ts";

export type MergeExecFn = (
  cmd: string,
  opts?: { cwd?: string; timeout?: number; maxBuffer?: number; shell?: string },
) => Promise<{ stdout: string; stderr?: string }>;

/** The identity facts the guard needs before it will allow a merge. */
export interface MergeTarget {
  /** Which forge served this — determines how the ledger is checked. */
  forge: "github" | "gitlab";
  /** The PR/MR number. */
  prNumber: number;
  /** The head branch name (what the ledger's `branch` field must match). */
  headBranch: string;
  /** The head OID (what the fetched head must equal). */
  headOid: string;
  /** The base branch name. */
  baseBranch: string;
  /** The author's login/username (for the dependabot carve-out). */
  author: string;
  /** The PR's labels (for the release-please carve-out). */
  labels: string[];
}

/** A refusal reason — the guard renders this verbatim into the block text. */
export interface MergeTargetError {
  ok: false;
  reason: string;
}

export type MergeTargetResult = { ok: true; target: MergeTarget } | MergeTargetError;

/**
 * Resolve the merge target for a PR/MR number.
 *
 * Fails closed on every fault: unreadable forge, unreadable PR, missing
 * fields. The refusal reason names the escape hatch so the operator knows
 * how to override.
 */
export async function readMergeTarget(
  execFn: MergeExecFn,
  cwd: string,
  prNumber: number,
): Promise<MergeTargetResult> {
  const escapeHatch = "PI_ENSEMBLE_ALLOW_UNREVIEWED_MERGE=1 (operator-set only)";

  // Detect the forge. Fail-closed on an unknown forge.
  // detectForge resolves the forge from PI_ENSEMBLE_FORGE, .pi/forge, or
  // the remote URL. No execFn injection needed: the env-var override and
  // the .pi/forge config file are the primary paths, and the remote URL
  // parse is a pure string operation (no exec needed for the common case).
  const detection = await detectForge(cwd);
  if (detection.forge === "unknown") {
    return {
      ok: false,
      reason: `could not determine the forge for this repo — the merge guard refuses by default; set ${escapeHatch} to override`,
    };
  }

  if (detection.forge === "github") {
    return readGhTarget(execFn, cwd, prNumber, escapeHatch);
  }
  return readGlTarget(execFn, cwd, prNumber, escapeHatch);
}

async function readGhTarget(
  execFn: MergeExecFn,
  cwd: string,
  prNumber: number,
  escapeHatch: string,
): Promise<MergeTargetResult> {
  // The exact argv the guard shells out to — pinned by the test.
  const cmd = `gh pr view ${prNumber} --json headRefName,headRefOid,baseRefName,author,labels`;
  let stdout: string;
  try {
    ({ stdout } = await execFn(cmd, { cwd, maxBuffer: 64 * 1024 }));
  } catch (err) {
    return {
      ok: false,
      reason: `gh pr view ${prNumber} failed: ${(err as Error).message?.slice(0, 120)} — set ${escapeHatch} to override`,
    };
  }
  let raw: Record<string, unknown>;
  try {
    raw = JSON.parse(stdout);
  } catch {
    return {
      ok: false,
      reason: `gh pr view ${prNumber} returned malformed JSON — set ${escapeHatch} to override`,
    };
  }
  const headBranch = str(raw.headRefName);
  const headOid = str(raw.headRefOid);
  const baseBranch = str(raw.baseRefName);
  const author = str((raw.author as Record<string, unknown> | null)?.login);
  const labels = Array.isArray(raw.labels)
    ? (raw.labels as unknown[])
        .map((l) => (l as Record<string, unknown>)?.name)
        .filter((s): s is string => typeof s === "string")
    : [];
  if (!headBranch || !headOid || !baseBranch) {
    return {
      ok: false,
      reason: `gh pr view ${prNumber} returned missing fields (headRefName=${headBranch}, headRefOid=${headOid}, baseRefName=${baseBranch}) — set ${escapeHatch} to override`,
    };
  }
  return {
    ok: true,
    target: {
      forge: "github",
      prNumber,
      headBranch,
      headOid,
      baseBranch,
      author: author ?? "unknown",
      labels,
    },
  };
}

async function readGlTarget(
  execFn: MergeExecFn,
  cwd: string,
  prNumber: number,
  escapeHatch: string,
): Promise<MergeTargetResult> {
  // The repo's canonical glab read shape (forge-commands.ts): --output json.
  const cmd = `glab mr view ${prNumber} --output json`;
  let stdout: string;
  try {
    ({ stdout } = await execFn(cmd, { cwd, maxBuffer: 64 * 1024 }));
  } catch (err) {
    return {
      ok: false,
      reason: `glab mr view ${prNumber} failed: ${(err as Error).message?.slice(0, 120)} — set ${escapeHatch} to override`,
    };
  }
  let raw: Record<string, unknown>;
  try {
    raw = JSON.parse(stdout);
  } catch {
    return {
      ok: false,
      reason: `glab mr view ${prNumber} returned malformed JSON — set ${escapeHatch} to override`,
    };
  }
  const headBranch = str(raw.source_branch);
  const headOid = str((raw.diff_refs as Record<string, unknown> | null)?.head_sha);
  const baseBranch = str(raw.target_branch);
  const author = str((raw.author as Record<string, unknown> | null)?.username);
  const labels = Array.isArray(raw.labels)
    ? (raw.labels as unknown[])
        .map((l) => (l as Record<string, unknown>)?.name)
        .filter((s): s is string => typeof s === "string")
    : [];
  if (!headBranch || !headOid || !baseBranch) {
    return {
      ok: false,
      reason: `glab mr view ${prNumber} returned missing fields (source_branch=${headBranch}, diff_refs.head_sha=${headOid}, target_branch=${baseBranch}) — set ${escapeHatch} to override`,
    };
  }
  return {
    ok: true,
    target: {
      forge: "gitlab",
      prNumber,
      headBranch,
      headOid,
      baseBranch,
      author: author ?? "unknown",
      labels,
    },
  };
}

function str(v: unknown): string | undefined {
  return typeof v === "string" && v.length > 0 ? v : undefined;
}

/**
 * Resolve the PR number when the command omits it: `gh pr view --json number`
 * on the current branch. Returns undefined when the command carries a number
 * (the guard uses that directly) or when the resolution fails (fail-closed).
 */
export async function resolvePrNumber(
  execFn: MergeExecFn,
  cwd: string,
  commandNumber: number | undefined,
): Promise<number | undefined> {
  if (commandNumber !== undefined) return commandNumber;
  try {
    const { stdout } = await execFn("gh pr view --json number", { cwd, maxBuffer: 8 * 1024 });
    const n = (JSON.parse(stdout) as { number?: number }).number;
    return typeof n === "number" ? n : undefined;
  } catch (err) {
    trace(`merge-target: cannot resolve PR number: ${(err as Error).message}`);
    return undefined;
  }
}

/**
 * The carve-out identities that are NOT agent merges and must stay open:
 * release-please branches and dependabot PRs.
 */
export function isCarveOut(target: MergeTarget): boolean {
  // release-please: head branch `release-please--*` OR label `autorelease: pending`.
  if (target.headBranch.startsWith("release-please--")) return true;
  if (target.labels.includes("autorelease: pending")) return true;
  // dependabot: head branch `dependabot/*` OR author `dependabot[bot]` / `app/dependabot`.
  if (target.headBranch.startsWith("dependabot/")) return true;
  if (target.author === "dependabot[bot]" || target.author === "app/dependabot") return true;
  return false;
}
