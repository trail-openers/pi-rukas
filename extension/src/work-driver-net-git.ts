/**
 * work-driver-net-git — #1095: the single seam for the driver's own NETWORK
 * git calls (fetch, pull, push, ls-remote).
 *
 * Why this exists: a driver network git call had no timeout and no
 * non-interactive SSH setting. `GIT_TERMINAL_PROMPT=0` only covers HTTPS
 * credential prompts; ssh reads a key passphrase or agent unlock from
 * /dev/tty directly, so a forwarded agent that vanished parks the call
 * indefinitely (one meadow `--restart` sat ~5h before handing off at branch).
 *
 * Every driver network git call goes through `runNetGit`, which:
 *   - runs with `GIT_TERMINAL_PROMPT=0` and a `GIT_SSH_COMMAND` that adds
 *     `-o BatchMode=yes` and `-o ConnectTimeout=30` ONLY when the operator's
 *     value does not already carry them (an operator-set command is kept);
 *   - is bounded by `PI_ENSEMBLE_GIT_NET_TIMEOUT_MS` (default 300000). The
 *     bound is enforced by a race, not just the exec `timeout`, because the
 *     exec callback waits for stdio to close and an ssh grandchild can hold
 *     the pipe open after git is killed. The call also passes `killGroup`, so
 *     an executor that honours it (exec.ts) SIGKILLs the whole process group
 *     and no ssh grandchild outlives the bound. A timeout rejects with
 *     `NetGitTimeoutError`, whose message begins "network git timed out".
 *
 * The enumeration gate (smoke-tests/test-driver-network-git-env.ts) fails if a
 * driver source file runs a network git command without going through here.
 */

import { execFileSync } from "node:child_process";
import path from "node:path";
import type { ExecFn } from "./worktree.ts";

export const NET_GIT_TIMEOUT_ENV = "PI_ENSEMBLE_GIT_NET_TIMEOUT_MS";
export const NET_GIT_TIMEOUT_DEFAULT_MS = 300_000;

/** The executor shape every driver network call receives (ExecFn-compatible). */
export type NetExec = (
  cmd: string,
  opts?: {
    cwd?: string;
    timeout?: number;
    maxBuffer?: number;
    argv?: string[];
    env?: NodeJS.ProcessEnv;
    /** Run in its own process group and kill the group on timeout (exec.ts). */
    killGroup?: boolean;
  },
) => Promise<{ stdout: string; stderr?: string }>;

export class NetGitTimeoutError extends Error {
  constructor(
    readonly command: string,
    readonly timeoutMs: number,
  ) {
    super(
      `network git timed out after ${timeoutMs}ms: ${command} — the remote did not answer (check the SSH agent and key; BatchMode makes ssh fail instead of waiting for a passphrase; PI_ENSEMBLE_GIT_NET_TIMEOUT_MS raises the bound)`,
    );
    this.name = "NetGitTimeoutError";
  }
}

export function isNetGitTimeout(err: unknown): err is NetGitTimeoutError {
  return err instanceof NetGitTimeoutError;
}

/** The bound in ms: the env value when it is a positive integer, else the default. */
export function netGitTimeoutMs(env: NodeJS.ProcessEnv = process.env): number {
  const raw = env[NET_GIT_TIMEOUT_ENV];
  const n = raw === undefined ? Number.NaN : Number(raw);
  return Number.isInteger(n) && n > 0 ? n : NET_GIT_TIMEOUT_DEFAULT_MS;
}

/** Append the ssh options that are absent from an operator-set command. */
export function withSshDefaults(sshCommand: string): string {
  const parts = [sshCommand];
  if (!/BatchMode=/.test(sshCommand)) parts.push("-o BatchMode=yes");
  if (!/ConnectTimeout=/.test(sshCommand)) parts.push("-o ConnectTimeout=30");
  return parts.join(" ");
}

/** Shell-quote one word: git runs GIT_SSH_COMMAND through a shell, so a GIT_SSH path with spaces must be quoted. */
function shellWord(p: string): string {
  return /^[\w@%+=:,./-]+$/.test(p) ? p : `'${p.replace(/'/g, "'\\''")}'`;
}

/**
 * Split a shell-style command string into words (POSIX quoting: single quotes,
 * double quotes with backslash escapes, backslash outside quotes). GIT_SSH_COMMAND
 * and core.sshCommand are run through a shell, so `'/opt/my ssh/ssh' -i /k`
 * names the program `/opt/my ssh/ssh`.
 */
export function splitShellWords(s: string): string[] {
  const words: string[] = [];
  let cur = "";
  let inWord = false;
  let quote: "'" | '"' | undefined;
  for (let i = 0; i < s.length; i++) {
    const c = s[i] as string;
    if (quote === "'") {
      if (c === "'") quote = undefined;
      else cur += c;
    } else if (quote === '"') {
      if (c === '"') quote = undefined;
      else if (c === "\\" && i + 1 < s.length && '"\\$`'.includes(s[i + 1] as string))
        cur += s[++i];
      else cur += c;
    } else if (c === "'" || c === '"') {
      quote = c;
      inWord = true;
    } else if (c === "\\" && i + 1 < s.length) {
      cur += s[++i];
      inWord = true;
    } else if (/\s/.test(c)) {
      if (inWord) words.push(cur);
      cur = "";
      inWord = false;
    } else {
      cur += c;
      inWord = true;
    }
  }
  if (inWord) words.push(cur);
  return words;
}

/** core.sshCommand per repo, read once: a `git config` spawn per network call is wasted work. */
const sshConfigCache = new Map<string, string | null>();

