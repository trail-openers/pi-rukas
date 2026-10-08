/**
 * Pi binary resolution — issue #1019 (Headless S3).
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
 */

import { spawn as cpSpawn } from "node:child_process";
import { constants, accessSync, existsSync, readFileSync } from "node:fs";
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
 * Returns the resolved absolute path to the CLI entry, or null when the
 * package is not installed. Never throws.
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
    const binPath = path.resolve(path.dirname(packageJsonPath), binEntry);
    if (!existsSync(binPath)) return null;
    // A bin entry escaping the package directory is a hostile or broken
    // package.json — never execute it (traced so the skip is auditable).
    const pkgDir = path.dirname(packageJsonPath);
    if (!binPath.startsWith(pkgDir + path.sep)) {
      trace(
        `pi-binary-resolve: package bin ${binPath} resolves outside the package directory — rejected`,
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

// Memoized resolvePackageBin() result (the default-package branch). The
// injected-path overload is deliberately unmemoized — tests call it with
// fixture paths and must not see a cached default.
let defaultPackageBinCache: string | null | undefined;

/**
 * Resolve the pi binary path and source synchronously. Cached per process.
 *
 * Resolution order:
 *   - Inside a Pi process: argv[1] (existing behaviour, unchanged)
 *   - PI_ENSEMBLE_PI_BIN (fails with a named error if invalid)
 *   - Package bin (silently skipped if not installed)
 *   - PATH fallback
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
      if (!existsSync(envBin)) {
        throw new Error("not found");
      }
    } catch {
      throw new Error(
        `PI_ENSEMBLE_PI_BIN is set to "${envBin}" but it is not an existing executable. Fix or unset the env var. Never falling through to other resolution branches.`,
      );
    }
    cachedSync = { path: envBin, source: "env", command: envBin };
    return cachedSync;
  }

  // 3. Package bin — silently skip if not installed. Memoized per process.
  if (defaultPackageBinCache === undefined) {
    defaultPackageBinCache = resolvePackageBin();
  }
  const pkgBin = defaultPackageBinCache;
  if (pkgBin) {
    cachedSync = { path: pkgBin, source: "package", command: pkgBin };
    return cachedSync;
  }

  // 4. PATH fallback.
  cachedSync = { path: "pi", source: "path", command: "pi" };
  return cachedSync;
}

/**
 * Reset the process-level cache. Exported for tests only.
 */
export function _resetPiBinaryCache(): void {
  cachedSync = null;
  versionPromise = null;
  defaultPackageBinCache = undefined;
}

// ---------------------------------------------------------------------------
// Async version probe (cached, 3 s timeout)
// ---------------------------------------------------------------------------

let versionPromise: Promise<{ version: string | null; probeTimedOut?: boolean }> | null = null;

/**
 * Run `pi --version` on the resolved binary and cache the result.
 * Times out after 3 s (returns version: null, probeTimedOut: true).
 * Never throws — unparseable output yields version: null.
 */
export function probePiVersion(): Promise<{ version: string | null; probeTimedOut?: boolean }> {
  if (versionPromise) return versionPromise;

  versionPromise = new Promise((resolve) => {
    const resolved = cachedSync ?? resolvePiBinarySync();
    const spawnArgs = resolved.script ? [resolved.script, "--version"] : ["--version"];

    const child = cpSpawn(resolved.command, spawnArgs, {
      stdio: ["ignore", "pipe", "pipe"],
      shell: false,
    });

    let stdout = "";
    let stdoutBytes = 0;
    let settled = false;

    const timer = setTimeout(() => {
      if (!settled) {
        settled = true;
        // Destroy the pipes in addition to killing the process: a grandchild
        // that keeps the write ends open would otherwise pin the process
        // handle (and our buffered stdout) past the kill.
        child.kill("SIGKILL");
        child.stdout?.destroy();
        child.stderr?.destroy();
        resolve({ version: null, probeTimedOut: true });
      }
    }, 3000);

    child.stdout?.on("data", (d: Buffer) => {
      // Cap the accumulator — `pi --version` prints one short line, anything
      // larger is not a version and is not worth retaining in memory.
      if (stdoutBytes < 4096) {
        stdout += d.toString("utf8");
        stdoutBytes += d.length;
      }
    });

    child.on("error", () => {
      if (!settled) {
        settled = true;
        clearTimeout(timer);
        resolve({ version: null });
      }
    });

    child.on("close", () => {
      if (!settled) {
        settled = true;
        clearTimeout(timer);
        resolve({ version: parsePiVersion(stdout) });
      }
    });
  });

  return versionPromise;
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Get the full pi binary resolution info (path, source, version).
 *
 * The path and source are resolved synchronously (cached). The version probe
 * runs asynchronously once and is cached, and it can wait up to 3 s (its
 * timeout) before resolving.
 *
 * ⚠ Spawn paths must NEVER await this. `spawnSpecialist` resolves the binary
 * with `resolvePiBinarySync()` only (zero I/O beyond the cached resolution) —
 * the probe exists to surface the PATH-source / older-than-verified warnings,
 * which the first spawn of a process triggers fire-and-forget. Awaiting here
 * would hold the spawn path for up to 3 s against a hung `--version` probe.
 *
 * Emits a single trace line with the resolved path, source, and version.
 * Warns (trace) when:
 *   - source is "path" (always)
 *   - version is older than the "Last verified against pi X.Y.Z" line
 */
export async function getPiResolutionInfo(): Promise<PiBinaryResolution> {
  const sync = resolvePiBinarySync();
  const probe = await probePiVersion();

  const result: PiBinaryResolution = {
    path: sync.path,
    source: sync.source,
    version: probe.version,
    ...(probe.probeTimedOut ? { probeTimedOut: true } : {}),
  };

  // Emit trace + warnings once (trace is a no-op when PI_ENSEMBLE_DEBUG≠1).
  const versionStr = result.version ?? (probe.probeTimedOut ? "(probe timed out)" : "unknown");
  trace(`pi-binary-resolve: path=${result.path} source=${result.source} version=${versionStr}`);

  if (result.source === "path") {
    // The PATH-source warning is operational, not a debug detail — a hijacked
    // or mismatched `pi` on PATH should be visible without PI_ENSEMBLE_DEBUG=1.
    console.warn(
      "[pi-rukas] pi-binary-resolve: WARNING — pi resolved from PATH, no integrity check performed",
    );
    trace("pi-binary-resolve: WARNING — resolved from PATH, no integrity check performed");
  }

  // Version warning: compare against the "Last verified against pi X.Y.Z" line.
  if (result.version) {
    const verified = getVerifiedVersion();
    if (verified && isVersionOlder(result.version, verified)) {
      trace(
        `pi-binary-resolve: WARNING — pi version ${result.version} is older than the verified version ${verified} (docs/pi-compatibility.md)`,
      );
    }
  }

  return result;
}

// ---------------------------------------------------------------------------
// Version comparison + verified-line parsing
// ---------------------------------------------------------------------------

/**
 * Compare two semver-like strings. Returns true when `a` is older than `b`.
 * Only the major.minor.patch numeric prefix is compared; pre-release/build
 * suffixes (e.g. "2.1.3-beta.1") are ignored.
 */
export function isVersionOlder(a: string, b: string): boolean {
  const pa = a.match(/^(\d+)\.(\d+)(?:\.(\d+))?/);
  const pb = b.match(/^(\d+)\.(\d+)(?:\.(\d+))?/);
  if (!pa || !pb) return false;
  const amaj = Number(pa[1]);
  const amin = Number(pa[2]);
  const apar = Number(pa[3] ?? "0");
  const bmaj = Number(pb[1]);
  const bmin = Number(pb[2]);
  const bpar = Number(pb[3] ?? "0");
  if (amaj !== bmaj) return amaj < bmaj;
  if (amin !== bmin) return amin < bmin;
  return apar < bpar;
}

let verifiedVersionCache: string | null | undefined;

/**
 * Read the "Last verified against pi X.Y.Z" version from docs/pi-compatibility.md.
 * Uses the shared parseVerifiedLine parser (single source, also used by
 * test-pi-version-drift.ts).
 * Returns null when the file or line is not found.
 */
function getVerifiedVersion(): string | null {
  if (verifiedVersionCache !== undefined) return verifiedVersionCache;
  try {
    const compatPath = path.resolve(import.meta.dirname, "..", "..", "docs", "pi-compatibility.md");
    const doc = readFileSync(compatPath, "utf8");
    verifiedVersionCache = parseVerifiedLine(doc)?.version ?? null;
  } catch {
    verifiedVersionCache = null;
  }
  return verifiedVersionCache;
}

// ---------------------------------------------------------------------------
// Shared "Last verified against pi X.Y.Z (YYYY-MM-DD)" parser
// ---------------------------------------------------------------------------

/**
 * Parse the maintained "## Last verified against pi X.Y.Z (YYYY-MM-DD)" line
 * from docs/pi-compatibility.md content. Single source of the regex — also
 * imported by smoke-tests/test-pi-version-drift.ts so the two can never drift.
 */
export function parseVerifiedLine(doc: string): { version: string; date: string } | null {
  const m = doc.match(
    /## Last verified against pi\s+([0-9][0-9a-z.+-]*)\s+\((\d{4}-\d{2}-\d{2})\)/,
  );
  if (!m) return null;
  return { version: m[1] as string, date: m[2] as string };
}

/**
 * Reset the verified-version cache. Exported for tests only.
 */
export function _resetVerifiedVersionCache(): void {
  verifiedVersionCache = undefined;
}

// ---------------------------------------------------------------------------
// Backward-compatible getPiInvocation
// ---------------------------------------------------------------------------

/**
 * Resolve the pi binary for spawning. Same interface as the old
 * getPiInvocation in spawn-support.ts, but now backed by the explicit
 * resolution order (argv → env → package → path).
 *
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
