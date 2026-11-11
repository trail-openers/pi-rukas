#!/usr/bin/env bun
/**
 * lean — a worktree whose base has a submodule has it populated (#2172).
 *
 * The bench shape this pins: a base commit carrying a git submodule, and a test
 * that imports from inside it. `git worktree add` gives you the submodule's
 * GITLINK and an empty directory, and `resetWorktreeToBase`'s `clean -fdx`
 * de-populates it on every reset after that — so the child's test fails before
 * collection, the runner prints nothing naming the file, and `specify` declines
 * on `criterion ACn has no red test`. An adversary is billed for an environment
 * the step emptied.
 *
 * So the create-or-reset path BOTH `specify` and `challenge` take runs
 * `git submodule update --init --recursive` after each reset, and a failure
 * there — an unreachable remote, a clone with no network — is the same
 * infrastructure handback as a runner that cannot collect.
 *
 * Real temp repos throughout, with a real committed submodule:
 *
 *   (a) `specify` on a submodule base: the directory holds the submodule's
 *       committed file BEFORE the runner preflight runs, the run freezes, and
 *       the child saw a populated tree;
 *   (b) the submodule survives the pipeline's own reset (the CAPTURE/RESET/
 *       REWRITE reset to the base, mid-step, is where `clean -fdx` bites);
 *   (c) a base with NO submodule is untouched by the initialisation and runs as
 *       before — one read, no failure, no extra behaviour;
 *   (d) `challenge` on a submodule base sees the submodule populated too (the
 *       shared provisioning path, not a specify-only fix);
 *   (e) a submodule that cannot be initialised ends the run as infrastructure
 *       naming what failed, with no dispatch and no rows.
 */

import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import {
  ROOTS as CHALLENGE_ROOTS,
  challengeFixture,
  put,
  redEdge,
  runChallenge,
} from "./lib/lean-challenge-fixture.ts";
import {
  ROOTS,
  SpecifyInfraError,
  configWith,
  git,
  makeRepo,
  redScript,
  runSpecify,
  submit,
} from "./lib/lean-specify-fixture.ts";

let exit = 0;
function assert(cond: boolean, msg: string): void {
  if (cond) console.log(`✓ ${msg}`);
  else {
    console.error(`✗ ${msg}`);
    exit = 1;
  }
}

/**
 * Mount `url` as a submodule at `at`, from a LOCAL path.
 *
 * `protocol.file.allow` is `user` by default since the CVE that made git refuse
 * it, so a plain `submodule add <path>` fails with `transport 'file' not
 * allowed` — and the refusal is git's policy on a machine's configuration, not a
 * fact about the repository under test. The allowlist is passed per call, which
 * is what a human doing this locally does too; nothing about the step's own
 * behaviour depends on it, because the step never adds a submodule: it only
 * populates one the base already carries.
 */
function addSubmodule(dir: string, url: string, at: string): void {
  git(dir, "-c", "protocol.file.allow=always", "submodule", "add", "-q", "--force", url, at);
}

/** The submodule's mount point, and the file committed inside it. */
const SUB = "vendor/lib";
const INSIDE = `${SUB}/lib`;
/** The file the child's test imports from inside the submodule. */
const RUNNER = "sh {file}";

/** A standalone repo to mount as a submodule, with one committed file. */
function remoteRepo(): { repoRoot: string; head: string } {
  const { repoRoot, baseSha } = makeRepo({ lib: "the submodule's content\n" });
  return { repoRoot, head: baseSha };
}

/**
 * A repo whose base commit carries a real submodule at `vendor/lib`.
 *
 * Built the way a human would: add the submodule from a local path, then commit
 * what git staged. `git submodule add` writes `.gitmodules` AND the gitlink, and
 * `git add` of the directory is what makes the gitlink part of the base tree —
 * without that commit the worktree would hold an untracked directory, which is a
 * different problem than the one being pinned here.
 */
