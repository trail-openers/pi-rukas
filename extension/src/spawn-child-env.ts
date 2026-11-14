/**
 * spawn-child-env — the child's `env` object, assembled in one place (#2160).
 *
 * `spawnSpecialistInner` sits at the AGENTS.md §12 size cap, and the env it
 * hands `spawn()` is a concern of its own: five separate rules stack into it,
 * each with its own reason, and reading them inline in the spawn body hides the
 * ORDER those rules are applied in. The order is the contract:
 *
 *   1. `childBaseEnv` — the inherited copy with a non-ops child's forge login
 *      removed and its config roots pointed at a fresh empty dir
 *      (spawn-permission.ts → child-forge-env.ts). The caller awaits
 *      `plan.ready` BEFORE calling this, so the forge socket named here is one
 *      the parent really bound.
 *   2. the vipune and write-fence additions the dispatch owns;
 *   3. `scrubGitLocation` — an inherited GIT_DIR & co. would point the child's
 *      git at another tree (git-env.ts, #1571);
 *   4. the GIT_* non-interactive pins — they MUST come after the inherited copy
 *      to win over the host's values (#605; the layout is pinned by
 *      test-subagent-git-guard.ts's lexical canary);
 *   5. `applyChildPermissionEnv` — the permission-mode marker and socket;
 *   6. `childTempEnv` — the child's own temp root, LAST, so no inherited
 *      `TMPDIR`/`TMP`/`TEMP` can win (#2241; the placement is pinned by
 *      test-child-tmpdir-2241.ts's canary, which reads this call site in
 *      `spawn.ts` — the caller passes the per-spawn dir and nothing after this
 *      line may touch the env).
 *
 * Nothing here decides policy: every rule lives with its owner and this module
 * only composes them. It takes the values the caller resolved rather than the
 * plan object, so the seam stays free of the permission module's types.
 */

import { scrubGitLocation } from "./git-env.ts";
import {
  type ChildPermissionPlan,
  applyChildPermissionEnv,
  childBaseEnv,
} from "./spawn-permission.ts";
import { vipuneChildEnv } from "./vipune.ts";
import type { WriteFence } from "./write-fence-contract.ts";
import { childTempEnv, writeFenceChildEnv } from "./write-fence-contract.ts";
import { CHILD_TMP_ENV } from "./write-fence-deletion.ts";

/**
 * Build the environment one specialist child runs with.
 *
 * `role` is the dispatched role (the forge strip is role-gated on it), `plan`
 * is the child's permission/forge plan from `planChildPermissions` — awaited on
 * `plan.ready` by the caller, since the forge socket only exists once the bind
 * settled — `writeFence` is the dispatch's fence — absent for an unfenced
 * child, which keeps the fence off for it — and `childTmp` is the spawn's
 * per-spawn dir: the ONLY temp tree this child may delete into (#2200), so it
 * is named as its deletion root and, last, as its temp root (#2241).
 */
export function buildChildEnv(
  role: string,
  plan: ChildPermissionPlan,
  writeFence?: WriteFence,
  childTmp?: string,
): Record<string, string> {
  // #2160 — the base env comes from the one helper both spawn paths call: it
  // strips a non-ops child's forge tokens, points its config roots at a fresh
  // empty dir, and names the parent's forge-read socket.
  const childEnv = childBaseEnv(role, plan.forge);
  Object.assign(childEnv, vipuneChildEnv(), writeFenceChildEnv(writeFence));
  // #1571 — the child works in `cwd`; an inherited GIT_DIR & co. would point
  // its git at another tree (git-env.ts).
  scrubGitLocation(childEnv);
  // Interactive-git hang prevention (#605). These win over the inherited
  // host env: a child that reaches an editor, sequence editor, terminal
  // prompt, or full-screen pager (git rebase -i, bare git commit, any
  // credential prompt, a paged diff) must never wait on a TTY it does not
  // have — the inactivity watchdog would otherwise kill it 25 minutes later
  // and misclassify the stall. `true` (the real no-op binary) over `:`
  // (a shell builtin git cannot exec), per Aider's pattern.
  childEnv.GIT_EDITOR = "true";
  childEnv.GIT_SEQUENCE_EDITOR = "true";
  childEnv.GIT_TERMINAL_PROMPT = "0";
  childEnv.GIT_PAGER = "cat";
  applyChildPermissionEnv(childEnv, plan);
  // #2241 — the child's own temp root, LAST of the childEnv writes. The
  // per-spawn dir is named TWICE because the two names answer different
  // questions: `PI_ENSEMBLE_CHILD_TMP` is the root the deletion rule (#2200)
  // judges against (set here, where the dir exists, so the rule's roots and the
  // spawn's cleanup can never name different directories), and TMPDIR/TMP/TEMP
  // are the spellings the child's own tools honour. An inherited value must
  // never win, so nothing below this line may touch the env — the placement the
  // `GIT_*` canary in test-subagent-git-guard.ts pins for its own assignments.
  if (childTmp !== undefined) {
    childEnv[CHILD_TMP_ENV] = childTmp;
    Object.assign(childEnv, childTempEnv(childTmp));
  }
  return childEnv;
}
