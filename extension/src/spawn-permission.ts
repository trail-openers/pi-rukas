/**
 * Per-child permission wiring — split out of spawn.ts (#1666) so the decision
 * and its env writes live in one place with their tests.
 *
 * A child's subagent guard takes one of three shapes:
 *
 *   - Strict (`subagentGuardEnabled`): a per-spawn Unix socket + broker, and the
 *     full pi-rukas extension forwarded via --extension with
 *     PI_ENSEMBLE_SUBAGENT_MODE=1. The subagent's `ask` verdicts escalate to the
 *     parent (or hard-deny when there is no broker). Used by every non-trust
 *     child, including a headless run's children that did not come from a /work
 *     cycle.
 *   - Trust (`trustChild`, no broker): the child gets PI_ENSEMBLE_TRUST_MODE=1 and
 *     no PI_ENSEMBLE_PERM_SOCKET. Two sources set it:
 *       · an interactive parent in trust mode (isParentInTrustMode), and
 *       · a headless /work cycle (#1666): the driver sets `workCycleTrust` on
 *         each dispatch of the cycle, so exactly that cycle's children are
 *         trusted. The process-global isParentInTrustMode() is deliberately NOT
 *         consulted for the cycle case, so a non-/work dispatch made by the same
 *         process is unaffected. PI_ENSEMBLE_STRICT_PERMISSIONS=1 in the runner
 *         env suppresses the cycle case (the explicit strict opt-in).
 *
 * In every shape the mode-independent guards and the write fence still reach the
 * child through the child-guards companion (child-guards.ts), which spawn.ts
 * appends unconditionally; nothing here touches them.
 */

import { readdirSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  createChildForgeConfigDir,
  forgeReadChildEnv,
  keepsForgeLogin,
} from "./child-forge-env.ts";
import { FORGE_READ_SECRET_ENV, FORGE_READ_SOCKET_ENV } from "./child-forge-read-activation.ts";
import { type ForgeReadBrokerHandle, bindForgeReadSocket } from "./forge-read-broker.ts";
import { type BrokerHandle, startBroker } from "./permission-broker.ts";
import { isParentInTrustMode, makeBrokerDeps } from "./permission-guard.ts";
import { trace } from "./trace.ts";
import { strictOptIn, workCycleTrustEnabled } from "./work-cycle-trust.ts";

/** The env a non-ops child carries for its forge reads. */
export interface ChildForgePlan {
  /** True when this role keeps the operator's forge login (ops only). */
  keepsLogin: boolean;
  /** The per-child empty forge config dir; undefined for a role that keeps its login. */
  configDir?: string;
  /** The parent's forge-read socket path; only ever set for a stripped child. */
  socketPath?: string;
  /**
   * The per-child secret the broker checks every request against, and the key
   * the child proves the reply with. Set only beside `socketPath` — the two are
   * one credential, and half of it is worthless (and dangerous) on its own.
   */
  secret?: string;
}

/**
 * The child's permission wiring, plus what the caller must take down when the
 * child exits.
 *
 * `forge.socketPath` is only ever set once the broker has GENUINELY bound. A
 * `server.listen` failure surfaces on a later tick, so the plan cannot be a
 * plain object filled in synchronously: the caller awaits `ready` before it
 * builds the child env (`spawn-child-env.ts` -> `childBaseEnv`). A helper whose
 * broker never bound gets no socket variable at all and `forge_read` stays off
 * its roster - the fail-closed shape, because a path that answers nothing is a
 * tool that lies, and a lie is worse than a missing tool.
 */
export interface ChildPermissionPlan {
  /** Strict shape: the broker is wired and the pi-rukas extension is forwarded. */
  subagentGuardEnabled: boolean;
  /** Trust shape: the child gets the PI_ENSEMBLE_TRUST_MODE marker. */
  trustChild: boolean;
  permSocketPath?: string;
  broker?: BrokerHandle;
  /** #2160 — the forge strip and the parent-served read broker. */
  forge: ChildForgePlan;
  /** Resolves once the forge broker has bound or failed to bind; never rejects. */
  ready: Promise<void>;
  /** Stops the forge-read broker and removes its temp dirs. Idempotent, never throws. */
  stopForgeBroker(): void;
}

