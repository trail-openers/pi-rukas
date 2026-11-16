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
 *       status keeps the hand-back that names the command.
 *
 * The stubs are `#!/bin/sh` scripts that behave like the runners they stand in
 * for; `test-lean-preflight-real-pytest.ts` is the same claims against real pytest.
 */

import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import {
  PY_PROBE,
  exists,
  probeDir,
  runner,
  runPreflight,
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
    testLocation: { testDir: "tests", testGlob: "test_*.py" },
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
    testLocation: { testDir: "tests", testGlob: "test-*.ts" },
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
    template: runner(dir, "pyroot.sh", 'case "$1" in _lean_runner_probe.py) exit 5;; esac', "exit 4"),
    testLocation: { testDir: "nope-missing", testGlob: "test_*.py" },
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
    testLocation: { testDir: "tests", testGlob: "*_probe.py" },
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
    testLocation: { testDir: "tests", testGlob: "test_*.py" },
  });
  assert(
    rejected.threw === undefined,
    `(k) an exit-4 probe is nobody's hand-back (${rejected.threw?.message ?? "clean"})`,
  );
  assert(
    rejected.note === "the runner rejected the probe file (exit 4): sh exit4.sh tests/_lean_runner_probe.py",
    `(k) the disclosure names the rendered command and the rejection (got ${rejected.note})`,
  );
  for (const status of [2, 3, 6] as const) {
    const bad = await runPreflight({
      wt: dir,
      template: runner(dir, `bad${String(status)}.sh`, `exit ${String(status)}`),
      testLocation: { testDir: "tests", testGlob: "test_*.py" },
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

for (const dir of ROOTS) {
  try {
    rmSync(dir, { recursive: true, force: true });
  } catch {
    /* the OS reaps tmpdir */
  }
}

process.exit(exit);
