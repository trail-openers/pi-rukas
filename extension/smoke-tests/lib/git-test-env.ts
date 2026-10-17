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
 * Four levers, one per door git reads:
 *
 *   GIT_CONFIG_GLOBAL   — an empty file replaces the per-user config (git >= 2.32).
 *   GIT_CONFIG_NOSYSTEM — the site-wide /etc/gitconfig is skipped.
 *   HOME                — an empty directory.
 *   XDG_CONFIG_HOME     — an empty directory, inside that HOME.
 *
 * The third is the one that is easy to get wrong, and it is not optional.
 * `GIT_CONFIG_GLOBAL` replaces the per-user *config*, but git derives the
 * global *ignore* file from the HOME directory (`$HOME/.config/git/ignore`,
 * XDG), so an empty config still leaves that file in force. Measured on this
 * host with git 2.50.1: with `GIT_CONFIG_GLOBAL` pointed at an empty file,
 * `git check-ignore -v` still attributed the path to `~/.config/git/ignore`;
 * with `HOME` pointed at an empty directory it reported "not ignored".
 *
 * The fourth exists because HOME is NOT the broad lever it was assumed to be.
 * Git reads the per-user config directory from `$XDG_CONFIG_HOME` WHENEVER THAT
 * IS SET and only falls back to `$HOME/.config` when it is unset — so
 * overriding HOME alone leaves a host `XDG_CONFIG_HOME/git/ignore` (and
 * `.../git/config`, `.../git/attributes`) in force. GitHub's `ubuntu-latest`
 * runner exports `XDG_CONFIG_HOME`, and that is what made the PRECONDITION of
 * smoke-tests/test-git-host-isolation-1145.ts red on CI while green here: the
 * fixture's hostile `$HOME/.config/git/ignore` was never read, because the
 * runner's variable sent git somewhere else. Reproduced locally by pointing
 * `XDG_CONFIG_HOME` at a directory carrying `git/ignore` with a clean HOME —
 * the sentinel disappears from `git status --porcelain -uall` exactly as CI
 * reported it. The isolation hole is the same one and is not test-only: a
 * developer whose `XDG_CONFIG_HOME` points at a config tree carrying ignores
 * was NOT isolated by overriding HOME, which is the guarantee this module
 * exists to give. Measured with git 2.50.1 on this host (which does NOT export
 * the variable, hence the local green): hostile `XDG_CONFIG_HOME` + clean HOME
 * hides the sentinel; the four-variable set shows it again.
 *
 * HOME is still the broader lever for the state that IS derived from it, and
 * the two are complementary rather than redundant: it isolates host-global git
 * state under the home directory — global config, and the `.config` fallback
 * git uses when XDG is unset — where XDG closes the per-user-config door that
 * HOME cannot reach. Fixtures never
 * depend on HOME: every commit in every fixture carries its identity locally
 * (`-c user.email=…` or an in-fixture `git config user.email …`), and
 * `ensureGitIdentity` in lib/git-worktree-fixture.ts supplies the
 * `GIT_AUTHOR_*` / `GIT_COMMITTER_*` fallback for commits that go through the safety
 * net rather than a per-call flag.
 *
 * ONE ENTRY POINT: `gitTestEnv()`
 * ---------------------------------------------------------------------------
 * There is exactly one thing a fixture calls to get an isolated git view:
 * `gitTestEnv()`. It does two jobs on the first call and both are idempotent.
 * It ENSURES the ambient isolation — it writes the four variables into
 * `process.env`, which is what reaches a production seam handed an exec the
 * fixture does not control (`execp` with no `env`, and the driver's `ExecFn`)
 * — and it RETURNS the env, which is what a fixture threads into a child
 * options object it does control. One call, one rule: ask for the env, and the
 * process you are running in has already been pointed at the same directory.
 *
 * `isolateGitEnv()` is a thin alias for the ambient half, for the call site
 * that genuinely wants only that (a test file's top-of-file statement, whose
 * author is not threading an env anywhere). It is the same `ensure()` behind
 * both, so mixing the two forms cannot produce two isolation dirs.
 *
 * WHY THE EXPORTS ARE RE-APPLIED TO EVERY GIT CALL, AND NOT ONLY TO `process.env`
 * -------------------------------------------------------------------------
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

/** The four variables that isolate a fixture repo from the host's git config. */
export const GIT_ISOLATION_VARS = [
  "GIT_CONFIG_GLOBAL",
  "GIT_CONFIG_NOSYSTEM",
  "HOME",
  "XDG_CONFIG_HOME",
] as const;

let cached: Record<string, string> | undefined;

/** Write one line to the test process's stderr without ever printing the
 * reporter's failure glyph. The smoke pool's digest (lib/verify-report.sh,
 * #827/#1028) greps the captured stream for `✗` and repeats those lines after
 * the summary as failure detail, so a module that announces itself with that
 * character in its prose manufactures a fake failing assertion in the tail.
 * The glyph is built from fragments so this file does not contain it either. */
const FAILURE_GLYPH = ["\u2717", "", ""].join("");
function emitIsolationWarning(msg: string): void {
  process.stderr.write(`WARNING [git-test-env]: ${msg.split(FAILURE_GLYPH).join("?")}\n`);
}
function emitIsolationTrace(msg: string): void {
  process.stderr.write(`trace [git-test-env]: ${msg.split(FAILURE_GLYPH).join("?")}\n`);
}

/**
 * THE entry point. Returns the isolation env merged over `base` (default: the
 * current `process.env`), and — on the first call in the process — points the
 * ambient env at the same isolated view (see the module header's one rule).
 *
 * Idempotent: the same four values every call, cached after the first, so a
 * helper may call this per git call without allocating a temp dir per call.
 *
 * Honours an already-set value the same way verify-loop.sh does: an operator
 * debugging a fixture with `PI_ENSEMBLE_SMOKE_HOST_GIT=1`, or a CI job that
 * already exported an isolation dir, gets that shape rather than a second one.
 */
export function gitTestEnv(
  base: Record<string, string | undefined> = process.env,
): Record<string, string> {
  const fresh = cached === undefined;
  if (fresh) cached = build();
  // The one rule: asking for the env also points the ambient env at the same
  // view, so a production seam handed an exec the fixture does not control
  // (`execp` with no `env`, the driver's `ExecFn`) reads the same host the
  // fixture's own git children do. Guarded on "first build" rather than being
  // unconditional, because `ensure()` itself calls back into this function to
  // read the cached set.
  if (fresh) ensure();
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(base)) if (v !== undefined) out[k] = v;
  return { ...out, ...cached };
}

