/**
 * The forge stub and the temp-repo builder every `work-lean` base case shares.
 *
 * Split out of `test-lean-seed-base.ts` when that file gained the immutable-oid
 * refusals and crossed AGENTS.md §12's line cap: the two files are one suite
 * split along the seam between its FIXTURES and its CASES, not a second suite.
 * Both read the same source (`src/lean/command.ts`), so both stay under the
 * same cap rather than one of them being squeezed.
 *
 * ## Every case in the two files these fixtures serve
 *
 * The base sha is a RUN-START fact, and a fresh `work-lean` used to have none.
 *
 * Field evidence: headless work-lean 1908 on main exited 10 after two steps.
 * `runWorkLean` seeded the engine with `{ version }` alone and `ready`'s handler
 * deliberately returns only its verdict, so nothing ever wrote `baseSha` — and
 * `specify` (like `build`, `challenge` and `verify`) refuses a run whose record
 * carries no base: "the run carries no base sha", thrown as infrastructure,
 * which is the wrong ending for a run whose issue was perfectly ready.
 *
 * `leanSeed` is the fix, and the cases these fixtures serve pin what it and
 * `readyOutcome` guarantee:
 *
 *   (a) the seed resolves the mainline tip the clone last saw (`origin/HEAD`),
 *       so the base is a real commit rather than a guess;
 *   (b) a repo with no mainline seeds `""` and does NOT throw — the seed runs
 *       before the run does, and a seed that threw would take the command down
 *       instead of letting `ready` refuse the issue with a reason;
 *   (c) the seed reaches the record: `runLean` puts it on the new run, and the
 *       `specify` handler sees the same value on `ctx.run.baseSha` — exactly the
 *       read that refused the field run;
 *   (d) the seed is a run-START fact: a resumed run keeps the sha its first
 *       round recorded, so a mainline that moved cannot silently become this
 *       run's base;
 *   (e) `ready` refuses an empty base with the mainline rule (quoting the
 *       seed's cause when it has one) rather than probing for a base of its own;
 *   (f) the wiring end to end: the handler set the command builds, driven by the
 *       engine, gets a green `ready` and a record carrying the base — the shape
 *       the field run could not reach;
 *   (g) a non-empty base that names no object is a `ready` refusal, not a
 *       default config, and the refused value is clipped in the rule;
 *   (h) a base whose commit carries no `.pi/work.json` is still `ok` — the
 *       refusal is about the absent commit, never the absent file;
 *   (i) the seed's cause reaches the rule through `handlersFor`;
 *   (j) the base is pinned to an IMMUTABLE oid, not merely to something git
 *       will resolve: `main`, `HEAD`, a ``main^{commit}`touch x`@{0}`` suffix
 *       chain, an 8-hex prefix and an uppercase full sha are all refused, and a
 *       real full sha still gives `ok`;
 *   (k) a git INFRASTRUCTURE fault is not a refusal: the second probe's answer
 *       decides, and a fault THROWS so the run hands back rather than posting
 *       "not a commit" on an issue whose clone merely could not be asked
 *       (`test-lean-base-infra.ts`);
 *   (l) the seeder PROVES what it probed — an oid-shaped mainline the clone
 *       cannot show seeds `""` with a reason naming the value, never a base
 *       `ready` would go on to refuse (`test-lean-base-infra.ts`);
 *   (m) a refused base is reported ONCE, in the rule, and never echoed in the
 *       facts (`test-lean-base-infra.ts`; the resolves-to-a-different-oid half
 *       is pinned with an injected executor in `test-lean-base-proof.ts`).
 *
 * (k)–(m) live in `test-lean-base-infra.ts` — the git-behaviour half of the same
 * suite — and are listed here as well as there so one file remains the whole
 * inventory; the two files share these fixtures and neither repeats the list a
 * second time inside itself.
 *
 * Everything is offline: real git in a temp repo (a stubbed probe would test the
 * stub), and `gh` pointed at a script printing the issue body so the forge read
 * succeeds without a network or a token.
 *
 * Nothing here asserts — a fixture that reported a verdict would be judging
 * someone else's run (the same reason `lib/lean-engine-fixtures.ts` makes its
 * assert a function).
 */

