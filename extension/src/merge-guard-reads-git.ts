/**
 * merge-guard-reads-git — the git reads the merge guard (merge-guard.ts) issues
 * before it consults the ledger, split out for the file cap (AGENTS.md §12):
 * everything that talks to git comes here, everything that judges the ledger
 * stays in the hook.
 *
 * Two invariants hold the reads together: **one `<remote>/<mainline>` pair for
 * all of them** (the caller resolves the mainline once and hands the same string
 * to each — two readers that resolved it separately is how a moved main changes
 * one verdict and not the other), and **fail closed** (a fetch, rev-parse or
 * protected diff that cannot be read returns a refusal, never a pass).
 *
 * Every refusal here names `PI_ENSEMBLE_ALLOW_UNREVIEWED_MERGE=1`, because at this
 * point the command HAS parsed as a merge and an operator who reviewed by other
 * means genuinely decides. The protected-path refusal (merge-guard-protected.ts)
 * is the exception: no hatch, because the remedy there is that the operator
 * merges the PR.
 *
 * A `Read<T>` is `{ ok: true }` narrowed to the value, or `{ ok: false }` with the
 * hook's `{ block: true, reason }` payload ready to return.
 */

import { resolveMainline } from "./mainline.ts";
import { analyseRefusal } from "./merge-refusal-render.ts";
import type { MergeExecFn, MergeTarget } from "./merge-target.ts";
import { netRefProblem, runNetGit } from "./work-driver-net-git.ts";

/** What a refused read hands back to the hook: `{ block: true, reason }`. */
export type GuardReadRefusal = { block: true; reason: string };

/** A git read that either answered with a `T`, or refused with the hook's payload. */
type Read<T> = { ok: true; value: T } | { ok: false; block: GuardReadRefusal };

/** The refusal suffix shared by this module's reads: the operator's hatch. */
const HATCH =
  "the merge guard refuses by default (set PI_ENSEMBLE_ALLOW_UNREVIEWED_MERGE=1 to override)";

/** Name a failed git read as a refusal, in the hook's shape. */
function refuseRead(what: string, err: unknown): { ok: false; block: GuardReadRefusal } {
  return {
    ok: false,
    block: {
      block: true,
      reason: `merge refused: ${what} — ${analyseRefusal(err, 120)} — ${HATCH}`,
    },
  };
}

/**
 * Resolve the mainline branch once, for the whole merge decision: the guard, the
 * protected-path read and the patch identity all diff against it, so one
 * resolution keeps them on the same commit. The refusal says plainly that neither
 * read has a base, rather than naming the protected gate for a failure it never
 * attempted.
 */
export async function guardMainline(cwd: string, execFn: MergeExecFn): Promise<Read<string>> {
  const mainline = await resolveMainline(cwd, execFn);
  if (mainline.ok) return { ok: true, value: mainline.branch };
  return {
    ok: false,
    block: {
      block: true,
      reason: `merge refused: the mainline branch could not be resolved (${mainline.reason}) — neither the protected-path read nor the patch identity has a base to diff against (${HATCH})`,
    },
  };
}

/**
 * Bring the PR head, its base and the mainline into the caller's tree, then check
 * the fetched head against the PR's own `headOid`.
 *
 * On success the caller gets the fetched OID back, and every later read — the
 * protected-path gate, the round-cap head check, the CI head pin — describes THAT
 * commit. The head equality is the guard's answer to "the branch moved after the
 * reviews ran", and the base and mainline are fetched alongside the head because
 * the merge-base is taken against them: a stale local main makes the identity and
 * the protected range describe commits the forge no longer has. Names are
 * validated by `netRefProblem` and passed as argv, never interpolated into shell.
 */
export async function guardFetchAndHead(
  execFn: MergeExecFn,
  cwd: string,
  remote: string,
  target: MergeTarget,
  mainline: string,
  timeoutMs: number,
): Promise<Read<string>> {
  const badRef = netRefProblem(remote, target.headBranch, target.baseBranch, mainline);
  if (badRef !== undefined) {
    return {
      ok: false,
      block: { block: true, reason: `merge refused: git fetch refused: ${badRef} — ${HATCH}` },
    };
  }
  try {
    await runNetGit(execFn, "git", {
      cwd,
      maxBuffer: 64 * 1024,
      timeoutMs,
      argv: ["fetch", remote, target.headBranch, target.baseBranch, mainline],
    });
  } catch (err) {
    return refuseRead("git fetch failed", err);
  }
  const fetched = await guardRevParse(execFn, cwd, `${remote}/${target.headBranch}`, timeoutMs);
  if (!fetched.ok) return fetched;
  const fetchedHead = fetched.value;
  if (fetchedHead !== target.headOid) {
    return {
      ok: false,
      block: {
        block: true,
        reason: `stale branch: fetched head ${fetchedHead.slice(0, 8)} ≠ PR headOid ${target.headOid.slice(0, 8)} — the branch moved after the PR was opened; re-run the reviews`,
      },
    };
  }
  return { ok: true, value: fetchedHead };
}

/**
 * Resolve `<remote>/<mainline>` to the OID every base-relative read describes.
 *
 * The guard fetches the mainline alongside the head, so this is a local read;
 * an answer that is not an object id is a refusal, never a diff over garbage.
 */
export async function guardMainlineOid(
  execFn: MergeExecFn,
  cwd: string,
  remote: string,
  mainline: string,
  timeoutMs: number,
): Promise<Read<string>> {
  return guardRevParse(execFn, cwd, `${remote}/${mainline}`, timeoutMs);
}

/** `git rev-parse <ref>` → the OID, or the named refusal. */
async function guardRevParse(
  execFn: MergeExecFn,
  cwd: string,
  ref: string,
  timeoutMs: number,
): Promise<Read<string>> {
  try {
    const { stdout } = await execFn(`git rev-parse ${ref}`, {
      cwd,
      maxBuffer: 8 * 1024,
      timeout: timeoutMs,
    });
    const oid = stdout.trim();
    if (!/^[0-9a-f]{7,64}$/.test(oid)) {
      throw new Error(`printed ${oid.slice(0, 40)}, not an object id`);
    }
    return { ok: true, value: oid };
  } catch (err) {
    return refuseRead(ref, err);
  }
}
