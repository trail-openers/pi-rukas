/**
 * lean/seed — what a brand-new run starts knowing: its version and its base.
 *
 * Split out of `lean/command.ts` at the 500-line file-size cap. It is its own
 * seam: the seed is a RUN-START fact, read once before the record exists, while
 * `command.ts` is the per-step handler table. The two share nothing but
 * `leanVersion`, which lives in `lean/version.ts`.
 *
 * The base has to be on the record from the first write: `specify`, `build`,
 * `challenge` and `verify` all read `ctx.run.baseSha`, and a fresh run that
 * carries `""` is refused by `specify` before a model is billed.
 *
 * It is probed ONCE here and pinned, because the base is a run-start fact: a
 * resume keeps the recorded sha rather than re-resolving a mainline that may
 * have moved.
 */

import { proveBaseSha } from "./base-proof.ts";
import { mainlineSha } from "./io.ts";
import { oneLine } from "./text-fence.ts";
import { leanVersion } from "./version.ts";

/** What the run is seeded with: the version stamp and the pinned base. */
export interface LeanSeed {
  version: string;
  baseSha: string;
  /** Why the probe failed — carried to `ready`'s rule so the comment says what git did. */
  why?: string;
  /**
   * The `why` describes a git INFRASTRUCTURE fault, not a mainline that is
   * simply absent — see `leanSeed`.
   *
   * It is what lets `ready` refuse to post: "this clone has no origin/HEAD" is a
   * fact about the repository the issue lives in and the operator can act on it,
   * while "git was killed" says nothing about the issue and posting it tells the
   * author their ready work was refused for a reason nobody can see. So when this
   * flag is set and the base is empty, `ready` THROWS and the engine hands the run
   * back at exit 10 with no comment.
   */
  infra?: boolean;
}

/**
 * The seed itself: the version stamp and the proven mainline sha.
 *
 * Never throws: a repo whose mainline cannot be resolved seeds `""`, and `ready` refuses the run with the
 * reason (`why`) it deserves — the seed runs before the run exists, so a seed that threw would take the command
 * down instead of letting the issue be answered. The value is proven with the same `proveBaseSha` `ready`
 * applies, so the record never carries a value that is shaped like an oid but is not the commit.
 *
 * The catch marks its seed `infra` and it is the only arm that can: every other arm ANSWERS, and only a
 * rejection means the clone could not be read.
 */
export async function leanSeed(repoRoot: string): Promise<LeanSeed> {
  const version = leanVersion();
  try {
    const probed = await mainlineSha(repoRoot);
    // A sha that is not a full oid, or one the clone holds no commit for, is refused
    // HERE rather than passed on: the seed is what gets written to the record, so an
    // abbreviated or mixed-case value would become the run's base and every later read
    // would be anchored to a string no equality check can settle.
    if (probed.sha !== undefined) {
      const proof = await proveBaseSha(repoRoot, probed.sha);
      if (proof.ok) return { version, baseSha: probed.sha };
      return {
        version,
        baseSha: "",
        why: `origin mainline ${oneLine(probed.sha, 80)}: ${oneLine(proof.rule, 120)}`,
      };
    }
    return {
      version,
      baseSha: "",
      why:
        probed.why ??
        `mainline resolved to ${JSON.stringify(probed.sha ?? "")}, not a full commit sha`,
    };
  } catch (err) {
    // A rejection reaching here means the proof refused to ANSWER — it returns a rule
    // for every refusal it can make, so the catch is reserved for a git that could not
    // be asked at all. It does NOT probe to find out: the only git read left is an
    // ambient one, and a second read that fails for that reason alone would report a
    // fault on a repository git is reading perfectly. `proveBaseSha` already put git's
    // own first line in the message it threw, so what arrives here is evidence.
    return {
      version,
      baseSha: "",
      infra: true,
      why: oneLine(err instanceof Error ? err.message : String(err), 160),
    };
  }
}
