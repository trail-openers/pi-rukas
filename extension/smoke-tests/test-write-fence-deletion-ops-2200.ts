#!/usr/bin/env bun
/**
 * #2200, the `ops` carve-out rows (G1 / G1b), split out of
 * `test-write-fence-deletion-2200.ts` by the repo's file-size cap.
 *
 * The rule leaves ONE role alone inside its own working directory: an `ops` dispatch, which
 * the driver never fences and which clears build and dependency trees in the operator's
 * checkout as its job. These rows pin both halves of that carve-out — that a real checkout
 * stays deletable, and that the carve-out cannot be widened by pointing the role's cwd at a
 * tree it does not own (a temp root, a dir named for one, `$HOME`, `/`, or the subtree the
 * ancestor walk climbs into).
 *
 * The rows that keep the carve-out OPEN are the ones the runner's environment used to decide:
 * the walk climbs a temp root's parent, and on a host whose temp dir sits under `$HOME` that
 * parent IS the home directory, so an unpinned `TMPDIR` closed the carve-out on every checkout
 * under it and the rows passed only because the machine happened to keep its temp dir elsewhere.
 * Both `HOME` and `TMPDIR` are therefore pinned through an explicit env object on every row
 * here and in the file these came from. Pinning them is not enough for the rows that build their
 * OWN tree: the rule also reads `os.tmpdir()` and `os.homedir()` off the process, and a fixture
 * inside either is refused by those before the row's own rule is asked. Those trees go through
 * `mkdtempUnderRoot(base, …)` — under the fixture, which is outside both — rather than
 * `mkdtemp(os.homedir())`, which is green under a bare `bun` and red under the runner's isolated
 * `HOME` (#1145).
 *
 * Run: cd extension && bun smoke-tests/test-write-fence-deletion-ops-2200.ts
 */

import { mkdirSync, rmSync } from "node:fs";
import path from "node:path";
import {
  deletionRootsFrom,
  firstDeletionOutside,
} from "../src/write-fence-deletion.ts";
import { withEnv } from "./lib/env-scope.ts";
import {
  buildDeletionFixture,
  deletionHost,
  mkdtempUnderRoot,
  withDeletionHost,
} from "./lib/write-fence-deletion-fixture.ts";
import {
  assert,
  exit,
  registerDeletionGuardWith,
  toolCall,
} from "./lib/write-fence-deletion-harness.ts";

const { base, sharedTmp, sharedRuns, foreignRun } = buildDeletionFixture("ops");
// Pinned for the whole file: the rule reads HOME/TMPDIR from process.env behind any row's back.
const HOST = deletionHost(base);

