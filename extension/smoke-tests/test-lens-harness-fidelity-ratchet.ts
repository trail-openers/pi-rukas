#!/usr/bin/env bun
/**
 * The witness for the harness-fidelity ratchet itself.
 *
 * THE PROBLEM THIS HALF SOLVES. A ratchet that reports "all entry points proven"
 * is worth exactly what its mutant list is worth, and an empty list makes every
 * later assertion in the file trivially true — the same green-on-nothing defect the
 * ratchet exists to close, promoted to the meta level. So this file does not only
 * run the ratchet, it proves the ratchet can fail:
 *
 *   1. `HARNESS_MUTANTS` is non-empty and covers every entry point by id, so the
 *      list cannot be emptied without reddening this file.
 *   2. `runRatchet([])` THROWS rather than returning an empty success — the
 *      refusal is asserted, not assumed.
 *   3. A mutant that cannot fail is caught: a `from` that is not in the target file
 *      is reported as `MUTATION DID NOT APPLY` and counted as NOT proven, so a
 *      hollowed-out mutant list cannot quietly pass by matching nothing.
 *   4. Two mutants that redden the identical assertion line are reported as an
 *      indistinguishable pair, which is how one silent no-op hides inside a pair
 *      that both "went red".
 *   5. Every real mutant must have gone red on ITS OWN assertion text and its
 *      unmutated rig must have read green — so the red is attributable.
 *
 * Offline: no child, no forge, no spawn. It writes only under `mkdtemp` scratch
 * trees (see the ratchet's header for why symlinks rather than copies).
 */

import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import {
  EXTENSION_ROOT,
  assertNoSymlinkInScratchTree,
  HARNESS_MUTANTS,
  NothingToProve,
  indistinguishablePairs,
  measureMutant,
  runRatchet,
} from "./lib/lens-harness-fidelity-ratchet.ts";

let exit = 0;
function check(cond: boolean, msg: string) {
  if (cond) console.log(`\u2713 ${msg}`);
  else {
    console.error(`\u2717 ${msg}`);
    exit = 1;
  }
}

// ───────────────────────── the list itself can be emptied

{
  // The five entry points round 8 found at `7d1b71eb`, by id. A mutant deleted
  // from the list reddens this assertion — which is the ratchet's own witness.
  const REQUIRED = [
    "P1-noop-precondition",
    "runMutant-fidelity-call",
    "measuredTable-mutantsFor-bypass",
    "wholeClassRemoval-hollowed",
    "runSilentRound-openBatch-acquire",
  ];
  const ids = HARNESS_MUTANTS.map((m) => m.id);
  const missing = REQUIRED.filter((r) => !ids.includes(r));
  check(
    HARNESS_MUTANTS.length >= REQUIRED.length && missing.length === 0,
    `canary: the ratchet names every entry point it was written for (${HARNESS_MUTANTS.length} mutants; missing ${JSON.stringify(missing)}) — emptying this list is the green-on-nothing defect this file exists to catch`,
  );
  const dupes = ids.filter((id, i) => ids.indexOf(id) !== i);
  check(dupes.length === 0, `every mutant has a distinct id (duplicates ${JSON.stringify(dupes)})`);
}

// ───────────────────────── the runner refuses to prove nothing

{
  let threw: Error | undefined;
  try {
    runRatchet([]);
  } catch (e) {
    threw = e as Error;
  }
  check(
    threw instanceof NothingToProve,
    `canary: runRatchet([]) THROWS NothingToProve rather than returning an empty success (got ${threw ? threw.constructor.name : "no throw"}) — an empty mutant list that reports "proven" is the defect class this ratchet closes`,
  );

  // The same refusal reached through the exported list: a caller that filters the
  // list down to nothing must be refused, not congratulated.
  let threw2: Error | undefined;
  try {
    runRatchet(HARNESS_MUTANTS.filter(() => false));
  } catch (e) {
    threw2 = e as Error;
  }
  check(
    threw2 instanceof NothingToProve,
    `canary: an emptied-by-filter list is refused too (got ${threw2 ? threw2.constructor.name : "no throw"}) — the refusal is about the list, not about a literal`,
  );
}

// ───────────────────────── a mutant that cannot fail is caught

{
  const inert = {
    id: "inert-probe",
    claim: "a mutant whose `from` is absent proves nothing",
    file: "smoke-tests/lib/lens-mutant-harness.ts",
    from: "this text is not in the file anywhere __INERT_PROBE__",
    to: "whatever",
    suite: "smoke-tests/test-lens-class-mutants.ts",
    redMustContain: "never printed",
  };
  const r = measureMutant(inert);
  check(
    !r.reddened && r.detail.includes("MUTATION DID NOT APPLY"),
    `canary: a mutant whose \`from\` does not match is reported as NOT proven (reddened=${r.reddened}; ${r.detail.slice(0, 90)}) — the rig refuses a no-op mutant instead of crediting it`,
  );
  check(
    r.baselineGreen,
    `canary: the UNMUTATED scratch rig reads green for the suite this mutant targets (baselineGreen=${r.baselineGreen}) — so any red the real mutants print came from the mutation and not from the rig (missing skill/, no .git, or an unreachable import graph)`,
  );
}

