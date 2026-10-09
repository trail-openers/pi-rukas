/**
 * #1015 — the harness-computed git-state line a developer/ops dispatch report
 * carries. A child can report "committed and pushed" while its worktree still
 * holds uncommitted files; this snapshot runs in the PARENT at report-build
 * time, against the dispatch cwd, and states what is actually on disk.
 *
 * Informational only: it never changes a dispatch's outcome. Every failure
 * (non-repo cwd, nested non-repo cwd, git error, 10s whole-report timeout, no
 * commits) yields "unverified (<reason>)" — never "clean". The dispatch cwd must be
 * the repository top level.
 *
 * The file list is untrusted repo content read by the PM model: it is rendered
 * behind an explicit UNTRUSTED_NAMES_MARKER, JSON-quoted, and stripped of
 * control, bidi/zero-width format and line/paragraph-separator characters.
 */
import { execFile } from "node:child_process";
import { realpathSync } from "node:fs";
import { promisify } from "node:util";

const execFileP = promisify(execFile);

export const GIT_STATE_TIMEOUT_MS = 10_000;
/** Marker that tells the PM model the names after it are untrusted repo content. */
export const UNTRUSTED_NAMES_MARKER = "(untrusted names)";
const PREFIX = "git state (at report time):";
const MAX_LISTED = 5;
const MAX_LINE_BYTES = 300;
const MAX_PATH_CHARS = 80;

/** Runs `git <args>` in `cwd`; `signal` aborts the child when the report deadline fires. */
export type GitRunner = (args: string[], cwd: string, signal?: AbortSignal) => Promise<string>;

/** Produces the git-state line for one dispatch cwd. Never expected to reject. */
export type GitLineFor = (cwd: string | undefined) => Promise<string>;

export const runGit: GitRunner = async (args, cwd, signal) => {
  // The repo is child-writable: a `core.fsmonitor` or hook config written there must never run in the parent.
  const safe = ["-c", "core.fsmonitor=false", "-c", "core.hooksPath=/dev/null", ...args];
  // No per-call timeout: the report-level AbortSignal deadline is the bound.
  const { stdout } = await execFileP("git", safe, {
    cwd,
    signal,
    maxBuffer: 4 * 1024 * 1024,
  });
  return stdout;
};

function reasonOf(err: unknown): string {
  const e = err as {
    code?: unknown;
    stderr?: string;
    message?: string;
  };
  if (e.code === "ERR_CHILD_PROCESS_STDIO_MAXBUFFER") return "git output too large";
  if (/not a git repository/i.test(`${e.stderr ?? ""} ${e.message ?? ""}`)) {
    return "not a git repository";
  }
  return "git error";
}

class Unverified extends Error {
  constructor(readonly reason: string) {
    super(reason);
  }
}

/**
 * Path of a `git status --porcelain` line. Only R (rename) and C (copy) entries
 * carry `ORIG -> NEW`; any other entry's name may itself contain " -> ".
 */
function porcelainPath(line: string): string {
  const raw = line.slice(3);
  const arrow = /[RC]/.test(line.slice(0, 2)) ? raw.indexOf(" -> ") : -1;
  const path = arrow >= 0 ? raw.slice(arrow + 4) : raw;
  // Zl/Zp (U+2028/U+2029) are line separators to line-oriented readers; git does not C-quote them.
  const printable = path.replace(/[\p{Cc}\p{Cf}\p{Zl}\p{Zp}]/gu, "");
  return JSON.stringify(Array.from(printable).slice(0, MAX_PATH_CHARS).join(""));
}

/** A count from git must be a plain non-negative integer; anything else is unverified, never zero. */
function countOf(out: string): number {
  const text = out.trim();
  if (!/^\d+$/.test(text)) throw new Unverified("git error");
  return Number(text);
}

async function unpushedClause(run: GitRunner, cwd: string): Promise<string> {
  // `rev-parse -q` exits 1 for a missing upstream; any other failure is a real error.
  const hasUpstream = await run(["rev-parse", "--verify", "-q", "@{u}"], cwd).then(
    () => true,
    (err: unknown) => {
      if ((err as { code?: number }).code !== 1) throw err;
      return false;
    },
  );
  if (hasUpstream) {
    const ahead = countOf(await run(["rev-list", "--count", "@{u}..HEAD"], cwd));
    return ahead > 0 ? `${ahead} commit(s) ahead of upstream` : "up to date with upstream";
  }
  const local = countOf(await run(["rev-list", "--count", "HEAD", "--not", "--remotes"], cwd));
  return local > 0 ? `no upstream, ${local} commit(s) not on any remote` : "";
}

