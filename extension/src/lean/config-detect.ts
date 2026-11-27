/**
 * lean/config-detect — the verify tiers a repository with neither `.pi/work.json` nor `.pi/verify-cmd`
 * implies, behind `PI_ENSEMBLE_LEAN_DETECT_VERIFY=1`.
 *
 * Off (unset, or anything but `1`) nothing here runs and such a repository keeps `ready`'s setup
 * refusal, which a host keys its fallback driver on; turning it on bypasses that refusal for every
 * repository detection answers.
 *
 * Two families only, each with a runner that takes ONE file path: Python with a pytest signal, and
 * Node with a `package.json` test script, whose lockfile picks the package manager. Both families,
 * neither, a pyproject with no pytest signal, or a package.json with no test script detect nothing,
 * and the reason rides into `ready`'s setup rule. Detection never invents a fast tier. The caller's
 * readers answer at the run's base commit, so every step that re-loads the config gets one answer.
 */
import type { WorkConfig } from "./config.ts";

/** `1` arms detection; every other value keeps the setup refusal byte for byte. */
export function leanDetectVerifyEnabled(): boolean {
  return process.env.PI_ENSEMBLE_LEAN_DETECT_VERIFY === "1";
}

/** What detection set, and the sentence that names it (or why nothing was set). */
export interface Detection {
  verify: WorkConfig["verify"];
  detection: string;
}

/** The `scripts.test` of a package.json, or undefined for none, `npm init`'s always-failing placeholder, or an unreadable file. */
function testScript(pkg: string): string | undefined {
  try {
    const test = (JSON.parse(pkg) as { scripts?: { test?: unknown } } | null)?.scripts?.test;
    return typeof test === "string" && test.trim() !== "" && !/no test specified/.test(test)
      ? test
      : undefined;
  } catch {
    return undefined;
  }
}

export async function detectVerify(
  exists: (path: string) => Promise<boolean>,
  read: (path: string) => Promise<string | undefined>,
): Promise<Detection> {
  const pyproject = await read("pyproject.toml");
  const ini = await exists("pytest.ini");
  const conftest = await exists("conftest.py");
  const pkg = await read("package.json");
  const none = (why: string): Detection => ({
    verify: {},
    detection: `PI_ENSEMBLE_LEAN_DETECT_VERIFY detected no runner (${why}); commit .pi/work.json`,
  });
  // No detected command spells the pinned compiler the canary keys on, so the canary checks none.
  const found = (from: string, full: string, test: string, testGlob: string) => ({
    verify: { full, test, testDir: "tests", testGlob },
    detection: `full tier \`${full}\` and verify.test \`${test}\` detected from ${from}; the compiler-integrity canary did not check them`,
  });
  const python = pyproject !== undefined || ini || conftest;
  if (python && pkg !== undefined) return none("both a Python and a Node manifest");
  if (python) {
    const from = ini ? "pytest.ini" : conftest ? "conftest.py" : "pyproject.toml";
    if (from === "pyproject.toml" && !/pytest/.test(pyproject ?? ""))
      return none("pyproject.toml names no pytest");
    return found(from, "pytest -q", "pytest -q {file}", "test_*.py");
  }
  if (pkg === undefined) return none("no pytest signal and no package.json");
  if (testScript(pkg) === undefined) return none("package.json has no test script");
  const pm =
    (await exists("bun.lock")) || (await exists("bun.lockb"))
      ? "bun"
      : (await exists("pnpm-lock.yaml"))
        ? "pnpm"
        : (await exists("yarn.lock"))
          ? "yarn"
          : "npm";
  const ts = await exists("tsconfig.json");
  const test = pm === "bun" ? "bun test {file}" : `${pm} test -- {file}`;
  return found("package.json", `${pm} test`, test, ts ? "*.test.ts" : "*.test.js");
}