/**
 * The env a child starts from: the parent's, with a non-ops child's forge
 * login stripped and its config roots pointed at a fresh empty directory
 * (child-forge-env.ts). Ops keeps every credential; every other helper role
 * loses all five tokens and gains the parent's forge-read socket path so its
 * `forge_read` tool can reach the broker the parent serves.
 */
export function childBaseEnv(role: string, forge: ChildForgePlan): Record<string, string> {
  return forgeReadChildEnv(process.env, role, forge.socketPath, forge.configDir, forge.secret);
}

/**
 * True when the strip really does point BOTH forge config roots at `dir`.
 *
 * Asked of `forgeReadChildEnv` itself — the same helper that builds the real
 * child env — over an empty source and with the caller's dir supplied, so this
 * reads the production redirect rule rather than restating it, and an empty
 * source keeps the operator's ambient `GH_CONFIG_DIR` out of the answer. Passing
 * the dir explicitly is what makes the question meaningful: asked without one,
 * the helper allocates a dir of its own and every root "matches" whatever was
 * just invented, which would make this check pass on a plan whose root the strip
 * never redirects.
 */
function envPointsBothRootsAt(role: string, forge: ChildForgePlan, dir: string): boolean {
  const env = forgeReadChildEnv({}, role, forge.socketPath, dir, forge.secret);
  return env.GH_CONFIG_DIR === dir && env.GLAB_CONFIG_DIR === dir;
}

/** The dir exists and holds nothing — a forge config root with no fallback in it. */
function isDirectoryAndEmpty(dir: string): boolean {
  try {
    return readdirSync(dir).length === 0;
  } catch {
    return false;
  }
}

/**
 * Start the per-child forge-read broker. Never rejects: a broker that cannot
 * bind is a normal, survivable outcome — the child simply has no forge reads —
 * so the failure is traced and reported as "no socket" rather than thrown at
 * the dispatch.
 *
 * The bind is awaited through the returned `ready`: `server.listen` reports a
 * failure on a later tick, so a plan that published `socketPath` synchronously
 * could name a socket nobody serves. The broker's temp dir holds the socket and
 * the child's forge-config dir together, and `stop()` removes them both when the
 * child exits.
 */
