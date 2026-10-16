/**
 * headless/pr-url — the web URL of a cycle's PR for the headless result
 * (#1326), so a host does not rebuild it from the remote itself.
 *
 * A URL is reported only when it is unambiguous; otherwise the result carries
 * `prNumber` alone. In order:
 *
 *  1. A URL the driver recorded: the handoff comment it posted on the PR
 *     (`handoff-emitted` with `targetType: "pr"`), minus the comment anchor.
 *  2. The project's git remote, when there is exactly one (so the PR cannot
 *     be on another), the forge is GitHub or GitLab, and the web address is
 *     certain: an `http(s)` remote (host and port kept), or an ssh remote on
 *     github.com / gitlab.com. An ssh remote on any other host is skipped —
 *     its host may be an ssh alias, and its port is not the web port.
 *
 * Local reads only (`git remote`, `.pi/forge`); the forge probe is off.
 */

import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { detectForge } from "../forge-detect.ts";
import type { WorkState } from "../workflow-state.ts";

const execFileP = promisify(execFile);
const SSH_WEB_HOSTS = new Set(["github.com", "gitlab.com"]);
const SEGMENT = /^[A-Za-z0-9._-]+$/;

/** The PR URL of a recorded PR comment (`…/pull/<n>#issuecomment-…`). */
export function prUrlFromComment(commentUrl: string, prNumber: number): string | undefined {
  const m = commentUrl.match(/^(https?:\/\/[^#?]+\/(?:pull|-\/merge_requests)\/(\d+))(?:[#?].*)?$/);
  return m && Number(m[2]) === prNumber ? m[1] : undefined;
}

/** The PR URL the driver itself recorded for `prNumber`, if any. */
export function recordedPrUrl(state: WorkState, prNumber: number): string | undefined {
  for (let i = state.eventLog.length - 1; i >= 0; i--) {
    const e = state.eventLog[i];
    if (e?.kind !== "handoff-emitted" || e.targetType !== "pr" || !e.commentUrl) continue;
    const url = prUrlFromComment(e.commentUrl, prNumber);
    if (url) return url;
  }
  return undefined;
}

/** `https://host[:port]/group/…/repo` for a remote, or undefined when not certain. */
export function webRepoUrl(forge: string, remoteUrl: string): string | undefined {
  const u = remoteUrl.trim();
  let base: string | undefined;
  let repoPath: string | undefined;
  const http = u.match(/^(https?):\/\/(?:[^@/]+@)?([^/]+)\/(.+)$/i);
  const ssh = u.match(/^ssh:\/\/(?:[^@/]+@)?([^/:]+)(?::\d+)?\/(.+)$/i);
  const scp = u.match(/^(?:[^@/]+@)?([^/:]+):(?!\/)(.+)$/);
  if (http?.[1] && http[2] && http[3]) {
    base = `${http[1].toLowerCase()}://${http[2].toLowerCase()}`;
    repoPath = http[3];
  } else {
    const m = ssh ?? scp;
    const host = m?.[1]?.toLowerCase();
    if (!host || !SSH_WEB_HOSTS.has(host) || !m?.[2]) return undefined;
    base = `https://${host}`;
    repoPath = m[2];
  }
  const segments = repoPath
    .replace(/\.git$/i, "")
    .replace(/\/+$/, "")
    .split("/");
  if (!segments.every((s) => SEGMENT.test(s) && s !== "." && s !== "..")) return undefined;
  if (forge === "github" && segments.length !== 2) return undefined;
  if (forge === "gitlab" && segments.length < 2) return undefined;
  if (forge !== "github" && forge !== "gitlab") return undefined;
  return `${base}/${segments.join("/")}`;
}

/** `<repo>/pull/<n>` (GitHub) or `<repo>/-/merge_requests/<n>` (GitLab). */
export function formatPrUrl(
  forge: string,
  remoteUrl: string,
  prNumber: number,
): string | undefined {
  const repo = webRepoUrl(forge, remoteUrl);
  if (!repo) return undefined;
  return forge === "github" ? `${repo}/pull/${prNumber}` : `${repo}/-/merge_requests/${prNumber}`;
}

/** A PR-number → URL function from `repoRoot`'s single remote; never throws. */
export async function prUrlResolver(
  repoRoot: string,
): Promise<(prNumber: number) => string | undefined> {
  const none = () => undefined;
  try {
    const { stdout } = await execFileP("git", ["-C", repoRoot, "remote"], { timeout: 10_000 });
    if (stdout.trim().split("\n").filter(Boolean).length !== 1) return none;
    const d = await detectForge(repoRoot, { allowProbe: false });
    const url = d.url;
    return url ? (n) => formatPrUrl(d.forge, url, n) : none;
  } catch {
    return none;
  }
}
