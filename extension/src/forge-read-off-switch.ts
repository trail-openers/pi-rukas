/**
 * forge-read-off-switch — the ONE reader of the switch that decides whether the
 * parent's `forge_read` broker refuses a read when the forge is off.
 *
 * `PI_ENSEMBLE_FORGE=none` means "there is no forge here" (`forge-off.ts`), and the
 * driver honours it. The broker did not: `runForgeRead` called `detectForge`
 * directly, which reads `none` as "fall through to the remote", so an offline
 * operator's helper child still got the parent's `gh`/`glab` run on its behalf.
 * With the switch on, a proved read under `none` comes back
 * `the forge is off: PI_ENSEMBLE_FORGE=none` and nothing is executed.
 *
 * `PI_ENSEMBLE_FORGE_READ_OFF_GUARD=0` restores the pre-fix broker byte for byte:
 * the read goes on to `detectForge` whatever the environment says. It exists for
 * the operator who set `none` to stop the DRIVER's forge work and still needs a
 * helper child to read a forge through the parent — the two consumers are separate,
 * and the value that means "off" to one should not silently mean "off" to the other
 * without an explicit way back. Only the literal `"0"` turns it off; unset and any
 * other value leave it on.
 *
 * The env var is read at CALL time, not at module load: every forge-read smoke file
 * runs in one bun process and pins off/on arms with `withEnv`, so a load-time read
 * would let one file's pin silently disable the rule in the next.
 */

/**
 * The reason a refused read carries, and the text the child renders. It lives with
 * the switch because the two together are the child-facing contract — the broker
 * answers with it, the child's tool prints it, and the tests assert it. Spelling it
 * in three places is how a contract drifts.
 */
export const FORGE_READ_OFF_REASON = "the forge is off: PI_ENSEMBLE_FORGE=none";

/** Whether the broker refuses a read while the forge is off. */
export function forgeReadOffGuardEnabled(): boolean {
  return process.env.PI_ENSEMBLE_FORGE_READ_OFF_GUARD !== "0";
}