function repoWithSubmodule(url?: string, from?: string): { repoRoot: string; baseSha: string } {
  const remote = from ?? makeRepo({ lib: "the submodule's own content\n" }).repoRoot;
  const { repoRoot } = makeRepo({ "src/retry.ts": "export const retry = () => {};\n" });
  addSubmodule(repoRoot, remote, SUB);
  if (url !== undefined) {
    // Point the recorded source somewhere that is not there, then un-populate
    // what `submodule add` checked out: the base now describes a submodule that
    // can only be obtained by a clone that will fail.
    const gitmodules = path.join(repoRoot, ".gitmodules");
    writeFileSync(gitmodules, readFileSync(gitmodules, "utf8").replace(/url = .*/, `url = ${url}`));
    rmSync(path.join(repoRoot, SUB), { recursive: true, force: true });
  }
  git(repoRoot, "add", "-A");
  git(
    repoRoot,
    "commit",
    "-q",
    "-m",
    url === undefined
      ? "add the vendored submodule"
      : "point the submodule at a source that is not there",
  );
  return { repoRoot, baseSha: git(repoRoot, "rev-parse", "HEAD") };
}
/** The child writes a test that reads the submodule's file, and declares it. */
function writeSubmoduleTest(wt: string): void {
  mkdirSync(path.join(wt, "tests"), { recursive: true });
  // The read is the point: an empty submodule directory makes this file fail
  // before it asserts anything, which is the collection error the preflight
  // turns into infrastructure.
  const body = [
    "#!/bin/sh",
    `if [ ! -f ${INSIDE} ]; then`,
    `  echo "cannot import ${SUB}: the submodule is empty" 1>&2`,
    "  exit 4",
    "fi",
    // The proof's own rule: a non-zero exit counts only when the output named
    // the file, so the script reports its own path — and not the submodule's
    // name, which would let the red be credited for the wrong reason.
    'echo "not ok - $0" 1>&2',
    'echo "assertion failed: retry gave up on the first transient failure" 1>&2',
    "exit 1",
    "",
  ].join("\n");
  writeFileSync(path.join(wt, "tests/AC1-submodule.test.sh"), body, { mode: 0o755 });
}

// ── (a) + (b) specify on a submodule base: populated before the probe, and it survives
{
  const { repoRoot, baseSha } = repoWithSubmodule();
  // What the CHILD saw (dispatch time, before any pipeline reset) and what the
  // tree held AFTER the step's own reset to the base — the moment `clean -fdx`
  // has just emptied the submodule and only the shared prepare can have restored
  // it. Two different claims, two different observation points.
  const seen: string[] = [];
  const afterReset: string[] = [];
  const r = await runSpecify({
    repoRoot,
    baseSha,
    issue: 51,
    config: configWith({ fast: "true", test: RUNNER }),
    writes: (wt) => {
      // What the child sees is the claim: it was dispatched against a tree whose
      // submodule directory held the committed file, not an empty one.
      seen.push(existsSync(path.join(wt, INSIDE)) ? "populated" : "empty");
      writeSubmoduleTest(wt);
    },
    afterCapture: (wt) => {
      afterReset.push(existsSync(path.join(wt, INSIDE)) ? "populated" : "empty");
    },
    toolUses: [submit("AC1", ["tests/AC1-submodule.test.sh"])],
  });
  assert(
    r.threw === undefined,
    `(a) a submodule base runs rather than handing back (${r.threw?.message})`,
  );
  assert(
    seen.join() === "populated",
    `(a) the child saw the submodule populated (got ${seen.join()})`,
  );
  assert(
    r.outcome?.kind === "ok",
    `(a) the test that imports from it freezes (got ${r.outcome?.kind})`,
  );
  assert(
    afterReset.join() === "populated",
    `(b) the submodule was re-initialised after the step's own reset to the base (got ${afterReset.join()})`,
  );
  assert(
    existsSync(path.join(r.worktree, INSIDE)) === true,
    `(b) and the tree the run leaves holds the submodule's file (got ${
      existsSync(path.join(r.worktree, INSIDE)) ? "there" : "empty"
    })`,
  );
  assert(
    git(r.worktree, "status", "--porcelain", "-uall").trim() === "",
    `(b) with the tree clean, submodule included (got ${git(r.worktree, "status", "--porcelain", "-uall")})`,
  );
}

// ── (b2) a leftover worktree reset by a re-run: the submodule comes back
{
  const { repoRoot, baseSha } = repoWithSubmodule();
  // First run establishes the worktree; then the tree is emptied the way a
  // `clean -fdx` empties it, and the second run must repair it rather than
  // decline on a child whose import cannot resolve.
  const first = await runSpecify({
    repoRoot,
    baseSha,
    issue: 52,
    config: configWith({ fast: "true", test: RUNNER }),
    writes: (wt) => writeSubmoduleTest(wt),
    toolUses: [submit("AC1", ["tests/AC1-submodule.test.sh"])],
  });
  assert(first.threw === undefined, `(b2) first run clean (${first.threw?.message})`);
  // No hand-emptied tree here: `resetWorktreeToBase`'s own `clean -fdx` is the
  // thing that empties a submodule, and the second run resets the same leftover
  // tree. What the case pins is that the re-run finds the file there again — the
  // first run left a worktree behind whose submodule the reset had to rebuild.
  const second = await runSpecify({
    repoRoot,
    baseSha,
    issue: 52,
    config: configWith({ fast: "true", test: RUNNER }),
    writes: (wt2) => writeSubmoduleTest(wt2),
    toolUses: [submit("AC1", ["tests/AC1-submodule.test.sh"])],
  });
  assert(
    second.threw === undefined && second.outcome?.kind === "ok",
    `(b2) the re-run re-initialises it (${second.threw?.message ?? second.outcome?.kind})`,
  );
  assert(
    existsSync(path.join(second.worktree, INSIDE)) === true,
    "(b2) and the file is back in the tree",
  );
}

