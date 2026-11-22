#!/usr/bin/env bun
/**
 * lean/config-detect — `PI_ENSEMBLE_LEAN_DETECT_VERIFY=1` detects verify tiers at the base commit
 * for a repository with neither `.pi/work.json` nor `.pi/verify-cmd`, and nothing else changes.
 *
 * Every case is a real temp git repo, because "present at the base" is a git fact. The off arm comes
 * first: a host falls back to another driver on `ready`'s setup refusal, so unset and any value but
 * `1` must leave both the loaded config and the refusal byte-identical.
 *
 * Mutants observed red: drop the pytest regex; swap the bun/npm template; let detection run with
 * `.pi/verify-cmd` present; drop the reason from the setup rule or the roster rule; drop the
 * detection note from the green verify reason; read the switch as `!== "0"`; accept the `npm init`
 * placeholder; drop the canary note from a TypeScript tier; read `.pi/verify-cmd` at HEAD with the switch on.
 */

import { execFileSync } from "node:child_process";
import { rmSync } from "node:fs";
import { execp } from "../src/exec.ts";
import { testLocationOf, validateTestGlob } from "../src/lean/config-test-location.ts";
import {
  type WorkConfig,
  defaultConfig,
  loadWorkConfig,
  validateTestRunner,
} from "../src/lean/config.ts";
import { NO_TEST_RUNNER_RULE, readySetup } from "../src/lean/ready-setup.ts";
import { namingLine } from "../src/lean/specify-prompt.ts";
import { verifyCmdAtHead } from "../src/lean/verify-reads.ts";
import { tiersOf } from "../src/lean/verify-steps.ts";
import { withEnv } from "./lib/env-scope.ts";
import { ROOTS, makeRepo } from "./lib/lean-specify-fixture.ts";
import { runVerify } from "./lib/lean-verify-fixture.ts";

let exit = 0;
function assert(cond: boolean, msg: string): void {
  if (cond) console.log(`✓ ${msg}`);
  else {
    console.error(`✗ ${msg}`);
    exit = 1;
  }
}

const PYTEST_INI = { "pytest.ini": "[pytest]\n" };
const load = (files: Record<string, string>): Promise<WorkConfig> => {
  const { repoRoot, baseSha } = makeRepo({ "README.md": "x\n", ...files });
  return loadWorkConfig(execp, repoRoot, baseSha);
};
const pkg = (scripts: Record<string, string>) => JSON.stringify({ name: "p", scripts });

// ── Off: unset, `0` and `true` all keep the loader's defaults and the setup refusal verbatim.
for (const value of [undefined, "0", "true"]) {
  await withEnv({ PI_ENSEMBLE_LEAN_DETECT_VERIFY: value }, async () => {
    const cfg = await load(PYTEST_INI);
    assert(
      JSON.stringify(cfg) === JSON.stringify(defaultConfig()),
      `off (${value}): a pytest repo loads today's defaults`,
    );
    const setup = await readySetup(async () => cfg);
    assert(
      "rule" in setup && setup.rule === NO_TEST_RUNNER_RULE,
      `off (${value}): ready keeps the setup refusal byte for byte`,
    );
  });
}

