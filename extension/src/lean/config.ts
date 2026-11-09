/**
 * lean/config — `.pi/work.json`, read at the cycle's base commit.
 *
 * Same rule as the driver's doctrine read: configuration that decides what a run may do is
 * read with `git show <baseSha>:.pi/work.json`, never from the working tree — a run that
 * edited its own config would otherwise be judged by the bytes it wrote.
 *
 * Two outcomes for a missing file and a broken one, kept deliberately apart:
 *   - absent  → defaults (a repo with no config is normal)
 *   - invalid → `LeanConfigError` (a typo'd budget must not silently become "no budget",
 *     which is the expensive direction to be wrong)
 *
 * The shipped table has a row for every state the machine can visit, including `review` and
 * `ci`. A key that is not in the table is refused at load, so there is no such thing as a
 * budget for an unbuilt state.
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
   * `test` is the per-file runner template the `specify` step uses to prove a test red on the
   * base: it must contain exactly one whole-word `{file}`, replaced with the test file's path.
   * It is executed as an executable plus argv, never through a shell, so `validateTestRunner`
   * refuses the shell-shaped strings.
   *
   * `testDir` is a repo-relative DIRECTORY and `testGlob` a basename pattern with exactly one
   * `*`: where the adversary's acceptance tests live and what they are called. Both absent —
   * the default — means the child may write its tests anywhere in the worktree. When both are
   * set the prompts name the folder and the boundary refuses a submitted test outside it.
   */
  verify: {
    fast?: string;
    full?: string;
    test?: string;
    testDir?: string;
    testGlob?: string;
    /**
     * A shell command the project runs over the whole tree to judge test-file CONTENT. `specify`
     * /`challenge` run it before freezing the candidate tests, and `verify` runs it when a
     * project tier is red at HEAD — because a frozen file a build round may not edit is a
     * contract nobody can repair. Unset: nothing runs. Mechanism: `lean/freeze-check.ts`.
     */
    freezeCheck?: string;
  };
  budgets: Partial<Record<string, Budget>>;
}

/** A config that exists but cannot be read. Never collapsed into a default. */
export class LeanConfigError extends Error {
  override readonly name = "LeanConfigError";
}

/**
 * The placeholder a `verify.test` template carries. ONE name for it: the validator here, the
 * prompt that explains it and the renderer that substitutes it all read this constant.
 */
export const TEST_RUNNER_PLACEHOLDER = "{file}";

/**
 * The one spelling of the config's path, for a gate that wants to read the same bytes the
 * loader does (`test-lean-work-config-committed.ts`). `loadWorkConfig` deliberately does NOT
 * interpolate it: the ref it passes to `gitShow` is a literal, so the read stays visible to
 * `test-headless-inputs.ts`.
 */
export const WORK_CONFIG_FILE = ".pi/work.json";

/** The executor seam: same signature as `execp`, injected so tests stay local. */
export type ConfigExec = typeof execp;

/** Ceiling for one committed config/verify-cmd blob; overflow is its own error class. */
const GIT_SHOW_MAX_BUFFER = 1024 * 1024;

/**
 * Characters a runner template may never contain. Each is a shell metacharacter or a newline:
 * present anywhere, they say the author meant the template for a shell, which is not how the
 * step executes it. Refusing them at the config boundary is what makes "no shell" a fact.
 */
