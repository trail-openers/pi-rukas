/**
 * lean/config — `.pi/work.json`, read at the cycle's base commit.
 *
 * Same rule as the old driver's doctrine read (#406): configuration that
 * decides what a run may do is read with `git show <baseSha>:.pi/work.json`,
 * never from the working tree. A run that edited its own config would
 * otherwise be judged by the bytes it wrote.
 *
 * Two outcomes for a missing file and a broken one, kept deliberately apart:
 *   - absent  → defaults (a repo with no config is normal)
 *   - invalid → `LeanConfigError` (a typo'd budget must not silently become
 *     "no budget", which is the expensive direction to be wrong)
 *
 * The defaults carry no budgets for states that phase 1 has no handler for
 * beyond handback, and a wall clock for `ci` where a stalled watch is the
 * whole risk.
 */

import type { execp } from "../exec.ts";
import { validateTestDir, validateTestGlob } from "./config-test-location.ts";

export interface Budget {
  turns: number;
  tokens: number;
  minutes: number;
}

/** 0 means "unbounded" for turns and tokens, "no bound" is never minutes. */
export interface WorkConfig {
  version: 1;
  autoMerge: boolean;
  /**
   * `test` is the per-file runner template the `specify` step uses to prove a
   * test red on the base: it must contain exactly one whole-word `{file}`,
   * which the step replaces with the test file's path (e.g. `bun run {file}`).
   * The template is executed as an executable plus argv, never through a
   * shell, so `validateTestRunner` refuses the shell-shaped strings that
   * would only mean something if it were.
   *
   * `testDir` is a repo-relative DIRECTORY (`extension/smoke-tests`) and
   * `testGlob` is a basename pattern with exactly one `*` (`test-*.ts`): where
   * the adversary's acceptance tests live and what they are called. Both
   * absent — the default — means today's behaviour: the child may write its
   * tests anywhere in the worktree. When both are set the prompts name the
   * folder and the boundary refuses a submitted test outside it, so a project's
   * own CI is the thing that runs the frozen tests.
   */
  verify: {
    fast?: string;
    full?: string;
    test?: string;
    testDir?: string;
    testGlob?: string;
  };
  budgets: Partial<Record<string, Budget>>;
}

/** A config that exists but cannot be read. Never collapsed into a default. */
export class LeanConfigError extends Error {
  override readonly name = "LeanConfigError";
}

/**
 * The placeholder a `verify.test` template carries. ONE name for it: the
 * validator here, the prompt that explains it to the child and the renderer
 * that substitutes it all read this constant, so the string cannot drift
 * between the three.
 */
export const TEST_RUNNER_PLACEHOLDER = "{file}";

/**
 * The one spelling of the config's path, for a gate that wants to read the
 * same bytes the loader does (`test-lean-work-config-committed.ts`).
 * `loadWorkConfig` deliberately does NOT interpolate it: the ref it passes to
 * `gitShow` is a literal, so the read stays visible to `test-headless-inputs.ts`
 * (a committed config listed in `HEADLESS_FILES` but unreadable in `src/` is
 * exactly what that gate exists to catch).
 */
export const WORK_CONFIG_FILE = ".pi/work.json";

/** The executor seam: same signature as `execp`, injected so tests stay local. */
export type ConfigExec = typeof execp;

/** Ceiling for one committed config/verify-cmd blob; overflow is its own error class. */
const GIT_SHOW_MAX_BUFFER = 1024 * 1024;

/**
 * Characters a runner template may never contain. Each one is a shell
 * metacharacter (`;` `&` `|` `` ` `` `$` `<` `>` `"` `'` `\`) or a newline:
 * present anywhere, they say the author meant the template to be read by a
 * shell, which is not how the step executes it. Refusing them at the config
 * boundary is what makes "no shell" a fact rather than an intention — a
 * template like `sh -c "x {file}"` or `rm {file}; ls` would otherwise reach
 * the executor as an argument a shell happily re-parses.
 */
const TEST_RUNNER_FORBIDDEN = /[;&|`$<>"'\\\n\r]/;

/**
 * Why this `verify.test` template is not usable, or undefined when it is.
 *
 * Three rules, all mechanical:
 *   - it must carry {@link TEST_RUNNER_PLACEHOLDER} EXACTLY once — twice and
 *     the second occurrence is a bug the config author should see rather than
 *     a silently duplicated path;
 *   - every occurrence must be a WHOLE whitespace-separated word, so
 *     `bun run test-{file}.ts` is refused rather than silently renaming the
 *     file it is supposed to be running; and
 *   - no shell metacharacter anywhere (see {@link TEST_RUNNER_FORBIDDEN}).
 */
export function validateTestRunner(template: string): string | undefined {
  // The metacharacter rule FIRST: a template carrying one is a template its
  // author meant for a shell, and saying so is the useful diagnosis even when
  // the placeholder also happens to be glued to something (`sh -c "x {file}"`
  // is both, and "go away from the shell" is the fix, not "add a space").
  if (TEST_RUNNER_FORBIDDEN.test(template))
    return ".pi/work.json verify.test is run without a shell: ; & | ` $ < > \" ' \\ and newline are not allowed";
  const count = template.split(TEST_RUNNER_PLACEHOLDER).length - 1;
  if (count === 0)
    return `.pi/work.json verify.test must contain the literal ${TEST_RUNNER_PLACEHOLDER}`;
  if (count > 1)
    return `.pi/work.json verify.test must contain ${TEST_RUNNER_PLACEHOLDER} exactly once, found ${count}`;
  const wholeWord = template.split(/\s+/).includes(TEST_RUNNER_PLACEHOLDER);
  if (!wholeWord)
    return `.pi/work.json verify.test must use ${TEST_RUNNER_PLACEHOLDER} as a whole word, not glued to other characters`;
  return undefined;
}

