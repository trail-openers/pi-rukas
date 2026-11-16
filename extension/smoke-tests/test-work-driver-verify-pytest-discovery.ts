#!/usr/bin/env bun
/**
 * #2282 — what the Python arm of `verifyCmdFor` discovers, and what it must not.
 *
 * Split out of `test-work-driver-verify.ts` (AGENTS.md §12 file-size limit); the
 * resolver itself and its precedence chain stay there, next to the package.json
 * and Cargo.toml arms it ranks against. What lives here is the whole Python
 * claim, in the two directions that matter:
 *
 *   - a `pyproject.toml` that names pytest MUST produce a command — the bug was
 *     a Python repo resolving to none, which makes the develop gate green on no
 *     evidence at all;
 *   - a tree that does not name pytest must produce NOTHING — inventing a gate
 *     would run a suite the project never asked for, and the file-count of a
 *     directory is not a statement of intent.
 *
 * The interpreter form is asserted literally (`python3 -m pytest -q`, `uv run
 * pytest -q`) rather than by shape: "any pytest-ish command" would still pass if
 * the arm regressed to a bare `python`, which is the spelling that cannot be
 * resolved on a host with only `python3`.
 *
 * Each negative case gets its own directory on purpose. A shared tree carries
 * the previous case's manifest into the next one, and then every "no command"
 * assertion is judged against a repo that actually has one — a green that means
 * nothing.
 */

import fsSync from "node:fs";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { verifyCmdFor } from "../src/work-driver-verify.ts";

let exit = 0;
function assert(cond: boolean, msg: string): void {
  if (cond) console.log(`✓ ${msg}`);
  else {
    console.error(`✗ ${msg}`);
    exit = 1;
  }
}

{
  // The resolver's positive arm: every manifest spelling that counts, the two
  // interpreter forms, and the precedence chain over the arms above it.
  // #2282 — the Python arm. pyproject.toml is a manifest the way Cargo.toml
  // is: it must produce a command, or the develop gate runs nothing and the
  // child is told to rely on the change being correct.
  const pyDir = mkdtempSync(path.join(tmpdir(), "verify-cmd-py-"));
  try {
    fsSync.writeFileSync(
      path.join(pyDir, "pyproject.toml"),
      '[tool.pytest.ini_options]\ntestpaths = ["tests"]\n',
    );
    fsSync.mkdirSync(path.join(pyDir, "tests"));
    fsSync.writeFileSync(
      path.join(pyDir, "tests", "test_ok.py"),
      "def test_ok():\n    assert True\n",
    );
    assert(
      (await verifyCmdFor(pyDir)) === "python3 -m pytest -q",
      "verifyCmdFor: pyproject with pytest, no uv.lock → python3 -m pytest -q",
    );
    fsSync.writeFileSync(
      path.join(pyDir, "pyproject.toml"),
      '[tool.pytest.ini_options]\ntestpaths = ["tests"]\n\n[tool.ruff]\nline-length = 100\n',
    );
    assert(
      (await verifyCmdFor(pyDir)) === "ruff check . && python3 -m pytest -q",
      "verifyCmdFor: ruff configured → ruff check . && python3 -m pytest -q",
    );
    // `ruff.toml` at the root configures the lint half.
    fsSync.writeFileSync(path.join(pyDir, "ruff.toml"), "line-length = 100\n");
    assert(
      (await verifyCmdFor(pyDir)) === "ruff check . && python3 -m pytest -q",
      "verifyCmdFor: ruff.toml at the root adds the lint half",
    );
    // And the predicate is the one `fromPython` has always used, carried
    // over untouched rather than widened here: an indented
    // `dependencies = ["ruff"]` entry does NOT match (`^ruff` is not
    // multiline-anchored), and widening it would move AGENTS.md's Testing
    // Standards section too, which is not this resolver's call.
    fsSync.rmSync(path.join(pyDir, "ruff.toml"));
    fsSync.writeFileSync(
      path.join(pyDir, "pyproject.toml"),
      '[project]\ndependencies = ["ruff"]\n\n[tool.pytest.ini_options]\n',
    );
    assert(
      (await verifyCmdFor(pyDir)) === "python3 -m pytest -q",
      "verifyCmdFor: a ruff dependency entry alone adds no lint half (the shared predicate's rule, unchanged)",
    );
    fsSync.writeFileSync(
      path.join(pyDir, "pyproject.toml"),
      '[tool.pytest.ini_options]\ntestpaths = ["tests"]\n\n[tool.ruff]\nline-length = 100\n',
    );
    // A uv project runs its tools through uv, so the pinned environment is
    // the one the gate judges.
    fsSync.writeFileSync(path.join(pyDir, "uv.lock"), "");
    assert(
      (await verifyCmdFor(pyDir)) === "uv run ruff check . && uv run pytest -q",
      "verifyCmdFor: uv.lock present → uv run ruff check . && uv run pytest -q",
    );
    fsSync.rmSync(path.join(pyDir, "uv.lock"));
    // package.json outranks the Python arm: a tooling manifest (docs build,
    // hooks) is still the project's own stated check.
    fsSync.writeFileSync(
      path.join(pyDir, "package.json"),
      JSON.stringify({ scripts: { test: "vitest run" } }),
    );
    assert(
      (await verifyCmdFor(pyDir)) === "npm run test",
      "verifyCmdFor: package.json test script wins over pyproject",
    );
    // The explicit escape valve still wins over both, comments skipped.
    fsSync.mkdirSync(path.join(pyDir, ".pi"), { recursive: true });
    fsSync.writeFileSync(
      path.join(pyDir, ".pi", "verify-cmd"),
      "# operator's own gate\nmake check\n",
    );
    assert(
      (await verifyCmdFor(pyDir)) === "make check",
      "verifyCmdFor: .pi/verify-cmd wins over package.json AND pyproject",
    );
  } finally {
    rmSync(pyDir, { recursive: true, force: true });
  }

}

