#!/usr/bin/env bun
/**
 * #1240 — the develop gate ran the project's verify command TWICE on the same
 * content in an N=1 cycle: once in the develop worktree and once at repoRoot
 * for the consolidated probe, which cherry-picks that one workstream's OWN
 * commits onto baseSha. Measured on the tehas factory: ~21 min per pass, a
 * third of a three-round cycle, for a tree the first run already judged.
 *
 * The probe now compares git's own tree object ids and skips the command only
 * when it can PROVE the probe tree is the tree that just passed. Each case
 * uses a REAL repo and a real cherry-pick — the identity is git's, so a stub
 * could not establish it. The commit-pr half of the same rule
 * (`integrate()` step 4) is covered by
 * `test-work-driver-integrate-verify-skip.ts`:
 *
 *   a. same tree → skipped, and the note names the hash and the worktree;
 *   b. different tree (a sibling's commit rides along) → the run happens;
 *   c. the hash read fails → the run happens (fail closed toward running);
 *   d. N>1 → the run happens (the combination genuinely is a new tree);
 *   e. PI_ENSEMBLE_CONSOLIDATED_VERIFY_SKIP=0 → the run happens;
 *   f. the same tree, but a workstream verify FAILED → the run happens
 *      (the per-worktree gate never established the tree as green).
 *
 * The executor counts runs of the verify command only; git reads are free.
 * "Ran" therefore means exactly one thing: the project's command executed.
 *
 * Cases a-h: the develop step. The commit-pr half of the same rule
 * (`integrate()` step 4) is covered by `test-work-driver-integrate-verify-skip.ts`.
 * What COUNTS AS DIRT — the content that denies a tree its identity, which is
 * the other half of "a gate that cannot prove equivalence runs the check" —
 * is covered by `test-work-driver-verify-tree-dirt.ts` (the §12 size cap
 * split). The two eligibility seams are unit-tested directly in
 * `test-work-driver-verify-eligibility-unit.ts`.
 */

import { execFile } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { execp } from "../src/exec.ts";
import { runConsolidatedVerify } from "../src/work-driver-consolidated-verify.ts";
import type { AlreadyVerifiedTree } from "../src/work-driver-verify-tree.ts";
import { verifyTreeId } from "../src/work-driver-verify-tree.ts";
import { verifyStepOutcome } from "../src/work-driver-verify.ts";
import {
  type Counts,
  type Runs,
  ctxFor,
  installVerifyCmd,
  makeExec,
  ranAt,
  stateFor,
} from "./lib/consolidated-verify-exec.ts";
import { fixture } from "./lib/consolidated-verify-fixture.ts";

const execFileP = promisify(execFile);
const git = (cwd: string, args: string[]) => execFileP("git", args, { cwd });

// Empty glob list disables the frontend-only classification (#1012) so the
// gate always reaches the verify chain in this fixture.
process.env.PI_ENSEMBLE_FRONTEND_ONLY_GLOBS = "";

let exit = 0;
function assert(cond: boolean, msg: string) {
  if (cond) console.log(`✓ ${msg}`);
  else {
    console.error(`✗ ${msg}`);
    exit = 1;
  }
}

const root = mkdtempSync(path.join(tmpdir(), "pi-ens-1240-"));

/** At least one verify run happened at repoRoot (the consolidated probe). */
const ranAtRoot = (runs: Runs, repo: string) => ranAt(runs, repo);
/** At least one verify run happened in the given worktree. */
const ranIn = (runs: Runs, wt: string) => ranAt(runs, wt);

