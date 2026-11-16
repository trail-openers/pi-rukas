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
import { PY_PROBE, runPreflight } from "./lib/lean-preflight-probe-fixture.ts";
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

/** Is pytest importable by the interpreter the case would use? */
function pytestAvailable(python: string): boolean {
  const r = spawnSync(python, ["-c", "import pytest"], { encoding: "utf8", timeout: 30_000 });
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
    testLocation: { testDir: "tests", testGlob: "test_*.py" },
  });
  assert(
    got.threw === undefined,
    `(1) real pytest accepts the probe: ${got.written[0] ?? "<nothing run>"}`,
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
    testLocation: { testDir: "tests", testGlob: "test_*.py" },
    limits: { timeoutMs: 60_000, env: { ...process.env, PYTHONPATH: ".pi" } },
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
    { cwd: dir, encoding: "utf8", timeout: 120_000 },
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
