/**
 * work-driver-protected-paths-read — NUL-separated reads for the #406 develop
 * protected-path gate (#1378).
 *
 * The gate read the change set with `git status --porcelain --untracked-files=all`
 * and `git diff --name-only <base>..HEAD`. Neither is `-z`, and between them
 * they hid two classes of protected-path write:
 *
 *   1. **A committed rename away from a protected path.** `--name-only` collapses a
 *      rename to its destination: `git mv .github/workflows/ci.yml src/ci.yml`
 *      printed `src/ci.yml` and nothing else. The workflow the cycle removed was
 *      absent from the change set the gate inspected, so the cycle passed.
 *   2. **A protected path whose name git C-quotes.** With `core.quotePath` at its
 *      default a non-ASCII name prints as `".github/workflows/w\303\266rkflows.yml"`.
 *      `porcelainPaths` strips the outer quotes and leaves the octal bytes literal,
 *      so `isProtectedPath` still saw a `.github` path — but the operator-facing
 *      prose, the grant comparison, and `SAFE_PATH_RE` all saw escape sequences.
 *
 * Both reads are NUL-separated here, where git emits names verbatim and rename
 * sides arrive as their own tokens. The layouts are deliberately NOT parsed by one
 * loop: `status --porcelain -z` puts the NEW name first (`R  new\0orig\0`) while
 * `diff -z --name-status -M` puts the status code first (`R100\0from\0to`). The
 * `worktreeStatus` precedent in work-develop-git.ts is the uncommitted-side shape;
 * `workstreamTouchedSet` in work-driver-verify.ts is the committed-side one, but
 * without `-z`, so there was nothing to import.
 *
 * Rename SOURCES feed the protected check only. `verifyDevelopOutcome` keeps a
 * separate `touchedPaths` union for the frontend-only verify skip, the
 * falsily-green check and the #285 scope/fanout gate, and a rename source belongs
 * to none of those verdicts: letting `git mv .github/workflows/ci.yml src/ci.yml`
 * into that union could classify a source-touching cycle as CSS-only and skip the
 * derived verify chain. Hence the split return type below.
 *
 * Both readers are fail-closed and say why: git itself failing, a rename token
 * without its pair, or a malformed status record all come back `{ unreadable }`
 * naming the offending token, so the caller can halt rather than pass on a change
 * set it never actually saw.
 *
 * The executor is the driver's `verifyExecFn` seam, but a plain string `cmd` is
 * NOT accepted here. Every git call in the worktree paths goes through the argv
 * form (`runGit` in work-develop-git.ts, the coupling grep in
 * work-driver-verify.ts) because a path or ref is data, never something a shell
 * re-parses; and the smoke-test fakes match on the command string, so a string
 * form here would let one fake the read it was written to stub while the real
 * read went unexercised. `test-exec-argv-contract.ts` enforces it.
 */

import type { DriverContext } from "./work-driver-context.ts";

/** Byte ceiling on either read. An overflow must reject, not truncate silently. */
export const PROTECTED_READ_MAX_BUFFER = 64 * 1024 * 1024;

export type ProtectedPathExec = NonNullable<DriverContext["verifyExecFn"]>;

/** argv for the committed read: NUL-separated name-status with rename detection,
 *  and `--end-of-options` so a base that reads like a flag stays a ref. */
export const PROTECTED_DIFF_ARGV = [
  "-c",
  "core.quotePath=off",
  "diff",
  "-z",
  "--name-status",
  "-M",
  "--end-of-options",
] as const;

/** argv for the uncommitted read. `-uall` lists an untracked directory file by file. */
export const PROTECTED_STATUS_ARGV = [
  "-c",
  "core.quotePath=off",
  "status",
  "--porcelain",
  "-z",
  "--untracked-files=all",
] as const;

/** A read that could not be trusted. The reason names the worktree's offending token. */
export interface Unreadable {
  unreadable: string;
}

/** The uncommitted change set: every path plus the rename sides, together. */
export type StatusRead = { paths: string[] } | Unreadable;

/**
 * The committed change set, split by what each side is allowed to decide.
 * `targets` are the paths that changed (the union every other gate already saw);
 * `renameSources` are the paths a rename moved *away from*, which only the
 * protected-path check may consult.
 */
export type DiffRead = { targets: string[]; renameSources: string[] } | Unreadable;

/** The first error message a rejection carries, bounded for the operator-facing note. */
function errText(err: unknown): string {
  const m = (err as Error)?.message ?? String(err);
  return m.slice(0, 200);
}

/** Porcelain v1 is `XY PATH`: at least four chars with a space at index 2. */
function isMalformedStatusToken(tok: string): boolean {
  return tok.length < 4 || tok[2] !== " ";
}

