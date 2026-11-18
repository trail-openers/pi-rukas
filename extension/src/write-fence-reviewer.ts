/**
 * write-fence-reviewer — the `tool_call` hook that confines a READ-ONLY child's
 * bash to the tree it was given and its own scratch (#2352).
 *
 * The field shape, three times in one day: an adversarial or lens child probing a
 * target project moved that project's live state directory into its scratch and
 * restored it by copying, planted thousands of files in it, and left a name with a
 * leading space and a symlink. Reviewer roles (and `explore`) have
 * write/edit/multiedit structurally excluded, so bash is their only write path —
 * and the two rules that judge a child's bash both stand aside for them:
 * `write-fence.ts`'s whole-tree fence needs `PI_ENSEMBLE_WRITE_ROOT`, which no
 * reviewer dispatch sets, and `write-fence-deps.ts` refuses only writes into a
 * shared dependency tree.
 *
 * So this is the third rule in the seam, with the deletion rule's shape and a
 * write-side allowance. Its verdicts are the three classes the issue settles (R4):
 * a target that resolves OUTSIDE the child's roots is REFUSED (a move, a copy
 * destination, a link name, a delete, an in-place edit, a `>`/`>>` redirect); a
 * target inside them is ALLOWED whatever the verb; and a word the judge cannot
 * resolve is REFUSED only for the verbs `write-fence-reviewer-positions.ts` names
 * as write positions — which is what keeps a reviewer able to review. That module
 * is the reading half (which words are write positions, and which cannot be
 * judged); this one is the roots, the verdict, the record and the hook.
 *
 * Allowed roots are the child's resolved `cwd` (the throwaway reviewer tree when
 * isolation succeeded, the caller's cwd when it fell back — `reviewer-tree.ts`)
 * plus `PI_ENSEMBLE_CHILD_TMP`, which holds the scratch HOME
 * (`reviewer-scratch-home.ts`). One root variable, no new allocation, and
 * `PI_ENSEMBLE_REVIEWER_ISOLATION=0` narrows nothing: the cwd judged is the one the
 * child really runs in.
 *
 * The consequence is the siblings' (R6): ONE tool call is refused, the child sees
 * the reason, and the refusal is recorded through `appendWriteFenceRefusal` — into
 * the cycle scratch when the dispatch has one, otherwise into the child's own
 * per-spawn dir, which a confined child always has, so the count survives — falling
 * back to `traceWarn` when even that is absent. `ok`, `loopOutcome` and the
 * adversarial/lens verdicts are untouched. This is a guardrail against an agent's
 * own bad judgement, not a sandbox: a write that names no path the readers read —
 * and, per R10, anything that resolves its store through the passwd entry rather
 * than `$HOME` — stays outside it, which is the half the scratch HOME covers.
 */

import { statSync } from "node:fs";
import path from "node:path";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { isConfinedRole } from "./reviewer-scratch-home.ts";
import { UNISOLATED_CHILD_ENV } from "./reviewer-tree.ts";
import { trace, traceWarn } from "./trace.ts";
import { NOT_JUDGED_LOG_TOKEN } from "./write-fence-deletion-tokens.ts";
import { CHILD_TMP_ENV } from "./write-fence-deletion.ts";
import { appendWriteFenceRefusal } from "./write-fence-log.ts";
import { isInside, safeResolve } from "./write-fence-path.ts";
import { type WritePosition, writePositions } from "./write-fence-reviewer-positions.ts";

/** The log line's `path` field for a confined-role write. Never the target. */
export const REVIEWER_WRITE_LOG_TOKEN = "(reviewer write)";

/** Why a target outside the child's roots is refused. Names the rule, never the target. */
export const REVIEWER_OUTSIDE_REASON =
  "it writes, moves, links or removes outside the tree you were given to review and your own scratch dir. Work inside those, or report the need to the PM";

