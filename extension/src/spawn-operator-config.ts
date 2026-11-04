/**
 * spawn-operator-config — restore the operator's global git and gh config if a
 * spawned child changed it.
 *
 * A child's bash is not read-only (AGENTS.md §3), and a redirect to an absolute
 * path is invisible to the bash write fence (`write-fence-deps.ts`): a reviewer
 * child replaced the operator's `~/.gitconfig` and created a per-user git config
 * with one `printf`, which took the host's HTTPS pushes down until a manual
 * restore. Relocating the child's HOME would not help — an absolute path defeats
 * it, and moving HOME/XDG breaks gh auth, Pi's agent dir, skills and the vipune
 * cache. So the four files that carry the operator's git identity and gh
 * credentials are snapshotted before the child spawns and verified when it ends:
 * any change is restored from the snapshot and reported. A child cannot leave
 * the operator's identity or credential helper altered.
 *
 * Git excludes/ignore files are deliberately not protected — they carry neither
 * identity nor credentials.
 *
 * Concurrency is accepted rather than prevented: two overlapping children share
 * one snapshot set, so whichever ends first restores the other's in-flight
 * bytes. That is why every line says "during the <role> run" and names the
 * path — the warn is the attribution, and it is disclosure only: `ok`,
 * `loopOutcome` and the adversarial/lens verdicts are untouched, since the
 * restore already happened. A legitimate operator edit made while a child runs
 * is reverted by the same rule; the line names the file.
 *
 * Reads are whole local config files (kilobytes), so no timeout machinery sits
 * on them. A read that fails for any reason other than ENOENT is reported once
 * as `cannot snapshot` and that path is then never treated as a child write —
 * an unreadable file is never evidence of a change.
 */

import { readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { traceWarn } from "./trace.ts";
import type { DispatchResult } from "./types.ts";

/** A process environment shaped enough to resolve the protected paths from. */
export type OperatorConfigEnv = Record<string, string | undefined>;

/** One protected file and the bytes it held before the child ran; null means it did not exist. */
type Snapshot = { path: string; bytes: Buffer | null };

/** `${XDG_CONFIG_HOME:-$HOME/.config}` — the XDG base directory git and gh both honour. */
function configHome(env: OperatorConfigEnv): string {
  const xdg = env.XDG_CONFIG_HOME;
  if (xdg !== undefined && path.isAbsolute(xdg)) return xdg;
  return path.join(homeDir(env), ".config");
}

/**
 * The operator's home, resolved from the live environment the way a shell does.
 * `os.homedir()` is the fallback only when HOME is absent or not absolute: Bun
 * snapshots HOME inside `os.homedir()` at process start, so a value read from
 * there is the home the process was launched with rather than the current one
 * (the same rule `write-fence-path.ts`'s `homeDir()` states).
 */
function homeDir(env: OperatorConfigEnv): string {
  const home = env.HOME;
  return home !== undefined && path.isAbsolute(home) ? home : os.homedir();
}

/** The config root gh resolves — gh's own documented order, not ours. */
function ghConfigDir(env: OperatorConfigEnv): string {
  const gh = env.GH_CONFIG_DIR;
  if (gh !== undefined && gh !== "") return gh;
  return path.join(configHome(env), "gh");
}

/**
 * The files whose contents a child must not leave changed, resolved from `env`
 * at CALL time — never latched at module load, so a test (or a caller) that
 * points HOME / XDG_CONFIG_HOME / GH_CONFIG_DIR at a sentinel tree points the
 * guard there too.
 */
export function protectedPaths(env: OperatorConfigEnv = process.env): string[] {
  const gitHome = path.join(configHome(env), "git");
  const gh = ghConfigDir(env);
  return [
    path.join(homeDir(env), ".gitconfig"),
    path.join(gitHome, "config"),
    path.join(gh, "config.yml"),
    path.join(gh, "hosts.yml"),
  ];
}

/** Read one path. `undefined` = not snapshotted (unreadable); null = absent; a Buffer = its bytes. */
async function readSnapshot(target: string): Promise<Buffer | null | undefined> {
  try {
    return await readFile(target);
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    // Absent is a state the guard can put back by deleting; anything else is a
    // file the guard has no baseline for, so it must not become a "change".
    if (code === "ENOENT") return null;
    traceWarn(`operator-config: cannot snapshot ${target} (${code ?? "unknown"})`);
    return undefined;
  }
}

/** Put one path back; returns the errno code when even that failed. */
async function restoreOne(target: string, bytes: Buffer | null): Promise<string | undefined> {
  try {
    if (bytes === null) await rm(target, { force: true });
    else await writeFile(target, bytes);
    return undefined;
  } catch (err) {
    return (err as NodeJS.ErrnoException).code ?? "unknown";
  }
}

/** Bytes changed (including appearing or disappearing) relative to the snapshot. */
function differsFrom(snap: Buffer | null, now: Buffer | null | undefined): boolean {
  if (now === undefined) return false;
  if (now === null) return snap !== null;
  return snap === null || !now.equals(snap);
}

/**
 * Run `runChild` with the operator's git/gh config guarded: snapshot the
 * protected files first, and in a `finally` — whatever ended the child, a
 * spawn throw, an abort, a cap kill — restore any file it changed and record a
 * line per change on the result as `operatorConfig`.
 *
 * The callback is invoked exactly once and never retried, so one snapshot set
 * belongs to one child. The result object is annotated in place (spawn builds
 * it fresh per dispatch, so nothing shares it); a callback whose value is not a
 * `DispatchResult` — the resume reattach returns its own shape — simply reports
 * its violations through the `traceWarn` channel, which is what that path
 * relies on since it builds no report to attach them to.
 */
export async function withOperatorConfigGuard<R>(
  role: string,
  runChild: () => Promise<R>,
): Promise<R> {
  const snapshots: Snapshot[] = [];
  for (const target of protectedPaths()) {
    const bytes = await readSnapshot(target);
    if (bytes !== undefined) snapshots.push({ path: target, bytes });
  }
  let result: R | null = null;
  try {
    result = await runChild();
    return result;
  } finally {
    const violations: string[] = [];
    for (const snap of snapshots) {
      const now = await readSnapshot(snap.path);
      if (!differsFrom(snap.bytes, now)) continue;
      const code = await restoreOne(snap.path, snap.bytes);
      violations.push(
        code === undefined
          ? `operator-config: ${snap.path} modified during the ${role} run — restored`
          : `operator-config: ${snap.path} modified during the ${role} run — NOT restored (${code})`,
      );
    }
    for (const line of violations) traceWarn(line);
    // Disclosure, never a verdict: `ok` and `loopOutcome` are left exactly as
    // the child's own run set them.
    if (violations.length > 0 && result !== null && isDispatchResult(result)) {
      result.operatorConfig = violations;
    }
  }
}

/** Only a plain result object can carry the disclosure; the reattach's shape cannot. */
function isDispatchResult(value: unknown): value is DispatchResult {
  return typeof value === "object" && value !== null && "ok" in value && "text" in value;
}
