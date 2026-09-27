/**
 * merge-target — what a PR/MR merge command would actually merge, and the
 * identity facts the merge guard (merge-guard.ts) needs to check.
 *
 * #912. The guard resolves the merge target with `gh`/`glab` (NOT git):
 *
 *   1. The PR number — from the command, or from `gh pr view --json number`
 *      (GitHub) / `glab mr view --output json` (GitLab) on the CURRENT
 *      branch when the command omits it.
 *   2. The PR's identity — `gh pr view N --json headRefName,headRefOid,
 *      baseRefName,author,labels` (GitHub) or `glab mr view N --output json`
 *      (GitLab, the repo's canonical form; the head OID comes from
 *      `diff_refs.head_sha`).
 *   3. The git remote — `origin` → `upstream` → first remote (the same
 *      precedence as `detectForge`), so `git fetch`/`rev-parse` /`patch-id`
 *      never assume a remote named `origin`. No remote → fail-closed.
 *
 * Every fault is fail-closed: an unreadable `gh` AND an unreadable `glab`
 * both refuse (the refusal text names the escape hatch). A partial JSON
 * response (e.g. `headOid` present but `headBranch` absent) also refuses.
 *
 * The exec seam is injectable so tests stub `gh`/`glab` offline, exactly the
 * fakeGh pattern in test-merge-authority.ts.
 */

import { type DetectForgeOpts, detectForge } from "./forge-detect.ts";
import { trace } from "./trace.ts";

/**
 * The forge detection options the guard uses for its own decisions (#926
 * fix round): `allowProbe: false`. detectForge's default path may fall into
 * an unbounded API probe against a non-github/gitlab remote host, and the
 * merge guard's tool_call hook already spends its 30s exec budget on the
 * gh/git reads — a network probe there would eat the whole budget and could
 * hang the child's turn. With `allowProbe: false` the forge decision uses
 * only the local heuristics (env → .pi/forge config → remote-URL known
 * hosts); a host those cannot classify is `source: "unknown"` and the guard
 * fails closed exactly as before.
 */
const GUARD_FORGE_OPTS = { allowProbe: false } as const;

/**
 * Build the forge options for the guard's detectForge call: the guard's
 * allowProbe: false always wins (a caller cannot re-enable the probe through
 * the guard), and caller-supplied options (execFn, env, probe, …) are
 * preserved. The caller's injected probe — when allowProbe is off the probe
 * is never invoked — is the seam tests use to canary "the guard never
 * probes" (see test-merge-target-forge-bound.ts).
 */
