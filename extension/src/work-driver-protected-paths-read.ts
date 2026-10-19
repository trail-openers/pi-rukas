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
 * `diff -z --name-status -M -C` puts the status code first (`R100\0from\0to`). The
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

/**
 * Byte ceiling on the uncommitted read. An overflow must reject, not truncate
 * silently, and `-uall` is the one that can genuinely reach it: it lists every
 * untracked file in the worktree, one token each, so a worktree the developer
 * filled with build output is a real (if unwelcome) shape.
 */
export const PROTECTED_READ_MAX_BUFFER = 64 * 1024 * 1024;

/**
 * Byte ceiling on the committed read. A separate, smaller ceiling than the
 * status read because the two read different things: this one is NUL-separated
 * name-status records for commits ahead of the base, bounded by what a developer
 * can plausibly commit in one cycle (a few hundred changed paths — megabytes, not
 * tens of megabytes). Carrying the 64 MiB figure here would let a pathological
 * commit hold 64 MiB of stdout in the driver to no purpose, and a ceiling nobody
 * expects to reach is not a ceiling.
 */
export const PROTECTED_DIFF_MAX_BUFFER = 8 * 1024 * 1024;

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
 *
 * **What is outside this guard's boundary — and it is a real boundary, not a
 * caveat.** The `fsmonitor`/`hooksPath` pairs and the named-`filter` entries
 * below are **defence-in-depth for common names only**. They are not the safety
 * boundary of these reads, and nothing here should be read as saying otherwise.
 * Two things this argv cannot close, each measured against git 2.50.1 rather
 * than assumed from the man page:
 *
 *   - **The shared config.** `core.hooksPath=/dev/null` redirects hooks; it does
 *     not read config. The config these runs honour is the **shared**
 *     `$GIT_COMMON_DIR/config`, one file for every worktree of the clone. A
 *     `filter.<x>.clean` entry there — or in `hooks/` — is reachable by every git
 *     invocation in the driver, this module's two and every other. This module
 *     hardens the argv of two reads; it does not fence a config it does not own.
 *
 *   - **A named filter driver cannot be blanket-blocked, and the name is the
 *     attacker's choice.** A `*.yml filter=x` binding from a committed
 *     `.gitattributes` **or** a `.git/info/attributes` (untracked, so the read can
 *     never remove it) plus a `filter.x.clean` config makes git execute that
 *     script as the driver while materialising content for `git diff` against a
 *     one-sided rev. `-c filter.x.clean=false` does stop it — but only for the
 *     name `x`. Any other name still runs: verified against a worktree-written
 *     filter called `childchose`, which executed under both guarded reads. There
 *     is no wildcard: `-c 'filter.*.clean=false'` sets one literal key, and with
 *     three paths bound to three different filter names, all three scripts still
 *     ran with it present. **The develop path currently has no owner for that
 *     case** — the same is true of the skip-ratchet's separate `-U0` content diff
 *     (`git diff <baseRef> -U0` in work-driver-verify-develop-gates.ts, plain-string
     argv with no `SAFE_CONFIG` at all), which runs
 *     the foreign-named filter too. Transport-level isolation of executable git
 *     config is a separate concern from #1378's NUL-separated reads and is
 *     **tracked separately**; do not treat any code in this repo as closing it.
 *     The "DOCUMENTED LIMIT" case in
 *     test-work-driver-protected-paths-filter.ts is the pin on all of this.
 *
 *   - **The two obvious flags do not work, and one of them breaks the reads if
 *     you try.** `core.attributesFile=/dev/null` does not stop the binding (git
 *     keeps the index/worktree attribute stack; `check-attr` still reports the
 *     filter and the script still runs), and neither does `GIT_ATTR_NOSYSTEM=1`,
 *     which only drops the system-level file. `--no-ext-diff` and `--no-textconv`
 *     are worse than useless here: they are `git diff` options, so at the global
 *     position git rejects them outright (`unknown option`, exit 129) — putting
 *     them in a shared list would have broken **both** reads, which is what an
 *     earlier revision of this file did and what the canary now refuses. After
 *     the subcommand git accepts them but they silence an *external diff command*
 *     and a *textconv* driver, neither of which a `--name-status` read reaches:
 *     the clean filter still ran with both present.
 *
 * What that leaves, and what the flags below therefore are: a defence-in-depth
 * set that closes every route these two reads can be made to take **by name**
 * (`fsmonitor`, `hooksPath`, and the `clean` filter forced to fail for the
 * conventional driver name), plus the honest statement that a child which can
 * write the worktree can arrange a named filter the argv cannot anticipate. The
 * read is fail-closed on its output, not trusted on its environment.
 *
 * **Exported because the boundary is not this module's reads.** The #1676
 * discard pass runs `git commit`/`checkout`/`rm` in the same child-writable
 * worktree and carries this exact list (`work-driver-discard-argv.ts`).
 */
