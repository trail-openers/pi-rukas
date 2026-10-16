#!/usr/bin/env bun
/**
 * #1240 — what COUNTS AS DIRT for a tree identity.
 *
 * The duplicate-verify skip is only safe because `verifyTreeId` refuses to
 * name a tree when the working holds content NO tree object describes: the
 * skip requires two real hashes, so dirt on either side means the command
 * runs. A dirt check that under-reports is therefore the whole safety
 * argument failing open, and these cases are the ones that catch it — each
 * is a shape in which a hash would certify content the verify command never
 * read.
 *
 * Split out of `test-work-driver-consolidated-verify-skip.ts` (which owns the
 * skip DECISION, cases a-h) under the AGENTS.md §12 500-line cap; the shared
 * fixtures live in `lib/consolidated-verify-*.ts`.
 *
 *   l1. a TRACKED modification under a driver-managed prefix (`.pi/`, `tmp/`,
 *       `.worktrees/`) IS dirt. `isDriverManagedDirtLine` — which the dirty-root
 *       gates also call — exempts those prefixes for ANY XY code, because they
 *       ask "is there leftover SCRATCH to clear?". Tree identity asks a
 *       different question, and `.pi/`/`tmp/` are not gitignored: a tracked
 *       ` M .pi/verify-cmd` is the project's own gate edited mid-cycle. The
 *       exemption applies to UNTRACKED entries only, decided locally.
 *   l2. the driver's own UNTRACKED scaffolding stays exempt, or every cycle
 *       would pay a duplicate verify because the driver wrote its own state file.
 *   l3. THE COLUMN. Porcelain v1 is `XY<space>PATH`: index 0 is the INDEX
 *       column, index 1 the WORKTREE column, index 2 the separator — always a
 *       space. The worktree-column test used to read index 2, so it never
 *       fired: measured against real git, an unstaged ` M tracked.txt` and an
 *       index-added-then-deleted `AD new.txt` each returned a HEAD hash. These
 *       are the break-proof cases at this seam — reverting the index to 2
 *       turns them RED.
 *
 * Every case drives real git: the identity is git's own, so a stub could not
 * establish (or deny) it.
 */

import { execFile } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { execp } from "../src/exec.ts";
import { isDriverManagedDirtLine } from "../src/work-driver-branch-residue.ts";
import { isDirtForTreeIdentity, verifyTreeId } from "../src/work-driver-verify-tree.ts";
import { verifyStepOutcome } from "../src/work-driver-verify.ts";
import {
  type Counts,
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
  if (cond) console.log(`\u2713 ${msg}`);
  else {
    console.error(`\u2717 ${msg}`);
    exit = 1;
  }
}

const root = mkdtempSync(path.join(tmpdir(), "pi-ens-1240-dirt-"));

