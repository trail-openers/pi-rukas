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
 *
 * Each arm uses its OWN temp repo: the ledger dedupes lens rows per
 * (branch, kind, patchId), so a second write in a shared repo can leave the
 * first row (and its headSha) in place — a fresh repo makes each arm's
 * ledger start empty and its assertion unambiguous.
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
import type { LedgerEntry } from "../src/review-ledger.ts";

// This file's own assert and exit counter (NOT the one exported by
// test-review-ledger.ts — its counter lives in the parent module, so a
// failure here would have exited 0: a test that could never fail).
let exit = 0;
function assert(cond: boolean, msg: string) {
  if (cond) console.log(`✓ ${msg}`);
  else {
    console.error(`✗ ${msg}`);
    exit = 1;
  }
}

/**
 * Poll until an entry matching `pred` appears. The writers are
 * fire-and-forget, so a plain waitForLedger returns an already-present file
 * at once and cannot wait for a NEW entry. Undefined after the 30 s budget.
 * MUST yield (setTimeout, not Atomics.wait): the writer's subprocess
 * callbacks run on the event loop, and a blocking wait starves them.
 */
async function waitForEntry(
  file: string,
  pred: (e: LedgerEntry) => boolean,
): Promise<LedgerEntry | undefined> {
  const deadline = Date.now() + 30_000;
  while (Date.now() < deadline) {
    const hit = (waitForLedger(file, 0) ?? []).filter(pred).sort((a, b) => b.at - a.at)[0];
    if (hit) return hit;
    await new Promise((r) => setTimeout(r, 20));
  }
  return undefined;
}

const emptySkills = mkdtempSync(path.join(os.tmpdir(), "skills-"));
const prevSkills = process.env.PI_ENSEMBLE_SKILLS_DIR;
process.env.PI_ENSEMBLE_SKILLS_DIR = emptySkills;
try {
  // ------------------------------------------- branch-name head → resolved SHA
  {
    const { repo, branch } = setupRepo();
    try {
      const expectedSha = execSync("git rev-parse feature/x", { cwd: repo, encoding: "utf8" }).trim();
      assert(isFullCommitSha(expectedSha), "the expected SHA is a 40-char OID");
      await runLensReview({ diff: "a", cwd: repo, branch, head: branch });
      const e = await waitForEntry(ledgerFile(repo), (x) => x.kind === "lens" && x.branch === branch);
      assert(e?.headSha === expectedSha, "branch-name head → stored headSha is the resolved SHA");
      assert(isFullCommitSha(e?.headSha ?? ""), "…matches /^[0-9a-f]{40}$/");
    } finally {
      rmSync(path.dirname(repo), { recursive: true, force: true });
    }
  }

  // ------------------------------------------- unresolvable head → no headSha
  {
    const { repo, branch } = setupRepo();
    try {
      await runLensReview({ diff: "a", cwd: repo, branch, head: "nonexistent-ref-1039" });
      const e = await waitForEntry(ledgerFile(repo), (x) => x.kind === "lens" && x.branch === branch);
      assert(e !== undefined, "unresolvable head → a lens entry was written");
      assert(e?.headSha === undefined, "unresolvable head → no headSha stored");
    } finally {
      rmSync(path.dirname(repo), { recursive: true, force: true });
    }
  }

  // ------------------------------------------- adversarial writer → resolved SHA
  {
    const { repo, branch } = setupRepo();
    try {
      const expectedSha = execSync("git rev-parse feature/x", { cwd: repo, encoding: "utf8" }).trim();
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
      const adv = await waitForEntry(ledgerFile(repo), (x) => x.kind === "adversarial" && x.branch === branch);
      assert(!!adv, "adversarial writer stored an entry");
      assert(adv?.headSha === expectedSha, "adversarial writer stores the resolved headSha");
      assert(isFullCommitSha(adv?.headSha ?? ""), "adversarial headSha is a 40-char OID");
    } finally {
      rmSync(path.dirname(repo), { recursive: true, force: true });
    }
  }
} finally {
  if (prevSkills === undefined) delete process.env.PI_ENSEMBLE_SKILLS_DIR;
  else process.env.PI_ENSEMBLE_SKILLS_DIR = prevSkills;
  rmSync(emptySkills, { recursive: true, force: true });
}

console.log(`\nexit ${exit}`);
process.exit(exit);