export const SAFE_CONFIG = [
  "-c",
  "core.quotePath=off",
  "-c",
  "core.fsmonitor=false",
  "-c",
  "core.hooksPath=/dev/null",
  // Belt-and-braces for the attribute-bound clean filter. A worktree that binds
  // a protected path to the conventional `filter=<name>` and points `.clean` at
  // a script is stopped for that name; see the block above for why the name
  // cannot be made unconditional. `false` is deliberate: git treats it as a
  // filter that fails, reports `external filter 'false' failed`, and still emits
  // the name-status record — so the read degrades loudly rather than executing
  // the child's script or returning an empty change set.
  "-c",
  "filter.pi-rukas-guarded.clean=false",
  "-c",
  "filter.x.clean=false",
  "-c",
  "filter.git.clean=false",
  // Belt-and-braces: git keeps an index/worktree attribute stack even when the
  // worktree-level file is redirected, so this alone does not defeat a binding
  // (measured). It is kept because it does drop the *config*-level
  // `core.attributesFile`, which is one of the four layers that can bind one.
  "-c",
  "core.attributesFile=/dev/null",
] as const;

/**
 * argv for the committed read: NUL-separated name-status with rename **and
 * copy** detection, and `--end-of-options` so a base that reads like a flag stays
 * a ref.
 *
 * `-C` alongside `-M` is what makes the parser's copy arm reachable at all — `-M`
 * alone can never emit a `C` record. What it buys is narrower than it looks, and
 * measured rather than assumed: git will not report a `C` whose source is an
 * **unmodified** file, so `cp .github/workflows/ci.yml docs/leak.yml` with the
 * workflow left in place is a bare `A docs/leak.yml` under `-M` **and** under
 * `-M -C` — neither flag sees that leak, and the gate cannot claim to. Where the
 * protected file is deleted and its content written to more than one new path,
 * `-M` pairs one destination as `R100` and reports the rest as plain additions,
 * while `-M -C` pairs the next as `C100`; both name the protected source, and the
 * second is the one `-C` adds. Verified against real git 2.50.1 in
 * test-work-driver-protected-paths-read.ts, which asserts both spellings so the
 * `-C` is shown to change the output rather than assumed to.
 */
export const PROTECTED_DIFF_ARGV = [
  ...SAFE_CONFIG,
  "diff",
  "-z",
  "--name-status",
  "-M",
  "-C",
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
 * `C` is git's copy record, which only `-C` makes reachable — see
 * `PROTECTED_DIFF_ARGV`. It is its own arm rather than a re-labelled `R` so a
 * reader cannot mistake "the gate saw a rename" for "the gate saw a copy": the
 * two are different acts (`git mv` vs `cp`) and the finding the operator reads
 * should say which.
 *
 * `other` is git's own code for the kinds that are none of M/A/D/R/C (T type
 * change, X unique, U unmerged). It is the code verbatim rather than a guess,
 * and `path` is still its path — so the protected gate sees the path whatever
 * the kind, and a future kind-specific rule has the real letter to match on.
 * Reaching this arm is gated by {@link NAME_STATUS_CODE_RE}: a token that is not
 * one of those letters is not an unusual kind, it is a **path** sitting in the
 * code slot, and it is unreadable.
 */
export type NameStatus =
  | { kind: "M" | "A" | "D"; path: string }
  | { kind: "R"; score: string; from: string; to: string }
  | { kind: "C"; score: string; from: string; to: string }
  | { kind: "other"; code: string; path: string };

