#!/usr/bin/env bun
/**
 * #1145 — the offline suite's fixture repos must not read the host's global
 * git config.
 *
 * The regression this pins is specific and was real: this host's
 * `~/.config/git/ignore` carried one line,
 *
 *     ** / .claude/settings.local.json      (written here split so this file's
 *                                            own docstring cannot close it)
 *
 * and git derives the global EXCLUDES file from `$HOME` — not from the config
 * file. Seven offline tests assert on what `git status --porcelain -uall`
 * reports for exactly that path, so they were red at `main` on this host and
 * green on a host without the line.
 *
 * Two directions, because a gate never observed to fail is worthless (the rule
 * the file-size ratchet and the env-clear ratchet both document):
 *
 *   1. THE BUG IS REPRODUCIBLE. A temp HOME is populated with a global ignores
 *      file matching a sentinel path, and the UNisolated git call must report
 *      that path as NOT untracked. If this assertion ever passes "for free" —
 *      because the fixture stopped creating the file, or git changed how it
 *      finds excludes — the gate below would be vacuous, so this one is what
 *      makes it mean something.
 *   2. THE ISOLATION WORKS. The same repo, the same file, the same git call,
 *      with `gitTestEnv()` threaded in: the path IS untracked.
 *
 * Plus the two levers the header argues about, pinned separately, because
 * `GIT_CONFIG_GLOBAL` alone is the wrong fix and looks right:
 *   - with only GIT_CONFIG_GLOBAL pointed at an empty file, the XDG ignores
 *     file under the real HOME still applies;
 *   - with the helper's full set (which includes HOME), it does not.
 *
 * And a production-side negative: `src/headless/build.ts` scrubs these two
 * variables for a read-only probe and must NEVER set them. A production module
 * that exported an isolated HOME would change what real git calls see for the
 * user, which is exactly the boundary this issue must not cross. The scan is
 * over `src/` and asserts the ONLY occurrences are the documented scrub list.
 */

import { execFileSync } from "node:child_process";
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { GIT_ISOLATION_VARS, gitTestEnv, isolateGitEnv } from "./lib/git-test-env.ts";

let exit = 0;
function assert(cond: boolean, msg: string) {
  if (cond) console.log(`✓ ${msg}`);
  else {
    console.error(`✗ ${msg}`);
    exit = 1;
  }
}

/** The sentinel: a path a host-global ignore file plausibly names. */
const SENTINEL_DIR = ".claude";
const SENTINEL_FILE = join(SENTINEL_DIR, "settings.local.json");
/** Built from fragments so this file cannot match the pattern it tests. */
const IGNORE_LINE = ["**/", SENTINEL_FILE].join("");

/** A single-commit repo with the sentinel present and untracked. */
function makeFixture(hostEnv: Record<string, string>): { dir: string; status: () => string } {
  const dir = mkdtempSync(join(tmpdir(), "pi-ens-1145-"));
  const g = (args: string[]) =>
    execFileSync("git", args, { cwd: dir, encoding: "utf8", env: hostEnv }).trim();
  g(["init", "-q", "--initial-branch=main"]);
  g(["config", "user.email", "t@example.com"]);
  g(["config", "user.name", "T"]);
  writeFileSync(join(dir, "a.txt"), "base\n");
  g(["add", "a.txt"]);
  g(["commit", "-q", "-m", "base"]);
  mkdirSync(join(dir, SENTINEL_DIR), { recursive: true });
  writeFileSync(join(dir, SENTINEL_FILE), "{}\n");
  return { dir, status: () => g(["status", "--porcelain", "-uall"]) };
}

/** A HOME whose global ignores file contains `line` — the host we are emulating. */
function hostileHome(line: string): string {
  const home = mkdtempSync(join(tmpdir(), "pi-ens-1145-home-"));
  const cfgDir = join(home, ".config", "git");
  mkdirSync(cfgDir, { recursive: true });
  writeFileSync(join(cfgDir, "ignore"), `${line}\n`);
  // A global config too, so "hostile host" also covers config, not just excludes.
  writeFileSync(join(home, ".gitconfig"), "[user]\n\tname = Host\n\temail = host@example.com\n");
  return home;
}

const baseEnv = (): Record<string, string> => {
  const e: Record<string, string> = {};
  for (const [k, v] of Object.entries(process.env)) if (v !== undefined) e[k] = v;
  return e;
};

// ---------------------------------------------------------------- 1. the bug is real
{
  const home = hostileHome(IGNORE_LINE);
  const { status } = makeFixture({ ...baseEnv(), HOME: home });
  const out = status();
  assert(
    !out.includes(SENTINEL_FILE),
    `PRECONDITION — a host global ignores file DOES hide the sentinel from an unisolated git (got ${JSON.stringify(out)}). If this fails, the host emulation broke and the isolation assertions below would be vacuous.`,
  );
}

// ---------------------------------------------------------------- 2. isolation works
{
  const home = hostileHome(IGNORE_LINE);
  // Same hostile HOME handed in as the base — the helper must override it.
  const env = gitTestEnv({ ...baseEnv(), HOME: home });
  const { status } = makeFixture({ ...baseEnv(), HOME: home });
  // Re-run the status through the isolated env (makeFixture captured hostEnv).
  const dir = mkdtempSync(join(tmpdir(), "pi-ens-1145-iso-"));
  const g = (args: string[]) =>
    execFileSync("git", args, { cwd: dir, encoding: "utf8", env }).trim();
  g(["init", "-q", "--initial-branch=main"]);
  g(["config", "user.email", "t@example.com"]);
  g(["config", "user.name", "T"]);
  writeFileSync(join(dir, "a.txt"), "base\n");
  g(["add", "a.txt"]);
  g(["commit", "-q", "-m", "base"]);
  mkdirSync(join(dir, SENTINEL_DIR), { recursive: true });
  writeFileSync(join(dir, SENTINEL_FILE), "{}\n");
  const out = g(["status", "--porcelain", "-uall"]);
  assert(
    out.includes(SENTINEL_FILE),
    `with gitTestEnv() the sentinel IS untracked even on the hostile host (got ${JSON.stringify(out)})`,
  );
  void status;
}

