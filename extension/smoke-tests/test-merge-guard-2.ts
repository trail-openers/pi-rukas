#!/usr/bin/env bun
/**
 * #912 — the merge guard (part 2): the "and it does not overreach" table.
 *
 * Moved out of test-merge-guard.ts verbatim (section comment included) so
 * both files sit under the 500-line hard limit. Same module under test,
 * same offline forge env, its own private ledger temp file.
 */

import { rmSync, mkdtempSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { mergesPr } from "../src/bash-command-parser.ts";

// Same offline forge as part 1 (the detectForge hard override).
process.env.PI_ENSEMBLE_FORGE = "github";

let exit = 0;
function assert(cond: boolean, msg: string) {
  if (cond) console.log(`✓ ${msg}`);
  else {
    console.error(`✗ ${msg}`);
    exit = 1;
  }
}

// Its own private ledger temp file (removed at the end), pointed at BEFORE
// any resolution so the real per-clone ledger is never touched. This table
// exercises only the matcher, but the isolation mirrors part 1.
const LEDGER_TMP_DIR = mkdtempSync(path.join(os.tmpdir(), "pi-ledger2-"));
process.env.PI_ENSEMBLE_REVIEW_LEDGER_FILE = path.join(
  LEDGER_TMP_DIR,
  "review-ledger.json",
);

// -------------------------------------------------- and it does not overreach

for (const cmd of [
  // Reads stay open.
  "gh pr view 12",
  "gh pr checks 12",
  "gh pr list",
  "glab mr view 12 --output json",
  "gh pr comment 5 --body hi",
  // A specific PR via REST (no /merge suffix) is a read.
  "gh api repos/o/r/pulls/42",
  "gh api repos/o/r/pulls/12 --method GET",
  "glab api /projects/1/mr/12",
  // The gh /merge door with an explicit GET is a read (inverted default).
  "gh api repos/o/r/pulls/12/merge --method GET",
  "gh api repos/o/r/pulls/12/merge -X GET",
  "gh api repos/o/r/pulls/12/merge -X get",
  // The glab /merge door: unqualified or explicit GET is a read.
  "glab api /projects/1/mr/12/merge",
  "glab api /projects/1/mr/12/merge -X GET",
  "glab api /projects/1/mr/12/merge --method GET",
  "glab api /projects/1/merge_requests/12/merge",
  "glab api /projects/1/merge_requests/12/merge --method GET",
  // A direct push to the base branch is not a forge merge (git-level control).
  "git push origin HEAD:main",
  // Non-merge endpoints stay open.
  "gh api user",
  "glab api user",
  // Quoted mentions create nothing — stripQuotedSegments removes them.
  'echo "gh pr merge 12"',
  'echo "glab mr merge 7"',
  "gh pr comment 5 --body 'we will gh pr merge 12 later'",
]) {
  assert(mergesPr(cmd) === undefined, `allowed — ${cmd}`);
}

try {
  rmSync(LEDGER_TMP_DIR, { recursive: true, force: true });
} catch (err) {
  console.error(`⚠ could not remove the ledger temp dir: ${(err as Error).message}`);
}

console.log(`\nexit ${exit}`);
process.exit(exit);
