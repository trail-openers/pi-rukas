#!/usr/bin/env bun
/**
 * lean/specify — the runner probe's PYTHON shape (#2202).
 *
 * `test-lean-specify-preflight.ts` pins the probe in general and is at the §12
 * line cap; the four cases here are the ones that only a Python project can show,
 * so they are a file of their own with the same two fixtures rather than a
 * compression of either. Read them as the second half of that file's contract.
 *
 *   (h) a healthy pytest repo is not a hand-back: a `.py` `testGlob` gets a probe
 *       the runner can IMPORT, and the run reaches the freeze;
 *   (i) WHERE each probe is written, on the full worktree-relative path — the
 *       `.py` case inside `testDir`, a `.ts` glob and an unconfigured run keeping
 *       today's root path byte for byte, and a `.py` glob whose `testDir` is not on
 *       the tree falling back to the root;
 *   (j) a probe name the project's own `testGlob` would collect is refused rather
 *       than written, and the runner is never asked;
 *   (k) an exit 4 on the probe is DISCLOSED and the run goes on, while every other
 *       status keeps the hand-back that names the command;
 *   (l) the exit-4 reading follows the name the probe ACTUALLY carries, so a Python
 *       probe that containment moved to the hidden root name keeps the hand-back;
 *   (m) a runner call that THROWS still leaves no probe behind — the removal covers
 *       the run itself, not only the classification;
 *   (n)+(q) the disclosure's bound — its own file, `test-lean-specify-preflight-note.ts`.
 *   (o) a DANGLING symlink at the probe name is the named refusal, not a raw EEXIST;
 *   (p) a refusal names the placement it actually chose — the folder, or the root
 *       when the folder is not on the tree.
 *
 * The stubs are `#!/bin/sh` scripts that behave like the runners they stand in
 * for; `test-lean-preflight-real-pytest.ts` is the same claims against real pytest.
 */

