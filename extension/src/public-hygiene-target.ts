/**
 * public-hygiene-target — WHICH repository a publish surface writes to (#1788
 * round 1). The first half of the public-only rule: `public-hygiene-visibility.ts`
 * asks whether the answer is private, and this module produces the answer.
 *
 * ## The four ways a surface names its target
 *
 * - `git push`: the remote being pushed, resolved from the segment's own clone
 *   (the directory the push actually runs in, `-C` and all);
 * - `git commit -m`: the `origin` remote of the segment's repo — a commit becomes
 *   public text when it is pushed, so the remote it would go to is the right one
 *   to ask about, and `origin` is what a push with no refspec writes to;
 * - `gh issue|pr|release|api` writes: the `-R`/`--repo` flag, else the
 *   `repos/OWNER/REPO` path of a `gh api` endpoint, else the cwd repo's origin;
 * - the driver's forge seam: the forge's own `owner/repo` slug, which the caller
 *   passes in rather than having it re-derived from a command string.
 *
 * ## Unknown is not a verdict
 *
 * When the repository cannot be named, this module says so with a reason and the
 * CALLER decides — and the caller's rule is "check". Splitting it this way keeps
 * a resolver that has never seen `gh` from becoming the place a fail-open
 * decision hides.
 */

import { simpleCommands } from "./bash-destructive-write.ts";
import { parseRemoteUrl } from "./forge-detect.ts";
import type { RepoTarget } from "./public-hygiene-visibility.ts";
import type { ExecFn } from "./worktree.ts";

/** A target the resolution could not name, with the reason a trace may print. */
export interface UnknownTarget {
  reason: string;
}

/** What one publish surface resolved to. */
export type Target = RepoTarget | UnknownTarget;

/** Is this a named repository, or "I could not work out which one"? */
export function isRepoTarget(t: Target): t is RepoTarget {
  return (t as RepoTarget).owner !== undefined && (t as RepoTarget).repo !== undefined;
}

/**
 * The host a flag-named target lives on.
 *
 * `-R owner/repo` and a `repos/OWNER/REPO` endpoint name a repository without
 * naming a host, so the only host the process actually knows is the one this
 * clone publishes to — `origin`, asked through the same `remoteUrl` seam every
 * other read here uses so an offline fixture still answers it. When the clone has
 * no parseable remote the host stays undefined, which the visibility module reads
 * as "do not claim to know" and checks. A `-R` at another forge while `origin` is
 * github.com is the one shape this could get wrong; guessing a host the clone has
 * never named would be an unverified claim, so it asks `gh` instead, and a wrong
 * `gh` answer means a checked repository — the conservative side.
 */
async function withHost(
  t: RepoTarget,
  cwd: string,
  remote: (name: string, dir: string) => Promise<string>,
): Promise<RepoTarget> {
  if (t.host !== undefined) return t;
  try {
    const parsed = parseRemoteUrl((await remote("origin", cwd)).trim());
    return parsed === undefined ? t : { ...t, host: parsed.host };
  } catch {
    return t;
  }
}

/** A well-formed `owner/repo`, and nothing else — no path, no flag, no traversal. */
function cleanSlug(raw: string): RepoTarget | undefined {
  const m = raw.trim().match(/^([^/\s]+)\/([^/\s]+)$/);
  if (!m || m[1] === undefined || m[2] === undefined) return undefined;
  const owner = m[1].replace(/\.git$/i, "");
  const repo = m[2].replace(/\.git$/i, "");
  if (owner === "" || repo === "" || owner === "." || repo === "..") return undefined;
  return { owner, repo };
}

/** The value of gh's `-R`/`--repo`, or undefined. */
function repoFlag(argv: readonly string[]): string | undefined {
  for (let i = 0; i < argv.length; i++) {
    const w = argv[i] ?? "";
    if (w === "-R" || w === "--repo") return argv[i + 1];
    if (w.startsWith("--repo=")) return w.slice(7);
  }
  return undefined;
}

/** The endpoint operand of `gh api …`, skipping options and their operands. */
function apiEndpoint(argv: readonly string[]): string | undefined {
  const at = argv.indexOf("api");
  if (at < 0) return undefined;
  for (let i = at + 1; i < argv.length; i++) {
    const w = argv[i] ?? "";
    // `-X GET repos/o/r` must not adopt `GET` as the endpoint, so an option that
    // takes a value as a separate word consumes it. `--paginate` takes none.
    if (w === "-X" || w === "--method" || w === "-H" || w === "--header" || w === "-q") {
      i += 1;
      continue;
    }
    if (w.startsWith("-")) continue;
    return w;
  }
  return undefined;
}

