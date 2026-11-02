/**
 * lens-baseline-witness — the witness for `runShipped`'s baseline loop.
 *
 * Split out of `lens-mutant-harness.ts` along the same seam `lens-mutant-corpus.ts`
 * records: the harness is the machinery that measures, this file is the assertion
 * that the machinery's own baseline was measured. It imports the harness and never
 * the reverse, so the two cannot form a cycle and `runShipped` cannot reach this
 * file by defaulting an argument.
 *
 * WHY `runShipped` NEEDED A WITNESS AT ALL. Until this file existed, nothing could
 * tell a baseline that had measured every fixture from one that had measured none:
 * a reviewer hollowed the three-line loop in `runShipped` out to `void accounted;
 * void corpus;` and all three lens suites reported `exit=0` — every `0` on the
 * per-member table intact, the one assertion that says "the corpus and the shipped
 * matcher agree" measuring nothing, and `measuredTable`'s `refusing to measure
 * ${flank}` precondition unreachable. The existing `baseline.length === 0`
 * assertion passes on an empty `reds` array of ANY provenance, which is the same
 * shape as an unread gate that returns `""` and calls it empty (#384).
 *
 * THE DESIGN RULE, learned the hard way. A witness is worthless if it measures
 * ALONGSIDE `runShipped`: the first revision of this function re-derived the
 * verdicts by calling `accountedFiles` itself, and the hollowed mutant stayed
 * green — this file was reading the product correctly while the function under
 * test read nothing, which is exactly the situation a green suite must not report.
 * So every measurement below goes THROUGH `runShipped`, and the discriminating
 * power comes from fixtures chosen so that "the loop ran" and "the loop computed
 * nothing" give DIFFERENT answers. That is what makes the two mutants the brief
 * demands observable rather than merely asserted against:
 *
 *   A  hollowing (`void accounted; void corpus;`)  -> arm (2) reddens
 *   B  constant return (`reds` emptied after the loop) -> arm (3) reddens
 *
 * The corpus's own fixtures cannot do either job: a correct baseline is red-free
 * by definition and a hollow one is red-free too, so only an assertion that
 * DEMANDS a named red, alongside one that demands a named non-red, separates them.
 *
 * `check` is injected so the caller's pass/fail counter and message format stay
 * with the suite — the same shape as `assertLivenessMutantReds`.
 */

import { selectedFiles } from "../../src/lens-review-coverage.ts";
import { runMutant, runShipped, SHIPPED } from "./lens-mutant-harness.ts";
import { CORPUS, type Fixture } from "./lens-mutant-corpus.ts";

/** The four arms, each one a `check` that a `runShipped` which measures nothing
 * cannot pass. `corpus` is a parameter only so a caller can point the witness at
 * a narrower set; the suites call it with no argument. */
