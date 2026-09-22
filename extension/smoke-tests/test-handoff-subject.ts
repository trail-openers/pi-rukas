#!/usr/bin/env bun
/**
 * #810 — a parked cycle's consolidation commit must carry a subject that
 * describes the CHANGE (derived from the issue title), not the driver's
 * housekeeping `chore(handoff): …` line. release-please derives the version
 * bump and changelog from that subject, so a `fix:` that landed as `chore:`
 * produces no bump and no changelog entry (the #810 incident: PR #801).
 *
 * This test covers the pure derivation (`parseConventionalTitle` /
 * `deriveConsolidationSubject`) — the load-bearing logic, including every
 * edge case in the issue — and an end-to-end check that the consolidation
 * still produces a real commit on the branch so the derived subject lands.
 */

import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { consolidateWorktreesToBranch } from "../src/work-driver-handoff-consolidate.ts";
import {
  deriveConsolidationSubject,
  parseConventionalTitle,
} from "../src/work-driver-handoff-subject.ts";
import type { WorkState } from "../src/workflow-state.ts";

let exit = 0;
function assert(cond: boolean, msg: string) {
  if (cond) console.log(`✓ ${msg}`);
  else {
    console.error(`✗ ${msg}`);
    exit = 1;
  }
}

// ---------------------------------------------------------------------------
// 1. parseConventionalTitle: extract type/scope/description from a title that
//    begins with a conventional-commit prefix; report "no prefix" otherwise.
// ---------------------------------------------------------------------------
{
  const p1 = parseConventionalTitle(
    "fix(work): restore repoRoot when a lens-fix integration fails",
  );
  assert(p1.type === "fix", "parse: type is 'fix' for a fix(work) title");
  assert(p1.scope === "work", "parse: scope is 'work' for a fix(work) title");
  assert(
    p1.description === "restore repoRoot when a lens-fix integration fails",
    `parse: description is the text after the prefix (got "${p1.description}")`,
  );
  assert(p1.breaking === false, "parse: no breaking marker for a plain fix title");

  const p2 = parseConventionalTitle("feat: add a brand-new worktree sweep");
  assert(p2.type === "feat", "parse: type is 'feat' for a bare feat title");
  assert(p2.scope === undefined, "parse: no scope for a bare feat title");

  const p3 = parseConventionalTitle("How do I configure the sandbox?");
  assert(p3.type === null, "parse: a question-titled issue has no conventional type");

  // #818 — 'spike' IS now a recognised plan-driver prefix (plan-types.ts's
  // TITLE_PREFIX emits `research: ` for spikes; `spike:` is the human-filed
  // variant). #810 asserted `type === null` because the parser only
  // recognised conventional types; #818 extends the parser to the full
  // plan-driver vocabulary, so `spike:` now parses (bare `spike`) and the
  // MAPPING to an honest `chore` happens in deriveConsolidationSubject
  // (PLAN_DRIVER_PREFIXES.spike === "chore" — asserted in section 2).
  const p4 = parseConventionalTitle("spike: explore the dispatch deck");
  assert(
    p4.type === "spike",
    "parse: 'spike' is a recognised plan-driver prefix (bare 'spike', #818)",
  );

  const p5 = parseConventionalTitle("fix(handoff): label the issue as well as the PR");
  assert(p5.type === "fix", "parse: type is 'fix' for fix(handoff)");
  assert(p5.scope === "handoff", "parse: scope is 'handoff' for fix(handoff)");

  const p6 = parseConventionalTitle("feat!: replace the dispatch deck");
  assert(p6.type === "feat", "parse: type is 'feat' for feat!");
  assert(p6.breaking === true, "parse: breaking marker captured for feat!");
}

