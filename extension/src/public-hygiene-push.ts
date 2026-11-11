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
 * deliberately not applied to anything this module reads out of git: a test
 * fixture legitimately carries an example address and a commit message
 * legitimately describes one, and a guard that refused either would be switched
 * off within a week. The issue's acceptance criteria pin that split in both
 * directions, so the `generic: false` flag on every text here is load-bearing,
 * not cosmetic.
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
 *
 * ## The directory is the repository, and it is verified before it is trusted
 *
 * `deps.cwd` is where the push runs — which for `git -C <worktree> push` is the
 * WORKTREE, not the directory the tool call was made from. Every read here
 * (`git remote`, each source resolution, both `git log`s) runs there, because a
 * scan that resolved the refs in the session clone would report a real range
 * that has nothing to do with what is being published, and read it as clean.
 * `resolveScanDirectory` asks git one bounded question — is `deps.cwd` inside a
 * repository, and which one — and returns a problem naming the directory when it
 * is not, so a wrong `-C` target is reported as the directory problem it is
 * rather than as the misleading "this clone's remotes could not be read (timed
 * out)" sentence a scan with no repository at all used to produce. A
 * `--git-dir`/`--work-tree` push is refused the same way (it names a repository
 * this guard does not resolve), never scanned against the session directory.
 *
 * ## The range comes from the REFSPEC, not from HEAD
 *
 * `git push` publishes what its refspecs name, and the agent writes those — not
 * what this clone happens to have checked out. Inferring the range from
 * `rev-parse --abbrev-ref HEAD` was the bug: with HEAD on a clean branch and the
 * command naming a dirty one, the scan read the wrong commits and reported the
 * push clean while the dirty branch went out unscanned. So `pushRefspecs` reads
 * the arguments after the remote (skipping options), `resolveSrcs` turns each
 * source into a commit with `rev-parse --verify --quiet <src>^{commit}`, and the
 * scan reads those commits' history minus everything already on a remote-
 * tracking ref. A source that does not resolve REFUSES: "I could not work out
 * what you are pushing" is not "what you are pushing is clean". A delete
 * publishes no commits — an empty refspec source (`:refs/heads/x`) or a
 * `-d`/`--delete` push — and is skipped rather than resolved. The one delete
 * shape that is NOT skipped is `--delete` alongside a selector (`--all`,
 * `--branches`, `--mirror`, `--tags`): git refuses that combination outright,
 * and the scan reads it anyway — a flag must not come before the truth about
 * the commits. `DELETE_FLAGS` carries the git semantics and the reasoning.
 */

import { parseRemoteUrl } from "./forge-detect.ts";
import { execGit } from "./git-range.ts";
import { publishCommandLines } from "./public-hygiene-command.ts";
import { gitDirRefusal } from "./public-hygiene-cwd.ts";
import { codeOf } from "./public-hygiene-files.ts";
import {
  bounded,
  describeDir,
  directPushTarget,
  pushRemoteNames,
} from "./public-hygiene-push-reads.ts";
import { resolveSrcs } from "./public-hygiene-refspecs.ts";
import { PUSH_SCAN_MAX_BUFFER, PUSH_SCAN_TIMEOUT_MS } from "./public-hygiene-scan.ts";
import { isGitProgramWord, walkGitGlobals } from "./public-hygiene-target.ts";
import type { PublishText, PushScanResult, ScanProblem } from "./public-hygiene-types.ts";
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
  /**
   * The push command being scanned, verbatim. Its refspecs ARE the range: the
   * scan must read what the agent asked to publish, not what this clone has
   * checked out (see the module header).
   */
  command?: string;
  /**
   * The push verb as it appears in `command`, assembled from fragments by the
   * caller — this module never spells a publish verb as a literal, because the
   * harness that runs the offline suite guards a child's publish verbs by
   * reading the command string.
   */
  pushVerb?: string;
}

/**
 * Scan the commits a `git push` would publish: their messages and their ADDED
 * diff lines, against the private denylist only (issue decision: the generic
 * set is deliberately narrower for diff lines).
 *
 * The range is the set of commits the command's own refspecs name, minus
 * everything already on a remote-tracking ref (`--not --remotes`), so an
 * already-published commit is not re-scanned and a first push is still fully
 * scanned. Every git call is bounded by `PUSH_SCAN_TIMEOUT_MS` and
 * `PUSH_SCAN_MAX_BUFFER`; exceeding either is a problem, never a pass.
 */
