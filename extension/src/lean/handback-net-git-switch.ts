/**
 * lean/handback-net-git-switch — the ONE reader of the switch that decides whether the verified
 * handback's origin reads go through the driver's network-git wrapper.
 *
 * `lean/handback-rewind.ts` asks origin four times on a rewind that pushes, and each ask is a
 * `git ls-remote` over the transport the push itself uses, so they carry what every other network git
 * call carries: `killGroup`, so a timeout kills an ssh grandchild holding stdout too; and
 * `netGitEnv()`, so a passphrase prompt fails instead of reading /dev/tty.
 *
 * `PI_ENSEMBLE_LEAN_HANDBACK_NET_GIT=0` puts all four calls back on the plain executor — same argv,
 * no env, no `killGroup` — for the operator whose origin needs an interactive credential helper. Only the
 * literal `"0"` turns the routing off, read at CALL time. The push is not the switch's: the lease switch
 * owns that argv.
 */

/** Whether the handback's origin reads run through `runNetGit`. */
export function leanHandbackNetGitEnabled(): boolean {
  return process.env.PI_ENSEMBLE_LEAN_HANDBACK_NET_GIT !== "0";
}