/** Why a target that cannot be resolved is refused (the deletion rule's vocabulary). */
export const REVIEWER_UNRESOLVED_REASON =
  "its path could not be resolved (a symbolic link loop, or a parent this child cannot read), so the target cannot be judged";

/** Re-exported so the position reader and the judge cannot name different verbs. */
export { GUARDED_COMMANDS, POSITION_UNJUDGED_REASON } from "./write-fence-reviewer-positions.ts";

/** The two roots this child may write into, as its env and cwd named them. */
export interface ReviewerRoots {
  /** The child's working directory — the base for a target the command left relative. */
  cwd: string;
  /** The roots as the child named them, for the refusal text. */
  labels: string[];
  /** The same roots as realpaths; an unusable one is absent, never guessed at. */
  allowed: string[];
}

/** A refused position: the log's `path` token, and the reason clause. */
export interface ReviewerHit {
  token: string;
  reason: string;
}

/** One usable absolute root, as the label it was named by and its realpath. */
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

/** The env name that says this reviewer was left in the reviewed tree (#2352 C2). */
export const REVIEWER_UNISOLATED_ENV = UNISOLATED_CHILD_ENV;

/**
 * The roots a confined child may write into: its own cwd (the reviewer tree, or the
 * caller's cwd when isolation fell back) and its per-spawn dir, which holds the
 * scratch HOME. Both read from the RAW env and the child's own cwd, never
 * `loadFenceConfig` — a reviewer has no write root, and that absence is the case
 * this rule exists for.
 *
 * One exception, and it is the fail-open's: when the spawn marked this child
 * `PI_ENSEMBLE_REVIEWER_UNISOLATED=1` it is telling the guard that the cwd it is
 * about to hand the child is the REVIEWED tree, not a throwaway one — the tree the
 * child was meant to be kept out of. Judging it as a writable root would give the
 * unisolated reviewer exactly the access the isolated one has, which is the hole the
 * field's four shapes walked through. So the cwd root is dropped and only the child's
 * scratch (and the scratch HOME under it) stays writable. Nothing else in the spawn
 * writes that name, so an isolated reviewer keeps its tree.
 */
export function reviewerRootsFrom(
  env: NodeJS.ProcessEnv = process.env,
  cwd: string = process.cwd(),
): ReviewerRoots {
  const dirs = env[UNISOLATED_CHILD_ENV] === "1" ? [env[CHILD_TMP_ENV]] : [cwd, env[CHILD_TMP_ENV]];
  const usable = dirs
    .map((raw) => usableRoot(raw))
    .filter((r): r is { label: string; real: string } => r !== undefined);
  return { cwd, labels: usable.map((r) => r.label), allowed: usable.map((r) => r.real) };
}

/**
 * Judge one position: no hit when its path lies inside a root, the outside reason
 * when it does not, and the unjudgeable reason when the reader could not resolve it
 * at all — the class-(c) case for a target, which is refused rather than guessed.
 */
function judgePosition(p: WritePosition, roots: ReviewerRoots): ReviewerHit | undefined {
  if (p.reason !== "") return { token: p.token, reason: p.reason };
  if (p.path === undefined || p.path === "") {
    return { token: p.token, reason: REVIEWER_UNRESOLVED_REASON };
  }
  const real = safeResolve(p.path);
  if (real === undefined) return { token: p.token, reason: REVIEWER_UNRESOLVED_REASON };
  if (roots.allowed.some((allowed) => isInside(real, allowed))) return undefined;
  return { token: p.token, reason: REVIEWER_OUTSIDE_REASON };
}

/**
 * The first thing this confined child may not touch, or undefined when the command
 * stays inside its roots. Throws only on an internal fault, which the caller turns
 * into a refusal.
 */
export function firstReviewerWriteOutside(
  command: string,
  roots: ReviewerRoots,
): ReviewerHit | undefined {
  for (const p of writePositions(command, roots.cwd)) {
    const hit = judgePosition(p, roots);
    if (hit !== undefined) return hit;
  }
  return undefined;
}

