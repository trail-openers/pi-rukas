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
 * Tri-state ref probe (#1134 follow-up). `absent` is git's OWN answer that
 * the ref is not there — its exit code (1 or 128) **and** its wording; any
 * other failure — a spawn error, a timeout, a signal, a non-repo cwd, a
 * dubious ownership — is `unknown` and carries the error, because it says
 * nothing about whether the ref exists.
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
    // No `--quiet`, deliberately (#1153 fix round): `--quiet` suppresses the
    // stderr that is the only real evidence for `absent`, AND it changes the
    // exit code — measured on git 2.53, a missing ref exits 1 with an empty
    // stderr under `--quiet` and 128 with `fatal: Needed a single revision`
    // without it. Probing without the flag is what lets `gitSaysAbsent` read
    // git's wording instead of guessing from a bare code.
    await execGit(exec, cwd, ["rev-parse", "--verify", "--end-of-options", ref], {
      timeout,
      maxBuffer: 64 * 1024,
    });
    return { state: "resolves" };
  } catch (err) {
    // #1153 — only git's OWN "this ref is not there" answer is `absent`. A
    // probe the harness killed (a timeout, a signal) carries a numeric exit
    // code as well — node's child process reports `code: 1` alongside
    // `killed: true` — and says nothing about whether the ref exists. Reading
    // that as absent would tell the operator "the branch was not pushed from
    // here" about a ref nobody read.
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
 * Did git itself say "this ref is not there"? Two conditions, both needed
 * (#1153 review):
 *
 * - **The exit code is git's, not the harness's.** A killed or timed-out
 *   probe carries a numeric code too, with `killed` set and a `signal` naming
 *   what terminated it. Neither is an answer about the ref.
 * - **git's wording says the ref is missing.** This is the load-bearing half,
 *   and it is why `--quiet` is not used: with the flag, a missing ref exits 1
 *   with an EMPTY stderr, and "exit 1 and said nothing" is not evidence — it
 *   is the same shape a silent shim or a killed probe leaves. Measured on git
 *   2.53 without the flag, a missing ref exits **128** with
 *   `fatal: Needed a single revision`, so the accepted codes are 1 and 128 and
 *   the wording decides between them. A non-repo cwd exits 128 too, with
 *   `fatal: not a git repository` — same code, different question — which is
 *   exactly what the wording clause separates.
 */
function gitSaysAbsent(err: unknown): boolean {
  const e = err as { code?: unknown; killed?: unknown; signal?: unknown } | null;
  if (e?.code !== 1 && e?.code !== 128) return false;
  if (e.killed === true) return false;
  if (e.signal !== null && e.signal !== undefined) return false;
  return gitWordingSaysRefMissing(err);
}

/**
 * git's own words for "I could not turn this string into a revision" — the
 * `rev-parse --verify` messages that mean the ref is not there. Matched
 * case-insensitively because git capitalises some of them
 * (`fatal: Needed a single revision`) and lower-cases others
 * (`fatal: not a valid object name …`).
 *
 * Anything else on stderr — `not a git repository`, `dubious ownership`, a
 * corrupt-objects complaint — is about the clone, not the ref, and the probe
 * stays `unknown`.
 */
function gitWordingSaysRefMissing(err: unknown): boolean {
  const e = err as { stderr?: unknown } | null;
  const stderr = typeof e?.stderr === "string" ? e.stderr : "";
  return /not a valid object name|unknown revision|ambiguous argument|needed a single revision/i.test(
    stderr,
  );
}

/**
 * A short description of an exec failure. `stderr` is preferred over
 * `message`: node's generic `Command failed: git …` prefix names the command
 * and says nothing, while git's own stderr names the reason (`fatal: not a
 * git repository`, `ambiguous argument`). Falls back to `message` when the
 * stream is empty or absent.
 */
export function errorText(err: unknown): string {
  const e = err as { stderr?: unknown; message?: unknown } | null;
  const stderr = typeof e?.stderr === "string" ? e.stderr.trim() : "";
  const text = stderr || ((e?.message ?? String(err)) as string);
  return String(text).slice(0, 200);
}
