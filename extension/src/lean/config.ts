/**
 * lean/config — `.pi/work.json`, read at the cycle's base commit.
 *
 * Same rule as the driver's doctrine read: configuration that decides what a run may do is read with
 * `git show <baseSha>:.pi/work.json`, never from the working tree — a run that edited its own config would
 * otherwise be judged by the bytes it wrote.
 *
 * Two outcomes for a missing file and a broken one, kept deliberately apart:
 *   - absent  → defaults (a repo with no config is normal)
 *   - invalid → `LeanConfigError` (a typo'd budget must not silently become "no budget")
 *
 * The shipped table has a row for every state the machine can visit. A key that is not in the table is refused
 * at load.
 */

import type { execp } from "../exec.ts";
import { validateTestDir, validateTestGlob } from "./config-test-location.ts";
import { DERIVE_DEFAULT_BUDGET } from "./derive-budget.ts";
import { protectedPathProblem } from "./protected-globs.ts";
import { SPEC_INTAKE_VALUES, type SpecIntake } from "./spec-intake-switch.ts";

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
   * `test` is the per-file runner template the `specify` step uses to prove a test red on the base: it must
   * contain exactly one whole-word `{file}`. It is executed as an executable plus argv, never through a shell.
   *
   * `testDir` is a repo-relative DIRECTORY and `testGlob` a basename pattern with exactly one `*`. Both absent
   * — the default — means the child may write its tests anywhere in the worktree. `testDirs` replaces
   * `testDir` where tests sit in several roots; setting both is refused.
   */
  verify: {
    fast?: string;
    full?: string;
    test?: string;
    testDir?: string;
    testDirs?: string[];
    testGlob?: string;
    /**
     * A shell command the project runs over the whole tree to judge test-file CONTENT. `specify`/`challenge`
     * run it before freezing the candidate tests, and `verify` runs it when a project tier is red at HEAD.
     * Unset: nothing runs. Mechanism: `lean/freeze-check.ts`.
     */
    freezeCheck?: string;
    /**
     * The runner's machine-readable per-test report command, which the project roster
     * (`lean/verify-roster.ts`) runs at head and at the run's base commit to record WHICH tests
     * ran and which failed. Like `test` it is executed as an executable plus argv, never through
     * a shell, so it carries the same metacharacter ban. `{dir}` names the tree the roster runs
     * in and `{report}` the file the gate reads back. Unset is not "no roster" — the gate derives
     * `--junitxml={report} {dir}` onto the `test` command; with neither field set the roster
     * cannot be built and the run hands back.
     */
    roster?: string;
  };
  budgets: Partial<Record<string, Budget>>;
  lean?: {
    /**
     * How the run obtains its `pi-spec v1` contract. `require` (the shipped
     * default) refuses an issue whose body carries no block; `derive` derives one
     * inside the run. Read through `resolveSpecIntake`, which weighs the env above
     * this field — the field is one input, never the last word.
     */
    specIntake?: SpecIntake;
    /**
     * The project's OWN protected list: repo-relative gitignore-style globs whose
     * paths the build and review-fix folds REVERT, the way they revert an edit to
     * `.pi/`. Semantics and validity rules: `lean/protected-globs.ts`. Read here, at
     * the run's base commit, and never again from the working tree.
     */
    protectedPaths?: string[];
  };
}

/** A config that exists but cannot be read. Never collapsed into a default. */
export class LeanConfigError extends Error {
  override readonly name = "LeanConfigError";
}

/**
 * The placeholder a `verify.test` template carries. ONE name for it: the validator here, the prompt that
 * explains it and the renderer that substitutes it all read this constant.
 */
export const TEST_RUNNER_PLACEHOLDER = "{file}";

/** The placeholder a `verify.roster` command names the tree with. See `validateRosterCommand` below. */
const ROSTER_DIR_PLACEHOLDER = "{dir}";

/** The placeholder a `verify.roster` command names its report file with. */
const ROSTER_REPORT_PLACEHOLDER = "{report}";

