/**
 * write-fence-deps — the dependency-tree refusal for READ-ONLY roles (#1879).
 *
 * The incident: a reviewer child — a role structurally denied write/edit/
 * multiedit, whose bash is NOT fenced — wrote over the main checkout's shared
 * `extension/node_modules/typescript/bin/tsc` with a `sleep 9.5; exit 0` stub,
 * and every local typecheck exited 0 on any tree for eleven minutes. The write
 * fence does not cover that case: a reviewer has no `PI_ENSEMBLE_WRITE_ROOT`, so
 * the fence is inert for it, and even with one, a dependency write through a
 * provisioned link is ALLOWED — that is what provisioning exists for.
 *
 * So the rule is different, and narrower: a read-only role does not need to
 * install anything, so no dependency tree is ever a legitimate target for it, in
 * the worktree or in the main checkout. A developer keeps the old behaviour
 * untouched; only the three roles whose tools already exclude write/edit are
 * held to this through their bash.
 *
 * What this rule actually sees is exactly what the bash target list resolves:
 * the tabled writers (`cp`/`mv`/`install`/`ln`/`link`, `sed -i`, `tar -C`, `rm`,
 * `tee`, redirections the lexer can resolve — see write-fence-bash-writers.ts).
 * It judges NOTHING else, and it is not trying to: an interpreter one-liner
 * (`node -e`, `python -c`), a heredoc or any other target the lexer cannot
 * resolve, and git's own writes all reach the tree without appearing in that
 * list. The compiler-integrity canary (work-driver-toolchain-canary.ts) is the
 * backstop for precisely those — it asks the compiler itself whether it still
 * refuses a known type error, so a clobber that this rule could not see is still
 * caught before any tier is trusted as GREEN.
 *
 * Judged on the RESOLVED path, so `<worktree>/node_modules/tsc` — which the OS
 * resolves into `<repo>/node_modules/tsc` through the provisioned link — is
 * caught, and so is the same path named directly. A symlink the CHILD creates
 * mid-command is not trusted to name the tree it will resolve to.
 */

import path from "node:path";
import { trace } from "./trace.ts";
import { SHAREABLE_DEPS } from "./worktree-dep-contract.ts";
import type { BashTarget } from "./write-fence-bash.ts";

/** The roles whose write/edit tools are structurally excluded, so bash is their only write path. */
export const READ_ONLY_ROLES = [
  "explore",
  "adversarial-developer",
  "code-review-specialist",
] as const;

/** Is `role` one of the read-only roles this rule covers? */
export function isReadOnlyRole(role: string | undefined): boolean {
  return role !== undefined && (READ_ONLY_ROLES as readonly string[]).includes(role);
}

/** Why a dependency write is refused. Names the role and the tree, not the rule's edges. */
export function depRefusalText(target: string, role: string): string {
  return `Refused: ${target} — ${JSON.stringify(role)} is a read-only role and may not write to a dependency directory (node_modules and the other shared dependency trees). A reviewer that needs a package writes it under the scratch dir, or reports the need to the PM.`;
}

/**
 * Does this resolved absolute path name an entry inside (or the root of) one of
 * the shared dependency trees? A plain-segment check, not a substring test:
 * `src/node_modules.md` names a FILE called that and is not a dependency path,
 * while `…/node_modules/typescript/bin/tsc` and a write aimed at the tree root
 * both are. `vendor` and `.venv` count because those are the trees
 * worktree-provision.ts shares, so the incident generalises to all three.
 */
export function isDependencyPath(abs: string): boolean {
  return abs.split(path.sep).some((seg) => (SHAREABLE_DEPS as readonly string[]).includes(seg));
}

/**
 * The first bash target that lands in a dependency tree, or undefined when the
 * command writes only outside them. `resolve` is injected so the test can pin
 * the rule to a resolved path without touching the filesystem.
 */
export function firstDependencyWrite(
  targets: BashTarget[],
  resolve: (p: string) => string | undefined,
): string | undefined {
  for (const t of targets) {
    // An unjudgeable target is the write fence's problem, not this rule's; it is
    // refused there. Here it is not evidence of a dependency write.
    if (t.opaque !== undefined) continue;
    const abs = path.isAbsolute(t.path) ? t.path : path.resolve(t.cwd, t.path);
    const real = resolve(abs);
    if (real !== undefined && isDependencyPath(real)) return t.path;
  }
  return undefined;
}

/**
 * The refusal this role's bash deserves, or undefined when the command is fine.
 * Returns a block-shaped reason in the same shape the write fence uses.
 */
export function depWriteRefusal(
  role: string | undefined,
  targets: BashTarget[],
  resolve: (p: string) => string | undefined,
): string | undefined {
  if (!isReadOnlyRole(role)) return undefined;
  const hit = firstDependencyWrite(targets, resolve);
  if (hit === undefined) return undefined;
  const reason = depRefusalText(hit, role as string);
  trace(`write-fence-deps: refused ${role} bash write to ${hit}`);
  return reason;
}
