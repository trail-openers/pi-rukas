/**
 * work-driver-verify-report-path — #1404: where the out-of-band verify verdict
 * lives, and what the driver is willing to do with it.
 *
 * The commit-pr baseline probe reads failing-test names ONLY from a file the
 * smoke loop writes itself (extension/smoke-tests/lib/verify-report-file.sh),
 * because names parsed out of the run's stdout/stderr are a string any test can
 * print — see `work-driver-verify-report-file.ts` for the forgery this closes.
 * This module owns the other half of that channel: the path, its permissions,
 * and the environment variable that names it.
 *
 * The path is NOT derived from anything the project controls. `.pi/verify-cmd`
 * is a project file, so a path taken from it (or from the verify command's
 * text) would let the project point the driver's reader at a file a test
 * wrote — which is the forgery again, wearing a legitimate hat. The directory
 * is a private temp dir the driver creates (0700) and the file name is random,
 * so:
 *
 *   - a test cannot guess the path (and cannot learn it anyway — the loop
 *     scrubs `VERIFY_REPORT_FILE` from every child's environment), and
 *   - a project cannot steer the reader to a file of its choosing.
 *
 * The variable name is deliberately NOT a `PI_ENSEMBLE_*` name. Every such
 * variable is a documented host input (`headless/inputs.ts`), which is the
 * wrong shape for this one: a host-settable report path is exactly the
 * steering the paragraph above refuses. It is a private contract between this
 * process and the smoke loop it spawns, so it is named for what it is.
 */

import {
  constants,
  chmodSync,
  closeSync,
  fstatSync,
  mkdtempSync,
  openSync,
  realpathSync,
  rmSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

/**
 * The environment variable that carries the report path to the smoke loop.
 * Read by `lib/verify-report-file.sh` and scrubbed from every test child by
 * `lib/verify-kill.sh`.
 */
export const VERIFY_REPORT_FILE_ENV = "VERIFY_REPORT_FILE";

/**
 * Create the driver's private report directory: a fresh temp dir, mode 0700.
 *
 * `mkdtemp` already creates 0700; the explicit `chmod` is not decoration — it
 * pins the mode against a restrictive umask having made it MORE open than the
 * contract wants, and it is the assertion that the directory exists (a chmod
 * on a vanished path throws here rather than at the first write).
 */
export function createVerifyReportDir(prefix = "pi-verify-report-"): string {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  chmodSync(dir, 0o700);
  return dir;
}

/**
 * Create one report file inside `dir` and return its absolute path.
 *
 * Created here, by the driver, empty and 0600 — the loop then writes it. The
 * driver creating the file (rather than letting the loop create it) is what
 * makes "the file exists but is empty" a distinguishable state from "nothing
 * was ever written": a 0-byte file is a run that reached no report half, and
 * `readVerifyReport` reads that as unattributable rather than as an all-pass.
 *
 * `O_EXCL` refuses a path that already exists. In a fresh 0700 temp dir that
 * cannot happen by accident, and that is the point: if it ever did, a
 * same-user attacker who had planted a file at the name would have the driver
 * reading it.
 */
export function createVerifyReportFile(dir: string, label: string): string {
  const safe = label.replace(/[^A-Za-z0-9_.-]/g, "-");
  const path = join(dir, `report-${safe}-${Math.random().toString(36).slice(2, 10)}.txt`);
  const nofollow = typeof constants.O_NOFOLLOW === "number" ? constants.O_NOFOLLOW : 0;
  const fd = openSync(
    path,
    constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | nofollow,
    0o600,
  );
  try {
    closeSync(fd);
  } catch {
    // Nothing to flush; the descriptor is closed or already gone.
  }
  return path;
}

/**
 * Whether `path` sits inside `dir`, resolved through symlinks on both sides.
 *
 * The reader uses this before trusting a path it was handed: the driver built
 * the path under `dir`, and a path that resolves outside it is not the file the
 * driver created, whatever string it started as.
 */
export function isInsideReportDir(path: string, dir: string): boolean {
  const resolvedDir = resolveExisting(dir);
  const resolvedPath = resolveExisting(path);
  if (resolvedDir === "" || resolvedPath === "") return false;
  return resolvedPath === resolvedDir || resolvedPath.startsWith(`${resolvedDir}/`);
}

/**
 * Resolve a path through symlinks as far as the filesystem allows, falling back
 * to the plain spelling for the not-yet-existing tail. A report file the loop
 * has not written yet has an existing parent and a non-existent basename, so a
 * whole-path `realpath` would throw and the caller would read that as "outside
 * the dir" — a park on a path the driver itself built.
 */
function resolveExisting(path: string): string {
  try {
    return getRealpathSync(path);
  } catch {
    // Fall back to the longest existing prefix, the same rule the name
    // comparison in work-driver-verify-names.ts uses for the same reason.
  }
  const parts = path.replace(/\\/g, "/").split("/");
  for (let i = parts.length; i >= 1; i--) {
    const head = parts.slice(0, i).join("/");
    if (head === "") continue;
    try {
      const real = getRealpathSync(head);
      const rest = parts.slice(i).filter((p) => p.length > 0);
      const base = real.endsWith("/") ? real.slice(0, -1) : real;
      return rest.length === 0 ? base : `${base}/${rest.join("/")}`;
    } catch {
      // Shorten and try again.
    }
  }
  return "";
}

// Resolve through the filesystem, with the whole-path call split out so the
// containment check has one named dependency a test can reason about.
function getRealpathSync(path: string): string {
  return realpathSync(path);
}

/**
 * Remove the driver's private report directory. Best-effort: the OS reaps
 * `TMPDIR`, and a failed removal must never change a verify verdict. The mode
 * is restored before the recursive removal so a 0400 report file inside a 0700
 * directory can actually be unlinked on the way out.
 */
export function removeVerifyReportDir(dir: string): void {
  try {
    rmSync(dir, { recursive: true, force: true });
  } catch {
    // A leak under TMPDIR costs disk, never correctness.
  }
}

/**
 * The env an exec of the project's verify command must carry: the ambient env
 * plus `VERIFY_REPORT_FILE` pointing at `path`. Kept in one place so every run
 * that is meant to produce a report produces it the same way, and so the
 * scrubbing guarantee (children of the LOOP never see it) is the loop's
 * business, not something each call site re-implements.
 */
export function verifyReportEnv(base: NodeJS.ProcessEnv, path: string): NodeJS.ProcessEnv {
  return { ...base, [VERIFY_REPORT_FILE_ENV]: path };
}

/**
 * Whether `path` is a regular file the reader may open. A directory, a FIFO or
 * a device at the report path is not a report; reading one would block or hang
 * the driver on something the loop never writes.
 */
export function isRegularReportFile(path: string): boolean {
  const nofollow = typeof constants.O_NOFOLLOW === "number" ? constants.O_NOFOLLOW : 0;
  let fd: number;
  try {
    fd = openSync(path, constants.O_RDONLY | nofollow);
  } catch {
    return false;
  }
  try {
    return fstatSync(fd).isFile();
  } catch {
    return false;
  } finally {
    try {
      closeSync(fd);
    } catch {
      // Already gone.
    }
  }
}
