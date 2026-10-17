#!/usr/bin/env bun
/**
 * #1391 task-e — offline REAL-GIT test of the severed lens-fix attempt: a
 * dirty worktree must not defeat the retry. (Part 1: the incident, the save,
 * the failure to save, and the reposition that follows.)
 *
 * The tehas incident (cycle 109-261015-212759, err.txt:100-103): the round-2
 * lens-fix developer died mid-stream (`cause=provider-severed`), the driver
 * re-ran the whole step, and the new attempt met the tree the dead child left
 * behind —
 *
 *   lens-fix-reposition: worktree has uncommitted changes: M DESIGN.md, …
 *   work-driver: lens-fix reposition guard parked the cycle — dirty: …
 *
 * — so the retry's own precondition check was defeated by the failure it was
 * retrying after: the third round lasted one second, no fixer was dispatched,
 * and the half-written work survived only as a scratch diff.
 *
 * What this file pins, against REAL git (no Pi spawn, no network — `origin`
 * is a bare repo on disk):
 *
 *  0. The incident shape is REPRODUCED first. The tree the dead attempt
 *     leaves is exactly the tree the #981 guard refuses to dispatch onto, and
 *     the guard returns `dirty` without moving it. A test that only asserts
 *     the fixed behaviour without seeing the failure is worthless (#1283 /
 *     #986's "a gate never observed to fail is worthless").
 *  1. The preserve-then-clean seam (`cleanWorktreeForRetry`) makes that tree
 *     clean WITHOUT destroying the work: the tree ends clean, the dirt
 *     survives in the worktree's own git history, and the preserved ref plus
 *     the scratch patch are both recorded.
 *  2. Idempotence: a clean tree is a no-op, and it is recorded no more than
 *     once. The retry re-enters the step, so the router's save is allowed to
 *     run twice only in the sense that the second run sees nothing.
 *  3. A save that does not land is a FAILURE, not a silent pass: nothing is
 *     cleared, the tree keeps its dirt, and the reason names why. Cleaning by
 *     destroying the lost attempt's work is the failure mode this whole
 *     change exists to avoid, so the seam refuses rather than guesses.
 *  4. After the clean, the #981 gate says the base is trustworthy — and when
 *     the branch has advanced in the meantime (the #978 shape layered on top
 *     of the #1391 shape, which is what a round-2 retry actually looks like)
 *     the gate repositions the tree instead of parking on it.
 *
 * Part 2 (`test-work-driver-retry-dirty-tree-accounting.ts`) pins the
 * operator-facing account. The seam under test is the composition the router
 * calls before it re-dispatches; this file does not re-test the router's
 * budget arithmetic — test-retry-lost-work.ts and
 * test-work-driver-transient-retry.ts own that.
 *
 * Deliberately NOT named `*-live.ts` — same convention as
 * test-work-driver-integrate-realgit.ts and test-work-driver-981-divergence-realgit.ts.
 */

import { readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import { repositionLensFixWorktree } from "../src/work-driver-lens-fix-reposition-gate.ts";
import { cleanWorktreeForRetry } from "../src/work-retry-tree-clean.ts";
import type { ExecFn } from "../src/worktree.ts";
import {
  fixture,
  git,
  gitOut,
  porcelain,
  realExec,
  saveArgs,
  severTheAttempt,
} from "./lib/retry-dirty-tree-fixture.ts";

let exit = 0;
function assert(cond: boolean, msg: string) {
  if (cond) console.log(`✓ ${msg}`);
  else {
    console.error(`✗ ${msg}`);
    exit = 1;
  }
}

try {
  // ==========================================================================
  // 0. The incident, reproduced. The dirt a severed attempt leaves IS the
  //    dirt the #981 guard refuses to dispatch a fixer onto.
  // ==========================================================================
  {
    const { repo, wt, branch } = await fixture("repro");
    severTheAttempt(wt);
    const before = await porcelain(wt);
    assert(before.length > 0, "repro: the severed attempt leaves an uncommitted tree");
    const dirtied = await gitOut(wt, ["status", "--porcelain", "-uall"]);
    assert(
      dirtied.includes("feature.txt") && dirtied.includes("host/game-view.js"),
      `repro: the dirt names the files the dead attempt edited (got: ${dirtied.replace(/\n/g, " | ")})`,
    );

    const rep = await repositionLensFixWorktree(realExec, wt, branch, [1391], "severed lens-fix");
    assert(
      rep.kind === "dirty",
      `repro: the reposition gate refuses to dispatch onto it (got ${rep.kind}) — this is the parked shape`,
    );
    assert(
      rep.kind === "dirty" && rep.detail.includes("uncommitted changes"),
      "repro: the gate's detail names uncommitted changes, exactly the cycle-109 evidence",
    );
    rmSync(repo, { recursive: true, force: true });
  }

  // ==========================================================================
  // 1. The preserve-then-clean seam: clean for the retry, nothing destroyed.
  // ==========================================================================
  {
    const f = await fixture("preserve");
    const headBefore = await gitOut(f.wt, ["rev-parse", "HEAD"]);
    severTheAttempt(f.wt);

    const res = await cleanWorktreeForRetry(realExec, saveArgs(f));
    assert(res.kind === "cleaned", `1: the dirty tree is cleaned (got ${res.kind})`);
    const save = res.kind === "cleaned" ? res : undefined;
    assert(
      save?.files.length === 4,
      `1: all four dirty paths are accounted for (got ${JSON.stringify(save?.files)})`,
    );
    assert(
      (await porcelain(f.wt)) === "",
      "1: the tree is CLEAN afterwards — the retry's precondition now holds",
    );
    assert(
      save?.commit !== undefined,
      "1: the dirt was committed, so it is in the worktree's own history, not merely deleted",
    );

    // Nothing destroyed: the preserved ref still names the saved state, and
    // every file the dead attempt wrote is readable from it.
    assert(
      (save?.preservedRef ?? "").startsWith("refs/pi-rukas/"),
      `1: a durable preserved ref is recorded (got ${JSON.stringify(save?.preservedRef)})`,
    );
    if (save?.preservedRef) {
      const saved = await gitOut(f.repo, ["rev-parse", save.preservedRef]).catch(() => "");
      assert(saved.length === 40, `1: the preserved ref resolves to a commit (${saved.slice(0, 8)})`);
      const listed = await gitOut(f.repo, [
        "ls-tree",
        "-r",
        "--name-only",
        save.preservedRef,
      ]).catch(() => "");
      assert(
        listed.includes("host/game-view.js") && listed.includes("scratch-notes.txt"),
        "1: the preserved commit holds the tracked edit AND the untracked file — an untracked file is the one the retry would otherwise lose",
      );
      const design = await gitOut(f.repo, ["show", `${save.preservedRef}:DESIGN.md`]).catch(() => "");
      assert(
        design.includes("half-written design"),
        "1: the half-written content is recoverable verbatim from the preserved ref",
      );
    }

    // The patch too: the operator's copy, outside the tree that gets reset.
    const patches = readdirSync(f.scratch).filter((n) => n.endsWith(".patch"));
    assert(
      patches.length === 1,
      `1: exactly one salvage patch is written into the scratch dir (got ${JSON.stringify(patches)})`,
    );
    if (patches[0]) {
      const body = readFileSync(path.join(f.scratch, patches[0]), "utf8");
      assert(
        body.includes("halfWritten") || body.includes("game-view"),
        "1: the patch carries the dead attempt's content, not an empty diff",
      );
    }

    // The HEAD the retry starts from is the HEAD the lost attempt started
    // from: preserving the work must not leave the fixer on top of it.
    assert(
      (await gitOut(f.wt, ["rev-parse", "HEAD"])) === headBefore,
      "1: the worktree is back at the base the retry is supposed to start from",
    );

    // And the tree really is usable again for the gate that parked before.
    const rep = await repositionLensFixWorktree(realExec, f.wt, f.branch, [1391], "severed lens-fix");
    assert(
      rep.kind === "already-at-tip" || rep.kind === "repositioned",
      `1: after the clean the gate will dispatch the fixer (got ${rep.kind})`,
    );
    rmSync(f.repo, { recursive: true, force: true });
  }

  // ==========================================================================
  // 2. Idempotence: the retry re-enters the step, so a second save sees
  //    nothing and records nothing.
  // ==========================================================================
  {
    const f = await fixture("idempotent");
    severTheAttempt(f.wt);
    const first = await cleanWorktreeForRetry(realExec, saveArgs(f));
    const afterFirst = readdirSync(f.scratch).filter((n) => n.endsWith(".patch")).length;
    const second = await cleanWorktreeForRetry(realExec, saveArgs(f));

    assert(
      first.kind === "cleaned" && second.kind === "clean",
      `2: the second run reports a clean tree rather than a second save (got ${first.kind} then ${second.kind})`,
    );
    assert(
      readdirSync(f.scratch).filter((n) => n.endsWith(".patch")).length === afterFirst,
      "2: a no-op save writes no second patch",
    );
    assert(
      second.kind === "clean",
      "2: the no-op is reported as `clean` — the shape with no files to account for, so the retry line cannot claim a phantom save",
    );
    rmSync(f.repo, { recursive: true, force: true });
  }

  // ==========================================================================
  // 3. A save that cannot land is a FAILURE. The tree keeps its dirt; the
  //    driver must park rather than restart the step on a cleared tree.
  // ==========================================================================
  {
    const f = await fixture("save-fails");
    const headBefore = await gitOut(f.wt, ["rev-parse", "HEAD"]);
    severTheAttempt(f.wt);

    // A save that always fails: the executor passes everything through
    // unchanged except the calls that would preserve the work or clear the
    // tree. The seam must not proceed past the save, and must never delete
    // anything on the way out.
    const failing: ExecFn = async (cmd, o) => {
      const argv = o?.argv;
      if (
        argv &&
        (argv[0] === "update-ref" ||
          argv[0] === "commit" ||
          argv[0] === "clean" ||
          (argv[0] === "--literal-pathspecs" && (argv[1] === "commit" || argv[1] === "clean")) ||
          (argv[0] === "reset" && argv[1] === "--hard"))
      ) {
        throw new Error("simulated save/clear failure (cannot lock ref)");
      }
      return realExec(cmd, o);
    };

    const res = await cleanWorktreeForRetry(failing, saveArgs(f));
    assert(res.kind === "failed", `3: a save that does not land is reported as a failure (got ${res.kind})`);
    assert(
      res.kind === "failed" && res.reason.length > 0,
      "3: the failure names why, so the handoff is not a bare `failed`",
    );
    const still = await porcelain(f.wt);
    assert(
      still.includes("feature.txt") && still.includes("DESIGN.md"),
      `3: NOTHING is cleared when the save failed — the dirt is still there to recover (got: ${still.replace(/\n/g, " | ")})`,
    );
    assert(
      readdirSync(f.scratch).filter((n) => n.endsWith(".patch")).length === 0,
      "3: a failed save leaves no half-written patch behind to be mistaken for the work",
    );
    const headStill = await gitOut(f.wt, ["rev-parse", "HEAD"]);
    assert(
      headStill === headBefore,
      "3: HEAD never moved — the clear is downstream of the save, and it did not run",
    );
    rmSync(f.repo, { recursive: true, force: true });
  }

  // ==========================================================================
  // 4. The #978 shape layered on the #1391 shape: the branch advanced while
  //    the attempt was dying. Clean + reposition, not clean + stale base.
  // ==========================================================================
  {
    const f = await fixture("advanced");
    severTheAttempt(f.wt);

    // Round 1's fix landed on the branch while round 2's attempt was running.
    writeFileSync(path.join(f.repo, "feature.txt"), "const x = safeParse(input);\n");
    await git(f.repo, ["add", "feature.txt"]);
    await git(f.repo, ["commit", "-q", "-m", "fix(lens): round 1 review findings"]);
    await git(f.repo, ["push", "-q", "origin", f.branch]);

    const res = await cleanWorktreeForRetry(realExec, saveArgs(f, 2));
    assert(res.kind === "cleaned", `4: the dirty tree is cleaned (got ${res.kind})`);

    const rep = await repositionLensFixWorktree(realExec, f.wt, f.branch, [1391], "severed lens-fix");
    assert(
      rep.kind === "repositioned",
      `4: the gate MOVES the cleaned tree to the advanced tip rather than parking (got ${rep.kind})`,
    );
    const tip = await gitOut(f.repo, ["rev-parse", f.branch]);
    assert((await gitOut(f.wt, ["rev-parse", "HEAD"])) === tip, "4: the fixer will be dispatched onto the branch tip");
    const seen = await gitOut(f.wt, ["show", "HEAD:feature.txt"]);
    assert(
      seen.includes("safeParse"),
      "4: the repositioned tree sees round 1's committed fix — round 2 does not rebuild on the old base",
    );
    rmSync(f.repo, { recursive: true, force: true });
  }
} catch (err) {
  console.error(`✗ unexpected error: ${(err as Error).stack?.slice(0, 800) ?? err}`);
  exit = 1;
}

console.log(`\nexit ${exit}`);
process.exit(exit);
