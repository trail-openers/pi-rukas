/**
 * work-driver-plan-unfence-git — #1167: the two git reads the unfence pass makes.
 *
 * Split out of work-driver-plan-unfence.ts for the AGENTS.md §12 line cap. One
 * job, and it is the job with the failure mode worth reading carefully: both
 * reads distinguish "the repo answered no" from "the repo did not answer", and
 * the pass unfences on the difference — so an infra failure that reads as a
 * clean negative would silently leave a fence in place, or remove one nothing
 * justified.
 *
 * `UnfenceExecFn` is the argv-form seam shared with the pass: the issue body is
 * untrusted prose, so the name and the path are DATA in an argv array and never
 * shell text.
 */

import { trace } from "./trace.ts";
import type { UnfenceExecFn } from "./work-driver-plan-unfence.ts";

/**
 * One `git show <ref>:<file>`; argv form, so the path is data, never shell.
 * `maxBuffer` and `timeout` are explicit (#1167 round-3): the default Node
 * buffer is 1 MB and `git show` of any file larger than that rejects, so a
 * big source file would have read as "no definition here" rather than as the
 * unreadable candidate it is.
 */
const GIT_TIMEOUT_MS = 15_000;
const GIT_MAX_BUFFER = 8 * 1024 * 1024;

export async function readAtRef(
  file: string,
  execFn: UnfenceExecFn,
  repoRoot: string,
  ref: string,
): Promise<string> {
  const { stdout } = await execFn("git", {
    argv: ["show", `${ref}:${file}`],
    cwd: repoRoot,
    timeout: GIT_TIMEOUT_MS,
    maxBuffer: GIT_MAX_BUFFER,
  });
  return stdout;
}

/**
 * One `git grep -l -w` at the base ref; argv form — the name is data, not shell.
 *
 * #1167 round-3 — `git grep` exits **1 with empty output when nothing
 * matches**, and that is the only failure allowed to mean "no file". Any other
 * outcome (non-zero with stderr, a timeout, an exit 1 that carried output) is
 * an infra failure and must not read as "this symbol is defined nowhere":
 * the caller treats it as unresolved and records a warning, because a silent
 * empty list is indistinguishable from a repo in which the name is genuinely
 * absent — and the pass unfences on the difference. `git grep` exits 0 on a
 * match and 1 with no output on no match, so `code === 1` with clean output is
 * the sole negative answer; anything else throws.
 */
export async function definingFiles(
  name: string,
  execFn: UnfenceExecFn,
  repoRoot: string,
  ref: string,
): Promise<string[]> {
  let stdout = "";
  try {
    const r = await execFn("git", {
      argv: ["grep", "-l", "-z", "-w", "-e", name, ref, "--"],
      cwd: repoRoot,
      timeout: GIT_TIMEOUT_MS,
      maxBuffer: GIT_MAX_BUFFER,
    });
    stdout = r.stdout ?? "";
    // An executor that reports an exit code alongside its result reports a
    // failure, not a match list — except exit 1, `git grep`'s own "nothing
    // matched", which is a real negative answer only when it carried nothing.
    const code = (r as { code?: number }).code;
    if (code !== undefined && code !== 0 && !(code === 1 && stdout.trim().length === 0)) {
      throw new Error(`git grep exited ${code}`);
    }
  } catch (err) {
    // A THROWN error is a failure unless it is exactly exit-1-with-empty-
    // stdout: the real executor (`execp` → `execFile`) throws for `git grep`'s
    // no-match too, and the error carries `code: 1` and `stdout: ""`. A
    // broken ref or a non-repo is also exit 1-adjacent but has stderr and a
    // 128 code, so it propagates: the caller records the name as unresolved
    // rather than letting a repo-wide git failure read as "defined nowhere".
    if (!isGitGrepNoMatch(err)) throw err;
    return [];
  }
  // #1642 — `git grep <ref>` prints `<ref>:<path>` lines, and the caller hands
  // each one to `readAtRef`, which adds the ref itself. Left in place the prefix
  // doubled (`git show HEAD:HEAD:<path>`), every read failed, and every fence the
  // pass was meant to lift stayed. Strip it here, once, so a path is a path.
  // `-z` ends each name with NUL, so a name with a space or a newline is data,
  // not a separator, and git does not quote it. No trim: a name may begin or
  // end with a space.
  const prefix = `${ref}:`;
  return stdout
    .split("\0")
    .filter((l) => l.length > 0)
    .map((l) => {
      if (l.startsWith(prefix)) return l.slice(prefix.length);
      // Not a shape `git grep <ref>` prints. Kept as-is (the read will fail and
      // be recorded there), but traced so the operator can see the shape changed.
      trace(
        `work-driver: plan unfence — git grep entry without the ${prefix} prefix kept as-is: ${l}`,
      );
      return l;
    });
}

/**
 * True when a thrown error is `git grep`'s own "no match" report and nothing
 * else: exit code **1**, **empty stdout**, and no sign of a kill, a missing
 * binary, a broken ref or a buffer overflow. The three signals are read from
 * the error OBJECT first (what `execFile` attaches) and from its message
 * second, so a stub executor that merely throws `new Error("git grep exited
 * 1")` — no code, no stdout field — is NOT mistaken for "the name is defined
 * nowhere": that reading needs positive evidence of emptiness, not its
 * absence.
 */
export function isGitGrepNoMatch(err: unknown): boolean {
  const e = err as { code?: number; exitCode?: number; stdout?: unknown; message?: string };
  const code = e?.code ?? e?.exitCode;
  const message = typeof e?.message === "string" ? e.message : String(err ?? "");
  if (/killed|ENOENT|ETIMEOUT|maxBuffer|AbortError/i.test(message)) return false;
  // An executor that attached no code at all has not evidenced exit 1; a bare
  // "exited 1" in prose is what a stub writes and is not the same claim.
  if (typeof code !== "number") return false;
  if (code !== 1) return false;
  if (typeof e.stdout === "string" && e.stdout.trim().length > 0) return false;
  return true;
}
