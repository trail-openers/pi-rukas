/**
 * headless/pr-url — the web URL of a cycle's PR for the headless result
 * (#1326), so a host does not rebuild it from the remote itself.
 *
 * Resolved from the project's forge detection with the network probe off: a
 * GitHub or GitLab remote yields a URL, anything else yields none (the result
 * then carries `prNumber` alone). Local reads only — `git remote` and `.pi/forge`.
 */

import { detectForge, parseRemoteUrl } from "../forge-detect.ts";

/** `https://<host>/<owner>/<repo>/pull/<n>` (GitHub) or `/-/merge_requests/<n>` (GitLab). */
export function formatPrUrl(
  forge: string,
  remoteUrl: string | undefined,
  prNumber: number,
): string | undefined {
  const parsed = remoteUrl ? parseRemoteUrl(remoteUrl) : undefined;
  if (!parsed) return undefined;
  const base = `https://${parsed.host}/${parsed.owner}/${parsed.repo}`;
  if (forge === "github") return `${base}/pull/${prNumber}`;
  if (forge === "gitlab") return `${base}/-/merge_requests/${prNumber}`;
  return undefined;
}

/** A PR-number → URL function for `repoRoot`; never throws. */
export async function prUrlResolver(
  repoRoot: string,
): Promise<(prNumber: number) => string | undefined> {
  try {
    const d = await detectForge(repoRoot, { allowProbe: false });
    return (n) => formatPrUrl(d.forge, d.url, n);
  } catch {
    return () => undefined;
  }
}
