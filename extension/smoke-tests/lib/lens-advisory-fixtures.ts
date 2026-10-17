/**
 * lens-review-advisory-fixtures — the clone and the stub lens the #1125
 * advisory suite (`test-lens-review-advisory.ts`) runs against, split out so
 * the test file holds assertions and not scaffolding (the 500-line gate).
 *
 * The clone is deliberately small and its changed lines are KNOWN exactly:
 * `main` holds `src/a.ts` and `src/other.ts` at ten lines each, and `feat/x`
 * appends ONE line to `src/a.ts` — so line 11 of that file is the only line
 * the PR changed, and no line of `src/other.ts` is. A fixture that "makes a
 * repo" and leaves the range implicit is what makes an advisory test wrong: the
 * whole point is knowing whether a cited line is inside the range or not.
 *
 * A bare remote with a `main` exists so the ledger writer can compute a patch
 * id and so `origin/main` resolves — the split's fallback range read needs a
 * mainline when the caller named no base.
 *
 * The stub lens reports whatever `report` holds (the round's FRESH findings)
 * and nothing else; the carried half of the round's list comes from the
 * findings store, seeded by the caller through the shared `seedFindings` seam.
 *
 * The builder sets the two env vars the review reads (`PI_ENSEMBLE_REVIEW_LEDGER_FILE`
 * and `PI_ENSEMBLE_SKILLS_DIR`) and hands back a `restore` that puts BOTH back as
 * it found them — a fixture that leaves them set leaks a ledger path and a skills
 * dir into every later test in the same process.
 *
 * WHY `sh` PASSES AN EXPLICIT `env` AND AN EXPLICIT `HOME` (#1145)
 * ----------------------------------------------------------------
 * Setting `process.env.PI_ENSEMBLE_REVIEW_LEDGER_FILE` is necessary but NOT
 * sufficient, because the builder also shells out through the SYNCHRONOUS
 * `child_process` form, and bun (1.3.12) does not propagate a `process.env`
 * assignment to a synchronous child that is spawned without an `env` option.
 * Measured on this host: after `process.env.FOO = "VALUE"`, async
 * `execFile`/`exec` children DO see `VALUE`, while `execSync`, `execFileSync`
 * and `spawnSync` children do not. So the fixture's own `sh("git init …")` calls
 * ran against the host environment: the isolation dir that
 * lib/verify-loop.sh and lib/git-test-env.ts arrange (an empty `GIT_CONFIG_GLOBAL`
 * and, decisively, a `HOME` with no `.config/git/ignore`) never reached them,
 * and the throwaway clone inherited the operator's global git config.
 *
 * That is what made this suite host-dependent. The review's fire-and-forget
 * ledger write runs `workingTreePatchId` (src/review-ledger.ts), which resolves
 * the identity base through `identityBase` → `resolveMainline` →
 * `git symbolic-ref --short refs/remotes/origin/HEAD`. The fixture pushes
 * `main` and fetches it, but `git fetch` only creates `origin/HEAD` when
 * `init.defaultBranch` is set (git's own hint: "If your project is in this
 * directory, to create origin/HEAD… run git remote set-head") — and that
 * variable lives in the host's global config. Isolated, `symbolic-ref` fails,
 * `resolveMainline` falls through to `gh repo view`, the stub answers `main`,
 * `origin/main` resolves, and the entry lands in the fixture's ledger. Against
 * a host config that sets `init.defaultBranch`, `origin/HEAD` exists, the write
 * takes the first branch, and no row ever appears at `ledgerFile` — the poll in
 * test-lens-review-advisory.ts then throws ENOENT. Same code, opposite verdict,
 * decided by the machine.
 *
 * `gitTestEnv()` is threaded into every `sh` call so the fixture's git view is
 * the isolated one however the call is transported, and `sh` additionally
 * re-applies `HOME` from `os.homedir()` afterwards: bun snapshots `homedir()`
 * at process start, so the real home stays reachable to a fixture that needs
 * it even while its git children run isolated (the same trade-off
 * lib/git-test-env.ts documents for the ambient env).
 */

import { execSync } from "node:child_process";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import path from "node:path";
import type { LensRunResult } from "../../src/lens-review-types.ts";
import { LENS_ROSTER } from "../../src/lens-roster.ts";
import { gitTestEnv } from "./git-test-env.ts";

