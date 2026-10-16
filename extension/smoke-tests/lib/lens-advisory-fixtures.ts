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
 */

import { execSync } from "node:child_process";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import path from "node:path";
import type { LensRunResult } from "../../src/lens-review-types.ts";
import { LENS_ROSTER } from "../../src/lens-roster.ts";

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
  /** The `runLensReview` options every round in the suite shares. */
  common: Record<string, unknown>;
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
  process.env.PI_ENSEMBLE_REVIEW_LEDGER_FILE = ledgerFile;
  process.env.PI_ENSEMBLE_SKILLS_DIR = skills;

  const sh = (cmd: string): string =>
    execSync(cmd, { cwd: repo, encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).trim();
  sh("git init -q -b main");
  sh("git config user.email dev@example.com");
  sh("git config user.name dev");
  writeFileSync(path.join(repo, "src", "a.ts"), lines(10, "a"));
  writeFileSync(path.join(repo, "src", "other.ts"), lines(10, "other"));
  sh("git add -A");
  sh("git commit -qm base");
  execSync(`git init -q --bare -b main ${path.join(root, "remote.git")}`);
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
    common: {
      cwd: repo,
      branch: "feat/x",
      head: "feat/x",
      diff: CHANGED_LINE_DIFF,
      lensChildFn: stubLens as never,
    },
  };
}