function build(): Record<string, string> {
  if (process.env.PI_ENSEMBLE_SMOKE_HOST_GIT === "1") {
    // The escape hatch is loud on purpose. Every host-red fixture in #1145 was
    // a fixture reading the operator's config, and a silent bypass is how that
    // state comes back looking green — so anyone who set it (or inherited it
    // from a shell profile) is told that the suite is no longer isolated. The
    // once-per-process guard lives in `ensure()`, the caller. It goes through
    // the test reporter's own line writer rather than a raw `process.stderr`
    // because this file's failure vocabulary is `✗` and the pool's digest
    // (lib/verify-report.sh) anchors its tail on that glyph — a warning that
    // quoted the marker's own character would be echoed into the summary tail
    // as if it were a failed assertion.
    emitIsolationWarning(
      "PI_ENSEMBLE_SMOKE_HOST_GIT=1 — HOST GIT CONFIG IN USE, isolation disabled. " +
        "Fixture git views depend on this machine's config; results are not the gated verdict.",
    );
    return {};
  }
  const dir = mkdtempSync(join(tmpdir(), "pi-ens-gitiso-"));
  const cfg = join(dir, "gitconfig");
  const home = join(dir, "home");
  mkdirSync(home, { recursive: true });
  // Empty, and INSIDE the isolated HOME so the two levers cannot disagree about
  // where the per-user config lives. Git looks for `$XDG_CONFIG_HOME/git/ignore`,
  // so an empty directory has nothing to ignore.
  const xdg = join(home, ".config");
  mkdirSync(xdg, { recursive: true });
  writeFileSync(cfg, "");
  const iso: Record<string, string> = {
    GIT_CONFIG_GLOBAL: cfg,
    GIT_CONFIG_NOSYSTEM: "1",
    HOME: home,
    XDG_CONFIG_HOME: xdg,
  };
  // An operator/runner that already chose a value wins — for the two CONFIG
  // levers only. `HOME` and `XDG_CONFIG_HOME` are deliberately excluded: they
  // are always isolated here, because they are the two whose host value
  // silently changes what a fixture's git sees. Honouring an inherited one
  // would defeat the whole point — verify-loop.sh exports its own isolated
  // `HOME` and `XDG_CONFIG_HOME` for the run, and re-using those here is
  // harmless, but re-using the OPERATOR's home or XDG config tree is exactly
  // the leak this module exists to close.
  for (const k of GIT_ISOLATION_VARS) {
    const existing = process.env[k];
    if (existing && k !== "HOME" && k !== "XDG_CONFIG_HOME") iso[k] = existing;
  }
  return iso;
}