/**
 * Why this `verify.roster` report command is not usable, or undefined when it is.
 *
 * The roster command reaches the executor in argv form, exactly as `verify.test` does, so the
 * same metacharacter ban applies — a template carrying one is one its author meant for a shell,
 * and the roster never hands a command to a shell. What differs is the placeholder rule: the
 * roster runs the whole suite rather than one file, so it carries no `{file}` and its own
 * placeholders are `{dir}` (the tree) and `{report}` (the file the gate reads back). Each, if
 * present, must be a WHOLE whitespace-separated word, because it is substituted per word.
 */
function validateRosterCommand(cmd: string): string | undefined {
  if (TEST_RUNNER_FORBIDDEN.test(cmd))
    return ".pi/work.json verify.roster is run without a shell: ; & | ` $ < > \" ' \\ and newline are not allowed";
  for (const placeholder of [ROSTER_DIR_PLACEHOLDER, ROSTER_REPORT_PLACEHOLDER] as const) {
    const count = cmd.split(placeholder).length - 1;
    if (count > 1)
      return `.pi/work.json verify.roster must contain the literal ${placeholder} at most once, found ${count}`;
    if (count === 1 && !cmd.split(/\s+/).includes(placeholder))
      return `.pi/work.json verify.roster must use ${placeholder} as a whole word, not glued to other characters`;
  }
  if (cmd.trim() === "") return ".pi/work.json verify.roster must not be empty";
  return undefined;
}

/**
 * The one spelling of the config's path, for a gate that wants to read the same bytes the loader does.
 * `loadWorkConfig` deliberately does NOT interpolate it: the ref it passes to `gitShow` is a literal.
 */
export const WORK_CONFIG_FILE = ".pi/work.json";

/**
 * The configured protected globs in the shape the fold wants: the list, or `undefined` for "no
 * configured rule" — an absent or empty field. Lives here so every `normaliseBuild` caller hands
 * the fold the SAME list, whichever fold of the run asks.
 */
export function protectedPathsOf(config?: WorkConfig): string[] | undefined {
  const list = config?.lean?.protectedPaths;
  return list === undefined || list.length === 0 ? undefined : [...list];
}

/** The executor seam: same signature as `execp`, injected so tests stay local. */
export type ConfigExec = typeof execp;

/** Ceiling for one committed config/verify-cmd blob; overflow is its own error class. */
const GIT_SHOW_MAX_BUFFER = 1024 * 1024;

/**
 * Characters a runner template may never contain. Each is a shell metacharacter or a newline: present anywhere,
 * they say the author meant the template for a shell, which is not how the step executes it.
 */