export async function assertBaselineLoopWitnessed(
  check: (cond: boolean, msg: string) => void,
  corpus: readonly Fixture[] = CORPUS,
): Promise<void> {
  // The discriminating fixtures. `summary`/`file`/`expected`/`denominator` are
  // COPIED VERBATIM from two corpus rows that already state which way each one
  // goes — the positive from the "NAMES a file as a path token" pair (expected
  // `"summary"`), the negative from the "NO evidence mentions" canary (expected
  // `undefined`). Nothing is invented, so neither canary is a hand-typed string
  // chosen to agree with whatever the code happens to do; and because the two
  // members of the pair answer opposite ways, a loop that stops measuring shows up.
  const positiveRow = corpus.find((fx) => fx.expected === "summary" && fx.name.includes("NAMES a file as a path token"));
  const negativeRow = corpus.find((fx) => fx.expected === undefined && fx.name.includes("NO evidence mentions"));
  const positiveCited: Fixture = {
    name: "baseline witness: the corpus's citing row must account",
    summary: positiveRow?.summary ?? "src/b.ts is fine as written.",
    file: positiveRow?.file ?? "src/b.ts",
    expected: positiveRow?.expected ?? "summary",
    denominator: positiveRow?.denominator ?? ["src/b.ts"],
  };
  const positiveUncited: Fixture = {
    name: "baseline witness: the corpus's un-cited row must NOT account",
    summary: negativeRow?.summary ?? "src/b.ts is fine as written.",
    file: negativeRow?.file ?? "src/c.ts",
    expected: "summary",
    denominator: negativeRow?.denominator ?? ["src/a.ts", "src/b.ts", "src/c.ts"],
  };
  const negative: Fixture = {
    // Same row, asked of `runShipped` on its own: the correct answer is exactly
    // one red, so a loop that ran and then returned a constant fails here while
    // every other assertion in the suite (which demands an empty reds) stays green.
    name: "baseline witness: the corpus's un-cited row, run alone, must be a red",
    summary: negativeRow?.summary ?? "src/b.ts is fine as written.",
    file: negativeRow?.file ?? "src/c.ts",
    expected: "summary",
    denominator: negativeRow?.denominator ?? ["src/a.ts", "src/b.ts", "src/c.ts"],
  };

  // (1) INDEPENDENT AGREEMENT, computed by product code rather than by this file.
  // `selectedFiles` parses `+++` headers out of a diff assembled from the
  // denominator fields the corpus's own fixtures declare; every file it finds must
  // be one some fixture asserts `"summary"`. `runShipped` is silent about this —
  // its contract is only "no reds" — so the agreement its greenness implies is
  // asserted rather than assumed.
  const denominator = selectedFiles(
    [...new Set(corpus.flatMap((fx) => fx.denominator))]
      .sort()
      .flatMap((f) => {
        const clean = f.replace(/^\.\//, "").replace(/\/+$/, "");
        return [`diff --git a/${clean} b/${clean}`, `--- a/${clean}`, `+++ b/${clean}`, "@@ -1 +1 @@", "-x", "+y"];
      })
      .join("\n"),
  );
  const assertedSummary = new Set(corpus.filter((fx) => fx.expected === "summary").map((fx) => fx.file));
  const missing = [...denominator].filter((f) => !assertedSummary.has(f));
  check(
    denominator.size > 0 && missing.length === 0 && corpus.length > 40,
    `canary: the corpus agrees with the shipped denominator — \`selectedFiles\` parses ${denominator.size} file(s) from a diff built out of the fixtures' own \`denominator\` fields and every one of them is asserted \`"summary"\` by some fixture (missing ${JSON.stringify(missing)}, corpus ${corpus.length})`,
  );

  // (2) THE HOLLOWING ARM — measured through `runShipped` on a pair whose two
  // members answer opposite ways. `reds.length` and the name are both asserted, so
  // an implementation that pushed the wrong fixture still reddens.
  const pair = await runShipped([positiveCited, positiveUncited]);
  check(
    pair.length === 1 && pair[0] === positiveUncited.name,
    `canary: the baseline loop MEASURES — through \`runShipped\` alone, the corpus's citing row accounts and its un-cited row reddens (${JSON.stringify(pair)}; expected exactly [${JSON.stringify(positiveUncited.name)}]). This is the arm that reddens \`void accounted; void corpus;\`: a loop that runs and computes nothing reports no red for either fixture, and no assertion elsewhere in the suite can see that, because a correct baseline is red-free and a hollow one is red-free too`,
  );

  // (3) THE CONSTANT ARM — the same function asked for the one answer a constant
  // `reds` cannot give: a fixture that must fail.
  const neg = await runShipped([negative]);
  check(
    neg.length === 1 && neg[0] === negative.name,
    `canary: the baseline loop PROPAGATES a red — the corpus's un-cited row, run on its own, must come back as exactly one named red (${JSON.stringify(neg)}; expected [${JSON.stringify(negative.name)}]). Without this arm a \`runShipped\` that ran its loop and then returned a constant — \`return [];\` after the loop, or \`reds.length = 0;\` — reads green, since every other assertion in the suite demands an EMPTY reds array`,
  );

  // (4) THE DELEGATION GUARD — the canaries above must be decided by
  // `accountedFiles`, not by a `mentionsPath` copy, or (2) would witness the wrong
  // function. A no-op substitution of the shipped class reddens ONLY the lone-CR
  // pair, because `mentionsPathWith` takes `NOT_LINE_BREAK` as an argument and a
  // member-level mutant leaves it at the shipped value. This is also the arm that
  // refuses a `runShipped` quietly reimplemented on top of `runMutant`.
  const notWitnessRow = (name: string) =>
    !/lone CR|NOT_LINE_BREAK/.test(name) && !name.startsWith("baseline witness:");
  const delegated = (["PATH_CHAR", "NOT_PATH", "TERMINATOR"] as const).flatMap((flank) =>
    runMutant(flank, SHIPPED[flank], [positiveCited, positiveUncited, negative]).filter(notWitnessRow),
  );
  const corpusProbe = runMutant("PATH_CHAR", SHIPPED.PATH_CHAR)
    .filter(notWitnessRow)
    .filter((n) => n !== positiveUncited.name && n !== negative.name);
  check(
    delegated.length === 0 && corpusProbe.length === 0 && corpus.length > 40,
    `canary: the baseline witness measures \`accountedFiles\` and not a \`mentionsPath\` copy — a no-op substitution of the shipped class reddens no corpus fixture outside the lone-CR pair and the witness's own rows (offenders: ${JSON.stringify(delegated.concat(corpusProbe))}), so the two canaries above are decided by the shipped accounting function the table's baseline row claims to measure (corpus ${corpus.length} fixtures)`,
  );
}
