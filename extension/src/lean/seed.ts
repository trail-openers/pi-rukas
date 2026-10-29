/**
 * lean/seed — what a brand-new run starts knowing: its version and its base.
 *
 * Split out of `lean/command.ts` at AGENTS.md §12's line cap. It is its own
 * seam and not a convenience one: the seed is a RUN-START fact, read once before
 * the record exists, while `command.ts` is the per-step handler table. The two
 * share nothing but `leanVersion`, and a reader who wants to know what the base
 * is allowed to be should not have to scroll past eleven handlers to find it.
 *
 * The base has to be on the record from the first write. `specify`, `build`,
 * `challenge` and `verify` all read `ctx.run.baseSha`, and before this existed
 * nothing ever wrote it — `ready`'s handler deliberately returns only its
 * verdict — so every fresh run carried `""` and `specify` refused with "the run
 * carries no base sha" before a model was billed (field evidence: headless
 * work-lean 1908, exit 10 after two steps).
 *
 * It is probed ONCE here and pinned, because the base is a run-start fact: a
 * resume keeps the recorded sha rather than re-resolving a mainline that may
 * have moved.
 */

import { proveBaseSha } from "./base-proof.ts";
import { leanVersion } from "./command.ts";
import { mainlineSha } from "./io.ts";
import { oneLine } from "./text-fence.ts";

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
   * It is what lets `ready` refuse to post. An empty base has two completely
   * different causes behind it and the not-ready comment can only tell one of
   * them: "this clone has no origin/HEAD" is a fact about the repository the
   * issue lives in, and the operator reading the issue can act on it; "git was
   * killed / git could not read the object store" says nothing about the issue
   * at all, and posting it on the issue tells the author their perfectly ready
   * work was refused for a reason nobody can see from the issue. So when this
   * flag is set and the base is empty, `ready` THROWS and the engine hands the
   * run back at exit 10 with no comment — the same ending an infrastructure
   * fault already gets from a NON-empty base.
   */
  infra?: boolean;
}

/**
 * The seed itself: the version stamp and the proven mainline sha.
 *
 * Never throws: a repo whose mainline cannot be resolved seeds `""`, and `ready`
 * refuses the run with the reason (`why`) it deserves — the seed runs before the
 * run exists, so a seed that threw would take the command down instead of
 * letting the issue be answered. The value is proven with the same
 * `proveBaseSha` `ready` applies — shape, peel and equality — so the record never
 * carries a value that is shaped like an oid but is not the commit the run was
 * seeded with; an unprovable value seeds `""` with its own `why`, the same
 * channel a probe that found nothing uses.
 *
 * The catch marks its seed `infra` and it is the only arm that can: every other
 * arm ANSWERS (a ref that did not resolve, a value the proof returned a rule
 * for), and only a rejection means the clone could not be read. That is the whole
 * distinction the flag carries — see `LeanSeed.infra` for what it costs `ready`.
 */
export async function leanSeed(repoRoot: string): Promise<LeanSeed> {
  const version = leanVersion();
  try {
    const probed = await mainlineSha(repoRoot);
    // A sha that is not a full oid, or one the clone holds no commit for, is
    // refused HERE rather than passed on to be refused by `ready`: the seed is
    // what gets written to the record, so an abbreviated, mixed-case or absent
    // value would become the run's base and every later read would be anchored
    // to a string no equality check can settle. `proveBaseSha` is the same
    // proof `ready` applies, so the seeder cannot write a base `ready` would go
    // on to refuse. The cause says so plainly, and the catch below keeps its
    // own; a git fault lands in that catch, which is the seed's contract — it
    // runs before the run exists, so it must not take the command down.
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
    // A rejection reaching here means the proof refused to ANSWER — it returns a
    // rule for every refusal it can make, so the catch is reserved for a git
    // that could not be asked at all, and the seed says so. It does NOT probe to
    // find out: the only git read this function has left to make is an ambient
    // one — `execp` with no `env`, which the smoke fixtures redirect wholesale
    // for isolation — and a second read that fails for that reason alone would
    // report a fault on a repository git is reading perfectly. `proveBaseSha`
    // already put git's own first line in the message it threw (`a fault is
    // classified, not raw stderr`, test-lean-base-proof (g)), so what arrives
    // here is evidence, not a mystery to go and re-derive.
    return {
      version,
      baseSha: "",
      infra: true,
      why: oneLine(err instanceof Error ? err.message : String(err), 160),
    };
  }
}
