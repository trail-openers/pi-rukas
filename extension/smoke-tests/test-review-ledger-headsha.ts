#!/usr/bin/env bun
/**
 * #1039 — the review ledger's headSha resolution (temp-repo tests): a
 * branch-name head stores the resolved 40-char SHA; an unresolvable head
 * stores no headSha (the round-cap check then fails closed); the
 * adversarial writer stores the resolved headSha too.
 *
 * Shares the temp-repo setup with test-review-ledger.ts (imported helpers)
 * and runs in its own file so both stay within the 500-line file limit.
 */

import { execSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { waitForLedger } from "./lib/wait-for-ledger.ts";
import { runLensReview } from "../src/lens-review.ts";
import { writeAdversarialLedgerEntry } from "../src/adversarial-ledger.ts";
import { isFullCommitSha } from "../src/review-head-sha.ts";
import { ledgerFile, setupRepo, assert } from "./test-review-ledger.ts";

let exit = 0;

// ------------------------------------------- #1039 — headSha resolution
{
  const { repo, branch } = setupRepo();
  try {
    const expectedSha = execSync("git rev-parse feature/x", { cwd: repo, encoding: "utf8" }).trim();
    assert(isFullCommitSha(expectedSha), "the expected SHA is a 40-char OID");
    const emptySkills = mkdtempSync(path.join(os.tmpdir(), "skills-"));
    const prevSkills = process.env.PI_ENSEMBLE_SKILLS_DIR;
    process.env.PI_ENSEMBLE_SKILLS_DIR = emptySkills;
    try {
      // Branch-name head → stored headSha is the resolved 40-char SHA.
      await runLensReview({ diff: "a", cwd: repo, branch, head: branch });
      await new Promise((r) => setTimeout(r, 200));
      let entries = waitForLedger(ledgerFile(repo));
      let e = entries?.find((x) => x.kind === "lens" && x.branch === branch);
      assert(e?.headSha === expectedSha, "branch-name head → stored headSha is the resolved SHA");
      assert(isFullCommitSha(e?.headSha ?? ""), "…matches /^[0-9a-f]{40}$/");

      // Unresolvable head → entry written WITHOUT headSha.
      await runLensReview({ diff: "a", cwd: repo, branch, head: "nonexistent-ref-1039" });
      await new Promise((r) => setTimeout(r, 200));
      entries = waitForLedger(ledgerFile(repo));
      const allLens = (entries ?? []).filter((x) => x.kind === "lens" && x.branch === branch);
      e = allLens.sort((a, b) => b.at - a.at)[0]; // latest by at
      assert(e?.headSha === undefined, "unresolvable head → no headSha stored");

      // Adversarial writer also stores headSha.
      writeAdversarialLedgerEntry(
        {
          role: "adversarial",
          ok: true,
          text: "",
          toolUses: [],
          ms: 0,
          exitCode: 0,
          loopOutcome: "approved",
        },
        { workCwd: repo, branch, head: branch },
      );
      await new Promise((r) => setTimeout(r, 200));
      entries = waitForLedger(ledgerFile(repo));
      const adv = entries?.find((x) => x.kind === "adversarial" && x.branch === branch);
      assert(adv?.headSha === expectedSha, "adversarial writer stores the resolved headSha");
      assert(isFullCommitSha(adv?.headSha ?? ""), "adversarial headSha is a 40-char OID");
    } finally {
      if (prevSkills === undefined) delete process.env.PI_ENSEMBLE_SKILLS_DIR;
      else process.env.PI_ENSEMBLE_SKILLS_DIR = prevSkills;
      rmSync(emptySkills, { recursive: true, force: true });
    }
  } finally {
    rmSync(path.dirname(repo), { recursive: true, force: true });
  }
}

console.log(`\nexit ${exit}`);
process.exit(exit);
