/**
 * Pi binary resolution — issue #1019 (Headless S3), hardened in #1038.
 *
 * Resolves the pi binary explicitly instead of trusting bare `pi` on PATH.
 * Resolution order (outside a Pi process):
 *   1. PI_ENSEMBLE_PI_BIN env var (must be an existing executable, else fail)
 *   2. The bin of the locally installed @earendil-works/pi-coding-agent package
 *   3. `pi` on PATH (always warns)
 *
 * Setting PI_ENSEMBLE_PI_BIN executes THAT binary as the child pi — the
 * X_OK check below validates usability only, never trust. Use it for an
 * install you intend to run; it is not an integrity gate.
 *
 * Inside a Pi process (argv[1] matches the Pi CLI path), the existing
 * argv[1] reuse stays first — no behaviour change for interactive sessions.
 *
 * The path + source resolve synchronously and are cached per process.
 * The `pi --version` probe is async, runs once, is cached, times out after
 * 3 s (version null, probeTimedOut: true), and never blocks a spawn.
 *
 * A package bin whose realpath escapes the package directory (e.g. a hoisted
 * bin symlinked outside it) is rejected and falls through to PATH. A broken
 * symlink is skipped with a trace, like the escape case.
 */

import { constants, accessSync, existsSync, readFileSync, realpathSync } from "node:fs";
import path from "node:path";
import { trace } from "./trace.ts";

export type PiBinSource = "env" | "package" | "path" | "argv";

export interface PiBinaryResolution {
  /** The resolved binary path (or "pi" for the PATH fallback). */
  path: string;
  /** Where the resolution came from. */
  source: PiBinSource;
  /** Parsed version string from `pi --version`, or null if unavailable. */
  version: string | null;
  /** True when the --version probe timed out (3 s). */
  probeTimedOut?: boolean;
}

/** The unified Pi CLI path pattern. Replaces the three divergent regexes. */
const PI_CLI_PATTERN = /pi-coding-agent.*\/(dist\/)?cli\.(js|cjs|mjs)$/i;

/**
 * Test whether a path looks like the Pi CLI entrypoint script.
 * Shared by spawn and resume-reattach to eliminate the regex divergence.
 */
export function looksLikePiCli(script: string | undefined): boolean {
  if (!script) return false;
  if (script.startsWith("/$bunfs/")) return false;
  return PI_CLI_PATTERN.test(script);
}

/**
 * Parse a `pi --version` output string. Handles "pi 1.0.0", "1.0.0", etc.
 * Returns null when no semver is found.
 */
export function parsePiVersion(output: string): string | null {
  const m = output.match(/(\d+\.\d+[\d.]*(?:-[\w.]+)?(?:\+[\w.]+)?)/);
  return m ? (m[1] as string) : null;
}

// ---------------------------------------------------------------------------
// Package-bin resolution (option 2 in the resolution order)
// ---------------------------------------------------------------------------

/**
 * Resolve the bin of the locally installed @earendil-works/pi-coding-agent
 * package. Uses fs directly (no require.resolve) so it's testable in isolation
 * via the injected packageJsonPath parameter.
 *
 * Returns the resolved absolute path to the CLI entry, or null when the package
 * is not installed. Never throws.
 * Returns null when the bin's realpath escapes the package directory, so a
 * symlink inside the package pointing outside is rejected.
 */
export function resolvePackageBin(
  packageJsonPath: string = defaultPackageJsonPath(),
): string | null {
  try {
    if (!existsSync(packageJsonPath)) return null;
    const pkg = JSON.parse(readFileSync(packageJsonPath, "utf8")) as {
      bin?: string | Record<string, string>;
    };
    const binEntry = typeof pkg.bin === "string" ? pkg.bin : pkg.bin?.pi;
    if (!binEntry) return null;
    const pkgDir = path.dirname(packageJsonPath);
    const binPath = path.resolve(pkgDir, binEntry);
    // existsSync is false for a broken symlink, so realpathSync below only runs
    // on a target that exists.
    if (!existsSync(binPath)) {
      trace(`pi-binary-resolve: package bin ${binPath} missing or broken symlink — skipped`);
      return null;
    }
    // A bin entry escaping the package directory is a hostile or broken
    // package.json — never execute it (traced so the skip is auditable).
    let realBin: string;
    let realPkgDir: string;
    try {
      realBin = realpathSync(binPath);
      realPkgDir = realpathSync(pkgDir);
    } catch (err) {
      // ELOOP, EACCES, or the file vanishing between existsSync and realpathSync.
      trace(
        `pi-binary-resolve: realpath of package bin ${binPath} failed — skipped (${String(err)})`,
      );
      return null;
    }
    if (!realBin.startsWith(realPkgDir + path.sep)) {
      trace(
        `pi-binary-resolve: package bin ${binPath} (real: ${realBin}) resolves outside the package directory — rejected`,
      );
      return null;
    }
    // Check the executable bit on the checked path, and return that same path
    // so the checked and executed binaries are identical.
    accessSync(realBin, constants.X_OK);
    return realBin;
  } catch {
    return null;
  }
}