// ---------------------------------------------------------------------------
// 2. deriveConsolidationSubject: the full derivation, mapping each edge case
//    to its honest output.
// ---------------------------------------------------------------------------
{
  // The #810 incident shape: a real fix with a fix(work) title must NOT land
  // as chore(handoff): — it must carry the fix type so release-please bumps.
  const s1 = deriveConsolidationSubject(
    "fix(work): restore repoRoot when a lens-fix integration fails",
  );
  assert(
    s1 === "fix(work): restore repoRoot when a lens-fix integration fails",
    `derive: a fix(work) title preserves the fix type (got ${JSON.stringify(s1)})`,
  );
  assert(
    s1 !== undefined && !s1.startsWith("chore"),
    "derive: the incident shape is NOT labelled chore",
  );

  // A feat with a scope keeps it; release-please bump type preserved.
  const s2 = deriveConsolidationSubject("feat(review): add per-lens retry");
  assert(
    s2 === "feat(review): add per-lens retry",
    `derive: feat(review) preserved (got ${JSON.stringify(s2)})`,
  );

  // #818 — a conventional type passes through as ITSELF, including the
  // non-bumping types (#810 collapsed `test:`/`ci:`/`chore:` to `chore`;
  // #818's commit-pr path needs the honest type instead, so the shared
  // parser passes the full conventional vocabulary through). The #810
  // assertion that pinned the collapse was updated to pin the pass-through:
  // the subject still starts with `chore`-class honesty for a non-bumping
  // type in that the type is preserved verbatim rather than relabelled.
  const s3 = deriveConsolidationSubject("test: add a regression test for the sweep");
  assert(
    s3 === "test(work): add a regression test for the sweep",
    `derive: a non-bumping conventional type passes through as itself (#818; got ${JSON.stringify(s3)})`,
  );
  assert(!s3.startsWith("fix"), "derive: non-bumping type is NOT relabelled fix");

  // #818 — the full conventional vocabulary passes through as itself.
  const s3a = deriveConsolidationSubject("chore: tidy the scratch dir");
  assert(
    s3a === "chore(work): tidy the scratch dir",
    `derive: chore: passes through as chore (got ${JSON.stringify(s3a)})`,
  );
  const s3b = deriveConsolidationSubject("docs: write the troubleshooting entry");
  assert(
    s3b === "docs(work): write the troubleshooting entry",
    `derive: docs: passes through as docs (got ${JSON.stringify(s3b)})`,
  );
  const s3c = deriveConsolidationSubject("ci: harden the verify gate");
  assert(
    s3c === "ci(work): harden the verify gate",
    `derive: ci: passes through as ci (got ${JSON.stringify(s3c)})`,
  );

  // A question title maps to no type → honest chore, with the title as description.
  const s4 = deriveConsolidationSubject("How do I configure the sandbox?");
  assert(
    s4 === "chore(work): How do I configure the sandbox?",
    `derive: a question title is an honest chore with the title as description (got ${JSON.stringify(s4)})`,
  );

  // A 'spike' title has no clean mapping → honest chore, not an invented fix.
  const s5 = deriveConsolidationSubject("spike: explore the dispatch deck");
  assert(
    s5.startsWith("chore"),
    `derive: a spike title is an honest chore (got ${JSON.stringify(s5)})`,
  );
  assert(!s5.startsWith("fix"), "derive: a spike title is NOT an invented fix");

  // A scope-less bumping type gets the driver's `work` scope.
  const s6 = deriveConsolidationSubject("fix: restore the branch after a conflict");
  assert(
    s6 === "fix(work): restore the branch after a conflict",
    `derive: a bare fix gets the 'work' scope (got ${JSON.stringify(s6)})`,
  );

  // An issue number can never land in the scope position.
  assert(
    s6 !== undefined && !s6.includes("(810)"),
    "derive: no issue number in the scope position",
  );

  // A breaking marker present in the title survives; one is never ADDED.
  const s7 = deriveConsolidationSubject("feat!: replace the dispatch deck");
  assert(
    s7 === "feat!(work): replace the dispatch deck",
    `derive: a '!' breaking marker is preserved (got ${JSON.stringify(s7)})`,
  );
  assert(!s7.includes("!!"), "derive: no double '!' marker");

  // No breaking marker is introduced for a plain title.
  assert(s1 !== undefined && !s1.includes("!"), "derive: no breaking marker is introduced");

  // An empty title produces no subject (the caller keeps the old chore line).
  assert(deriveConsolidationSubject("") === undefined, "derive: an empty title yields no subject");
  assert(
    deriveConsolidationSubject("   ") === undefined,
    "derive: a whitespace title yields no subject",
  );

  // -----------------------------------------------------------------------
  // #818 — plan-driver prefixes (TITLE_PREFIX in plan-types.ts) map to the
  // type the change actually ships; unknown prefixes stay honest chore.
  // -----------------------------------------------------------------------
  // The #818 incident shape: a plan-driver bug must land as `fix:`, not
  // `chore:` (which release-please drops) and not a raw `Bug: …`.
  const s8 = deriveConsolidationSubject("Bug: test-cancel.ts is timing-flaky in the offline suite");
  assert(
    s8 === "fix(work): test-cancel.ts is timing-flaky in the offline suite",
    `derive: 'Bug:' maps to fix (got ${JSON.stringify(s8)})`,
  );
  assert(!s8?.startsWith("chore"), "derive: a Bug: title is NOT an honest chore");

  // Lowercase 'bug' (the case-insensitive shape a human might file).
  const s9 = deriveConsolidationSubject("bug: the queue halts on one dead cycle");
  assert(
    s9 === "fix(work): the queue halts on one dead cycle",
    `derive: lowercase 'bug' maps to fix (got ${JSON.stringify(s9)})`,
  );

  // Feature: (capitalised) maps to feat, like feat:.
  const s10 = deriveConsolidationSubject("Feature: add a brand-new worktree sweep");
  assert(
    s10 === "feat(work): add a brand-new worktree sweep",
    `derive: 'Feature:' maps to feat (got ${JSON.stringify(s10)})`,
  );

  // EPIC: maps to feat — an epic ships features.
  const s11 = deriveConsolidationSubject("EPIC: overhaul the dispatch deck");
  assert(
    s11 === "feat(work): overhaul the dispatch deck",
    `derive: 'EPIC:' maps to feat (got ${JSON.stringify(s11)})`,
  );

  // research:/spike: map to an honest chore — research is not a feature.
  const s12 = deriveConsolidationSubject("research: sandbox landscape survey");
  assert(
    s12 === "chore(work): sandbox landscape survey",
    `derive: 'research:' maps to chore (got ${JSON.stringify(s12)})`,
  );
  assert(!s12?.startsWith("feat"), "derive: a research title is NOT relabelled feat");

  // A conventional prefix with a scope + the plan-driver prefix is
  // mutually exclusive by construction: 'Bug' is not conventional, so no
  // 'Bug(spawn):' shape exists to worry about. But an explicit scope on a
  // plan-driver prefix is still parsed and honoured when alphabetic.
  const s13 = deriveConsolidationSubject("Bug(spawn): the child hangs on macOS");
  assert(
    s13 === "fix(spawn): the child hangs on macOS",
    `derive: 'Bug(spawn):' keeps the alphabetic scope (got ${JSON.stringify(s13)})`,
  );

  // Genuinely unknown prefix → honest chore with the title as description.
  const s14 = deriveConsolidationSubject("Urgent: the queue halts on one dead cycle");
  assert(
    s14 === "chore(work): Urgent: the queue halts on one dead cycle",
    `derive: an unknown prefix is an honest chore with the full title (got ${JSON.stringify(s14)})`,
  );
  assert(!s14?.startsWith("fix"), "derive: an unknown prefix is NOT an invented fix");

  // parseConventionalTitle now recognises the plan-driver prefixes too
  // (returned bare lowercase; the mapping is deriveConsolidationSubject's).
  const p7 = parseConventionalTitle("Bug: test-cancel.ts is flaky");
  assert(p7.type === "bug", "parse: 'Bug' is recognised as a plan-driver prefix (bare 'bug')");
  const p8 = parseConventionalTitle("EPIC: overhaul the deck");
  assert(p8.type === "epic", "parse: 'EPIC' is recognised (bare 'epic', lowercased)");
  const p9 = parseConventionalTitle("research: sandbox survey");
  assert(p9.type === "research", "parse: 'research' is recognised as a plan-driver prefix");
}

