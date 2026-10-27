#!/usr/bin/env bun
/**
 * #1849 C — the fix pass's fan-out CEILING does not charge a pass for the tests
 * its own coupled-test route admitted.
 *
 * The ceiling bounds how far a pass may WANDER from its declared scope; a test
 * that proves the pass's own fix is the opposite of wandering, and the
 * coupled-test route exists precisely so a fix lands with its test. Charging the
 * ceiling for it parked passes in which every single file had been asked for.
 *
 * Split from `test-fix-pass-fence-1698.ts` (the corrective route's five
 * conditions), which the ceiling check shares a scaffold with but is a different
 * rule — and whose file the size gate would not hold at 557 lines.
 */

import { rmSync } from "node:fs";
import { defaultExec } from "../src/work-driver-adversarial-fix-git.ts";
import { postPassFault } from "../src/work-driver-adversarial-fix-scope.ts";
import {
  correctiveScaffold,
  devCommit,
  fixState,
  mustRead,
  passEdit,
  plannedPassesFor,
  repoWithFile,
  trackAtBase,
} from "./lib/adversarial-fix-fixtures.ts";

let exit = 0;
function assert(cond: boolean, msg: string) {
  if (cond) console.log(`✓ ${msg}`);
  else {
    console.error(`✗ ${msg}`);
    exit = 1;
  }
}

// 0 — #1846 C: a coupled test the admission route admitted does NOT also spend
// the fan-out ceiling. The ceiling bounds how far a pass may WANDER; a test that
// proves the pass's own fix is the opposite of wandering, and charging for it
// parks a pass in which every single file was asked for.
{
  const { dir, st, planned } = await correctiveScaffold("1846-coupled-fanout");
  try {
    passEdit(dir);
    // One declared file, fixed, with six coupled tests beside it: the declared
    // count is 2 and the minimum limit is 6, so seven files is over it — unless
    // the coupled tests are excluded from the numerator, which is the point.
    devCommit(dir, "lib/main.ts", "export const m = 2;\n");
    // `main.test.ts` is the one coupled test the name rule can prove — its stem
    // token IS the subject's whole basename. It is committed UNTRACKED-clean and
    // named by the finding, so it clears the widening provenance, which lets the
    // pass reach the ceiling check at all.
    devCommit(dir, "lib/main.test.ts", "test main\n");
    // Seven MORE tests coupled to the same subject: the name rule proves each one
    // (`main-<n>.test.ts` tokenises to `main`). Nine tracked files against the
    // ceiling `max(2*3, 6) = 6` — so with the coupled tests in the numerator this
    // pass parks on the fan-out limit, and with them excluded (2 files) it
    // clears. Varying ONLY the numerator's membership is what makes this case
    // fail on the pre-#1846 shape.
    for (let i = 0; i < 7; i++) devCommit(dir, `lib/main-${i}.test.ts`, `test m${i}\n`);
    const post = await postPassFault(
      defaultExec,
      planned,
      st.pipelineState.baseSha ?? "",
      [],
    );
    assert(
      post.reason === undefined,
      `0: the coupled tests the route admits are not charged to the fan-out ceiling (got "${(post.reason ?? "").slice(0, 120)}")`,
    );
    // The canary that makes the case above mean something: the ceiling check IS
    // reachable in this scaffold, and it is the ONLY thing that could park this
    // pass (every file here is declared or coupled). If it stops firing, case 0
    // passed because the check is unreachable, not because the numerator excludes.
    const wide = repoWithFile("1846-coupled-fanout-wide");
    try {
      trackAtBase(wide, { "lib/main.ts": "export const m = 1;\n" });
      const wst = fixState(wide, ["a.txt", "lib/main.ts"], "a.txt: change one to two");
      const wplanned = await plannedPassesFor(wide, wst, "a.txt: change one to two");
      passEdit(wide);
      devCommit(wide, "lib/main.ts", "export const m = 2;\n");
      devCommit(wide, "lib/main.test.ts", "test main\n");
      for (let i = 0; i < 7; i++) devCommit(wide, `lib/wide${i}.ts`, `export const w${i} = 1;\n`);
      const wpost = await postPassFault(defaultExec, wplanned, wst.pipelineState.baseSha ?? "", []);
      // Either refusal is a real stop: an uncoupled file parks on its own
      // admission refusal, and had the ladder admitted it (a directory-wide
      // declared entry) the ceiling would be the next thing to say no. What the
      // assertion needs is that the scaffold WITHOUT coupled tests does not clear
      // the way case 0 does — otherwise 0's pass says nothing about the numerator.
      assert(
        wpost.reason !== undefined,
        `0b: canary — the same scaffold WITH uncoupled files does not clear, so 0 is a real exclusion (got "${(wpost.reason ?? "").slice(0, 120)}")`,
      );
    } finally {
      rmSync(wide, { recursive: true, force: true });
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}


if (exit !== 0) console.log(`\n${exit} assertion(s) FAILED`);
else console.log("\nall assertions passed");
process.exit(exit);