/** One seeded/stub finding as the test states it. */
export type Raw = { severity: string; path: string; line: number; title: string };

export interface AdvisoryFixture {
  /** The temp dir holding the clone, the skills dir and the ledger. */
  root: string;
  repo: string;
  ledgerFile: string;
  /** The full SHA `feat/x` sits at — the head every range names. */
  headSha: string;
  /** Run one git command in the clone (stdout trimmed). */
  sh: (cmd: string) => string;
  /** `report`'s setter: the FRESH findings the stub lens returns this round. */
  setReport: (rows: Raw[]) => void;
  /** The stub `lensChildFn` handed to `runLensReview`. */
  stubLens: (args: { lens: { name: string } }) => Promise<LensRunResult>;
  /** Await the ledger write of the most recent `runLensReview` this suite ran.
   *
   * #1145 — the write is fire-and-forget by contract (#912: the summary is never
   * gated on it), and it runs `git status --porcelain` and two `git diff` reads
   * (`workingTreePatchId`, src/review-ledger.ts) in the SAME clone the test then
   * mutates. A test that goes straight from a review into `git mv`/`git commit`
   * races that writer for `.git/index.lock` and loses about one run in ten with
   * git's "Another git process seems to be running" (status 128). Polling the
   * ledger file is NOT sufficient: the row is written by an atomic rename at the
   * END of the write, but `waitForLedger` returns as soon as the file parses, and
   * the pre-rename `git status` can still be in flight against a file left over
   * from an earlier round. `onLedgerWrite` (the #984 seam) hands back the write's
   * own promise, and awaiting IT is the only thing that proves the writer's git
   * children have finished. It is a test-side side-channel — production still
   * discards the promise, so the fire-and-forget contract is unchanged. */
  awaitLedgerWrite: () => Promise<void>;
  /** `runLensReview` options every round in the suite shares, including the
   * `onLedgerWrite` hook that feeds `awaitLedgerWrite`. */
  common: Record<string, unknown>;
  /** Restore the two env vars this fixture set (a `finally` seam): each one goes
   * back to its exact prior value, including "was not set at all". */
  restore: () => void;
}

/** The diff of the round that changed one line of `src/a.ts` — the value the
 * lenses are handed on a full round, and the string the split parses when the
 * review has one. */
export const CHANGED_LINE_DIFF =
  "diff --git a/src/a.ts b/src/a.ts\n--- a/src/a.ts\n+++ b/src/a.ts\n@@ -8,3 +8,4 @@\n // a 8\n // a 9\n // a 10\n+// changed";

const lines = (n: number, tag: string): string =>
  `${Array.from({ length: n }, (_, i) => `// ${tag} ${i + 1}`).join("\n")}\n`;

