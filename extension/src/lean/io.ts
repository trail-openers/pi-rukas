/**
 * lean/io — the three things a lean run asks the outside world for.
 *
 * Split from `command.ts` for the brief's 250-line cap, and the split earns its keep beyond the size:
 * `command.ts` is registration and handler wiring, this file is the seam where a lean run touches the forge
 * and git.
 *
 * Every call is argv-form, so `gh` and `git` never see a shell string here. An issue title or a provider
 * error message cannot become a word the shell re-parses.
 */

import { execp } from "../exec.ts";
import type { Forge } from "../forge.ts";
import { issueSpecOrThrow, withApprovedSpec } from "../issue-spec.ts";
import { detectMainline } from "../mainline.ts";
import { resolveCycleForge } from "../work-driver-forge-ctx.ts";
import type { Guard } from "./derive-guards.ts";
import { type PiSpec, renderPiSpec } from "./spec.ts";
import { oneLine } from "./text-fence.ts";

/**
 * The forge adapter for this repo, or undefined when it cannot be resolved. Resolution goes through the
 * driver's one guarded detection so a lean run and a `/work` cycle give the same answer for the same repo.
 *
 * Exported because `publish` asks for the same adapter in a narrower shape (`PublishForge` is a `Pick` of
 * `Forge`), and a second lookup here would be a second detection path with its own failure modes.
 */
export async function forgeFor(repoRoot: string): Promise<Forge | undefined> {
  return resolveCycleForge(repoRoot, { traceLabel: "lean" });
}

/** The body every step reads: the approved text and spec when a host handed them (`issue-spec.ts`). */
export async function fetchIssueBody(repoRoot: string, issue: number): Promise<string> {
  const s = await issueSpecOrThrow(issue);
  const body = s?.approved?.body ?? (await fetchLiveIssueBody(repoRoot, issue));
  return s === undefined ? body : withApprovedSpec(body, s);
}

/** The issue body: the adapter when there is one, raw `gh` when there is not. */
async function fetchLiveIssueBody(repoRoot: string, issue: number): Promise<string> {
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
 * Lives beside the probe list it names, because the two must move together: `lean/base-proof.ts` renders the
 * empty-base rule and needs a tail that is never empty, and a clause that quotes refs this function never
 * asked is worse than no clause at all.
 */
export const NO_MAINLINE_WHY = "no mainline ref resolved (origin/HEAD, origin/main, origin/master)";

/**
 * What a mainline probe returned: the sha, or the reason there is none.
 *
 * A failure CAUSE travels back with the answer rather than sitting in a module global: the global version read
 * the LAST probe's causes, so a second probe after a failure — a retry, or two issues in one process — reported
 * one run's cause against another's, and the comment said something git never did.
 */
interface MainlineSha {
  sha?: string;
  why?: string;
}

/**
 * The mainline sha: `origin/HEAD`, then `origin/main`, then `main`, then the branch `detectMainline` resolves.
 * `{}` for none, with `why` saying what was probed and why each probe failed — so the sha the whole cycle reads
 * its config at never comes back as a bare empty string that reads like "no such branch" when it actually meant
 * "git broke". These are LOCAL refs: no fetch happens here.
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
  // No local ref resolved: ask the same detector the old driver asks, whose `gh repo view` fallback covers a
  // clone whose origin/HEAD was never set. The name it returns is probed bare and as `origin/<name>`.
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
  // The tail is the one thing this answer always has, even when every probe answered so quietly it left no
  // cause behind — see `NO_MAINLINE_WHY`.
  const causesText = causes.length > 0 ? `${causes.join("; ")}; ` : "";
  return { why: `${causesText}${NO_MAINLINE_WHY}` };
}

/**
 * What a ref probe printed when it printed nothing: "" → the ref simply does not exist; anything else is
 * output git should not have given, so it is quoted verbatim rather than read as absence.
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
 * The seam both reporting steps post through, and the witness the host-channel cases read. A test installs a
 * recorder; `undefined` is the forge adapter.
 *
 * Why a seam at all, when `handbackOutcome` already takes a `post`: the claim under test is that the HOST
 * CHANNEL POSTS NOTHING, and that claim is only falsifiable if the FORGE channel's post is observable. With no
 * seam here the two answers, "the host channel posted nothing" and "the forge channel tried to post and had no
 * forge", leave identical records and the case asserts nothing.
 */
let commentPoster: ((issue: number, body: string) => Promise<void>) | undefined;

/**
 * Install `poster` and hand back the undo. Scoped to a test on purpose: this is the one place a lean run's
 * comment leaves the process, so a case that swaps it must put the forge back. The returned function is
 * idempotent.
 */
export function setLeanCommentPoster(
  poster: ((issue: number, body: string) => Promise<void>) | undefined,
): () => void {
  commentPoster = poster;
  return () => {
    commentPoster = undefined;
  };
}

/** Get `body` in front of a human: the seam when one is installed, else the forge.
 * The seam is consulted BEFORE `forgeFor` so a recorded count cannot depend on a
 * forge a temp repo does not have (two network probes would sit in front of it).
 * `what` names the comment in the refusal, since a run with no adapter has to say
 * which of its promises it could not keep. */
async function deliverComment(repoRoot: string, issue: number, body: string, what: string) {
  if (commentPoster !== undefined) return commentPoster(issue, body);
  const forge = await forgeFor(repoRoot);
  if (!forge) throw new Error(`no forge adapter: cannot post the ${what} comment`);
  await forge.issueComment(issue, body);
}

/**
 * Post one comment listing the failed rules. Throws so the caller can report it: a run that could not tell the
 * operator why it refused is a worse failure than one that says so in the summary line.
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
  return deliverComment(repoRoot, issue, body, "not-ready");
}

/**
 * Post the handback comment: what the run still needs. The same adapter and the same public-text check
 * `postNotReady` goes through. It throws so the caller can record that nobody was told; `handback` is the
 * caller, and it never lets that throw end the run.
 */
export async function postHandback(repoRoot: string, issue: number, body: string): Promise<void> {
  return deliverComment(repoRoot, issue, body, "handback");
}

/**
 * Post the derived-contract comment: the criteria this run read out of a prose
 * ticket and is now building to. Silence here would leave an author reading a PR
 * whose acceptance criteria nobody approved, so the derivation is published the
 * moment it is made, fenced exactly as an author would write it and with the model
 * named — the two things needed to notice a bad derivation before the merge.
 */
export async function postDerivedSpec(
  repoRoot: string,
  issue: number,
  spec: PiSpec,
  model: string,
  guards: Guard[] = [],
): Promise<void> {
  const body = [
    `work-lean: issue #${issue} carried no \`pi-spec v1\` block, so this run derived one and is building to it.`,
    "",
    "Read the criteria below against the ticket. If they are wrong, correct them (or run /plan), and start the run again — the run re-reads the block from the issue.",
    "",
    renderPiSpec(spec),
    "",
    `- derived by ${model === "" ? "the run's default model" : `\`${model}\``}`,
    `- ${String(spec.criteria.length)} criteria, size ${spec.size}`,
    // A guard has no red test: the full verify tier ci runs before landing is what holds it.
    ...(guards.length === 0
      ? []
      : [
          "",
          "Regression guards — no red test; each is enforced by the run's full verify tier (`verify.full` in `.pi/work.json`, or the committed `.pi/verify-cmd`), which ci runs before the run can land:",
          ...guards.map((g) => `- ${g.text}`),
        ]),
  ].join("\n");
  return deliverComment(repoRoot, issue, body, "derived-spec");
}
