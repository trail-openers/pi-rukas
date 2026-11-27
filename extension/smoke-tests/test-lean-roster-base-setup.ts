#!/usr/bin/env bun
/**
 * The roster's base run happens in a tree provisioned like the run's own worktree: the project's
 * `.pi/worktree-setup` runs there too, behind `PI_ENSEMBLE_LEAN_ROSTER_BASE_SETUP` (off only on `"0"`).
 *
 * The regression this pins: a project whose tests need what its setup hook generates. Without the
 * hook, the base checkout fails that test for want of the generated file, so a head that really
 * broke it reads as "failing at base too" and the roster excuses it — a green for a broken test.
 * With the hook, the base passes it and the head failure is the red that names it.
 */
import { readFileSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import { execp } from "../src/exec.ts";
import { leanRosterBaseSetupEnabled } from "../src/lean/roster-base-setup-switch.ts";
import { buildProjectRoster } from "../src/lean/verify-roster.ts";
import { withEnv } from "./lib/env-scope.ts";
import { makeAssert } from "./lib/lean-engine-fixtures.ts";
import { ROOTS, git, makeRepo, outsideDir } from "./lib/lean-specify-fixture.ts";

const { assert, failures } = makeAssert();
const ENV = "PI_ENSEMBLE_LEAN_ROSTER_BASE_SETUP";

// `generated` passes only where the hook wrote gen.txt AND the code still says good.
const RUNNER = `#!/bin/sh
gen=failure; [ -f gen.txt ] && grep -q good src/value && gen=passed
case $gen in passed) g='/>' ;; *) g='><failure/></testcase>' ;; esac
printf '<testsuite><testcase classname="tests.t" name="plain"/><testcase classname="tests.t" name="generated"%s</testsuite>' "$g" > "$1"
`;

async function roster(hook = "echo generated > gen.txt", extra: Record<string, string> = {}) {
  const { repoRoot, baseSha } = makeRepo({
    ...extra,
    ".gitignore": ".worktrees/\ngen.txt\n",
    ".pi/worktree-setup": `#!/bin/sh\n${hook}\n`,
    "run-roster.sh": RUNNER,
    "src/value": "good\n",
    "tests/t.sh": "# the suite run-roster.sh reports on\n",
  });
  const wt = path.join(outsideDir(), "head");
  git(repoRoot, "worktree", "add", "-q", "-b", "head", wt, baseSha);
  writeFileSync(path.join(wt, "src/value"), "bad\n");
  writeFileSync(path.join(wt, "gen.txt"), "generated\n");
  git(wt, "commit", "-q", "-am", "head breaks generated");
  return buildProjectRoster({
    exec: execp,
    repoRoot,
    wt,
    baseSha,
    issue: 2410,
    timeoutMs: 30_000,
    config: { roster: "sh {dir}/run-roster.sh {report}", testDir: "tests", testGlob: "*.sh" },
    frozen: {},
  });
}

await withEnv({ [ENV]: undefined }, async () => {
  const r = await roster();
  assert(
    r.status === "red" && r.reason.includes("tests.t::generated"),
    `(on) a test the hook-provisioned base passes and head fails is red naming it (got ${r.status}: ${"reason" in r ? r.reason.slice(0, 160) : ""})`,
  );
});

// A manifest with no dependency tree at repoRoot is the hook-installs-from-scratch shape: the run's
// own worktree only traces that, so the base must not hand back on it either.
await withEnv({ [ENV]: undefined }, async () => {
  const r = await roster(undefined, { "pyproject.toml": "[project]\nname = 'p'\n" });
  assert(
    r.status === "red" && r.reason.includes("tests.t::generated"),
    `(on) a manifest with no dependency source at repoRoot still reads the red (got ${r.status}: ${"reason" in r ? r.reason.slice(0, 160) : ""})`,
  );
});

await withEnv({ [ENV]: undefined }, async () => {
  const r = await roster("exit 3");
  assert(
    r.status === "none" && r.reason.includes(".pi/worktree-setup failed"),
    `(on) a base whose setup hook fails hands back naming it (got ${r.status}: ${"reason" in r ? r.reason.slice(0, 200) : ""})`,
  );
});

await withEnv({ [ENV]: "0" }, async () => {
  const r = await roster();
  assert(
    r.status === "roster" && r.record.baseFailed.includes("tests.t::generated"),
    `(0) the symlink-only base fails the generated test too, so the head failure is excused (got ${r.status})`,
  );
});

for (const [v, on] of [
  [undefined, true],
  ["1", true],
  ["", true],
  ["false", true],
  ["0", false],
] as const)
  await withEnv({ [ENV]: v }, async () => {
    assert(leanRosterBaseSetupEnabled() === on, `${ENV}=${String(v)} reads ${String(on)}`);
  });

const doc = readFileSync(path.join(import.meta.dir, "../../docs/configuration.md"), "utf8");
assert(doc.includes(`\`${ENV}\``), `docs/configuration.md carries a row for ${ENV}`);

for (const dir of ROOTS) rmSync(dir, { recursive: true, force: true });
if (failures() !== 0) process.exit(1);
