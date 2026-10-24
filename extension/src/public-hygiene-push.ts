/**
 * public-hygiene-push — the outgoing commits a `git push` would publish
 * (#1788).
 *
 * The command-side half of the hygiene guard lives in `public-hygiene-scan.ts`;
 * this is the git-side half, split out so each stays under the §12 size cap and
 * so the git plumbing has one owner. It answers one question — what text does
 * this push put in front of the world — and answers it with a list of texts and
 * a list of things it could not read, never with a verdict. The caller
 * (`public-hygiene-guard.ts`) decides; refusing on an unreadable range is the
 * caller's rule, expressed here as a `problems` entry.
 *
 * ## What is scanned, and against what
 *
 * The outgoing commits' MESSAGES and their ADDED diff lines, against the
 * PRIVATE denylist ONLY. The generic set (private IPv4s, home paths) is
 * deliberately not applied to a diff: a test fixture legitimately carries an
 * example address, and a guard that refused it would be switched off within a
 * week. The issue's acceptance criteria pin that split in both directions, so
 * the `generic: false` flag on every text here is load-bearing, not cosmetic.
 *
 * ## The trigger, and why other hosts are exempt
 *
 * Any remote whose host resolves to `github.com` through `parseRemoteUrl`
 * (forge-detect.ts) — the HOST TABLE decides, not repository visibility, which
 * nothing in this codebase can read. A private GitHub repo behind that host is
 * scanned too, which is the conservative direction; a company host name or a
 * self-hosted forge is not, per issue decision 3.
 *
 * ## The budget
 *
 * Every git call carries `PUSH_SCAN_TIMEOUT_MS` and `PUSH_SCAN_MAX_BUFFER`
 * (PM decision: 10 s, 5 MiB). Exceeding either is a `problems` entry, which the
 * guard turns into a refusal: a push nobody could read is not a push that was
 * read and found clean.
 */

import { parseRemoteUrl } from "./forge-detect.ts";
import { execGit, refResolves } from "./git-range.ts";
import type { PublishText, PushScanResult, ScanProblem } from "./public-hygiene-types.ts";
import {
  PUSH_SCAN_MAX_BUFFER,
  PUSH_SCAN_TIMEOUT_MS,
} from "./public-hygiene-scan.ts";
import type { ExecFn } from "./worktree.ts";

/** The host whose pushes publish to the public forge (issue decision 3). */
const PUBLIC_GITHUB_HOST = "github.com";

/** What the push scan needs from git, bounded. */
export interface PushScanDeps {
  exec: ExecFn;
  /** The directory the push runs in (the tool call's cwd). */
  cwd: string;
  timeoutMs?: number;
  maxBuffer?: number;
  /** Override for `git remote get-url` (tests pin the github.com decision offline). */
  remoteUrl?: (remote: string) => Promise<string>;
}

/**
 * Scan the commits a `git push` would publish: their messages and their ADDED
 * diff lines, against the private denylist only (issue decision: the generic
 * set is deliberately narrower for diff lines).
 *
 * The range is `<remote>/<branch>..<src>`; when the remote branch does not
 * exist the base falls back to `<remote>/HEAD`, and then to the merge base
 * with the default branch, so a first push still gets scanned. Every git call
 * is bounded by `PUSH_SCAN_TIMEOUT_MS` and `PUSH_SCAN_MAX_BUFFER`; exceeding
 * either is a problem, never a pass.
 */
