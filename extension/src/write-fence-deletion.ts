/**
 * write-fence-deletion — the `tool_call` hook that keeps a child's DELETIONS
 * inside its own trees (#2200).
 *
 * The field evidence: a /work develop child hit a disk-quota error in the shared
 * temp root and cleared it itself — about fifty commands, `rm -rf` and `rmdir` on
 * literal paths, a `find … -print0 | xargs -0 -r rm -rf` sweep across thirty name
 * prefixes (other projects' temp dirs, test-runner dirs, other cycles' live
 * reviewer trees), and an `rm -rf` of a VCS root the operator kept under that
 * root. About 9.8 GB went. The write fence refused only the glob and
 * unresolvable-expansion forms: every LITERAL `rm -rf` outside the child's
 * worktree went through, because the write rule lets anything land under the OS
 * temp dirs (a build must be able to write there), and an interpreter one-liner
 * was not read at all.
 *
 * So the deletion rule is a second one, with a different allowance, registered
 * beside the fence but NOT gated on it:
 *
 *   - the allowed roots are the worktree, the cycle scratch dir and the child's
 *     OWN per-child temp root — never the shared temp root, whatever its name.
 *     They come from the raw env, never from `loadFenceConfig`: that returns
 *     undefined for exactly the reviewer (no `PI_ENSEMBLE_WRITE_ROOT`) and the
 *     `PI_ENSEMBLE_WRITE_FENCE=0` cases this hook must still refuse.
 *   - it has no opt-out. The hatch is the developer whole-tree fence's switch and
 *     reaches writes only; an operator who needs a deletion outside the roots runs
 *     it from the parent session, which this child-only hook does not cover.
 *   - what cannot be resolved at a delete position is refused, in the bash fence's
 *     own fail-closed vocabulary rather than a second invented verdict.
 *
 * Reading the command is the reader's job (write-fence-deletion-positions.ts):
 * the bash walk, the operand table and the interpreter reader, with the rule that
 * a word counts as a deleted path only when a command this rule owns named it.
 * This module is the judgement and the record: resolve each position, compare it
 * with the child's roots, refuse the first one that lies outside them.
 *
 * `git clean` is the one overlap. The destructive-git guard owns it and has its own
 * opt-out; a forcing clean (`-f`/`--force`, never `-n`) aimed OUTSIDE the child's
 * roots is refused here whatever that opt-out says, because that opt-out is about
 * the child's own working tree. Aimed inside, nothing here refuses it, so the
 * guard's rule and its hatch stay the only answer for the in-tree case and that
 * guard's test rows stay green. No `git clean` verb is added to the writers table.
 *
 * The refusal names the rule and the allowed roots and NEVER the target — a target
 * is an operator path and the handoff is public. Like the dependency rule (#1879)
 * this is a guardrail against an agent's own bad judgement, not a security
 * boundary: a command that names no path this scanner reads stays outside it, and
 * the categories it does not reach are listed in docs/troubleshooting.md.
 */

import { statSync } from "node:fs";
import path from "node:path";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { trace, traceWarn } from "./trace.ts";
import { deletePositions } from "./write-fence-deletion-positions.ts";
import {
  NOT_JUDGED_LOG_TOKEN,
  OUTSIDE_REASON,
  UNRESOLVED_REASON,
} from "./write-fence-deletion-tokens.ts";
import { appendWriteFenceRefusal } from "./write-fence-log.ts";
import { isInside, safeResolve } from "./write-fence-path.ts";

export {
  DELETION_LOG_TOKEN,
  GIT_CLEAN_LOG_TOKEN,
  NOT_JUDGED_LOG_TOKEN,
  OUTSIDE_REASON,
} from "./write-fence-deletion-tokens.ts";

/** What the hook may delete into, as the child's env named it. */
export interface DeletionRoots {
  /** The child's working directory: the base for a target the command left relative. */
  cwd: string;
  /** The worktree, scratch dir and per-child temp root, exactly as the env named them. */
  labels: string[];
  /** The same roots as realpaths; an unusable one is absent, never guessed at. */
  allowed: string[];
}

/** A refused delete position: the log's `path` token, and the reason clause. */
export interface DeletionHit {
  token: string;
  reason: string;
}

/** Resolve a target and judge it against the allowed roots; undefined when it lies inside one. */
function judge(abs: string, roots: DeletionRoots, token: string): DeletionHit | undefined {
  const real = safeResolve(abs);
  if (real === undefined) return { token, reason: UNRESOLVED_REASON };
  if (roots.allowed.some((allowed) => isInside(real, allowed))) return undefined;
  return { token, reason: OUTSIDE_REASON };
}

/**
 * The first delete position this child may not take, or undefined when every one
 * lies inside its roots.
 */
export function firstDeletionOutside(
  command: string,
  roots: DeletionRoots,
): DeletionHit | undefined {
  for (const hit of deletePositions(command, roots.cwd)) {
    if (hit.reason !== "") return { token: hit.token, reason: hit.reason };
    const judged = judge(hit.path ?? "", roots, hit.token);
    if (judged !== undefined) return judged;
  }
  return undefined;
}