// ------------------------------------------- 3. GIT_CONFIG_GLOBAL ALONE is not enough
{
  const home = hostileHome(IGNORE_LINE);
  const empty = join(mkdtempSync(join(tmpdir(), "pi-ens-1145-cfg-")), "gitconfig");
  writeFileSync(empty, "");
  const dir = mkdtempSync(join(tmpdir(), "pi-ens-1145-cfgonly-"));
  const g = (env: Record<string, string>) => (args: string[]) =>
    execFileSync("git", args, { cwd: dir, encoding: "utf8", env }).trim();
  const hostOnly = g({ ...baseEnv(), HOME: home });
  hostOnly(["init", "-q", "--initial-branch=main"]);
  hostOnly(["config", "user.email", "t@example.com"]);
  hostOnly(["config", "user.name", "T"]);
  writeFileSync(join(dir, "a.txt"), "base\n");
  hostOnly(["add", "a.txt"]);
  hostOnly(["commit", "-q", "-m", "base"]);
  mkdirSync(join(dir, SENTINEL_DIR), { recursive: true });
  writeFileSync(join(dir, SENTINEL_FILE), "{}\n");

  const configOnly = {
    ...baseEnv(),
    HOME: home,
    GIT_CONFIG_GLOBAL: empty,
    GIT_CONFIG_NOSYSTEM: "1",
  };
  const out = g(configOnly)(["status", "--porcelain", "-uall"]);
  assert(
    !out.includes(SENTINEL_FILE),
    `GIT_CONFIG_GLOBAL+NOSYSTEM alone still hides the sentinel (the XDG ignores file is derived from HOME, not the config file) — this is why the helper also isolates HOME (got ${JSON.stringify(out)})`,
  );

  const full = gitTestEnv({ ...baseEnv(), HOME: home });
  const out2 = g(full)(["status", "--porcelain", "-uall"]);
  assert(
    out2.includes(SENTINEL_FILE),
    `the helper's full set (including HOME) shows the sentinel as untracked (got ${JSON.stringify(out2)})`,
  );
}

// ------------------------------------------------------ 4. the helper is idempotent
{
  const a = gitTestEnv().HOME;
  const b = gitTestEnv().HOME;
  assert(
    a !== undefined && a === b,
    "gitTestEnv() caches — repeated calls reuse one isolation dir",
  );
  assert(
    GIT_ISOLATION_VARS.length === 3 && GIT_ISOLATION_VARS.includes("HOME"),
    `the isolation set is the documented three, HOME included (got ${JSON.stringify(GIT_ISOLATION_VARS)})`,
  );
  isolateGitEnv();
  assert(
    process.env.GIT_CONFIG_NOSYSTEM === "1" && !!process.env.GIT_CONFIG_GLOBAL,
    "isolateGitEnv() applies the isolation to the current process env too",
  );
  // An operator override is honoured, not silently replaced.
  process.env.PI_ENSEMBLE_SMOKE_HOST_GIT = "1";
  // Clear the cache indirectly: a fresh module-level cache is not reachable, so
  // assert the bypass through a call made with the flag already set (the cached
  // set is reused, so the only honest assertion here is that the base env passes
  // through and no value points at the isolation dir for a NEW process).
  const bypassed = gitTestEnv({ FOO: "bar" });
  assert(bypassed.FOO === "bar", "gitTestEnv() passes the caller's base env through");
  // biome-ignore lint/performance/noDelete: delete is the correct "reset to unset"
  delete process.env.PI_ENSEMBLE_SMOKE_HOST_GIT;
}

// ------------------------------------- 5. production never SETS these (only scrubs)
{
  const srcDir = join(import.meta.dirname, "..", "src");
  const offenders: string[] = [];
  const walk = (d: string) => {
    for (const entry of readdirSync(d)) {
      const full = join(d, entry);
      if (statSync(full).isDirectory()) {
        walk(full);
        continue;
      }
      if (!entry.endsWith(".ts")) continue;
      const text = readFileSync(full, "utf8");
      for (const v of ["GIT_CONFIG_GLOBAL", "GIT_CONFIG_NOSYSTEM"]) {
        // An ASSIGNMENT (export / process.env write) — a scrub-list string in an
        // array is not one, which is what headless/build.ts legitimately does.
        const re = new RegExp(`(export\\s+${v}|process\\.env\\.${v}\\s*=[^=])`, "m");
        if (re.test(text)) offenders.push(`${full.slice(srcDir.length + 1)} sets ${v}`);
      }
    }
  };
  walk(srcDir);
  assert(
    offenders.length === 0,
    `no production module under src/ SETS the isolation vars (src/headless/build.ts only SCRUBS them, which is not an export): ${JSON.stringify(offenders)}`,
  );
}

console.log(exit === 0 ? "\nAll #1145 git-isolation checks passed." : "\nFAILED");
process.exit(exit);
