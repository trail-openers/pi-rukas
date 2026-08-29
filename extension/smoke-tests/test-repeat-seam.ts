#!/usr/bin/env bun
/**
 * Pure-fn unit tests for detectRepeatSeam (issue #280 §A).
 *
 * Covers: 3 files → fires; 2 files → no; 3 different titles → no;
 * title normalisation tolerates file-specific tokens; edge cases.
 */

import { detectRepeatSeam } from "../src/detect-repeat-seam.ts";

let exit = 0;
function assert(cond: boolean, msg: string) {
  if (cond) console.log(`✓ ${msg}`);
  else {
    console.error(`✗ ${msg}`);
    exit = 1;
  }
}

// 1. 3 same-lens/same-title findings across 3 files → fires.
{
  const findings = [
    {
      lens: "SIMPLICITY",
      title: "Unused variable in src/auth/token.ts",
      path: "src/auth/token.ts",
    },
    { lens: "SIMPLICITY", title: "Unused variable in src/api/user.ts", path: "src/api/user.ts" },
    {
      lens: "SIMPLICITY",
      title: "Unused variable in src/workers/email.ts",
      path: "src/workers/email.ts",
    },
  ];
  const result = detectRepeatSeam(findings);
  assert(result !== null, "3 same-lens/same-title findings across 3 files → fires");
  assert(result?.fileCount === 3, "  fileCount is 3");
  assert(
    result?.normalisedTitle.includes("unused variable"),
    `  theme names the pattern (got: ${result?.normalisedTitle})`,
  );
}

// 2. 3 findings across only 2 files → does NOT fire.
{
  const findings = [
    {
      lens: "SIMPLICITY",
      title: "Unused variable in src/auth/token.ts",
      path: "src/auth/token.ts",
    },
    { lens: "SIMPLICITY", title: "Unused variable in src/api/user.ts", path: "src/api/user.ts" },
    { lens: "SIMPLICITY", title: "Unused variable in src/api/user.ts", path: "src/api/user.ts" },
  ];
  const result = detectRepeatSeam(findings);
  assert(result === null, "3 findings across only 2 files → does not fire");
}

// 3. 3 different titles → does NOT fire.
{
  const findings = [
    {
      lens: "SIMPLICITY",
      title: "Unused variable in src/auth/token.ts",
      path: "src/auth/token.ts",
    },
    { lens: "SIMPLICITY", title: "Missing null check in src/api/user.ts", path: "src/api/user.ts" },
    {
      lens: "SIMPLICITY",
      title: "Error handling in src/workers/email.ts",
      path: "src/workers/email.ts",
    },
  ];
  const result = detectRepeatSeam(findings);
  assert(result === null, "3 different titles → does not fire");
}

// 4. Title normalisation tolerates file-specific tokens.
{
  const findings = [
    {
      lens: "SECURITY",
      title: "src/auth/token.ts:12 - missing null check",
      path: "src/auth/token.ts",
    },
    {
      lens: "SECURITY",
      title: "src/api/user.ts - missing null check at line 45",
      path: "src/api/user.ts",
    },
    {
      lens: "SECURITY",
      title: "Missing null check in src/workers/email.ts",
      path: "src/workers/email.ts",
    },
  ];
  const result = detectRepeatSeam(findings);
  assert(result !== null, "title normalisation tolerates file-specific tokens → fires");
  assert(result?.fileCount === 3, "  all 3 files clustered despite title variance");
}

// 5. Fewer than 3 findings → does NOT fire.
{
  const findings = [
    {
      lens: "SIMPLICITY",
      title: "Unused variable in src/auth/token.ts",
      path: "src/auth/token.ts",
    },
    { lens: "SIMPLICITY", title: "Unused variable in src/api/user.ts", path: "src/api/user.ts" },
  ];
  const result = detectRepeatSeam(findings);
  assert(result === null, "2 findings → does not fire");
}

// 6. Empty findings → does NOT fire.
{
  const findings: Array<{ lens: string; title: string; path: string }> = [];
  const result = detectRepeatSeam(findings);
  assert(result === null, "empty findings → does not fire");
}

// 7. Different lenses with same title → does NOT fire (different clusters).
{
  const findings = [
    {
      lens: "SIMPLICITY",
      title: "Unused variable in src/auth/token.ts",
      path: "src/auth/token.ts",
    },
    { lens: "SECURITY", title: "Unused variable in src/api/user.ts", path: "src/api/user.ts" },
    {
      lens: "PERFORMANCE",
      title: "Unused variable in src/workers/email.ts",
      path: "src/workers/email.ts",
    },
  ];
  const result = detectRepeatSeam(findings);
  assert(result === null, "same title, different lenses → does not fire (different clusters)");
}

console.log(`\nexit ${exit}`);
process.exit(exit);
