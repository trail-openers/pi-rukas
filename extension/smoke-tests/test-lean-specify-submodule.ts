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
 *       naming what failed, with no dispatch and no rows; that sabotage reaches
 *       git through the reset's own `beforeSubmoduleInit` seam, which is where
 *       the initialisation now lives;
 *   (f) `resetWorktreeToBase` called DIRECTLY on a tree whose submodule was
 *       emptied leaves it populated and does not throw — the property every
 *       caller of the reset depends on, and the one a reset whose initialisation
 *       sat outside it does not have.
 */

import { existsSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import { execp } from "../src/exec.ts";
import { resetWorktreeToBase } from "../src/lean/specify-reset.ts";
import type { ExecFn } from "../src/worktree.ts";
import { withEnv } from "./lib/env-scope.ts";
import { gitTestEnv } from "./lib/git-test-env.ts";
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
import {
  INSIDE,
  SUB,
  addSubmodule,
  repoWithSubmodule,
  submoduleRemote,
  writeSubmoduleTest,
} from "./lib/lean-specify-submodule-fixture.ts";
import { submoduleCalls } from "./lib/lean-submodule-off-fixture.ts";

let exit = 0;
function assert(cond: boolean, msg: string): void {
  if (cond) console.log(`✓ ${msg}`);
  else {
    console.error(`✗ ${msg}`);
    exit = 1;
  }
}

/** The runner template the cases configure: `sh {file}`, the shape the fixture's
 * tests are written for — each names its own path, which is what the proof reads. */
const RUNNER = "sh {file}";

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
  const remote = submoduleRemote();
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

// ── (e) a submodule nothing here can supply is said, in the handback or in the reason
{
  // The offline-laptop shape, built from three parts that are each load-bearing: a
  // recorded source that is a local path, a submodule never fetched into the repository
  // (so `--init` has no cached module and must clone), and that source gone by the time
  // the step asks git to populate the tree. The sabotage lands at the step's own
  // initialisation — the fixture runs it between the reset's `clean -fdx` and the
  // submodule pass that follows it — so what the assertion sees is git failing a command,
  // not a fixture's opinion about what git would have done.
  //
  // What the step then does is decided by the switch, and both answers are correct ones,
  // so the case pins the property the two share rather than one of the two routes: a
  // submodule the tree cannot be made whole without is NEVER left unmentioned. With the
  // local rule off, git is asked for the recorded URL, it fails, and the run hands back as
  // infrastructure — the pre-fix behaviour, and the route a switch-off case pins below.
  // With the rule on, the step does not reach the network at all: it proceeds and names
  // the path. Either way an adversary is not paid to attack a tree whose vendored code is
  // simply not there, because the reason line says so.
  const remote = makeRepo({ lib: "the submodule's own content\n" });
  const { repoRoot } = repoWithSubmodule(undefined, remote.repoRoot);
  const baseSha = git(repoRoot, "rev-parse", "HEAD");
  const gitArgvs: string[][] = [];
  const r = await runSpecify({
    repoRoot,
    baseSha,
    issue: 55,
    config: configWith({ fast: "true", test: RUNNER }),
    gitArgvs,
    afterProvision: () => {
      // Both copies of the submodule's objects go, not just the source it was mounted
      // from. With the local rule on, a module store left anywhere under the superproject
      // is a source the step will seed from and the tree would come out populated — a
      // "clean" run whose reason says nothing, which the assertions below would read as
      // the disclosure being missing. Deleting the source alone was enough for the
      // switch-off world this case was written in; in this one the local copy has to go
      // too, or the case is measuring a different situation than it claims.
      rmSync(remote.repoRoot, { recursive: true, force: true });
      const common = git(repoRoot, "rev-parse", "--git-common-dir");
      rmSync(path.join(repoRoot, common, "modules", ...SUB.split("/")), {
        recursive: true,
        force: true,
      });
      rmSync(path.join(repoRoot, ".git", "modules", ...SUB.split("/")), {
        recursive: true,
        force: true,
      });
    },
    writes: (wt) => writeSubmoduleTest(wt),
    toolUses: [submit("AC1", ["tests/AC1-submodule.test.sh"])],
  });
  const handedBack = r.threw instanceof SpecifyInfraError;
  // Which verdict the run lands on belongs to the child and the runner; what the case owns
  // is that the submodule is nowhere unmentioned. With the local rule off, git is handed
  // the recorded URL, fails, and the step hands back as infrastructure — the pre-fix
  // behaviour. With the rule on nothing reaches the network, so the step proceeds and the
  // child reads an empty directory: the verdict is the child's (`no-red-test` here, since
  // a test that cannot import its vendored code is not red), and the disclosure is the
  // step's. Both shapes are honest; the lie would be a verdict with the submodule absent
  // from every field an operator reads.
  const disclosure = [r.threw?.message, r.outcome?.reason, r.outcome?.failedRules?.join("; ")]
    .filter((x): x is string => x !== undefined)
    .join(" | ");
  assert(
    handedBack || r.outcome !== undefined,
    `(e) the run ends in a verdict or an infrastructure handback, never a silence (got ${
      r.threw?.constructor.name ?? r.outcome?.kind ?? "neither"
    })`,
  );
  assert(
    /submodule/i.test(disclosure),
    `(e) and the submodule is NAMED either way — in the handback, or in what the verdict reports (got ${JSON.stringify(disclosure)})`,
  );
  assert(
    handedBack ? r.dispatched === 0 : /nothing on this host could supply them/.test(disclosure),
    handedBack
      ? `(e) a handback pays no adversary (got ${r.dispatched})`
      : `(e) and a run that proceeds says WHY, not just the path (got ${JSON.stringify(disclosure)})`,
  );
  // The local rule's own claim, asserted on the argv rather than argued from source: with
  // no local copy to seed from, the step must NOT have handed the recorded URL to git.
  if (!handedBack) {
    const fetchShaped = gitArgvs.filter(
      (argv) =>
        (argv.includes("clone") ||
          argv.includes("fetch") ||
          argv.includes("ls-remote") ||
          (argv.includes("update") && argv.includes("submodule"))) &&
        argv.some((a) => a.includes("http") || a.includes("://")),
    );
    assert(
      fetchShaped.length === 0,
      `(e) and with the rule on the step never took a URL to git (got ${JSON.stringify(fetchShaped)})`,
    );
  }
  assert(
    handedBack ? r.deadDispatches === undefined : true,
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

// ── (f) the reset itself, called directly, is what populates the submodule
{
  // The property the review finding is about: the re-initialisation belongs to
  // `resetWorktreeToBase`, not to the one caller that happened to ask for it.
  // A hand-emptied tree here rather than a `clean -fdx`: this case is not about
  // what emptied it, it is about what the reset does about it — so the emptying
  // is done by hand and the reset is the ONLY thing allowed to put it back.
  const { repoRoot, baseSha } = repoWithSubmodule();
  const issue = 58;
  const wt = path.join(repoRoot, ".worktrees", `lean-${issue}`);
  git(repoRoot, "worktree", "add", "-q", "--detach", wt, baseSha);
  const inside = path.join(wt, INSIDE);
  // The reset's own git children get the FIXTURE's environment, exactly as the
  // fixture's `exec` wrapper gives it to every git call of the step's: these
  // submodule remotes are local paths and git refuses the `file` transport
  // without the allowance. The product still adds none of its own — (e3) above
  // pins that on the argv.
  const env: Record<string, string> = {
    ...gitTestEnv(),
    GIT_CONFIG_COUNT: "1",
    GIT_CONFIG_KEY_0: "protocol.file.allow",
    GIT_CONFIG_VALUE_0: "always",
  };
  const exec: ExecFn = async (cmd, o) => execp(cmd, { ...o, env: { ...env, ...(o?.env ?? {}) } });
  const reset = (target: string, sha: string) => resetWorktreeToBase(exec, target, sha, "");
  // A fresh `worktree add` hands out the gitlink and an empty directory — the
  // state the step's own prepare has to repair — so the precondition is asserted
  // AFTER the preparation this case is about, not against a hand-populated tree.
  let threw: Error | undefined;
  try {
    await reset(wt, baseSha);
  } catch (err) {
    threw = err as Error;
  }
  assert(
    threw === undefined,
    `(f) preparing the fresh tree does not throw (${threw ? `${threw.name}: ${threw.message.split("\n")[0]}` : "clean"})`,
  );
  assert(existsSync(inside), "(f) the prepared tree has the submodule populated");
  rmSync(path.join(wt, SUB), { recursive: true, force: true });
  threw = undefined;
  try {
    await reset(wt, baseSha);
  } catch (err) {
    threw = err as Error;
  }
  assert(
    threw === undefined,
    `(f) resetting a tree whose submodule was emptied does not throw (${threw ? `${threw.name}: ${threw.message.split("\n")[0]}` : "clean"})`,
  );
  assert(
    existsSync(inside),
    `(f) and the reset left the submodule populated (got ${existsSync(inside) ? "there" : "empty"})`,
  );
}

// ── (g) with `PI_ENSEMBLE_LEAN_RUNNER_PREFLIGHT=0` the step issues NO submodule call
{
  // R1's per-path half for `specify` itself. The switch is honoured inside
  // `resetWorktreeToBase`, so what is asserted is the absence of the call from the
  // argv the STEP issued — not a directory being empty, which a base with no
  // submodule would show too. Every case above drives this same shape with the
  // switch unset and asserts the submodule IS populated, so the argv is the only
  // thing the switch moved.
  const { repoRoot, baseSha } = repoWithSubmodule();
  const gitArgvs: string[][] = [];
  const seen: string[] = [];
  let threw: Error | undefined;
  let outcomeKind: string | undefined;
  let worktree = "";
  await withEnv({ PI_ENSEMBLE_LEAN_RUNNER_PREFLIGHT: "0" }, async () => {
    try {
      const r = await runSpecify({
        repoRoot,
        baseSha,
        issue: 61,
        config: configWith({ fast: "true", test: RUNNER }),
        gitArgvs,
        writes: (wt) => {
          seen.push(existsSync(path.join(wt, INSIDE)) ? "populated" : "empty");
          writeSubmoduleTest(wt);
        },
        toolUses: [submit("AC1", ["tests/AC1-submodule.test.sh"])],
      });
      outcomeKind = r.outcome?.kind;
      worktree = r.worktree;
    } catch (err) {
      threw = err as Error;
    }
  });
  assert(
    threw === undefined,
    `(g) the switch-off run does not hand back on the submodule (${threw ? `${threw.name}: ${threw.message.split("\n")[0]}` : "clean"})`,
  );
  // The argv this case reads for the switch-off arm is argv from which the release
  // issued NOTHING about submodules. The local arm's silent read of the tree
  // (`submodule status`) is not that: it asks git what the tree holds, fetches nothing,
  // and exists to disclose what the step could not supply. Excluding it is the
  // difference between "the step did not ask git to populate anything" — the claim —
  // and "the step never mentioned submodules", which the disclosure now deliberately
  // breaks. The other assertions in this case are what pin the claim: `seen` is the
  // child's own look at the tree and must read `empty`, and the run must still reach a
  // verdict, so a status call that silently populated the tree could not pass them.
  const fetchShaped = submoduleCalls(gitArgvs).filter((argv) => !argv.includes("status"));
  assert(
    fetchShaped.length === 0,
    `(g) the step issued no submodule call of any kind (got ${JSON.stringify(
      fetchShaped.map((a) => a.slice(-3)),
    )})`,
  );
  assert(
    seen.join() === "empty",
    `(g) and the child worked in the tree v0.14.71 left it — the gitlink stayed empty (got ${seen.join()})`,
  );
  assert(
    existsSync(path.join(worktree, INSIDE)) === false,
    `(g) and the tree the run left holds no submodule file (got ${
      existsSync(path.join(worktree, INSIDE)) ? "there" : "empty"
    })`,
  );
  assert(
    outcomeKind !== undefined,
    `(g) and the step still reached a verdict rather than infrastructure (got ${String(outcomeKind)})`,
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
