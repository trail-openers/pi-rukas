/**
 * child-role-env — the switch for stamping `PI_ENSEMBLE_ROLE` into a spawned
 * child's env (#2352 R11).
 *
 * The defect this switch exists beside is not a missing guard, it is a missing
 * NAME. Every role-scoped child-side rule reads the role out of the child's own
 * environment — the #1879 read-only dependency rule, the #2200 deletion rule and
 * its `ops` carve-out, the #2140 reviewer bash bound, the #1113 push ban, and
 * this issue's reviewer bash containment — and a spawned child's env carried no
 * `PI_ENSEMBLE_ROLE` at all: the spawn path builds it in `spawn-child-env.ts`
 * (`childBaseEnv` → `forgeReadChildEnv` → `buildChildForgeEnv`), and none of
 * those three stamp the role. The only stamper was `childEnvFor`
 * (write-fence-contract.ts), which the nested-dispatch and resume paths call and
 * the smoke tests exercise — so the guards read `undefined`, every role test
 * failed, and each rule reported itself as working while judging nothing.
 *
 * Stamping the role ACTIVATES rules that were inert for every child, so the
 * switch is the operator's escape hatch for the whole set, not for one guard:
 * `PI_ENSEMBLE_CHILD_ROLE_ENV=0` leaves the child env byte-identical to the
 * pre-#2352 shape. That is the honest off arm — it restores the bug alongside
 * the behaviour, which is what an escape hatch is for.
 *
 * The parent session is untouched: it sets no `PI_ENSEMBLE_ROLE` of its own
 * (permission-guard.ts falls back to `project-manager` for an unset one), and
 * this module is reached only from the child-env builder.
 */

/** The env name the role-scoped child guards read. */
export const CHILD_ROLE_ENV = "PI_ENSEMBLE_ROLE";

/** The env name that switches the stamp off. */
export const ROLE_SWITCH = "PI_ENSEMBLE_CHILD_ROLE_ENV";

/**
 * Whether the spawn stamps the dispatched role into the child's env.
 *
 * Default ON; only the literal `"0"` turns it off, the same convention every
 * other pi-rukas switch uses, so `false`/`off`/garbage keep the stamp.
 */
export function childRoleEnvEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  return env[ROLE_SWITCH] !== "0";
}

/**
 * The value stamped for one dispatch: the plan's role string, verbatim, or
 * `undefined` when the dispatch named none.
 *
 * Verbatim is the requirement (R9), not a style choice: the plan's alphabet and
 * `READ_ONLY_ROLES`' are different sets — `lens-fix` is a plan role and is in
 * neither the reviewer set nor the develop one — and a stamp that normalised it
 * would make the guard judge a lens-fix child as something it is not. Trimming is
 * the only rewrite, because a stray space would read as an unknown role and
 * silently deactivate the guard for the child that most needs it.
 */
export function childRoleEnvValue(role: string | undefined): string | undefined {
  const trimmed = role?.trim();
  return trimmed === undefined || trimmed === "" ? undefined : trimmed;
}