function startForgeBroker(
  role: string,
  cwd: string,
): { forge: ChildForgePlan; stop: () => void; ready: Promise<void> } {
  const forge: ChildForgePlan = { keepsLogin: false };
  let handle: ForgeReadBrokerHandle | undefined;
  // The broker's temp dir holds the socket AND this child's forge-config dir, so
  // the handle is the ONE owner of that tree: `stop()` removes the socket and the
  // config root together, and a bind that never succeeded leaves no handle and no
  // dir either. A second remover of the same path would put the config root out
  // of existence before a caller that reads back the env this plan handed out (a
  // test, a reattach inspection) could observe it.
  //
  // `stopped` covers the race the other way: an abort or timeout can reach
  // spawn.ts's finally block before `ready` settles, so a bind that succeeds
  // after the stop has run must tear itself down rather than leave a listening
  // socket and a 0700 temp dir behind.
  let stopped = false;
  const stopAll = (): void => {
    stopped = true;
    handle?.stop();
    // The config root is a child of the broker's temp tree and `handle?.stop()`
    // removes that tree, but only when a bind ever completed: a plan whose bind
    // failed has no handle, and a bind that completed AFTER this stop has run
    // takes its own tree down. Neither owns the case where the dir exists and the
    // handle never will, so the caller removes what it can name. Best-effort — a
    // leftover temp dir is a leak, not a wrong answer.
    if (forge.configDir) removeTree(forge.configDir);
  };
  const bind = bindForgeReadSocket(cwd)
    .then((bound) => {
      // Late success: `stop()` already ran (an abort or a timeout took the
      // dispatch down while the bind was in flight), so nothing else will ever
      // close this server. Tear the whole tree down here rather than leaving a
      // listening socket and a 0700 temp dir that outlive the child.
      if (stopped) {
        bound.stop();
        return;
      }
      forge.socketPath = bound.socketPath;
      // The key is the sibling of the socket: it names the same child, lives as
      // long as the same broker, and is handed to that child and no other.
      forge.secret = bound.secret;
      handle = bound;
      // The per-child empty forge-config dir is made INSIDE the broker's 0700
      // `mkdtemp` dir (child-forge-env.ts): one owner, a name a sibling child
      // cannot guess, and it stays a sibling of `broker.sock` rather than a
      // wrapper — a config root must be EMPTY.
      //
      // The allocation is deliberately AFTER the socket is bound and it may
      // FAIL. `mkdtemp` honours `TMPDIR`, so the two resources can genuinely
      // disagree about where the temp root is: when the dir could not be made,
      // the child gets no config root at all rather than a path under a root it
      // cannot write — and `forgeReadChildEnv` falls back to its OWN private
      // dir before it gives up, so the roots reach an empty directory rather
      // than being deleted with the tokens. What must never happen is an
      // inherited operator root in a token-less child: a config root is half a
      // login (`gh` reads an `hosts.yml`/`oauth_token` out of it with no token in
      // the env), so it is the fallback this strip exists to close. The five
      // token variables are deleted whatever happens here.
      try {
        forge.configDir = createChildForgeConfigDir(bound.dir);
        // Verify the redirect at the ONE instant it is certain to be true — the
        // dir exists, nothing has been handed out yet, and `spawn.ts` awaits
        // `ready` before it builds the child env, so no teardown can have
        // reached this plan. Both roots must point at the plan's dir, which is
        // also the check that a future refactor does not redirect one root and
        // forget the other. A plan whose redirect is wrong is FLAGGED (traced)
        // rather than carrying a value a reader far away has to guess at.
        if (!envPointsBothRootsAt(role, forge, forge.configDir)) {
          trace(
            `spawn[${role}]: forge-config root was allocated but the strip did not redirect BOTH config roots at it`,
          );
        } else if (!isDirectoryAndEmpty(forge.configDir)) {
          trace(
            `spawn[${role}]: forge-config root ${forge.configDir} is not an empty directory — the child's CLI has a fallback to read from`,
          );
        }
      } catch (err) {
        trace(
          `spawn[${role}]: forge-config dir could not be made — this child gets no config root: ${describeError(err)}`,
        );
      }
    })
    .catch((err: unknown) => {
      trace(
        `spawn[${role}]: forge-read broker could not bind — this child has no forge reads: ${describeError(err)}`,
      );
    });
  return { forge, stop: stopAll, ready: bind };
}