await withEnv(
  { PI_ENSEMBLE_LEAN_DETECT_VERIFY: "1", PI_ENSEMBLE_LEAN_PROJECT_ROSTER: undefined },
  async () => {
    // ── Detected: each signal, the values, and the validators the loader holds a config to.
    const cases: [string, Record<string, string>, string, string, string][] = [
      ["pytest.ini", PYTEST_INI, "pytest -q", "pytest -q {file}", "test_*.py", false],
      ["conftest.py", { "conftest.py": "" }, "pytest -q", "pytest -q {file}", "test_*.py", false],
      [
        "pyproject [tool.pytest]",
        { "pyproject.toml": "[tool.pytest.ini_options]\n" },
        "pytest -q",
        "pytest -q {file}",
        "test_*.py",
      ],
      [
        "pyproject pytest dependency",
        { "pyproject.toml": '[project]\ndependencies = ["pytest>=8"]\n' },
        "pytest -q",
        "pytest -q {file}",
        "test_*.py",
      ],
      [
        "bun + tsconfig",
        { "package.json": pkg({ test: "bun test" }), "bun.lock": "{}", "tsconfig.json": "{}" },
        "bun test",
        "bun test {file}",
        "*.test.ts",
      ],
      [
        "bun.lockb",
        { "package.json": pkg({ test: "bun test" }), "bun.lockb": "\0" },
        "bun test",
        "bun test {file}",
        "*.test.js",
      ],
      [
        "pnpm",
        { "package.json": pkg({ test: "vitest" }), "pnpm-lock.yaml": "" },
        "pnpm test",
        "pnpm test -- {file}",
        "*.test.js",
      ],
      [
        "yarn",
        { "package.json": pkg({ test: "jest" }), "yarn.lock": "" },
        "yarn test",
        "yarn test -- {file}",
        "*.test.js",
      ],
      [
        "npm (no lockfile)",
        { "package.json": pkg({ test: "jest" }), "tsconfig.json": "{}" },
        "npm test",
        "npm test -- {file}",
        "*.test.ts",
      ],
    ];
    for (const [name, files, full, test, glob] of cases) {
      const cfg = await load(files);
      const v = cfg.verify;
      assert(
        v.full === full &&
          v.test === test &&
          v.testDir === "tests" &&
          v.testGlob === glob &&
          v.fast === undefined,
        `${name}: detects ${full} / ${test} / tests/${glob} (got ${JSON.stringify(v)})`,
      );
      assert(
        validateTestRunner(v.test ?? "") === undefined &&
          validateTestGlob(v.testGlob ?? "") === undefined,
        `${name}: the detected template and glob pass the loader's validators`,
      );
      const note = cfg.detection ?? "";
      const from = name.startsWith("pyproject")
        ? "pyproject.toml"
        : name.startsWith("py") || name.startsWith("conf")
          ? name
          : "package.json";
      assert(
        note.includes(`\`${full}\``) && note.includes(`detected from ${from}`),
        `${name}: the detection names the command and its manifest (${note})`,
      );
      assert(
        note.includes("canary did not check"),
        `${name}: the canary note is there, since no detected command reaches the canary`,
      );
      const setup = await readySetup(async () => cfg);
      assert(
        "config" in setup
          ? test.startsWith("pytest")
          : !test.startsWith("pytest") && setup.rule.endsWith(`; ${note}`),
        `${name}: ready passes a pytest runner; a Node runner meets the roster rule naming detection`,
      );
    }

    // ── The specify prompt's example test name follows the detected glob.
    const py = namingLine(testLocationOf((await load(PYTEST_INI)).verify));
    assert(
      py.includes("`tests/test_AC1-example.py`") && !py.includes(".ts`"),
      `the specify example follows test_*.py (${py})`,
    );

    // ── Not detected: each fails ready with the setup rule plus the reason, before any issue read.
    const refused: [string, Record<string, string>, string][] = [
      [
        "Python plus Node",
        { ...PYTEST_INI, "package.json": pkg({ test: "jest" }) },
        "both a Python and a Node",
      ],
      [
        "pyproject with no pytest",
        { "pyproject.toml": "[project]\nname = 'p'\n" },
        "names no pytest",
      ],
      [
        "package.json with no test script",
        { "package.json": pkg({ build: "tsc" }) },
        "no test script",
      ],
      [
        "npm init placeholder test script",
        { "package.json": pkg({ test: 'echo "Error: no test specified" && exit 1' }) },
        "no test script",
      ],
      ["Cargo.toml only", { "Cargo.toml": "[package]\n" }, "no package.json"],
      ["go.mod only", { "go.mod": "module p\n" }, "no package.json"],
      ["empty repo", {}, "no package.json"],
    ];
    for (const [name, files, why] of refused) {
      const cfg = await load(files);
      const setup = await readySetup(async () => cfg);
      assert(
        "rule" in setup &&
          setup.rule.startsWith(NO_TEST_RUNNER_RULE) &&
          setup.rule.includes(why) &&
          setup.rule.includes("commit .pi/work.json"),
        `${name}: ready refuses naming why (${"rule" in setup ? setup.rule.slice(NO_TEST_RUNNER_RULE.length) : "passed"})`,
      );
    }

    // ── Precedence: work.json beats verify-cmd beats detection, all at the base commit.
    const committed = await load({
      ...PYTEST_INI,
      ".pi/work.json": JSON.stringify({ version: 1, verify: { test: "sh {file}" } }),
    });
    assert(
      committed.verify.test === "sh {file}" &&
        committed.verify.full === undefined &&
        committed.detection === undefined,
      "work.json beats detection",
    );
    const viaCmd = await load({ ...PYTEST_INI, ".pi/verify-cmd": "make check\n" });
    assert(
      viaCmd.verify.full === "make check" &&
        viaCmd.verify.test === undefined &&
        viaCmd.detection === undefined,
      ".pi/verify-cmd beats detection",
    );

    // ── A HEAD that commits its own .pi/verify-cmd changes neither verify's tiers nor ci's full tier.
    const { repoRoot, baseSha } = makeRepo(PYTEST_INI);
    execFileSync(
      "sh",
      [
        "-c",
        "mkdir .pi && echo 'echo pwned' > .pi/verify-cmd && git add -A && git -c user.name=t -c user.email=t@t commit -qm head",
      ],
      { cwd: repoRoot },
    );
    const head = execFileSync("git", ["rev-parse", "HEAD"], {
      cwd: repoRoot,
      encoding: "utf8",
    }).trim();
    const atBase = await loadWorkConfig(execp, repoRoot, baseSha);
    const headCmd = (await loadWorkConfig(execp, repoRoot, head)).verify.full;
    assert(headCmd === "echo pwned", "the fixture's HEAD does carry a different .pi/verify-cmd");
    assert(
      (await verifyCmdAtHead(execp, repoRoot, head, baseSha)) === undefined,
      "verify reads .pi/verify-cmd at the base, so HEAD's file is not the command it is judged by",
    );
    await withEnv({ PI_ENSEMBLE_LEAN_DETECT_VERIFY: undefined }, async () =>
      assert(
        (await verifyCmdAtHead(execp, repoRoot, head, baseSha)) === "echo pwned",
        "off: verify keeps reading .pi/verify-cmd at HEAD",
      ),
    );
    assert(
      JSON.stringify(tiersOf(atBase.verify, headCmd)) === JSON.stringify([["full", "pytest -q"]]),
      "verify runs the base answer, not HEAD's .pi/verify-cmd",
    );
    assert(
      (atBase.verify.full ?? headCmd) === "pytest -q",
      "ci's full tier (config.verify.full before the read) is the base answer",
    );
  },
);

// ── The green verify reason, which the PR body prints, names the detected tier.
const detection =
  "full tier `pytest -q` and verify.test `pytest -q {file}` detected from pytest.ini; the compiler-integrity canary did not check them";
const green = await runVerify({ issue: 2016, implement: true, detection });
assert(
  green.outcome?.kind === "green" && (green.outcome.reason ?? "").includes(detection),
  `the green verify reason carries the detection (${(green.outcome?.reason ?? green.threw?.message ?? "").slice(0, 200)})`,
);

for (const dir of ROOTS) rmSync(dir, { recursive: true, force: true });
process.exit(exit);