// ── (c) a base with no submodule is untouched by the initialisation
{
  const { repoRoot, baseSha } = makeRepo({
    "src/retry.ts": "export const retry = () => {};\n",
    "runner.sh": ["#!/bin/sh", 'echo "runner: $1" 1>&2', "exit 0", ""].join("\n"),
  });
  const r = await runSpecify({
    repoRoot,
    baseSha,
    issue: 53,
    config: configWith({ fast: "true", test: RUNNER }),
    writes: (wt) => {
      mkdirSync(path.join(wt, "tests"), { recursive: true });
      writeFileSync(path.join(wt, "tests/AC1-retry.test.sh"), redScript(), { mode: 0o755 });
    },
    toolUses: [submit("AC1", ["tests/AC1-retry.test.sh"])],
  });
  assert(
    r.threw === undefined && r.outcome?.kind === "ok",
    `(c) a submodule-free base runs exactly as before (${r.threw?.message ?? r.outcome?.kind})`,
  );
  assert(
    existsSync(path.join(r.worktree, ".gitmodules")) === false,
    "(c) and the step invented no submodule config while it was there",
  );
}

// ── (d) challenge shares the provisioning path, so a submodule survives ITS reset
{
  const issue = 54;
  const built = challengeFixture(issue);
  const remote = remoteRepo();
  // The submodule joins the run's BRANCH — the commit `challenge` resets to and
  // proves red against — and the worktree is moved onto it, exactly as a real
  // run's head carries a gitlink its base did not.
  const head = (() => {
    // The branch is held by the run's worktree, so the new commit is made there:
    // the round's head is the commit its own tree carries, which is the state a
    // run that committed on its branch is actually in.
    addSubmodule(built.worktree, remote.repoRoot, SUB);
    git(built.worktree, "commit", "-q", "-m", "add the vendored submodule");
    return git(built.worktree, "rev-parse", "HEAD");
  })();
  void head;
  const r = await runChallenge({
    issue,
    built,
    child: (tree) => {
      put(tree, "tests/AC1-submodule.test.sh", redEdge("tests/AC1-submodule.test.sh"), 0o755);
      assert(
        existsSync(path.join(tree, INSIDE)),
        "(d) the challenge child worked in a tree whose submodule was populated",
      );
    },
    toolUses: [submit("AC1", ["tests/AC1-submodule.test.sh"])],
  });
  assert(r.threw === undefined, `(d) the round ran rather than handing back (${r.threw?.message})`);
  assert(
    existsSync(path.join(r.worktree, INSIDE)) === true,
    `(d) and the round left the submodule populated (got ${
      existsSync(path.join(r.worktree, INSIDE)) ? "there" : "empty"
    })`,
  );
}

// ── (e) a submodule that cannot be fetched is infrastructure, not a verdict
{
  // The offline-laptop shape, built from three parts that are each load-bearing:
  // a recorded source that is a local path, a submodule never fetched into the
  // repository (so `--init` has no cached module and must clone), and that source
  // gone by the time the step asks git to populate the tree. The sabotage lands
  // at the step's own initialisation — the fixture runs it between the reset's
  // `clean -fdx` and the `submodule update --init` that follows it — so what the
  // assertion sees is git failing the command the step issued, not a fixture's
  // opinion about what git would have done.
  //
  // Any part missing and that command exits 0, and a step that reported
  // infrastructure then would be reporting a failure that did not happen: leave
  // the source present and the clone succeeds.
  const remote = makeRepo({ lib: "the submodule's own content\n" });
  const { repoRoot } = repoWithSubmodule(undefined, remote.repoRoot);
  const baseSha = git(repoRoot, "rev-parse", "HEAD");
  const r = await runSpecify({
    repoRoot,
    baseSha,
    issue: 55,
    config: configWith({ fast: "true", test: RUNNER }),
    afterProvision: () => {
      rmSync(remote.repoRoot, { recursive: true, force: true });
    },
    writes: (wt) => writeSubmoduleTest(wt),
    toolUses: [submit("AC1", ["tests/AC1-submodule.test.sh"])],
  });
  assert(
    r.threw instanceof SpecifyInfraError,
    `(e) an un-fetchable submodule is infrastructure (got ${
      r.threw?.constructor.name ?? r.outcome?.kind
    })`,
  );
  assert(
    r.threw === undefined || /submodule/i.test(r.threw.message),
    `(e) the handback names the submodule step (got ${r.threw?.message})`,
  );
  assert(
    r.threw === undefined || /does not exist/.test(r.threw.message),
    `(e) and carries git's own reason (got ${r.threw?.message})`,
  );
  assert(r.dispatched === 0, `(e) and no adversary was paid (got ${r.dispatched})`);
  assert(
    r.deadDispatches === undefined,
    `(e) with no dispatch rows on the throw (got ${JSON.stringify(r.deadDispatches)})`,
  );
}