function lineFor(count: number, listed: string[], unpushed: string): string {
  const more = count - listed.length;
  const tree =
    count === 0
      ? "clean"
      : listed.length === 0
        ? `${count} uncommitted/untracked (names omitted)`
        : `${count} uncommitted/untracked ${UNTRUSTED_NAMES_MARKER}: ${listed.join(", ")}${more > 0 ? ` (+${more} more)` : ""}`;
  return `${PREFIX} ${tree}${unpushed ? `; ${unpushed}` : ""}`;
}

/**
 * Lists as many of the first MAX_LISTED paths as fit the byte budget. The count
 * and the "+N more" suffix are always kept; a line that cannot name any path says
 * "names omitted", so the result is always within MAX_LINE_BYTES.
 */
function boundedLine(entries: string[], unpushed: string): string {
  const listed: string[] = [];
  for (const entry of entries.slice(0, MAX_LISTED)) {
    const next = [...listed, porcelainPath(entry)];
    if (Buffer.byteLength(lineFor(entries.length, next, unpushed)) > MAX_LINE_BYTES) break;
    listed.push(next[next.length - 1] as string);
  }
  return lineFor(entries.length, listed, unpushed);
}

/**
 * The one git-state line for a dispatch cwd, e.g.
 *   "git state (at report time): clean"
 *   "git state (at report time): 7 uncommitted/untracked (untrusted names): \"a\", \"b\" (+5 more); 1 commit(s) ahead of upstream"
 *   "git state (at report time): unverified (not a git repository)"
 */
async function reportLine(cwd: string | undefined, run: GitRunner): Promise<string> {
  if (cwd === undefined) return `${PREFIX} unverified (no cwd)`;
  try {
    // The three probes are independent; they share the report deadline via `run`.
    // `-c core.quotepath=off` keeps non-ASCII names raw so the format-character strip sees them;
    // `--no-optional-locks` keeps the report from taking the index lock.
    // `normal` lists untracked directories as one entry: no walk of an unignored build tree.
    const headProbe = run(["rev-parse", "--verify", "-q", "HEAD"], cwd).then(
      () => undefined,
      (err: unknown) => {
        if ((err as { code?: number }).code !== 1) throw err;
        throw new Unverified("no commits");
      },
    );
    const [topOut, status] = await Promise.all([
      run(["rev-parse", "--show-toplevel"], cwd),
      run(
        [
          "-c",
          "core.quotepath=off",
          "--no-optional-locks",
          "status",
          "--porcelain",
          "--untracked-files=normal",
        ],
        cwd,
      ),
      headProbe,
    ]);
    // A nested non-repo cwd resolves upward to the parent repo; the dispatch cwd must BE the top level.
    if (realpathSync(topOut.trim()) !== realpathSync(cwd)) {
      throw new Unverified("not repository top level");
    }
    const entries = status.split("\n").filter((l) => l.length > 0);
    const unpushed = await unpushedClause(run, cwd);
    return boundedLine(entries, unpushed);
  } catch (err) {
    const reason = err instanceof Unverified ? err.reason : reasonOf(err);
    return `${PREFIX} unverified (${reason})`;
  }
}

/**
 * #1015 — the whole report is bounded by ONE deadline (GIT_STATE_TIMEOUT_MS), not per git call:
 * a hung repo must not delay the steer by several timeouts in sequence. At the deadline the
 * shared AbortSignal kills any git child still running and every later git call is refused.
 * Never rejects.
 */
export async function gitStateLine(
  cwd: string | undefined,
  runner: GitRunner = runGit,
): Promise<string> {
  const ctl = new AbortController();
  let timer: ReturnType<typeof setTimeout> | undefined;
  const deadline = new Promise<string>((resolve) => {
    timer = setTimeout(() => {
      ctl.abort();
      resolve(`${PREFIX} unverified (git timeout)`);
    }, GIT_STATE_TIMEOUT_MS);
  });
  const run: GitRunner = (args, dir) =>
    ctl.signal.aborted
      ? Promise.reject(new Unverified("git timeout"))
      : runner(args, dir, ctl.signal);
  try {
    return await Promise.race([reportLine(cwd, run), deadline]);
  } finally {
    clearTimeout(timer);
  }
}
