#!/usr/bin/env bun
/**
 * lean/specify — the runner preflight against REAL pytest (#2202).
 *
 * Every other probe case in this suite stands a `#!/bin/sh` stub in for the
 * runner, which is the right call for an exit-status contract and the wrong call
 * for the defect this one pins: the whole bug was pytest's own import machinery,
 * and a stub can only repeat what its author already believed about it. So this
 * file runs the preflight for real against the `python3 -m pytest` on `PATH`, in a
 * temp repo shaped like a Python project — a `pyproject.toml` with a
 * `[tool.pytest.ini_options]` table and a `tests/` directory.
 *
 * Four things are asked of the real runner:
 *
 *   (1) the probe PASSES — the step gets its healthy answer and the run goes on.
 *       This is the red-then-green pair for the whole issue: against origin/main's
 *       hidden dotfile probe, real pytest answers 4 ("not found … no match in any
 *       of") and the step hands back;
 *   (2) the OPERATOR's shape: `verify.test` is `python -m pytest -q -p <plugin>
 *       {file}` with `PYTHONPATH=.pi` and a plugin module at `.pi/<plugin>.py`.
 *       A template that loads a conftest-less plugin is the shape a real Python
 *       project configures, and it is the shape whose probe the old name refused;
 *   (2b) a plain pytest repo with NO plugin at all, whose tests sit DEEP inside a
 *       nested `testDir` (`test/units/modules/network/`) with a source tree on
 *       `PYTHONPATH=lib:.`. Nothing is imported and no project plugin is loaded,
 *       so the only reason this shape could hand back is the probe's own name —
 *       which is exactly the field report this case exists to pin;
 *   (3) POSITIVE CONTROL, so (1) cannot be green because pytest was never really
 *       asked: a sibling file holding a failing test, run through the same
 *       template, exits 1 — the runner the probe trusted does report on files;
 *   (4) the probe leaves nothing in the tree afterwards.
 *
 * **`pytest` absent is a SKIP, never a pass.** The gate prints
 * `SKIP: pytest not installed` and exits 0 WITHOUT asserting anything, because a
 * Python-dependent assertion whose verdict is a property of the host is the exact
 * failure mode this repo's suite has been burned by repeatedly. The skip is loud
 * and the file's own summary says which way it went.
 */

import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { tmpdir } from "node:os";
import path from "node:path";
import { PY_PROBE, pythonUserEnv, runPreflight } from "./lib/lean-preflight-probe-fixture.ts";
import { ROOTS } from "./lib/lean-specify-fixture.ts";

let passed = 0;
let failed = 0;
function assert(cond: boolean, msg: string): void {
  if (cond) {
    passed++;
    console.log(`✓ ${msg}`);
  } else {
    failed++;
    console.error(`✗ ${msg}`);
  }
}

/** Is pytest importable by the interpreter the case would use?
 *
 * Asked with the REAL home, not the fixture's isolated one: the skip gate is a
 * question about the host, and it is asked before any git fixture exists, so the
 * ambient `HOME` may or may not have been replaced by whichever helper ran first.
 * A gate that inherits that accident would SKIP on a host that does have pytest.
 */
function pytestAvailable(python: string): boolean {
  const r = spawnSync(python, ["-c", "import pytest"], {
    encoding: "utf8",
    timeout: 30_000,
    env: { ...process.env, ...pythonUserEnv() },
  });
  return r.status === 0;
}

/** A temp repo that looks, to pytest, exactly like a Python project's checkout. */
function pythonRepo(): { dir: string; pyproject: string } {
  const dir = mkdtempSync(path.join(tmpdir(), "lean-pytest-"));
  ROOTS.push(dir);
  mkdirSync(path.join(dir, "tests"), { recursive: true });
  const pyproject = "[tool.pytest.ini_options]\ntestpaths = [\"tests\"]\n";
  writeFileSync(path.join(dir, "pyproject.toml"), pyproject);
  return { dir, pyproject };
}

/**
 * A repo whose tests live DEEP under a nested `testDir`, with the source tree on
 * `PYTHONPATH` — the shape a large Python project (an Ansible collection layout:
 * `lib/` for the modules, `test/units/<area>/<sub>/` for the suites) really has.
 *
 * Every package directory carries an `__init__.py`, which is what makes pytest
 * treat the tree as packages and resolve the probe by IMPORTING it rather than by
 * matching a path: with packages on the tree, a name pytest cannot match answers 4
 * with "no match in any of [<Package …>]" — the hand-back this case pins.
 */