/** The change kinds a non-rename record can be spelled as. */
type NamedKind = "M" | "A" | "D";

/**
 * The only tokens git ever puts in the code slot of a `diff -z --name-status`
 * record: `M`, `A`, `D`, `T`, `U`, `X` bare, and `R`/`C` with the similarity
 * score git appends (`R100`, `C75`).
 *
 * Without this the parser distinguished only an EMPTY code from a real one, so
 * a **non-empty** token in the code slot — a path — fell to the `other` arm and
 * `ok: true`. `".github/workflows/ci.yml\0src/ci.yml\0"` (a codeless stream: the
 * protected path lands in the code slot and the surviving name in the path slot)
 * parsed as one `other` record for `src/ci.yml`, and the protected path the gate
 * exists to halt on was gone from the change set while the read claimed to have
 * seen it. The shape is not hypothetical: git's own `--diff-filter` rejects the
 * same alphabet, and a stream that lacks a code is the stream a truncated or
 * hand-constructed fake produces.
 *
 * A digit is legal **only** on `R`/`C`, which is why the alternation is
 * `(?:[RC]\d*|[MADTUX])` and not `[MADTUCRX]\d*`: the score is git's rename/copy
 * confidence and git appends it to those two letters alone, so `M100` is not a
 * git token. Scoring it in would let a malformed record — or a fake that
 * mistypes the letter — through the very arm this regex exists to close, and the
 * `other` arm would report a path git never said. A bare `R`/`C` (no score) is
 * what the fakes emit and stays legal.
 */
const NAME_STATUS_CODE_RE = /^(?:[RC]\d*|[MADTUX])$/;

/** A rename or copy record — the two kinds that carry a source path. */
type SourcedRecord = Extract<NameStatus, { kind: "R" | "C" }>;

/** The paths a read's records changed, in the order git printed them.
 *  A rename/copy contributes its DESTINATION: the source is not in the tree. */
export function changedPaths(records: readonly NameStatus[]): string[] {
  return records.map((r) => (r.kind === "R" || r.kind === "C" ? r.to : r.path));
}

/**
 * The paths a read's rename/copy records moved away from. Both letters are
 * included deliberately: `-C` is what makes `C` occur at all, and the copy's
 * source is exactly the protected path the leak copies out of.
 */
export function renameSourcePaths(records: readonly NameStatus[]): string[] {
  return records
    .filter((r): r is SourcedRecord => r.kind === "R" || r.kind === "C")
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
 * Read the committed change set with `diff -z --name-status -M -C <base>..HEAD`.
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
 * `core.fsmonitor=false`, `core.hooksPath=/dev/null`, `core.attributesFile=/dev/null`
 * and the per-name `filter.<name>.clean=false` entries). `--no-ext-diff` and
 * `--no-textconv` are **deliberately absent**: they are `git diff` options, so at
 * the global position git rejects them outright (exit 129) and they would break
 * this read — see the `SAFE_CONFIG` block for the measurement, and for why the
 * per-name filter entries are defence-in-depth rather than the safety boundary.
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
      maxBuffer: PROTECTED_DIFF_MAX_BUFFER,
      timeout: DEFAULT_GIT_TIMEOUT_MS,
    }));
  } catch (err) {
    return { ok: false, unreadable: `git diff -z --name-status -M -C failed: ${errText(err)}` };
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
    if (!NAME_STATUS_CODE_RE.test(code)) {
      // A non-empty token that is not one of git's letters is a PATH in the code
      // slot, not an exotic kind. Reading on would pair it with the next token as
      // its "path" and report a change set missing the file the caller must halt on.
      return {
        ok: false,
        unreadable: `unrecognised name-status code ${JSON.stringify(code.slice(0, 80))}`,
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
      // Each letter keeps its own arm: `-C` is the only thing that makes `C`
      // appear, and a copy is what a developer produces when they duplicate a
      // workflow out of a protected directory instead of moving it.
      records.push(
        kind === "C"
          ? { kind: "C", score: code.slice(1), from, to }
          : { kind: "R", score: code.slice(1), from, to },
      );
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
