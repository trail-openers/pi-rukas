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
 * It **fails closed toward the irreversible act**. Absent, a tree, a symlink, a
 * read git refused, or a file that holds nothing but comments all refuse every
 * merge. That inverts `lean/config.ts`'s `gitShow`, whose absent-to-default
 * contract is right for a config and wrong for an allowlist: "the project never
 * named anyone" and "nobody could read the file" both mean *no author is
 * allowlisted*, and neither is a licence to merge. Hence this module's own reader
 * rather than a reuse of that one.
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
  opts?: { cwd?: string; timeout?: number; maxBuffer?: number; argv?: string[] },
) => Promise<{ stdout: string; stderr?: string }>;

/** Why the allowlist could not be read — operator-facing, and never the content. */
export type AllowlistUnreadable =
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
  | { ok: true; logins: string[]; /** Case-folded set the comparison runs against. */ set: ReadonlySet<string> }
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
  const e = err as { code?: number | null; killed?: boolean; message?: string; stderr?: string };
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
  try {
    const { stdout } = await exec("git", {
      argv: [...GIT_HARDENING, "cat-file", "-t", spec],
      cwd,
      timeout: ALLOWLIST_TIMEOUT_MS,
      maxBuffer: 8 * 1024,
    });
    type = stdout.trim();
  } catch (err) {
    // A missing path and a broken repository both arrive here; the second `git
    // show` below separates them, because it answers a real failure with its own
    // stderr while a missing path answers with the standard "does not exist".
    type = "";
    // The cause is carried forward by the `git show` below, which is the read
    // that can tell a missing path from a broken repository.
    void err;
  }
  if (type === "tree") return { ok: false, reason: "not-a-blob", detail: `${file} is a directory at the base commit` };
  if (type === "symlink" || type === "link") {
    return { ok: false, reason: "not-a-blob", detail: `${file} is a symlink at the base commit` };
  }
  if (type !== "blob") return { ok: false, reason: "not-a-blob", detail: `git reported no blob at ${file}` };
  let stdout = "";
  try {
    ({ stdout } = await exec("git", {
      argv: [...GIT_HARDENING, "show", spec],
      cwd,
      timeout: ALLOWLIST_TIMEOUT_MS,
      maxBuffer: ALLOWLIST_MAX_BUFFER,
    }));
  } catch (err) {
    if (isBufferOverflow(err)) {
      return { ok: false, reason: "too-large", detail: `${file} is over the ${ALLOWLIST_MAX_BUFFER} byte read bound` };
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
          ? read.detail ?? `${file} is larger than the read bound`
          : read.reason === "git-failed"
            ? `the git read of ${file} failed (${read.detail ?? "no cause reported"})`
            : read.detail ?? `${file} could not be read as a file at the base commit`;
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
  if (!args.allowlist.ok) return { ok: false, reason: allowlistRefusal(args.allowlist, file) };
  if (!args.author.ok) return { ok: false, reason: authorUnreadable(args.author.detail, file) };
  const login = args.author.login.trim();
  if (login.length === 0) {
    return { ok: false, reason: authorUnreadable("the forge answered with an empty author", file) };
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
    return { ok: false, detail: "the forge's author field was absent, and the target reader substituted a placeholder" };
  }
  return { ok: true, login };
}
