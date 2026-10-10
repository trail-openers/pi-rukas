#!/usr/bin/env bun
/**
 * #1078 — the Step 4 developer brief is self-sufficient for the issue body.
 *
 * Sibling `test-develop-prompt-scope.ts` covers the single-issue variant of
 * this seam (artifact path present → `cat <path>` + "Do NOT re-fetch" + no
 * `gh issue view` line; path absent → the re-fetch fallback). This file is
 * deliberately narrower: it covers only the MULTI-ISSUE variant, where the
 * pre-#1078 prompt rendered a per-issue loop of `gh issue view <N>` lines and
 * the refactor collapsed that loop into a single artifact path. The
 * "no re-fetch" guarantee must hold for multi-issue too — specifically, NO
 * per-issue `gh issue view <N>` line may survive when the artifact path is
 * present, and the absent-path fallback must still name every issue number
 * so the developer knows which ones to fetch.
 */

import { inlineDevelopPrompt } from "../src/work-driver-prompts-early.ts";

let exit = 0;
function assert(cond: boolean, msg: string) {
  if (cond) console.log(`✓ ${msg}`);
  else {
    console.error(`✗ ${msg}`);
    exit = 1;
  }
}

const ws = {
  id: "task-a",
  scope: "Thread the issue body into the develop prompt",
  paths: ["extension/src/work-driver-prompts-early.ts"],
  outOfScope: ["extension/src/work-develop-run.ts"],
};

const ARTIFACT = "/home/user/.pi/work-state/1078-1079/issue-body.txt";

// ---------------------------------------------------- 1. Multi-issue, path present

{
  const prompt = inlineDevelopPrompt(
    [1078, 1079],
    "/tmp/scratch",
    ws,
    "task-a",
    undefined,
    undefined,
    undefined,
    undefined,
    ARTIFACT,
  );
  // generic artifact-present properties (path rendered, cat instructed, re-fetch forbidden) are asserted for single-issue in test-develop-prompt-scope.ts
  assert(
    !/gh issue view 1078/.test(prompt) && !/gh issue view 1079/.test(prompt),
    "multi-issue: NO per-issue `gh issue view <N>` line survives — the artifact path replaces the whole loop",
  );
}

// ---------------------------------------------------- 2. Multi-issue, path absent

{
  const prompt = inlineDevelopPrompt(
    [1078, 1079],
    "/tmp/scratch",
    ws,
    "task-a",
    undefined,
    undefined,
    undefined,
    undefined,
    undefined,
  );
  assert(
    prompt.includes("gh issue view <N>") && prompt.includes("#1078, #1079"),
    "multi-issue: absent artifact path → the prompt tells the developer to run `gh issue view <N>` for each issue in the list",
  );
  assert(
    prompt.includes("#1078") && prompt.includes("#1079"),
    "multi-issue: the specific issue numbers are named so the developer knows which to fetch",
  );
  assert(
    !prompt.includes(ARTIFACT),
    "multi-issue: no fabricated artifact path when none was threaded",
  );
}

console.log(`\nexit ${exit}`);
process.exit(exit);
