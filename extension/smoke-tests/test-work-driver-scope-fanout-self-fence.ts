#!/usr/bin/env bun
/**
 * #784 — self-fence exemption in the develop scope-fence gate.
 *
 * The plan step can list the SAME file in a workstream's in-scope `paths`
 * AND in that workstream's own `outOfScope` fence — the plan contradicts
 * itself ("this file is yours" and "don't touch it" in the same plan). The
 * recorded #776 incident: rc1's fence listed work-driver-integrate.ts as
 * out-of-scope while integrate.ts is exactly where rc1's fix lives; the
 * driver parked on "declared fence violated" and the (correct, complete)
 * work had to be merged by hand (PR #779).
 *
 * The fix adds a SECOND, additive exemption branch to the per-file fence
 * hit filter: a fenced path is demoted (to a NOTE, not silently dropped)
 * when it is declared in the SAME workstream's own `paths`. Self-fence only
 * — a path declared by an INDEPENDENT sibling still fails with the identical
 * #679/#725 true-positive string. The #725 dependsOn carve-out is untouched.
 *
 * These cases drive `runScopeFanoutGate` directly (the seam test-scope-
 * fanout-725.ts uses for cases 3a–3e), so no git fixtures are needed.
 */

import { runScopeFanoutGate } from "../src/work-driver-scope-fanout.ts";

let exit = 0;
function assert(cond: boolean, msg: string) {
  if (cond) console.log(`✓ ${msg}`);
  else {
    console.error(`✗ ${msg}`);
    exit = 1;
  }
}

type WS = {
  id: string;
  scope: string;
  paths: string[];
  outOfScope: string[];
  dependsOn?: string[];
};

const FENCE_FAIL = /developer touched out-of-scope path .+ — declared fence violated/;
const DEMOTION_NOTE =
  /fence hit demoted to warning: .+ is declared in this workstream's own paths \(self-fence\)/;

function run(workstreams: Record<string, WS>, changed: Record<string, string[]>) {
  const failures: string[] = [];
  const notes: string[] = [];
  runScopeFanoutGate(
    workstreams,
    new Map(Object.entries(changed).map(([k, v]) => [k, new Set(v)] as [string, Set<string>])),
    failures,
    notes,
  );
  return { failures, notes };
}

// --------------------------------------------------------- case 1: the #776
// shape — workstream A's fence lists a file that ALSO appears in A's own
// declared paths; A's diff touches it. NO fence failure; demotion note
// present.
{
  const a: WS = {
    id: "a",
    scope: "x",
    paths: ["src/a.ts", "src/integrate.ts"],
    outOfScope: ["src/integrate.ts", "src/b.ts"],
  };
  const b: WS = { id: "b", scope: "y", paths: ["src/b.ts"], outOfScope: [] };
  const { failures, notes } = run({ a, b }, { a: ["src/integrate.ts"] });
  assert(
    !failures.some((f) => FENCE_FAIL.test(f)),
    `#776 shape: NO "declared fence violated" when the fenced file is self-declared (got: ${failures.join("; ")})`,
  );
  assert(
    notes.some((n) => DEMOTION_NOTE.test(n) && /src\/integrate\.ts/.test(n)),
    `#776 shape: demotion note IS present and names the path (got: ${notes.join("; ")})`,
  );
}

// --------------------------------------------------------- case 2: a fenced
// path declared ONLY by an independent sibling (no dependsOn) — the #679/#725
// true positive — must STILL fail with the identical failure string.
{
  const a: WS = { id: "a", scope: "x", paths: ["src/a.ts"], outOfScope: ["src/b.ts"] };
  const b: WS = { id: "b", scope: "y", paths: ["src/b.ts"], outOfScope: ["src/a.ts"] };
  const { failures, notes } = run({ a, b }, { b: ["src/a.ts"] });
  assert(
    failures.some((f) =>
      /developer touched out-of-scope path src\/a\.ts — declared fence violated/.test(f),
    ),
    `regression: sibling-declared path (no dependsOn) still FAILS with the unchanged string (got: ${failures.join("; ")})`,
  );
  assert(
    !notes.some((n) => DEMOTION_NOTE.test(n)),
    `regression: no demotion note for a sibling-only declaration (got: ${notes.join("; ")})`,
  );
}

// --------------------------------------------------------- case 3: mixed —
// one workstream touches TWO fenced files: one self-declared (demoted to a
// note) and one genuinely undeclared (still a failure). Exactly one failure,
// exactly one note.
{
  const a: WS = {
    id: "a",
    scope: "x",
    paths: ["src/own.ts", "src/self.ts"],
    outOfScope: ["src/self.ts", "src/other.ts"],
  };
  const { failures, notes } = run({ a }, { a: ["src/self.ts", "src/other.ts"] });
  const fenceFailures = failures.filter((f) => FENCE_FAIL.test(f));
  const demotionNotes = notes.filter((n) => DEMOTION_NOTE.test(n));
  assert(
    fenceFailures.length === 1 && /src\/other\.ts/.test(fenceFailures[0]),
    `mixed: exactly ONE failure, for the undeclared file (got: ${failures.join("; ")})`,
  );
  assert(
    !/src\/self\.ts/.test(fenceFailures.join("; ")),
    `mixed: the self-declared file does NOT appear in a failure (got: ${failures.join("; ")})`,
  );
  assert(
    demotionNotes.length === 1 && /src\/self\.ts/.test(demotionNotes[0]),
    `mixed: exactly ONE demotion note, for the self-declared file (got: ${notes.join("; ")})`,
  );
}

