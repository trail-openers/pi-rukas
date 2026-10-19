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

import os from "node:os";
import path from "node:path";
import { type BrokerHandle, startBroker } from "./permission-broker.ts";
import { isParentInTrustMode, makeBrokerDeps } from "./permission-guard.ts";
import { trace } from "./trace.ts";

export interface ChildPermissionPlan {
  /** Strict shape: the broker is wired and the pi-rukas extension is forwarded. */
  subagentGuardEnabled: boolean;
  /** Trust shape: the child gets the PI_ENSEMBLE_TRUST_MODE marker. */
  trustChild: boolean;
  permSocketPath?: string;
  broker?: BrokerHandle;
}

/**
 * Whether a dispatch's `workCycleTrust` request is honoured. The runner's own
 * strict opt-in wins over the cycle's request, so an operator who sets
 * PI_ENSEMBLE_STRICT_PERMISSIONS=1 gets today's allowlist behaviour back.
 */
export function workCycleTrustEnabled(workCycleTrust: boolean | undefined): boolean {
  return workCycleTrust === true && process.env.PI_ENSEMBLE_STRICT_PERMISSIONS !== "1";
}

/**
 * Decide the child's permission shape and, in the strict shape, start its
 * broker. Starts a listening socket as a side effect — the caller stops
 * `broker` when the child exits.
 */
export function planChildPermissions(opts: {
  runId: string;
  role: string;
  workCycleTrust?: boolean;
}): ChildPermissionPlan {
  const trustChild = isParentInTrustMode() || workCycleTrustEnabled(opts.workCycleTrust);
  // PI_ENSEMBLE_DISABLE_SUBAGENT_GUARD=1 forces the guard off (debugging escape hatch).
  const subagentGuardEnabled =
    process.env.PI_ENSEMBLE_DISABLE_SUBAGENT_GUARD !== "1" && !trustChild;
  if (!subagentGuardEnabled) return { subagentGuardEnabled, trustChild };
  const permSocketPath = path.join(os.tmpdir(), `pi-rukas-perm-${opts.runId}-${opts.role}.sock`);
  const deps = makeBrokerDeps();
  if (!deps) {
    trace(
      `spawn[${opts.role}]: parent guard not ready — subagent permissions will headless-deny on ask`,
    );
    // No socket env var when no broker could start: the subagent's guard then
    // falls through to the headless deny cleanly.
    return { subagentGuardEnabled, trustChild };
  }
  return {
    subagentGuardEnabled,
    trustChild,
    permSocketPath,
    broker: startBroker(permSocketPath, deps),
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
    childEnv.PI_ENSEMBLE_TRUST_MODE = "1";
    childEnv.PI_ENSEMBLE_PERM_SOCKET = undefined;
  }
}