function nestedPkgRepo(): { dir: string; testDir: string; nested: string } {
  const dir = mkdtempSync(path.join(tmpdir(), "lean-pytest-nested-"));
  ROOTS.push(dir);
  const nested = "test/units/modules/network";
  mkdirSync(path.join(dir, "lib"), { recursive: true });
  mkdirSync(path.join(dir, nested), { recursive: true });
  for (const pkg of ["lib", "test", "test/units", "test/units/modules", nested]) {
    writeFileSync(path.join(dir, pkg, "__init__.py"), "");
  }
  writeFileSync(
    path.join(dir, nested, "test_x.py"),
    "def test_x():\n    assert True\n",
  );
  return { dir, testDir: "test/units", nested };
}

// The skip gate is asked BEFORE any assertion, so a host without pytest cannot
// contribute a single green to this file's tally.
const PYTHON = process.env.PI_ENSEMBLE_PYTEST_PYTHON ?? "python3";

if (!pytestAvailable(PYTHON)) {
  console.log("SKIP: pytest not installed");
  console.log(`(probed \`${PYTHON} -c 'import pytest'\`; ${passed + failed} assertions run)`);
  for (const dir of ROOTS) {
    try {
      rmSync(dir, { recursive: true, force: true });
    } catch {
      /* the OS reaps tmpdir */
    }
  }
  process.exit(0);
}

// ── (1) the probe passes against real pytest, and (4) it leaves nothing behind
{
  const { dir } = pythonRepo();
  writeFileSync(path.join(dir, "tests", "test_ok.py"), "def test_ok():\n    assert True\n");
  const got = await runPreflight({
    wt: dir,
    template: `${PYTHON} -m pytest {file}`,
    testLocation: { testDirs: ["tests"], testGlob: "test_*.py" },
    limits: { timeoutMs: 60_000 },
  });
  assert(
    got.threw === undefined,
    `(1) real pytest accepts the probe: ${got.written[0] ?? "<nothing run>"}${got.threw === undefined ? "" : ` — ${got.threw.message.split("\n")[0] ?? ""}`}`,
  );
  assert(
    got.written[0] === `tests/${PY_PROBE}`,
    `(1) and the probe it was handed is the collectable name (got ${got.written[0] ?? "<none>"})`,
  );
  assert(
    got.note === undefined,
    `(1) the answer was healthy, not the "rejected the probe file" disclosure (got ${got.note})`,
  );
  assert(
    !existsSync(path.join(dir, "tests", PY_PROBE)),
    "(4) the probe is gone from the repo afterwards",
  );
}

// ── (2) the operator's template: a plugin module under .pi, loaded with -p
{
  const { dir } = pythonRepo();
  mkdirSync(path.join(dir, ".pi"), { recursive: true });
  // A plugin the way a project writes one: a module on `PYTHONPATH` named by `-p`.
  // Its `pytest_configure` hook runs during plugin registration, BEFORE collection,
  // so a probe pytest cannot even import dies with the plugin's output above it —
  // which is the shape the old hidden name produced.
  writeFileSync(
    path.join(dir, ".pi", "leanprobe_plugin.py"),
    "def pytest_configure(config):\n    config._lean_probe_seen = True\n",
  );
  writeFileSync(path.join(dir, "tests", "test_ok.py"), "def test_ok():\n    assert True\n");
  // `PYTHONPATH` reaches the runner through the probe's own limits, which is the
  // seam production uses for a runner that needs an environment the shell would
  // otherwise have supplied — `verify.test` is argv, never a shell string.
  const got = await runPreflight({
    wt: dir,
    template: `${PYTHON} -m pytest -q -p leanprobe_plugin {file}`,
    testLocation: { testDirs: ["tests"], testGlob: "test_*.py" },
    limits: {
      timeoutMs: 60_000,
      env: { ...process.env, ...pythonUserEnv(), PYTHONPATH: ".pi" },
    },
  });
  assert(
    got.threw === undefined,
    `(2) the operator's plugin template passes preflight: ${got.written[0] ?? "<nothing run>"}`,
  );
  assert(
    !existsSync(path.join(dir, ".pi", PY_PROBE)) &&
      !existsSync(path.join(dir, "tests", PY_PROBE)),
    "(2) and no probe byte survives it, in the folder or outside it",
  );
}

