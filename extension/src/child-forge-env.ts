/**
 * child-forge-env — the child half of the ambient-forge-login split (#2160).
 *
 * Every helper subagent used to inherit the operator's forge login: the five
 * forge token variables pass straight through the child env, and `gh`/`glab`
 * fall back to the operator's own config dir when no token is set. A child
 * that ran one `gh pr merge` was acting with the operator's credentials, so
 * the text classifier was the only thing standing between a careless prompt
 * and a landing. Reads now go through the parent's `forge_read` tool
 * (`forge-read-broker.ts`); this module removes the login the helper no
 * longer needs.
 *
 * The rule is a DELETE, never an assignment of `undefined`: `childEnvFor`
 * filters undefined values out of its spread, but the resume-reattach site
 * copies only defined values into its own object, and an `env[k] = undefined`
 * there serialises as the literal string "undefined" for `gh` — the same
 * unset-vs-undefined trap `scrubGitLocation` (git-env.ts) avoids the same way.
 *
 * `GH_CONFIG_DIR` / `GLAB_CONFIG_DIR` point at a per-child EMPTY directory so
 * a token-less child cannot quietly fall back to the operator's config. Both
 * variables are set even when only one CLI is in use: an unset one is a
 * fallback path, and the whole point is that a helper has none. The directory
 * is created here, so the child's CLI finds a real empty config root rather
 * than a dangling path. When no directory could be made, BOTH roots are
 * DELETED rather than left as inherited: a config root is half of a login —
 * `gh` reads an `hosts.yml`/`oauth_token` out of it with no token in the env at
 * all — so an inherited operator root in a token-less child is the very
 * fallback this module exists to close.
 *
 * The threat model, stated honestly: helpers run as the operator's UID, so a
 * helper that deliberately re-points `GH_CONFIG_DIR` at the operator's config
 * or reads a credential store can regain the login. This removes the AMBIENT
 * login — the accidental and the prompted-but-careless landing — and is not a
 * sandbox. Confinement remains the sandbox's job.
 *
 * Ops keeps the login: it is the only role that lands work, and it is the one
 * role that must be able to run `gh`/`glab` itself. The parent session keeps
 * it too — it spawns no forge strip, so this module never touches it.
 */

import { mkdirSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { newForgeReadSecret } from "./forge-read-auth.ts";
import { trace } from "./trace.ts";

/** The five variables that carry a forge login to `gh` / `glab`. */
export const FORGE_TOKEN_VARS = [
  "GH_TOKEN",
  "GITHUB_TOKEN",
  "GITLAB_TOKEN",
  "GH_ENTERPRISE_TOKEN",
  "GITLAB_ACCESS_TOKEN",
] as const;

/** The two config roots the CLIs fall back to when no token is present. */
export const FORGE_CONFIG_DIR_VARS = ["GH_CONFIG_DIR", "GLAB_CONFIG_DIR"] as const;

/** The role that keeps every credential: the one role that lands work. */
export const OPS_ROLE = "ops";

/** True when this role's child keeps the operator's forge login. */
export function keepsForgeLogin(role: string): boolean {
  return role.trim().toLowerCase() === OPS_ROLE;
}

/**
 * A per-child empty forge-config directory. The name carries the pid, a clock
 * and a random suffix so two children of one parent never share it, and
 * `pi-rukas-forge-config-` so a leftover is recognisable to whoever sweeps the
 * temp root. Created eagerly — the child's CLI must find a real empty config
 * root, not a dangling path — and it stays EMPTY: a `gh` that finds a stray
 * file in its config root is a different, worse failure than one that finds
 * none (the spawn-path assertion in test-child-forge-credentials.ts is the
 * detector).
 *
 * `root` is the directory the config dir is made IN. `spawn-permission.ts`
 * passes the broker's own `mkdtemp` directory, so the socket and this dir are
 * siblings under one 0700 tree that one teardown removes when the child exits,
 * and a sibling child cannot guess the name. Called without a `root` — the
 * reattach path, and any path that strips without serving a broker — it makes a
 * private `mkdtemp` dir of its own, so the returned path is always a whole
 * directory the caller may `rmSync`: never a sibling name inside a temp root
 * someone else owns.
 */
export function createChildForgeConfigDir(root?: string): string {
  const parent = root ?? mkdtempSync(join(tmpdir(), "pi-rukas-forge-"));
  const dir = join(
    parent,
    `pi-rukas-forge-config-${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
  );
  mkdirSync(dir, { recursive: true });
  return dir;
}

/**
 * Strip the ambient forge login from a child env, in place: the five token
 * variables are DELETED and both config roots point at `configDir`.
 *
 * Returns the names it removed, so a caller can trace what it took. An ops
 * child returns `[]` and its env is untouched — same signature, one call site
 * per spawn path, no branch at the call site that could be forgotten.
 */
export function stripForgeCredentials(
  env: Record<string, string | undefined>,
  role: string,
  configDir: string,
): string[] {
  if (keepsForgeLogin(role)) return [];
  const removed: string[] = [];
  for (const name of FORGE_TOKEN_VARS) {
    if (name in env) {
      removed.push(name);
      // `Reflect.deleteProperty` is the operation that actually removes the key;
      // assigning `undefined` — biome's suggested `noDelete` fix — leaves the key
      // present and serialises as the string "undefined". See `buildChildForgeEnv`.
      Reflect.deleteProperty(env, name);
    }
  }
  // The token delete comes FIRST and is unconditional. The redirect below is the
  // part that can be unavailable (no config root could be made), and a child
  // must never keep its login because the redirect failed. An EMPTY `configDir`
  // means "no config root is available", and both roots are then DELETED rather
  // than left as inherited: a config root is half of a login — `gh` reads an
  // `hosts.yml`/`oauth_token` out of it with no token in the env at all — so an
  // inherited operator root surviving a token strip is the fallback this whole
  // strip exists to close. An absent root is the honest answer: the CLI has
  // nothing to fall back to, where a dangling path would make it error instead.
  for (const name of FORGE_CONFIG_DIR_VARS) {
    Reflect.deleteProperty(env, name);
    if (configDir !== "") env[name] = configDir;
  }
  if (removed.length > 0) {
    trace(`child-forge-env: removed ${removed.join(", ")} from the ${role} child env`);
  }
  return removed;
}

/**
 * Build one child env from the parent's: a plain copy of `source` (only
 * defined values), with a non-ops child's forge login removed and its config
 * roots pointed at `configDir`. An EMPTY `configDir` means "no config root is
 * available": the tokens are still deleted and both roots are deleted with them
 * rather than left inherited — see `stripForgeCredentials`.
 *
 * `PI_ENSEMBLE_FORGE_READ_SOCKET` and `PI_ENSEMBLE_FORGE_READ_SECRET` are the
 * broker pair, and they travel together or not at all. Both are set only when
 * the caller names a `socketPath` AND the `secret` that broker checks; otherwise
 * BOTH are DELETED, so a child whose parent served no broker (the reattach path)
 * never holds a socket path or a key from an earlier spawn or from an outer
 * pi-rukas. This socket answers CONTENT, so a stale path is a listener someone
 * else may own — and half a pair is the same hazard by another route: a path with
 * no key leaves the child unable to authenticate whoever answers, and a key with
 * no path is a secret with nothing to prove. An absent broker is therefore two
 * absent variables, never a wrong pair or half of one. The child's own predicate
 * (`forgeReadAvailableForRole`) requires both, so a half-pair env registers no
 * tool at all rather than one that can only refuse.
 */
export function buildChildForgeEnv(
  source: NodeJS.ProcessEnv,
  role: string,
  configDir: string,
  socketPath?: string,
  secret?: string,
): Record<string, string> {
  const env: Record<string, string> = {};
  for (const [k, v] of Object.entries(source)) {
    if (v !== undefined) env[k] = v;
  }
  stripForgeCredentials(env, role, configDir);
  if (socketPath) {
    env.PI_ENSEMBLE_FORGE_READ_SOCKET = socketPath;
    // A socket the parent named is THIS child's broker, so a caller that holds
    // the path has the plan's key too. A caller that names a path and no key (a
    // test standing in for the parent, or a plan inspected after its broker was
    // stopped) mints one: the pair must always go out complete, because half of
    // it is the hazard the delete below exists for.
    env.PI_ENSEMBLE_FORGE_READ_SECRET = secret ?? newForgeReadSecret();
  }
  // DELETED, never assigned `undefined`: this env reaches `childEnvFor`'s spread
  // and the reattach site's own copy, and an `undefined` value there serialises as
  // the literal string "undefined" for the child (`scrubGitLocation`, git-env.ts,
  // avoids the same trap). `Reflect.deleteProperty` is `delete` written so biome's
  // recommended `noDelete` stays quiet: its autofix is the `undefined` assignment
  // this line exists to prevent, so the rule cannot be obeyed by its own advice.
  else {
    Reflect.deleteProperty(env, "PI_ENSEMBLE_FORGE_READ_SOCKET");
    Reflect.deleteProperty(env, "PI_ENSEMBLE_FORGE_READ_SECRET");
  }
  return env;
}

/**
 * The one child-env construction that every non-ops path funnels through:
 * copy `source`, strip the forge login from a helper child, redirect its
 * config roots, and name the parent's forge_read socket when there is one.
 * Ops children and the parent are returned unchanged apart from the copy.
 *
 * `configDir` is the caller's when it has one (the spawn path passes the dir
 * that shares its parent with this child's broker socket, so one teardown
 * removes both); otherwise a fresh private temp dir of this child's own. When
 * even that cannot be made — the temp root is unwritable — the child is built
 * with NO config root at all: the tokens and both config roots are gone either
 * way, so an unwritable temp root degrades the child to no forge access rather
 * than to the operator's login.
 *
 * `secret` is the broker's other half (#2160 adversarial round 1) and is handed
 * to the child only beside the socket that needs it — see `buildChildForgeEnv`.
 */
export function forgeReadChildEnv(
  source: NodeJS.ProcessEnv,
  role: string,
  socketPath?: string,
  configDir?: string,
  secret?: string,
): Record<string, string> {
  let dir = "";
  if (!keepsForgeLogin(role)) {
    dir = configDir ?? "";
    if (!dir) {
      try {
        dir = createChildForgeConfigDir();
      } catch (err) {
        trace(
          `child-forge-env: no forge config root could be made — the child gets no config root at all: ${err instanceof Error ? err.message : String(err)}`,
        );
      }
    }
  }
  return buildChildForgeEnv(source, role, dir, socketPath, secret);
}
