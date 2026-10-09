#!/usr/bin/env bun
/**
 * #1039 — the review ledger's headSha resolution (temp-repo tests): a
 * branch-name head stores the resolved 40-char SHA; an unresolvable head
 * stores no headSha (the round-cap check then fails closed); the
 * adversarial writer stores the resolved headSha too.
 *
 * Shares the temp-repo setup with the #912 suite via
 * lib/review-ledger-test-helpers.ts (importing test-review-ledger.ts
 * directly would execute its whole test body and its process.exit, which
 * pre-empted this file's final line — the setup helpers moved to lib/ for
 * that reason). Runs in its own file so both stay within the 500-line
 * file limit.
 */

import { execSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { waitForLedger } from "./lib/wait-for-ledger.ts";
import { ledgerFile, setupRepo } from "./lib/review-ledger-test-helpers.ts";
import { runLensReview } from "../src/lens-review.ts";
import { writeAdversarialLedgerEntry } from "../src/adversarial-ledger.ts";
import { isFullCommitSha } from "../src/review-head-sha.ts";
// #1039 — this file's own assert (NOT the one exported by
// test-review-ledger.ts): the parent's assert increments the PARENT
// module's exit counter, so a failure in this file would have exited 0 —
// a test that can never fail. The local assert below owns this file's
// counter and its final process.exit is the process's only exit.

let exit = 0;
function assert(cond: boolean, msg: string) {
  if (cond) console.log(`✓ ${msg}`);
  else {
    console.error(`✗ ${msg}`);
    exit = 1;
  }
}

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
      // #984 — waitForLedger polls (20 ms tick, 30 s budget) until the
      // fire-and-forget write's tmp+rename completes; the fixed setTimeout
      // sleeps are gone (they raced the writer on a loaded host).
      await runLensReview({ diff: "a", cwd: repo, branch, head: branch });
      await new Promise((r) => setTimeout(r, 300));
      let entries = waitForLedger(ledgerFile(repo));
      let e = entries?.find((x) => x.kind === "lens" && x.branch === branch);
      assert(e?.headSha === expectedSha, "branch-name head → stored headSha is the resolved SHA");
      assert(isFullCommitSha(e?.headSha ?? ""), "…matches /^[0-9a-f]{40}$/");

      // Unresolvable head → entry written WITHOUT headSha.
      await runLensReview({ diff: "a", cwd: repo, branch, head: "nonexistent-ref-1039" });
      await new Promise((r) => setTimeout(r, 300));
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
      // The adversarial writer is fire-and-forget (no await seam). The
      // ledger file already exists from the lens writes, so a plain
      // waitForLedger poll cannot wait for the NEW entry to appear — it
      // returns the pre-existing file immediately. Settle briefly (the
      // writer's two subprocess hops + atomic rename, the #984 shape),
      // then read once: the single fixed wait is the deterministic
      // substitute for the removed setTimeout chain, and the file is
      // written atomically (tmp+rename), so a settled read is stable.
      await new Promise((r) => setTimeout(r, 500));
      const advEntries = waitForLedger(ledgerFile(repo)) ?? [];
      const adv = advEntries.find((x) => x.kind === "adversarial" && x.branch === branch);
      assert(!!adv, "adversarial writer stored an entry");
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