export function buildAdvisoryFixture(root: string): AdvisoryFixture {
  const repo = path.join(root, "repo");
  const skills = path.join(root, "skills");
  const ledgerDir = path.join(root, "ledger");
  const ledgerFile = path.join(ledgerDir, "review-ledger.json");
  mkdirSync(path.join(repo, "src"), { recursive: true });
  mkdirSync(ledgerDir);
  // A complete six-lens skills dir, so the roster is healthy and the verdict
  // can never come back REVIEW_INCOMPLETE for a reason unrelated to the split.
  let prec = 10;
  for (const l of LENS_ROSTER) {
    mkdirSync(path.join(skills, l.skill), { recursive: true });
    writeFileSync(
      path.join(skills, l.skill, "SKILL.md"),
      `---\nname: ${l.skill}\nprecedence: ${prec}\n---\n`,
    );
    prec += 10;
  }
  const priorLedger = process.env.PI_ENSEMBLE_REVIEW_LEDGER_FILE;
  const priorSkills = process.env.PI_ENSEMBLE_SKILLS_DIR;
  process.env.PI_ENSEMBLE_REVIEW_LEDGER_FILE = ledgerFile;
  process.env.PI_ENSEMBLE_SKILLS_DIR = skills;

  // The isolation env, merged over the current process env, handed to EVERY git
  // child this builder shells out to — see the module header for why an
  // explicit `env` is required on the synchronous spawn form.
  const gitEnv = gitTestEnv();
  const sh = (cmd: string): string =>
    execSync(cmd, {
      cwd: repo,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
      env: gitEnv,
    }).trim();
  sh("git init -q -b main");
  sh("git config user.email dev@example.com");
  sh("git config user.name dev");
  writeFileSync(path.join(repo, "src", "a.ts"), lines(10, "a"));
  writeFileSync(path.join(repo, "src", "other.ts"), lines(10, "other"));
  sh("git add -A");
  sh("git commit -qm base");
  execSync(`git init -q --bare -b main ${path.join(root, "remote.git")}`, {
    encoding: "utf8",
    env: gitEnv,
  });
  sh(`git remote add origin ${path.join(root, "remote.git")}`);
  sh("git push -q origin main");
  sh("git fetch -q origin");
  sh("git checkout -q -b feat/x");
  // The one changed line is line 11; lines 1-10 of this file are untouched.
  writeFileSync(path.join(repo, "src", "a.ts"), `${lines(10, "a")}// changed\n`);
  sh("git commit -qam change");
  const headSha = sh("git rev-parse HEAD");

  // The lens's own findings for the round (the fresh half of the reported list);
  // the carried half arrives from the findings store.
  let report: Raw[] = [];
  // The most recent round's ledger-write promise (#984 seam), drained once so a
  // second `awaitLedgerWrite()` does not re-await a settled write. Initialised
  // resolved so awaiting before any review is a no-op rather than a hang.
  let pendingWrite: Promise<unknown> = Promise.resolve();
  const drainWrite = (): Promise<void> => {
    const w = pendingWrite;
    pendingWrite = Promise.resolve();
    return w.then(
      () => undefined,
      () => undefined,
    );
  };
  const stubLens = async (args: { lens: { name: string } }): Promise<LensRunResult> =>
    ({
      lens: args.lens.name,
      ok: true,
      ms: 1,
      startMs: Date.now(),
      attempts: 1,
      blocked: false,
      summary: "reviewed the diff",
      findings:
        args.lens.name === LENS_ROSTER[0]?.name
          ? report.map((f) => ({ lens: args.lens.name, ...f }))
          : [],
    }) as unknown as LensRunResult;

  return {
    root,
    repo,
    ledgerFile,
    headSha,
    sh,
    setReport: (rows: Raw[]) => {
      report = rows;
    },
    stubLens,
    // Both vars the fixture set, each back to its exact prior value — `delete`
    // for one that was unset, since assigning `undefined` to process.env stores
    // the string "undefined" rather than removing it.
    restore: () => {
      // `delete` is the only correct "reset to unset": assigning `undefined` to
      // process.env stores the STRING "undefined", which `piSkillsDir()` and the
      // ledger-path getter then treat as a real value (and the next caller's
      // save/restore sees as a set prior).
      // biome-ignore lint/performance/noDelete: delete is the correct "reset to unset"
      if (priorLedger === undefined) delete process.env.PI_ENSEMBLE_REVIEW_LEDGER_FILE;
      else process.env.PI_ENSEMBLE_REVIEW_LEDGER_FILE = priorLedger;
      // biome-ignore lint/performance/noDelete: delete is the correct "reset to unset"
      if (priorSkills === undefined) delete process.env.PI_ENSEMBLE_SKILLS_DIR;
      else process.env.PI_ENSEMBLE_SKILLS_DIR = priorSkills;
    },
    awaitLedgerWrite: drainWrite,
    common: {
      cwd: repo,
      branch: "feat/x",
      head: "feat/x",
      diff: CHANGED_LINE_DIFF,
      lensChildFn: stubLens as never,
      // #984 — capture the fire-and-forget write's promise on every round so the
      // suite can await it before mutating the clone (see `awaitLedgerWrite`).
      onLedgerWrite: (w: Promise<unknown>) => {
        pendingWrite = w;
      },
    },
  };
}

/**
 * Rename `from` to `to` on the branch and return the diff real git computes for
 * `base...HEAD`. The rename-pinning test asserts against git's OWN output on
 * both sides of the rule: a pasted rename diff would pin the fixture's string
 * rather than what `git diff` emits, which is the whole question (a split that
 * trusted `rename from/to` would read a rename as no changed lines, and only
 * real git says what git does). `from` must be a file whose content git can pair
 * byte-for-byte, so rename detection is actually engaged.
 */
export function renameOnBranch(
  fixture: AdvisoryFixture,
  from: string,
  to: string,
  base = "main",
): string {
  fixture.sh(`git mv ${from} ${to}`);
  fixture.sh("git commit -qm rename");
  return fixture.sh(`git diff ${base}...HEAD`);
}
