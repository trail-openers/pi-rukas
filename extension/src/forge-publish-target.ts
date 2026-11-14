/**
 * forge-publish-target — the repository a forge adapter's own post writes to.
 *
 * The public-only gate asks one question before the driver posts: which
 * repository does this write to, and is it private? A private repository has no
 * public to protect, so the surface is skipped; anything the guard cannot name is
 * checked, because "could not tell" is never "clean". The adapter used to hand
 * that question whatever two segments a regex pulled off the raw remote URL, on
 * the host the *detection* reported — and both halves were wrong in the direction
 * that stops a scan:
 *
 *   - the host came from `ForgeDetection.host`, which on the config leg is the
 *     operator's `host=` value rather than a host the remote ever named, so a
 *     project on some self-hosted instance could be asked about as github.com and
 *     a `true` answer excused every post the cycle made;
 *   - the slug came from a path of any depth, so a remote whose path is deeper
 *     than `owner/repo` (which a github.com clone mislabelled as GitLab produces)
 *     yielded an owner carrying a slash. github.com serves one repository per
 *     owner, so that slug names nothing `gh` can resolve — and an answer about a
 *     repository the public host does not serve is an unverified claim used to
 *     skip a check.
 *
 * So the target is derived here, from the parsed remote, and refused rather than
 * truncated: an absent target routes the caller to the command-based resolver and
 * then to a lookup it cannot shortcut. Extraction is what the file-size cap
 * requires; the rule is the module's whole contract.
 */

import { type ForgeArg, parseRemoteUrl } from "./forge-detect.ts";
import type { RepoTarget } from "./public-hygiene-visibility.ts";
import { GITHUB_HOST } from "./public-hygiene-visibility.ts";

/**
 * Reduce a remote URL to the adapter's publish target, or `undefined` when the
 * remote names no repository this guard may treat as a checked target.
 *
 * `forge` is the detected type, passed to the parser so a GitLab subgroup project
 * keeps its whole namespace as the owner — the slug `glab` and the hygiene target
 * both need — with the project as the last segment.
 *
 * The host is the one the REMOTE carried, never the detection result's. Absent
 * means "unknown, so check": `isPrivateTarget` asks `gh` about github.com only,
 * and an unknown host is an explicit unknown rather than a claim.
 *
 * A `github.com` path deeper than `owner/repo` yields no target at all. That is
 * the fail-closed direction: a slug the public host does not serve cannot be
 * positively reported private, and only a positive private answer skips a check.
 */
export function forgePublishTarget(
  url: string | undefined,
  forge: ForgeArg,
): RepoTarget | undefined {
  if (!url) return undefined;
  const parsed = parseRemoteUrl(url, forge);
  if (!parsed) return undefined;
  const repo = parsed.path[parsed.path.length - 1] ?? "";
  const owner = parsed.path.slice(0, -1).join("/");
  if (owner === "" || repo === "") return undefined;
  // The parser already refuses a deep github.com path whatever forge was passed;
  // the check is restated here because this is the seam that decides whether the
  // gate gets a licence to stop checking, and the licence should not depend on a
  // rule holding only somewhere else.
  if (parsed.host === GITHUB_HOST && parsed.path.length !== 2) return undefined;
  return { owner, repo, host: parsed.host };
}