/** The per-child temp root the spawn layer names for one child (#2200), as
 * `writeRolePromptFile` creates it. Read as a NAME and not as a property, so the
 * env inventory in headless/inputs.ts stays the single list of what the build honours. */
export const CHILD_TMP_ENV = "PI_ENSEMBLE_CHILD_TMP";

/** One usable absolute root from the env, as the label it was named by and its realpath. */
function usableRoot(raw: string | undefined): { label: string; real: string } | undefined {
  if (raw === undefined || raw === "" || !path.isAbsolute(raw)) return undefined;
  try {
    if (!statSync(raw).isDirectory()) return undefined;
  } catch {
    // Any stat failure (ENOENT, EACCES on a parent) means the root is not usable.
    return undefined;
  }
  const real = safeResolve(raw);
  return real === undefined ? undefined : { label: raw, real };
}

/**
 * The roots this child may delete into, from the RAW env. Every role receives a
 * per-child temp root; a fenced dispatch also has its worktree and its scratch
 * dir. Never `loadFenceConfig` — it is undefined for exactly the reviewer and the
 * hatch cases this rule must still judge. A root the env names that is not a
 * usable directory is left out, so a child the driver gave nothing has NO allowed
 * root and every deletion it attempts is refused.
 */
export function deletionRootsFrom(
  env: NodeJS.ProcessEnv,
  cwd: string = process.cwd(),
): DeletionRoots {
  const usable = [
    usableRoot(env.PI_ENSEMBLE_WRITE_ROOT),
    usableRoot(env.PI_ENSEMBLE_WRITE_SCRATCH),
    usableRoot(env[CHILD_TMP_ENV]),
  ].filter((r): r is { label: string; real: string } => r !== undefined);
  return { cwd, labels: usable.map((r) => r.label), allowed: usable.map((r) => r.real) };
}

/** The refusal the child sees: the rule, the allowed roots, and never the target. */
export function deletionRefusalText(roots: DeletionRoots, why: string): string {
  const allowed = roots.labels.length > 0 ? roots.labels.join(", ") : "none";
  return `Refused: ${why}. Allowed roots: ${allowed}. Delete inside those, or report the need to the PM; a shared temp root, the main checkout, a sibling worktree and $HOME are not yours to remove.`;
}

/**
 * Register the deletion guard for this child. It registers for EVERY child in
 * every mode and role: no env switch is consulted, so neither a missing
 * `PI_ENSEMBLE_WRITE_ROOT` (a reviewer) nor the operator's
 * `PI_ENSEMBLE_WRITE_FENCE=0` (the developer hatch) can disarm it (#2200 D5).
 *
 * `roots` is injectable so the tests can point the rule at a fixture; production
 * reads the env and the cwd at registration, which is what the child's dispatch
 * decided for it.
 */
export function registerDeletionGuard(
  pi: ExtensionAPI,
  deps: { roots?: DeletionRoots; env?: NodeJS.ProcessEnv; cwd?: string } = {},
): void {
  const env = deps.env ?? process.env;
  const roots = deps.roots ?? deletionRootsFrom(env, deps.cwd ?? process.cwd());
  const role = env.PI_ENSEMBLE_ROLE;
  const log = { scratch: env.PI_ENSEMBLE_WRITE_SCRATCH, repo: env.PI_ENSEMBLE_WRITE_REPO };
  pi.on("tool_call", async (event) => {
    if (event.toolName !== "bash") return;
    const command = (event.input as { command?: unknown } | undefined | null)?.command;
    if (typeof command !== "string") return;
    let hit: DeletionHit | undefined;
    try {
      hit = firstDeletionOutside(command, roots);
    } catch (err) {
      // An internal fault is a refusal too: the call was not judged, so it does not run.
      const reason = `deletion guard could not judge this call: ${(err as Error).message}`;
      trace(`write-fence-deletion: ${reason}`);
      recordRefusal(log, NOT_JUDGED_LOG_TOKEN, reason, role);
      return { block: true, reason };
    }
    if (hit === undefined) return;
    const reason = deletionRefusalText(roots, hit.reason);
    recordRefusal(log, hit.token, reason, role);
    return { block: true, reason };
  });
}

/**
 * Record one refusal. A child with a scratch dir appends through the write fence's
 * own channel, so the driver counts it beside the fence's refusals. A child with
 * none — a reviewer, which the driver never fences — has no scratch to append to,
 * so the refusal reaches the ungated warn and is declared uncounted (#2200 D2):
 * the pinned refusal totals cover fenced children only.
 */
function recordRefusal(
  log: { scratch?: string; repo?: string },
  token: string,
  reason: string,
  role: string | undefined,
): void {
  if (log.scratch !== undefined && log.scratch !== "") {
    appendWriteFenceRefusal(
      log.scratch,
      { tool: "bash", path: token, reason, at: Date.now() },
      log.repo,
    );
    trace(`write-fence-deletion: refused a deletion (${token})`);
    return;
  }
  traceWarn(
    `write-fence-deletion: refused a deletion (${token}) for the ${role ?? "unroled"} child — not counted, it has no scratch dir`,
  );
}