/**
 * Default package.json path — resolved relative to this module's location.
 * The extension source lives in <root>/extension/src/, so the package.json
 * is one level up from src/.
 */
function defaultPackageJsonPath(): string {
  // In ESM, import.meta.dirname gives the source file's directory.
  // The package.json is at extension/package.json (one level up from src/).
  return path.resolve(import.meta.dirname, "..", "package.json");
}

// ---------------------------------------------------------------------------
// Synchronous resolution (cached per process)
// ---------------------------------------------------------------------------

interface SyncResolution {
  path: string;
  source: PiBinSource;
  /** The executable to invoke (process.execPath when source is argv). */
  command: string;
  /** The script argument (when source is argv) or undefined. */
  script?: string;
}

let cachedSync: SyncResolution | null = null;

type WarningReporter = (message: string) => void;
let pathWarningReporter: WarningReporter = (message) => console.warn(message);

/**
 * Replace the sink for the PATH-fallback warning. Tests inject a recorder; the
 * default writes to stderr. Resolution itself never writes directly.
 */
export function setPathWarningReporter(reporter: WarningReporter): void {
  pathWarningReporter = reporter;
}

/**
 * Resolve the pi binary path and source synchronously. Cached per process;
 * a handful of stat/read syscalls per process (memoized after the first call).
 *
 * Resolution order:
 *   - Inside a Pi process: argv[1]
 *   - PI_ENSEMBLE_PI_BIN (fails with a named error if invalid)
 *   - Package bin (silently skipped if not installed)
 *   - PATH fallback (warns once per process, here at resolution time)
 *
 * @throws When PI_ENSEMBLE_PI_BIN is set but the path is not an existing
 *         executable file. Never falls through to other branches in that case.
 */
export function resolvePiBinarySync(): SyncResolution {
  if (cachedSync) return cachedSync;

  const currentScript = process.argv[1];

  /*
   * Resolve the pi binary. When this code runs inside a pi process (the
   * extension is loaded), argv[1] is Pi's CLI entry script and we re-invoke the
   * SAME pi build (avoids PATH ambiguity, matches Pi's own subagent example).
   * When this code runs outside Pi (smoke tests under `bun run`), argv[1] is the
   * test file and we'd recursively spawn ourselves — guard against that by only
   * trusting argv[1] when it looks like a Pi CLI entrypoint.
   */

  // 1. Pi process: argv[1] is the Pi CLI entrypoint.
  // Fallback order when argv[1] is not a Pi CLI entrypoint:
  // PI_ENSEMBLE_PI_BIN → package bin → PATH.
  if (looksLikePiCli(currentScript)) {
    cachedSync = {
      path: currentScript as string,
      source: "argv",
      command: process.execPath,
      script: currentScript,
    };
    return cachedSync;
  }

  // 2. PI_ENSEMBLE_PI_BIN — must be a valid executable, else fail.
  const envBin = process.env.PI_ENSEMBLE_PI_BIN;
  if (envBin) {
    try {
      accessSync(envBin, constants.X_OK);
    } catch {
      throw new Error(
        `PI_ENSEMBLE_PI_BIN is set to "${envBin}" but it is not an existing executable. Fix or unset the env var. Never falling through to other resolution branches.`,
      );
    }
    cachedSync = { path: envBin, source: "env", command: envBin };
    return cachedSync;
  }

  // 3. Package bin — silently skip if not installed.
  // (Only reached when cachedSync is null, so resolvePackageBin runs at most
  // once per process here; the injected-path overload stays unmemoized for
  // test fixture paths.)
  const pkgBin = resolvePackageBin();
  if (pkgBin) {
    cachedSync = { path: pkgBin, source: "package", command: pkgBin };
    return cachedSync;
  }

  // 4. PATH fallback.
  // The PATH-source warning is operational, not a debug detail — a hijacked
  // or mismatched `pi` on PATH should be visible without PI_ENSEMBLE_DEBUG=1.
  // Reported here, once per process (cachedSync guards repeats), so it is visible
  // even if the async version probe never completes. Not moved into the probe.
  pathWarningReporter(
    "[pi-rukas] pi-binary-resolve: WARNING — pi resolved from PATH, no integrity check performed",
  );
  cachedSync = { path: "pi", source: "path", command: "pi" };
  return cachedSync;
}

/**
 * Reset the binary-resolution cache. Internal: only pi-version-probe.ts calls it,
 * via _resetPiVersionProbe, which is the reset seam tests use.
 */
export function _resetPiBinaryCache(): void {
  cachedSync = null;
}

// ---------------------------------------------------------------------------
// Backward-compatible getPiInvocation
// ---------------------------------------------------------------------------

/**
 * Resolve the pi binary for spawning. Same interface as the old
 * getPiInvocation in spawn-support.ts, but now backed by the explicit
 * resolution order (argv → env → package → path).
 * No behaviour change for children spawned from an interactive Pi session
 * (source === "argv" → same command + args as before).
 */
export function getPiInvocation(args: string[]): { command: string; args: string[] } {
  const resolved = resolvePiBinarySync();
  if (resolved.source === "argv" && resolved.script) {
    return { command: resolved.command, args: [resolved.script, ...args] };
  }
  return { command: resolved.command, args };
}