try {
  // ----------------------------------------------------------------- case l1
  // A TRACKED edit under a driver-managed prefix is dirt.
  //
  // `isDriverManagedDirtLine` — which the dirty-root gates also call —
  // exempts a path under `.worktrees/`, `.pi/` or `tmp/` for ANY XY code.
  // Those gates ask "is there leftover SCRATCH the operator must clear?".
  // Tree identity asks a different question — "do the FILES match a tree
  // object?" — and a TRACKED modification answers it the same way anywhere in
  // the tree, because `.pi/` and `tmp/` are not gitignored: a tracked
  // ` M .pi/verify-cmd` is the project's own gate being edited while the
  // verify supposedly ran against it. Before the local predicate, that line
  // was skipped entirely and `verifyTreeId` returned HEAD's tree — a claim
  // about content the command did not read.
  {
    const f = await fixture(root, "tracked-gate-edit", ["default"]);
    installVerifyCmd(f.repo, "never-written.txt");
    writeFileSync(path.join(f.worktrees.default as string, "a.txt"), "a\n");
    await git(f.worktrees.default as string, ["add", "."]);
    await git(f.worktrees.default as string, ["commit", "-q", "-m", "task: add a"]);
    // Tracked at repoRoot (a project that version-controls its gate has it
    // committed), then edited UNSTAGED.
    await git(f.repo, ["add", ".pi/verify-cmd"]);
    await git(f.repo, ["commit", "-q", "-m", "chore: track the verify command"]);
    assert(
      (await git(f.repo, ["ls-files", ".pi/verify-cmd"])).stdout.trim() === ".pi/verify-cmd",
      "case l1 (setup): .pi/verify-cmd is tracked at repoRoot",
    );
    writeFileSync(path.join(f.repo, ".pi", "verify-cmd"), "sh -c 'echo run >> edited.txt'\n");
    const porcelainL1 = (await git(f.repo, ["status", "--porcelain", "-uall"])).stdout;
    assert(
      porcelainL1.includes("M .pi/verify-cmd"),
      `case l1 (setup): the gate file reads as a tracked modification (${JSON.stringify(porcelainL1)})`,
    );

    // The unit level: that exact porcelain line is dirt for identity purposes
    // even though the shared driver-managed predicate exempts it.
    assert(
      isDirtForTreeIdentity(" M .pi/verify-cmd") === true,
      "case l1: a tracked ' M .pi/verify-cmd' IS dirt for tree identity",
    );
    assert(
      isDriverManagedDirtLine(" M .pi/verify-cmd") === true,
      "case l1 (contrast): the dirty-root predicate still exempts it — the two questions differ",
    );
    assert(
      isDirtForTreeIdentity("?? .pi/x") === false,
      "case l1: an untracked '?? .pi/x' is still exempt",
    );

    // And the effect, end to end: repoRoot's tree is the side the probe
    // compares against, so with a tracked gate edit standing there is NO
    // identity on that side and the consolidated verify runs. (The gate's
    // own dirty-root preflight refuses the probe first, which is the other
    // half of the same "never skip on unproven content" rule — either way
    // there is no skip.)
    const rootTree = await verifyTreeId(execp, f.repo);
    assert(
      rootTree === undefined,
      `case l1: repoRoot has NO tree identity while a tracked gate edit stands (got: ${rootTree})`,
    );

    const counts: Counts = { runs: [], repoRoot: f.repo };
    const gate = await verifyStepOutcome(
      ctxFor(f.repo, 1251, makeExec(counts)),
      stateFor(f, 1251),
      "develop",
    );
    assert(
      !gate.notes.some((n) => /consolidated verify skipped/.test(n)),
      `case l1: no skip note while a tracked gate edit stands (notes: ${JSON.stringify(gate.notes)})`,
    );
  }

  // ----------------------------------------------------------------- case l2
  // The other half of the same predicate: the driver's OWN scaffolding stays
  // exempt while untracked, or every cycle would run a duplicate verify
  // because the driver wrote its own state file.
  {
    const f = await fixture(root, "untracked-scaffolding", ["default"]);
    installVerifyCmd(f.repo, "never-written.txt");
    writeFileSync(path.join(f.worktrees.default as string, "a.txt"), "a\n");
    await git(f.worktrees.default as string, ["add", "."]);
    await git(f.worktrees.default as string, ["commit", "-q", "-m", "task: add a"]);
    // Untracked entries under each driver-managed prefix.
    mkdirSync(path.join(f.worktrees.default as string, ".pi", "work-state"), { recursive: true });
    writeFileSync(path.join(f.worktrees.default as string, ".pi", "x"), "scratch\n");
    writeFileSync(
      path.join(f.worktrees.default as string, ".pi", "work-state", "1252.json"),
      "{}\n",
    );
    mkdirSync(path.join(f.worktrees.default as string, "tmp", "issue-1252"), { recursive: true });
    writeFileSync(path.join(f.worktrees.default as string, "tmp", "y"), "scratch\n");

    const treeHash = await verifyTreeId(execp, f.worktrees.default as string);
    assert(
      typeof treeHash === "string",
      `case l2: an untracked '?? .pi/x' (and tmp/, .worktrees/) stays exempt — identity stands (got: ${treeHash})`,
    );

    const counts: Counts = { runs: [], repoRoot: f.repo };
    const gate = await verifyStepOutcome(
      ctxFor(f.repo, 1252, makeExec(counts)),
      stateFor(f, 1252),
      "develop",
    );
    assert(
      !ranAt(counts.runs, f.repo),
      `case l2: the driver's own untracked scaffolding never forces a duplicate verify (runs: ${JSON.stringify(counts.runs)})`,
    );
    assert(
      gate.notes.some((n) => /consolidated verify skipped/.test(n)),
      `case l2: the skip still fires with untracked scaffolding present (notes: ${JSON.stringify(gate.notes)})`,
    );
  }

  // ----------------------------------------------------------------- case l3
  // THE COLUMN. Porcelain v1 is `XY<space>PATH`: index 0 is the INDEX column,
  // index 1 the WORKTREE column, index 2 the SEPARATOR — always a space. The
  // worktree-column test used to read index 2, so it never fired and every
  // dirty tree looked clean: measured against real git, a worktree holding an
  // unstaged ` M tracked.txt` and one holding an index-added-then-deleted `AD
  // new.txt` each returned a HEAD hash, and `verifyTreeId` happily handed the
  // skip an identity for content NO tree object describes. These are the
  // break-proof cases at this seam: reverting the index to 2 turns them RED.
  {
    const f = await fixture(root, "porcelain-column", ["default"]);
    installVerifyCmd(f.repo, "never-written.txt");
    writeFileSync(path.join(f.worktrees.default as string, "a.txt"), "a\n");
    await git(f.worktrees.default as string, ["add", "."]);
    await git(f.worktrees.default as string, ["commit", "-q", "-m", "task: add a"]);
    const wt = f.worktrees.default as string;

    // The predicate itself, on the shapes real git produces.
    assert(
      isDirtForTreeIdentity(` M ${"a.txt"}`) === true,
      "case l3: ' M path' (worktree column set) is dirt",
    );
    assert(
      isDirtForTreeIdentity(`M  ${"a.txt"}`) === false,
      "case l3: 'M  path' (index column set, worktree blank) is NOT dirt",
    );
    assert(
      isDirtForTreeIdentity(`AD ${"a.txt"}`) === true,
      "case l3: 'AD path' (index added, then deleted from the worktree) is dirt",
    );
    assert(
      isDirtForTreeIdentity("?? .pi/x") === false && isDirtForTreeIdentity("?? a.txt") === true,
      "case l3: untracked entries are dirt unless driver-managed",
    );

    // (i) Unstaged modification in the worktree → no identity.
    writeFileSync(path.join(wt, "b.txt"), "b\n");
    const unstaged = await verifyTreeId(execp, wt);
    assert(
      unstaged === undefined,
      `case l3 (i): an unstaged modification gives NO identity (got: ${unstaged})`,
    );
    rmSync(path.join(wt, "b.txt"), { force: true });

    // (ii) Index-added then deleted from the worktree (`AD`) → no identity.
    //      The index describes a file the FILES do not hold, so neither side
    //      of the comparison can be trusted.
    writeFileSync(path.join(wt, "c.txt"), "c\n");
    await git(wt, ["add", "c.txt"]);
    rmSync(path.join(wt, "c.txt"), { force: true });
    const adPorcelain = (await git(wt, ["status", "--porcelain", "-uall"])).stdout;
    assert(
      adPorcelain.startsWith("AD "),
      `case l3 (ii) (setup): git reports the entry as AD (${JSON.stringify(adPorcelain)})`,
    );
    const ad = await verifyTreeId(execp, wt);
    assert(ad === undefined, `case l3 (ii): an AD entry gives NO identity (got: ${ad})`);
    await git(wt, ["reset", "-q", "--mixed", "HEAD"]);

    // (iii) Positive control: a clean worktree still HAS an identity, so the
    //         two above are the dirt speaking, not a read that never works.
    const clean = await verifyTreeId(execp, wt);
    assert(
      typeof clean === "string",
      `case l3 (iii): the clean worktree keeps its identity (got: ${clean})`,
    );
  }
} finally {
  rmSync(root, { recursive: true, force: true });
}

console.log(`\nexit ${exit}`);
process.exit(exit);
