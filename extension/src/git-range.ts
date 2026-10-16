/**
 * git-range — the PR range and its commit count (#1134).
 *
 * `execGit` is how driver git plumbing invokes git: argv always, a bounded
 * timeout always, never a command string.
 *
 * Shared by the driver's diff reader, the verify gates and the comment-retention
 * check, so every PR-shaped git read names its range the same way. Imports
 * nothing from work-driver-*: it is a neutral leaf, which keeps those modules
 * from depending on each other through it.
 */

import type { ExecFn } from "./worktree.ts";

/** Per-git-call timeout when the caller does not pass one (a hung git must not hang the cycle). */
export const DEFAULT_GIT_TIMEOUT_MS = 10 * 60_000;

/**
 * Run git with argv (never a shell string) and return its stdout. Rejects on
 * any exec failure, carrying the exec error shape (`code`, `stderr`).
 */
export async function execGit(
  exec: ExecFn,
  cwd: string,
  args: string[],
  opts: { timeout?: number; maxBuffer?: number } = {},
): Promise<string> {
  const { stdout } = await exec("git", {
    argv: args,
    cwd,
    timeout: opts.timeout ?? DEFAULT_GIT_TIMEOUT_MS,
    maxBuffer: opts.maxBuffer ?? 1024 * 1024,
  });
  return stdout;
}

/**
 * The PR range as one string: `<base>...<head>`, the diff from the merge base to
 * `head`. Callers pass fully-qualified refs (`origin/<base>`, `origin/<branch>`),
 * or a local ref where the site runs before the push. Two-dot is never used for
 * a PR: it diffs tip against tip, so a base that moved after the branch was cut
 * reads as reverted files.
 */
export function prRange(base: string, head: string): string {
  return `${base}...${head}`;
}

/**
 * Tri-state ref probe (#1134 follow-up). `absent` is git's own "not a valid
 * object" answer (exit 1 under `--quiet`); any other failure — a spawn error,
 * a timeout, a non-repo cwd — is `unknown` and carries the error, because it
 * says nothing about whether the ref exists.
 */
export type RefState =
  | { state: "resolves" }
  | { state: "absent" }
  | { state: "unknown"; error: string };

export async function refResolves(
  exec: ExecFn,
  cwd: string,
  ref: string,
  timeout?: number,
): Promise<RefState> {
  try {
    // A zero exit is the answer: `rev-parse --verify` prints the object id it resolved.
    await execGit(exec, cwd, ["rev-parse", "--verify", "--quiet", "--end-of-options", ref], {
      timeout,
      maxBuffer: 64 * 1024,
    });
    return { state: "resolves" };
  } catch (err) {
    // #1153 — only git's OWN "not a valid object" answer is `absent`. A probe
    // the harness killed (a timeout, a signal) exits 1 as well — node's child
    // process reports `code: 1` alongside `killed: true` — and says nothing
    // about whether the ref exists. Reading that as absent would tell the
    // operator "the branch was not pushed from here" about a ref nobody read.
    if (gitSaysAbsent(err)) return { state: "absent" };
    return { state: "unknown", error: errorText(err) };
  }
}

/**
 * How far `head` is ahead of `base` (#1134 follow-up). One place that decides
 * "commits ahead of base, and can we tell?"; each caller maps the kind to its
 * own policy. `unknown` and `unresolved` carry a sentence naming what could not
 * be read, so no caller has to invent one.
 */
export type AheadOfBase =
  | { kind: "ahead"; n: number }
  | { kind: "empty" }
  | { kind: "unpushed" }
  | { kind: "unresolved"; reason: string }
  | { kind: "unknown"; error: string };

export async function aheadOfBase(
  exec: ExecFn,
  cwd: string,
  base: string,
  head: string,
  opts: { pathspec?: string[]; timeout?: number } = {},
): Promise<AheadOfBase> {
  // #1153 — the two probes are independent: neither result changes how the
  // other is run. Sequentially they cost two git spawns (and two timeouts on
  // a hung fs); together they cost one.
  const [h, b] = await Promise.all([
    refResolves(exec, cwd, head, opts.timeout),
    refResolves(exec, cwd, base, opts.timeout),
  ]);
  if (h.state === "absent") return { kind: "unpushed" };
  if (h.state === "unknown")
    return { kind: "unknown", error: `could not check ${head}: ${h.error}` };
  if (b.state === "absent")
    return { kind: "unresolved", reason: `${base} does not resolve in this clone` };
  if (b.state === "unknown")
    return { kind: "unknown", error: `could not check ${base}: ${b.error}` };
  let stdout: string;
  try {
    stdout = await execGit(
      exec,
      cwd,
      [
        "rev-list",
        "--count",
        "--right-only",
        "--end-of-options",
        prRange(base, head),
        ...(opts.pathspec?.length ? ["--", ...opts.pathspec] : []),
      ],
      { timeout: opts.timeout, maxBuffer: 64 * 1024 },
    );
  } catch (err) {
    return {
      kind: "unknown",
      error: `could not count commits ahead of ${base}: ${errorText(err)}`,
    };
  }
  const t = stdout.trim();
  if (!/^\d+$/.test(t)) {
    return {
      kind: "unknown",
      error: `could not count commits ahead of ${base}: git printed "${t.slice(0, 80)}", not a count`,
    };
  }
  const n = Number(t);
  return n === 0 ? { kind: "empty" } : { kind: "ahead", n };
}

/**
 * Did git itself say "not a valid object"? Exit code 1 alone is not enough:
 * a killed or timed-out probe carries `code: 1` too, with `killed` set and a
 * `signal` naming what terminated it. Both must be absent for the exit code
 * to be git's answer rather than the harness's.
 */
function gitSaysAbsent(err: unknown): boolean {
  const e = err as { code?: unknown; killed?: unknown; signal?: unknown } | null;
  if (e?.code !== 1) return false;
  if (e.killed === true) return false;
  return e.signal === null || e.signal === undefined;
}

/**
 * A short description of an exec failure. `stderr` is preferred over
 * `message`: node's generic `Command failed: git …` prefix names the command
 * and says nothing, while git's own stderr names the reason (`fatal: not a
 * git repository`, `ambiguous argument`). Falls back to `message` when the
 * stream is empty or absent.
 */
function errorText(err: unknown): string {
  const e = err as { stderr?: unknown; message?: unknown } | null;
  const stderr = typeof e?.stderr === "string" ? e.stderr.trim() : "";
  const text = stderr || ((e?.message ?? String(err)) as string);
  return String(text).slice(0, 200);
}
