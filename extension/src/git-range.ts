/**
 * git-range — the one typed git entry point and the PR range it names (#1134,
 * #1153).
 *
 * `execGit` is how driver git plumbing invokes git: argv always, a bounded
 * timeout always, never a command string. Shared by the driver's diff reader,
 * the verify gates and the comment-retention check, so every PR-shaped read
 * names its range the same way. Imports nothing from work-driver-*: it is a
 * neutral leaf, which keeps those modules from depending on each other.
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
    if (exitCodeOf(err) === 1) return { state: "absent" };
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
  const h = await refResolves(exec, cwd, head, opts.timeout);
  if (h.state === "absent") return { kind: "unpushed" };
  if (h.state === "unknown")
    return { kind: "unknown", error: `could not check ${head}: ${h.error}` };
  const b = await refResolves(exec, cwd, base, opts.timeout);
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

function exitCodeOf(err: unknown): number | undefined {
  const code = (err as { code?: unknown } | null)?.code;
  return typeof code === "number" ? code : undefined;
}

function errorText(err: unknown): string {
  return ((err as Error)?.message ?? String(err)).slice(0, 200);
}