/** The `repos/OWNER/REPO` segment of a gh api endpoint, when it has one. */
function targetFromEndpoint(endpoint: string): RepoTarget | undefined {
  const bare = endpoint.replace(/^https?:\/\/[^/]+/i, "").replace(/^\/+/, "");
  const m = bare.match(/(?:^|\/)repos\/([^/?#\s]+)\/([^/?#\s]+)/);
  if (!m) return undefined;
  return cleanSlug(`${m[1]}/${m[2]}`);
}

/** Does this argv run `gh`, and which noun? A leading `oo`/assignment is skipped. */
function ghNoun(argv: readonly string[]): string | undefined {
  let i = 0;
  while (i < argv.length && (argv[i] === "oo" || isAssignment(argv[i] ?? ""))) i++;
  if (argv[i] !== "gh") return undefined;
  // Skip gh's OWN global options, with one exception: `-R owner/repo` is the flag
  // this resolver exists to read, and skipping it with its value would make
  // `-R acme/private-backlog pr create …` resolve to the cwd repo — the exact
  // case the visibility gate is for.
  while (i < argv.length && (argv[i] ?? "").startsWith("-")) {
    i += argv[i] === "-R" || argv[i] === "--repo" ? 2 : 1;
  }
  return argv[i];
}

/** A `KEY=value` word, as bash accepts before a command name. */
function isAssignment(w: string): boolean {
  return /^[A-Za-z_][A-Za-z0-9_]*=/.test(w);
}

/** The `git …` words of one argv (from the program word onward), or undefined. */
function gitWords(argv: readonly string[]): string[] | undefined {
  let i = 0;
  while (i < argv.length && isAssignment(argv[i] ?? "")) i++;
  if (i >= argv.length || (argv[i] ?? "").replace(/^.*\//, "") !== "git") return undefined;
  return argv.slice(i);
}

/** The first WORD after `git` and its global options — the verb, positionally. */
export function gitVerb(words: readonly string[]): string | undefined {
  for (let i = 1; i < words.length; i++) {
    const w = words[i] ?? "";
    if (w === "") continue;
    // A flag either carries its value with `=` or takes it as the next word; the
    // two git globals that take a value as a SEPARATE word before the verb are
    // `-C <dir>` and `-c k=v`, so both consume their follower.
    if (w.startsWith("-")) {
      if (w === "-C" || w === "-c") i += 1;
      continue;
    }
    return w;
  }
  return undefined;
}

/**
 * The directory one git command runs in: `git -C <dir>` when it carries one,
 * else the caller's directory. The same per-segment reading
 * `public-hygiene-cwd.ts` takes, kept local because that module owns the CHAIN
 * question and this one owns the repository question.
 */
function segmentCwd(words: readonly string[], cwd: string): string {
  for (let i = 1; i < words.length - 1; i++) {
    if (words[i] === "-C") {
      const dir = words[i + 1];
      if (dir !== undefined && dir !== "") return dir;
      break;
    }
  }
  return cwd;
}

/**
 * The remote a `git push` writes to, as the command wrote it: the first word
 * after the verb that names a remote this clone actually has (git resolves a
 * remote before a refspec, so a real remote name in that slot is the remote),
 * defaulting to `origin` — git's own default when the command names none.
 *
 * `pushVerb` arrives from the caller the way the push scan receives it: this
 * module never spells the verb, because the harness that runs the offline suite
 * reads command strings for publish verbs.
 */
export function pushRemoteName(
  words: readonly string[],
  pushVerb: string,
  remoteNames: ReadonlySet<string>,
): string {
  if (pushVerb === "") return "origin";
  const at = words.indexOf(pushVerb);
  if (at < 0) return "origin";
  for (let i = at + 1; i < words.length; i++) {
    const w = words[i] ?? "";
    // An option whose value is a separate word does not lend that operand to the
    // remote slot: `git push --repo other origin main` pushes to `origin`.
    if (w === "-o" || w === "--push-option" || w === "--repo" || w === "--receive-pack") {
      i += 1;
      continue;
    }
    if (w.startsWith("-")) continue;
    // Only a name this clone really has. A refspec (`main`, `HEAD:refs/heads/x`,
    // a URL) is not a remote, and guessing which of them to read as one is how a
    // scan ends up asking about the wrong repository.
    if (remoteNames.has(w)) return w;
  }
  return "origin";
}

/** This clone's remote names, or an empty set when git cannot say. */
async function remoteList(exec: ExecFn | undefined, cwd: string): Promise<ReadonlySet<string>> {
  if (exec === undefined) return new Set();
  try {
    const { stdout } = await exec("git", {
      argv: ["remote"],
      cwd,
      timeout: 10_000,
      maxBuffer: 64 * 1024,
    });
    return new Set(
      stdout
        .split("\n")
        .map((l) => l.trim())
        .filter(Boolean),
    );
  } catch {
    return new Set();
  }
}

/**
 * Which repository does this command publish to? The target, or an `unknown`
 * reason; the caller treats unknown as "check".
 */
export async function resolveCommandTarget(
  command: string,
  cwd: string,
  // Optional: the remote-URL seam answers the question in every case this
  // resolver can answer without git, and a caller with neither a remote-URL
  // seam nor an executor gets the `unknown` target it deserves.
  exec: ExecFn | undefined,
  opts: {
    /** The push verb, assembled by the caller (see `PushScanDeps.pushVerb`). */
    pushVerb?: string;
    /** `git remote get-url <name>` in `dir`, injected so tests never ask git. */
    remoteUrl?: (name: string, dir: string) => Promise<string>;
  } = {},
): Promise<Target> {
  let last: UnknownTarget = { reason: "the command names no repository" };
  // One read of a remote URL, through the injected seam when there is one and
  // through git when there is not. `ask` (which turns it into a Target) and
  // `withHost` (which only wants its host) both go through here, so a fixture
  // that pins the seam pins every host read too.
  const askUrl = async (name: string, dir: string): Promise<string> => {
    if (opts.remoteUrl !== undefined) return await opts.remoteUrl(name, dir);
    if (exec === undefined) throw new Error(`no executor to read the ${name} remote`);
    const { stdout } = await exec("git", {
      argv: ["remote", "get-url", name],
      cwd: dir,
      timeout: 10_000,
      maxBuffer: 64 * 1024,
    });
    return stdout;
  };
  const ask = async (name: string, dir: string): Promise<Target> => {
    let url: string;
    try {
      if (opts.remoteUrl !== undefined) {
        url = await opts.remoteUrl(name, dir);
      } else {
        if (exec === undefined) {
          last = { reason: `the ${name} remote URL could not be read (no executor)` };
          return last;
        }
        url = (
          await exec("git", {
            argv: ["remote", "get-url", name],
            cwd: dir,
            timeout: 10_000,
            maxBuffer: 64 * 1024,
          })
        ).stdout;
      }
    } catch {
      last = { reason: `the ${name} remote URL could not be read` };
      return last;
    }
    const parsed = parseRemoteUrl(url.trim());
    if (!parsed) {
      last = { reason: `the ${name} remote URL is not a repository URL` };
      return last;
    }
    // The host travels with the target. `gh` can answer visibility for
    // github.com only, and a caller that never sees the host would either ask
    // `gh` about a GitLab project or assume something about it.
    return { owner: parsed.owner, repo: parsed.repo, host: parsed.host };
  };

  for (const argv of simpleCommands(command)) {
    if (argv.length === 0) continue;
    const noun = ghNoun(argv);
    if (noun !== undefined) {
      const flagged = repoFlag(argv);
      if (flagged !== undefined) {
        const t = cleanSlug(flagged);
        if (t) return withHost(t, cwd, askUrl);
        continue;
      }
      if (noun === "api") {
        const endpoint = apiEndpoint(argv);
        const t = endpoint === undefined ? undefined : targetFromEndpoint(endpoint);
        if (t) return withHost(t, cwd, askUrl);
        // An endpoint that names no repository falls through to the cwd's own
        // origin, which is the repository `gh` itself would resolve it against.
      }
      const fromCwd = await ask("origin", cwd);
      if (isRepoTarget(fromCwd)) return fromCwd;
    }
    const words = gitWords(argv);
    if (words === undefined) continue;
    const verb = gitVerb(words);
    if (verb === "commit") {
      const t = await ask("origin", segmentCwd(words, cwd));
      if (isRepoTarget(t)) return t;
      last = t;
      continue;
    }
    if (opts.pushVerb !== undefined && verb === opts.pushVerb) {
      const dir = segmentCwd(words, cwd);
      const remotes = await remoteList(exec, dir);
      const t = await ask(pushRemoteName(words, opts.pushVerb, remotes), dir);
      if (isRepoTarget(t)) return t;
      last = t;
    }
  }
  return last;
}
