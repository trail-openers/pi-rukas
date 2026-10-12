/**
 * work-driver-net-git — #1095: the single seam for the driver's own NETWORK
 * git calls (fetch, pull, push, ls-remote).
 *
 * Why this exists: a driver network git call had no timeout and no
 * non-interactive SSH setting. `GIT_TERMINAL_PROMPT=0` only covers HTTPS
 * credential prompts; ssh reads a key passphrase or agent unlock from
 * /dev/tty directly, so a forwarded agent that vanished parks the call
 * indefinitely (one lievo `--restart` sat ~5h before handing off at branch).
 *
 * Every driver network git call goes through `runNetGit`, which:
 *   - runs with `GIT_TERMINAL_PROMPT=0` and a `GIT_SSH_COMMAND` that adds
 *     `-o BatchMode=yes` and `-o ConnectTimeout=30` ONLY when the operator's
 *     value does not already carry them (an operator-set command is kept);
 *   - is bounded by `PI_ENSEMBLE_GIT_NET_TIMEOUT_MS` (default 300000). The
 *     bound is enforced by a race, not just the exec `timeout`, because the
 *     exec callback waits for stdio to close and an ssh grandchild can hold
 *     the pipe open after git is killed. The call also passes `killGroup`, so
 *     an executor that honours it (lens-exec) SIGKILLs the whole process group
 *     and no ssh grandchild outlives the bound. A timeout rejects with
 *     `NetGitTimeoutError`, whose message begins "network git timed out".
 *
 * The enumeration gate (smoke-tests/test-driver-network-git-env.ts) fails if a
 * driver source file runs a network git command without going through here.
 */

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
    /** Run in its own process group and kill the group on timeout (lens-exec). */
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

/** The non-interactive environment every driver network git call runs with. */
export function netGitEnv(base: NodeJS.ProcessEnv = process.env): NodeJS.ProcessEnv {
  const operatorSsh = base.GIT_SSH_COMMAND?.trim();
  return {
    ...base,
    GIT_TERMINAL_PROMPT: "0",
    GIT_SSH_COMMAND: withSshDefaults(operatorSsh ? operatorSsh : "ssh"),
  };
}

export interface NetGitOpts {
  cwd?: string;
  maxBuffer?: number;
  /** argv form (#1005): `cmd` is the executable, `argv` its arguments. */
  argv?: string[];
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
  const timeoutMs = netGitTimeoutMs();
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
        env: netGitEnv(),
        ...(opts.argv ? { argv: opts.argv } : {}),
      }),
      deadline,
    ]);
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}
