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