/** The refusal the child sees: the rule, its roots, and never the target. */
export function reviewerRefusalText(roots: ReviewerRoots, why: string): string {
  const allowed = roots.labels.length > 0 ? roots.labels.join(", ") : "none";
  return `Refused: ${why}. Your roots: ${allowed}. Write, move, link and remove inside those; the operator's home, a sibling worktree and the shared temp root are not yours to change.`;
}

/**
 * Register the confinement hook for this child. Like the deletion rule it sits in the
 * mode-independent companion ABOVE the `PI_ENSEMBLE_SUBAGENT_MODE` no-op, so a
 * strict/headless child is judged too, and it registers through `failClosedPi` so an
 * internal fault answers as a refusal rather than a pass.
 *
 * `roots`/`env`/`cwd` are injectable so the tests point the rule at a fixture;
 * production reads the child's own env and cwd at registration, which is what the
 * dispatch decided for it.
 */
export function registerReviewerWriteGuard(
  pi: ExtensionAPI,
  deps: { roots?: ReviewerRoots; env?: NodeJS.ProcessEnv; cwd?: string } = {},
): void {
  const env = deps.env ?? process.env;
  const role = env.PI_ENSEMBLE_ROLE;
  // Two gates, both read at registration: the switch (the operator's escape hatch
  // for a review that must reach outside) and the role (only the read-only set has an
  // unfenced bash and no write tool). A developer, ops or lens-fix child is untouched
  // — the driver's fence is what confines them.
  if (env.PI_ENSEMBLE_REVIEWER_WRITE_GUARD === "0") return;
  if (!isConfinedRole(role)) return;
  const roots = deps.roots ?? reviewerRootsFrom(env, deps.cwd ?? process.cwd());
  const log = { scratch: env.PI_ENSEMBLE_WRITE_SCRATCH, repo: env.PI_ENSEMBLE_WRITE_REPO };
  pi.on("tool_call", async (event) => {
    if (event.toolName !== "bash") return;
    const command = (event.input as { command?: unknown } | undefined | null)?.command;
    if (typeof command !== "string") return;
    let hit: ReviewerHit | undefined;
    try {
      hit = firstReviewerWriteOutside(command, roots);
    } catch (err) {
      // An internal fault is a refusal too: the call was not judged, so it does not run.
      const reason = `reviewer write guard could not judge this call: ${(err as Error).message}`;
      trace(`write-fence-reviewer: ${reason}`);
      recordRefusal(log, NOT_JUDGED_LOG_TOKEN, reason, role);
      return { block: true, reason };
    }
    if (hit === undefined) return;
    const reason = reviewerRefusalText(roots, hit.reason);
    recordRefusal(log, hit.token, reason, role);
    return { block: true, reason };
  });
}

/**
 * Record one refusal the way the sibling rules do: through the write fence's own
 * channel, into the cycle scratch when the dispatch set one and otherwise into the
 * child's per-spawn dir, which a confined child always has — so a reviewer's
 * refusals are countable rather than confined to a warn line nobody reads. Only when
 * neither exists does the line go to the ungated warn, declared uncounted. Never a
 * verdict change (R6).
 */
function recordRefusal(
  log: { scratch?: string; repo?: string },
  token: string,
  reason: string,
  role: string | undefined,
): void {
  const dir = log.scratch ?? process.env[CHILD_TMP_ENV] ?? "";
  if (dir !== "") {
    appendWriteFenceRefusal(dir, { tool: "bash", path: token, reason, at: Date.now() }, log.repo);
    trace(`write-fence-reviewer: refused a write (${token})`);
    return;
  }
  traceWarn(
    `write-fence-reviewer: refused a write (${token}) for the ${role ?? "unroled"} child — not counted, it has no scratch dir`,
  );
}
