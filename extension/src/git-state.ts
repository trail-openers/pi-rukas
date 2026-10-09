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
 */
import { execFile } from "node:child_process";
import { realpathSync } from "node:fs";
import { promisify } from "node:util";

const execFileP = promisify(execFile);

export const GIT_STATE_TIMEOUT_MS = 10_000;
const PREFIX = "git state (at report time):";
const MAX_LISTED = 5;
const MAX_LINE_BYTES = 300;
const MAX_PATH_CHARS = 80;

/** Runs `git <args>` in `cwd`; resolves stdout, rejects on any failure. */
export type GitRunner = (args: string[], cwd: string) => Promise<string>;

export const runGit: GitRunner = async (args, cwd) => {
  const { stdout } = await execFileP("git", args, {
    cwd,
    timeout: GIT_STATE_TIMEOUT_MS,
    maxBuffer: 4 * 1024 * 1024,
  });
  return stdout;
};

function reasonOf(err: unknown): string {
  const e = err as {
    killed?: boolean;
    signal?: string | null;
    stderr?: string;
    message?: string;
  };
  // Only the exec timeout sets `killed`; an external signal is not a timeout.
  if (e.killed) return "git timeout";
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

/** Path of a `git status --porcelain` line; renames keep the new path. */
function porcelainPath(line: string): string {
  const raw = line.slice(3);
  const arrow = raw.indexOf(" -> ");
  const path = arrow >= 0 ? raw.slice(arrow + 4) : raw;
  // Untrusted (PR-controlled) filenames: JSON-quote (escapes newlines/control chars, marks it as data) and bound the length.
  return JSON.stringify(Array.from(path).slice(0, MAX_PATH_CHARS).join(""));
}

function countOf(out: string): number {
  return Number.parseInt(out.trim(), 10) || 0;
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

function capBytes(line: string): string {
  if (Buffer.byteLength(line) <= MAX_LINE_BYTES) return line;
  // Accumulate by code point so a surrogate pair is never split.
  let out = "";
  let bytes = 0;
  for (const ch of line) {
    const b = Buffer.byteLength(ch);
    if (bytes + b > MAX_LINE_BYTES - 3) break;
    out += ch;
    bytes += b;
  }
  return `${out}...`;
}

/**
 * The one git-state line for a dispatch cwd, e.g.
 *   "git state (at report time): clean"
 *   "git state (at report time): 7 uncommitted/untracked (a, b, c, d, e, +2 more); 1 commit(s) ahead of upstream"
 *   "git state (at report time): unverified (not a git repository)"
 */
async function reportLine(cwd: string | undefined, run: GitRunner): Promise<string> {
  if (cwd === undefined) return `${PREFIX} unverified (no cwd)`;
  try {
    // A nested non-repo cwd resolves upward to the parent repo; the dispatch cwd must BE the top level.
    const top = (await run(["rev-parse", "--show-toplevel"], cwd)).trim();
    if (realpathSync(top) !== realpathSync(cwd)) throw new Unverified("not a git repository");
    // `normal` lists untracked directories as one entry: no walk of an unignored build tree.
    const status = await run(["status", "--porcelain", "--untracked-files=normal"], cwd);
    await run(["rev-parse", "--verify", "-q", "HEAD"], cwd).catch((err: unknown) => {
      if ((err as { code?: number }).code !== 1) throw err;
      throw new Unverified("no commits");
    });
    const entries = status.split("\n").filter((l) => l.length > 0);
    const unpushed = await unpushedClause(run, cwd);
    const tree =
      entries.length === 0
        ? "clean"
        : `${entries.length} uncommitted/untracked (${entries
            .slice(0, MAX_LISTED)
            .map(porcelainPath)
            .join(
              ", ",
            )}${entries.length > MAX_LISTED ? `, +${entries.length - MAX_LISTED} more` : ""})`;
    return capBytes(`${PREFIX} ${tree}${unpushed ? `; ${unpushed}` : ""}`);
  } catch (err) {
    const reason = err instanceof Unverified ? err.reason : reasonOf(err);
    return `${PREFIX} unverified (${reason})`;
  }
}

/**
 * #1015 — the whole report is bounded by ONE deadline (GIT_STATE_TIMEOUT_MS), not per git call:
 * a hung repo must not delay the steer by several timeouts in sequence.
 */
export async function gitStateLine(
  cwd: string | undefined,
  run: GitRunner = runGit,
): Promise<string> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const deadline = new Promise<string>((resolve) => {
    timer = setTimeout(() => resolve(`${PREFIX} unverified (git timeout)`), GIT_STATE_TIMEOUT_MS);
  });
  try {
    return await Promise.race([reportLine(cwd, run), deadline]);
  } finally {
    clearTimeout(timer);
  }
}
