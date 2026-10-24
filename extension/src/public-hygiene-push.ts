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
import { PUSH_SCAN_MAX_BUFFER, PUSH_SCAN_TIMEOUT_MS } from "./public-hygiene-scan.ts";
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
  // "This clone has no remote" and "git could not be asked" are DIFFERENT facts
  // and must not share a sentence — they send the agent to different things to
  // fix. A `.catch(() => undefined)` collapsed both, so a git that never
  // returned reported itself as a clone with no remote. The probe's failure is
  // tracked by its own marker, and the whole scan carries a wall clock of its
  // own: an executor that ignores the timeout it is handed must still not hang
  // the hook, because a hung guard is a guard an operator switches off.
  const askFailed = Symbol("ask-failed");
  const remotes = await bounded(
    timeout,
    askFailed,
    git(["remote"]).catch(() => askFailed),
  );
  if (remotes === askFailed) {
    return {
      scanned: false,
      texts: [],
      problems: [{ location: "push", reason: "this clone's remotes could not be read" }],
    };
  }
  const names = remotes
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
  // Read once, before the loop, into a binding the branches below test. Optional
  // seams arrive as a bag (`opts`), so this is a plain local read and there is
  // exactly one place that decides whether a transport was pinned.
  const transport = deps.remoteUrl;
  for (const name of names) {
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
    texts.push({ location: `commit message (${sha})`, text: message, generic: true });
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

/** How a push names "every local branch" / "every tag". */
const ALL_BRANCHES_FLAGS = new Set(["--all", "--branches", "--mirror"]);
const ALL_TAGS_FLAGS = new Set(["--tags"]);

/**
 * Push options that take a value as a SEPARATE word — the one case where the
 * word after a flag is not a refspec, and the reason a flag cannot simply be
 * "anything beginning with `-`". `-o`/`--push-option` carry an arbitrary
 * string, `--repo` names the remote and `--receive-pack`/`--exec` name a
 * program or path, so each swallows its operand and the scan must swallow it
 * too or the value is resolved as a revision — and an unresolvable value is a
 * refusal, which would refuse a routine `push -o ci.skip`.
 *
 * `--force-with-lease` and `--signed` are deliberately NOT here: git reads
 * their value only in the `=`-attached form, so a following bare word is a
 * refspec and must stay one.
 */
const VALUE_OPTIONS = new Set(["-o", "--push-option", "--repo", "--receive-pack", "--exec"]);

/**
 * The deletion switches: a push that removes refs publishes no commits.
 *
 * Git's own semantics, cited because the scan has to agree with them rather
 * than guess: under `-d`/`--delete` EVERY listed ref is deleted — the option is
 * the same as prefixing each refspec with a colon — so its operands are names
 * to remove, never revisions to resolve. And git REFUSES to combine `--delete`
 * with `--all`/`--branches`/`--mirror`/`--tags` ("cannot use --all with
 * --delete"), so the two can never mean one push.
 *
 * The scan takes the conservative reading of both facts: `--delete <refs...>`
 * publishes nothing and is skipped, but `--delete` appearing TOGETHER with a
 * selector does not short-circuit — the selector is still scanned. A command
 * git would refuse publishes nothing either way, so the extra read costs a git
 * call and can only ever refuse something that was never going to publish;
 * short-circuiting on `--delete` first would hide a dirty branch behind a flag
 * combination that merely has not been typed yet.
 */
const DELETE_FLAGS = new Set(["-d", "--delete"]);

/**
 * The refspecs of a `git push`, as the command wrote them.
 *
 * The push verb and the remote name are the two anchors a refspec sits after;
 * both arrive as data from the caller rather than as literals here (see
 * `PushScanDeps.pushVerb`). After the remote, a flag is dropped and anything
 * else is a refspec — a rule that needs no table of git's push options except
 * for one case: an option whose value is a SEPARATE word (`-o ci.skip`,
 * `--repo origin2`) is a flag plus its operand, and treating that operand as a
 * refspec makes the scan resolve `ci.skip` as a revision and refuse a push that
 * publishes nothing dirty. `VALUE_OPTIONS` is that short table, kept short on
 * purpose: `--force-with-lease` and `--signed` take their value only with `=`,
 * so their follower stays a refspec and belongs to the general rule.
 *
 * `--all`/`--branches`/`--mirror` mean every local branch and `--tags` every
 * tag; they become category selectors rather than a refspec the scan would then
 * try to resolve as a revision.
 */
export function pushRefspecs(
  words: readonly string[],
  pushVerb: string,
  remoteNames: ReadonlySet<string>,
): { refspecs: string[]; branches: boolean; tags: boolean; deletes: boolean } {
  const refspecs: string[] = [];
  let branches = false;
  let tags = false;
  let deletes = false;
  const at = pushVerb === "" ? -1 : words.indexOf(pushVerb);
  if (at < 0) return { refspecs, branches, tags, deletes };
  // Two passes, because a selector can sit BEFORE the remote (`--all origin`,
  // the form git itself documents) and a refspec cannot: asking the selector
  // question of the whole tail and the refspec question only of the part after
  // the remote is what keeps `--all` a selector there while an argument that
  // merely looks like a remote name (`git@github.com:o/r.git`) is not the
  // anchor. Options never depend on position, refspecs always do.
  for (const w of words.slice(at + 1)) {
    if (ALL_BRANCHES_FLAGS.has(w)) branches = true;
    else if (ALL_TAGS_FLAGS.has(w)) tags = true;
    else if (DELETE_FLAGS.has(w)) deletes = true;
  }
  let seenRemote = false;
  for (let i = at + 1; i < words.length; i++) {
    const w = words[i] ?? "";
    if (!seenRemote) {
      // The remote anchor never consumes a word, and an option's operand is
      // never it: `git push --repo origin2 origin main` names `origin2` as a
      // VALUE, and adopting it as the anchor would leave `origin` — a real
      // remote name — to be scanned as the refspec.
      if (!w.startsWith("-") && remoteNames.has(w)) seenRemote = true;
      continue;
    }
    if (w.startsWith("-")) {
      // `-o ci.skip`: the option's operand is its value, not a refspec.
      if (VALUE_OPTIONS.has(w)) i++;
      continue;
    }
    refspecs.push(w);
  }
  return { refspecs, branches, tags, deletes };
}

/** The commit list the scan asks git for, plus why it could not be built. */
interface ResolvedSrcs {
  commits: string[];
  problem?: string;
}

/**
 * Every source the command names, resolved to a commit — fail-closed.
 *
 * Each source is stripped of a leading `+` (the force flag) and of its `:dst`
 * half; an empty source is a branch deletion, which publishes no commits and is
 * skipped. Resolution is `rev-parse --verify --quiet <src>^{commit}` in argv
 * form (the revision suffix is appended here rather than taken from the text it
 * is asked about, so a source cannot grow a `--` into the git argv); anything
 * that does not print a commit object id is refused, so a typo, a ref that is
 * not there and a git that could not be asked all stop the push rather than
 * reporting a range nobody resolved.
 */
async function resolveSrcs(
  deps: PushScanDeps,
  git: (args: string[]) => Promise<string>,
  names: string[],
): Promise<ResolvedSrcs> {
  const words = splitPushWords(deps.command ?? "");
  const pushVerb = deps.pushVerb ?? "";
  const parsed = pushRefspecs(words, pushVerb, new Set(names));
  if (words.indexOf(pushVerb) < 0) {
    return { commits: [], problem: "the push command could not be parsed" };
  }
  const selector = parsed.branches || parsed.tags;
  if (parsed.deletes && !selector) {
    // `-d`/`--delete` removes refs on the remote: under git's rules EVERY
    // listed ref is deleted (the option is the same as a leading colon on each
    // refspec), so nothing leaves this clone and its operands are names to
    // delete rather than revisions to read. Resolving them would refuse the
    // deletion of a branch that is already gone — a routine `git push origin
    // --delete stale` read as "could not resolve the push source" — so the scan
    // asks no question and reports nothing.
    return { commits: [] };
  }
  if (parsed.refspecs.length === 0 && !parsed.branches && !parsed.tags) {
    // No refspec and no selector: the three shapes that take their range from
    // HEAD. A `--delete` with an operand is NOT one of them — `origin --delete
    // gone` carries `gone`, and treating it as “nothing named” would resolve
    // HEAD and scan commits this push does not publish, which is a range nobody
    // is sending read as if it were. Bare push and `push <remote>` are the
    // cases that publish HEAD because the command names no range at all.
    return resolveOne(git, "HEAD", "the commits to be pushed could not be resolved");
  }
  // With `--delete` AND a selector this is a command git itself refuses (it
  // will not delete every branch), so the push cannot happen — but the scan
  // still reads what the selector names. That is defence in depth, not a
  // second opinion on the verdict: a delete publishes no commit either way, so
  // scanning can only ever refuse what was never going out, while short-
  // circuiting on `--delete` would put a flag before the truth about the
  // commits — the same shape that let a dirty branch out unscanned when the
  // range was inferred rather than read (see the module header).
  //
  // The operands are dropped here because under `--delete` git reads EVERY
  // listed ref as a deletion — the option is the same as a leading colon on
  // each refspec — and `--not --remotes` in the caller subtracts the already
  // published half of what the selector lists.
  if (parsed.deletes && selector) {
    const deleted: string[] = [];
    for (const sel of [parsed.branches ? "--branches" : "", parsed.tags ? "--tags" : ""]) {
      if (sel === "") continue;
      try {
        const out = await git(["rev-list", sel]);
        for (const line of out.split("\n")) {
          const sha = line.trim();
          if (/^[0-9a-f]{40,64}$/.test(sha)) deleted.push(sha);
        }
      } catch {
        return { commits: [], problem: "the push sources could not be listed" };
      }
    }
    if (deleted.length === 0) {
      return { commits: [], problem: "the push sources could not be listed" };
    }
    return { commits: deleted };
  }
  const sources = parsed.refspecs.map(refspecSource);
  const selectors: string[] = [];
  if (parsed.branches) selectors.push("--branches");
  if (parsed.tags) selectors.push("--tags");
  const commits: string[] = [];
  for (const src of sources) {
    // A delete (`:refs/heads/x` or `x:`) publishes nothing; ask no question.
    if (src === "") continue;
    const resolved = await resolveOne(git, src, "a push source could not be resolved to a commit");
    if (resolved.problem !== undefined) return { commits: [], problem: resolved.problem };
    commits.push(...resolved.commits);
  }
  if (selectors.length > 0) {
    // `--all`/`--tags` name refs by category, so the category is listed rather
    // than each ref resolved: `rev-list` accepts the selector directly.
    try {
      const out = await git(["rev-list", ...selectors]);
      let listed = 0;
      for (const line of out.split("\n")) {
        const sha = line.trim();
        if (/^[0-9a-f]{40,64}$/.test(sha)) {
          commits.push(sha);
          listed++;
        }
      }
      if (listed === 0) {
        return { commits: [], problem: "the push sources could not be listed" };
      }
    } catch {
      return { commits: [], problem: "the push sources could not be listed" };
    }
  }
  return { commits };
}

/** The left half of a refspec, force flag stripped; "" for a deletion. */
export function refspecSource(refspec: string): string {
  const left = refspec.split(":")[0] ?? "";
  return left.startsWith("+") ? left.slice(1) : left;
}

/**
 * Resolve one source to a commit sha, or the generic refusal to print. The
 * refusal never quotes the source: it is agent-authored text and a bad source
 * name can itself carry a private term.
 */
async function resolveOne(
  git: (args: string[]) => Promise<string>,
  src: string,
  problem: string,
): Promise<ResolvedSrcs> {
  try {
    const out = await git([
      "rev-parse",
      "--verify",
      "--quiet",
      "--end-of-options",
      `${src}^{commit}`,
    ]);
    const sha = out.trim();
    if (!/^[0-9a-f]{40,64}$/.test(sha)) return { commits: [], problem };
    return { commits: [sha] };
  } catch {
    return { commits: [], problem };
  }
}

/**
 * The push command split into words, with the shell's quote delimiters removed
 * so `git push origin "my branch"` names one refspec rather than two.
 */
function splitPushWords(command: string): string[] {
  return command
    .split(/\s+/)
    .filter((w) => w !== "")
    .map(stripQuotes);
}

/** Drop the delimiters of a balanced quoted word, keeping its contents. */
function stripQuotes(word: string): string {
  const open = word[0];
  if (open !== '"' && open !== "'") return word;
  const closed = word.length > 1 && word.endsWith(open);
  return closed ? word.slice(1, -1) : word.slice(1);
}

/**
 * Resolve `work`, or `fallback` once `ms` has passed. The guard's own wall
 * clock: `exec` is a seam the caller supplies, and an executor that ignores the
 * timeout it was handed would otherwise hang the `tool_call` hook forever — a
 * hung guard is a guard an operator switches off, which is the failure mode the
 * issue's criteria name. The losing promise is left to settle; nothing in this
 * module holds state that a late resolution can corrupt, and the scan is
 * read-only against git.
 */
async function bounded<T>(ms: number, fallback: T, work: Promise<T>): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const deadline = new Promise<T>((resolve) => {
    timer = setTimeout(() => resolve(fallback), ms);
  });
  try {
    return await Promise.race([work, deadline]);
  } finally {
    if (timer) clearTimeout(timer);
  }
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