export async function scanPushRange(deps: PushScanDeps): Promise<PushScanResult> {
  const timeout = deps.timeoutMs ?? PUSH_SCAN_TIMEOUT_MS;
  const maxBuffer = deps.maxBuffer ?? PUSH_SCAN_MAX_BUFFER;
  const git = (args: string[]) =>
    execGit(deps.exec, deps.cwd, args, { timeout, maxBuffer });
  const remotes = await git(["remote"]).catch(() => undefined);
  const names = (remotes ?? "")
    .split("\n")
    .map((l) => l.trim())
    .filter(Boolean);
  if (names.length === 0) {
    return {
      scanned: false,
      texts: [],
      problems: [{ location: "push", reason: "this clone has no remote to resolve" }],
    };
  }
  let target: { remote: string; host: string } | undefined;
  for (const name of names) {
    let url: string;
    try {
      url = deps.remoteUrl
        ? await deps.remoteUrl(name)
        : await git(["remote", "get-url", name]);
    } catch {
      return {
        scanned: false,
        texts: [],
        problems: [{ location: "push", reason: `the ${name} remote URL could not be read` }],
      };
    }
    const parsed = parseRemoteUrl(url.trim());
    if (parsed?.host === PUBLIC_GITHUB_HOST) {
      target = { remote: name, host: parsed.host };
      break;
    }
  }
  // No github.com remote: nothing here publishes to the public forge, so the
  // push is not this guard's business (issue decision: other hosts are not
  // scanned).
  if (!target) return { scanned: false, texts: [], problems: [] };
  let branch: string;
  try {
    branch = (await git(["rev-parse", "--abbrev-ref", "HEAD"])).trim();
  } catch {
    return {
      scanned: false,
      texts: [],
      problems: [{ location: "push", reason: "the current branch could not be resolved" }],
    };
  }
  const base = await resolveBase(deps.exec, deps.cwd, timeout, target.remote, branch);
  if (base === undefined) {
    return {
      scanned: false,
      texts: [],
      problems: [
        {
          location: "push",
          reason: `the outgoing range against ${target.remote} could not be resolved`,
        },
      ],
    };
  }
  const texts: PublishText[] = [];
  const problems: ScanProblem[] = [];
  let log: string;
  let patch: string;
  try {
    log = await git(["log", "--format=%H%x09%B%x1e", `${base}..HEAD`]);
  } catch (err) {
    return {
      scanned: true,
      texts,
      problems: [
        { location: "push", reason: `the outgoing commits could not be read (${codeOf(err)})` },
      ],
    };
  }
  for (const record of log.split("\u001e")) {
    const tab = record.indexOf("\t");
    if (tab < 0) continue;
    const sha = shortSha(record.slice(0, tab));
    const message = record.slice(tab + 1);
    texts.push({ location: `commit message (${sha})`, text: message, generic: false });
  }
  try {
    patch = await git(["log", "--patch", "--format=", `${base}..HEAD`]);
  } catch (err) {
    problems.push({
      location: "push",
      reason: `the added lines could not be read (${codeOf(err)})`,
    });
    return { scanned: true, texts, problems };
  }
  // The ADDED lines of the whole outgoing range, attributed to the commit that
  // introduced them so the refusal can name a path and a short sha.
  let file = "the diff";
  let sha = "";
  for (const line of patch.split("\n")) {
    if (line.startsWith("commit ")) {
      sha = shortSha(line.slice(7).trim());
      continue;
    }
    const hunk = /^\+\+\+ (?:a\/)?(.*)$/.exec(line);
    if (hunk?.[1] !== undefined && hunk[1] !== "/dev/null") {
      file = hunk[1];
      continue;
    }
    if (line.startsWith("+++") || line.startsWith("---")) continue;
    if (!line.startsWith("+")) continue;
    texts.push({
      location: `added lines (${sha}, ${file})`,
      text: line.slice(1),
      generic: false,
    });
  }
  return { scanned: true, texts, problems };
}

/** The base for the outgoing range: the remote branch, then the default branch
 * (`<remote>/HEAD`, then `<remote>/<default>`). Each probe distinguishes git's
 * OWN "that ref is not there" from "nobody could ask" via `refResolves` —
 * reading a killed or errored probe as absent would fall back to a base the
 * cycle never had and scan the wrong commits.
 */
async function resolveBase(
  exec: ExecFn,
  cwd: string,
  timeout: number,
  remote: string,
  branch: string,
): Promise<string | undefined> {
  const candidates = [`${remote}/${branch}`, `${remote}/HEAD`];
  for (const ref of candidates) {
    const state = await refResolves(exec, cwd, ref, timeout);
    if (state.state === "resolves") return ref;
    if (state.state === "unknown") return undefined;
  }
  // A clone whose remote has no HEAD symref: ask for its default branch by
  // name, which is the last base that means "what main has".
  for (const name of ["main", "master"]) {
    const ref = `${remote}/${name}`;
    const state = await refResolves(exec, cwd, ref, timeout);
    if (state.state === "resolves") return ref;
    if (state.state === "unknown") return undefined;
  }
  return undefined;
}

/** A short SHA for the refusal's location. */
function shortSha(sha: string): string {
  return sha.slice(0, 9);
}

/** An exec error's `code`, so a refusal names why it could not read without quoting content. */
function codeOf(err: unknown): string {
  const code = (err as { code?: unknown })?.code;
  if (typeof code === "string") return code;
  return err instanceof Error && err.message ? "unreadable" : "unknown error";
}
