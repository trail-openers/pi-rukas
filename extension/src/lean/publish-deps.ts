/**
 * lean/publish-deps — the outside world `lean/publish` reaches, in production form, plus the
 * error its throws are instances of.
 *
 * Split from `publish.ts` along the seam the file already had: the step body is the algorithm and its
 * preconditions, this file is the wiring to git, the forge and the issue.
 *
 * `PublishInfraError` lives here because both halves raise it: the step for a claim it could not verify, a
 * dependency for a machine that would not answer.
 */

import { execp } from "../exec.ts";
import type { ExecOpts } from "../exec.ts";
import type { Forge } from "../forge-types.ts";
import { type IssueSpec, type SpecBlockAt, issueSpecOrThrow, specBlockAt } from "../issue-spec.ts";
import { MAINLINE_PROBE_TIMEOUT_MS, type MainlineExecFn, resolveMainline } from "../mainline.ts";
import { causeOf } from "../probe-cause.ts";
import { netGitEnv, runNetGit } from "../work-driver-net-git.ts";
import { assertSafeRef } from "../worktree-loss.ts";
import { fetchIssueBody, forgeFor } from "./io.ts";
import type { VerifyExec } from "./verify-types.ts";

/** Infrastructure: the step could not observe what it needed, so it did not act. */
export class PublishInfraError extends Error {
  override readonly name = "PublishInfraError";
}

/**
 * The executor this step needs: the argv form plus `execp`'s `killGroup`, which the push carries so a hung
 * `git push` cannot leave an ssh grandchild holding the pipe open. See `verify-types.ts`.
 */
type PublishExec = VerifyExec;

/**
 * The forge in the shape the step uses: list, read, (re)draft, then create. Nothing else.
 *
 * `issueView` reads the title a created PR carries. `prDraft` is here because a REUSED PR carries the draft
 * state a previous run left on it — `prCreate`'s `draft` option applies only to a PR this step opens.
 * `prView` exists because `gh pr list --json` carries no `isDraft`, so the list reply alone cannot tell a
 * reused PR's state.
 */
export type PublishForge = Pick<Forge, "issueView" | "prList" | "prView" | "prDraft" | "prCreate">;

/** What the step reaches outside itself. */
export interface PublishDeps {
  exec: PublishExec;
  fetchBody: (repoRoot: string, issue: number) => Promise<string>;
  forge: (repoRoot: string) => PromiseLike<PublishForge | undefined>;
  /** The host's approved spec (`issue-spec.ts`); throws when its manifest entry is invalid. */
  issueSpec: (issue: number) => Promise<IssueSpec | undefined>;
  /** The approved spec's PR-body block at a head, and what its check cost. */
  specBlock: SpecBlockAt;
}

/**
 * The push target must be a lean branch, and never the mainline.
 *
 * `branch` arrives from the run's persisted state file — data a stale or edited file supplies, not a name
 * this cycle chose. Pushing it raw is how a run whose state named `main` writes unreviewed work onto the
 * mainline; `assertSafeRef` only says the string is a legal ref, which `main` is.
 *
 * Rule 1 is load-bearing: a lean run's branch is `lean/…` by construction, so the prefix also rejects
 * `refs/heads/` and `origin/`. Rule 2 catches a mainline that does not spell `main`, asking origin when it
 * cannot be read.
 *
 * `exec` is the caller's own executor — a requirement, not a convenience: the probes deciding whether a
 * force-push happens must go over the transport the push will use.
 *
 * Throws `PublishInfraError`, which the engine turns into a handed-back run.
 */
export async function assertPublishableBranch(
  repoRoot: string,
  branch: string,
  exec: MainlineExec,
): Promise<void> {
  // The ref's own charset first — every other lean git call site validates its ref before a command
  // line; re-wrapped so the engine sees a PublishInfraError.
  try {
    assertSafeRef(branch);
  } catch (err) {
    throw new PublishInfraError((err as Error).message);
  }
  if (!branch.startsWith("lean/"))
    throw new PublishInfraError(
      `refusing to publish to ${branch}: work-lean pushes only lean/ branches`,
    );
  const local = await resolveMainline(repoRoot, shellForm(exec)).catch((err: unknown) => ({
    // `resolveMainline` is total, so this arm is a rejecting executor — and the SAME refusal, because
    // silence is never a pass. The cause is the only thing that says which fault the machine had.
    ok: false as const,
    reason: `mainline probe threw: ${causeOf(err)}`,
  }));
  if (local.ok === true) {
    if (local.branch === branch) throw mainlineRefusal(branch);
    return;
  }
  // The policy's second half: ask origin, over the transport the push will use.
  const remote = await originHeadBranch(repoRoot, exec);
  if (remote === undefined) {
    throw new PublishInfraError(
      `refusing to publish to ${branch}: could not resolve the mainline to check it against, so the push is refused rather than guessed at (${local.reason}; ${ORIGIN_PROBE_WHY})`,
    );
  }
  if (remote === branch) throw mainlineRefusal(branch);
}