/** Whether the first `build()` chose the isolated shape or the escape hatch.
 * Read by the trace below and by nothing else — it exists so the one line this
 * module writes to stderr says WHICH shape won, rather than leaving a reader to
 * infer it from the absence of the other, and so the trace fires once rather
 * than on every git call. */
let isolationMode: "isolated" | "host-git" | undefined;

/** The ambient half: write the four variables into `process.env` so a child
 * that inherits the env (rather than being handed one) gets the isolated view.
 * Called once from `gitTestEnv()` on its first call, and from `isolateGitEnv()`.
 *
 * `XDG_CONFIG_HOME` is SET to the empty dir rather than deleted from
 * `process.env`, although "isolated" would accept either. The reason is the bun
 * behaviour described in the header: bun drops `process.env` mutations on
 * synchronous spawns, so a `delete` that lands on `process.env` still does not
 * reach an unthreaded child — the operator's value survives either way, and only
 * the positive form is robust. It also keeps `gitTestEnv()` a pure superset of
 * its base, so no caller has to reason about un-setting anything. */
function ensure(): void {
  if (isolationMode) return;
  const iso = gitTestEnv();
  for (const k of GIT_ISOLATION_VARS) {
    const v = iso[k];
    if (v !== undefined) process.env[k] = v;
  }
  // `host-git` only when the escape hatch fired; otherwise the four levers are
  // pointed at an isolated view, whether this module built it or a CI job
  // pre-set all four itself.
  isolationMode = process.env.PI_ENSEMBLE_SMOKE_HOST_GIT === "1" ? "host-git" : "isolated";
  // One line per process on stderr, naming the shape a reader would otherwise
  // have to deduce. Deliberately NOT a console.log — a test's stdout is its
  // `✓`-transcript and the passing path's output is what the digest compares.
  if (isolationMode === "host-git") {
    emitIsolationTrace(
      "isolation ESCHEWED — host git config in use (PI_ENSEMBLE_SMOKE_HOST_GIT=1)",
    );
  } else {
    emitIsolationTrace(
      `isolated git view — HOME=${process.env.HOME} XDG_CONFIG_HOME=${process.env.XDG_CONFIG_HOME}`,
    );
  }
}

/**
 * Isolate the CURRENT process, and only that — the thin alias over the ambient
 * half of `gitTestEnv()`, for the call site that wants the ambient statement
 * and has no child env to thread (a test file's top-of-file isolation).
 *
 * A call site that DOES spawn a child should call `gitTestEnv()` and thread the
 * return value — the ambient write alone does NOT reach a `child_process` call
 * that omits `env` on bun 1.3 (see the header), and this returns nothing
 * precisely so that mistake is a type error rather than a silent host read.
 */
export function isolateGitEnv(): void {
  ensure();
}
