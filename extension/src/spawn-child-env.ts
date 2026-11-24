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
 *   2. the vipune, write-fence and codemode-worker additions the dispatch owns;
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
 *      line may touch the env). The same six rules are what
 *      {@link buildResumedChildEnv} stacks for a child that resumes a session
 *      outside `spawnSpecialist`, so "the child's env" has one definition.
 *
 * Nothing here decides policy: every rule lives with its owner and this module
 * only composes them. It takes the values the caller resolved rather than the
 * plan object, so the seam stays free of the permission module's types.
 *
 * A child spawned OUTSIDE `spawnSpecialist` — a resumed session re-asked for the
 * one artefact it owed — calls {@link buildResumedChildEnv} rather than the forge
 * strip on its own. The strip alone leaves out the role stamp, the per-child temp
 * root and the read-only role's scratch `HOME`/XDG, and those three are what make
 * the child-side guards judge anything: a re-ask that built its env that way was
 * the same role running unjudged (#2611).
 */

import { childCodemodeWorkersEnv } from "./child-codemode.ts";
import { CHILD_ROLE_ENV, childRoleEnvEnabled, childRoleEnvValue } from "./child-role-env.ts";
import { scrubGitLocation } from "./git-env.ts";
import {
  reviewerScratchHomeEnabled,
  reviewerScratchHomeEnv,
  reviewerWriteGuardEnabled,
} from "./reviewer-scratch-home.ts";
import { UNISOLATED_CHILD_ENV } from "./reviewer-tree.ts";
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
 * is named as its deletion root and, last, as its temp root (#2241). A
 * read-only role's child also gets `PI_ENSEMBLE_ROLE` stamped here (#2352 R11)
 * and, when the guard that makes it meaningful is on, a scratch `HOME`/XDG set
 * derived from that same dir (#2352 R12). `failOpen` is the spec's mark that the
 * reviewer-isolation choke point left this child in the reviewed tree, and it
 * becomes the env name that rule reads (#2352 C2).
 */
export function buildChildEnv(
  role: string,
  plan: ChildPermissionPlan,
  writeFence?: WriteFence,
  childTmp?: string,
  failOpen?: boolean,
): Record<string, string> {
  // #2160 — the base env comes from the one helper both spawn paths call: it
  // strips a non-ops child's forge tokens, points its config roots at a fresh
  // empty dir, and names the parent's forge-read socket.
  const childEnv = childBaseEnv(role, plan.forge);
  // #2352 R11 — the role is stamped HERE, the one env construction the spawn
  // path calls. Every role-scoped child-side rule (`write-fence.ts`'s
  // read-only dependency rule, `write-fence-deletion.ts`'s roots and its `ops`
  // carve-out, `review-bash-timeout.ts`, the push ban, and this issue's
  // reviewer guard) reads `PI_ENSEMBLE_ROLE` from the child's own env, so
  // without this line all of them were inert for a spawned child: the only
  // other stamper is `childEnvFor` (write-fence-contract.ts), which smoke
  // tests call and production spawn does not.
  // R11: the role is stamped HERE, and the value is the plan's string VERBATIM —
  // `childRoleEnvValue` only trims, so `lens-fix` reaches the guards as `lens-fix`
  // and not as some other role's spelling. Never an empty value: an unset role
  // leaves the key absent, which is distinguishable from a role that judges nothing.
  const stamped = childRoleEnvValue(role);
  if (childRoleEnvEnabled() && stamped !== undefined) childEnv[CHILD_ROLE_ENV] = stamped;
  // #2352 C2 — a reviewer the isolation choke point could NOT relocate is told so,
  // and its guard drops the reviewed cwd from its roots accordingly: the tree it was
  // pointed at is the one it was meant to be kept out of, so it is not a writable
  // root. Absent unless the choke point marked this dispatch (see `DispatchSpec`).
  if (failOpen === true) childEnv[UNISOLATED_CHILD_ENV] = "1";
  Object.assign(
    childEnv,
    vipuneChildEnv(),
    writeFenceChildEnv(writeFence),
    childCodemodeWorkersEnv(),
  );
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
    // #2352 R12 — a read-only child's bash sees a scratch HOME and its own XDG
    // roots, so a probe that writes through `$HOME` or `$XDG_STATE_HOME` lands
    // under the per-spawn dir instead of the operator's live state. The scratch
    // is created HERE (the spawn's own `finally` removes the parent, so there is
    // no new allocation and no new cleanup site), and the value is derived from
    // it. The stamp is gated on BOTH #2352 switches: the guard is the
    // load-bearing half (R10 — a tool that resolves home through getpwuid
    // ignores `HOME`), so the redirect alone would be an isolation nobody could
    // rely on and a tree nobody asked for.
    if (reviewerScratchHomeEnabled() && reviewerWriteGuardEnabled()) {
      Object.assign(childEnv, reviewerScratchHomeEnv(role, childTmp));
    }
    Object.assign(childEnv, childTempEnv(childTmp));
  }
  return childEnv;
}

/**
 * The env of a child that RESUMES an existing session outside `spawnSpecialist`
 * (#2611): the same rules the dispatch path stacks, over a permission plan that
 * adds nothing.
 *
 * A resumed re-ask has no broker of its own to hand out and no fence to name, so
 * its plan is empty — which is the shape `applyChildPermissionEnv` answers by
 * DELETING both halves of any inherited forge-read pair rather than trusting it.
 * Everything else the dispatched child gets is here: the forge strip, the role
 * stamp (`PI_ENSEMBLE_ROLE`), the non-interactive git pins, the per-child temp
 * root and, for a read-only role, the scratch `HOME`/XDG under it. Those are the
 * rules the sibling re-ask sites quietly lacked, and the role stamp is the one
 * that matters: every role-scoped child-side rule reads the role out of the
 * child's own env, so a re-ask built on `forgeReadChildEnv` alone ran the same
 * role with every one of those guards inert.
 *
 * `childTmp` is the caller's own per-child dir — this names a tree it does not
 * allocate, so the caller creates it and its `finally` removes it. Nothing writes
 * the env after this returns: the caller hands the result straight to `spawn()`.
 */
export function buildResumedChildEnv(role: string, childTmp: string): Record<string, string> {
  const noPlan = {
    subagentGuardEnabled: false,
    trustChild: false,
    forge: { keepsLogin: false },
    ready: Promise.resolve(),
    stopForgeBroker: (): void => {},
  } satisfies ChildPermissionPlan;
  return buildChildEnv(role, noPlan, undefined, childTmp);
}
