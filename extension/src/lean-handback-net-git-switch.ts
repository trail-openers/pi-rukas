/**
 * lean-handback-net-git-switch — the ONE reader of the switch that decides whether the
 * verified handback's origin reads go through the driver's network-git wrapper.
 *
 * `lean/handback-rewind.ts` asks origin four times on a rewind that pushes — the branch
 * before the push, the branch and its keeping-ref after it, and `originBranchHead` for
 * the handback's own record — and each ask is a `git ls-remote` over the transport the
 * push itself uses. The reads shipped without the two things every other network git
 * call carries: `killGroup`, so a timeout killed only the direct child and an ssh
 * grandchild holding stdout outlived the ceiling; and `netGitEnv()`, so a passphrase or
 * an agent unlock was read from /dev/tty instead of failing. The routed deadline report
 * bounds the STEP at the handoff allowance, so a hung read is cut there — and the child
 * it was waiting on is not, which is the difference between losing a step and losing the
 * trial: a lean run against a local origin inside a deadline budget has no time to
 * recover from an orphan that keeps the pipe open.
 *
 * `PI_ENSEMBLE_LEAN_HANDBACK_NET_GIT=0` puts all four calls back on the executor in the
 * shape they had before the fix — same argv, no env, no `killGroup`, the same ceiling
 * and buffer — for the operator whose origin needs an interactive credential helper or
 * whose `core.sshCommand` the wrapper would outrank. Only the literal `"0"` turns the
 * routing off; unset and any other value leave it on. The push is not the switch's: the
 * lease switch owns that argv.
 *
 * The env var is read at CALL time, not at module load: every lean smoke file runs in
 * one bun process and pins off/on arms with `withEnv`, so a load-time read would let one
 * file's pin silently disarm the routing in the next.
 */

/** Whether the handback's origin reads run through `runNetGit`. */
export function leanHandbackNetGitEnabled(): boolean {
  return process.env.PI_ENSEMBLE_LEAN_HANDBACK_NET_GIT !== "0";
}
