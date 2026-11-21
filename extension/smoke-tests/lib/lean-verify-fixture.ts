/**
 * lib/lean-verify-fixture — the harness the `lean/verify` smoke tests share.
 *
 * `verify`'s claims are git claims plus process-exit claims, so both are real
 * here: a temp git repo whose HEAD holds the frozen acceptance test, real `git`
 * probes, and real `sh` processes for the tiers and the frozen test runs. Only
 * the project's CONFIG is injected — a case that wants a tier to exit 1 must not
 * have to rewrite a commit the frozen records were hashed at to ask for one.
 *
 * This module builds its own repo rather than reusing `lean-build-fixture`'s
 * `buildFixture`, for one reason: that helper checks the run's branch out in
 * `repoRoot` too (`-B`), and a worktree whose HEAD the case moves must hold the
 * branch alone. The shape is otherwise the same — base commit, acceptance-test
 * commit, registered worktree — and the frozen sha256 in the step log is the one
 * the committed blob really hashes to, so the tamper cases have to break a real
 * byte to be red.
 *
 * A case mutates the tree BEFORE the step looks at it — editing a frozen file on
 * disk, committing a rewrite of the frozen blob at HEAD, dropping a stray file —
 * and the step then judges the result. That order is the whole point: `verify`
 * is asked "is this the tree that was frozen?", and the only way to show it
 * reads bytes rather than vibes is to change the bytes.
 */

