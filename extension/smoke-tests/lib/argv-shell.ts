/**
 * #1016 — test seam for the argv form of `ExecFn`. Production git calls pass
 * `execFn("git", { argv })`, but the stubs in these smoke tests match the
 * command STRING (`cmd.startsWith("git status")`) and the real `/bin/sh`
 * fixture ignores `argv`. `asShellForm` wraps such an exec so it sees the
 * familiar `cmd` string: the executable plus its argv, each argument
 * shell-quoted only when it contains characters outside a safe set. The
 * assertions are unchanged; only the transport form the stub sees differs.
 */

type AnyExec = (cmd: string, o?: any) => Promise<any>;

const SAFE = /^[A-Za-z0-9_@%+=:,./^~-]+$/;

/** Join an executable and its argv into one shell-form command line. */
export function shellJoin(parts: string[]): string {
  return parts
    .map((p) => (p === "" || !SAFE.test(p) ? `'${p.replace(/'/g, `'\\''`)}'` : p))
    .join(" ");
}

/** Wrap an exec so an `argv` call reaches it as a shell-form command string. */
export function asShellForm<T extends AnyExec>(exec: T): T {
  return (async (cmd: string, o?: any) => {
    if (!o?.argv) return exec(cmd, o);
    const { argv, ...rest } = o;
    return exec(shellJoin([cmd, ...argv]), rest);
  }) as unknown as T;
}

/** The shell-form command line a stub should match: `cmd` plus its argv, if any. */
export function commandOf(cmd: string, o?: { argv?: string[] }): string {
  return o?.argv ? shellJoin([cmd, ...o.argv]) : cmd;
}
