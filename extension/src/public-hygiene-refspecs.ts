/**
 * public-hygiene-refspecs — the refspec half of the push scan (#1788): what a
 * `git push` command says it publishes, and the commits it therefore names.
 *
 * Split from `public-hygiene-push.ts` along the seam AGENTS.md §12 asks for:
 * that module answers "what text does this push put in front of the world" and
 * owns the git reads; this one answers "what did the command NAME" and owns the
 * command's grammar. The two rules change for different reasons — a git push
 * option someone adds, versus a denylist tier — and a file that holds both grows
 * whenever either does.
 *
 * ## The reader is the range
 *
 * `git push` publishes what its refspecs name, and the agent writes those — not
 * what this clone has checked out. `pushRefspecs` reads the arguments after the
 * remote (skipping options), `resolveSrcs` turns each source into a commit, and
 * `refspecSource` strips the force flag and the destination half. A source that
 * does not resolve REFUSES: "I could not work out what you are pushing" is not
 * "what you are pushing is clean".
 *
 * ## Deletions
 *
 * Git's own semantics, cited because the scan has to agree with them rather than
 * guess: under `-d`/`--delete` EVERY listed ref is deleted — the option is the
 * same as prefixing each refspec with a colon — so its operands are names to
 * remove, never revisions to resolve. And git REFUSES to combine `--delete` with
 * `--all`/`--branches`/`--mirror`/`--tags` ("cannot use --all with --delete"),
 * so the two can never mean one push.
 *
 * The scan takes the conservative reading of both facts: `--delete <refs...>`
 * publishes nothing and is skipped, but `--delete` appearing TOGETHER with a
 * selector does not short-circuit — the selector is still read. A command git
 * would refuse publishes nothing either way, so the extra read costs a git call
 * and can only ever refuse something that was never going to publish;
 * short-circuiting on `--delete` first would hide a dirty branch behind a flag
 * combination that merely has not been typed yet — the same failure shape as
 * inferring the range from HEAD instead of from the command.
 */

import type { PushScanDeps } from "./public-hygiene-push.ts";

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

/** The deletion switches: see this module's header for git's semantics. */
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
export interface ResolvedSrcs {
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
export async function resolveSrcs(
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
    // No refspec and no selector: the shapes that take their range from HEAD. A
    // `--delete` with an operand is NOT one of them — `origin --delete gone`
    // carries `gone`, and treating it as "nothing named" would resolve HEAD and
    // scan commits this push does not publish, which is a range nobody is
    // sending read as if it were. Bare push and `push <remote>` are the cases
    // that publish HEAD because the command names no range at all.
    return resolveOne(git, "HEAD", "the commits to be pushed could not be resolved");
  }
  // With `--delete` AND a selector this is a command git itself refuses (it will
  // not delete every branch), so the push cannot happen — but the scan still
  // reads what the selector names. Defence in depth, not a second opinion on the
  // verdict: a delete publishes no commit either way, so scanning can only ever
  // refuse what was never going out, while short-circuiting on `--delete` would
  // put a flag before the truth about the commits.
  //
  // The operands are dropped here because under `--delete` git reads EVERY
  // listed ref as a deletion, and `--not --remotes` in the caller subtracts the
  // already published half of what the selector lists.
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
export function splitPushWords(command: string): string[] {
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