import { spawnSync } from "node:child_process";
import { chmodSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import type { GitReply as ProofGitReply } from "./lean-base-proof-fixtures.ts";
import { gitTestEnv, trackedTempDir } from "./git-test-env.ts";

/** The pi-spec every base case feeds the forge, so the spec parse goes green. */
export const SPEC = {
  problem: "The retry helper gives up on the first transient failure.",
  size: "S",
  criteria: [{ id: "AC1", text: "retries a transient failure twice", verify: "test" }],
};

export const BODY = `\`\`\`pi-spec v1\n${JSON.stringify(SPEC, null, 2)}\n\`\`\``;

function runGit(
  dir: string,
  args: string[],
  runner?: (args: string[]) => { status: number; stdout?: string; stderr?: string },
): string {
  const r =
    runner !== undefined
      ? runner(args)
      : spawnSync("git", args, {
          cwd: dir,
          encoding: "utf8",
          env: {
            ...gitTestEnv(),
            GIT_AUTHOR_NAME: "t",
            GIT_AUTHOR_EMAIL: "t@t",
            GIT_COMMITTER_NAME: "t",
            GIT_COMMITTER_EMAIL: "t@t",
          },
        });
  if (r.status !== 0)
    throw new Error(`git ${args.join(" ")} failed in ${dir}: ${(r.stderr ?? "").trim()}`);
  return (r.stdout ?? "").trim();
}

/**
 * A dir whose `gh` answers every call with `{ body }` — the shape both the
 * forge adapter's `gh issue view … --json …` and the raw fallback parse.
 *
 * `command.ts` wires `readyOutcome` to the real forge, so the seam a case has
 * for the issue body is the `gh` those paths shell out to. A PATH entry pointing
 * at a script is the narrowest fake that keeps the production read in place: the
 * JSON parse, the spec parser and the readiness judgement all run on real bytes,
 * and no token or network is needed.
 *
 * The script writes a JSON file and `cat`s it. It must NOT print the body
 * through `printf`: `%s` swallows the backquotes of a pi-spec fence and `%b`
 * eats the escapes that JSON used to spell the body's own newlines (both
 * measured — each produced `{"body":""}` from a well-formed spec), and a fake
 * that quietly deletes the fence tests a run that was refused for a reason the
 * case never intended. `cat` passes the bytes through unchanged.
 */
export function fakeGhDir(body: string): string {
  const dir = trackedTempDir("lean-seed-gh-");
  const json = JSON.stringify({
    body,
    number: 1,
    title: "t",
    state: "OPEN",
    url: "https://forge.invalid/o/r/issues/1",
    createdAt: "2026-01-01T00:00:00Z",
    updatedAt: "2026-01-01T00:00:00Z",
    labels: [],
    author: { login: "t" },
  });
  writeFileSync(path.join(dir, "answer.json"), json, "utf8");
  writeFileSync(path.join(dir, "gh"), '#!/bin/sh\ncat "$(dirname "$0")/answer.json"\n', {
    mode: 0o755,
  });
  return dir;
}

/**
 * A PATH entry whose `git` answers ONE mainline read and forwards everything
 * else to the real binary.
 *
 * `mainlineSha` reads refs and the base proof peels the value it read, so a
 * case that needs the two answers to DISAGREE — the field shape of a mixed-case
 * or otherwise mangled mainline name, or a ref whose object the clone has
 * dropped — cannot get it from a real object store. The script recognises
 * `git rev-parse --verify --quiet <ref>` only, for every other argv it `exec`s
 * the real git, so the peel, the config read and the fixture's own setup all
 * still go through git; only the one read the case named is staged.
 *
 * `spec` is `<ref>=<sha>` (stage that ref, printing that sha — an empty sha
 * means "the ref does not resolve") or `<any>` (no ref resolves at all).
 */
function fakeGitDir(spec: string): string {
  const dir = trackedTempDir("lean-seed-git-");
  const found = spawnSync("which", ["git"], { encoding: "utf8" });
  const real = (found.stdout ?? "").trim() || "/usr/bin/git";
  let rule = "  *) :;;";
  if (spec === "<any>") {
    rule = "  *rev-parse*--verify*--quiet*) printf '' ; exit 1;;";
  } else if (spec === "<upper-tip>") {
    // Print the real tip in UPPERCASE: it is still a 40-hex-shaped name, and
    // the peel resolves it to the LOWERCASE oid, which is the one case where a
    // probe's name and the object store's answer legitimately disagree.
    rule = "  *rev-parse*--verify*--quiet*) printf '%s\\n' \"$UPPER_TIP\";;";
  } else {
    const eq = spec.indexOf("=");
    const ref = spec.slice(0, eq);
    const sha = spec.slice(eq + 1);
    rule =
      sha === ""
        ? `  *rev-parse*--verify*--quiet*${ref}*) printf '' ; exit 1;;`
        : `  *rev-parse*--verify*--quiet*${ref}*) printf '%s\\n' '${sha}';;`;
  }
  writeFileSync(
    path.join(dir, "git"),
    [
      "#!/bin/sh",
      'if [ "$1" = "-C" ]; then REPO="$2"; shift 2; fi',
      'ARGS="$(printf "%s " "$@")"',
      `REAL() { '${real}' -C "\${REPO:-.}" "$@"; }`,
      `UPPER_TIP="$(REAL rev-parse HEAD 2>/dev/null | tr a-z A-Z)"`,
      'case "$ARGS" in',
      rule,
      `  *) exec '${real}' "$@";;`,
      "esac",
      "",
    ].join("\n"),
    { mode: 0o755 },
  );
  return dir;
}

/** Run `fn` with the repo's staged `git` (when it has one) searched first. */
export async function withGitBin<T>(
  repo: { gitBin: string | undefined },
  fn: () => Promise<T>,
): Promise<T> {
  if (repo.gitBin === undefined) return fn();
  return withGh(repo.gitBin, fn);
}

/**
 * Run `fn` with the forge turned off AND a `gh` on PATH that answers every call.
 *
 * Two knobs one case needs at once. `originRepo` sets `PI_ENSEMBLE_FORGE=none`
 * when it builds and `dispose` restores the prior value, so a case that builds
 * one repo to set the env and a SECOND repo to drive (a faulted seed for the
 * run, a scratch tree for the record) has no forge for the second unless it
 * turns the env off itself. And with no forge, `fetchIssueBody` falls back to
 * raw `gh issue view … --json body`, which on a host with the CLI installed
 * either asks for a login or prints the real issue — so the case has to install
 * the `cat`-a-file stub `fakeGhDir` writes, exactly as the single-repo cases do.
 * The env goes back to its exact prior bytes, absent restored as absent: every
 * reader in the tree compares against `"none"`, so a value left behind would
 * hand the next case a forge it never asked for.
 */
export async function withStubForge<T>(binDir: string, fn: () => Promise<T>): Promise<T> {
  const before = process.env.PI_ENSEMBLE_FORGE;
  process.env.PI_ENSEMBLE_FORGE = "none";
  try {
    return await withGh(binDir, fn);
  } finally {
    if (before === undefined) delete process.env.PI_ENSEMBLE_FORGE;
    else process.env.PI_ENSEMBLE_FORGE = before;
  }
}

/**
 * Run `fn` with the forge turned off.
 *
 * `originRepo` sets `PI_ENSEMBLE_FORGE=none` when it builds and `dispose`
 * restores the prior value, so a case that builds one repo to set the env and a
 * SECOND repo to actually drive has no forge for the second unless it turns the
 * env off itself — which is the shape the seed-fault cases need (a faulted repo
 * for the seed, a healthy scratch tree for the run). The `gh` stub `withGh`
 * installs is a `gh`, not a forge: `fetchIssueBody` reaches it only on the
 * no-forge path, so a case that left a real forge detected would have the
 * adapter answer instead of the stub and read whatever the host's remote says.
 */
export async function withoutForge<T>(fn: () => Promise<T>): Promise<T> {
  const before = process.env.PI_ENSEMBLE_FORGE;
  process.env.PI_ENSEMBLE_FORGE = "none";
  try {
    return await fn();
  } finally {
    if (before === undefined) delete process.env.PI_ENSEMBLE_FORGE;
    else process.env.PI_ENSEMBLE_FORGE = before;
  }
}

/** Run `fn` with `binDir` searched before the host's PATH; restores after. */
export async function withGh<T>(binDir: string, fn: () => Promise<T>): Promise<T> {
  const before = process.env.PATH;
  process.env.PATH = `${binDir}${path.delimiter}${before ?? ""}`;
  try {
    return await fn();
  } finally {
    process.env.PATH = before;
  }
}

/**
 * A real repo whose object store git cannot fully read: one loose object's
 * fanout directory at mode `000`.
 *
 * The `chmod 000` case in `test-lean-base-proof.ts` needs the fault to come
 * from git itself — a fixture that merely said "permission denied" would test
 * the fixture. Built here because this file already owns the fixture-local git
 * identity and the temp-dir tracking. Returns `undefined` when no commit could
 * be built or git read the object anyway (the caller skips rather than asserts
 * nothing).
 *
 * The reply is captured from the REAL `cat-file -e` while the fanout is still
 * unreadable, so the case asserts on how production classifies git's actual
 * bytes rather than on a string this file invented.
 */
export function realGitFaultRepo():
  | {
      repoRoot: string;
      sha: string;
      /** The exec reply real git gave for `cat-file -e <sha>^{commit}`. */
      unreadableProbeFailure: () => ProofGitReply;
      dispose: () => void;
    }
  | undefined {
  const repoRoot = trackedTempDir("lean-seed-fault-");
  const setup = (args: string[]): string => runGit(repoRoot, args);
  try {
    setup(["init", "-q", "-b", "main"]);
    mkdirSync(path.join(repoRoot, "f"), { recursive: true });
    writeFileSync(path.join(repoRoot, "f", "a.txt"), "a\n", "utf8");
    setup(["add", "-A"]);
    setup(["commit", "-q", "-m", "base"]);
    const sha = setup(["rev-parse", "HEAD"]);
    const fanout = path.join(repoRoot, ".git", "objects", sha.slice(0, 2));
    chmodSync(fanout, 0o000);
    // Ask the real git while the directory is still unreadable, and record what
    // it said: the case asserts on the CLASSIFICATION of that answer, and an
    // answer captured here fails loudly (via `undefined` below) if the
    // environment made the read succeed after all.
    const probe = spawnSync("git", ["cat-file", "-e", "--end-of-options", `${sha}^{commit}`], {
      cwd: repoRoot,
      encoding: "utf8",
      env: gitTestEnv(),
    });
    if (probe.status === 0) return undefined;
    const reply: ProofGitReply = {
      throw: {
        code: typeof probe.status === "number" ? probe.status : null,
        stderr: probe.stderr ?? "",
        message: `Command failed: git cat-file -e ${sha}^{commit}`,
      },
    };
    return {
      repoRoot,
      sha,
      unreadableProbeFailure: () => reply,
      dispose: () => {
        chmodSync(fanout, 0o755);
        rmSync(repoRoot, { recursive: true, force: true });
      },
    };
  } catch {
    return undefined;
  }
}

/**
 * A temp repo whose mainline refs exist or do not, as the case asks.
 *
 * `git remote set-head` is what makes `origin/HEAD` exist at all — a repo
 * `git init`-ed in a temp dir has no such ref, and the whole bug class here is a
 * probe that reads refs. `workJson` commits the config at the base because
 * `ready` loads `.pi/work.json` AT that sha: absent it, `ready` would fall back
 * to defaults, which is a different situation from the one under test.
 *
 * `workJson` is an OBJECT, not a boolean, because a case that needs the run to
 * start on a particular commit has to commit that file and then record the sha
 * — `{}` writes the minimum valid config, `false`/omitted writes no file at all
 * (the defaults case), and a string writes those exact bytes, which is what
 * makes a malformed-config refusal testable without a second fixture.
 *
 * `withLocalMain: false` is the second shape the seed must answer for. `origin`
 * is the last ref `mainlineSha` probes, so with no remote AND no `main` there is
 * nothing left to resolve — and a commit still has to exist for the case to have
 * a repo, so it goes on a throwaway branch and `main` is deleted.
 */
export function originRepo(
  opts: {
    withOrigin?: boolean;
    withLocalMain?: boolean;
    workJson?: boolean | object | string;
    /**
     * Stand in for `git` on the PATH while the returned `gitBin` is installed
     * (see `withGitBin`): `"<ref>=<sha>"` answers one exact
     * `git rev-parse --verify --quiet <ref>` with `<sha>` (`<sha>` empty is
     * "the ref does not resolve"), `"<any>"` answers any read git could not
     * answer, and everything else — including every `cat-file` the peel asks —
     * goes to the real git. The seam for a mainline whose ref and whose object
     * disagree, which no object store will produce on request.
     */
    fakeGit?: string;
  } = {},
): {
  repoRoot: string;
  originHead: string;
  tip: string;
  gitBin: string | undefined;
  dispose: () => void;
} {
  const withOrigin = opts.withOrigin !== false;
  const withLocalMain = opts.withLocalMain !== false;
  const repoRoot = trackedTempDir("lean-seed-");
  /** One chokepoint for every git the fixture itself runs (never redirected). */
  const setup = (args: string[]): string => runGit(repoRoot, args);
  const originDir = path.join(repoRoot, ".origin.git");
  setup(["init", "-q", "-b", "main"]);
  mkdirSync(path.join(repoRoot, ".pi"), { recursive: true });
  writeFileSync(path.join(repoRoot, "README.md"), "# seed fixture\n", "utf8");
  // `workJson: false` is a real shape, not an unused knob: `ready` loads the
  // config AT the base and a repo without one is the common case, so a case
  // has to drive it and see the run go green on the defaults anyway. An object
  // is written as JSON (a case that wants a specific config, and therefore a
  // specific commit, uses it); a string is written verbatim so a malformed
  // config is testable at the same seam.
  if (typeof opts.workJson === "object" && opts.workJson !== null) {
    writeFileSync(path.join(repoRoot, ".pi", "work.json"), JSON.stringify(opts.workJson), "utf8");
  } else if (typeof opts.workJson === "string") {
    writeFileSync(path.join(repoRoot, ".pi", "work.json"), opts.workJson, "utf8");
  } else if (opts.workJson !== false) {
    writeFileSync(path.join(repoRoot, ".pi", "work.json"), JSON.stringify({ version: 1 }), "utf8");
  } else {
    // Keep `.pi/` in the commit so the directory exists and a later case can
    // tell "no config file" from "no config directory".
    writeFileSync(path.join(repoRoot, ".pi", "README"), "no config\n", "utf8");
  }
  setup(["add", "-A"]);
  if (withLocalMain) {
    setup(["commit", "-q", "-m", "base"]);
  } else {
    setup(["commit", "-q", "-m", "base", "--allow-empty"]);
    setup(["checkout", "-q", "-b", "side"]);
    setup(["branch", "-D", "main"]);
  }
  if (withOrigin) {
    setup(["init", "-q", "--bare", originDir]);
    setup(["remote", "add", "origin", originDir]);
    setup(["push", "-q", "origin", "main"]);
    setup(["remote", "set-head", "origin", "main"]);
  }
  const originHead = withOrigin && withLocalMain ? setup(["rev-parse", "origin/HEAD"]) : "";
  // The local tip, which exists even in a repo with no remote: a case that
  // needs a REAL full sha in a repo with no `origin/HEAD` (the uppercase-sha
  // refusal) cannot use `originHead`, which is "" there.
  const tip = withLocalMain ? setup(["rev-parse", "HEAD"]) : "";
  const forgeBefore = process.env.PI_ENSEMBLE_FORGE;
  // Set BEFORE the caller's first case reads it, and restored to the exact prior
  // bytes rather than `delete`d: every reader in the tree (`fetchIssueBody`,
  // `postNotReady`, …) compares against `"none"`, so a stale value a sibling
  // test file left on the process would be as good as a forge to the fixture
  // that is supposed to keep the network out. Absent is restored as absent.
  process.env.PI_ENSEMBLE_FORGE = "none";
  const forgeWasAbsent = forgeBefore === undefined;
  const gitBin = opts.fakeGit === undefined ? undefined : fakeGitDir(opts.fakeGit);
  return {
    repoRoot,
    originHead,
    tip,
    gitBin,
    dispose: () => {
      if (gitBin !== undefined) rmSync(gitBin, { recursive: true, force: true });
      if (forgeWasAbsent) delete process.env.PI_ENSEMBLE_FORGE;
      else process.env.PI_ENSEMBLE_FORGE = forgeBefore;
      rmSync(repoRoot, { recursive: true, force: true });
    },
  };
}