// ---------------------------------------------------------------------------
// 3. End-to-end: the consolidation still produces a real commit on the branch
//    when there is work to move, so the derived subject (asserted above) is
//    what lands. PI_ENSEMBLE_FORGE=none makes the subject-derivation skip the
//    gh fetch and fall back to the honest chore line, so this deterministic
//    git test asserts the mechanics (a commit is made), not the live-title
//    path (covered by the pure-derivation assertions in 1/2).
// ---------------------------------------------------------------------------
{
  const dir = mkdtempSync(join(tmpdir(), "issue810-subject-"));
  const wt = join(dir, ".worktrees", "issue-810-task-a");
  try {
    mkdirSync(join(dir, ".worktrees"), { recursive: true });
    const g = (args: string[], cwd = dir) => execFileSync("git", args, { cwd }).toString().trim();
    g(["init", "-b", "main"]);
    g(["config", "user.name", "t"]);
    g(["config", "user.email", "t@t"]);
    g(["commit", "--allow-empty", "-m", "base"]);
    g(["worktree", "add", "--detach", wt, "HEAD"]);
    // A real (non-empty) change in the worktree so the staged diff is non-empty.
    writeFileSync(join(wt, "change.txt"), "content\n");
    g(["add", "-A"], wt);
    g(["commit", "-m", "w: real change"], wt);
    const baseSha = g(["rev-list", "--max-parents=0", "HEAD"]);

    const state = {
      issue: 810,
      schemaVersion: 1,
      resumable: false,
      startedAt: 1,
      updatedAt: 2,
      pipelineState: {
        status: "handoff",
        currentStep: "handoff",
        lastCompletedStep: "develop",
        reviewRound: 0,
        ciRetryCount: 0,
        inFlightJobIds: [],
        branchName: "feature/issue-810",
        baseSha,
        worktrees: { "task-a": wt },
      },
      eventLog: [
        {
          kind: "cap-hit",
          at: 3,
          cap: "verify-failed:develop",
          reviewRound: 0,
          nextStep: "handoff",
        },
      ],
      // biome-ignore lint/suspicious/noExplicitAny: partial fixture
    } as any;
    const saved = process.env.PI_ENSEMBLE_FORGE;
    process.env.PI_ENSEMBLE_FORGE = "none";
    const result = await consolidateWorktreesToBranch(
      { repoRoot: dir, issue: 810, scratchDir: dir },
      state,
    );
    if (saved === undefined) process.env.PI_ENSEMBLE_FORGE = undefined;
    else process.env.PI_ENSEMBLE_FORGE = saved;
    assert(result.ok, `e2e: consolidation succeeds on the real repo (reason=${result.reason})`);
    let aheadOnBranch = -1;
    try {
      aheadOnBranch = Number.parseInt(g(["rev-list", "--count", "main..feature/issue-810"]), 10);
    } catch {
      aheadOnBranch = -1;
    }
    assert(
      aheadOnBranch === 1,
      `e2e: exactly one consolidation commit landed on the branch (got ${aheadOnBranch})`,
    );
  } finally {
    try {
      execFileSync("git", ["worktree", "remove", "--force", wt], { cwd: dir });
    } catch {
      /* worktree already gone */
    }
    rmSync(dir, { recursive: true, force: true });
  }
}

console.log(`\nexit ${exit}`);
process.exit(exit);
