#!/usr/bin/env bun
/**
 * #2282 — what a `pyproject.toml` must say before it counts as a Python gate.
 *
 * These two predicates have two callers and the second one is a gate: the
 * AGENTS.md renderer treats a miss as a cosmetic omission, but
 * `verifyCmdFor`'s Python arm turns a hit into `python3 -m pytest -q` in the
 * develop step. So a false positive is not a cosmetic any more — a manifest
 * that merely *mentions* pytest in a comment produced a command, that command
 * collected nothing, pytest's exit 5 rejected, and the develop gate parked the
 * cycle with `[baseline-red]` as its first evidence line: a blame on the base
 * commit for a suite the repository never had.
 *
 * A substring regex cannot draw that line, because TOML comments and string
 * values are prose. The predicates walk the document instead, so these cases
 * are the seam: every POSITIVE is a manifest that asks for the tool, every
 * NEGATIVE is one that only talks about it. A case that passes under the old
 * `/pytest|pytest\.ini|^\s*\[tool\.pytest/` is not evidence of anything, so the
 * negatives below are chosen to be exactly the shapes that regex matched.
 */

import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import {
  pyprojectConfiguresRuff,
  pyprojectNamesPytest,
} from "../src/agents-md/pyproject.ts";

let exit = 0;
function assert(cond: boolean, msg: string): void {
  if (cond) console.log(`✓ ${msg}`);
  else {
    console.error(`✗ ${msg}`);
    exit = 1;
  }
}

/** A root with no conventional files: only the manifest can make the call. */
const EMPTY_ROOT = mkdtempSync(path.join(tmpdir(), "pyproject-predicate-"));

// The shapes that USED to match `/pytest|pytest\.ini|^\s*\[tool\.pytest/` and
// must now read as prose, each written the way a real manifest writes it.
const PYTEST_PROSE: [string, string][] = [
  ["a TOML comment", "# run pytest for the python helpers\n[build-system]\nrequires = ['setuptools']\n"],
  ["a keywords value", '[project]\nname = "x"\nkeywords = ["pytest", "cli"]\n'],
  ["a readme value", '[project]\nname = "x"\nreadme = "pytest.md"\n'],
  ["an author name", '[[project.authors]]\nname = "pytest team"\n'],
  ["a description", '[project]\ndescription = "a pytest plugin host"\n'],
  ["a classifier", '[project]\ndependencies = ["flask"]\nclassifiers = ["Framework :: Pytest"]\n'],
  ["a comment inside a deps array", '[project]\ndependencies = [\n    # pytest is nice\n    "black",\n]\n'],
  [
    "a script entry point",
    '[project]\ndependencies = ["flask"]\n\n[project.scripts]\npytest-lint = "pkg:main"\n',
  ],
  [
    "an array-of-tables metadata block",
    '[project]\ndependencies = ["flask"]\n\n[[tool.uv.dependency-metadata]]\nname = "x"\nrequires = ["pytest"]\n',
  ],
  [
    "an inline table field",
    '[project]\ndependencies = [{ name = "pytest" }]\n',
  ],
];
for (const [why, manifest] of PYTEST_PROSE) {
  assert(
    pyprojectNamesPytest(manifest, EMPTY_ROOT) === false,
    `pytest: ${why} is prose, not a dependency — no gate`,
  );
}

// Every spelling of "this project declares pytest", across the manifests real
// Python repos use.
const PYTEST_DECLARED: [string, string][] = [
  ["a [tool.pytest.ini_options] table", '[tool.pytest.ini_options]\ntestpaths = ["tests"]\n'],
  ["a PEP 621 dependency", '[project]\ndependencies = ["pytest>=8"]\n'],
  [
    "a multi-line PEP 621 array",
    '[project]\ndependencies = [\n    "pydantic>=2",\n    "pytest>=8",\n]\n',
  ],
  ["[dependency-groups]", '[dependency-groups]\ndev = ["pytest>=8"]\n'],
  ["[project.optional-dependencies]", '[project.optional-dependencies]\ntest = ["pytest>=7"]\n'],
  ["a poetry pin", '[tool.poetry.group.dev.dependencies]\npytest = "^8"\n'],
  ["a pdm dev-dependency", '[tool.pdm.dev-dependencies]\ndev = ["pytest"]\n'],
  ["a single-quoted entry", "[project]\ndependencies = ['pytest']\n"],
  ["an extras entry", '[project]\ndependencies = ["pytest[toml]>=7"]\n'],
  ["a pytest-cov entry", '[project]\ndependencies = ["pytest-cov"]\n'],
];
for (const [why, manifest] of PYTEST_DECLARED) {
  assert(
    pyprojectNamesPytest(manifest, EMPTY_ROOT) === true,
    `pytest: ${why} is the manifest asking for pytest — gate`,
  );
}

// The ruff half, whose shipped predicate (`/^ruff|\[tool\.ruff\]/`, no `m`
// flag) matched only a manifest that STARTS with the word, so the realistic
// dependency spelling silently lost the lint half while docs promised it.
const RUFF_CONFIGURED: [string, string][] = [
  ["a [tool.ruff] table", '[project]\nname = "x"\n\n[tool.ruff]\nline-length = 100\n'],
  ["[tool.ruff.lint] alone", '[tool.ruff.lint]\nselect = ["E"]\n'],
  [
    "a ruff dependency entry",
    '[project]\ndependencies = [\n    "pytest>=8",\n    "ruff>=0.6",\n]\n',
  ],
];
for (const [why, manifest] of RUFF_CONFIGURED) {
  assert(
    pyprojectConfiguresRuff(manifest, EMPTY_ROOT) === true,
    `ruff: ${why} configures the lint half`,
  );
}
const RUFF_ABSENT: [string, string][] = [
  ["a prose mention", '[project]\ndependencies = ["black"]\ndescription = "ruff compatible"\n'],
  ["a comment", '# run ruff over the python helpers\n[project]\ndependencies = ["black"]\n'],
  ["no ruff at all", '[project]\ndependencies = ["black"]\n'],
];
for (const [why, manifest] of RUFF_ABSENT) {
  assert(
    pyprojectConfiguresRuff(manifest, EMPTY_ROOT) === false,
    `ruff: ${why} does not configure the lint half`,
  );
}

// `ruff.toml` / `.ruff.toml` at the root are ruff's own filenames: a file the
// project placed there is intent, and neither regex could see them.
const withFile = (name: string): string => {
  const dir = mkdtempSync(path.join(tmpdir(), "pyproject-ruff-file-"));
  writeFileSync(path.join(dir, name), "line-length = 100\n");
  return dir;
};
for (const name of ["ruff.toml", ".ruff.toml"]) {
  const dir = withFile(name);
  try {
    assert(
      pyprojectConfiguresRuff('[project]\ndependencies = ["pytest"]\n', dir) === true,
      `ruff: a root ${name} configures the lint half`,
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

rmSync(EMPTY_ROOT, { recursive: true, force: true });

console.log(`\nexit ${String(exit)}`);
process.exit(exit);
