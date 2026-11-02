/**
 * lens-harness-fidelity-ratchet — the ratchet that proves the lens mutation
 * harness's OWN checks can fail.
 *
 * WHY THIS FILE EXISTS. Eight six-lens rounds on this branch each found a NEW
 * instance of one class: a verification step in the mutation harness runs, and
 * nothing shows it is able to fail. The instances differed (a precondition gated
 * on `false`; a fidelity call that could be deleted; a table that never calls the
 * generator; a whole-class control that delegates to the shipped matcher; a batch
 * acquire that decides nothing) and fixing them one at a time did not converge,
 * because the class is not "this check is wrong" — it is "this check is unproven".
 * Asserting each check again is the same one-at-a-time move. What closes the class
 * is a check that checks the checkers: for every named entry point, apply a
 * deletion/hollowing mutant to a scratch copy of the harness and REQUIRE a red.
 *
 * WHY A SCRATCH COPY AND NOT THIS TREE. The mutations edit files on disk, so they
 * must not happen where a developer, a gate, or `git add -A` can see them. Each
 * mutant is applied under a `mkdtemp` copy of `extension/` and the tree is removed
 * afterwards; the working tree this test runs in is never written. See
 * `runMutantSuite` for the copy's shape and why a copy that omits the sibling
 * `skill/` dir or the real `.git` silently invalidates every measurement.
 *
 * WHY A RED IS NOT ENOUGH — THE DOUBLE-RED CONTRACT. A mutant that reddens for a
 * reason unrelated to the check it targets proves nothing, and the cheapest way to
 * write a ratchet that always "passes" is to mutate something that breaks the
 * import graph: every mutant would then exit non-zero and every check would read
 * as proven. So every entry point is asserted in TWO directions:
 *
 *   MUTATE  -> the named suite reddens (the check can fail)
 *   UNMUTATED -> the same suite, in the same kind of scratch copy, is green
 *                (the red came from the mutation, not from the rig)
 *
 * and each mutant additionally names the specific assertion text its red must
 * contain, so a mutant that reddens an unrelated assertion does not count.
 *
 * THE RATCHET'S OWN WITNESS (`test-lens-harness-fidelity-ratchet.ts`). A ratchet
 * whose mutant list is empty reports "0 entry points proven" and exits 0, which is
 * the green-on-nothing defect it exists to close, wearing the ratchet's own shape.
 * `HARNESS_MUTANTS` is exported so that file can prove the list is non-empty AND
 * prove the runner reddens when given a mutant that cannot fail.
 */

