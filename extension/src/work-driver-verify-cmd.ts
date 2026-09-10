/**
 * work-driver-verify-cmd — verify command discovery.
 *
 * Extracted from work-driver-verify.ts (issue #338, file-size cap).
 * Determines the project's verify command (typecheck / test) using
 * the PR17/PR18 precedence chain.
 */

import fs from "node:fs/promises";
import path from "node:path";

/** Read the first non-empty, non-comment line from a config file. */
export function readFirstConfigLine(content: string): string | undefined {
  return content
    .split("\n")
    .map((l) => l.trim())
    .find((l) => l.length > 0 && !l.startsWith("#"));
}

/**
 * #679 (task-evidence) — manifest-derived source-file classifier.
 *
 * The develop gate must tell "a workstream whose declared paths are source
 * but which produced no source changes" (falsely green) from "a genuine
 * docs-only workstream" (legitimately no source). It classifies files the
 * SAME way the project's own verify-cmd / language detection already does:
 * the language set is derived from the manifest signals `verifyCmdFor` already
 * reads (Cargo.toml → Rust, package.json → JS/TS, go.mod → Go, pyproject /
 * setup.py → Python). There is NO new independent classifier — the manifest
 * presence here mirrors the manifest presence `verifyCmdFor` branches on.
 * Absent any manifest, a plain extension-based default applies.
 */

/** File extensions treated as source, per detected language. */
const SOURCE_EXT = {
  rust: [".rs"],
  js: [".ts", ".tsx", ".js", ".jsx", ".mjs", ".cjs", ".mts", ".cts", ".vue"],
  go: [".go"],
  python: [".py"],
  // Extension-based default when no manifest is present.
  default: [".rs", ".ts", ".tsx", ".js", ".jsx", ".mjs", ".cjs", ".go", ".py"],
} as const;

const isSourceExt = (file: string, sourceExts: string[]): boolean =>
  sourceExts.some((ext) => file.endsWith(ext));

/**
 * #679 (task-evidence) — does a file path classify as source code, using the
 * language set derived from the project's manifests (the same signals
 * `verifyCmdFor` reads)? Exported so the develop gate and its tests share one
 * classifier.
 */
export async function isSourcePath(file: string, repoRoot: string): Promise<boolean> {
  const has = async (f: string) =>
    fs
      .access(path.join(repoRoot, f))
      .then(() => true)
      .catch(() => false);
  const sources: string[] = [];
  if (await has("Cargo.toml")) sources.push(...SOURCE_EXT.rust);
  try {
    if (await has("package.json")) sources.push(...SOURCE_EXT.js);
  } catch {
    // package.json unreadable — fall through; not a source signal either way.
  }
  if (await has("go.mod")) sources.push(...SOURCE_EXT.go);
  if ((await has("pyproject.toml")) || (await has("setup.py"))) sources.push(...SOURCE_EXT.python);
  if (sources.length === 0) sources.push(...SOURCE_EXT.default);
  return isSourceExt(file, sources);
}

/**
 * #679 (task-evidence) — do ANY of a workstream's declared paths classify as
 * source? A docs-only workstream (declared `docs/*.md`) returns false, so its
 * zero-commits / no-source-changes state is NOT penalised by the falsily-green
 * check. Manifest-aware: the same `isSourcePath` predicate decides.
 */
export async function declaredPathsHaveSource(
  declaredPaths: string[],
  repoRoot: string,
): Promise<boolean> {
  const TRAILING_PAREN = /\s*\([^()]*\)\s*$/;
  const normalised = declaredPaths
    .map((p) => p.trim().replace(TRAILING_PAREN, ""))
    .filter((p) => p.length > 0);
  if (normalised.length === 0) return false;
  return (await Promise.all(normalised.map((p) => isSourcePath(p, repoRoot)))).some((s) => s);
}

/**
 * PR17 — Discover the project's verify command (typecheck/test) for the
 * driver-side outcome-verification gate.
 *
 * Precedence (PR18/R6 shape):
 *   1. `.pi/verify-cmd` file at the target repo root — first non-empty,
 *      non-comment line is the command verbatim. The explicit escape
 *      valve for projects whose gate isn't derivable.
 *   2. `package.json` `typecheck` script — an intentional project-level
 *      signal; wins even next to a Cargo.toml. Runner detected from
 *      lockfile: bun.lock(b) → bun, pnpm-lock.yaml → pnpm, yarn.lock →
 *      yarn, else npm.
 *   3. `Cargo.toml` → `cargo check --quiet`. Beats a bare package.json
 *      `test` script — a Rust repo with a tooling package.json (docs
 *      build, hooks) must not run `npm run test` as its gate.
 *   4. `package.json` `test` script (non-Rust repos only).
 *   5. Nothing found → undefined; the gate skips command verification
 *      and checks diff/commit/PR evidence only (note emitted).
 */
export async function verifyCmdFor(repoRoot: string): Promise<string | undefined> {
  const has = async (f: string) =>
    fs
      .access(path.join(repoRoot, f))
      .then(() => true)
      .catch(() => false);
  try {
    const raw = await fs.readFile(path.join(repoRoot, ".pi", "verify-cmd"), "utf8");
    const line = readFirstConfigLine(raw);
    if (line) return line;
  } catch {
    // No explicit file — try derivation.
  }
  // PR18 (R6 fix) — Cargo.toml wins over package.json UNLESS package.json
  // has an explicit `typecheck` script. Pre-PR18 package.json won
  // unconditionally, so a Rust repo with any tooling package.json (docs
  // build, git hooks, frontend fragment) discovered `npm run test`
  // instead of `cargo check` and ran the wrong build in every worktree —
  // guaranteed spurious verify-failures on Rust projects. A `typecheck`
  // script is treated as an intentional project-level signal; a bare
  // `test` script next to a Cargo.toml is almost always tooling.
  const isRust = await has("Cargo.toml");
  try {
    const pkgRaw = await fs.readFile(path.join(repoRoot, "package.json"), "utf8");
    const pkg = JSON.parse(pkgRaw) as { scripts?: Record<string, string> };
    const script = pkg.scripts?.typecheck
      ? "typecheck"
      : !isRust && pkg.scripts?.test
        ? "test"
        : undefined;
    if (script) {
      let runner = "npm run";
      if ((await has("bun.lock")) || (await has("bun.lockb"))) runner = "bun run";
      else if (await has("pnpm-lock.yaml")) runner = "pnpm run";
      else if (await has("yarn.lock")) runner = "yarn";
      return `${runner} ${script}`;
    }
  } catch {
    // No package.json or malformed — fall through.
  }
  if (isRust) return "cargo check --quiet";
  return undefined;
}
