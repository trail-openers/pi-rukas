/**
 * lean/io — the three things a lean run asks the outside world for.
 *
 * Split from `command.ts` for the brief's 250-line cap, and the split earns
 * its keep beyond the size: `command.ts` is registration and handler wiring,
 * this file is the seam where a lean run touches the forge and git. A phase
 * that swaps the adapter for an API client, or adds a retry, changes one file
 * and leaves the handler set alone; a test that wants to fake the outside
 * world replaces this module rather than the command.
 *
 * Every call is argv-form, so `gh` and `git` never see a shell string here.
 * An issue title or a provider error message cannot become a word the shell
 * re-parses.
 */

import { execp } from "../exec.ts";
import { detectForge } from "../forge-detect.ts";
import { type Forge, type ForgeDetection, createForge } from "../forge.ts";

/** The forge adapter for this repo, or undefined when it cannot be resolved. */
async function forgeFor(repoRoot: string): Promise<Forge | undefined> {
  if (process.env.PI_ENSEMBLE_FORGE === "none") return undefined;
  try {
    const det: ForgeDetection = await detectForge(repoRoot, {});
    if (det.forge === "unknown") return undefined;
    return createForge(det, { cwd: repoRoot });
  } catch {
    return undefined;
  }
}

/** The issue body: the adapter when there is one, raw `gh` when there is not. */
export async function fetchIssueBody(repoRoot: string, issue: number): Promise<string> {
  const forge = await forgeFor(repoRoot);
  if (forge) {
    const viewed = await forge.issueView(issue);
    if (typeof viewed.body === "string") return viewed.body;
  }
  const { stdout } = await execp("gh", {
    argv: ["issue", "view", String(issue), "--json", "body"],
    cwd: repoRoot,
    timeout: 60_000,
    maxBuffer: 4 * 1024 * 1024,
  });
  const parsed = JSON.parse(stdout) as { body?: unknown };
  if (typeof parsed.body !== "string") throw new Error(`issue ${issue} carries no body`);
  return parsed.body;
}

/** The mainline sha: `origin/HEAD`, then `origin/main`, then `main`. Empty for none. */
export async function mainlineSha(repoRoot: string): Promise<string> {
  for (const ref of ["origin/HEAD", "origin/main", "main"]) {
    try {
      const { stdout } = await execp("git", {
        argv: ["rev-parse", "--verify", "--quiet", ref],
        cwd: repoRoot,
        timeout: 15_000,
      });
      const sha = stdout.trim();
      if (sha) return sha;
    } catch {
      /* that ref does not exist — try the next one */
    }
  }
  return "";
}

/**
 * Post one comment listing the failed rules. Throws so the caller can report
 * it: a run that could not tell the operator why it refused is a worse
 * failure than one that says so in the summary line.
 */
export async function postNotReady(
  repoRoot: string,
  issue: number,
  failedRules: string[],
): Promise<void> {
  const body = [
    `work-lean: issue #${issue} is not ready to build from.`,
    "",
    ...(failedRules.length > 0
      ? failedRules.map((r) => `- ${r}`)
      : ["- no failed rule was recorded"]),
    "",
    "Fix the `pi-spec v1` block, or run /plan to regenerate it, then start the run again.",
  ].join("\n");
  const forge = await forgeFor(repoRoot);
  if (!forge) throw new Error("no forge adapter: cannot post the not-ready comment");
  await forge.issueComment(issue, body);
}