export type MainlineExec = (
  cmd: string,
  opts?: ExecOpts,
) => Promise<{ stdout: string; stderr?: string }>;

/**
 * The origin probe's command line, in one place.
 *
 * The guard issues it through the harness's network-git wrapper rather than the executor directly: the
 * wrapper gives a network git call its non-interactive env, process-group kill and bound — what makes a
 * wedged probe a refusal rather than a step that never answers.
 */
export const ORIGIN_PROBE_COMMAND = "git ls-remote --symref origin HEAD";

/** The symref probe's own name in the refusal's cause list. */
const ORIGIN_PROBE_WHY = `${ORIGIN_PROBE_COMMAND} did not answer`;

/**
 * The adapter from the guard's seam to the executor shape the probes declare: they never use the argv arm,
 * so argv is dropped here rather than widening `MainlineExecFn` with a field no probe can send.
 */
function shellForm(exec: MainlineExec): MainlineExecFn {
  return (cmd, opts) => {
    const { argv: _argv, ...rest } = opts ?? {};
    return exec(cmd, rest);
  };
}

async function originHeadBranch(repoRoot: string, exec: MainlineExec): Promise<string | undefined> {
  const ran = await runNetGit(shellForm(exec), ORIGIN_PROBE_COMMAND, {
    cwd: repoRoot,
    maxBuffer: 64 * 1024,
    timeoutMs: MAINLINE_PROBE_TIMEOUT_MS,
  }).catch(() => undefined);
  const line = (ran?.stdout ?? "")
    .split("\n")
    .map((l) => l.trim())
    .find((l) => l.startsWith("ref: "));
  if (line === undefined) return undefined;
  const ref = line.slice(5).split(/\s+/)[0] ?? "";
  const prefix = "refs/heads/";
  const branch = ref.startsWith(prefix) ? ref.slice(prefix.length) : "";
  return branch === "" ? undefined : branch;
}

/** Rule 2's refusal: the pushed branch IS the mainline, however it was spelled. */
function mainlineRefusal(branch: string): PublishInfraError {
  return new PublishInfraError(`refusing to push to the mainline ${branch}`);
}

/**
 * The three command lines the guard asks its executor, in the order it asks them.
 *
 * Exported for the suites: a "no push" claim means something only if the probes a case scripted are the
 * probes the guard actually makes.
 */
export const MAINLINE_PROBE_COMMANDS = [
  "git symbolic-ref --short refs/remotes/origin/HEAD",
  "gh repo view --json defaultBranchRef --jq '.defaultBranchRef.name'",
  ORIGIN_PROBE_COMMAND,
] as const;

/** Production dependencies: the real executor, the real issue read, the real forge. */
export function publishDeps(headless: boolean): PublishDeps {
  return {
    // One executor for both shapes: `execp`'s opts type declares every field this step passes.
    //
    // The push is the one call that leaves the clone, so it gets the driver's own non-interactive env
    // (`netGitEnv`) and cannot drift from a driver push. Every other git call the step makes is local.
    //
    // `o?.cwd` is passed through because `netGitEnv` reads the repo's `core.sshCommand` in that directory:
    // with no cwd the lookup is skipped and plain `ssh` is promoted ahead of the config.
    exec: (cmd, o) =>
      execp(cmd, {
        ...(o ?? {}),
        ...(cmd === "git" && o?.env === undefined ? { env: netGitEnv(process.env, o?.cwd) } : {}),
      }),
    fetchBody: fetchIssueBody,
    // `forgeFor` is io.ts's one lookup; `Forge` is structurally assignable to the `Pick`, so no cast.
    // `undefined` is an ANSWER ("this clone has no forge the harness can drive"), and a detection that
    // THREW also comes back undefined — an unresolvable forge is not a step the run can finish either way.
    forge: forgeFor,
    issueSpec: (issue) => issueSpecOrThrow(issue),
    specBlock: specBlockAt(headless),
  };
}