/** Test seam: forget the cached core.sshCommand lookups. */
export function resetSshConfigCache(): void {
  sshConfigCache.clear();
}

function repoSshCommand(cwd: string): string | null {
  const hit = sshConfigCache.get(cwd);
  if (hit !== undefined) return hit;
  let value: string | null = null;
  try {
    value =
      execFileSync("git", ["config", "--get", "core.sshCommand"], {
        cwd,
        encoding: "utf8",
        stdio: ["ignore", "pipe", "ignore"],
      }).trim() || null;
  } catch {
    // unset (git config exits 1) or not a repo: fall through to GIT_SSH / ssh
  }
  sshConfigCache.set(cwd, value);
  return value;
}

/**
 * The ssh command git itself would run, as a shell-ready string plus its
 * program name, in git's precedence order: GIT_SSH_COMMAND, then
 * core.sshCommand (repo config, read in `cwd`), then GIT_SSH, then plain `ssh`.
 * Setting GIT_SSH_COMMAND unconditionally would outrank a repo's
 * core.sshCommand, so the defaults must be appended to the command git would
 * have used (#1095 review).
 */
function operatorSsh(base: NodeJS.ProcessEnv, cwd?: string): { command: string; program: string } {
  const fromEnv = base.GIT_SSH_COMMAND?.trim();
  if (fromEnv) return { command: fromEnv, program: splitShellWords(fromEnv)[0] ?? "" };
  const cfg = cwd === undefined ? null : repoSshCommand(cwd);
  if (cfg) return { command: cfg, program: splitShellWords(cfg)[0] ?? "" };
  const gitSsh = base.GIT_SSH?.trim();
  // GIT_SSH is exec'd directly by git (no shell), so its path is quoted here.
  if (gitSsh) return { command: shellWord(gitSsh), program: gitSsh };
  return { command: "ssh", program: "ssh" };
}

/**
 * The non-interactive environment every driver network git call runs with.
 * `cwd` lets the repo's core.sshCommand take part in the precedence (see
 * operatorSsh); without it only the env and the default apply. The OpenSSH
 * options are appended only when the program is OpenSSH: a plink or wrapper
 * may reject unknown `-o` flags, and the operator's command is kept as is.
 */
export function netGitEnv(base: NodeJS.ProcessEnv = process.env, cwd?: string): NodeJS.ProcessEnv {
  const { command, program } = operatorSsh(base, cwd);
  const isOpenSsh = /^ssh(\.exe)?$/.test(path.basename(program));
  return {
    ...base,
    GIT_TERMINAL_PROMPT: "0",
    GIT_SSH_COMMAND: isOpenSsh ? withSshDefaults(command) : command,
  };
}

/**
 * Named refusal for a remote or branch that is not safe to hand to git (#1095
 * security). Argv removes shell parsing, but git still parses refspec syntax
 * from argv: `:` (src:dst), a leading `+` (force), `^`, `~`, `*`, `?`, `[`, `{`
 * and a leading `-` (option injection) are all live. So the check is an
 * allowlist, not a denylist. Undefined when every value is safe. Callers refuse
 * BEFORE any git call, so a refused name never reaches a command line.
 */
export function netRefProblem(...refs: string[]): string | undefined {
  for (const ref of refs) {
    if (ref.length === 0 || ref.startsWith("-")) return `"${ref}" is not a valid git ref name`;
    if (!NET_REF_ALLOWED.test(ref) || ref.includes("..")) {
      return `"${ref}" contains characters a network git call will not take`;
    }
  }
  return undefined;
}

/**
 * The names a network git call may carry: a letter, digit or `_` first, then
 * git-valid name characters. Refuses `:` (refspec), a leading `+` (force),
 * `^ ~ * ? [ {` (refspec/revision syntax), whitespace and shell metacharacters.
 * Git-valid names such as `feature/x+y` and `user@host` pass.
 */
const NET_REF_ALLOWED = /^[A-Za-z0-9_][A-Za-z0-9._/+@-]*$/;

export interface NetGitOpts {
  cwd?: string;
  maxBuffer?: number;
  /** argv form (#1005): `cmd` is the executable, `argv` its arguments. */
  argv?: string[];
  /**
   * A tighter per-call bound (e.g. a best-effort ls-remote). Clamped to the
   * PI_ENSEMBLE_GIT_NET_TIMEOUT_MS ceiling, never raised above it.
   */
  timeoutMs?: number;
}

/**
 * Run one driver network git command with the non-interactive env and the
 * bounded wait. Rejects with `NetGitTimeoutError` when the bound elapses; any
 * other failure is the executor's own error, passed through unchanged.
 */
export async function runNetGit(
  execFn: NetExec | ExecFn,
  cmd: string,
  opts: NetGitOpts = {},
): Promise<{ stdout: string; stderr?: string }> {
  const ceiling = netGitTimeoutMs();
  const timeoutMs = opts.timeoutMs === undefined ? ceiling : Math.min(opts.timeoutMs, ceiling);
  const label = (opts.argv ? [cmd, ...opts.argv] : [cmd]).join(" ").slice(0, 160);
  let timer: ReturnType<typeof setTimeout> | undefined;
  const deadline = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new NetGitTimeoutError(label, timeoutMs)), timeoutMs);
  });
  try {
    return await Promise.race([
      (execFn as NetExec)(cmd, {
        cwd: opts.cwd,
        maxBuffer: opts.maxBuffer ?? 1024 * 1024,
        timeout: timeoutMs,
        killGroup: true,
        env: netGitEnv(process.env, opts.cwd),
        ...(opts.argv ? { argv: opts.argv } : {}),
      }),
      deadline,
    ]);
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}