const TEST_RUNNER_FORBIDDEN = /[;&|`$<>"'\\\n\r]/;

/**
 * Why this `verify.test` template is not usable, or undefined when it is. Three rules, all mechanical: it must
 * carry {@link TEST_RUNNER_PLACEHOLDER} EXACTLY once; every occurrence must be a WHOLE whitespace-separated
 * word; and no shell metacharacter anywhere.
 */
export function validateTestRunner(template: string): string | undefined {
  // The metacharacter rule FIRST: a template carrying one is one its author meant for a shell.
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
 * Per-state ceilings, each bounding ONE CHILD and never a step's total. `tokens` counts all usage including
 * cache re-reads (~150k per turn measured), which is why the 400-turn rows carry 60M. A child's own bound knob
 * can only lower `minutes`, never raise it. `ci`'s minutes is the verify tier timeout, not a child bound.
 *
 * `0` means "no bound" for turns and tokens. An operator's `budgets.ci.minutes` of `0` would be an
 * immediately-expired wait, so `ciMinutes` in `lean/ci.ts` takes a non-positive `ci` minutes as the shipped
 * default.
 */
export const DEFAULT_BUDGETS: Readonly<Record<string, Budget>> = Object.freeze({
  specify: Object.freeze({ turns: 400, tokens: 60_000_000, minutes: 20 }),
  build: Object.freeze({ turns: 400, tokens: 60_000_000, minutes: 45 }),
  challenge: Object.freeze({ turns: 400, tokens: 60_000_000, minutes: 15 }),
  review: Object.freeze({ turns: 400, tokens: 60_000_000, minutes: 30 }),
  ci: Object.freeze({ turns: 0, tokens: 0, minutes: 30 }),
  // The spec-intake child, which drafts a contract from a prose ticket. Its own row,
  // not a borrowing of `specify`'s, so an operator can price and bound a drafting
  // pass without touching a build step's ceiling — and a derivation that runs away
  // cannot spend the money a build would have needed. One short read-only pass: the
  // child works from text already in its prompt, with no repository to explore.
  derive: DERIVE_DEFAULT_BUDGET,
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
 * The shipped defaults plus the own, validated keys of the file's `budgets`. Assembles by copying the three
 * named fields rather than spreading, which is what keeps a prototype-polluting key out of the result.
 */
function mergeBudgets(
  overrides: Partial<Record<string, Budget>> | undefined,
): WorkConfig["budgets"] {
  const merged: Record<string, Budget> = {};
  // `DEFAULT_BUDGETS` is typed as a `Record<string, Budget>`, so an index read is `Budget` by declaration yet
  // `undefined` at runtime for an unknown key — these keys all come from `Object.keys`.
  for (const state of Object.keys(DEFAULT_BUDGETS)) {
    const base = DEFAULT_BUDGETS[state] as Budget;
    merged[state] = { turns: base.turns, tokens: base.tokens, minutes: base.minutes };
  }
  for (const [state, budget] of Object.entries(overrides ?? {})) {
    const base = DEFAULT_BUDGETS[state] as Budget | undefined;
    if (!Object.hasOwn(DEFAULT_BUDGETS, state) || budget === undefined || base === undefined)
      continue;
    // Explicit fields, each defaulted to the shipped number: an omitted member means "keep the default".
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
    for (const key of [
      "fast",
      "full",
      "test",
      "testDir",
      "testGlob",
      "freezeCheck",
      "roster",
    ] as const) {
      if (v[key] !== undefined && typeof v[key] !== "string")
        return `.pi/work.json verify.${key} must be a string`;
    }
    if (v.testDirs !== undefined) {
      if (v.testDir !== undefined)
        return ".pi/work.json verify.testDir and verify.testDirs are exclusive: set one or the other";
      if (!Array.isArray(v.testDirs) || v.testDirs.length === 0)
        return ".pi/work.json verify.testDirs must be a non-empty array of directories";
      for (const [i, dir] of v.testDirs.entries()) {
        if (typeof dir !== "string") return `.pi/work.json verify.testDirs[${i}] must be a string`;
        const reason = validateTestDir(dir, `verify.testDirs[${i}]`);
        if (reason !== undefined) return reason;
      }
    }
    // The test location is a PAIR: prompts name both the folder and the naming pattern, and the boundary
    // refuses on both.
    const dirs = v.testDir ?? v.testDirs;
    if (dirs !== undefined && v.testGlob === undefined)
      return `.pi/work.json verify.${v.testDir === undefined ? "testDirs" : "testDir"} requires verify.testGlob (the file-name pattern, e.g. test-*.ts)`;
    if (v.testGlob !== undefined && dirs === undefined)
      return ".pi/work.json verify.testGlob requires verify.testDir or verify.testDirs (the directory the tests live in)";
    if (typeof v.testDir === "string") {
      const reason = validateTestDir(v.testDir);
      if (reason !== undefined) return reason;
    }
    if (typeof v.testGlob === "string") {
      const reason = validateTestGlob(v.testGlob);
      if (reason !== undefined) return reason;
    }
    // The runner template is a template: without exactly one whole-word placeholder the step cannot name the
    // file it is running.
    if (typeof v.test === "string") {
      const reason = validateTestRunner(v.test);
      if (reason !== undefined) return reason;
    }
    // The roster report command is executed in argv form too, so it earns the metacharacter ban
    // — but NOT the `{file}` rule: it runs the whole suite, not one file, and its own
    // placeholders are `{dir}` and `{report}`.
    if (typeof v.roster === "string") {
      const reason = validateRosterCommand(v.roster);
      if (reason !== undefined) return reason;
    }
  }
  if (o.lean !== undefined) {
    if (typeof o.lean !== "object" || o.lean === null || Array.isArray(o.lean))
      return ".pi/work.json lean must be an object";
    const l = o.lean as Record<string, unknown>;
    // Validated at the loader, like every other key here, so a typo'd mode is
    // refused at load rather than silently reading as the shipped default.
    if (
      l.specIntake !== undefined &&
      (typeof l.specIntake !== "string" || !SPEC_INTAKE_VALUES.includes(l.specIntake as SpecIntake))
    )
      return `.pi/work.json lean.specIntake must be one of ${SPEC_INTAKE_VALUES.join(", ")}`;
    // Each entry is judged by the SAME module that later decides whether a path matches it,
    // so a config cannot carry a pattern the fold reads as other than what the author meant
    // — a typo'd entry is a rule that silently protects nothing, which this loader refuses.
    if (l.protectedPaths !== undefined) {
      if (!Array.isArray(l.protectedPaths))
        return ".pi/work.json lean.protectedPaths must be an array of glob strings";
      for (const entry of l.protectedPaths as unknown[]) {
        const reason = protectedPathProblem(entry);
        if (reason !== undefined) return reason;
      }
    }
  }
  if (o.budgets !== undefined) {
    if (typeof o.budgets !== "object" || o.budgets === null || Array.isArray(o.budgets))
      return ".pi/work.json budgets must be an object";
    for (const [state, budget] of Object.entries(o.budgets as Record<string, unknown>)) {
      // The KEY is validated too: a budget is read by exact state name, so a typo'd key is a valid object that
      // silently does nothing. `Object.hasOwn`, not `in`: `in` walks the prototype chain.
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
 * "Not in that commit" has three shapes git reports differently — the path is absent, the path is a *tree*, and
 * the path is a symlink — and all three mean defaults to the caller. `cat-file -t` is asked first because it
 * separates the second from the first.
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
    // A blob the reader could not hold is an infra failure, not a config problem.
    if (isBufferOverflow(err))
      throw new LeanConfigError(
        `could not read ${ref}: larger than the ${GIT_SHOW_MAX_BUFFER} byte read limit`,
      );
    // Exit 128 with "does not exist" is an absent file; anything else is a real failure the caller must see.
    const e = err as { code?: number | null; stderr?: string; message?: string };
    const detail = `${e.stderr ?? ""}${e.message ?? ""}`;
    if (e.code === 128 || /does not exist|exists on disk|not in this repository/i.test(detail))
      return undefined;
    throw new LeanConfigError(`could not read ${ref}: ${detail.trim().slice(0, 200)}`);
  }
}

/**
 * Load the run's config from the base commit. `baseSha` is required rather than "current": every read in the
 * run is against that one commit, so config, doctrine and code all describe the same tree.
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
    // Built field by field for the same reason: the two keys below are all the schema
    // admits under `lean`, and the glob list is copied rather than aliased to the parsed
    // document a fold will later match against.
    ...(o.lean === undefined
      ? {}
      : {
          lean: {
            ...(typeof (o.lean as { specIntake?: unknown }).specIntake === "string"
              ? { specIntake: (o.lean as { specIntake: SpecIntake }).specIntake }
              : {}),
            ...(Array.isArray((o.lean as { protectedPaths?: unknown }).protectedPaths)
              ? {
                  protectedPaths: [
                    ...(o.lean as { protectedPaths: readonly string[] }).protectedPaths,
                  ],
                }
              : {}),
          },
        }),
  };
}