import { mkdirSync, readlinkSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import path from "node:path";
import { PROBE_NOTE_MAX_CHARS, PROBE_REJECTED } from "../src/lean/specify-preflight-write.ts";
import { joinNotes } from "../src/lean/text-fence.ts";
import { withEnv } from "./lib/env-scope.ts";
import {
  PY_PROBE,
  exists,
  existsAnyInode,
  probeDir,
  runPreflight,
  runner,
} from "./lib/lean-preflight-probe-fixture.ts";
import {
  ROOTS,
  SpecifyInfraError,
  configWith,
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

/** Today's probe name at the worktree root — what a non-python glob must still get. */
const PROBE = ".lean-runner-probe.test";

{
  // The bug: `.lean-runner-probe.test` is hidden, and pytest's default prepend
  // import mode cannot import a module whose name starts with a dot — an empty
  // hidden `.py` exits 2 and a path pytest cannot match exits 4, neither healthy.
  // So EVERY pytest repo handed back at `specify` for a reason that was the probe's
  // own name. The stub below is a pytest honest about the distinction: exit 5 for a
  // dot-free `.py` (collected nothing), 2 for a dot-prefixed basename, 4 for
  // anything else. A probe that is still hidden, or still extensionless, hands back.
  const { repoRoot, baseSha } = makeRepo({
    "src/retry.py": "def retry():\n    pass\n",
    "pyrunner.sh": [
      "#!/bin/sh",
      'echo "runner: $1" 1>&2',
      'b=$(basename "$1")',
      'case "$b" in .*) exit 2;; esac',
      'case "$b" in *.py) exit 5;; esac',
      "exit 4",
      "",
    ].join("\n"),
  });
  const r = await runSpecify({
    repoRoot,
    baseSha,
    issue: 47,
    config: configWith({
      fast: "true",
      test: "sh pyrunner.sh {file}",
      testDir: "tests",
      testGlob: "test_*.py",
    }),
    writes: (wt) => {
      mkdirSync(path.join(wt, "tests"), { recursive: true });
      writeFileSync(path.join(wt, "tests/test_AC1_retry.py"), redScript(), { mode: 0o755 });
    },
    toolUses: [submit("AC1", ["tests/test_AC1_retry.py"])],
  });
  assert(
    r.threw === undefined,
    `(h) a healthy pytest repo is not a hand-back (${r.threw?.message ?? r.outcome?.kind})`,
  );
  assert(
    r.outcome?.kind === "ok",
    `(h) and the run proceeds to freeze (${r.outcome?.kind ?? r.threw?.message})`,
  );
  assert(
    Object.keys(r.outcome?.frozen ?? {}).join() === "tests/test_AC1_retry.py",
    `(h) the frozen set is the child's red python test (got ${Object.keys(r.outcome?.frozen ?? {}).join()})`,
  );
  assert(r.dispatched === 1, `(h) one dispatch (got ${r.dispatched})`);
  assert(
    !exists(r.worktree, `tests/${PY_PROBE}`) &&
      !exists(r.worktree, PY_PROBE) &&
      !exists(r.worktree, PROBE),
    "(h) the probe left no byte in the tree it was describing",
  );
}

// ── (i) WHERE each probe is written, asserted on the full worktree-relative path
{
  // (h) shows a python probe passes; this shows WHICH path it is. A probe that
  // passed from the wrong directory — the root instead of the folder, or the folder
  // for a non-python glob — would keep every case above green, so the path is the
  // assertion and not an inference from a passing run.
  const dir = probeDir();
  // Healthy ONLY for an empty, dot-free `.py` under `tests/`: the shape the fix
  // produces. Anything else exits 4, so a probe at the root, still hidden, or
  // carrying bytes makes the run hand back and the recorded argv answers for itself.
  const pyTemplate = runner(
    dir,
    "pyrunner.sh",
    'case "$1" in tests/\\_lean\\_runner\\_probe.py) [ -s "$1" ] && exit 1; exit 5;; esac',
    "exit 4",
  );
  const py = await runPreflight({
    wt: dir,
    template: pyTemplate,
    testLocation: { testDirs: ["tests"], testGlob: "test_*.py" },
  });
  assert(
    py.written[0] === `tests/${PY_PROBE}`,
    `(i) a .py glob probes the configured testDir at \`tests/${PY_PROBE}\` (got ${py.written[0] ?? "<nothing run>"})`,
  );
  assert(py.threw === undefined, `(i) and that probe is healthy (${py.threw?.message})`);
  const tsTemplate = runner(dir, "tsrunner.sh", `case "$1" in ${PROBE}) exit 0;; esac`, "exit 4");
  const ts = await runPreflight({
    wt: dir,
    template: tsTemplate,
    testLocation: { testDirs: ["tests"], testGlob: "test-*.ts" },
  });
  assert(
    ts.written[0] === PROBE,
    `(i) a .ts glob keeps today's probe path exactly: \`${PROBE}\` (got ${ts.written[0] ?? "<nothing run>"})`,
  );
  // No test location at all: the same root path, byte for byte.
  const bare = await runPreflight({ wt: dir, template: tsTemplate });
  assert(
    bare.written[0] === PROBE,
    `(i) and with no testGlob configured, today's path again (got ${bare.written[0] ?? "<nothing run>"})`,
  );
  // A .py glob whose testDir is NOT on the tree falls back to the root — with the
  // collectable name, since the reason to be inside the folder is not on the tree.
  const missing = await runPreflight({
    wt: dir,
    template: runner(
      dir,
      "pyroot.sh",
      'case "$1" in _lean_runner_probe.py) exit 5;; esac',
      "exit 4",
    ),
    testLocation: { testDirs: ["nope-missing"], testGlob: "test_*.py" },
  });
  assert(
    missing.written[0] === PY_PROBE,
    `(i) a .py glob with an absent testDir probes the root as \`${PY_PROBE}\` (got ${missing.written[0] ?? "<nothing run>"})`,
  );
  for (const rel of [PROBE, PY_PROBE, `tests/${PY_PROBE}`]) {
    assert(!exists(dir, rel), `(i) \`${rel}\` was removed from where it could have been written`);
  }
}

// ── (j) a probe the project's own CI would collect is refused, not written
{
  // The hidden dotfile needed no such check because `validateTestGlob` refuses a
  // glob starting with `.`. The python name is visible, so it must be checked
  // against the project's OWN pattern: a repo configuring `*_probe.py` would
  // otherwise have the runner collect the probe as one of its tests, and a probe
  // the CI grades is a probe that can be green for the wrong reason.
  const dir = probeDir();
  const template = runner(dir, "collider.sh", "exit 5");
  const got = await runPreflight({
    wt: dir,
    template,
    testLocation: { testDirs: ["tests"], testGlob: "*_probe.py" },
  });
  assert(
    got.threw instanceof SpecifyInfraError,
    `(j) a probe the repo's own testGlob matches is infrastructure (got ${
      got.threw?.constructor.name ?? "no throw"
    })`,
  );
  assert(
    got.threw === undefined ||
      (got.threw.message.includes("testGlob") && got.threw.message.includes(PY_PROBE)),
    `(j) the handback names the pattern and the name that collide (got ${got.threw?.message})`,
  );
  assert(
    got.written.length === 0,
    `(j) and the runner was never asked, since there was no legal probe to run (got ${got.written.length} calls)`,
  );
  assert(!exists(dir, `tests/${PY_PROBE}`), "(j) and the colliding probe is not left in the tree");
}

// ── (k) an exit 4 on the probe is disclosed, not handed back; the rest still throw
{
  // The operator's reading: pytest's 4 is "no collector for this file", which is a
  // fact about the PROBE and not about the bench. The step records it and goes on.
  // Every OTHER non-0/5 status keeps its hand-back — the switch may soften one
  // status, not the preflight.
  const dir = probeDir();
  const rejected = await runPreflight({
    wt: dir,
    template: runner(dir, "exit4.sh", "exit 4"),
    testLocation: { testDirs: ["tests"], testGlob: "test_*.py" },
  });
  assert(
    rejected.threw === undefined,
    `(k) an exit-4 probe is nobody's hand-back (${rejected.threw?.message ?? "clean"})`,
  );
  assert(
    rejected.note ===
      "the runner rejected the probe file (exit 4): sh exit4.sh tests/_lean_runner_probe.py",
    `(k) the disclosure names the rendered command and the rejection (got ${rejected.note})`,
  );
  for (const status of [2, 3, 6] as const) {
    const bad = await runPreflight({
      wt: dir,
      template: runner(dir, `bad${String(status)}.sh`, `exit ${String(status)}`),
      testLocation: { testDirs: ["tests"], testGlob: "test_*.py" },
    });
    assert(
      bad.threw instanceof SpecifyInfraError,
      `(k/exit ${String(status)}) every other status still hands back (got ${
        bad.threw?.constructor.name ?? "no throw"
      })`,
    );
    assert(
      bad.threw === undefined ||
        (bad.threw.message.includes(`bad${String(status)}.sh`) &&
          bad.threw.message.includes(`exited ${String(status)}`)),
      `(k/exit ${String(status)}) naming the configured command and the status (got ${bad.threw?.message})`,
    );
  }
  for (const rel of [`tests/${PY_PROBE}`, PROBE, PY_PROBE]) {
    assert(!exists(dir, rel), `(k) \`${rel}\` left no byte behind on any of these paths`);
  }
}

// ── (l) the exit-4 reading follows the name the probe ACTUALLY carries
{
  // The bug this case pins is a reading keyed to the switch rather than to the file.
  // Containment can move a Python project's probe to the hidden root name — that is
  // what (c1) of the containment file is — and the hidden name has no `.py`, so
  // pytest's "no collector for this file" is TRUE about it: the runner really was
  // shown a file it would never run. A `py` flag carried over from the config would
  // have disclosed it as "the probe was refused", which is the one reading that lets
  // a broken bench walk away. Same repo, same exit 4, one variable apart.
  const dir = probeDir();
  const outside = probeDir("lean-py-exit4-outside-");
  rmSync(path.join(dir, "tests"), { recursive: true, force: true });
  symlinkSync(outside, path.join(dir, "tests"));
  const got = await runPreflight({
    wt: dir,
    template: runner(dir, "exit4linked.sh", "exit 4"),
    testLocation: { testDirs: ["tests"], testGlob: "test_*.py" },
  });
  assert(
    got.written[0] === PROBE,
    `(l) the python probe fell back to the hidden root name (got ${got.written[0] ?? "<nothing>"})`,
  );
  assert(
    got.threw instanceof SpecifyInfraError,
    `(l) so an exit 4 on it is a hand-back, not a disclosure — the file has no .py to refuse (got ${
      got.threw?.constructor.name ?? `note: ${got.note}`
    })`,
  );
  assert(
    got.threw === undefined || !/rejected the probe file/.test(got.threw.message),
    `(l) and the disclosure does not appear on a probe that never carried the collectable name (got ${got.threw?.message})`,
  );
  assert(
    !exists(dir, PROBE) && !exists(dir, PY_PROBE) && !exists(dir, `tests/${PY_PROBE}`),
    "(l) and the probe left no byte on either name",
  );
}

// ── (m) a runner call that THROWS still removes the probe
{
  // "The probe file is removed on every path" is the claim this step makes about a
  // tree it does not own. The shape that tests it is not an exit status and not an
  // exec that rejects: `runTestFile` is `never throws` by contract and folds every
  // rejection into a classified `Proof`, so neither can reach the path the `finally`
  // is there for. The case therefore replaces the RUN call with one that raises,
  // which is what an executor that died rather than answered looks like from here.
  const dir = probeDir();
  const got = await runPreflight({
    wt: dir,
    template: runner(dir, "neverruns.sh", "exit 0"),
    testLocation: { testDirs: ["tests"], testGlob: "test_*.py" },
    run: () => {
      throw new Error("the run raised instead of answering");
    },
  });
  assert(
    got.threw !== undefined && /the run raised instead of answering/.test(got.threw.message),
    `(m) the step reports the run's own exception rather than swallowing it (got ${
      got.threw?.message ?? "no throw"
    })`,
  );
  assert(
    got.written[0] === `tests/${PY_PROBE}`,
    `(m) and the probe was placed before the run raised (got ${got.written[0] ?? "<nothing>"})`,
  );
  // The assertion this case exists for. A `finally` opened only around the
  // classification leaves this file in the tree, and the reset's clean-tree assertion
  // and the acceptance-test commit both have to explain an byte the step wrote.
  assert(
    !existsAnyInode(dir, `tests/${PY_PROBE}`),
    `(m) the probe was REMOVED even though the run raised — the try opens before the run (still at tests/${PY_PROBE})`,
  );
  assert(
    !existsAnyInode(dir, PY_PROBE) && !existsAnyInode(dir, PROBE),
    "(m) and no probe byte survives it under either name",
  );
}

// ── (o) a DANGLING symlink at the probe name is the named refusal, not a raw EEXIST
{
  // The guard asked `existsSync`, which FOLLOWS links and reports a symlink whose
  // target is gone as nothing there — so the guard said "clear" and `wx` then
  // answered EEXIST against the link itself. The operator got a raw ENOENT-looking
  // `EEXIST` naming a file that appears not to exist, which is the opposite of the
  // message this module exists to give. The fix is to ask the same question the rule
  // states: is any inode at the name, following no links?
  const dir = probeDir();
  const dangling = path.join(dir, "no-such-directory", "no-such-file.py");

  symlinkSync(dangling, path.join(dir, PY_PROBE));
  assert(
    !exists(dir, PY_PROBE) && existsAnyInode(dir, PY_PROBE),
    "(o) the fixture really made a dangling symlink: invisible to existsSync, present to lstat",
  );
  const got = await runPreflight({
    wt: dir,
    template: runner(dir, "dangling.sh", "exit 5"),
    testLocation: { testDirs: ["."], testGlob: "test_*.py" },
  });
  assert(
    got.threw instanceof SpecifyInfraError,
    `(o) a dangling symlink at the probe name is infrastructure (got ${
      got.threw?.constructor.name ?? "no throw"
    })`,
  );
  assert(
    got.threw === undefined || /already exists/.test(got.threw.message),
    `(o) the handback NAMES the existing path rather than leaking a raw EEXIST (got ${got.threw?.message})`,
  );
  assert(
    got.threw === undefined || !/EEXIST/.test(got.threw.message),
    `(o) and no raw errno reaches the operator (got ${got.threw?.message})`,
  );
  assert(
    got.written.length === 0,
    `(o) and the runner was never asked about a probe that was refused (got ${got.written.length} calls)`,
  );
  assert(
    readlinkSync(path.join(dir, PY_PROBE)) === dangling,
    "(o) and the link itself was left alone — neither followed nor unlinked",
  );
}

// ── (p) a refusal names the placement it ACTUALLY chose
{
  // The refusal is the only thing an operator has to go on, and "the probe would go
  // inside the folder" and "the probe would go to the root" are different diagnoses:
  // the second says the configured folder is not on this tree at all. So the message
  // has to name where the probe would really have been written — which is also the
  // basename the probe really carries at that placement.
  const colliding = (msg: string): boolean => msg.includes("testGlob") && msg.includes(PY_PROBE);
  const inside = probeDir();
  const inFolder = await runPreflight({
    wt: inside,
    template: runner(inside, "collide1.sh", "exit 5"),
    testLocation: { testDirs: ["tests"], testGlob: "*_probe.py" },
  });
  assert(
    inFolder.threw instanceof SpecifyInfraError && colliding(inFolder.threw.message),
    `(p) a collision inside the configured folder is refused (got ${
      inFolder.threw?.message ?? "no throw"
    })`,
  );
  assert(
    inFolder.threw?.message.includes("in tests/") === true,
    `(p) and the message names the folder it would have written into (got ${inFolder.threw?.message})`,
  );
  // The same config whose `testDir` is NOT on the tree: the probe would have gone to
  // the ROOT under the same name, and the message must say so.
  const bare = probeDir();
  rmSync(path.join(bare, "tests"), { recursive: true, force: true });
  const atRoot = await runPreflight({
    wt: bare,
    template: runner(bare, "collide2.sh", "exit 5"),
    testLocation: { testDirs: ["tests"], testGlob: "*_probe.py" },
  });
  assert(
    atRoot.threw instanceof SpecifyInfraError && colliding(atRoot.threw.message),
    `(p) a collision at the root placement is refused too (got ${atRoot.threw?.message ?? "no throw"})`,
  );
  assert(
    atRoot.threw !== undefined && /in \.\/|at the worktree root/.test(atRoot.threw.message),
    `(p) and the message names the ROOT as the placement when the folder is absent (got ${atRoot.threw?.message})`,
  );
  assert(
    !exists(bare, PY_PROBE),
    `(p) and the refused probe was never written at the root name it would have carried (got ${
      existsAnyInode(bare, PY_PROBE) ? PY_PROBE : "nothing"
    })`,
  );
}

for (const dir of ROOTS) {
  try {
    rmSync(dir, { recursive: true, force: true });
  } catch {
    /* the OS reaps tmpdir */
  }
}

process.exit(exit);
