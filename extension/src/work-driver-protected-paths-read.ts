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
 * without its pair, or a malformed status record all come back `{ ok: false }`
 * naming the offending token, so the caller can halt rather than pass on a change
 * set it never actually saw.
 *
 * **Why these are three parsers and not one** (`porcelainPaths` in
 * work-driver-verify.ts and `worktreeStatus` in work-develop-git.ts are the other
 * two): each is pinned to one git command's documented field layout and each
 * rejects the shapes that command must not produce. One parser over three layouts
 * would need a mode per command and would accept another command's tokens, which
 * is how a rename silently becomes an empty change set — the bug this module
 * exists for. The three are deliberately not merged.
 *
 * The executor is the driver's `verifyExecFn` seam, but a plain string `cmd` is
 * NOT accepted here. Every git call in the worktree paths goes through the argv
 * form (`runGit` in work-develop-git.ts, the coupling grep in
 * work-driver-verify.ts) because a path or ref is data, never something a shell
 * re-parses; and the smoke-test fakes match on the command string, so a string
 * form here would let one fake the read it was written to stub while the real
 * read went unexercised. `test-exec-argv-contract.ts` enforces it.
 */

import { DEFAULT_GIT_TIMEOUT_MS } from "./git-range.ts";
import type { DriverContext } from "./work-driver-context.ts";

/** Byte ceiling on either read. An overflow must reject, not truncate silently. */
export const PROTECTED_READ_MAX_BUFFER = 64 * 1024 * 1024;

export type ProtectedPathExec = NonNullable<DriverContext["verifyExecFn"]>;

/**
 * The `-c` pairs both reads carry, ahead of the subcommand.
 *
 * `core.quotePath=off` — `-z` stops git C-quoting the names it prints, but the
 * *range* argument is still echoed C-quoted inside git's own fatal message
 * (`fatal: bad revision '"w\303\266orkflows.yml"..HEAD'`), and that message is the
 * reason an operator sees when a read fails closed.
 *
 * `core.fsmonitor=false` and `core.hooksPath=/dev/null` — the worktree these reads
 * run in is **child-writable**: a developer, a lens-fix, or a malicious dependency
 * can write `git config core.fsmonitor <script>` into it, and an unguarded read
 * would execute that script as the *driver*. Same guard `runGit` applies in
 * src/git-state.ts:38, for the same reason. A read is only as safe as the config it
 * honours, so the two reads share one list rather than restating it.
 */
const SAFE_CONFIG = [
  "-c",
  "core.quotePath=off",
  "-c",
  "core.fsmonitor=false",
  "-c",
  "core.hooksPath=/dev/null",
] as const;

/** argv for the committed read: NUL-separated name-status with rename detection,
 *  and `--end-of-options` so a base that reads like a flag stays a ref. */
export const PROTECTED_DIFF_ARGV = [
  ...SAFE_CONFIG,
  "diff",
  "-z",
  "--name-status",
  "-M",
  "--end-of-options",
] as const;

/** argv for the uncommitted read. `-uall` lists an untracked directory file by file. */
export const PROTECTED_STATUS_ARGV = [
  ...SAFE_CONFIG,
  "status",
  "--porcelain",
  "-z",
  "--untracked-files=all",
] as const;

/** A read that could not be trusted. The reason names the worktree's offending token. */
export interface Unreadable {
  ok: false;
  unreadable: string;
}

/**
 * The uncommitted change set: every path plus the rename sides, together.
 * Discriminated on `ok` — a caller that forgets to narrow gets a compile error
 * rather than `undefined` out of `paths`.
 */
export type StatusRead = { ok: true; paths: string[] } | Unreadable;

/**
 * The committed change set: the parsed `diff -z --name-status` records. The
 * rename *sources* are deliberately not a separate field — the only reader that
 * may consult them is the protected-path gate, and `renameSourcePaths(targets)`
 * derives them. A second list invited the other gates (the #285 fanout, the
 * frontend-only skip, the falsily-green check) to consume a path they must never
 * see: `git mv .github/workflows/ci.yml src/ci.yml` would otherwise read as a
 * changed file it is not.
 */
export type DiffRead = { ok: true; targets: NameStatus[] } | Unreadable;

/**
 * One record from `diff -z --name-status`: the change kind git printed and the
 * path(s) it applies to. A rename's score is kept (`R100` vs `R85` is git's
 * confidence and the only clue a mispaired rename leaves) and its source kept
 * separate — it decides nothing outside the protected-path gate.
 *
 * `other` is git's own code for the kinds that are none of M/A/D/R (T type
 * change, X unique, U unmerged). It is the code verbatim rather than a guess,
 * and `path` is still its path — so the protected gate sees the path whatever
 * the kind, and a future kind-specific rule has the real letter to match on.
 */
export type NameStatus =
  | { kind: "M" | "A" | "D"; path: string }
  | { kind: "R"; score: string; from: string; to: string }
  | { kind: "other"; code: string; path: string };

