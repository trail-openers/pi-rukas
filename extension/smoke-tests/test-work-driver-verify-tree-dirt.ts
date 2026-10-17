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
import { recordConsolidatedVerifySkip } from "../src/work-driver-verify-events.ts";
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
      porcelainL1.includes(" M .pi/verify-cmd"),
      `case l1 (setup): the gate file reads as an unstaged tracked modification, i.e. an exact \` M .pi/verify-cmd\` porcelain line (${JSON.stringify(porcelainL1)})`,
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
      isDirtForTreeIdentity("?? a.txt") === true,
      "case l1: an untracked file outside the driver's artefacts is dirt",
    );
    // Unit half of the narrowing: only the DRIVER's artefacts are exempt.
    assert(
      isDirtForTreeIdentity("?? tmp/evil.ts") === true,
      "case l1: an untracked '?? tmp/evil.ts' IS dirt — tmp/ is not exempt wholesale",
    );
    assert(
      isDirtForTreeIdentity("?? .pi/other") === true,
      "case l1: an untracked '?? .pi/other' IS dirt — .pi/ is not exempt wholesale",
    );
    assert(
      isDirtForTreeIdentity("?? tmp/issue-12/x") === false,
      "case l1: an untracked '?? tmp/issue-12/x' (the cycle scratch) is exempt",
    );
    assert(
      isDirtForTreeIdentity("?? .pi/work-state/1.json") === false,
      "case l1: an untracked '?? .pi/work-state/1.json' (the driver's state) is exempt",
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
    // Untracked entries under each shape the driver itself writes — the
    // scaffolding a real cycle leaves behind, so this is the shape whose
    // exemption keeps every cycle from paying a duplicate verify.
    mkdirSync(path.join(f.worktrees.default as string, ".pi", "work-state"), { recursive: true });
    writeFileSync(path.join(f.worktrees.default as string, ".pi", "x"), "scratch\n");
    writeFileSync(
      path.join(f.worktrees.default as string, ".pi", "work-state", "1252.json"),
      "{}\n",
    );
    mkdirSync(path.join(f.worktrees.default as string, "tmp", "issue-1252"), { recursive: true });
    writeFileSync(path.join(f.worktrees.default as string, "tmp", "y"), "scratch\n");
    writeFileSync(
      path.join(f.worktrees.default as string, "tmp", "issue-1252", "handoff-comment.md"),
      "scratch\n",
    );
    mkdirSync(path.join(f.worktrees.default as string, ".worktrees", "other"), {
      recursive: true,
    });
    writeFileSync(
      path.join(f.worktrees.default as string, ".worktrees", "other", "readme"),
      "scratch\n",
    );

    // `?? .pi/x` and `?? tmp/y` are NOT artefacts the driver writes, so the
    // narrowing makes them dirt — and they are exactly what makes the gate
    // below run the consolidated verify. The identity assertions therefore use
    // the driver-only shapes; the broad-prefix residue is the dirt case.
    const driverOnly = mkdtempSync(path.join(root, "driver-only-"));
    await execFileP("git", ["init", "-q", "--initial-branch=main", driverOnly]);
    await git(driverOnly, ["config", "user.email", "t@example.com"]);
    await git(driverOnly, ["config", "user.name", "T"]);
    writeFileSync(path.join(driverOnly, "a.txt"), "a\n");
    await git(driverOnly, ["add", "."]);
    await git(driverOnly, ["commit", "-q", "-m", "task: add a"]);
    mkdirSync(path.join(driverOnly, ".pi", "work-state"), { recursive: true });
    writeFileSync(path.join(driverOnly, ".pi", "work-state", "1252.json"), "{}\n");
    mkdirSync(path.join(driverOnly, "tmp", "issue-1252"), { recursive: true });
    writeFileSync(path.join(driverOnly, "tmp", "issue-1252", "notes.md"), "scratch\n");
    mkdirSync(path.join(driverOnly, ".worktrees", "sibling"), { recursive: true });
    writeFileSync(path.join(driverOnly, ".worktrees", "sibling", "readme"), "scratch\n");

    const treeHash = await verifyTreeId(execp, driverOnly);
    assert(
      typeof treeHash === "string",
      `case l2: the driver's own untracked artefacts stay exempt — identity stands (got: ${treeHash})`,
    );
    const strayTree = await verifyTreeId(execp, f.worktrees.default as string);
    assert(
      strayTree === undefined,
      `case l2: broad-prefix residue that is not the driver's (?? .pi/x, ?? tmp/y) denies the identity (got: ${strayTree})`,
    );

    const counts: Counts = { runs: [], repoRoot: f.repo };
    // The residue this fixture writes (`?? .pi/x`, `?? tmp/y`) is NOT the
    // driver's own, so after the narrowing it is dirt: the identity is
    // unestablished and the consolidated verify RUNS. That is the new, safer
    // outcome — a stray file under a driver-prefix directory now costs a
    // duplicate run instead of hiding a change the command reads.
    const gate = await verifyStepOutcome(
      ctxFor(f.repo, 1252, makeExec(counts)),
      stateFor(f, 1252),
      "develop",
    );
    assert(
      ranAt(counts.runs, f.repo),
      `case l2: non-driver residue under a driver prefix forces the consolidated verify to run (runs: ${JSON.stringify(counts.runs)})`,
    );
    assert(
      !gate.notes.some((n) => /consolidated verify skipped/.test(n)),
      `case l2: no skip while broad-prefix residue stands (notes: ${JSON.stringify(gate.notes)})`,
    );

    // The other half: with ONLY the driver's own artefacts present, the skip
    // still fires — the narrowing must not cost every real cycle a run.
    const d = await fixture(root, "driver-artefacts-only", ["default"]);
    installVerifyCmd(d.repo, "never-written.txt");
    const dwt = d.worktrees.default as string;
    writeFileSync(path.join(dwt, "a.txt"), "a\n");
    await git(dwt, ["add", "."]);
    await git(dwt, ["commit", "-q", "-m", "task: add a"]);
    mkdirSync(path.join(dwt, ".pi", "work-state"), { recursive: true });
    writeFileSync(path.join(dwt, ".pi", "work-state", "1253.json"), "{}\n");
    mkdirSync(path.join(dwt, "tmp", "issue-1253"), { recursive: true });
    writeFileSync(path.join(dwt, "tmp", "issue-1253", "handoff-comment.md"), "scratch\n");
    mkdirSync(path.join(dwt, ".worktrees", "sibling"), { recursive: true });
    writeFileSync(path.join(dwt, ".worktrees", "sibling", "readme"), "scratch\n");
    const dCounts: Counts = { runs: [], repoRoot: d.repo };
    const dGate = await verifyStepOutcome(
      ctxFor(d.repo, 1253, makeExec(dCounts)),
      stateFor(d, 1253),
      "develop",
    );
    assert(
      !ranAt(dCounts.runs, d.repo),
      `case l2: the driver's own untracked artefacts never force a duplicate verify (runs: ${JSON.stringify(dCounts.runs)})`,
    );
    assert(
      dGate.notes.some((n) => /consolidated verify skipped/.test(n)),
      `case l2: the skip still fires with only driver artefacts present (notes: ${JSON.stringify(dGate.notes)})`,
    );

    // ---- the durable half of "never silent" (#1240 review r2, item 2) ----
    // The note is what the operator sees; the EVENT is what survives in the
    // state file, and a fast `develop` is only explainable from there. Driven
    // from the SAME gate result above (not a hand-built identity), through the
    // one recorder all four develop re-run seams share. The control is a gate
    // that ran the command: the skip event's absence is the evidence a run
    // happened, so a recorder that appended unconditionally is caught here.
    const afterRecord = recordConsolidatedVerifySkip(stateFor(d, 1253), dGate);
    const recorded = afterRecord.eventLog.filter((e) => e.kind === "consolidated-verify-skipped");
    assert(
      recorded.length === 1,
      `case l2: the skip lands in state.eventLog as consolidated-verify-skipped (log kinds: ${afterRecord.eventLog.map((e) => e.kind).join(",")})`,
    );
    assert(
      recorded[0]?.kind === "consolidated-verify-skipped" &&
        recorded[0].step === "develop" &&
        recorded[0].workstreamCount === 1 &&
        recorded[0].treeHash === dGate.consolidatedVerifySkipped?.treeHash &&
        recorded[0].worktree === dGate.consolidatedVerifySkipped?.worktree,
      `case l2: the event carries step=develop, the N=1 count and the identity the gate proved (${JSON.stringify(recorded[0])})`,
    );
    assert(
      recordConsolidatedVerifySkip(stateFor(d, 1253), {}).eventLog.length ===
        stateFor(d, 1253).eventLog.length,
      "case l2 (control): a gate that ran the consolidated verify appends no skip event",
    );
    // The recorder is reached through the verify side, not the events fragment
    // — the fragment must stay type-only (no value import of `appendEvent`
    // from workflow-state.ts, which closed a require cycle).
    const fragment = await Bun.file(
      new URL("../src/workflow-state-events-verify-flake.ts", import.meta.url),
    ).text();
    assert(
      !/^import\s+(?!type)/m.test(fragment) && !/^import\s+\{[^}]*\bappendEvent\b/m.test(fragment),
      "case l2: the events fragment carries no runtime import (no cycle through workflow-state.ts)",
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
      isDirtForTreeIdentity("?? a.txt") === true &&
        isDirtForTreeIdentity("?? .pi/work-state/1.json") === false,
      "case l3: untracked entries are dirt unless they are the driver's own artefacts",
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

    const clean = await verifyTreeId(execp, wt);
    assert(
      typeof clean === "string",
      `case l3 (pre-iii): a clean worktree has an identity to compare against (got: ${clean})`,
    );

    // (iii) The untracked narrowing, end to end: an untracked source in the
    //       worktree that is NOT one of the driver's artefacts denies the
    //       identity even though it sits under a prefix the dirty-root gates
    //       wave through. This is the assertion that goes RED if the untracked
    //       exemption reverts to `isDriverManagedDirtLine`'s wholesale prefixes.
    mkdirSync(path.join(wt, "tmp"), { recursive: true });
    writeFileSync(path.join(wt, "tmp", "evil.ts"), "export const x = 1\n");
    const evilPorcelain = (await git(wt, ["status", "--porcelain", "-uall"])).stdout;
    assert(
      evilPorcelain.includes("?? tmp/evil.ts"),
      `case l3 (iii-a) (setup): git reports the stray file as untracked (${JSON.stringify(evilPorcelain)})`,
    );
    const evil = await verifyTreeId(execp, wt);
    assert(
      evil === undefined,
      `case l3 (iii-a): '?? tmp/evil.ts' is dirt, so the worktree has NO identity (got: ${evil})`,
    );
    // …while the driver's own scratch under the SAME prefix stays invisible.
    rmSync(path.join(wt, "tmp", "evil.ts"), { force: true });
    mkdirSync(path.join(wt, "tmp", "issue-1253"), { recursive: true });
    writeFileSync(path.join(wt, "tmp", "issue-1253", "notes.md"), "scratch\n");
    const driverScratch = await verifyTreeId(execp, wt);
    assert(
      driverScratch === clean,
      `case l3 (iii-b): '?? tmp/issue-1253/notes.md' is the driver's own scratch, identity stands (got: ${driverScratch})`,
    );
    rmSync(path.join(wt, "tmp"), { recursive: true, force: true });

    // (iv) Positive control: a clean worktree still HAS an identity, so the
    //      cases above are the dirt speaking, not a read that never works.
    const clean2 = await verifyTreeId(execp, wt);
    assert(
      typeof clean2 === "string",
      `case l3 (iv): the clean worktree keeps its identity (got: ${clean2})`,
    );
  }
} finally {
  rmSync(root, { recursive: true, force: true });
}

console.log(`\nexit ${exit}`);
process.exit(exit);