{
  // What is NOT a discoverable Python gate. Three trees, each written for
  // its own claim, because a shared directory quietly carries the previous
  // case's manifest and then every "no command" assertion is judged against
  // a repo that has one.
  { // A manifest that names pytest nowhere and holds neither conventional
    // pytest file: nothing to derive, and inventing a command would run a
    // suite the project never asked for.
    const dir = mkdtempSync(path.join(tmpdir(), "verify-cmd-py-none-"));
    try {
      fsSync.writeFileSync(path.join(dir, "pyproject.toml"), '[project]\nname = "x"\n');
      assert(
        (await verifyCmdFor(dir)) === undefined,
        "verifyCmdFor: pyproject naming no pytest → undefined (no invented gate)",
      );
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }
  { // `conftest.py` is one of pytest's two conventional files and is a signal
    // `fromPython` has always honoured — but only beside a manifest, which is
    // the signal every arm of this resolver reads.
    const dir = mkdtempSync(path.join(tmpdir(), "verify-cmd-py-conftest-"));
    try {
      fsSync.writeFileSync(path.join(dir, "conftest.py"), "import pytest\n");
      assert(
        (await verifyCmdFor(dir)) === undefined,
        "verifyCmdFor: conftest.py with no pyproject.toml → undefined (manifest is the signal)",
      );
      fsSync.writeFileSync(path.join(dir, "pyproject.toml"), '[project]\nname = "x"\n');
      assert(
        (await verifyCmdFor(dir)) === "python3 -m pytest -q",
        "verifyCmdFor: pyproject plus a root conftest.py → python3 -m pytest -q",
      );
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }
  { // A declared pytest dependency IS the manifest naming pytest, so it
    // counts with no `[tool.pytest.*]` table and no conventional file.
    const dir = mkdtempSync(path.join(tmpdir(), "verify-cmd-py-dep-"));
    try {
      fsSync.writeFileSync(
        path.join(dir, "pyproject.toml"),
        '[project]\nname = "x"\ndependencies = ["pytest>=8"]\n',
      );
      assert(
        (await verifyCmdFor(dir)) === "python3 -m pytest -q",
        "verifyCmdFor: pytest as a declared dependency → python3 -m pytest -q",
      );
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }

}

console.log(`\nexit ${String(exit)}`);
process.exit(exit);
