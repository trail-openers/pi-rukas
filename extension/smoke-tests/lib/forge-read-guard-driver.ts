/**
 * forge-read-guard-driver.ts — the row driver the #2638 forge-config read rows
 * share.
 *
 * The rule under test is one hook (`registerForgeReadGuard`), but the rows span
 * nine groups across two files (the read/copy/tool/env/symlink arms and the
 * fail-closed/pass/role/canary/mutant arms), and every row needs the same
 * three things: a fake pi, the env pins the guard reads, and the fixture's
 * parent-resolved set. Two copies of that harness would drift on exactly the
 * details that make a row meaningful — which env is pinned, whether the set is
 * injected or read from the child's own env, whether the mutant stands the judge
 * down or merely empties a set — so the driver lives here, once.
 *
 * Nothing asserts in this module. A driver that asserts cannot tell a row's
 * intent, and the intent is the row's.
 */

import { registerForgeReadGuard } from "../../src/child-forge-read-guard.ts";
import type { ProtectedDir } from "../../src/child-forge-read-judge.ts";
import {
  FORGE_PROTECTED_HOMES_ENV,
  FORGE_PROTECTED_PATHS_ENV,
  forgeHomesFrom,
  forgeHomeSpellings,
  protectedForgePathsFrom,
} from "../../src/child-forge-read-roots.ts";
import { FORGE_READ_RULE } from "../../src/forge-read-refusal.ts";
import { assert } from "./assert-rig.ts";
import { withEnv } from "./env-scope.ts";
import { dispatch, makeFakePi } from "./forge-read-guard-harness.ts";

/**
 * The slice of Pi's `ExtensionAPI` the guard registration touches. Named locally
 * rather than imported: this project's smoke-tests config pins `"types": ["node"]`
 * and has never resolved the Pi packages from a `lib/` module, and the collector
 * next door (`forge-read-collector.ts`) has the same rule for the same reason — a
 * driver whose types depend on an unresolved package is a driver that cannot load.

/** One row: a bash command, or a tool call as [toolName, input]. */
export type Row = string | [string, Record<string, unknown>];

export function isCommand(row: Row): row is string {
  return typeof row === "string";
}

/** What the hook answered: a refusal with its reason, or nothing at all. */
export interface Verdict {
  block?: boolean;
  reason?: string;
}

/**
 * The harness-owned set a fixture's parent env resolves to, with the fixture's
 * SECOND home as the passwd entry — the same two homes the parent judges in
 * production, where the second is the passwd entry rather than a fixture path.
 * `os.homedir()` is deliberately never consulted: the runner's own home is not a
 * fact the rows can depend on, and a canary inside a tree the fixture already
 * protects would prove nothing.
 */
export function dirsFor(env: Record<string, string>, passwdHome: string): ProtectedDir[] {
  return protectedForgePathsFrom(env, forgeHomesFrom(env, passwdHome));
}

/**
 * The homes the PARENT published for one fixture — the string that travels in the
 * harness-owned homes channel, so a `~` in a child's path expands against the
 * operator's home rather than the scratch home the harness gave that child.
 */
export function homesFor(env: Record<string, string>, passwdHome: string): string[] {
  return forgeHomeSpellings(forgeHomesFrom(env, passwdHome));
}

/**
 * Load the guard for one row and judge one call.
 *
 * Three levers, and each one is a different question:
 *
 *  - `injected` hands the hook an array directly. An EMPTY array is the
 *    silent-death arm: the guard reads a set with no entries the same way it
 *    reads an absent one — nothing judged, so nothing runs.
 *  - `standDown` is the mutant's lever: the same registration, with the
 *    path-matching step made to find nothing. The role check, the roster and the
 *    refusal text all stay in place, which is what makes the difference
 *    observable: a refusal row that survives a stand-down was refusing for a
 *    reason other than the rule.
 *  - Neither, the default: the hook is registered with `dirs` left undefined, so
 *    it reads its OWN env — the production path, and the only way to pin that the
 *    serialised string alone carries the rule.
 */
export async function judge(
  row: Row,
  dirs: readonly ProtectedDir[] | undefined,
  opts: {
    role?: string;
    cwd?: string;
    standDown?: boolean;
    injected?: ProtectedDir[];
    homes?: string[];
    env?: Record<string, string | undefined>;
  } = {},
): Promise<Verdict | undefined> {
  const fake = makeFakePi();
  await withEnv(
    {
      PI_ENSEMBLE_ROLE: opts.role,
      [FORGE_PROTECTED_PATHS_ENV]:
        dirs === undefined ? undefined : dirs.map((d) => d.lexical).join(":"),
      [FORGE_PROTECTED_HOMES_ENV]: opts.homes?.join(":"),
      ...opts.env,
    },
    async () => {
      registerForgeReadGuard(fake as unknown as Parameters<typeof registerForgeReadGuard>[0], {
        ...(opts.injected === undefined && !opts.standDown ? { dirs } : { dirs: opts.injected }),
        cwd: opts.cwd ?? "/tmp",
      });
    },
  );
  const event = isCommand(row)
    ? { toolName: "bash", input: { command: row } }
    : { toolName: row[0], input: row[1] };
  if (opts.standDown) fake.standDown();
  return (await dispatch(fake, event)) as Verdict | undefined;
}

/** A row that must be refused, and must name the rule rather than the path's content. */
export async function expectRefused(
  row: Row,
  dirs: ProtectedDir[],
  label: string,
  why: string,
  opts: { homes?: string[]; env?: Record<string, string | undefined>; cwd?: string } = {},
): Promise<void> {
  const r = await judge(row, dirs, opts);
  assert(r?.block === true, `${label}: refused (${why})${r === undefined ? " — NOT refused" : ""}`);
  if (r?.block === true) {
    assert(
      (r.reason ?? "").includes(FORGE_READ_RULE),
      `${label}: the refusal names the rule, not a path's content`,
    );
  }
}

/** A row that must run: the rule is a rule, not a refusal of everything. */
export async function expectAllowed(
  row: Row,
  dirs: ProtectedDir[],
  label: string,
  why: string,
  opts: { homes?: string[]; env?: Record<string, string | undefined>; cwd?: string } = {},
): Promise<void> {
  const r = await judge(row, dirs, opts);
  assert(r === undefined, `${label}: allowed (${why})${r ? " — refused" : ""}`);
}