// --------------------------------------------------------- case 4: the
// demotion note wording is DISTINCT from the failure string, and the failure
// string never names a self-fenced path (the operator must be able to tell
// the two apart).
{
  const a: WS = {
    id: "a",
    scope: "x",
    paths: ["src/own.ts"],
    outOfScope: ["src/own.ts"],
  };
  const { failures, notes } = run({ a }, { a: ["src/own.ts"] });
  assert(
    !failures.some((f) => /src\/own\.ts/.test(f)),
    `distinct wording: no failure names the self-fenced path (got: ${failures.join("; ")})`,
  );
  const note = notes.find((n) => /src\/own\.ts/.test(n));
  assert(
    !!note &&
      !/declared fence violated/.test(note) &&
      /fence hit demoted to warning/.test(note),
    `distinct wording: the note is the demotion wording, not the failure wording (got: ${notes.join("; ")})`,
  );
}

// --------------------------------------------------------- case 5: dependsOn
// carve-out and self-fence are independent branches — self-fence must work
// WITH a dependsOn field present on the workstream (no interaction bug); the
// dependency-owned hit stays exempt via the #725 branch, the self-declared
// hit via the new branch.
{
  const a: WS = { id: "a", scope: "dep", paths: ["src/dep.ts"], outOfScope: [] };
  const b: WS = {
    id: "b",
    scope: "me",
    paths: ["src/own.ts", "src/self.ts"],
    outOfScope: ["src/self.ts", "src/dep.ts"],
    dependsOn: ["a"],
  };
  const { failures, notes } = run({ a, b }, { b: ["src/self.ts", "src/dep.ts"] });
  assert(
    !failures.some((f) => FENCE_FAIL.test(f)),
    `self-fence + dependsOn coexist: neither a self-declared nor a dependency-owned fence hit fails (got: ${failures.join("; ")})`,
  );
  assert(
    notes.filter((n) => DEMOTION_NOTE.test(n)).length === 1 &&
      notes.some((n) => /src\/self\.ts/.test(n) && DEMOTION_NOTE.test(n)),
    `self-fence + dependsOn coexist: exactly one demotion note, for the self-fenced path (got: ${notes.join("; ")})`,
  );
}

// --------------------------------------------------------- case 6:
// PI_ENSEMBLE_SCOPE_GATE=0 — the whole gate early-returns; no demotion note
// and no failure are produced (the demoted-warning path is reachable only
// under the same env handling as existing notes/failures).
{
  const prev = process.env.PI_ENSEMBLE_SCOPE_GATE;
  process.env.PI_ENSEMBLE_SCOPE_GATE = "0";
  try {
    const a: WS = {
      id: "a",
      scope: "x",
      paths: ["src/own.ts"],
      outOfScope: ["src/own.ts"],
    };
    const { failures, notes } = run({ a }, { a: ["src/own.ts"] });
    assert(
      failures.length === 0 && !notes.some((n) => DEMOTION_NOTE.test(n)),
      `gate disabled: no demotion note and no failure under PI_ENSEMBLE_SCOPE_GATE=0 (got: ${failures.join("; ")})`,
    );
    assert(
      notes.some((n) => /gate disabled/.test(n)),
      `gate disabled: the standard disabled-note is still emitted (got: ${notes.join("; ")})`,
    );
  } finally {
    if (prev === undefined) delete process.env.PI_ENSEMBLE_SCOPE_GATE;
    else process.env.PI_ENSEMBLE_SCOPE_GATE = prev;
  }
}

// --------------------------------------------------------- case 7: the
// self-fence check uses the SAME matching as the fence (directory prefix) —
// a file under a self-declared directory entry is demoted.
{
  const a: WS = {
    id: "a",
    scope: "x",
    paths: ["src/tree/"],
    outOfScope: ["src/tree/"],
  };
  const { failures, notes } = run({ a }, { a: ["src/tree/leaf.ts"] });
  assert(
    !failures.some((f) => FENCE_FAIL.test(f)),
    `directory self-fence: a file under a self-declared directory is demoted, not failed (got: ${failures.join("; ")})`,
  );
  assert(
    notes.some((n) => DEMOTION_NOTE.test(n) && /src\/tree\/leaf\.ts/.test(n)),
    `directory self-fence: demotion note names the touched file (got: ${notes.join("; ")})`,
  );
}

console.log(`\nexit ${exit}`);
process.exit(exit);
