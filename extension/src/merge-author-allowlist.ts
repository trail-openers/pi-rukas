/**
 * merge-author-allowlist — WHO may have a pull request landed, answered once for
 * all three merge paths: the `/work` driver's `merged` step, lean's `land` step,
 * and the mode-independent merge guard on a hand-run `gh pr merge`.
 *
 * The operator's rule is that only PRs authored by a small fixed set of maintainer
 * accounts are ever landed, by any agent or driver. A PR from anybody else is not
 * landed whatever its reviews and CI say: it stays open and the refusal or the
 * handoff says so. Until now that rule was prose, and prose is convention — this is
 * the check.
 *
 * The allowlist is a gate file, `.pi/merge-authors`, read with `git show
 * <baseSha>:.pi/merge-authors` — at the **cycle's base commit**, never from the
 * working tree (#406's rule: a cycle cannot rewrite the rules it is judged by
 * mid-cycle). `.pi/` is a protected directory, so only the operator can change it.
 *
 * ## The gate is opt-in per repository
 *
 * The allowlist is a **grant the repository makes**, and a repository that never
 * committed the file never made one. `/work` and lean run in repositories other
 * than this one — including seeded trial repos that carry only the lean config —
 * and an allowlist that opted out by default would refuse every landing there for
 * a rule its operator never chose. So **absence is not a refusal**: no file at the
 * base commit means no author rule, and every other gate keeps its meaning.
 *
 * **Presence is fail-closed.** Once the file exists, everything about it that
 * cannot be established refuses: a tree, a symlink, a read git refused, or a file
 * that holds nothing but comments. "It is there but nobody could read it" is not
 * "the project named no anyone" — it is the operator's gate file failing, and the
 * one act it governs is irreversible. Likewise an author the forge never reported
 * refuses *when the file is present*: with no file there is no list to check a
 * login against, so the gate has no subject and says nothing at all.
 *
 * That split — absence answers, presence fails closed — is why this module has its
 * own reader rather than a reuse of `lean/config.ts`'s `gitShow`, which collapses
 * absent, a tree and a symlink into one "no config" answer. For a config that is
 * right; for a gate file the two shapes must stay apart.
 *
 * ## The author arrives as a read, never as a placeholder string
 *
 * `MergeTarget.author` defaults a missing author to the literal `"unknown"`, and
 * a check that read that field would report *"author `unknown` is not
 * allowlisted"* — the unreadable-author case wearing the non-allowlisted case's
 * clothes, which sends the operator to a different file than the truth does. So
 * `AuthorRead` is a discriminated pair and its refusal texts differ: "the author
 * could not be read" is not "this author is not on the list". A caller holding a
 * `MergeTarget` passes the login only when the forge actually answered one;
 * `mergeGuardAuthorRead` does that narrowing in one place so the placeholder
 * never reaches a comparison.
 *
 * ## No override reaches this gate
 *
 * `PI_ENSEMBLE_ALLOW_UNREVIEWED_MERGE`, `PI_ENSEMBLE_MERGE_AUTHORITY=0` and
 * `/work --merge` are statements about the reviews and the permission to merge.
 * None is a statement about WHO opened the PR, so none is consulted here. Like the
 * protected-path gate, this sits outside the merge-authority switch.
 *
 * Neither refusal prints the allowlisted logins: they are the operator's private
 * list, and the refusal is rendered into agent transcripts.
 */

import { errText } from "./protected-paths-text.ts";

/** The gate file that names the maintainers whose PRs may be landed. */
export const MERGE_AUTHORS_FILE = ".pi/merge-authors";

/** Bound on the file's bytes; a committed allowlist is a dozen lines, not a megabyte. */
const ALLOWLIST_MAX_BUFFER = 64 * 1024;

/** Bound on the git bound: a wedged git answers with a refusal, not with a merge. */
const ALLOWLIST_TIMEOUT_MS = 15_000;

/** A base SHA safe to place inside a `git show <sha>:<path>` spec. */
const SHA_RE = /^[0-9a-f]{7,40}$/;

/** The one git executor this module needs; every caller's seam is assignment-compatible. */
type AllowlistExec = (
  cmd: string,
  opts?: {
    cwd?: string;
    timeout?: number;
    maxBuffer?: number;
    argv?: string[];
  },
) => Promise<{ stdout: string; stderr?: string }>;