/** The change kinds a non-rename record can be spelled as. */
type NamedKind = "M" | "A" | "D";

/** The paths a read's records changed, in the order git printed them. */
export function changedPaths(records: readonly NameStatus[]): string[] {
  return records.map((r) => (r.kind === "R" ? r.to : r.path));
}

/** The paths a read's rename/copy records moved away from. */
export function renameSourcePaths(records: readonly NameStatus[]): string[] {
  return records
    .filter((r): r is Extract<NameStatus, { kind: "R" }> => r.kind === "R")
    .map((r) => r.from);
}

/**
 * The first error message a rejection carries, bounded for the operator-facing note.
 * Narrowed rather than cast: a rejection is not guaranteed to be an `Error` (a
 * string or a plain object reaches here from a shimmed executor), and `(err as
 * Error)?.message` on those yields `undefined` and then the literal `"undefined"`
 * as the reason an operator reads.
 */
function errText(err: unknown): string {
  const text = err instanceof Error ? err.message : typeof err === "string" ? err : String(err);
  // A rejection that stringifies to nothing still needs a name in the reason —
  // an empty one reads as "git failed for no stated reason".
  return (text.trim().length > 0 ? text : errTextFallback(err)).slice(0, 200);
}

/** A rejection that stringifies to nothing still needs a name in the reason. */
function errTextFallback(err: unknown): string {
  return err === null ? "null" : err === undefined ? "undefined" : "unknown rejection";
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
      timeout: DEFAULT_GIT_TIMEOUT_MS,
    }));
  } catch (err) {
    return { ok: false, unreadable: `git status --porcelain -z failed: ${errText(err)}` };
  }
  const tokens = stdout.split("\0");
  const paths: string[] = [];
  for (let i = 0; i < tokens.length; i++) {
    const tok = tokens[i] ?? "";
    // The only legitimate empty token is the one after the final NUL.
    if (tok === "" && i === tokens.length - 1) continue;
    if (isMalformedStatusToken(tok)) {
      return {
        ok: false,
        unreadable: `malformed status entry ${JSON.stringify(tok.slice(0, 80))}`,
      };
    }
    const code = tok.slice(0, 2);
    const path = tok.slice(3);
    if (/[RC]/.test(code)) {
      i++;
      const origin = tokens[i];
      if (origin === undefined || origin === "") {
        return {
          ok: false,
          unreadable: `rename/copy status entry without its origin path: ${JSON.stringify(path.slice(0, 80))}`,
        };
      }
      paths.push(path, origin);
    } else if (path.length > 0) {
      paths.push(path);
    }
  }
  return { ok: true, paths };
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
 * Both reads carry the `SAFE_CONFIG` pairs above (`core.quotePath=off`,
 * `core.fsmonitor=false`, `core.hooksPath=/dev/null`) — see that block for why each
 * one is load-bearing, including the executable-config hole these reads run beside
 * in a child-writable worktree.
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
      timeout: DEFAULT_GIT_TIMEOUT_MS,
    }));
  } catch (err) {
    return { ok: false, unreadable: `git diff -z --name-status -M failed: ${errText(err)}` };
  }
  const tokens = stdout.split("\0");
  const records: NameStatus[] = [];
  for (let i = 0; i < tokens.length; i++) {
    const code = tokens[i] ?? "";
    // The only legitimate empty token is the one after the final NUL.
    if (code === "" && i === tokens.length - 1) continue;
    const kind = code[0] ?? "";
    if (kind === "") {
      return {
        ok: false,
        unreadable: `missing status field in name-status record ${JSON.stringify(code.slice(0, 80))}`,
      };
    }
    if (kind === "R" || kind === "C") {
      const from = tokens[i + 1];
      const to = tokens[i + 2];
      if (from === undefined || to === undefined || from === "" || to === "") {
        return {
          ok: false,
          unreadable: `rename/copy record ${code} without both its source and destination paths`,
        };
      }
      i += 2;
      // A copy (`C`) is recorded as a rename — both have a source the protected
      // gate must see, and the score is git's similarity for either.
      records.push({ kind: "R", score: code.slice(1), from, to });
      continue;
    }
    const path = tokens[i + 1];
    if (path === undefined || path === "") {
      return { ok: false, unreadable: `status record ${code} without its path` };
    }
    i++; // the path is consumed as this record's second token
    // A non-rename record is exactly one code and one path: `diff --name-status`
    // prints no stage columns, so an unmerged (U) entry needs no special case.
    // git also emits T (type change), X (unique) and U (unmerged); none of those
    // is a modification, an add or a delete, so the letter is kept verbatim in
    // `code` rather than rounded to one of the named kinds.
    const named: NamedKind | null =
      kind === "A" ? "A" : kind === "D" ? "D" : kind === "M" ? "M" : null;
    records.push(named ? { kind: named, path } : { kind: "other", code, path });
  }
  return { ok: true, targets: records };
}
