/**
 * review-findings-fixtures — the setup the review-findings smoke tests share
 * (#1125 cleanup). Four files used to carry byte-identical copies of it: a temp
 * clone, a skills dir with one installed `code-review-*` skill per lens, a
 * private ledger dir (so a test never writes the real per-clone ledger — the
 * rule `test-ledger-isolation.ts` enforces), and a stub lens child that reports
 * whatever the scenario asks of the FIRST lens while every other lens answers
 * with a prose summary so the round counts as complete.
 *
 * The duplication was not cosmetic: the ledger-isolation marker and the
 * "first lens reports, the rest are complete" convention are the two things a
 * copied setup gets subtly wrong, and a stub that lets a lens return in silence
 * makes the round INCOMPLETE rather than clean — which silently changes what the
 * scenario proves.
 *
 * Everything is offline: no Pi child is spawned (`lensChildFn` is always
 * injected), and the ledger is redirected to a temp dir via
 * `PI_ENSEMBLE_REVIEW_LEDGER_FILE`.
 *
 * ⚠ That redirect is a PROCESS env var, so a second fixture started while a
 * first is still in use steals it, and the first fixture's later writes resolve
 * against the second clone ("not a git clone"). `cleanup()` restores the value
 * that was set before this fixture started, so tests that need a second
 * fixture either finish the first one first, or restore in a `finally`.
 */

import { execSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import type { LensRunResult } from "../../src/lens-review-types.ts";
import { LENS_ROSTER } from "../../src/lens-roster.ts";
import type { FindingRun } from "../../src/review-findings-store.ts";
import { recordFindingRunOutcome } from "../../src/review-findings-store.ts";

/** A finding a stub lens reports; `lens` is filled in by the stub. */
export interface StubFinding {
  severity: string;
  path: string;
  line?: number;
  title: string;
  description?: string;
  lens?: string;
}

/** What a stubbed round reports, and how complete it is. */
export interface StubState {
  /** The findings the FIRST roster lens reports each round. */
  report: () => StubFinding[];
  /** When true, every lens but the first is blocked: the round is incomplete. */
  blockNonFirst?: () => boolean;
}

export interface ReviewFixture {
  /** The temp clone (a real git repo, one commit on `main` unless noted). */
  repo: string;
  /** The dir holding the ledger and, beside it, `review-findings.json`. */
  ledgerDir: string;
  /** Absolute path of the ledger file (the isolation marker). */
  ledgerFile: string;
  /** Run one git command inside `repo` and return trimmed stdout. */
  sh: (cmd: string) => string;
  /** The stub lens spawner to pass to `runLensReview` as `lensChildFn`. */
  stubLens: unknown;
  /** Findings a COMPLETE round's lens prompt receives as the prior block. */
  seenPrior: string[];
  /** Remove the temp root. Call from a `finally`. */
  cleanup: () => void;
}

/** Write the installed-skills dir: one valid SKILL.md per expected lens. */
function installLensSkills(skills: string): void {
  let prec = 10;
  for (const l of LENS_ROSTER) {
    mkdirSync(path.join(skills, l.skill), { recursive: true });
    writeFileSync(
      path.join(skills, l.skill, "SKILL.md"),
      `---\nname: ${l.skill}\nprecedence: ${prec}\n---\n`,
    );
    prec += 10;
  }
}

/**
 * Build the shared fixture: a temp root holding the clone, the skills dir and
 * the ledger dir, with the process env pointed at the private ledger and skills.
 *
 * `files` are written (and committed) before the base commit; `branch` is the
 * branch the clone starts on (a plain `git init -b`, so tests that need a
 * `main` + feature-branch pair create the extra branch themselves).
 */
export function setupReviewFixture(opts: {
  /** Prefix for the mkdtemp root name. */
  prefix: string;
  /** Repo-relative file contents committed as the base commit. */
  files: Record<string, string>;
  /** The initial branch name. */
  branch?: string;
  /** The findings the first lens reports, read fresh each round. */
  report: () => StubFinding[];
  /** When set true, all lenses but the first are blocked (an incomplete round). */
  blockNonFirst?: () => boolean;
  /** Install the six lens skills and set PI_ENSEMBLE_SKILLS_DIR (default true). */
  withSkills?: boolean;
}): ReviewFixture {
  const root = mkdtempSync(path.join(os.tmpdir(), `${opts.prefix}-`));
  // What the two process env vars were before this fixture, so cleanup() can
  // undo BOTH: a leaked PI_ENSEMBLE_SKILLS_DIR points a later test at a skills
  // dir this fixture has already removed.
  const savedLedger = process.env.PI_ENSEMBLE_REVIEW_LEDGER_FILE;
  const savedSkills = process.env.PI_ENSEMBLE_SKILLS_DIR;
  const repo = path.join(root, "repo");
  const skills = path.join(root, "skills");
  const ledgerDir = path.join(root, "ledger");
  const ledgerFile = path.join(ledgerDir, "review-ledger.json");
  mkdirSync(repo);
  mkdirSync(ledgerDir);
  if (opts.withSkills !== false) installLensSkills(skills);
  // The ledger-isolation marker: the findings file lives beside the ledger, so
  // an absolute override keeps every fixture write out of the real clone's .git.
  process.env.PI_ENSEMBLE_REVIEW_LEDGER_FILE = ledgerFile;
  if (opts.withSkills !== false) process.env.PI_ENSEMBLE_SKILLS_DIR = skills;

  const sh = (cmd: string) =>
    execSync(cmd, { cwd: repo, encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).trim();
  sh(`git init -q -b ${opts.branch ?? "main"}`);
  sh("git config user.email dev@example.com");
  sh("git config user.name dev");
  for (const [rel, body] of Object.entries(opts.files)) {
    const target = path.join(repo, rel);
    mkdirSync(path.dirname(target), { recursive: true });
    writeFileSync(target, body);
  }
  sh("git add -A");
  sh("git commit -qm base");

  const seenPrior: string[] = [];
  const stubLens = async (args: {
    lens: { name: string };
    opts: { priorFindings?: string };
  }): Promise<LensRunResult> => {
    seenPrior.push(args.opts.priorFindings ?? "");
    const first = args.lens.name === LENS_ROSTER[0]?.name;
    const blocked = !first && (opts.blockNonFirst?.() ?? false);
    const reported = first && !blocked ? opts.report() : [];
    return {
      lens: args.lens.name,
      ok: !blocked,
      ms: 1,
      startMs: Date.now(),
      attempts: 1,
      blocked,
      // Every lens answers with prose: a lens that returns in silence makes the
      // round INCOMPLETE, which is a different scenario than these tests assert.
      summary: blocked ? "" : "reviewed the diff",
      findings: reported.map((f) => ({ lens: args.lens.name, ...f })),
    } as unknown as LensRunResult;
  };

  return {
    repo,
    ledgerDir,
    ledgerFile,
    sh,
    stubLens,
    seenPrior,
    cleanup: () => {
      rmSync(root, { recursive: true, force: true });
      if (savedLedger === undefined) delete process.env.PI_ENSEMBLE_REVIEW_LEDGER_FILE;
      else process.env.PI_ENSEMBLE_REVIEW_LEDGER_FILE = savedLedger;
      if (savedSkills === undefined) delete process.env.PI_ENSEMBLE_SKILLS_DIR;
      else process.env.PI_ENSEMBLE_SKILLS_DIR = savedSkills;
    },
  };
}

/**
 * Run one round and return its decisions, or undefined when nothing was
 * recorded. The ONE copy of this helper (it used to be pasted into five test
 * files, each drifting a little); a test that needs the outcome's `reason`,
 * `carried` or `setAside` calls `recordFindingRunOutcome` directly.
 */
export async function decide(run: FindingRun) {
  const out = await recordFindingRunOutcome(run);
  return out.ok ? out.decisions : undefined;
}

/** A plausible full-review diff string (the stubs never read it). */
export const FULL_DIFF = "diff --git a/src/a.ts b/src/a.ts\n+++ b/src/a.ts\n+export const a = 1;";

/** The canonical clone's `src/a.ts`: 5 lines, one function, cited line 3. */
export const SRC_A = [
  "// header",
  "export function alpha(x: number) {",
  "  const a = x + 1;",
  "  return a * 2;",
  "}",
];