/**
 * Read the uncommitted change set with `status --porcelain -z --untracked-files=all`.
 *
 * `-z` means a name is never C-quoted and never shell-mangled: the bytes git has
 * on disk arrive verbatim, so a non-ASCII protected path is the path the gate
 * compares and the path the operator reads. `-uall` lists an untracked directory
 * file by file — a `?? .github/` collapse would leave the gate with a directory,
 * which no grant can name (#1090).
 *
 * With `-z` a rename/copy is `XY new\0orig\0`: the origin is its own token, and it
 * is the *second* one. Both sides are returned. A malformed record — or a rename
 * whose origin token is missing — is unreadable, not skipped: the paths after it
 * in the stream would be misread as status records, which is a wrong answer rather
 * than a missing one.
 */
export async function readProtectedStatusPaths(
  exec: ProtectedPathExec,
  cwd: string,
): Promise<StatusRead> {
  let stdout: string;
  try {
    ({ stdout } = await exec("git", {
      argv: [...PROTECTED_STATUS_ARGV],
      cwd,
      maxBuffer: PROTECTED_READ_MAX_BUFFER,
    }));
  } catch (err) {
    return { unreadable: `git status --porcelain -z failed: ${errText(err)}` };
  }
  const tokens = stdout.split("\0");
  const paths: string[] = [];
  for (let i = 0; i < tokens.length; i++) {
    const tok = tokens[i] ?? "";
    // The only legitimate empty token is the one after the final NUL.
    if (tok === "" && i === tokens.length - 1) continue;
    if (isMalformedStatusToken(tok)) {
      return { unreadable: `malformed status entry ${JSON.stringify(tok.slice(0, 80))}` };
    }
    const code = tok.slice(0, 2);
    const path = tok.slice(3);
    if (/[RC]/.test(code)) {
      i++;
      const origin = tokens[i];
      if (origin === undefined || origin === "") {
        return {
          unreadable: `rename/copy status entry without its origin path: ${JSON.stringify(path.slice(0, 80))}`,
        };
      }
      paths.push(path, origin);
    } else if (path.length > 0) {
      paths.push(path);
    }
  }
  return { paths };
}

/**
 * Read the committed change set with `diff -z --name-status -M <base>..HEAD`.
 *
 * `-M` is what the bug needed: without rename detection the record for a moved
 * protected file is a bare `A src/ci.yml` and the protected side never appears.
 * With `-z` each field is its own NUL-terminated token and the order is
 * `R100\0from\0to` — status first, then the source, then the destination — which
 * is the opposite arrangement from the status read above.
 *
 * The range is passed as one argv element after `--end-of-options`, so a base that
 * looks like a flag cannot become one and an unreadable ref rejects rather than
 * printing an empty name-set (`git diff -- <bogus>` is exit 128, and an empty set
 * would look like "nothing protected changed").
 *
 * `D` and `A` are first-class paths: a delete-plus-add pair does NOT collapse to
 * `R100` unless git's similarity heuristic pairs it, so a deleted protected file
 * must halt on the `D` record alone.
 *
 * `core.quotePath=off` is set on both reads. `-z` stops git C-quoting the names it
 * prints, but the *range* argument is still echoed C-quoted inside git's own fatal
 * message (`fatal: bad revision '"w\303\266orkflows.yml"..HEAD'`), and that message
 * is the reason an operator sees when a read fails closed.
 */
export async function readCommittedProtectedPaths(
  exec: ProtectedPathExec,
  cwd: string,
  base: string,
): Promise<DiffRead> {
  let stdout: string;
  try {
    ({ stdout } = await exec("git", {
      argv: [...PROTECTED_DIFF_ARGV, `${base}..HEAD`],
      cwd,
      maxBuffer: PROTECTED_READ_MAX_BUFFER,
    }));
  } catch (err) {
    return { unreadable: `git diff -z --name-status -M failed: ${errText(err)}` };
  }
  const tokens = stdout.split("\0");
  const targets: string[] = [];
  const renameSources: string[] = [];
  for (let i = 0; i < tokens.length; i++) {
    const code = tokens[i] ?? "";
    // The only legitimate empty token is the one after the final NUL.
    if (code === "" && i === tokens.length - 1) continue;
    const kind = code[0] ?? "";
    if (kind === "") {
      return {
        unreadable: `missing status field in name-status record ${JSON.stringify(code.slice(0, 80))}`,
      };
    }
    if (kind === "R" || kind === "C") {
      const from = tokens[i + 1];
      const to = tokens[i + 2];
      if (from === undefined || to === undefined || from === "" || to === "") {
        return {
          unreadable: `rename/copy record ${code} without both its source and destination paths`,
        };
      }
      i += 2;
      targets.push(to);
      renameSources.push(from);
      continue;
    }
    const path = tokens[i + 1];
    if (path === undefined || path === "") {
      return { unreadable: `status record ${code} without its path` };
    }
    i++; // the path is consumed as this record's second token
    // A non-rename record is exactly one code and one path: `diff --name-status`
    // prints no stage columns, so an unmerged (U) entry needs no special case.
    targets.push(path);
  }
  return { targets, renameSources };
}