function guardForgeOpts(callerOpts: DetectForgeOpts = {}): DetectForgeOpts {
  return {
    ...callerOpts,
    allowProbe: GUARD_FORGE_OPTS.allowProbe,
  };
}

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
  forgeOpts?: DetectForgeOpts,
): Promise<MergeTargetResult> {
  const escapeHatch = "PI_ENSEMBLE_ALLOW_UNREVIEWED_MERGE=1 (operator-set only)";

  // Detect the forge. Fail-closed on an unknown forge: `detection.source` is
  // the detection's own "how did we know this" answer, and it is the real
  // unknown signal (an env-forced forge still reports source "env" even when
  // its remote is unparseable — the type is authoritative there, so that is
  // by design). A remote that exists is a real answer; an absent remote is
  // the fail-closed case the guard must refuse. allowProbe: false keeps the
  // guard's forge decision inside the 30s exec budget (see GUARD_FORGE_OPTS).
  const detection = await detectForge(cwd, guardForgeOpts(forgeOpts));
  if (detection.source === "unknown") {
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
  let raw: Record<string, unknown>;
  try {
    const { stdout } = await execFn(cmd, { cwd, maxBuffer: 64 * 1024 });
    raw = JSON.parse(stdout);
  } catch (err) {
    return {
      ok: false,
      reason: `gh pr view ${prNumber} failed: ${(err as Error).message?.slice(0, 120)} — set ${escapeHatch} to override`,
    };
  }
  const headBranch = str(raw.headRefName);
  const headOid = str(raw.headRefOid);
  const baseBranch = str(raw.baseRefName);
  const author = str((raw.author as Record<string, unknown> | null)?.login);
  const labels = labelNames(raw.labels);
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
  let raw: Record<string, unknown>;
  try {
    const { stdout } = await execFn(cmd, { cwd, maxBuffer: 64 * 1024 });
    raw = JSON.parse(stdout);
  } catch (err) {
    return {
      ok: false,
      reason: `glab mr view ${prNumber} failed: ${(err as Error).message?.slice(0, 120)} — set ${escapeHatch} to override`,
    };
  }
  const headBranch = str(raw.source_branch);
  const headOid = str((raw.diff_refs as Record<string, unknown> | null)?.head_sha);
  const baseBranch = str(raw.target_branch);
  const author = str((raw.author as Record<string, unknown> | null)?.username);
  const labels = labelNames(raw.labels);
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

/** The forge's labels array (gh: `[{name}]`, glab: `[{name}]` or `[]`) → names. */
function labelNames(labels: unknown): string[] {
  if (!Array.isArray(labels)) return [];
  return (labels as unknown[])
    .map((l) => (l as Record<string, unknown>)?.name)
    .filter((s): s is string => typeof s === "string");
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
  forgeOpts?: DetectForgeOpts,
): Promise<number | undefined> {
  if (commandNumber !== undefined) return commandNumber;
  // Forge-aware: the PR/MR for the CURRENT branch, read from whichever forge
  // the repo lives on (detectForge: PI_ENSEMBLE_FORGE → .pi/forge → remote
  // URL). The probe is disabled by the caller (allowProbe: false) — the
  // guard's forge decision is local-heuristics-only and fails closed on an
  // unknown host. `gh pr view --json number` on the current branch (GitHub)
  // and `glab mr view --output json` on the current branch (GitLab).
  const detection = await detectForge(cwd, guardForgeOpts(forgeOpts));
  if (detection.source === "unknown") {
    trace("merge-target: cannot resolve PR number — forge is unknown (fail-closed)");
    return undefined;
  }
  try {
    if (detection.forge === "gitlab") {
      const { stdout } = await execFn("glab mr view --output json", { cwd, maxBuffer: 8 * 1024 });
      const n = (JSON.parse(stdout) as { iid?: number }).iid;
      return typeof n === "number" ? n : undefined;
    }
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
 * release-please and dependabot.
 *
 * Both require a BOT IDENTITY, not a branch shape: a branch prefix alone
 * proves nothing (a human or an agent can open a PR from any branch name —
 * the incident this guard closes was exactly an agent acting on its own
 * work, and a self-named branch must not launder it into a bot). So:
 *
 *   - dependabot: the AUTHOR is the dependabot bot identity
 *     (`dependabot[bot]` on GitHub, `app/dependabot` on GitLab).
 *   - release-please: the head branch is `release-please--*` (release-please
 *     always names its head branch that way) AND the label `autorelease:
 *     pending` is present OR the author is a bot identity.
 */
export function isCarveOut(target: MergeTarget): boolean {
  const isDependabotAuthor =
    target.author === "dependabot[bot]" || target.author === "app/dependabot";
  // dependabot: the bot author is the identity — a `dependabot/*` branch
  // alone (any author) is not.
  if (isDependabotAuthor) return true;
  // release-please: head branch prefix + (label OR bot author).
  if (target.headBranch.startsWith("release-please--")) {
    return target.labels.includes("autorelease: pending") || isBotAuthor(target.author);
  }
  return false;
}

/** A bot identity in the forge's author field (GitHub or GitLab). */
function isBotAuthor(author: string): boolean {
  return (
    author === "dependabot[bot]" ||
    author === "app/dependabot" ||
    author === "release-please[bot]" ||
    author === "app/release-please"
  );
}