function describeError(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/** Best-effort removal of one temp tree. A leftover dir is a temp leak, not a wrong answer. */
function removeTree(dir: string): void {
  try {
    rmSync(dir, { recursive: true, force: true });
  } catch (err) {
    trace(`spawn: could not remove ${dir}: ${describeError(err)}`);
  }
}

/**
 * Decide the child's permission shape and, in the strict shape, start its
 * permission broker. Starts listening sockets as a side effect — the caller
 * stops `broker` and calls `stopForgeBroker()` when the child exits, and awaits
 * `ready` before it reads `forge.socketPath`.
 */
export function planChildPermissions(opts: {
  runId: string;
  role: string;
  cwd: string;
  workCycleTrust?: boolean;
}): ChildPermissionPlan {
  // #2160 — the forge strip is mode-INDEPENDENT: an ops child keeps the login,
  // every other helper role loses it in trust, sandbox, strict and headless
  // alike, so the decision sits above the trust branch rather than inside it.
  const keepsLogin = keepsForgeLogin(opts.role);
  const broker = keepsLogin
    ? { forge: { keepsLogin } as ChildForgePlan, stop: (): void => {}, ready: Promise.resolve() }
    : startForgeBroker(opts.role, opts.cwd);
  const forge = broker.forge;
  const ready = broker.ready;
  const stopForgeBroker = (): void => {
    try {
      broker.stop();
    } catch (err) {
      trace(`spawn[${opts.role}]: forge broker stop failed: ${describeError(err)}`);
    }
  };
  const trustChild = isParentInTrustMode() || workCycleTrustEnabled(opts.workCycleTrust);
  // The operator's strict opt-in suppressed a /work cycle's trust request. Traced so
  // the strict child is explained in the log rather than looking like a regression.
  if (opts.workCycleTrust === true && strictOptIn()) {
    trace(
      `spawn[${opts.role}]: PI_ENSEMBLE_STRICT_PERMISSIONS=1 — /work trust suppressed, strict child`,
    );
  }
  // PI_ENSEMBLE_DISABLE_SUBAGENT_GUARD=1 forces the guard off (debugging escape hatch).
  const subagentGuardEnabled =
    process.env.PI_ENSEMBLE_DISABLE_SUBAGENT_GUARD !== "1" && !trustChild;
  if (!subagentGuardEnabled)
    return { subagentGuardEnabled, trustChild, forge, ready, stopForgeBroker };
  const permSocketPath = path.join(os.tmpdir(), `pi-rukas-perm-${opts.runId}-${opts.role}.sock`);
  const deps = makeBrokerDeps();
  if (!deps) {
    trace(
      `spawn[${opts.role}]: parent guard not ready — subagent permissions will headless-deny on ask`,
    );
    // No socket env var when no broker could start: the subagent's guard then
    // falls through to the headless deny cleanly.
    return { subagentGuardEnabled, trustChild, forge, ready, stopForgeBroker };
  }
  return {
    subagentGuardEnabled,
    trustChild,
    permSocketPath,
    broker: startBroker(permSocketPath, deps),
    forge,
    ready,
    stopForgeBroker,
  };
}

/** Write the plan's marker into the child env. Trust children never carry a socket. */
export function applyChildPermissionEnv(
  childEnv: NodeJS.ProcessEnv,
  plan: ChildPermissionPlan,
): void {
  if (plan.subagentGuardEnabled) {
    childEnv.PI_ENSEMBLE_SUBAGENT_MODE = "1";
    if (plan.permSocketPath) childEnv.PI_ENSEMBLE_PERM_SOCKET = plan.permSocketPath;
  } else if (plan.trustChild) {
    // Propagate trust mode so the child's own pi-rukas load (if any) short-circuits
    // the same way the parent does. An inherited socket must not survive into a
    // trust child: the broker it names is not this child's.
    // Sandbox sessions already set PI_ENSEMBLE_SANDBOX_MODE on every child via the wrapper env, so this covers the host case.
    childEnv.PI_ENSEMBLE_TRUST_MODE = "1";
    Reflect.deleteProperty(childEnv, "PI_ENSEMBLE_PERM_SOCKET");
  }
  // #2160 — a child carries a forge-read socket ONLY when this plan bound one.
  // The variable is what gates the tool at both of its sites (registration and
  // activation read it), so deleting it is what keeps both wrong cases off the
  // parent's broker: an ops child (which holds its own login and needs no
  // proxy), and a helper whose broker did not bind — an inherited path from an
  // outer pi-rukas process would name a daemon that is not this child's parent,
  // the takeover the broker's naming rule exists to prevent. A bind failure
  // leaves the variable unset in the first place; this arm is what makes an
  // INHERITED one impossible.
  //
  // BOTH halves are deleted here, never the socket alone. This is the last seam
  // to mutate the pair — `buildChildEnv` (spawn-child-env.ts) calls it after the
  // base env was built — so it is the one site that could hand a child half a
  // pair, and the one site that can ADD the socket (the block above adds
  // `PI_ENSEMBLE_PERM_SOCKET` the same way) while its delete names one of two
  // variables. A path with no key leaves the child unable to authenticate whoever
  // answers it; a key with no path is a secret with nothing to prove. Enforcing
  // the pairing rule here means it does not depend on the order of the earlier
  // delete in `buildChildForgeEnv`.
  if (plan.forge.keepsLogin || !plan.forge.socketPath) {
    Reflect.deleteProperty(childEnv, FORGE_READ_SOCKET_ENV);
    Reflect.deleteProperty(childEnv, FORGE_READ_SECRET_ENV);
  }
}
