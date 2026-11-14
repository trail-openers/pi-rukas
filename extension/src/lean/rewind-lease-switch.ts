/**
 * lean/rewind-lease-switch — the ONE reader of the switch that decides whether
 * the verified handback's rewind lease is allowed to bind.
 *
 * The rewind moves origin's branch back to the last verified head with one push
 * that carries `--force-with-lease=<ref>:<head this step read off origin>` and
 * two refspecs. A refspec with a leading `+` tells git to force that ref, and a
 * forced ref is one git does NOT check against its lease — so with the `+` the
 * lease was decoration and a branch somebody else had moved was force-updated
 * anyway. A rewind is a non-fast-forward move by definition, and the lease names
 * the value the step just read off origin, so the lease alone authorises exactly
 * that one move and nothing else: the `+` was never what made the rewind work.
 *
 * `PI_ENSEMBLE_LEAN_REWIND_LEASE_BINDS=0` restores the pre-fix argv byte for
 * byte — the leading `+` and nothing else is what the switch reaches, so no new
 * git option enters either arm. Only the literal `"0"` turns it off; unset and
 * any other value leave it on.
 *
 * The env var is read at CALL time, not at module load: every lean smoke file
 * runs in one bun process and pins off/on arms with `withEnv`, so a load-time
 * read would let one file's pin silently disable the rule in the next.
 */

/** Whether the rewind's branch refspec is left unforced so its lease binds. */
export function leanRewindLeaseBinds(): boolean {
  return process.env.PI_ENSEMBLE_LEAN_REWIND_LEASE_BINDS !== "0";
}
