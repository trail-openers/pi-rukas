/**
 * parent-guards — the guards the PARENT session needs that the shared child
 * block does not already cover (#1788).
 *
 * Split out of `permission-guard.ts` for the §12 size cap: that file sits one
 * line under the 500-line limit, and a role-scoped registration does not
 * belong in the file that owns the verdict-resolution machinery anyway.
 *
 * ## Why the parent needs its own call for the hygiene guard
 *
 * `registerModeIndependentGuards` (subagent-guard-guards.ts) is the block the
 * CHILD entry points call — the companion (`child-guards.ts`, trust-mode
 * children) and `registerSubagentGuard` (strict/headless children). The parent
 * path in `permission-guard.ts` does NOT call that block, so a guard registered
 * only there guards every child and nothing else. For the public hygiene guard
 * that is the wrong half: the parent session is the PM, and the PM is the role
 * that writes issue bodies, PR prose, and hand-typed `gh` invocations — exactly
 * the publishes this guard exists to catch (three of the issues #598 closed were
 * PM-authored). So the parent registers it directly, and because a child can
 * reach both sites (a strict child loaded with the full extension AND the
 * companion), the guard is idempotent per process — see its header, and
 * `test-public-hygiene-guard.ts`'s double-registration case.
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { execp } from "./exec.ts";
import { registerPublicHygieneGuard } from "./public-hygiene-guard.ts";

/**
 * Register the parent-path guards. Call from `registerPermissionGuard`, before
 * the sandbox short-circuit, the subagent branch, and the trust-mode early
 * return — a hook placed after any of those would, in practice, never run.
 */
export function registerParentGuards(pi: ExtensionAPI): void {
  // #1788 — a publish whose text carries a private term is refused here. The
  // repository is public, and the modes this must fire in are the defaults.
  // The executor is named at the call site (#1788 round 2): without it the push
  // scan silently never ran, because a guard with no executor reports the push
  // range as "not read" and the pass-for-no-executor branch lets it through.
  registerPublicHygieneGuard(pi, { execFn: execp });
}
