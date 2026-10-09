/**
 * Pi binary resolution — issue #1019 (Headless S3), hardened in #1038.
 *
 * Resolves the pi binary explicitly instead of trusting bare `pi` on PATH.
 * Resolution order (outside a Pi process):
 *   1. PI_ENSEMBLE_PI_BIN env var (must be an existing executable, else fail)
 *   2. The bin of the locally installed @earendil-works/pi-coding-agent package
 *   3. `pi` on PATH (always warns, once per process, at resolution time)
 *
 * Setting PI_ENSEMBLE_PI_BIN executes THAT binary as the child pi — the
 * X_OK check below validates usability only, never trust. Use it for an
 * install you intend to run; it is not an integrity gate.
 *
 * Inside a Pi process (argv[1] matches the Pi CLI path), the existing
 * argv[1] reuse stays first — no behaviour change for interactive sessions.
 *
 * The path + source resolve synchronously and are cached per process. The
 * `pi --version` probe lives in pi-version-probe.ts (async, never on a spawn path).
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
 * package. Returns the absolute path to the CLI entry, or null when the package
 * is not installed or the bin escapes the package directory (checked on REALPATHS,
 * so a symlink inside the package pointing outside is rejected). Never throws.
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
    if (!existsSync(binPath)) return null;
    // A bin escaping the package directory is a hostile or broken package.json,
    // or a symlink planted inside it — never execute it (traced so the skip is auditable).
    const realBin = realpathSync(binPath);
    const realPkgDir = realpathSync(pkgDir);
    if (!realBin.startsWith(realPkgDir + path.sep)) {
      trace(
        `pi-binary-resolve: package bin ${binPath} (real: ${realBin}) resolves outside the package directory — rejected`,
      );
      return null;
    }
    // Verify executable bit
    accessSync(binPath, constants.X_OK);
    return binPath;
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
  return path.resolve(import.meta.dirname, "..", "package.json");
}

// ---------------------------------------------------------------------------
// Synchronous resolution (cached per process)
// ---------------------------------------------------------------------------

export interface SyncResolution {
  path: string;
  source: PiBinSource;
  /** The executable to invoke (process.execPath when source is argv). */
  command: string;
  /** The script argument (when source is argv) or undefined. */
  script?: string;
}

let cachedSync: SyncResolution | null = null;

/**
 * Resolve the pi binary path and source synchronously. Cached per process.
 *
 * Resolution order:
 *   - Inside a Pi process: argv[1] (existing behaviour, unchanged)
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
   * When this code runs inside a pi process (the extension is loaded), argv[1]
   * is Pi's CLI entry script and we re-invoke the SAME pi build. When it runs
   * outside Pi (smoke tests under `bun run`), argv[1] is the test file — only
   * trust argv[1] when it looks like a Pi CLI entrypoint.
   */

  // 1. Pi process: argv[1] is the Pi CLI entrypoint.
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
  const pkgBin = resolvePackageBin();
  if (pkgBin) {
    cachedSync = { path: pkgBin, source: "package", command: pkgBin };
    return cachedSync;
  }

  // 4. PATH fallback. Warned here, once per process (cachedSync guards repeats),
  // so it is visible even if the async version probe never completes.
  console.warn(
    "[pi-rukas] pi-binary-resolve: WARNING — pi resolved from PATH, no integrity check performed",
  );
  cachedSync = { path: "pi", source: "path", command: "pi" };
  return cachedSync;
}

/**
 * Reset the synchronous resolution cache. Exported for tests only.
 * Probe state is reset by _resetPiVersionProbe in pi-version-probe.ts.
 */
export function _resetPiBinaryCache(): void {
  cachedSync = null;
}

// ---------------------------------------------------------------------------
// Backward-compatible getPiInvocation
// ---------------------------------------------------------------------------

/**
 * Resolve the pi binary for spawning, backed by the explicit resolution order
 * (argv → env → package → path). No behaviour change for children spawned from
 * an interactive Pi session (source === "argv").
 */
export function getPiInvocation(args: string[]): { command: string; args: string[] } {
  const resolved = resolvePiBinarySync();
  if (resolved.source === "argv" && resolved.script) {
    return { command: resolved.command, args: [resolved.script, ...args] };
  }
  return { command: resolved.command, args };
}