/** Did this rejection come from a stream breaking its buffer, not from git? */
function isBufferOverflow(err: unknown): boolean {
  const e = err as { code?: number | null; killed?: boolean; message?: string; stderr?: string };
  if (typeof e?.message === "string" && /maxBuffer/i.test(e.message)) return true;
  return e?.killed === true && e.code === null && /maxBuffer/i.test(e.stderr ?? "");
}

/**
 * The git object type at `ref` (`blob`, `tree`, `commit`, `tag`, `object`),
 * or undefined when the path is not in that commit.
 *
 * `cat-file -t` exits 128 for an unknown path, so a missing file and a bad
 * sha both land in the "absent" branch — which is what a config loader wants
 * for a missing file, and the subsequent `git show` is what still surfaces a
 * genuinely broken repository.
 */
async function gitType(
  exec: ConfigExec,
  repoRoot: string,
  ref: string,
): Promise<string | undefined> {
  try {
    const { stdout } = await exec("git", {
      argv: ["cat-file", "-t", ref],
      cwd: repoRoot,
      timeout: 30_000,
    });
    const type = stdout.trim();
    return type === "" ? undefined : type;
  } catch {
    return undefined;
  }
}

/**
 * Per-state ceilings. States not listed have none yet — a phase that adds a
 * handler adds its budget with it, rather than inheriting a number nobody
 * chose.
 */
export const DEFAULT_BUDGETS: Readonly<Record<string, Budget>> = Object.freeze({
  specify: Object.freeze({ turns: 80, tokens: 10_000_000, minutes: 20 }),
  build: Object.freeze({ turns: 150, tokens: 20_000_000, minutes: 45 }),
  challenge: Object.freeze({ turns: 60, tokens: 8_000_000, minutes: 15 }),
  review: Object.freeze({ turns: 40, tokens: 6_000_000, minutes: 15 }),
  ci: Object.freeze({ turns: 0, tokens: 0, minutes: 30 }),
});

/** Defaults for a repo with no `.pi/work.json`: nothing enabled, nothing generous. */
export function defaultConfig(verifyFull?: string): WorkConfig {
  return {
    version: 1,
    autoMerge: false,
    verify: verifyFull === undefined ? {} : { full: verifyFull },
    budgets: { ...DEFAULT_BUDGETS },
  };
}

/** First non-comment, non-blank line — the same reader the old verify-cmd used. */
function firstLine(content: string): string | undefined {
  return content
    .split(/\r?\n/)
    .map((l) => l.trim())
    .find((l) => l.length > 0 && !l.startsWith("#"));
}

/** A budget whose members are all non-negative integers, or undefined to skip. */
function checkBudget(where: string, v: unknown): string | undefined {
  if (v === undefined) return undefined;
  if (typeof v !== "object" || v === null || Array.isArray(v)) return `${where} must be an object`;
  const b = v as Record<string, unknown>;
  for (const key of ["turns", "tokens", "minutes"] as const) {
    const n = b[key];
    if (n === undefined) continue;
    if (typeof n !== "number" || !Number.isFinite(n) || n < 0 || !Number.isInteger(n))
      return `${where}.${key} must be a non-negative integer`;
  }
  return undefined;
}

