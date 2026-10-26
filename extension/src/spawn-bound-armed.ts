/**
 * spawn-bound-armed — the one-way flag saying a KILLING bound has decided to
 * end this child (#1827).
 *
 * Four supervision seams watch a running child — the slow-run notice, the turn
 * nudge, the child-bound wrap-up steer, and the caps session's own steer — and
 * each of them asks the same question before it spends a steer: is this child
 * already being ended? A child that is 200 ms from a SIGTERM does not benefit
 * from a "please wrap up" message, and the operator reading the lifecycle log
 * should not see an advisory steer queued behind a kill that was already armed.
 *
 * So the flag is write-once and read by closure everywhere, which is the same
 * shape every other per-child kill flag in this stack uses (`declareKillFlags`).
 * It lives here rather than beside any one of the four because none of them owns
 * it: the writer is whichever bound fires first (a cap, a child bound, or one of
 * the #1827 reviewer bounds), and the readers must not have to agree on which
 * module to import a getter from.
 *
 * `arm()` is idempotent and notifies the caller through `onArm` exactly once —
 * the caller's watch lives outside `spawnSpecialist` (the lens child and the
 * adversarial phase each own their own slow watch) and needs the same stand-down
 * signal. A failing notification never delays a kill, so the callback is
 * swallowed: the watch is advisory and a broken seam must not cost the child's
 * process group its SIGTERM.
 */

export interface BoundArmed {
  /** Read: has a killing bound armed for this child? */
  armed: () => boolean;
  /** Write-once: mark the child as being ended, notifying the caller once. */
  arm: () => void;
}

export function createBoundArmed(onArm?: () => void): BoundArmed {
  let armed = false;
  return {
    armed: () => armed,
    arm: () => {
      if (armed) return;
      armed = true;
      if (!onArm) return;
      try {
        onArm();
      } catch {
        /* the watch is advisory; a failing seam never delays the kill */
      }
    },
  };
}
