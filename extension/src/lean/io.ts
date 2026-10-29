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
import { detectMainline } from "../mainline.ts";
import { oneLine } from "./text-fence.ts";

/**
 * The forge adapter for this repo, or undefined when it cannot be resolved.
 *
 * Exported because `publish` asks for the same adapter in a narrower shape
 * (`PublishForge` is a `Pick` of `Forge`), and a second lookup here would be
 * a second detection path with its own failure modes.
 */
export async function forgeFor(repoRoot: string): Promise<Forge | undefined> {
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

/** Refs probed for the mainline sha, in order. The first that resolves wins. */
const MAINLINE_REFS = ["origin/HEAD", "origin/main", "main"] as const;

/**
 * The fixed tail for a mainline that resolved to nothing and gave no cause.
 *
 * Lives beside the probe list it names, because the two must move together:
 * `lean/base-proof.ts` renders the empty-base rule and needs a tail that is
 * never empty, and a clause that quotes refs this function never asked is
 * worse than no clause at all. `detectMainline` (the fallback probe below) adds
 * `origin/<name>` for whatever branch it resolves — which on a GitHub clone is
 * usually `master` — so the clause names the three deterministic refs plus that
 * remote spelling and says plainly that no ref resolved.
 */
export const NO_MAINLINE_WHY = "no mainline ref resolved (origin/HEAD, origin/main, origin/master)";

/**
 * What a mainline probe returned: the sha, or the reason there is none.
 *
 * A failure CAUSE travels back with the answer rather than sitting in a
 * module global. The global version (`mainlineShaFailure`) read the LAST
 * probe's causes, so a second probe after a failure — a retry, or two issues
 * checked in one process — reported one run's cause against another's, and
 * the comment on the issue said something git never did.
 */
export interface MainlineSha {
  sha?: string;
  why?: string;
}

/**
 * The mainline sha: `origin/HEAD`, then `origin/main`, then `main`, then the
 * branch `detectMainline` resolves (which falls back to `gh repo view` when
 * `origin/HEAD` is unset). `{}` for none, with `why` saying what was probed
 * and why each probe failed — so the sha the whole cycle reads its config at
 * never comes back as a bare empty string that reads like "no such branch"
 * when it actually meant "git broke". Note also that these are LOCAL refs: no
 * fetch happens here, so the sha is the tip the clone last saw.
 */
export async function mainlineSha(repoRoot: string): Promise<MainlineSha> {
  const causes: string[] = [];
  for (const ref of MAINLINE_REFS) {
    try {
      const { stdout } = await execp("git", {
        argv: ["rev-parse", "--verify", "--quiet", ref],
        cwd: repoRoot,
        timeout: 15_000,
      });
      const sha = stdout.trim();
      if (sha) return { sha };
      causes.push(`${ref}: ${oneLine(noSuchRef(sha), 60)}`);
    } catch (err) {
      causes.push(`${ref}: ${oneLine((err as Error)?.message ?? String(err), 60)}`);
    }
  }
  // No local ref resolved: ask the same detector the old driver asks, whose
  // `gh repo view` fallback covers a clone whose origin/HEAD was never set.
  // The name it returns is probed bare and as `origin/<name>`, since the
  // detector gives a branch name and the tip usually lives on the remote.
  const detected = await resolveMainlineBranch(repoRoot);
  if (!detected)
    return { why: `${causes.join("; ")}${causes.length > 0 ? "; " : ""}${NO_MAINLINE_WHY}` };
  for (const ref of [detected, `origin/${detected}`]) {
    try {
      const { stdout } = await execp("git", {
        argv: ["rev-parse", "--verify", "--quiet", ref],
        cwd: repoRoot,
        timeout: 15_000,
      });
      const sha = stdout.trim();
      if (sha) return { sha };
      causes.push(`${oneLine(ref, 60)} (detectMainline): ${oneLine(noSuchRef(sha), 60)}`);
    } catch (err) {
      causes.push(
        `${oneLine(ref, 60)} (detectMainline): ${oneLine((err as Error)?.message ?? String(err), 60)}`,
      );
    }
  }
  // The tail is the one thing this answer always has, even when every probe
  // answered so quietly it left no cause behind — see `NO_MAINLINE_WHY`.
  const causesText = causes.length > 0 ? `${causes.join("; ")}; ` : "";
  return { why: `${causesText}${NO_MAINLINE_WHY}` };
}

/**
 * What a ref probe printed when it printed nothing.
 * "" → the ref simply does not exist; anything else is git's own noise.
 */
function noSuchRef(printed: string): string {
  return printed === "" ? "no such ref" : `unexpected output ${JSON.stringify(printed)}`;
}

/** The branch name `detectMainline` resolves, or undefined for none. */
async function resolveMainlineBranch(repoRoot: string): Promise<string | undefined> {
  try {
    const result = await detectMainline(repoRoot, execp);
    return result.ok ? result.branch : undefined;
  } catch {
    return undefined;
  }
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

/**
 * Post the handback comment: what the run still needs.
 *
 * The same adapter and the same public-text check `postNotReady` goes through —
 * `forge.issueComment` runs the body past the public-hygiene gate and returns
 * the bytes it judged, so what is checked and what is posted are one string.
 * It throws so the caller can record that nobody was told; `handback` is the
 * caller, and it never lets that throw end the run.
 */
export async function postHandback(repoRoot: string, issue: number, body: string): Promise<void> {
  const forge = await forgeFor(repoRoot);
  if (!forge) throw new Error("no forge adapter: cannot post the handback comment");
  await forge.issueComment(issue, body);
}
