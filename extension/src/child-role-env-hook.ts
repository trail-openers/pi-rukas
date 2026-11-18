/**
 * child-role-env-hook — writes the stamp into THIS process's env at startup, so
 * the companion's role-scoped guards have a role to read (#2352 R11).
 *
 * The companion (`child-guards.ts`) registers the role-scoped guards in its
 * extension factory, and the guards gate on `process.env.PI_ENSEMBLE_ROLE` at
 * registration. For a child whose env the spawn built, that is already set — but
 * the guard must not silently no-op when the parent's argv carried the companion
 * without the stamp (an older parent, or a hand-rolled `--extension`), so the
 * companion calls this first and recovers the role from the one other name the
 * spawn always sets: `PI_ENSEMBLE_CHILD_ID`, whose suffix after the pid is the
 * dispatched role.
 *
 * Deliberately narrow. It fills the key ONLY when absent and only from a name the
 * parent wrote — it never guesses a role, never overrides what the spawn set, and
 * never runs in the parent session (nothing in the parent path imports it, and
 * `registerChildRoleEnv` refuses to invent a role for a process the harness did
 * not stamp an id into).
 */

import { CHILD_ROLE_ENV, childRoleEnvEnabled, childRoleEnvValue } from "./child-role-env.ts";

/** The env name the spawn sets to `<pid>:<role>` for every child. Not a switch and
 * not a `HEADLESS_INPUTS` row: the spawn sets it unconditionally and this module is
 * its only reader, so there is no operator-facing knob to list. */
const CHILD_ID_ENV = "PI_ENSEMBLE_CHILD_ID";

/**
 * The env names this module reads, exported as data so the capability list can
 * carry them. `PI_ENSEMBLE_CHILD_ID` is not a switch — the spawn sets it
 * unconditionally and this module is its only reader — but the inputs gate asks
 * that every `PI_ENSEMBLE_*` the source reads be listed, and an id whose shape this
 * module parses is a name the build honours. It goes in `internal`, the scope the
 * other spawn-internal names use.
 */
export const CHILD_ROLE_ENV_NAMES = [CHILD_ROLE_ENV, CHILD_ID_ENV] as const;

/**
 * The role one child id names, or undefined. Everything before the first `:` is
 * the pid; everything after it is the role the dispatch carried, and a second
 * `:` means the id was not shaped as the spawn shapes it, so nothing is inferred.
 */
export function childIdRole(value: string | undefined): string | undefined {
  if (value === undefined) return undefined;
  const sep = value.indexOf(":");
  if (sep <= 0 || sep === value.length - 1) return undefined;
  const role = value.slice(sep + 1);
  return role.includes(":") ? undefined : childRoleEnvValue(role);
}

/**
 * Stamp the role this process's id names, if it has one and the key is not already
 * set. Returns the value the guards will read, so the caller can trace it.
 *
 * The `childRoleEnvEnabled` gate is what makes this the honest off arm: with
 * `PI_ENSEMBLE_CHILD_ROLE_ENV=0` the companion recovers nothing, so the child env
 * is the pre-#2352 shape and every role-scoped guard is inert again — the bug and
 * the behaviour restored together, which is what an escape hatch is for.
 */
export function registerChildRoleEnv(env: NodeJS.ProcessEnv = process.env): string | undefined {
  if (!childRoleEnvEnabled(env)) return undefined;
  const existing = childRoleEnvValue(env[CHILD_ROLE_ENV]);
  if (existing !== undefined) {
    env[CHILD_ROLE_ENV] = existing;
    return existing;
  }
  const recovered = childIdRole(env[CHILD_ID_ENV]);
  if (recovered === undefined) return undefined;
  env[CHILD_ROLE_ENV] = recovered;
  return recovered;
}
