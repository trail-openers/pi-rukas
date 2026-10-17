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
 * And the lever whose absence the first CI run of this file caught: HOME alone
 * is also the wrong fix, and also looks right. Git reads the per-user config
 * directory from `$XDG_CONFIG_HOME` whenever it is set, so a host that exports
 * it keeps `$XDG_CONFIG_HOME/git/ignore` in force no matter what HOME says.
 * Case 3b pins that directly (hostile XDG, CLEAN HOME — HOME cannot be blamed),
 * and case 1 pins it on the fixture the original test used: an env that
 * overrides HOME but does not control XDG must still reproduce the bug, which
 * is what a `ubuntu-latest` runner (which exports the variable) does and what
 * this host (which does not) does not.
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

/** A single-commit repo with the sentinel present and untracked.
 *
 * Built under a private `mkdtemp` root, deliberately NOT under the checkout.
 * A fixture repo is a repo wherever it lives, but a nested one inherits the
 * OUTER clone's exclude files — `$GIT_COMMON_DIR/info/exclude` (the checkout's
 * own `.git/info/exclude`, which per-clone `worktree-provision` hooks write
 * into) is one of the four exclude sources git consults, and a line there
 * naming the sentinel would hide it for reasons that have nothing to do with
 * the host. Measured on this host that does not bite — a `mkdtemp` repo under
 * `/var/folders/...` has no parent repo, so `--git-common-dir` is its own
 * `.git` — but a `TMPDIR` inside a checkout, or a repo rooted in the tree, is
 * one exclude line away from a silent false pass on every assertion below.
 * One private root also gives the whole file one place to clean up; it is
 * created LAZILY because case 4 calls `isolateGitEnv()`, which repoints the
 * ambient `HOME`/`XDG_CONFIG_HOME` that later cases inherit into their
 * `baseEnv()` — a root resolved at module load would then sit under the
 * isolated HOME, and git resolves `.git/config`'s `core.excludesFile`
 * relative to it, so every hostile fixture after that point would go quietly
 * benign.
 */
let _fixtureRoot: string | undefined;
function fixtureRoot(): string {
  if (!_fixtureRoot) _fixtureRoot = mkdtempSync(join(tmpdir(), "pi-ens-1145-root-"));
  return _fixtureRoot;
}

