/**
 * Pi version probe — issue #1019, split out of pi-binary-resolve.ts (#1038).
 *
 * Runs `pi --version` on the binary resolved by resolvePiBinarySync, once per
 * process, with a 3 s timeout. Never awaited on a spawn path: kickPiResolutionProbe
 * fires it and forgets it. Warns (trace) when the resolved version is older than
 * the "Last verified against pi X.Y.Z" line in docs/pi-compatibility.md.
 *
 * Retry model (#1038): ONE-SHOT. A probe that fails to spawn is cached as
 * `{ version: null }` and reported once on stderr; it is not re-run, because the
 * failure mode is a broken binary path that a retry will not repair.
 */

import { spawn as cpSpawn } from "node:child_process";
import { readFileSync } from "node:fs";
import path from "node:path";
import {
  type PiBinaryResolution,
  parsePiVersion,
  resolvePiBinarySync,
} from "./pi-binary-resolve.ts";
import { parseVerifiedLine } from "./pi-doc-parsing.ts";
import { trace } from "./trace.ts";

type ProbeResult = { version: string | null; probeTimedOut?: boolean };

let versionPromise: Promise<ProbeResult> | null = null;
let piResolutionProbeStarted = false;
let verifiedVersionCache: string | null | undefined;

/**
 * Run `pi --version` on the resolved binary and cache the result.
 * Times out after 3 s (version: null, probeTimedOut: true).
 * Never throws — unparseable or unspawnable yields version: null.
 */
export function probePiVersion(): Promise<ProbeResult> {
  if (versionPromise) return versionPromise;

  versionPromise = new Promise((resolve) => {
    const resolved = resolvePiBinarySync();
    const spawnArgs = resolved.script ? [resolved.script, "--version"] : ["--version"];

    const child = cpSpawn(resolved.command, spawnArgs, {
      stdio: ["ignore", "pipe", "ignore"],
      shell: false,
    });

    let stdout = "";
    let stdoutBytes = 0;
    let settled = false;

    const timer = setTimeout(() => {
      if (!settled) {
        settled = true;
        // Destroy the pipes too: a grandchild holding the write ends would
        // otherwise pin the handle past the kill.
        child.kill("SIGKILL");
        child.stdout?.destroy();
        resolve({ version: null, probeTimedOut: true });
      }
    }, 3000);

    child.stdout?.on("data", (d: Buffer) => {
      // `pi --version` prints one short line; cap what we retain.
      if (stdoutBytes < 4096) {
        stdout += d.toString("utf8");
        stdoutBytes += d.length;
      }
    });

    child.on("error", (err: Error) => {
      if (!settled) {
        settled = true;
        clearTimeout(timer);
        // Operational, not debug: a binary that cannot be spawned must be visible.
        console.warn(
          `[pi-rukas] pi-version-probe: WARNING — could not run "${resolved.command}" for --version: ${err.message}`,
        );
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

/**
 * Get the full pi binary resolution info (path, source, version).
 *
 * ⚠ Spawn paths must NEVER await this — it can hold for up to 3 s against a
 * hung `--version`. Use kickPiResolutionProbe (fire-and-forget) from spawns.
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

  // The PATH-source warning is emitted once at resolution time (resolvePiBinarySync),
  // not here — this is trace only.
  const versionStr = result.version ?? (probe.probeTimedOut ? "(probe timed out)" : "unknown");
  trace(`pi-binary-resolve: path=${result.path} source=${result.source} version=${versionStr}`);

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

/**
 * Kick the version probe on first spawn (#1019). Fire-and-forget: never throws
 * into the spawn path, and a failed probe is traced rather than swallowed.
 */
export function kickPiResolutionProbe(): void {
  if (piResolutionProbeStarted) return;
  piResolutionProbeStarted = true;
  try {
    getPiResolutionInfo().catch((e: unknown) => {
      trace(`pi-version-probe: probe failed — ${e instanceof Error ? e.message : String(e)}`);
    });
  } catch (e) {
    trace(`pi-version-probe: probe failed — ${e instanceof Error ? e.message : String(e)}`);
  }
}

/**
 * Compare two semver-like strings. Returns true when `a` is older than `b`.
 * Only the major.minor.patch numeric prefix is compared.
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

/**
 * Read the "Last verified against pi X.Y.Z" version from docs/pi-compatibility.md.
 * Returns null when the file or line is not found.
 */
export function getVerifiedVersion(): string | null {
  if (verifiedVersionCache !== undefined) return verifiedVersionCache;
  try {
    const compatPath = path.resolve(import.meta.dirname, "..", "..", "docs", "pi-compatibility.md");
    const doc = readFileSync(compatPath, "utf8");
    const parsed = parseVerifiedLine(doc)?.version ?? null;
    // Strip a leading range prefix (~, ^, >, <, =) so comparison sees plain versions.
    verifiedVersionCache = parsed ? parsed.replace(/^[~^><=]+/, "") : null;
  } catch {
    verifiedVersionCache = null;
  }
  return verifiedVersionCache;
}

/**
 * Reset all probe-side state. Exported for tests only.
 */
export function _resetPiVersionProbe(): void {
  versionPromise = null;
  piResolutionProbeStarted = false;
  verifiedVersionCache = undefined;
}
