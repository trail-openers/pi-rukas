/**
 * #1145 — a test fixture's git view must not depend on the host it runs on.
 *
 * A throwaway repo (`git init` in a temp dir) still reads the operator's
 * global configuration. On a host whose `~/.config/git/ignore` carries a line
 * like `** / .claude/settings.local.json` (written without the space in the
 * real file), the tool's own local settings file is
 * invisible to `git status --porcelain -uall`: it is not untracked, it is not
 * ignored-and-listed, it simply is not there. Seven offline tests pin what the
 * dirty-root exemption baseline, the integrate preflight, the restore claim and
 * the consolidated-verify gate see in exactly that tree, so they were red on
 * this host at `main` and green on a host without the line — the suite's
 * verdict was a property of the machine.
 *
 * Three levers, one per door git reads:
 *
 *   GIT_CONFIG_GLOBAL   — an empty file replaces the per-user config (git >= 2.32).
 *   GIT_CONFIG_NOSYSTEM — the site-wide /etc/gitconfig is skipped.
 *   HOME                — an empty directory.
 *
 * The third is the one that is easy to get wrong, and it is not optional.
 * `GIT_CONFIG_GLOBAL` replaces the per-user *config*, but git derives the
 * global *ignore* file from the HOME directory (`$HOME/.config/git/ignore`,
 * XDG), so an empty config still leaves that file in force. Measured on this
 * host with git 2.50.1: with `GIT_CONFIG_GLOBAL` pointed at an empty file,
 * `git check-ignore -v` still attributed the path to `~/.config/git/ignore`;
 * with `HOME` pointed at an empty directory it reported "not ignored".
 *
 * HOME is also the broader lever, which is the actual requirement: it isolates
 * ANY host-global git state under the home directory — global config, XDG
 * config, XDG ignore — rather than this one excludesFile. Fixtures never
 * depend on HOME: every commit in every fixture carries its identity locally
 * (`-c user.email=…` or an in-fixture `git config user.email …`), and
 * `ensureGitIdentity` in lib/git-worktree-fixture.ts supplies the
 * `GIT_AUTHOR_*` / `GIT_COMMITTER_*` fallback for commits that go through the safety
 * net rather than a per-call flag.
 *
 * WHY THE EXPORTS ARE RE-APPLIED TO EVERY GIT CALL, AND NOT ONLY TO `process.env`
 * --------------------------------------------------------------------------------
 * Mutating `process.env` in a bun test file is NOT enough on this host's bun
 * (1.3.12). Node's `child_process` inherits the real `environ` when no `env`
 * option is passed, and bun does not write a `process.env` assignment back to
 * it — so `process.env.HOME = x` changes what the test reads and not what the
 * child sees. Measured: after `process.env.FOO_A = "alpha"`, a plain
 * `execFileSync("/usr/bin/env")` child does not list `FOO_A`; the same call
 * with `env: process.env` does. That is why every helper here threads
 * `gitTestEnv()` explicitly into the child options rather than trusting an
 * ambient mutation, and why the same isolation is exported by
 * lib/verify-loop.sh for the whole run (belt and braces: whichever path a
 * fixture's git call takes, it lands on an isolated view).
 *
 * The `process.env` assignment IS still made, for one reason: production code
 * under test reads `process.env` at call time, so a fixture that hands a
 * production seam an exec it does not control (the driver's `ExecFn`) has to
 * have the value visible in the ambient env too.
 *
 * DO NOT USE THIS FROM `src/`. It exists so a test can pin what git reports;
 * production git calls must keep reading the operator's configuration. The
 * only production module that touches these variables scrubs them for a
 * read-only repository probe (`src/headless/build.ts` `GIT_ENV_SCRUB`) — it
 * never sets them, and it is not changed by this.
 */
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

/** The three variables that isolate a fixture repo from the host's git config. */
export const GIT_ISOLATION_VARS = ["GIT_CONFIG_GLOBAL", "GIT_CONFIG_NOSYSTEM", "HOME"] as const;

/**
 * The real home directory, captured before this module isolates `HOME` and
 * re-exported as `PI_ENSEMBLE_TEST_REAL_HOME`. A test that legitimately needs
 * the operator's home (test-runs.ts browses `~/.pi/agent/ensemble-runs`) reads
 * that variable; `os.homedir()` would otherwise keep returning the real path
 * anyway (bun snapshots it at process start), so reading this is the explicit
 * statement of "I mean the host home, not the isolated one".
 */
export const REAL_HOME = process.env.PI_ENSEMBLE_TEST_REAL_HOME ?? process.env.HOME ?? "";

let cached: Record<string, string> | undefined;

/**
 * The isolation env, merged over a base (default: the current `process.env`).
 * Idempotent: the same three values every call, cached after the first, so a
 * helper may call this per git call without allocating a temp dir per call.
 *
 * Honours an already-set value the same way verify-loop.sh does: an operator
 * debugging a fixture with `PI_ENSEMBLE_SMOKE_HOST_GIT=1`, or a CI job that
 * already exported an isolation dir, gets that shape rather than a second one.
 */
export function gitTestEnv(
  base: Record<string, string | undefined> = process.env,
): Record<string, string> {
  if (!cached) cached = build();
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(base)) if (v !== undefined) out[k] = v;
  return { ...out, ...cached };
}

function build(): Record<string, string> {
  if (process.env.PI_ENSEMBLE_SMOKE_HOST_GIT === "1") return {};
  const dir = mkdtempSync(join(tmpdir(), "pi-ens-gitiso-"));
  const cfg = join(dir, "gitconfig");
  mkdirSync(join(dir, "home"), { recursive: true });
  writeFileSync(cfg, "");
  const iso: Record<string, string> = {
    GIT_CONFIG_GLOBAL: cfg,
    GIT_CONFIG_NOSYSTEM: "1",
    HOME: join(dir, "home"),
  };
  // An operator/runner that already chose a value wins — for the two CONFIG
  // levers only. `HOME` is deliberately excluded: it is always isolated here,
  // because it is the broad lever (the header) and the one whose host value
  // silently changes what a fixture's git sees. Honouring an inherited `HOME`
  // would defeat the whole point — verify-loop.sh exports its own isolated
  // `HOME` for the run, and re-using it here is harmless, but re-using the
  // OPERATOR's home is exactly the leak this module exists to close.
  for (const k of GIT_ISOLATION_VARS) {
    const existing = process.env[k];
    if (existing && k !== "HOME") iso[k] = existing;
  }
  process.env.PI_ENSEMBLE_TEST_REAL_HOME = REAL_HOME;
  return iso;
}

/**
 * Isolate the CURRENT process (and therefore any child that inherits
 * `process.env` explicitly, `Bun.spawn({env: {...process.env}})` among them).
 * Does NOT reach a `child_process` call that omits `env` on bun 1.3 — see the
 * header note; those calls must thread `gitTestEnv()` themselves.
 */
export function isolateGitEnv(): void {
  const iso = gitTestEnv();
  for (const k of GIT_ISOLATION_VARS) {
    const v = iso[k];
    if (v !== undefined) process.env[k] = v;
  }
  process.env.PI_ENSEMBLE_TEST_REAL_HOME = REAL_HOME;
}