function makeFixture(hostEnv: Record<string, string>): { dir: string; status: () => string } {
  const dir = mkdtempSync(join(fixtureRoot(), "repo-"));
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

/**
 * A HOME whose global ignores file contains `line` — the host we are emulating.
 *
 * The hostile env this produces is `hostileEnv(home)`, not `home` alone, and
 * that is the whole point of the #1145 follow-up: the fixture writes the ignore
 * file into `$HOME/.config/git/`, which git only reads when `XDG_CONFIG_HOME`
 * is UNSET. A runner that exports it (GitHub's `ubuntu-latest` does) sends git
 * somewhere else entirely, the fixture's file goes unread, and the PRECONDITION
 * below reports the sentinel as untracked — red on CI, green locally, for a
 * reason that has nothing to do with the code under test. So the hostile env
 * controls BOTH doors: `XDG_CONFIG_HOME` is pinned INSIDE the hostile home, at
 * the directory git falls back to when the variable is absent, so the fixture
 * is the host on any runner and the emulation does not silently degrade to "no
 * hostile file at all".
 */
function hostileHome(line: string): string {
  const home = mkdtempSync(join(fixtureRoot(), "home-"));
  const cfgDir = join(home, ".config", "git");
  mkdirSync(cfgDir, { recursive: true });
  writeFileSync(join(cfgDir, IG), `${line}\n`);
  // A global config too, so "hostile host" also covers config, not just excludes.
  writeFileSync(join(home, ".gitconfig"), "[user]\n\tname = Host\n\temail = host@example.com\n");
  return home;
}

/** The env of the emulated hostile host: HOME and XDG_CONFIG_HOME both point at it. */
function hostileEnv(home: string): Record<string, string> {
  return { ...baseEnv(), HOME: home, XDG_CONFIG_HOME: join(home, ".config") };
}

/** A directory holding `git/<file>` with `contents` — an XDG config dir to emulate. */
function hostileXdgDir(file: string, contents: string): string {
  const root = mkdtempSync(join(fixtureRoot(), "xdg-"));
  const gitDir = join(root, "git");
  mkdirSync(gitDir, { recursive: true });
  writeFileSync(join(gitDir, file), contents);
  return root;
}

/** An empty HOME — the "clean host" half of a two-door experiment. */
function cleanHome(): string {
  return mkdtempSync(join(fixtureRoot(), "clean-"));
}

/**
 * The ambient env, with the two home-ish levers DROPPED.
 *
 * Callers here always state the host they mean — `hostileEnv()` sets HOME and
 * XDG_CONFIG_HOME explicitly — so an ambient value for either must not survive
 * into the env handed to git. That is not a style choice: case 4 calls
 * `isolateGitEnv()`, which writes the isolation HOME/XDG into `process.env`, so
 * on any re-run order that put case 4 first (or a future case that isolates
 * earlier) every later fixture would inherit the isolated pair and silently
 * lose its hostility. A base that cannot carry them makes the order irrelevant.
 */
function baseEnv(): Record<string, string> {
  const e: Record<string, string> = {};
  for (const [k, v] of Object.entries(process.env)) {
    if (v === undefined) continue;
    if (k === "HOME" || k === "XDG_CONFIG_HOME") continue;
    e[k] = v;
  }
  return e;
}

/**
 * "ignore", built from fragments. This file asserts on a pattern that matches
 * the tool's own settings path; it must not also match itself in a grep, and
 * the filename of the excludes file is the token that would do it.
 */
const IG = ["ig", "nore"].join("");

// ---------------------------------------------------------------- 1. the bug is real
{
  const home = hostileHome(IGNORE_LINE);
  const { status } = makeFixture(hostileEnv(home));
  const out = status();
  assert(
    !out.includes(SENTINEL_FILE),
    `PRECONDITION — a host global ignores file DOES hide the sentinel from an unisolated git (got ${JSON.stringify(out)}). If this fails, the host emulation broke and the isolation assertions below would be vacuous.`,
  );
}

// ------------------------------- 1b. and it reproduces when only HOME points at the host
{
  // The shape a `ubuntu-latest` runner actually gives you: HOME overridden, the
  // runner's own `XDG_CONFIG_HOME` still inherited. The fixture's ignore file
  // sits under HOME, so on a host that exports the variable this DOES NOT hide
  // anything — which is precisely the CI failure this case now pins instead of
  // being blindsided by. Two outcomes, both stated, neither silent:
  //   - the sentinel is hidden  -> this host does not export the variable, and
  //     HOME alone was enough here (it is not enough in general: see 3b).
  //   - the sentinel is visible -> the host exports it, and the isolation must
  //     come from the XDG lever, not the HOME one.
  // Either way the assertion is that `gitTestEnv()` still shows the sentinel,
  // which is the only claim the suite actually depends on.
  const home = hostileHome(IGNORE_LINE);
  const { status } = makeFixture({ ...baseEnv(), HOME: home });
  const out = status();
  const hides = !out.includes(SENTINEL_FILE);
  const exportsXdg = process.env.XDG_CONFIG_HOME !== undefined;
  assert(
    hides || exportsXdg,
    `HOME-only hostility reproduces the bug whenever the host does not export XDG_CONFIG_HOME (hidden=${hides}, host exports XDG_CONFIG_HOME=${exportsXdg}). A false result here with a false exportsXdg means the fixture stopped being hostile at all.`,
  );
  const iso = gitTestEnv({ ...baseEnv(), HOME: home });
  const isolated = makeFixture(iso);
  assert(
    isolated.status().includes(SENTINEL_FILE),
    `HOME-only hostility is isolated by gitTestEnv() whatever the host exports for XDG (got ${JSON.stringify(isolated.status())})`,
  );
}

// ---------------------------------------------------------------- 2. isolation works
{
  const home = hostileHome(IGNORE_LINE);
  // The hostile pair handed in as the BASE — the helper must override both, not
  // just the one it originally knew about.
  const env = gitTestEnv(hostileEnv(home));
  assert(
    env.HOME !== home && env.XDG_CONFIG_HOME !== join(home, ".config"),
    `gitTestEnv() overrides a hostile HOME AND a hostile XDG_CONFIG_HOME from the caller's base (HOME=${JSON.stringify(env.HOME)}, XDG=${JSON.stringify(env.XDG_CONFIG_HOME)})`,
  );
  // The repo is CREATED and read under the isolated env, which is what a
  // fixture actually does. Building it hostile and reading it isolated (the
  // first version of this case) asserted the wrong thing: it only proved that
  // the ignore file did not match retroactively, not that a fixture built on a
  // hostile host and inspected isolated shows its own files. Case 3 pins the
  // build-hostile/read-isolated shape on purpose, as the HOME-lever argument.
  const { status } = makeFixture(env);
  const out = status();
  assert(
    out.includes(SENTINEL_FILE),
    `with gitTestEnv() the sentinel IS untracked even on the hostile host (got ${JSON.stringify(out)})`,
  );
}

// ------------------------------------------- 3. GIT_CONFIG_GLOBAL ALONE is not enough
{
  const home = hostileHome(IGNORE_LINE);
  const empty = join(mkdtempSync(join(fixtureRoot(), "cfg-")), "gitconfig");
  writeFileSync(empty, "");
  const dir = mkdtempSync(join(fixtureRoot(), "cfgonly-"));
  const g = (env: Record<string, string>) => (args: string[]) =>
    execFileSync("git", args, { cwd: dir, encoding: "utf8", env }).trim();
  const hostOnly = g(hostileEnv(home));
  hostOnly(["init", "-q", "--initial-branch=main"]);
  hostOnly(["config", "user.email", "t@example.com"]);
  hostOnly(["config", "user.name", "T"]);
  writeFileSync(join(dir, "a.txt"), "base\n");
  hostOnly(["add", "a.txt"]);
  hostOnly(["commit", "-q", "-m", "base"]);
  mkdirSync(join(dir, SENTINEL_DIR), { recursive: true });
  writeFileSync(join(dir, SENTINEL_FILE), "{}\n");

  const configOnly = {
    ...hostileEnv(home),
    GIT_CONFIG_GLOBAL: empty,
    GIT_CONFIG_NOSYSTEM: "1",
  };
  const out = g(configOnly)(["status", "--porcelain", "-uall"]);
  assert(
    !out.includes(SENTINEL_FILE),
    `GIT_CONFIG_GLOBAL+NOSYSTEM alone still hides the sentinel (the ignores file is derived from the config dir, not the config file) — this is why the helper also isolates HOME and XDG_CONFIG_HOME (got ${JSON.stringify(out)})`,
  );

  const full = gitTestEnv(hostileEnv(home));
  const out2 = g(full)(["status", "--porcelain", "-uall"]);
  assert(
    out2.includes(SENTINEL_FILE),
    `the helper's full set (HOME + XDG_CONFIG_HOME) shows the sentinel as untracked (got ${JSON.stringify(out2)})`,
  );
}

// --------------------- 3b. HOSTILE XDG_CONFIG_HOME WITH A CLEAN HOME — HOME is not enough
{
  // The case the first CI run of this file was the version of. The HOME here is
  // EMPTY, so nothing under it can hide anything: if the sentinel disappears,
  // the only thing that can have done it is the exported XDG directory. Before
  // the fix this is exactly what a runner that exports the variable does to
  // every fixture in the suite — seven host-red tests at `main`, and this
  // file's own PRECONDITION red on CI.
  const xdg = hostileXdgDir(IG, `${IGNORE_LINE}\n`);
  const home = cleanHome();
  const dir = mkdtempSync(join(fixtureRoot(), "xdgonly-"));
  const g = (env: Record<string, string>) => (args: string[]) =>
    execFileSync("git", args, { cwd: dir, encoding: "utf8", env }).trim();
  const setup = g({ ...baseEnv(), HOME: home });
  setup(["init", "-q", "--initial-branch=main"]);
  setup(["config", "user.email", "t@example.com"]);
  setup(["config", "user.name", "T"]);
  writeFileSync(join(dir, "a.txt"), "base\n");
  setup(["add", "a.txt"]);
  setup(["commit", "-q", "-m", "base"]);
  mkdirSync(join(dir, SENTINEL_DIR), { recursive: true });
  writeFileSync(join(dir, SENTINEL_FILE), "{}\n");

  // Control: with neither door hostile, git sees the sentinel. Without this the
  // assertion below could pass because the fixture never created the file.
  const clean = g({ ...baseEnv(), HOME: home })(["status", "--porcelain", "-uall"]);
  assert(
    clean.includes(SENTINEL_FILE),
    `CONTROL — with a clean HOME and no hostile XDG dir the sentinel IS untracked, so the fixture really creates it (got ${JSON.stringify(clean)})`,
  );

  const hostile = g({ ...baseEnv(), HOME: home, XDG_CONFIG_HOME: xdg })([
    "status", "--porcelain", "-uall",
  ]);
  assert(
    !hostile.includes(SENTINEL_FILE),
    `PRECONDITION — an XDG ignores file hides the sentinel with a CLEAN HOME, so HOME alone cannot isolate it (got ${JSON.stringify(hostile)}). A visible sentinel here means git stopped honouring the variable and the isolation below would be vacuous.`,
  );

  const full = gitTestEnv({ ...baseEnv(), HOME: home, XDG_CONFIG_HOME: xdg });
  const isolated = g(full)(["status", "--porcelain", "-uall"]);
  assert(
    isolated.includes(SENTINEL_FILE),
    `under isolation the hostile XDG ignores file no longer applies and the sentinel is visible again (got ${JSON.stringify(isolated)})`,
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
    GIT_ISOLATION_VARS.length === 4 &&
      GIT_ISOLATION_VARS.includes("HOME") &&
      GIT_ISOLATION_VARS.includes("XDG_CONFIG_HOME"),
    `the isolation set is the documented four — HOME and XDG_CONFIG_HOME both in it (got ${JSON.stringify(GIT_ISOLATION_VARS)})`,
  );
  // The two home-ish levers must agree, not point at different trees: the XDG
  // dir lives INSIDE the isolated HOME, so a caller that reads one cannot be
  // handed a view of a directory the other has already isolated away.
  const iso = gitTestEnv();
  assert(
    !!iso.HOME && !!iso.XDG_CONFIG_HOME && iso.XDG_CONFIG_HOME.startsWith(`${iso.HOME}${"/"}`),
    `the isolated XDG dir is inside the isolated HOME, so the two levers describe one host (HOME=${JSON.stringify(iso.HOME)}, XDG=${JSON.stringify(iso.XDG_CONFIG_HOME)})`,
  );
  isolateGitEnv();
  assert(
    process.env.GIT_CONFIG_NOSYSTEM === "1" && !!process.env.GIT_CONFIG_GLOBAL,
    "isolateGitEnv() applies the isolation to the current process env too",
  );
  assert(
    !!process.env.XDG_CONFIG_HOME,
    `isolateGitEnv() SETS XDG_CONFIG_HOME rather than leaving the host's in place (got ${JSON.stringify(process.env.XDG_CONFIG_HOME)})`,
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
      for (const v of ["GIT_CONFIG_GLOBAL", "GIT_CONFIG_NOSYSTEM", "XDG_CONFIG_HOME"]) {
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