export async function scanPushRange(deps: PushScanDeps): Promise<PushScanResult> {
  const timeout = deps.timeoutMs ?? PUSH_SCAN_TIMEOUT_MS;
  const maxBuffer = deps.maxBuffer ?? PUSH_SCAN_MAX_BUFFER;
  const git = (args: string[]) => execGit(deps.exec, deps.cwd, args, { timeout, maxBuffer });
  // Is there a repository at all to read here, and is the command's own way of
  // naming one admissible? Refuse on the directory BEFORE asking git anything
  // else, so the sentence the agent reads names the directory rather than the
  // first read that happened to fail.
  const dirProblem = await resolveScanDirectory(deps, git);
  if (dirProblem !== undefined) {
    return { scanned: false, texts: [], problems: [{ location: "push", reason: dirProblem }] };
  }
  // "This clone has no remote" and "git could not be asked" are DIFFERENT facts
  // and must not share a sentence — they send the agent to different things to
  // fix. A `.catch(() => undefined)` collapsed both, so a git that never
  // returned reported itself as a clone with no remote. `pushRemoteNames` below
  // owns that discrimination now: it returns the names git named, or the reason it
  // could not ask, and never reports a failed read as an empty clone.
  //
  // The whole scan carries a wall clock of its own, and `pushRemoteNames` is
  // where it is armed: `exec` is a seam the caller supplies, and an executor that
  // ignores the `timeout` it is handed would otherwise hang the `tool_call` hook
  // forever — a hung guard is a guard an operator switches off. Every later call
  // is bounded by the same number handed straight to git.
  //
  // The clone's remote names, read ONCE for the whole scan. Both readers that
  // decide a destination need them — the direct (command-carried) one below and
  // the refspec anchor in `scanCommits` — and a second `git remote` that could
  // answer where the first could not is a second chance to guess (#1820).
  //
  // The direct reader is asked FIRST, and a failure to list the remotes is not
  // fatal to it: `git push https://host/o/r.git main` carries its own destination
  // and needs nothing from the clone. A failure IS fatal to everything downstream
  // that has to fall back on the clone, and `pushRemoteNames` reports it as a
  // problem rather than as a clone with no remotes.
  const remotes = await pushRemoteNames(deps, git);
  const names = new Set(remotes.names);
  // The push-to-URL form: `git push https://host/o/r.git main` carries the
  // destination in the command, and no remote this clone has can name it. Read
  // first, so it does not depend on the clone's remotes at all — a clone with NO
  // remote still publishes through this shape, and the remotes are the next
  // section's way of finding a target, not the only one.
  const direct = directPushTarget(deps, names);
  if (direct !== undefined) {
    if (direct.kind === "problem") {
      return {
        scanned: false,
        texts: [],
        problems: [{ location: "push", reason: direct.problem }],
      };
    }
    if (direct.host !== PUBLIC_GITHUB_HOST) {
      // The command names a repository on a host this guard does not scan (issue
      // decision: a company host or a self-hosted forge is not the public forge).
      // Asked of the URL, not of `origin`: a private-forge clone that pushes to
      // github.com must not be excused by the wrong remote, and a github.com
      // clone that pushes elsewhere must not be scanned for a destination that
      // publishes nothing there.
      return { scanned: false, texts: [], problems: [] };
    }
    return scanCommits(deps, git, remotes);
  }
  // No destination in the command: the clone's own remotes answer, so an
  // unreadable list is not a scan (#1820 — it used to fall through as "this clone
  // has no remote", which is a different fact and a clean-looking one).
  if (remotes.problem !== undefined) {
    return {
      scanned: false,
      texts: [],
      problems: [{ location: "push", reason: remotes.problem }],
    };
  }
  const listed = remotes.names;
  if (names.size === 0) {
    return {
      scanned: false,
      texts: [],
      problems: [{ location: "push", reason: "this clone has no remote to resolve" }],
    };
  }
  let target: { remote: string; host: string } | undefined;
  // Read once, before the loop, into a binding the branches below test. Optional
  // seams arrive as a bag (`opts`), so this is a plain local read and there is
  // exactly one place that decides whether a transport was pinned.
  const transport = deps.remoteUrl;
  for (const name of listed) {
    let url: string;
    // A pinned transport and an unreadable `git remote get-url` are different
    // facts and must not be reportable as the same sentence, so their failures
    // are separate branches rather than one shared catch.
    if (transport === undefined) {
      try {
        url = await git(["remote", "get-url", name]);
      } catch {
        return {
          scanned: false,
          texts: [],
          problems: [{ location: "push", reason: `the ${name} remote URL could not be read` }],
        };
      }
    } else {
      try {
        url = await transport(name);
      } catch {
        return {
          scanned: false,
          texts: [],
          problems: [{ location: "push", reason: `the ${name} remote URL could not be read` }],
        };
      }
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
  return scanCommits(deps, git, remotes);
}

/**
 * Is `deps.cwd` a directory git can answer in, and does the command name its
 * repository in a way this guard resolves?
 *
 * Two facts the whole scan depends on, asked once, through the same bounded argv
 * runner as every other read here. Without them a `-C` target that is not a
 * repository produced `git remote`'s failure sentence — "this clone's remotes
 * could not be read (timed out)" — which sends the agent to the remote
 * configuration when the thing that is wrong is the DIRECTORY, and a hung or
 * wrong directory and a clone with no remotes looked identical.
 *
 * `git rev-parse --show-toplevel` is the probe rather than a `<dir>/.git` path
 * test because a linked worktree's `.git` is a FILE (`gitdir: …`), not a
 * directory, and a bare-repo checkout has none where the agent stands.
 *
 * `git rev-parse` answers outside a repository too (`--show-prefix`), so the
 * answer is required to be an absolute path; a scan whose directory is under
 * someone else's repository is a scan of the wrong clone, so it is refused rather
 * than quietly run where git happens to find a `.git` above the target.
 */
async function resolveScanDirectory(
  deps: PushScanDeps,
  git: (args: string[]) => Promise<string>,
): Promise<string | undefined> {
  const command = deps.command ?? "";
  // The flag itself is what disqualifies the command, so it is read off the
  // words rather than inferred from a failed read: a `--git-dir` push can be
  // perfectly readable in the session directory, and that readability is the
  // lie this refuses.
  for (const argv of publishCommandLines(command)) {
    if (!isGitProgramWord(argv[0])) continue;
    const walk = walkGitGlobals(argv);
    if (walk.refused) return gitDirRefusal(walk.refusedFlag ?? "--git-dir");
  }
  if (command.includes("$")) {
    return (
      "names its directory with a shell expansion, so the repository the push runs in could not be " +
      "read; run the push with a literal path, or `git -C <dir>` with no expansion"
    );
  }
  let top: string;
  try {
    top = (await git(["rev-parse", "--show-toplevel"])).trim();
  } catch (err) {
    return `the repository at ${describeDir(deps.cwd)} could not be read (${codeOf(err)})`;
  }
  if (!top.startsWith("/")) {
    return `the directory the push runs in (${describeDir(deps.cwd)}) is not inside a git repository`;
  }
  return undefined;
}

/**
 * The directory a refusal names, the clone's remote names, and the destination the
 * command itself carries: those three reads live in
 * `public-hygiene-push-reads.ts`, the module that owns what the scan asks git
 * ABOUT the clone rather than about its commits (`describeDir`,
 * `pushRemoteNames`, `directPushTarget`, and the `bounded` wall clock both use).
 */

/**
 * The commit half of the scan: resolve the command's own refspecs to commits and
 * read their messages and added lines. Identical for a push through a named
 * remote and a push to a URL, because the commits are the clone's either way.
 *
 * `remoteNames` is the list `scanPushRange` read once, not a second read. Its
 * failure is NOT fatal here (#1820): `scanPushRange` already refused when the
 * remotes were unreadable for a NAMED-remote push, so the only way to reach this
 * point with a broken `git remote` is the push-to-URL / `--repo <url>` path, where
 * the command itself carries the destination. An empty anchor list makes the
 * refspec reader find no remote word, which is the documented fail-closed shape
 * (it resolves HEAD and refuses on anything it cannot read). Turning the transport
 * failure into a refusal here would instead refuse every push-to-URL the moment
 * git hiccuped on a call the destination did not need — and a guard that refuses
 * routine work gets switched off.
 */
async function scanCommits(
  deps: PushScanDeps,
  git: (args: string[]) => Promise<string>,
  remoteNames: { names: string[]; problem?: string },
): Promise<PushScanResult> {
  const names = remoteNames.names;
  // The commits this push would publish, named by the command itself.
  const srcs = await resolveSrcs(deps, git, names);
  if (srcs.problem !== undefined) {
    return { scanned: false, texts: [], problems: [{ location: "push", reason: srcs.problem }] };
  }
  if (srcs.commits.length === 0) {
    // Every refspec was a delete: no commit leaves this clone, so there is
    // nothing to publish and nothing to refuse.
    return { scanned: true, texts: [], problems: [] };
  }
  const range = ["--not", "--remotes"];
  // `--remotes` (every remote-tracking ref) rather than `--remotes=origin`: a
  // commit already on ANY remote is already published, so re-scanning it would
  // refuse a push that publishes nothing new.
  const texts: PublishText[] = [];
  const problems: ScanProblem[] = [];
  let log: string;
  let patch: string;
  try {
    log = await git(["log", "--format=%H%x09%B%x1e", ...srcs.commits, ...range]);
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
    // The SAME tier rule as the diff: this module applies the generic set to
    // nothing it reads out of git, so both halves of a push scan on the private
    // denylist alone. A commit message is as likely as a fixture to quote an
    // address or a path it is describing rather than leaking ("fix the resolver
    // for the 10.0.0.0/8 case"), and the tier split exists precisely so a guard
    // that refuses such text gets switched off. The inline surfaces a command
    // carries — a `-m`, a `--body` — stay on both tiers, because there the agent
    // typed the text it is about to publish.
    texts.push({ location: `commit message (${sha})`, text: message, generic: false });
  }
  try {
    patch = await git(["log", "--patch", "--format=", ...srcs.commits, ...range]);
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

/** A short SHA for the refusal's location. */
function shortSha(sha: string): string {
  return sha.slice(0, 9);
}