try {
  // ------------------------------------------------------------------ case a
  // N=1, committed work, per-worktree verify green → the consolidated probe is
  // the same tree: skipped, with the note naming the hash and the worktree.
  {
    const f = await fixture(root, "same-tree", ["default"]);
    installVerifyCmd(f.repo, "never-written.txt");
    writeFileSync(path.join(f.worktrees.default as string, "a.txt"), "a\n");
    await git(f.worktrees.default as string, ["add", "."]);
    await git(f.worktrees.default as string, ["commit", "-q", "-m", "task: add a"]);

    const counts: Counts = { runs: [], repoRoot: f.repo };
    const gate = await verifyStepOutcome(
      ctxFor(f.repo, 1240, makeExec(counts)),
      stateFor(f, 1240),
      "develop",
    );
    assert(gate.ok, `case a: the gate passes (failures: ${gate.failures.join(" | ")})`);
    assert(
      ranIn(counts.runs, f.worktrees.default as string),
      "case a: the per-worktree verify ran",
    );
    assert(
      !ranAtRoot(counts.runs, f.repo),
      `case a: the consolidated verify did NOT run (${JSON.stringify(counts.runs)})`,
    );
    const note = gate.notes.find((n) => /consolidated verify skipped/.test(n));
    assert(
      note !== undefined,
      `case a: a visible skip note is recorded (notes: ${JSON.stringify(gate.notes)})`,
    );
    assert(
      note?.includes("already passed in") &&
        note.includes(f.worktrees.default as string) &&
        /tree [0-9a-f]{40}/.test(note),
      `case a: the note names the tree hash and the worktree (got: ${note?.slice(0, 220)})`,
    );
    assert(
      !gate.notes.some((n) => /consolidated verify passed/.test(n)),
      "case a: no note claims a consolidated run that never happened",
    );
  }

  // ------------------------------------------------------------------ case b
  // A different tree: two workstreams, so the probe carries work the per-
  // worktree run never saw. The consolidated verify MUST run.
  // (This is the break-proof target: forcing the comparison to "equal" makes
  // this assertion go RED.)
  {
    const f = await fixture(root, "different-tree", ["a", "b"]);
    installVerifyCmd(f.repo, "never-written.txt");
    writeFileSync(path.join(f.worktrees.a as string, "a.txt"), "a\n");
    await git(f.worktrees.a as string, ["add", "."]);
    await git(f.worktrees.a as string, ["commit", "-q", "-m", "task-a"]);
    writeFileSync(path.join(f.worktrees.b as string, "b.txt"), "b\n");
    await git(f.worktrees.b as string, ["add", "."]);
    await git(f.worktrees.b as string, ["commit", "-q", "-m", "task-b"]);

    const counts: Counts = { runs: [], repoRoot: f.repo };
    const gate = await verifyStepOutcome(
      ctxFor(f.repo, 1241, makeExec(counts)),
      stateFor(f, 1241),
      "develop",
    );
    assert(
      ranAtRoot(counts.runs, f.repo),
      `case b: the consolidated verify ran — two workstreams combine into a tree neither worktree held (runs: ${JSON.stringify(counts.runs)})`,
    );
    assert(
      !gate.notes.some((n) => /consolidated verify skipped/.test(n)),
      "case b: no skip note when the trees differ",
    );
    assert(gate.ok, `case b: the gate passes (failures: ${gate.failures.join(" | ")})`);
  }

  // ------------------------------------------------------------------ case c
  // The hash read fails (the probe's `git write-tree` errors) → the run
  // happens. Absence of identity is never read as "the same tree".
  {
    const f = await fixture(root, "hash-read-fails", ["default"]);
    installVerifyCmd(f.repo, "never-written.txt");
    writeFileSync(path.join(f.worktrees.default as string, "a.txt"), "a\n");
    await git(f.worktrees.default as string, ["add", "."]);
    await git(f.worktrees.default as string, ["commit", "-q", "-m", "task: add a"]);

    const counts: Counts = { runs: [], repoRoot: f.repo };
    const gate = await verifyStepOutcome(
      ctxFor(
        f.repo,
        1242,
        // Break BOTH identity reads at repoRoot — the index tree and the HEAD
        // tree — while leaving the worktree's reads intact: an executor that
        // answers nothing is never read as a hash.
        makeExec(counts, {
          breakAtRepoRoot: (cmd) => /^git (write-tree|rev-parse HEAD\^\{tree\})$/.test(cmd),
        }),
      ),
      stateFor(f, 1242),
      "develop",
    );
    assert(
      ranAtRoot(counts.runs, f.repo),
      `case c: a failed hash read runs the consolidated verify anyway (runs: ${JSON.stringify(counts.runs)})`,
    );
    assert(
      !gate.notes.some((n) => /consolidated verify skipped/.test(n)),
      `case c: a failed hash read never skips (notes: ${JSON.stringify(gate.notes)})`,
    );
    assert(
      gate.notes.some((n) => /consolidated verify passed/.test(n)),
      "case c: the consolidated verify ran and reported its pass",
    );
  }

  // ------------------------------------------------------------------ case d
  // N>1 is unchanged by construction: the single-workstream condition is the
  // precondition, so no identity is even computed. Case b covers the run; this
  // case pins the shape where the N=1 tree would otherwise match — one
  // workstream holds the work, a second contributes nothing, and the cycle is
  // still N>1.
  {
    const f = await fixture(root, "n-greater-than-one", ["a", "b"]);
    installVerifyCmd(f.repo, "never-written.txt");
    writeFileSync(path.join(f.worktrees.a as string, "a.txt"), "a\n");
    await git(f.worktrees.a as string, ["add", "."]);
    await git(f.worktrees.a as string, ["commit", "-q", "-m", "task-a"]);

    const counts: Counts = { runs: [], repoRoot: f.repo };
    const gate = await verifyStepOutcome(
      ctxFor(f.repo, 1243, makeExec(counts)),
      stateFor(f, 1243),
      "develop",
    );
    assert(
      ranAtRoot(counts.runs, f.repo),
      `case d: with two workstreams in the cycle the consolidated verify runs (runs: ${JSON.stringify(counts.runs)})`,
    );
    assert(
      !gate.notes.some((n) => /consolidated verify skipped/.test(n)),
      "case d: no skip note at N>1",
    );
  }

  // ------------------------------------------------------------------ case e
  // The escape hatch: identical trees, but PI_ENSEMBLE_CONSOLIDATED_VERIFY_
  // SKIP=0 restores the pre-#1240 behaviour.
  {
    const f = await fixture(root, "escape-hatch", ["default"]);
    installVerifyCmd(f.repo, "never-written.txt");
    writeFileSync(path.join(f.worktrees.default as string, "a.txt"), "a\n");
    await git(f.worktrees.default as string, ["add", "."]);
    await git(f.worktrees.default as string, ["commit", "-q", "-m", "task: add a"]);

    process.env.PI_ENSEMBLE_CONSOLIDATED_VERIFY_SKIP = "0";
    const counts: Counts = { runs: [], repoRoot: f.repo };
    try {
      const gate = await verifyStepOutcome(
        ctxFor(f.repo, 1244, makeExec(counts)),
        stateFor(f, 1244),
        "develop",
      );
      assert(
        ranAtRoot(counts.runs, f.repo),
        `case e: PI_ENSEMBLE_CONSOLIDATED_VERIFY_SKIP=0 runs the consolidated verify anyway (runs: ${JSON.stringify(counts.runs)})`,
      );
      assert(
        !gate.notes.some((n) => /consolidated verify skipped/.test(n)),
        "case e: the escape hatch leaves no skip note",
      );
    } finally {
      // `delete` is what an operator's env looks like when the knob is unset;
      // assigning `undefined` would leave the key present as the string
      // "undefined", which `consolidatedVerifySkipEnabled` reads as a value.
      // biome-ignore lint/performance/noDelete: restoring an absent env key, not a cache
      delete process.env.PI_ENSEMBLE_CONSOLIDATED_VERIFY_SKIP;
    }
  }

  // ------------------------------------------------------------------ case f
  // The per-worktree verify FAILED on the only workstream, so nothing proved
  // that tree green: the probe still runs (and the per-worktree failure keeps
  // blocking, #1005).
  {
    const f = await fixture(root, "per-worktree-red", ["default"]);
    installVerifyCmd(f.repo, "never-written.txt", { fail: true });
    writeFileSync(path.join(f.worktrees.default as string, "a.txt"), "a\n");
    await git(f.worktrees.default as string, ["add", "."]);
    await git(f.worktrees.default as string, ["commit", "-q", "-m", "task: add a"]);

    const counts: Counts = { runs: [], repoRoot: f.repo };
    const gate = await verifyStepOutcome(
      ctxFor(f.repo, 1245, makeExec(counts, { fail: true })),
      stateFor(f, 1245),
      "develop",
    );
    assert(
      !gate.ok && gate.failures.some((fl) => /verify command/.test(fl)),
      `case f: the per-worktree failure still blocks the step (failures: ${gate.failures.join(" | ").slice(0, 200)})`,
    );
    assert(
      ranAtRoot(counts.runs, f.repo),
      `case f: the consolidated verify still runs when no per-worktree run proved this tree green (runs: ${JSON.stringify(counts.runs)})`,
    );
    assert(
      !gate.notes.some((n) => /consolidated verify skipped/.test(n)),
      `case f: an unverified tree is never 'already passed' (notes: ${JSON.stringify(gate.notes)})`,
    );
  }

  // ------------------------------------------------------------------ case g
  // Uncommitted-but-staged work in the DEVELOP worktree: the consolidation
  // transplants it as a patch, so identity is the worktree's INDEX tree and
  // the probe's index tree, and they still match. The run must be skipped.
  //
  // This case drives `runConsolidatedVerify` directly (with a pre-computed
  // identity, exactly as `runVerifyCommandGate` threads it) rather than the
  // whole develop gate: the gate's own #453 preflight refuses to pass a
  // workstream whose work is uncommitted, and that refusal predates #1240.
  // The gate path is covered by cases a–f; here the question is only whether
  // index identity matches across the patch transplant.
  {
    const f = await fixture(root, "staged-work", ["default"]);
    const verifyCmd = installVerifyCmd(f.repo, "never-written.txt");
    writeFileSync(path.join(f.worktrees.default as string, "a.txt"), "a\n");
    await git(f.worktrees.default as string, ["add", "."]); // staged, never committed

    // The identity the gate would compute BEFORE the probe (the worktree is
    // untouched until the next pass, so this is what just passed).
    const treeHash = await verifyTreeId(execp, f.worktrees.default as string);
    assert(
      typeof treeHash === "string",
      "case g: the staged worktree has a provable tree identity",
    );

    const runs: Runs = [];
    const result = await runConsolidatedVerify(makeExec({ runs, repoRoot: f.repo }), {
      repoRoot: f.repo,
      baseSha: f.baseSha,
      worktrees: { default: f.worktrees.default as string },
      scratchDir: path.join(f.dir, "scratch"),
      verifyCmd,
      timeoutMs: 30_000,
      alreadyVerifiedTree: {
        treeHash: treeHash as string,
        worktree: f.worktrees.default as string,
      } as AlreadyVerifiedTree,
    });
    assert(
      result.status === "passed" && result.skipped !== undefined,
      `case g: a staged-only worktree's index tree matches the probe's (status: ${result.status}, skipped: ${JSON.stringify((result as { skipped?: unknown }).skipped)})`,
    );
    assert(
      runs.length === 0,
      `case g: the verify command never ran at repoRoot (runs: ${JSON.stringify(runs)})`,
    );

    // Anti-vacuity: a wrong identity on the same fixture DOES run.
    const runs2: Runs = [];
    const wrong = await runConsolidatedVerify(makeExec({ runs: runs2, repoRoot: f.repo }), {
      repoRoot: f.repo,
      baseSha: f.baseSha,
      worktrees: { default: f.worktrees.default as string },
      scratchDir: path.join(f.dir, "scratch"),
      verifyCmd,
      timeoutMs: 30_000,
      alreadyVerifiedTree: {
        treeHash: "0000000000000000000000000000000000000000",
        worktree: f.worktrees.default as string,
      } as AlreadyVerifiedTree,
    });
    assert(
      wrong.status === "passed" && wrong.skipped === undefined && runs2.length === 1,
      `case g (anti-vacuity): a non-matching identity runs the verify (runs: ${JSON.stringify(runs2)})`,
    );
  }

  // ------------------------------------------------------------------ case i
  // The degenerate N=1 shape: the one worktree IS repoRoot. The per-worktree
  // loop never runs there (the `changed` decision excludes it, so the probe's
  // dirty-root refusal stays reachable), so there is no green run to reuse
  // and the consolidated verify runs exactly as before #1240.
  {
    const f = await fixture(root, "root-as-worktree", ["default"]);
    const verifyCmd = installVerifyCmd(f.repo, "never-written.txt");
    // Commit the root's work, then add an UNTRACKED file: untracked dirt at
    // repoRoot is what the probe's preflight refuses on, and in this shape
    // (the workstream's worktree IS the root) the gate itself does not run a
    // per-worktree verify — so there is no green run to reuse, whatever the
    // probe decides. Untracked (not staged) content keeps the probe's own
    // index identical to the committed tree, so a naive "hashes match"
    // rule would have skipped here; the real caller never asks in this shape.
    writeFileSync(path.join(f.repo, "a.txt"), "a\n");
    await git(f.repo, ["add", "a.txt"]);
    await git(f.repo, ["commit", "-q", "-m", "root work"]);
    writeFileSync(path.join(f.repo, "operator-residue.txt"), "deliberate\n");

    const runs: Runs = [];
    const result = await runConsolidatedVerify(makeExec({ runs, repoRoot: f.repo }), {
      repoRoot: f.repo,
      baseSha: f.baseSha,
      // The N=1 degenerate map: the workstream's "worktree" is the root.
      worktrees: { default: f.repo },
      scratchDir: path.join(f.dir, "scratch"),
      verifyCmd,
      timeoutMs: 30_000,
      // Deliberately NO `alreadyVerifiedTree`: this is exactly what the gate
      // passes for the root-as-worktree shape, and the pre-existing
      // dirty-root refusal still fires.
    });
    assert(
      result.status === "conflict" && runs.length === 0,
      `case i: the root-as-worktree probe keeps its dirty-root refusal and asks no identity (status: ${result.status}, runs: ${JSON.stringify(runs)})`,
    );
    // And the same fixture with the root clean does run the command — the
    // refusal above was the dirt, not a skip.
    rmSync(path.join(f.repo, "operator-residue.txt"));
    const runs2: Runs = [];
    const clean = await runConsolidatedVerify(makeExec({ runs: runs2, repoRoot: f.repo }), {
      repoRoot: f.repo,
      baseSha: f.baseSha,
      worktrees: { default: f.repo },
      scratchDir: path.join(f.dir, "scratch"),
      verifyCmd,
      timeoutMs: 30_000,
    });
    assert(
      clean.status === "passed" && runs2.length === 1,
      `case i: with a clean root the same probe runs the verify as before #1240 (status: ${clean.status}, runs: ${JSON.stringify(runs2)})`,
    );
  }

  // ------------------------------------------------------------------ case j
  // THE MISMATCH CASE AT N=1 — the one the skip rule actually guards. The
  // cycle's `baseSha` moved after the worktree branched (a base advance, a
  // resumed cycle, a re-recorded base): the probe is base' + the workstream's
  // commits, which is NOT the tree the worktree verify judged. Same workstream
  // count, same green per-worktree run — only the tree differs, so this is
  // what breaks if the comparison is forced to "equal".
  {
    const f = await fixture(root, "base-moved", ["default"]);
    installVerifyCmd(f.repo, "never-written.txt");
    writeFileSync(path.join(f.worktrees.default as string, "a.txt"), "a\n");
    await git(f.worktrees.default as string, ["add", "."]);
    await git(f.worktrees.default as string, ["commit", "-q", "-m", "task: add a"]);
    // Advance the mainline the cycle's base is recorded at: a second commit
    // on the base the probe checks out, which the worktree does not hold.
    const ahead = (await git(f.repo, ["rev-parse", "HEAD"])).stdout.trim();
    writeFileSync(path.join(f.repo, "base-extra.txt"), "from the advanced base\n");
    await git(f.repo, ["add", "base-extra.txt"]);
    await git(f.repo, ["commit", "-q", "-m", "base advance"]);
    const movedBase = (await git(f.repo, ["rev-parse", "HEAD"])).stdout.trim();
    assert(movedBase !== ahead, "case j (setup): the recorded base moved past the worktree's base");

    const counts: Counts = { runs: [], repoRoot: f.repo };
    const gate = await verifyStepOutcome(
      ctxFor(f.repo, 1249, makeExec(counts)),
      stateFor({ baseSha: movedBase, worktrees: f.worktrees }, 1249),
      "develop",
    );
    assert(
      ranAtRoot(counts.runs, f.repo),
      `case j: an N=1 probe built on a DIFFERENT base runs the verify — it is not the tree that passed (runs: ${JSON.stringify(counts.runs)})`,
    );
    assert(
      !gate.notes.some((n) => /consolidated verify skipped/.test(n)),
      `case j: no skip note when the trees differ at N=1 (notes: ${JSON.stringify(gate.notes)})`,
    );
  }

  // ------------------------------------------------------------------ case h
  // Unstaged dirt in the worktree: no tree object describes it, so the
  // worktree's identity is undefined and the probe runs. The verify command
  // reads FILES, and a hash of HEAD would be a claim about content that is
  // not what was tested.
  {
    const f = await fixture(root, "unstaged-dirt", ["default"]);
    installVerifyCmd(f.repo, "never-written.txt");
    writeFileSync(path.join(f.worktrees.default as string, "a.txt"), "a\n");
    await git(f.worktrees.default as string, ["add", "."]);
    await git(f.worktrees.default as string, ["commit", "-q", "-m", "task: add a"]);
    // A further edit, NOT staged: `git add .` was never run after it.
    writeFileSync(path.join(f.worktrees.default as string, "b.txt"), "b\n");

    const counts: Counts = { runs: [], repoRoot: f.repo };
    const gate = await verifyStepOutcome(
      ctxFor(f.repo, 1247, makeExec(counts)),
      stateFor(f, 1247),
      "develop",
    );
    assert(
      ranAtRoot(counts.runs, f.repo),
      `case h: unstaged work means no proven identity, so the consolidated verify runs (runs: ${JSON.stringify(counts.runs)})`,
    );
    assert(
      !gate.notes.some((n) => /consolidated verify skipped/.test(n)),
      "case h: no skip note when the tree is not described by any tree object",
    );
  }
} finally {
  rmSync(root, { recursive: true, force: true });
}

console.log(`\nexit ${exit}`);
process.exit(exit);