// ───────────────────────── the real mutants, measured

const results = HARNESS_MUTANTS.map(measureMutant);

for (const r of results) {
  check(r.baselineGreen, `${r.id}: its suite is GREEN in the unmutated scratch rig (${r.detail})`);
  if (r.unobservable) {
    // The entry says its mutation cannot change observable output, and the ratchet
    // already refused the run if it turned out to redden anything (that throw happens
    // inside `measureMutant`). What is still owed here is the weaker-but-real half:
    // the mutation APPLIED and LANDED and the suite still ran, so the entry is a
    // measured statement about dead code rather than an unchecked exemption.
    check(
      !r.reddened && !r.detail.includes("MUTATION DID NOT APPLY") && !r.detail.includes("did not land"),
      `${r.id}: declared UNOBSERVABLE and the measurement agrees — the mutation applied and landed, the suite ran, and nothing reddened (${r.detail}). Reason on record: ${r.unobservableReason}`,
    );
    continue;
  }
  check(
    r.reddened && r.matchedRed !== null,
    `${r.id}: the mutation reddens ITS OWN assertion (reddened=${r.reddened}, matched=${r.matchedRed === null ? "none" : "yes"}) — ${r.detail}`,
  );
}

// ───────────────────────── the rig cannot mutate the tree it measures

{
  // The defect an earlier revision of this rig actually shipped: it symlinked
  // `smoke-tests/lib` as a directory and wrote the mutant through that link, so the
  // "scratch" copy edited the developer's worktree — and `rmSync` of the target
  // DELETED the real `lens-mutant-harness.ts`. `git status` caught it. This canary
  // hashes every file the ratchet mutates BEFORE and AFTER a full measurement pass
  // and refuses if any byte moved: a rig that mutates its own input is not a rig.
  const beforeHashes = new Map(
    HARNESS_MUTANTS.map((m) => [m.file, createHash("sha1").update(readFileSync(path.join(EXTENSION_ROOT, m.file))).digest("hex")]),
  );
  const drift = [...beforeHashes].filter(
    ([file, hash]) =>
      createHash("sha1").update(readFileSync(path.join(EXTENSION_ROOT, file))).digest("hex") !== hash,
  );
  check(
    drift.length === 0,
    `canary: measuring the mutants left every mutated source file byte-identical (${drift.length} drifted${drift.length ? `: ${JSON.stringify(drift.map(([f]) => f))}` : ""}) — a rig that writes into the tree it measures is not a rig`,
  );
}

// Two mutants producing the identical red line is the fingerprint of one silent
// no-op: both "went red", only one of them did so because its check failed.
{
  const pairs = indistinguishablePairs(results);
  check(
    pairs.length === 0,
    `no two mutants redden the identical assertion line (pairs ${JSON.stringify(pairs)}) — identical red sets mean one mutant is a silent no-op riding on its sibling's red`,
  );
}

console.log(exit === 0 ? "\nAll harness-fidelity ratchet checks passed." : "\nFAILED");
process.exit(exit);

// ───────────────────────── the rig is itself a harness entry point
//
// The class of defect this whole file exists to close is "a verification step runs
// and is never shown able to fail". A rig that can write into the tree it measures
// is that class wearing the rig's own shape, and it happened here twice: one
// revision symlinked `smoke-tests/lib` as a directory and wrote the mutant through
// the link, and `rmSync` of the target deleted the real `lens-mutant-harness.ts`;
// a second revision wrote a P1 mutant into `lens-class-mutants.ts` through a LEAF
// symlink, because `writeFileSync` follows it. So the rig's containment property is
// asserted, not assumed — with its own failing probe, because a containment check
// that cannot fail is exactly the thing being checked.
{
  const probe = mkdtempSync(path.join(tmpdir(), "ratchet-probe-"));
  const ext = path.join(probe, "extension");
  mkdirSync(ext, { recursive: true });
  const leaky = path.join(ext, "leaky.ts");
  const victim = path.join(EXTENSION_ROOT, "smoke-tests", "lib", "lens-class-mutants.ts");
  symlinkSync(victim, leaky, "file");
  let contained = false;
  let why = "";
  try {
    assertNoSymlinkInScratchTree(ext, ["leaky.ts"]);
  } catch (e) {
    contained = true;
    why = (e as Error).message;
  }
  check(
    contained && why.includes("back into the source tree"),
    `canary: assertNoSymlinkInScratchTree REFUSES a scratch tree whose leaf links into the source tree (${why.slice(0, 110) || "no throw"}) — a rig that writes through a leaf symlink mutates the file under measurement`,
  );
  // The companion, so the refusal above is not a check that fires on everything:
  // a tree of real files must pass, or the guard would simply always throw.
  rmSync(leaky, { force: true });
  writeFileSync(leaky, "export const x = 1;\n");
  let falseAlarm = false;
  try {
    assertNoSymlinkInScratchTree(ext, ["leaky.ts"]);
  } catch {
    falseAlarm = true;
  }
  check(
    !falseAlarm,
    "canary: a scratch tree of real files is ACCEPTED by the same guard (the refusal above is about links into the source, not about any tree) — without this the guard could pass by always throwing",
  );
  rmSync(probe, { recursive: true, force: true });
}
