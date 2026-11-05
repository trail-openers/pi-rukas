/**
 * The shared clone for the #2027 changed-lines tests: a repo whose branch holds
 * `src/a.ts` with the cited line at 3 and a second file nothing cites, plus the
 * two round builders every one of them needs.
 *
 * The four AC files drive the SAME store seam and were each pasting the git
 * setup and the `round()` wrapper (the reason they overflowed the acceptance
 * size cap while testing one sentence each). One fixture, one wrapper, and each
 * test file is left holding only its own scenario.
 */
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import type { FindingRun } from "../../src/review-findings-store.ts";
import { recordFindingRunOutcome } from "../../src/review-findings-store.ts";
import { gitTestEnv } from "./git-test-env.ts";

/** The row-citing file's committed content; line 3 is the cited line. */
export const CITED_FILE = "// header\nexport const a = 1;\nexport const b = 2;\n// trailing\n";
/** The fix, same length: it REWRITES the cited line in place. */
export const FIXED_FILE =
  "// header\nexport const a = 1;\nexport const b = fenceText(value);\n// trailing\n";
/** A delta whose hunk list holds only an unrelated file (the hunk-subtraction shape). */
export const SUBTRACTED_DELTA =
  "diff --git a/src/other.ts b/src/other.ts\n--- a/src/other.ts\n+++ b/src/other.ts\n@@ -1 +1 @@\n-x\n+y\n";
/** The command a HIGH claims to have run, and the round's record of running it (#2040). */
export const REPRO_COMMAND = "bun test";
export const EVIDENCE = new Map([
  ["SIMPLICITY", { toolUses: [{ id: "c1", name: "bash", arguments: { command: REPRO_COMMAND } }] }],
]);

export interface ChangedLinesRepo {
  dir: string;
  /** Run one git command in the clone; returns trimmed stdout. */
  git: (...args: string[]) => string;
  /** Record one round at the clone's current head. */
  round: (
    o: Omit<FindingRun, "cwd" | "branch" | "headSha">,
  ) => ReturnType<typeof recordFindingRunOutcome>;
  cleanup: () => void;
}

/**
 * Build the clone on `feat/x`, one commit ahead of `main`, with the cited file
 * and an uncited one committed. Call `cleanup()` from a `finally`.
 */
export function setupChangedLinesRepo(branch = "feat/x"): ChangedLinesRepo {
  const dir = mkdtempSync(path.join(tmpdir(), "changed-lines-2027-"));
  const env = gitTestEnv();
  const git = (...args: string[]) =>
    execFileSync("git", ["-C", dir, ...args], { env, encoding: "utf8" }).trim();
  const write = (rel: string, body: string) => writeFileSync(path.join(dir, rel), body);
  git("init", "-q", "-b", "main");
  git("config", "user.email", "t@t");
  git("config", "user.name", "t");
  mkdirSync(path.join(dir, "src"), { recursive: true });
  write("src/a.ts", CITED_FILE);
  write("src/other.ts", "x\n");
  git("add", "-A");
  git("commit", "-qm", "base");
  git("checkout", "-qb", branch);
  return {
    dir,
    git,
    round: (o) =>
      recordFindingRunOutcome({
        ...o,
        cwd: dir,
        branch,
        headSha: git("rev-parse", "HEAD"),
      }),
    cleanup: () => rmSync(dir, { recursive: true, force: true }),
  };
}

/** Overwrite `src/a.ts` with `body` and commit it as its own commit. */
export function commitFile(
  repo: ChangedLinesRepo,
  rel: string,
  body: string,
  message: string,
): string {
  writeFileSync(path.join(repo.dir, rel), body);
  repo.git("add", rel);
  repo.git("commit", "-qm", message);
  return repo.git("rev-parse", "HEAD");
}