/**
 * Why the allowlist did not answer.
 *
 * `absent` is NOT one of these in spirit — the repository simply has no rule — but
 * it travels the same `{ ok: false }` shape so a caller cannot mistake it for a
 * read that succeeded, and `mergeAuthorGate` is the single place that decides what
 * each reason means. Every other member is a present gate file that failed.
 */
export type AllowlistUnreadable =
  /** The path is not in the base commit: the repository never opted in (A7). */
  | "absent"
  /** No base commit was recorded, so no commit exists to read the file at. */
  | "no-base"
  /** The base SHA is missing or not hex, so it cannot be named to git. */
  | "bad-base-sha"
  /** The executor could not answer at all — no git, a timeout, a non-zero exit. */
  | "git-failed"
  /** The blob was larger than the read bound, so its contents were never seen. */
  | "too-large"
  /** git answered something that is not a blob's bytes. */
  | "not-a-blob"
  /** The blob exists and names no login — a refusal, never an empty list. */
  | "empty";

/** The allowlist as read at a commit: the logins, or the reason none could be named. */
export type AllowlistRead =
  | {
      ok: true;
      logins: string[] /** Case-folded set the comparison runs against. */;
      set: ReadonlySet<string>;
    }
  | { ok: false; reason: AllowlistUnreadable; detail?: string };

/** The PR's author, as the forge answered it — an absence is a read failure, never a name. */
export type AuthorRead = { ok: true; login: string } | { ok: false; detail: string };

/** What a merge path needs to decide: allow, or refuse with the text it showed. */
export type AuthorGate = { ok: true } | { ok: false; reason: string };

/**
 * Parse the allowlist's bytes.
 *
 * One login per line; `#` comments and blank lines are ignored; comparison is
 * case-insensitive, which is why the parsed set is case-folded at parse time —
 * the single place case is decided, so no caller can compare case-sensitively by
 * accident. A file that yields no login is NOT an empty allowlist that happens to
 * match nothing: it is a read that named nobody, and it refuses.
 */
export function parseMergeAuthorAllowlist(raw: string): string[] {
  const out: string[] = [];
  for (const line of raw.split("\n")) {
    const trimmed = line.trim();
    if (trimmed.length === 0 || trimmed.startsWith("#")) continue;
    // Trailing whitespace is stripped above; an inline `# comment` after a login
    // is not a thing the format offers, so a token is taken verbatim.
    out.push(trimmed);
  }
  return out;
}

/** Buffer overflow in either executor's error shape (`execp` and `execFile` differ). */
function isBufferOverflow(err: unknown): boolean {
  const e = err as {
    code?: number | null;
    killed?: boolean;
    message?: string;
    stderr?: string;
  };
  if (typeof e?.message === "string" && /maxBuffer/i.test(e.message)) return true;
  return e?.killed === true && e.code === null && /maxBuffer/i.test(e.stderr ?? "");
}

/** The read-only git config this probe must not honour from a child-writable tree. */
const GIT_HARDENING = ["-c", "core.fsmonitor=false", "-c", "core.hooksPath=/dev/null"] as const;

/**
 * Read the allowlist at a commit through `git show`, failing CLOSED.
 *
 * `undefined`-on-absent is not available here: absence, a tree, a symlink and a
 * git failure all refuse, each naming itself, because the caller's decision is
 * irreversible. The `cat-file -t` leg is what separates "that path is not in that
 * commit" from "that path is a directory" and "that path is a symlink" — git would
 * print a tree's contents or follow the link otherwise.
 */
