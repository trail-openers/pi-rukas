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

import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
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

/**
 * What one `glabCreateEnv()` allocated, so its owner can take exactly that back.
 *
 * `parent` is the `mkdtemp` directory `createChildForgeConfigDir` made IN when it
 * was called without a `root`, and `configDir` the empty config dir made inside
 * it. The parent's name is held by no one else, so no one else will remove it —
 * which is why both are handed back rather than only the inner dir the env names.
 * `undefined` on the shared/spawn path, where a broker owns the parent and one
 * teardown removes the socket and this dir together.
 */
export interface GlabCreateEnvOwned {
  configDir: string;
  parent?: string;
}

/**
 * The env a `glab mr create` is issued with, and what it allocated.
 *
 * `owned` is whatever this call mkdtemp'd and nobody else can name. The create
 * owns the teardown of everything its own env builder allocated — the config dir
 * AND its mkdtemp parent — so they are returned together rather than left for a
 * teardown that only knows the half it can see.
 *
 * `CI` is the flag glab and its prompt library read as "nobody is here", and
 * `GIT_TERMINAL_PROMPT=0` is git's own version of the same answer. Together with
 * the argv's `-y` they are what keeps a create from asking a question the driver
 * cannot answer. The descriptor that question would be read from is closed
 * elsewhere: `execp`'s argv form ends the child's stdin, so even a prompt none
 * of these flags suppresses reads EOF instead of blocking.
 *
 * The copy comes from `forgeReadChildEnv` — the one child-env construction every
 * non-ops path funnels through — so the create carries no forge token and no
 * operator config root, exactly as a spawned child's env does. The adapter hands
 * `role` "" (a driver exec is not an ops child), which `keepsForgeLogin` answers
 * "no" to, and no broker pair, so both halves of that pair are deleted rather
 * than inherited.
 */
export function glabCreateEnv(): {
  env: Record<string, string>;
  owned: GlabCreateEnvOwned[];
} {
  const owned: GlabCreateEnvOwned[] = [];
  const env = forgeReadChildEnv(process.env, "", undefined, undefined, undefined, owned);
  env.CI = "1";
  env.GIT_TERMINAL_PROMPT = "0";
  return { env, owned };
}

/**
 * Remove what a `glabCreateEnv()` allocated, when it allocated any. The create is
 * a short-lived driver exec, so unlike a spawned child — whose config dir a
 * teardown removes when the child exits — nothing else ever takes this directory
 * back, and one leaks per MR create.
 *
 * Only a directory this module created and handed back through `owned` is ever
 * removed: a name the caller owns (a broker's own temp tree passed as
 * `configDir`, a path carried in from outside) is not this module's to delete, so
 * it is left alone. The path is matched exactly and never by substring — an
 * inner config dir sits INSIDE a `pi-rukas-forge-` parent, and a substring test
 * would either miss that parent or reach into a tree someone else made.
 */
export function removeGlabCreateEnvDirs(owned: GlabCreateEnvOwned[]): void {
  for (const dir of owned) {
    // The path that used to leak is the `mkdtemp` PARENT, whose name is held nowhere
    // but the list handed in here: `createChildForgeConfigDir` makes it when called
    // without a `root`, and the predecessor of this teardown removed only the inner
    // config dir — which it found by SUBSTRING of the env value — so one empty parent
    // per create stood in the temp root for the life of the host. The parent is not
    // removed separately because it cannot be reached separately: the config dir sits
    // INSIDE it, so one recursive removal of the config dir takes both. What the fix is,
    // is that the path is taken from `owned` — the exact path this module allocated —
    // rather than inferred from a name, which is what made the parent reachable at all.
    // `force` keeps a path another teardown already took from erroring in a `finally`.
    if (dir.configDir) rmSync(dir.configDir, { recursive: true, force: true });
  }
}

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
 * someone else owns. `owned` collects exactly that private parent, the one path
 * this call made that no one else holds a name for.
 */
export function createChildForgeConfigDir(root?: string, owned?: GlabCreateEnvOwned[]): string {
  let parent = root ?? "";
  if (!parent) {
    parent = mkdtempSync(join(tmpdir(), "pi-rukas-forge-"));
    // Recorded HERE, at the allocation, rather than returned and recorded by the
    // caller: the caller that cannot see this name is the one that needs it, and
    // a value handed back through a closure can be lost where an append cannot.
    owned?.push({ configDir: parent, parent });
  }
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
 *
 * A caller that names a path and holds no key therefore gets the DELETE branch,
 * not a minted key. The key is the thing the broker on the other end checks, so
 * minting one here would publish a pair whose server does not exist: the child
 * would dial a listener nobody bound and be unable to tell it from a stranger —
 * the exact state the delete exists to make unreachable. The pair is complete
 * only when the caller that bound the socket hands down the key it bound it with.
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
  if (socketPath && secret) {
    env.PI_ENSEMBLE_FORGE_READ_SOCKET = socketPath;
    env.PI_ENSEMBLE_FORGE_READ_SECRET = secret;
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
 *
 * `owned` collects every directory THIS call allocated and nobody else can name
 * (see `GlabCreateEnvOwned`): the private `mkdtemp` parent it made when no
 * `configDir` was passed, which recursively covers the config dir inside it. A
 * caller that passes its own `configDir` owns that dir, so nothing is recorded
 * for it and it is left for that caller's teardown. It is an ARRAY the callee
 * fills rather than a value returned through a callback: the only reference to it
 * would otherwise sit in a closure handed to a third function, where this runtime
 * has mis-bound such a binding before — a parameter that read as `undefined` at
 * the moment of the call, inside a `try` that would have swallowed the TypeError
 * and left the create with no config root at all. An append either happened or it
 * did not, and the caller can see which.
 */
export function forgeReadChildEnv(
  source: NodeJS.ProcessEnv,
  role: string,
  socketPath?: string,
  configDir?: string,
  secret?: string,
  owned?: GlabCreateEnvOwned[],
): Record<string, string> {
  let dir = "";
  if (!keepsForgeLogin(role)) {
    dir = configDir ?? "";
    if (!dir) {
      try {
        dir = createChildForgeConfigDir(undefined, owned);
      } catch (err) {
        trace(
          `child-forge-env: no forge config root could be made — the child gets no config root at all: ${err instanceof Error ? err.message : String(err)}`,
        );
      }
    }
  }
  return buildChildForgeEnv(source, role, dir, socketPath, secret);
}