await withDeletionHost(HOST, async () => {
{
  // G1 — an ops dispatch is never fenced by the driver, but it is the one role
  // that works in the operator's own checkout and does git/PR work there. Only
  // deletes it cannot justify are refused: its own cwd is a working root, the
  // shared temp root is not (#2200's acceptance addition).
  //
  // The row names its OWN home, as every row here does. It cannot be the home the file
  // pinned: the carve-out refuses a cwd that IS the home directory, and the pinned host puts
  // that home one level above this fixture's `wt` (the home-relative temp root the rule must
  // tolerate). A checkout lives beside the temp root, not under it, so the row writes that
  // shape out rather than inheriting a tree it did not choose.
  const opsCheckout = path.join(base, "ops-checkout");
  mkdirSync(opsCheckout, { recursive: true });
  const opsEnv = { PI_ENSEMBLE_ROLE: "ops", HOME: base, TMPDIR: sharedTmp };
  const ops = registerDeletionGuardWith(opsEnv, opsCheckout);
  const inCwd = await toolCall(ops, "rm -rf dist");
  assert(
    inCwd === undefined,
    `G: an ops child's in-cwd \`rm -rf dist\` is not refused by this guard (got ${JSON.stringify(inCwd)})`,
  );
  const inCwdRm = await toolCall(ops, `rm -rf ${opsCheckout}/node_modules`);
  assert(inCwdRm === undefined, "G: nor an in-cwd delete named absolutely");
  const shared = await toolCall(ops, `rm -rf ${foreignRun}`);
  assert(shared?.block === true, "G: and an ops delete of the shared temp root is still refused");
}
{
  // G1b — the carve-out cannot be widened by pointing the ops child's cwd at a shared tree.
  // The driver dispatches ops at the checkout (`roles.ts`: `cwd: "repo"`), so a cwd that IS
  // a temp root, $HOME or / is a spawn that aimed the role at the very tree the rule exists
  // to protect — and `rm -rf .` there is the incident's damage. The forbidden set is built
  // from ONE fixed union — the env's temp root, the well-known temp spellings and the home
  // directory the shell expands `~` to — so an env that points `TMPDIR` at a tree of the
  // child's choosing cannot shrink it, and a fixture (which never names the machine's own
  // dirs) cannot make the rule pass by being somewhere else.
  // The test's own view of the env the rule reads: an ops child spawned with no `HOME` and no
  // `TMPDIR`, so only the well-known spellings are in play. Without this the block would judge
  // the fixture under the harness's redirected `TMPDIR`, and a scratch tree inside a shared root
  // reads as a different tree from the one its rows are written under.
  await withEnv({ HOME: undefined, TMPDIR: undefined }, async () => {
    const inSharedRoot = deletionRootsFrom({ PI_ENSEMBLE_ROLE: "ops" }, sharedTmp);
    assert(
      inSharedRoot.allowed.length === 0,
      `G1b: an ops cwd that is the shared temp root (\`${sharedTmp}\`) is not admitted as a root`,
    );
    for (const command of [`rm -rf ${sharedTmp}/pi-rukas-review-victim`, "rm -rf .", "rm -rf x"]) {
      assert(
        firstDeletionOutside(command, inSharedRoot) !== undefined,
        `G1b: an ops child standing IN the temp root cannot run \`${command}\``,
      );
    }
    // Two gates, two rows, because the `tmp`-named cwd is refused by the FIRST of them and a
    // single row would only ever observe that one.
    //
    // Gate 1 — the name. A directory called `tmp` is a temp root by the only convention a child
    // can be told to aim at (`mktemp -p ./tmp`, `TMPDIR=$PWD/tmp`), so the carve-out refuses a cwd
    // that GOES BY that name outright, wherever it sits: the fixture's own `tmp/other-session-run`
    // gets no root at all, though the machine keeps none of its temp dirs anywhere near it, and the
    // child can clean neither that dir nor anything above it.
    const inTmpNamedDir = deletionRootsFrom(
      { PI_ENSEMBLE_ROLE: "ops" },
      path.join(sharedTmp, "named-dir"),
    );
    assert(
      inTmpNamedDir.allowed.length === 0 &&
        firstDeletionOutside("rm -rf .", inTmpNamedDir) !== undefined &&
        firstDeletionOutside("rm -rf keep", inTmpNamedDir) !== undefined,
      "G1b: an ops cwd NAMED `tmp` is refused as a working root by its name, wherever it sits",
    );
    // Gate 2 — containment: what the ancestor walk of `forbiddenWorkingDirectories` decides, and
    // the gate Gate 1 cannot see (the name rule answers that cwd first, so the `tmp`-named tree is
    // useless for observing it). The walk climbs the PARENT of the temp root the PROCESS was
    // started with, for that parent's whole subtree — the tree that holds every per-run scratch
    // dir, where a child standing in the parent reaches a sibling's temp root with `rm -rf ..`.
    // To judge that climb without touching the machine's real temp root, the row pins
    // `process.env.TMPDIR` for its own duration (`withDeletionHost`) at a tree of its own,
    // `machinetmp/`, and puts the cwd under its parent (`<scratch>/builds/other-run`). Nothing
    // else can refuse that cwd: `builds` is named for no temp root, it lies inside neither home
    // read, and it is not the machine's own temp dir. Refuse the parent for its subtree and this
    // row goes red while Gate 1 above stays green.
    const scratchTree = path.join(base, "scratchtree");
    const machineTmp = path.join(scratchTree, "machinetmp");
    const opsCwd = path.join(scratchTree, "builds", "other-run");
    for (const dir of [machineTmp, opsCwd]) mkdirSync(dir, { recursive: true });
    await withDeletionHost({ HOME: scratchTree, TMPDIR: machineTmp }, async () => {
      const inChildOfRuns = deletionRootsFrom({ PI_ENSEMBLE_ROLE: "ops" }, opsCwd);
      assert(
        inChildOfRuns.allowed.length === 0 &&
          firstDeletionOutside("rm -rf ../..", inChildOfRuns) !== undefined &&
          firstDeletionOutside(`rm -rf ${machineTmp}/victim`, inChildOfRuns) !== undefined,
        "G1b: an ops cwd under the tree holding the machine's temp root is refused by the walk alone",
      );
      // The control: the same rule, the same temp root, and a cwd the walk has no claim on. The
      // walk adds a temp root's parent only where a temp root really sits in it, and the one tree
      // the process's temp root sits in here is `machinetmp`'s own parent — which is why the row
      // above is refused and this one, standing in a different tree of the same scratch, is not.
      const ordinary = path.join(base, "projects", "repo");
      mkdirSync(ordinary, { recursive: true });
      const withRoot = deletionRootsFrom({ PI_ENSEMBLE_ROLE: "ops" }, ordinary);
      assert(
        withRoot.allowed.length === 1 &&
          firstDeletionOutside("rm -rf dist", withRoot) === undefined &&
          firstDeletionOutside(`rm -rf ${machineTmp}/victim`, withRoot) !== undefined,
        "G1b: with $HOME as the temp root's parent, a checkout under it keeps the carve-out (the walk must not close that tree)",
      );
      // …and the direction the control cannot be satisfied by: the temp root's OWN subtree stays
      // refused, so the row above is not the walk having been dropped. A cwd the dispatch parked
      // inside the temp root is no one's working directory.
      const insideTemp = deletionRootsFrom({ PI_ENSEMBLE_ROLE: "ops" }, path.join(machineTmp, "wt"));
      assert(
        insideTemp.allowed.length === 0 &&
          firstDeletionOutside("rm -rf dist", insideTemp) !== undefined,
        "G1b: an ops cwd inside the machine's temp root is refused fail-closed",
      );
    });
  });
  // The two spellings of "the temp root" the rule recognises, each named by the ROW rather
  // than read from the runner: the process env's `TMPDIR` (which is the row's own pinned
  // `TMPDIR`, not whatever the invocation happened to carry), and the child's own env value.
  // Reading the runner's `process.env.TMPDIR` here made the row a test of the machine — a
  // different temp root per invocation is a different tree judged, and the row could go red
  // without the rule changing.
  for (const [name, env, cwd] of [
    ["TMPDIR from the process env", { TMPDIR: HOST.TMPDIR }, HOST.TMPDIR],
    ["TMPDIR carried in the child's env", { TMPDIR: sharedTmp }, sharedTmp],
  ] as Array<[string, Record<string, string | undefined>, string]>) {
    await withEnv(env, async () => {
      const roots = deletionRootsFrom({ PI_ENSEMBLE_ROLE: "ops" }, cwd);
      assert(
        roots.allowed.length === 0 && firstDeletionOutside("rm -rf .", roots) !== undefined,
        `G1b: an ops cwd that is the temp root (${name}) is refused as a root`,
      );
    });
  }
  // The well-known roots are refused whatever the env says: an empty env (no HOME, no
  // TMPDIR — a trimmed or scrubbed spawn) must not drop the guard, and `$HOME`/`/` are
  // refused as themselves while a checkout under the home directory stays a working tree.
  await withEnv({ HOME: undefined, TMPDIR: undefined }, async () => {
    for (const cwd of ["/", "/tmp", "/var/tmp", "/private/tmp"]) {
      assert(
        deletionRootsFrom({ PI_ENSEMBLE_ROLE: "ops" }, cwd).allowed.length === 0,
        `G1b: an ops cwd of \`${cwd}\` is not a working root, HOME-less env included`,
      );
    }
    // A scratch tree the harness built is admitted as a working directory: the rule decides the
    // cwd by where the machine's temp dirs are and what `HOME` the spawn handed over, and it
    // cannot tell a scratch tree from the checkout parked in the same shape. The damage is caught
    // on the TARGET — an absolute delete of a tree outside the roots is refused — which is why
    // the row below keeps a checkout working while the shared root two rows up stays closed.
    const checkout = path.join(base, "projects", "some-checkout");
    mkdirSync(checkout, { recursive: true });
    try {
      const inRepo = deletionRootsFrom({ PI_ENSEMBLE_ROLE: "ops", HOME: base }, checkout);
      assert(
        inRepo.allowed.length === 1 && firstDeletionOutside("rm -rf dist", inRepo) === undefined,
        "G1b: an ops child in a real checkout under $HOME still cleans it",
      );
      assert(
        firstDeletionOutside(`rm -rf ${sharedTmp}/pi-rukas-review-victim`, inRepo) !== undefined,
        "G1b: and an absolute delete of the temp root from that checkout is refused",
      );
      // The env-coupling this row exists for: a machine whose temp dir sits UNDER the home
      // directory — what macOS publishes as `$TMPDIR`, and any operator who parks their scratch at
      // `~/tmp` — is the shape that silently closed the carve-out, because the temp roots were read
      // from the parent process while `$HOME` came from the spawn. Pointing `TMPDIR` at a dir under
      // this row's own `$HOME` is that host, reproduced rather than avoided. The tree is the row's own
      // (`mkdtempUnderRoot`), and the row hands the rule the SAME path as `HOME`: the shape is a single
      // home tree holding the temp dir and the checkout, exactly where `~` points them. It cannot be
      // built under `os.homedir()`, because under the runner that is the isolated #1145 home the rule
      // refuses as itself (and for its whole subtree once a temp root sits in it), which would close
      // the carve-out before the env-coupling under test got asked. A checkout beside the temp root
      // would be refused by the rule that closes the tree holding every run's temp dirs, which is a
      // different rule. The checkout must still be a working root with its build dir deletable:
      // fail-closed on every ops spawn is what these two assertions refuse to let the code do
      // quietly. `TMPDIR` is the variable under test, not the machine's.
      const hostTree = mkdtempUnderRoot(base, "host-");
      const realCheckout = path.join(hostTree, "projects", "checkout");
      // NOT named `tmp`: a directory bearing a temp root's name is refused wherever it sits, which
      // is a different rule and would decide this row before the env-coupling under test got asked.
      const homeTmp = path.join(hostTree, "machinetmp");
      mkdirSync(realCheckout, { recursive: true });
      mkdirSync(homeTmp, { recursive: true });
      const tmpInsideHome = deletionRootsFrom(
        { PI_ENSEMBLE_ROLE: "ops", HOME: hostTree, TMPDIR: homeTmp },
        realCheckout,
      );
      assert(
        tmpInsideHome.allowed.length === 1 &&
          firstDeletionOutside("rm -rf dist", tmpInsideHome) === undefined &&
          firstDeletionOutside("rm -rf node_modules", tmpInsideHome) === undefined,
        "G1b: an ops child still cleans its checkout when the machine's temp dir sits under $HOME",
      );
      assert(
        firstDeletionOutside(`rm -rf ${homeTmp}/victim`, tmpInsideHome) !== undefined,
        "G1b: and that same env still refuses a delete inside the temp dir it points at",
      );
      rmSync(hostTree, { recursive: true, force: true });
      // The other half of the host shape, which the row above cannot reach: a machine whose temp
      // root sits OUTSIDE the home the row names (an operator who parks scratch at
      // `~/scratch/machinetmp`, a container that points `TMPDIR` at a volume of its own). There the
      // tree the walk wants to add — the temp root's parent — is neither `$HOME` nor `/`, so the
      // exemption that keeps the carve-out open does not cover it and the walk's own test on that
      // tree is what decides. Two things must hold at once and this row pins both: a working checkout
      // that merely LIVES under that tree keeps its carve-out (three assertions, because
      // `allowed.length === 1` alone still passes when the in-cwd clean is refused by something else),
      // and the tree itself stays refused for its whole subtree, which is what a child standing beside
      // the temp root reaches with `rm -rf ..`. A build that got either half wrong shows up here:
      // refuse the parent and the carve-out closes on every checkout of this shape; stop refusing it
      // and the shared root one level down opens. `TMPDIR` is the variable under test, not the machine's.
      //
      // Both trees are the row's own (`mkdtempUnderRoot`, i.e. under the fixture), and the temp root
      // sits inside the tree the row's `HOME` names so that tree — the temp root's parent — is the one
      // the walk would claim. The checkout sits in a DIFFERENT tree, which is what makes the temp
      // root's tree outside `$HOME`; no location under the host can express that. Neither tree may sit
      // under `os.homedir()` (the runner's #1145 home, refused as itself) nor under `os.tmpdir()` (the
      // walk's seed, refused for its whole subtree): under the runner both are true of the machine's
      // real scratch, so a row that built there was refused by the seed before the rule it tests was
      // asked, and passed or failed on where the invocation happened to keep its temp dirs.
      const outsideHome = mkdtempUnderRoot(base, "outside-");
      const scratchRoot = path.join(outsideHome, "scratchroot"); // neither HOME nor `/`
      const machineTmp = path.join(scratchRoot, "machinetmp");
      const checkoutOutside = path.join(base, "projects", "checkout-outside");
      mkdirSync(path.join(machineTmp, "pi-rukas-Q1"), { recursive: true });
      mkdirSync(path.join(machineTmp, "pi-rukas-Q2"), { recursive: true });
      mkdirSync(checkoutOutside, { recursive: true });
      const outsideEnv = { PI_ENSEMBLE_ROLE: "ops", HOME: outsideHome, TMPDIR: machineTmp };
      const inOutsideCheckout = deletionRootsFrom(
        outsideEnv,
        checkoutOutside,
        () => path.join(machineTmp, "pi-rukas-Q1"),
      );
      assert(
        inOutsideCheckout.allowed.length === 1 &&
          firstDeletionOutside("rm -rf dist", inOutsideCheckout) === undefined &&
          firstDeletionOutside("rm -rf node_modules", inOutsideCheckout) === undefined,
        "G1b: an ops checkout keeps the carve-out when the temp root sits OUTSIDE $HOME and / (the walk must refuse only the temp root, not the tree holding it)",
      );
      // …and the refusal the carve-out must NOT buy back: the temp root's own subtree, and the
      // tree holding it, stay out of reach by absolute path from that checkout.
      assert(
        firstDeletionOutside(`rm -rf ${machineTmp}/victim`, inOutsideCheckout) !== undefined &&
          firstDeletionOutside(`rm -rf ${scratchRoot}`, inOutsideCheckout) !== undefined,
        "G1b: and that same checkout still cannot delete the temp root or the tree holding it",
      );
      rmSync(outsideHome, { recursive: true, force: true });
    } finally {
      rmSync(path.join(base, "projects"), { recursive: true, force: true });
    }
  });
  // The ancestor walk never climbs to `$HOME` or the volume root. The walk seeds on a temp root
  // and adds its PARENT for the whole subtree (a child standing there reaches a sibling child's
  // temp dir with `rm -rf ..`). Where that parent IS the home directory — any host that publishes
  // a home-relative temp dir, macOS's `$TMPDIR` or an operator's `~/tmp` — adding it closes the
  // whole subtree, so every checkout under `$HOME` loses the `ops` carve-out. A home directory (and
  // `/`) is refused where it STANDS, never for everything under it, which is what these rows pin.
  // The env is the host described above, read through `HOME`/`TMPDIR` only: the rule's own view of
  // both comes from the one env handed to this call, so the row is the host rather than an imitation
  // of it. `HOME = <base>`, `TMPDIR = <base>/tmp`.
  const homeHost = { PI_ENSEMBLE_ROLE: "ops", HOME: base, TMPDIR: sharedTmp };
  const opsCheckout = path.join(base, "projects", "repo");
  mkdirSync(opsCheckout, { recursive: true });
  {
    const inCheckout = deletionRootsFrom(homeHost, opsCheckout);
    assert(
      inCheckout.allowed.length === 1 &&
        firstDeletionOutside("rm -rf dist", inCheckout) === undefined,
      `G1b: an ops checkout under \`$HOME\` keeps the carve-out when \`TMPDIR\` is \`$HOME/tmp\` (parent walk must not add \`$HOME\`) (got ${JSON.stringify(inCheckout.allowed)})`,
    );
    // The refusal still covers the temp root's own subtree — everything but its parent — so the
    // carve-out above is not the walk having been dropped.
    assert(
      firstDeletionOutside(`rm -rf ${sharedTmp}`, inCheckout) !== undefined &&
        firstDeletionOutside(`rm -rf ${sharedTmp}/other-session-run`, inCheckout) !== undefined,
      "G1b: and the temp root's own subtree stays refused from that checkout",
    );
    // A home directory is refused as ITSELF, not as a subtree: this line is the one a whole-subtree
    // refusal of `$HOME` would be indistinguishable from, so it is pinned on its own.
    assert(
      firstDeletionOutside(`rm -rf ${base}`, inCheckout) !== undefined,
      "G1b: and an absolute `rm -rf $HOME` from that checkout is refused",
    );
  }
  {
    // Fail-closed, and deliberately so: a checkout the dispatch parked INSIDE the temp root is not
    // a working directory. The rule refuses a temp root for its whole subtree precisely because a
    // child standing in one reaches the shared root itself with `rm -rf ..`, and the basename rule
    // refuses a cwd NAMED for a temp root wherever it sits. Both would be undone by admitting this
    // cwd, so the row says the answer out loud rather than leaving it to be inferred from the row
    // above, whose cwd sits beside the temp root.
    const insideTemp = deletionRootsFrom(homeHost, path.join(sharedTmp, "wt", "repo"));
    assert(
      insideTemp.allowed.length === 0 &&
        firstDeletionOutside("rm -rf dist", insideTemp) !== undefined,
      "G1b: a checkout the dispatch parked inside the temp root is refused fail-closed, not carved out",
    );
  }
}
});

console.log(`\nexit ${exit}`);
process.exit(exit);