import { chmodSync, mkdirSync, mkdtempSync, realpathSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { execp } from "../../src/exec.ts";
import type { WorkConfig } from "../../src/lean/config.ts";
import type { HandlerCtx } from "../../src/lean/engine.ts";
import { type Outcome, type Step, createRun } from "../../src/lean/state.ts";

import type { VerifyDeps } from "../../src/lean/verify-deps.ts";
import {
  DETACH_TIER,
  HANG_TIER,
  PASS_TIER,
  failTier,
  flakeTier,
  killOnSecondTier,
  pytestFailTier,
  writeTier,
} from "./lean-verify-tiers.ts";
export {
  DETACH_TIER,
  HANG_TIER,
  PASS_TIER,
  failTier,
  flakeTier,
  killOnSecondTier,
  pytestFailTier,
  writeTier,
} from "./lean-verify-tiers.ts";
import { canonicalProbeDir, makeVerifyExec } from "./lean-verify-exec.ts";
import { FROZEN_FILE } from "./lean-verify-frozen.ts";
// The handback step-log builders live in `lean-verify-handback-log.ts`: a case that only needs a
// log should not provision a repo to get one. Re-exported so every case still imports the harness
// from this module.
export {
  type HandbackPost,
  decided,
  handbackCtx,
  publishStep,
  redLog,
} from "./lean-verify-handback-log.ts";
// The repo builders (a real repo at its frozen head, its registered worktree, the project-test
// stub the roster enumerates) live in `lean-verify-repo.ts`; this module runs the step against
// what they build.
import {
  buildFixtureForWiring,
  commitHere,
  fixture,
  fixtureSync,
} from "./lean-verify-repo.ts";
export { buildFixtureForWiring };
import { type Fixture, provisionHookedTree } from "./lean-verify-hook-tree.ts";
import {
  rosterCommandFor,
  rosterSideNames,
  rosterTemplate,
  rosterTestFiles,
} from "./lean-verify-roster.ts";
import type { VerifyOpts, VerifyRun } from "./lean-verify-types.ts";

/** The shapes a verify case is configured with and answers with, re-exported here so a
 * case imports the whole harness from one module. */
export type { VerifyOpts, VerifyRun };

/** Temp dirs the harness made; the caller removes them at the end of the run. */
export { ROOTS };

/**
 * The frozen-test and runner-helper bytes, re-exported so a case imports the whole
 * harness from one module. They live in `lean-verify-bytes.ts` with the reason each
 * body has to take the shape it does.
 */
export {
  GREEN_TEST,
  NAMING_RUNNER_FILE,
  NAMING_RUNNER_SCRIPT,
  NAMING_RUNNER_TEMPLATE,
  RED_ACCEPTANCE_TEST,
  RED_BASE_TEST,
  SILENT_RUNNER_FILE,
  SILENT_RUNNER_SCRIPT,
  SILENT_RUNNER_TEMPLATE,
  SRC,
  TEST,
  commitFrozenFiles,
} from "./lean-verify-bytes.ts";
import { ROSTER_REPORT_FILE } from "../../src/lean/verify-roster-command.ts";
import {
  NAMING_RUNNER_FILE,
  NAMING_RUNNER_SCRIPT,
  NAMING_RUNNER_TEMPLATE,
  RED_ACCEPTANCE_TEST,
  RED_BASE_TEST,
  SILENT_RUNNER_FILE,
  SILENT_RUNNER_SCRIPT,
  SILENT_RUNNER_TEMPLATE,
  SRC,
  TEST,
  commitFrozenFiles,
} from "./lean-verify-bytes.ts";
import { ROOTS, fixtureGitEnv, git, sha } from "./lean-verify-git.ts";

export { git, sha };

/** Run `verify` against a fixture repo; a throw comes back as `threw`. */
export async function runVerify(opts: VerifyOpts): Promise<VerifyRun> {
  // Each declared pre-existing test file is committed at the BASE as a script reporting the names
  // this case declared for the BASE run — which is what makes "pre-existing" a fact the case states
  // once and both trees then honour, rather than one the harness invents at read time.
  const rosterFiles = rosterTestFiles(opts);
  const f = await fixture(
    opts.issue,
    opts.baseRedContract === true,
    opts.hookAtBase,
    opts.frozenText,
    opts.extraFrozen ?? {},
    rosterFiles,
    opts.baseProjectTestFails === true,
    opts.roster?.baseMissingDeps !== undefined,
    opts.roster?.baseMissingDeps,
  );

  const wt = f.wt;
  const repoRoot = f.repoRoot;
  const probeDir = canonicalProbeDir(repoRoot, opts.issue);

  if (opts.implement === true && opts.editDisk === undefined) {
    // The green cases COMMIT their work, so the tree the step judges is clean.
    writeFileSync(path.join(wt, "src/DONE"), "done\n");
    git(wt, "add", "src/DONE");
    commitHere(wt, "feat: implemented the retry helper");
  }
  if (opts.editAtHead !== undefined) {
    // The freeze is the fixture's own commit, hashed into the log's record; this
    // rewrite lands AFTER it, so HEAD's blob no longer matches the record while
    // the working tree stays clean. Only a read of the commit can see it.
    writeFileSync(path.join(wt, FROZEN_FILE), opts.editAtHead, { mode: 0o755 });
    chmodSync(path.join(wt, FROZEN_FILE), 0o755);
    commitHere(wt, "chore: rewrote the frozen test after the freeze");
  }
  if (opts.editDisk !== undefined) {
    // The on-disk tamper case: the frozen file is edited and NOTHING else is
    // dirty, so the only thing standing between this run and a tier pass is the
    // on-disk comparison. The marker the contract asks for is committed here —
    // uncommitted, it would trip the clean-tree refusal before the tamper was
    // ever reached, and the case would prove nothing.
    if (opts.implement === true) {
      writeFileSync(path.join(wt, "src/DONE"), "done\n");
      commitHere(wt, "feat: implemented the retry helper");
    }
    writeFileSync(path.join(wt, FROZEN_FILE), opts.editDisk, { mode: 0o755 });
  }
  if (opts.dirty === true) writeFileSync(path.join(wt, "notes.txt"), "a stray file\n");

  // The run EDITS these pre-existing test files: their HEAD bytes become the case's text, committed,
  // so the tree is clean and the roster must run each file's BASE version against the head code.
  // Bench cell 2's shape, made of real commits rather than of a stub's say-so.
  if (opts.editProjectTests !== undefined) {
    for (const [rel, text] of Object.entries(opts.editProjectTests)) {
      writeFileSync(path.join(wt, rel), text, { mode: 0o755 });
      chmodSync(path.join(wt, rel), 0o755);
    }
    commitHere(wt, "test: the run rewrote an existing test's expectation");
  }

  const head = git(wt, "rev-parse", "HEAD");
  // The tier commands this case configured, as strings: a tier runs as a shell
  // command, so the only thing that identifies one to the executor is its own text.
  const configured: Partial<WorkConfig["verify"]> =
    opts.noCommand === true ? {} : (opts.config ?? { fast: PASS_TIER });
  if (opts.full !== undefined) configured.full = opts.full;
  const tiers: string[] = [configured.fast, configured.full].filter(
    (c): c is string => typeof c === "string" && c.trim() !== "",
  );
  if (opts.silentRunner === true) {
    // Committed before `head` is read: the step refuses a dirty tree before it
    // ever runs a test, so a helper left untracked would trip that first, and the
    // frozen file itself is untouched, so no tamper is mistaken for this.
    writeFileSync(path.join(wt, SILENT_RUNNER_FILE), SILENT_RUNNER_SCRIPT, { mode: 0o755 });
    commitHere(wt, "chore: fixture runner that stays silent");
  }
  if (opts.alwaysRedFrozen === true) {
    // The same rule as the silent helper above: committed, and committed before
    // `head` is read, so the tree the step judges is clean.
    writeFileSync(path.join(wt, NAMING_RUNNER_FILE), NAMING_RUNNER_SCRIPT, { mode: 0o755 });
    commitHere(wt, "chore: fixture runner that names its failing test");
  }
  // The log's frozen record is the bytes the FREEZE committed. A case that
  // rewrote the file on disk or at HEAD afterwards faces a record that no
  // longer matches, which is exactly the tamper the step must catch.
  const all = opts.extraSteps === undefined ? f.ctx.steps : [...f.ctx.steps, ...opts.extraSteps];
  const ctx: HandlerCtx = { ...f.ctx, steps: all };
  ctx.run = { ...ctx.run, steps: all };

  const { exec, redRunsSeen, baseTierRunsSeen, frozenRunsSeen, rosterRunsSeen } = makeVerifyExec({
    wt,
    probeDir,
    repoRoot,
    tiers,
    opts,
    baseSha: f.ctx.run.baseSha,
    ...(opts.hookAtBase === undefined ? {} : { hookMarks: opts.hookAtBase.marksDir }),
    // The roster's project suite reaches the executor in argv form, so the stub needs the
    // command's binary to tell that call from a frozen run's `sh <file>`.
    rosterCmd: rosterCommandFor({ roster: rosterTemplate(opts, configured) }),
    // What each side's report says. The default is one test that passes in BOTH trees; a case
    // declares names to ask for a red, a missing report, or a test that only the base ran.
    rosterNames: {
      head: rosterSideNames(opts, "head"),
      base: rosterSideNames(opts, "base"),
    },
  });

  const deps: VerifyDeps = {
    exec,
    loadConfig: async () => ({
      verify: {
        ...configured,
        // The roster's inventory comes from the config pair, so a case that declares pre-existing
        // tests has to say where they live — the same `testDir`/`testGlob` the real loader reads at
        // the base commit. Absent, the roster cannot enumerate anything and the step hands back.
        roster: rosterTemplate(opts, configured),
        testDir: opts.testDir ?? "tests",
        testGlob: opts.testGlob ?? "test-*.sh",
        // A case that wants the ROSTERLESS hand-back takes the pair away, as a project that
        // configured no test location would.
        ...(opts.noTestLocation === true ? { testDir: undefined, testGlob: undefined } : {}),
        test:
          opts.frozenRunner ??
          (opts.silentRunner === true
            ? SILENT_RUNNER_TEMPLATE
            : opts.alwaysRedFrozen === true
              ? NAMING_RUNNER_TEMPLATE
              : "sh {file}"),
      },
    }),
    readVerifyCmd: async () => undefined,
    // The lean contract lives in the issue body, and the verify gate now reads it
    // through this seam for its `command` criteria. A fixture case whose body
    // carries no `pi-spec` block is the ordinary "the spec asked for nothing"
    // shape, so the tier runs no criteria and the case judges only what it asked.
    fetchIssueBody: async () => opts.specBody ?? "",
    ...(opts.timeoutMs === undefined ? {} : { timeoutMs: opts.timeoutMs }),
  };
  try {
    const { verifyOutcome } = await import("../../src/lean/verify.ts");
    return {
      outcome: await verifyOutcome(ctx, deps),
      worktree: wt,
      head,
      probeDir,
      repoRoot,
      tierRuns: redRunsSeen(),
      baseTierRuns: baseTierRunsSeen(),
      frozenRuns: frozenRunsSeen(),
      rosterRuns: rosterRunsSeen(),
      baseSha: f.ctx.run.baseSha,
    };
  } catch (err) {
    return {
      threw: err as Error,
      worktree: wt,
      head,
      probeDir,
      repoRoot,
      tierRuns: redRunsSeen(),
      baseTierRuns: baseTierRunsSeen(),
      frozenRuns: frozenRunsSeen(),
      rosterRuns: rosterRunsSeen(),
      baseSha: f.ctx.run.baseSha,
    };
  }
}