/** The whole schema. Returns the reason the file is invalid, or undefined. */
function validate(obj: unknown): string | undefined {
  if (typeof obj !== "object" || obj === null || Array.isArray(obj))
    return ".pi/work.json must be a JSON object";
  const o = obj as Record<string, unknown>;
  if (o.version !== 1) return ".pi/work.json version must be 1";
  if (o.autoMerge !== undefined && typeof o.autoMerge !== "boolean")
    return ".pi/work.json autoMerge must be a boolean";
  if (o.verify !== undefined) {
    if (typeof o.verify !== "object" || o.verify === null || Array.isArray(o.verify))
      return ".pi/work.json verify must be an object";
    const v = o.verify as Record<string, unknown>;
    for (const key of ["fast", "full", "test", "testDir", "testGlob"] as const) {
      if (v[key] !== undefined && typeof v[key] !== "string")
        return `.pi/work.json verify.${key} must be a string`;
    }
    // The test location is a PAIR: prompts name both the folder and the naming
    // pattern, and the boundary refuses on both. One without the other is a
    // config that says half of what it means, so it is refused here rather than
    // left for a step to guess which half the author meant.
    if (v.testDir !== undefined && v.testGlob === undefined)
      return ".pi/work.json verify.testDir requires verify.testGlob (the file-name pattern, e.g. test-*.ts)";
    if (v.testGlob !== undefined && v.testDir === undefined)
      return ".pi/work.json verify.testGlob requires verify.testDir (the directory the tests live in)";
    if (typeof v.testDir === "string") {
      const reason = validateTestDir(v.testDir);
      if (reason !== undefined) return reason;
    }
    if (typeof v.testGlob === "string") {
      const reason = validateTestGlob(v.testGlob);
      if (reason !== undefined) return reason;
    }
    // The runner template is a template: without exactly one whole-word
    // placeholder the step cannot name the file it is running, and would run
    // the same command for every test and call the result a proof.
    if (typeof v.test === "string") {
      const reason = validateTestRunner(v.test);
      if (reason !== undefined) return reason;
    }
  }
  if (o.budgets !== undefined) {
    if (typeof o.budgets !== "object" || o.budgets === null || Array.isArray(o.budgets))
      return ".pi/work.json budgets must be an object";
    for (const [state, budget] of Object.entries(o.budgets as Record<string, unknown>)) {
      const reason = checkBudget(`.pi/work.json budgets.${state}`, budget);
      if (reason) return reason;
    }
  }
  return undefined;
}

/**
 * Read one blob at a commit. `undefined` for "that path is not in that commit".
 *
 * "Not in that commit" has three shapes git reports differently, and all
 * three mean the same thing to a caller that wants defaults: the path is
 * absent (`git show` exits 128), the path is a *tree* rather than a file
 * (`git show` exits 0 and prints a listing, so the bytes would otherwise
 * reach the JSON parser and be reported as a typo'd config), and the path is
 * a symlink. `cat-file -t` is asked first precisely because it separates the
 * second from the first instead of leaving it to be guessed at from stdout.
 */
async function gitShow(
  exec: ConfigExec,
  repoRoot: string,
  ref: string,
): Promise<string | undefined> {
  const type = await gitType(exec, repoRoot, ref);
  if (type === undefined) return undefined;
  if (type !== "blob") return undefined;
  try {
    const { stdout } = await exec("git", {
      argv: ["show", ref],
      cwd: repoRoot,
      timeout: 30_000,
      maxBuffer: GIT_SHOW_MAX_BUFFER,
    });
    return stdout;
  } catch (err) {
    // A blob the reader could not hold is an infra failure, not a config
    // problem: a 2 MB committed file must not be reported as "not valid
    // JSON", because the operator would go looking for a typo in a file the
    // driver simply refused to read.
    if (isBufferOverflow(err))
      throw new LeanConfigError(
        `could not read ${ref}: larger than the ${GIT_SHOW_MAX_BUFFER} byte read limit`,
      );
    // Exit 128 with "does not exist" is an absent file; anything else (a bad
    // sha, no git, a locked index) is a real failure the caller must see.
    const e = err as { code?: number | null; stderr?: string; message?: string };
    const detail = `${e.stderr ?? ""}${e.message ?? ""}`;
    if (e.code === 128 || /does not exist|exists on disk|not in this repository/i.test(detail))
      return undefined;
    throw new LeanConfigError(`could not read ${ref}: ${detail.trim().slice(0, 200)}`);
  }
}

/**
 * Load the run's config from the base commit.
 *
 * `baseSha` is required rather than "current": the caller resolved the
 * mainline sha for the cycle and every read in the run is against that one
 * commit, so config, doctrine and code all describe the same tree.
 */
export async function loadWorkConfig(
  exec: ConfigExec,
  repoRoot: string,
  baseSha: string,
): Promise<WorkConfig> {
  const raw = await gitShow(exec, repoRoot, `${baseSha}:.pi/work.json`);
  if (raw === undefined) {
    // No config: fall back to the committed .pi/verify-cmd for the full tier,
    // which is the file the old driver's ci step already used.
    const verifyCmd = await gitShow(exec, repoRoot, `${baseSha}:.pi/verify-cmd`);
    const full = verifyCmd === undefined ? undefined : firstLine(verifyCmd);
    return defaultConfig(full);
  }
  let obj: unknown;
  try {
    obj = JSON.parse(raw);
  } catch (err) {
    throw new LeanConfigError(`.pi/work.json is not valid JSON: ${(err as Error).message}`);
  }
  const reason = validate(obj);
  if (reason) throw new LeanConfigError(reason);
  const o = obj as unknown as Partial<WorkConfig> & { version: 1 };
  return {
    version: 1,
    autoMerge: o.autoMerge ?? false,
    verify: { ...(o.verify ?? {}) },
    budgets: { ...DEFAULT_BUDGETS, ...(o.budgets ?? {}) },
  };
}