import { chmodSync, cpSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import { HARNESS_MUTANTS } from "./lens-fidelity-ratchet-mutants.ts";
import type { HarnessMutant } from "./lens-fidelity-ratchet-types.ts";
import {
  EXTENSION_ROOT,
  assertNoSymlinkInScratchTree,
  gitEnv,
  makeScratch,
  runSuite,
} from "./lens-fidelity-rig.ts";

export { EXTENSION_ROOT, assertNoSymlinkInScratchTree };
export { HARNESS_MUTANTS } from "./lens-fidelity-ratchet-mutants.ts";

/** The two things a run reports per mutant: did the unmutated rig read green, and
 * did the mutated one redden where it must. */
export interface RatchetResult {
  readonly id: string;
  readonly baselineGreen: boolean;
  readonly reddened: boolean;
  readonly matchedRed: string | null;
  /** True when the entry declared its mutation unobservable and that claim held. */
  readonly unobservable: boolean;
  readonly unobservableReason?: string;
  readonly detail: string;
}


/**
 * One mutant, measured: copy, mutate, run, classify, discard.
 *
 * The unmutated run happens in the SAME kind of scratch tree so the pair is
 * comparable — a red that the rig itself produces (missing `skill/`, no `.git`)
 * would otherwise be indistinguishable from a red the mutation produced.
 */
export function measureMutant(m: HarnessMutant): RatchetResult {
  const { root, extensionDir } = makeScratch();
  const { gitDir, env } = gitEnv(extensionDir);
  try {
    // The mutated file is a REAL file inside the scratch tree (every leaf there is
    // either a per-file symlink or a copy, and nothing under a linked directory is
    // ever written — see `buildScratch`). It is copied fresh from the source here so
    // a prior mutant's bytes can never leak into this measurement, then rewritten.
    const target = path.join(extensionDir, m.file);
    const source = path.join(EXTENSION_ROOT, m.file);
    const original = readFileSync(source, "utf8");
    // THE LEAK THIS LINE CLOSES, and why it is a line rather than a comment.
    // `buildScratch` links every leaf with `symlink(…, "file")`, and `writeFileSync`
    // FOLLOWS a leaf symlink and writes the target. An earlier revision checked
    // `isSymbolicLink()` only in the refusal branch, so the check that ran first was
    // the earlier `rmSync`/`cpSync`, and a mutant of `lens-class-mutants.ts` wrote
    // `if (false && mutated === literal)` into the DEVELOPER'S file. A mutation rig
    // that mutates the tree it measures is the defect class this branch exists to
    // close, wearing the rig's own shape — twice now. So the guard is the FIRST
    // operation on the target, it is unconditional, and it is enforced on every
    // scratch leaf rather than only on the one about to be written.
    // The guarded set is the file this mutant writes. The check runs BEFORE any
    // write and before the copy that stages it, so a leaf symlink left in place by a
    // future change to `buildScratch` fails here instead of landing in the worktree.
    assertNoSymlinkInScratchTree(extensionDir, [m.file]);
    rmSync(target, { force: true });
    cpSync(source, target);
    if (readFileSync(target, "utf8") !== original)
      throw new Error(
        `the scratch copy of ${m.file} is not the source file — the rig measured a different tree than the one it mutated`,
      );
    const baseline = runSuite(extensionDir, m.suite, env);

    // The mutation must actually apply. A `from` that is not in the file means the
    // mutant is a no-op and its "red" would be the baseline's — refused loudly.
    if (!original.includes(m.from)) {
      return {
        id: m.id,
        baselineGreen: !baseline.failed,
        reddened: false,
        matchedRed: null,
        unobservable: false,
        detail: `MUTATION DID NOT APPLY: ${m.file} does not contain the expected text — the mutant is a no-op and its green is meaningless`,
      };
    }
    const mutated = original.replace(m.from, m.to);
    writeFileSync(target, mutated);
    chmodSync(target, 0o644);
    // Read it back. `writeFileSync` can be defeated by a mount, an editor, or (the
    // failure this rig has already shipped twice) a link that resolves elsewhere; a
    // mutation that did not land produces the baseline's output and would be
    // reported as "this check cannot fail" — the wrong verdict in the loud direction.
    if (readFileSync(target, "utf8") !== mutated)
      throw new Error(
        `the mutation of ${m.file} did not land on disk — refusing to report a verdict about a check that was never mutated`,
      );
    const after = runSuite(extensionDir, m.suite, env);
    // An entry may declare its mutation unobservable (dead code, or a check that is
    // self-confirming at its call site). That is a claim the ratchet CHECKS rather
    // than trusts: the entry must still apply, still land on disk, and still leave the
    // suite green — the difference from a proven mutant being that no red is owed. If
    // such a mutant suddenly DOES redden something, that is reported as a contradiction
    // and fails, because the entry's stated reason has just been falsified.
    const claimsUnobservable = m.observable === false;
    if (claimsUnobservable && !m.unobservableReason)
      throw new Error(
        `mutant ${m.id} declares itself unobservable without saying why — an unobservable mutant with no reason is an unchecked exemption`,
      );
    if (claimsUnobservable && after.failed)
      throw new Error(
        `mutant ${m.id} claims to be unobservable (${m.unobservableReason}) yet its mutation reddened ${after.reds.length} assertion(s): ${after.reds[0]?.slice(0, 160)} — the claim is falsified, give the mutant a real redMustContain`,
      );
    // An observable mutant must name the red it expects; the type allows the field to
    // be absent only alongside `observable: false`, and that pairing is enforced here
    // rather than left to the compiler's structural slack — a mutant with no
    // `redMustContain` and no unobservability claim would match nothing and read as
    // "proven".
    if (!claimsUnobservable && !m.redMustContain)
      throw new Error(
        `mutant ${m.id} has no redMustContain and does not claim to be unobservable — a mutant that names no red cannot be attributed, which is the green-on-nothing defect this ratchet exists to close`,
      );
    const expected = m.redMustContain;
    const matched = expected === undefined ? null : (after.reds.find((r) => r.includes(expected)) ?? null);
    return {
      id: m.id,
      baselineGreen: !baseline.failed,
      reddened: after.failed,
      matchedRed: matched,
      unobservable: claimsUnobservable,
      unobservableReason: m.unobservableReason,
      detail: `baseline pass=${baseline.passes} red=${baseline.reds.length}; mutated pass=${after.passes} red=${after.reds.length}${after.stderr ? ` stderr=${after.stderr}` : ""}`,
    };
  } finally {
    rmSync(root, { recursive: true, force: true });
    rmSync(gitDir, { recursive: true, force: true });
  }
}

/** The ratchet's own refusal when asked to prove nothing. */
export class NothingToProve extends Error {}

/**
 * Run every mutant and refuse, rather than pass, when the list is empty or when a
 * mutant cannot be trusted. Returns the per-mutant results for the caller to print.
 */
export function runRatchet(mutants: readonly HarnessMutant[] = HARNESS_MUTANTS): RatchetResult[] {
  if (mutants.length === 0)
    throw new NothingToProve(
      "the harness-fidelity ratchet was given no mutants — an empty list proves every entry point and reddens nothing, which is the defect class this file exists to close",
    );
  const ids = new Set(mutants.map((m) => m.id));
  if (ids.size !== mutants.length)
    throw new NothingToProve("two ratchet mutants share an id — one of them is not being measured");
  return mutants.map(measureMutant);
}

/**
 * Two mutants that reddened exactly the same lines means one of them reddened for
 * the other's reason, and the pair proves one thing, not two. Returns the pairs
 * whose red sets are identical.
 */
export function indistinguishablePairs(
  results: readonly { id: string; matchedRed: string | null; reddened: boolean }[],
): [string, string][] {
  const done = results.filter((r) => r.reddened);
  const pairs: [string, string][] = [];
  for (let i = 0; i < done.length; i++) {
    for (let j = i + 1; j < done.length; j++) {
      const a = done[i]!;
      const b = done[j]!;
      if (a.matchedRed !== null && a.matchedRed === b.matchedRed) pairs.push([a.id, b.id]);
    }
  }
  return pairs;
}