export async function readMergeAuthorAllowlist(
  exec: AllowlistExec,
  cwd: string,
  baseSha: string | undefined,
  file: string = MERGE_AUTHORS_FILE,
): Promise<AllowlistRead> {
  if (baseSha === undefined || baseSha.length === 0) {
    return { ok: false, reason: "no-base" };
  }
  if (!SHA_RE.test(baseSha)) {
    return { ok: false, reason: "bad-base-sha", detail: baseSha.slice(0, 40) };
  }
  const spec = `${baseSha}:${file}`;
  let type = "";
  /** Git's own words for the probe's failure, kept for the absent/git-failed split. */
  let probeError = "";
  try {
    const { stdout } = await exec("git", {
      argv: [...GIT_HARDENING, "cat-file", "-t", "--end-of-options", spec],
      cwd,
      timeout: ALLOWLIST_TIMEOUT_MS,
      maxBuffer: 8 * 1024,
    });
    type = stdout.trim();
  } catch (err) {
    // A missing path and a broken repository both arrive here, and they must not
    // collapse: one is "this repository has no author rule" (A7), the other is
    // "the gate file could not be read". Git tells them apart in its own wording,
    // so the wording is kept and classified below rather than guessed at by a
    // second read that would answer a broken repository the same way.
    type = "";
    // `errText` reads `message`, which is where `execp` puts the command line but
    // NOT where git's diagnosis lands: a non-zero exit carries the words on
    // `stderr`. Reading only the message made a genuine "that path is not in that
    // commit" indistinguishable from a wedged repository, which is exactly the
    // distinction A7 turns on — so both places are consulted.
    probeError = `${errText(err)} ${errTextStderr(err)}`;
    if (ABSENT_PROBE.test(probeError)) {
      return {
        ok: false,
        reason: "absent",
        detail: `${file} does not exist at the base commit`,
      };
    }
  }
  if (type === "tree")
    return {
      ok: false,
      reason: "not-a-blob",
      detail: `${file} is a directory at the base commit`,
    };
  if (type === "symlink" || type === "link") {
    return {
      ok: false,
      reason: "not-a-blob",
      detail: `${file} is a symlink at the base commit`,
    };
  }
  if (type !== "blob") {
    return {
      ok: false,
      reason: "not-a-blob",
      detail: `${file} is not a file at the base commit${type.length > 0 ? ` (git reported it as “${type}”)` : ""}`,
    };
  }
  let stdout = "";
  try {
    ({ stdout } = await exec("git", {
      argv: [...GIT_HARDENING, "show", "--end-of-options", spec],
      cwd,
      timeout: ALLOWLIST_TIMEOUT_MS,
      maxBuffer: ALLOWLIST_MAX_BUFFER,
    }));
  } catch (err) {
    if (isBufferOverflow(err)) {
      return {
        ok: false,
        reason: "too-large",
        detail: `${file} is over the ${ALLOWLIST_MAX_BUFFER} byte read bound`,
      };
    }
    return { ok: false, reason: "git-failed", detail: errText(err) };
  }
  const logins = parseMergeAuthorAllowlist(stdout);
  if (logins.length === 0) {
    return {
      ok: false,
      reason: "empty",
      detail: `${file} exists at the base commit but names no login`,
    };
  }
  return { ok: true, logins, set: new Set(logins.map((l) => l.toLowerCase())) };
}

/**
 * git's `stderr` off a rejection, when the executor attached one.
 *
 * `execp` and `execFile` disagree about where the failing child's words go, and the
 * reader must not inherit that disagreement: the absence test needs git's own
 * sentence whichever shape the caller's executor has.
 */
function errTextStderr(err: unknown): string {
  const stderr = (err as { stderr?: unknown })?.stderr;
  return typeof stderr === "string" ? stderr : "";
}

/**
 * Git's own wording for "that path is not in that commit", from `cat-file -t`.
 *
 * Matched on the phrase set rather than on an exit code, because the exit code for
 * a missing path (128) is the code for a broken repository, a dubious ownership and
 * a missing pack file alike — those are `git-failed`, and treating them as absence
 * would turn a wedged repository into an open gate. `does not exist in` is the
 * phrase git prints for the path; `not a valid object name` is what a partial
 * clone adds beside it; both say the SAME thing about the path.
 */
const ABSENT_PROBE = /does not exist in|path .* does not exist|not a valid object name/i;

/** The refusal shared by every path, minus the path's own framing. */
function notAllowlisted(login: string, file: string): string {
  return `the PR author \`${login}\` is not listed in ${file} (the allowlist of maintainers whose pull requests an agent may land), so the merge is refused; the PR stays open for a person to land`;
}

/** The refusal for a read that never answered — a different operator action than the one above. */
function authorUnreadable(detail: string, file: string): string {
  return `the PR's author could not be read from the forge (${detail}), so it cannot be checked against ${file}; the merge is refused rather than merged unverified`;
}