// ── (e2) the healthy side of the same seam: a submodule the step populates itself
{
  // The control for (e): nothing is sabotaged, and the step's own initialisation
  // — with no test ever having touched the submodule — is what puts the file
  // there. The child's own read of it is asserted in (a); this asserts the
  // preflight never mistakes a freshly initialised submodule for a broken one.
  const remote = makeRepo({ lib: "the submodule's own content\n" });
  const { repoRoot, baseSha } = repoWithSubmodule(undefined, remote.repoRoot);
  const r = await runSpecify({
    repoRoot,
    baseSha,
    issue: 56,
    config: configWith({ fast: "true", test: RUNNER }),
    writes: (wt) => writeSubmoduleTest(wt),
    toolUses: [submit("AC1", ["tests/AC1-submodule.test.sh"])],
  });
  assert(
    r.threw === undefined && r.outcome?.kind === "ok",
    `(e2) the step's own initialisation is not mistaken for infrastructure (${
      r.threw?.message ?? r.outcome?.kind
    })`,
  );
}

// ── (e3) the product's own submodule argv carries no transport licence of its own
{
  // `protocol.file.allow=always` sat on the PRODUCTION `submodule update --init
  // --recursive` for a while, and it was a real exposure rather than a convenience:
  // with `--recursive`, a `file:` URL in a SUBMODULE's own `.gitmodules` — content of
  // a repository fetched from wherever the first one points, not content this project
  // reviewed — could clone any repository already on the host into the tree the run
  // then tests and commits. git's own default (`user`) is the policy; the operator can
  // widen it in their own config, which git still reads. The fixture needs the
  // allowance for its LOCAL-PATH remotes and gets it through its own git environment
  // (`GIT_CONFIG_COUNT`/`KEY`/`VALUE` in the exec env), never through product code.
  const remote = makeRepo({ lib: "the submodule's own content\n" });
  const { repoRoot, baseSha } = repoWithSubmodule(undefined, remote.repoRoot);
  const gitArgvs: string[][] = [];
  const r = await runSpecify({
    repoRoot,
    baseSha,
    issue: 57,
    config: configWith({ fast: "true", test: RUNNER }),
    gitArgvs,
    writes: (wt) => writeSubmoduleTest(wt),
    toolUses: [submit("AC1", ["tests/AC1-submodule.test.sh"])],
  });
  assert(
    r.threw === undefined && r.outcome?.kind === "ok",
    `(e3) the run populates its submodule under git's own policy (${r.threw?.message ?? r.outcome?.kind})`,
  );
  const submoduleCalls = gitArgvs.filter((argv) => argv.includes("submodule"));
  assert(
    submoduleCalls.length > 0,
    `(e3) the step did issue its submodule command (got ${String(submoduleCalls.length)})`,
  );
  const offenders = submoduleCalls.filter((argv) =>
    argv.some((a) => a.includes("protocol.file.allow") || a.includes("protocol.allow")),
  );
  assert(
    offenders.length === 0,
    `(e3) no submodule command of the step's carries a transport allowance (got ${JSON.stringify(offenders)})`,
  );
  assert(
    gitArgvs.every((argv) => !argv.some((a) => a.includes("protocol.file.allow"))) === true,
    `(e3) and no git command of the step's carries one anywhere (got ${JSON.stringify(gitArgvs.filter((a) => a.some((x) => x.includes("-c"))))})`,
  );
  // The allowance has to be the FIXTURE's, or the assertion above proves nothing:
  // with no config anywhere, git refuses these local-path remotes and the run would
  // be about a hand-back rather than about the argv. See the (e) case for the failure
  // shape that refusal takes.
  assert(
    existsSync(path.join(r.worktree, INSIDE)) === true,
    "(e3) the submodule really was populated, so the fixture's env is what allowed it",
  );
}

for (const dir of [...ROOTS, ...CHALLENGE_ROOTS]) {
  try {
    rmSync(dir, { recursive: true, force: true });
  } catch {
    /* the OS reaps tmpdir */
  }
}

process.exit(exit);