// ── (2b) a plain repo with NO plugin, tests deep under a nested testDir
{
  const { dir, testDir, nested } = nestedPkgRepo();
  // No plugin, no conftest, no ini file: the runner is handed nothing but the file,
  // and `PYTHONPATH=lib:.` is the source-tree import the project's own CI sets. So
  // if this hands back, the only thing it can be blamed on is the probe's name.
  const got = await runPreflight({
    wt: dir,
    template: `${PYTHON} -m pytest -q -p no:cacheprovider -p no:randomly {file}`,
    testLocation: { testDirs: [testDir], testGlob: "test_*.py" },
    limits: {
      timeoutMs: 60_000,
      env: {
        ...process.env,
        ...pythonUserEnv(),
        PYTHONPATH: "lib:.",
      },
    },
  });
  assert(
    got.threw === undefined,
    `(2b) a plain no-plugin repo with a nested testDir passes preflight: ${got.written[0] ?? "<nothing run>"} — ${got.threw?.message.split("\n")[0] ?? ""}`,
  );
  assert(
    got.written[0] === `${testDir}/${PY_PROBE}`,
    `(2b) and the probe sat inside the configured testDir, where the package tree lets pytest import it (got ${got.written[0] ?? "<none>"})`,
  );
  assert(
    got.note === undefined,
    `(2b) with no plugin loaded the answer is still healthy, not a rejection (got ${got.note})`,
  );
  assert(
    !existsSync(path.join(dir, testDir, PY_PROBE)),
    "(2b) and no probe byte survives it in the testDir",
  );

  // The field report, stated as a fact about pytest on THIS host rather than about
  // the step: the shipped dotfile name at the same path answers 4 — the status the
  // preflight used to read as "the runner could not run a test file".
  writeFileSync(path.join(dir, nested, ".lean-runner-probe.test"), "");
  const old = spawnSync(
    PYTHON,
    ["-m", "pytest", "-q", "-p", "no:cacheprovider", "-p", "no:randomly", `${nested}/.lean-runner-probe.test`],
    {
      cwd: dir,
      encoding: "utf8",
      timeout: 120_000,
      env: {
        ...process.env,
        ...pythonUserEnv(),
        PYTHONPATH: "lib:.",
      },
    },
  );
  rmSync(path.join(dir, nested, ".lean-runner-probe.test"), { force: true });
  assert(
    old.status === 4,
    `(2b) the shipped dotfile name in the same nested package is refused by pytest with exit 4, the hand-back status (got ${String(old.status)})`,
  );
}

// ── (3) POSITIVE CONTROL: the same template reports a real failing test as a 1
{
  const { dir } = pythonRepo();
  writeFileSync(path.join(dir, "tests", "test_ok.py"), "def test_ok():\n    assert True\n");
  writeFileSync(
    path.join(dir, "tests", "test_control_fails.py"),
    'def test_control_fails():\n    raise AssertionError("the control test is red on purpose")\n',
  );
  const direct = spawnSync(
    PYTHON,
    ["-m", "pytest", "-q", "tests/test_control_fails.py"],
    { cwd: dir, encoding: "utf8", timeout: 120_000, env: { ...process.env, ...pythonUserEnv() } },
  );
  assert(
    direct.status === 1,
    `(3) positive control: a failing test file in the same repo exits 1 under the same runner (got ${String(direct.status)})`,
  );
  assert(
    (direct.stdout + direct.stderr).includes("test_control_fails"),
    "(3) and the runner NAMED the file it judged, so a probe answer of 5 is a report and not a silence",
  );
  // And the same runner, asked the probe path, says "collected 0 items" — the 5 the
  // preflight calls healthy. This is the assertion that makes (1) a claim about
  // pytest rather than about the fixture: the exit status comes from the tool.
  writeFileSync(path.join(dir, "tests", PY_PROBE), "");
  const probe = spawnSync(PYTHON, ["-m", "pytest", "-q", `tests/${PY_PROBE}`], {
    cwd: dir,
    encoding: "utf8",
    timeout: 120_000,
    env: { ...process.env, ...pythonUserEnv() },
  });
  rmSync(path.join(dir, "tests", PY_PROBE), { force: true });
  assert(
    probe.status === 5,
    `(3) and the SAME runner gives exit 5 for the empty collectable probe, which is the status the preflight calls healthy (got ${String(probe.status)}: ${(probe.stdout + probe.stderr).split("\n").filter((l) => l !== "").slice(-1)[0] ?? ""})`,
  );
  // The old name, in the same repo, through the same interpreter: the status the
  // preflight could not accept, and the reason every pytest repo handed back.
  writeFileSync(path.join(dir, "tests", ".lean-runner-probe.test"), "");
  const old = spawnSync(PYTHON, ["-m", "pytest", "-q", "tests/.lean-runner-probe.test"], {
    cwd: dir,
    encoding: "utf8",
    timeout: 120_000,
    env: { ...process.env, ...pythonUserEnv() },
  });
  rmSync(path.join(dir, "tests", ".lean-runner-probe.test"), { force: true });
  assert(
    old.status !== 0 && old.status !== 5,
    `(3) the hidden dotfile probe is the shape real pytest refuses — exit ${String(old.status)}, which is why the name changed`,
  );
}

console.log(`\n${passed} passed, ${failed} failed`);

for (const dir of ROOTS) {
  try {
    rmSync(dir, { recursive: true, force: true });
  } catch {
    /* the OS reaps tmpdir */
  }
}

process.exit(failed === 0 ? 0 : 1);