/** The refusal for an allowlist that could not be established. */
function allowlistRefusal(read: Extract<AllowlistRead, { ok: false }>, file: string): string {
  if (read.reason === "empty") {
    const why = read.detail ?? `${file} names no login at the base commit`;
    return `${why} — an allowlist that names nobody lands nothing, so the merge is refused`;
  }
  const why =
    read.reason === "no-base"
      ? "no base commit is recorded for this cycle, so the allowlist could not be read at the commit the cycle started from"
      : read.reason === "bad-base-sha"
        ? `the recorded base commit ${JSON.stringify(read.detail ?? "")} is not a commit sha, so the allowlist could not be read at it`
        : read.reason === "too-large"
          ? (read.detail ?? `${file} is larger than the read bound`)
          : read.reason === "git-failed"
            ? `the git read of ${file} failed (${read.detail ?? "no cause reported"})`
            : (read.detail ?? `${file} could not be read as a file at the base commit`);
  return `${why} — an allowlist that could not be read allows nobody, so every merge is refused`;
}

/**
 * The one question all three merge paths ask.
 *
 * Both inputs are reads, not values: the allowlist may have been unreadable and
 * the author may have been unanswerable, and each has its own refusal text. The
 * allowlist is refused FIRST — an operator who cannot read their own gate file is
 * told that, rather than being told an author is not on a list that nobody read.
 */
export function mergeAuthorGate(args: {
  allowlist: AllowlistRead;
  author: AuthorRead;
  file?: string;
}): AuthorGate {
  const file = args.file ?? MERGE_AUTHORS_FILE;
  // A repository that never committed the gate file never granted this rule, so
  // there is nothing to check and nothing to say — not even about an author the
  // forge could not read, whose only relevance here would be a list that does not
  // exist. This is the ONE opt-out; every other unreadable input refuses.
  if (!args.allowlist.ok && args.allowlist.reason === "absent") return { ok: true };
  // The author is classified FIRST. Both refusals block the merge, but they send the
  // operator to different places — the allowlist file, or their `gh` setup — and when
  // both are missing the author is the one fact the gate was asked about. Reporting
  // "no base commit is recorded" for a cycle that also never read an author names the
  // allowlist as the thing to fix when no allowlist could have answered anyway.
  if (!args.author.ok) return { ok: false, reason: authorUnreadable(args.author.detail, file) };
  if (!args.allowlist.ok) return { ok: false, reason: allowlistRefusal(args.allowlist, file) };
  const login = args.author.login.trim();
  if (login.length === 0) {
    return {
      ok: false,
      reason: authorUnreadable("the forge answered with an empty author", file),
    };
  }
  if (args.allowlist.set.has(login.toLowerCase())) return { ok: true };
  return { ok: false, reason: notAllowlisted(login, file) };
}

/**
 * Narrow a forge's author field to a read, refusing the placeholder.
 *
 * `MergeTarget.author` carries `"unknown"` for a PR whose author the CLI did not
 * report (merge-target.ts), and the GitLab mapping folds a missing username to
 * `undefined`. Feeding either straight to the gate would label the unreadable case
 * as a person named `unknown`; this is where the two shapes become one read.
 */
export function mergeGuardAuthorRead(author: string | undefined): AuthorRead {
  const login = (author ?? "").trim();
  if (login.length === 0) return { ok: false, detail: "the forge reported no author" };
  // The placeholder is merge-target's own constant, not a real login: GitHub
  // logins may not contain it, so it can only ever be the stand-in.
  if (login.toLowerCase() === "unknown") {
    return {
      ok: false,
      detail:
        "the forge's author field was absent, and the target reader substituted a placeholder",
    };
  }
  // The same reasoning catches `merge-target`'s other stand-ins: a git author name
  // or email is what the reader writes when the forge answered neither, and neither
  // is a GitHub login — `@` is illegal in one. Labeling them "not allowlisted" sent
  // the operator to the allowlist for a PR whose author was never read.
  if (login.toLowerCase() === "local" || login.includes("@")) {
    return {
      ok: false,
      detail: "the forge's author field carried a local git identity, not a forge login",
    };
  }
  return { ok: true, login };
}