const TEST_RUNNER_FORBIDDEN = /[;&|`$<>"'\\\n\r]/;

/**
 * Why this `verify.test` template is not usable, or undefined when it is.
 *
 * Three rules, all mechanical: it must carry {@link TEST_RUNNER_PLACEHOLDER} EXACTLY once;
 * every occurrence must be a WHOLE whitespace-separated word (so `bun run test-{file}.ts` is
 * refused rather than silently renaming the file); and no shell metacharacter anywhere.
 */
export function validateTestRunner(template: string): string | undefined {
  // The metacharacter rule FIRST: a template carrying one is one its author meant for a shell,
  // and saying so is the useful diagnosis even when the placeholder is also glued to something.
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
 * `cat-file -t` exits 128 for an unknown path, so a missing file and a bad sha both land in the
 * "absent" branch — which is what a config loader wants for a missing file, and the subsequent
 * `git show` still surfaces a genuinely broken repository.
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
 * Per-state ceilings, each bounding ONE CHILD and never a step's total. `tokens` counts all
 * usage including cache re-reads, so each row's tokens sit at or above its turns × ~150k and
 * the turn ceiling binds no later than the token ceiling. A child's own bound knob can only
 * lower `minutes`, never raise it. `ci`'s minutes is the verify tier timeout, not a child
 * bound; the review row bounds the lens and fixer children and has no wall clock of its own.
 *
 * `0` means "no bound" for turns and tokens. For `ci` a `0` minutes would be an
 * immediately-expired wait — the opposite of the generous setting every other `0` here says —
 * so `ci` takes a non-positive minutes as the shipped default. Mechanism: `ciMinutes` in
 * `lean/ci.ts`.
 */
export const DEFAULT_BUDGETS: Readonly<Record<string, Budget>> = Object.freeze({
  specify: Object.freeze({ turns: 400, tokens: 60_000_000, minutes: 20 }),
  build: Object.freeze({ turns: 400, tokens: 60_000_000, minutes: 45 }),
  challenge: Object.freeze({ turns: 400, tokens: 60_000_000, minutes: 15 }),
  review: Object.freeze({ turns: 400, tokens: 60_000_000, minutes: 30 }),
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

/**
 * The shipped defaults plus the own, validated keys of the file's `budgets`. Assembles by
 * copying the three named fields rather than spreading, which is what keeps a
 * prototype-polluting key out of the result even if one got past validation some other way.
 */
function mergeBudgets(
  overrides: Partial<Record<string, Budget>> | undefined,
): WorkConfig["budgets"] {
  const merged: Record<string, Budget> = {};
  // `DEFAULT_BUDGETS` is typed as a `Record<string, Budget>`, so an index read is `Budget` by
  // declaration yet `undefined` at runtime for an unknown key — these keys all come from
  // `Object.keys`, so they are all present.
  for (const state of Object.keys(DEFAULT_BUDGETS)) {
    const base = DEFAULT_BUDGETS[state] as Budget;
    merged[state] = { turns: base.turns, tokens: base.tokens, minutes: base.minutes };
  }
  for (const [state, budget] of Object.entries(overrides ?? {})) {
    const base = DEFAULT_BUDGETS[state] as Budget | undefined;
    if (!Object.hasOwn(DEFAULT_BUDGETS, state) || budget === undefined || base === undefined)
      continue;
    // Explicit fields, each defaulted to the shipped number: the schema lets a budget omit any
    // of the three, so an omitted member means "keep the default", not "undefined".
    merged[state] = {
      turns: budget.turns ?? base.turns,
      tokens: budget.tokens ?? base.tokens,
      minutes: budget.minutes ?? base.minutes,
    };
  }
  return merged;
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
    for (const key of ["fast", "full", "test", "testDir", "testGlob", "freezeCheck"] as const) {
      if (v[key] !== undefined && typeof v[key] !== "string")
        return `.pi/work.json verify.${key} must be a string`;
    }
    // The test location is a PAIR: prompts name both the folder and the naming pattern, and the
    // boundary refuses on both. One without the other says half of what it means.
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
    // The runner template is a template: without exactly one whole-word placeholder the step
    // cannot name the file it is running, and would run the same command for every test and
    // call the result a proof.
    if (typeof v.test === "string") {
      const reason = validateTestRunner(v.test);
      if (reason !== undefined) return reason;
    }
  }
  if (o.budgets !== undefined) {
    if (typeof o.budgets !== "object" || o.budgets === null || Array.isArray(o.budgets))
      return ".pi/work.json budgets must be an object";
    for (const [state, budget] of Object.entries(o.budgets as Record<string, unknown>)) {
      // The KEY is validated too. A budget is read by exact state name (`budgetFor`), so a
      // typo'd key is a valid object that silently does nothing while the real state keeps the
      // default. `Object.hasOwn`, not `in`: `in` walks the prototype chain, so `__proto__`,
      // `constructor` and `toString` would all "exist" and pass a check whose job is to refuse
      // an inert key.
      if (!Object.hasOwn(DEFAULT_BUDGETS, state)) {
        const known = Object.keys(DEFAULT_BUDGETS).join(", ");
        return `.pi/work.json budgets.${state} is not a lean state (known: ${known})`;
      }
      const reason = checkBudget(`.pi/work.json budgets.${state}`, budget);
      if (reason) return reason;
    }
  }
  return undefined;
}

/**
 * Read one blob at a commit. `undefined` for "that path is not in that commit".
 *
 * "Not in that commit" has three shapes git reports differently, and all three mean the same
 * thing to a caller that wants defaults: the path is absent, the path is a *tree* (which would
 * otherwise reach the JSON parser and be reported as a typo'd config), and the path is a
 * symlink. `cat-file -t` is asked first because it separates the second from the first.
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
    // A blob the reader could not hold is an infra failure, not a config problem: a 2 MB
    // committed file must not be reported as "not valid JSON".
    if (isBufferOverflow(err))
      throw new LeanConfigError(
        `could not read ${ref}: larger than the ${GIT_SHOW_MAX_BUFFER} byte read limit`,
      );
    // Exit 128 with "does not exist" is an absent file; anything else (a bad sha, no git, a
    // locked index) is a real failure the caller must see.
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
 * `baseSha` is required rather than "current": the caller resolved the mainline sha for the
 * cycle and every read in the run is against that one commit, so config, doctrine and code all
 * describe the same tree.
 */
export async function loadWorkConfig(
  exec: ConfigExec,
  repoRoot: string,
  baseSha: string,
): Promise<WorkConfig> {
  const raw = await gitShow(exec, repoRoot, `${baseSha}:.pi/work.json`);
  if (raw === undefined) {
    // No config: fall back to the committed .pi/verify-cmd for the full tier.
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
    // Built from the validated own keys only, never spread wholesale: a prototype-polluting
    // key is an own property of the parsed object, and spreading it would put it on the result
    // rather than refuse it.
    budgets: mergeBudgets(o.budgets),
  };
}
