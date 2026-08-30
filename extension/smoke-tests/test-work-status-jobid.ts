#!/usr/bin/env bun
/**
 * Smoke test for /work-status jobId resolution (PR1 of issue #587).
 *
 * Tests the async-jobs registry job-issue mapping that enables
 * `/work-status <jobId>` to resolve a running cycle back to its
 * issue number(s).
 */

import { getJobIssues, setJobIssues } from "../src/async-jobs-registry.ts";

let exit = 0;
function assert(cond: boolean, msg: string) {
  if (cond) console.log(`✓ ${msg}`);
  else {
    console.error(`✗ ${msg}`);
    exit = 1;
  }
}

// 1. Empty registry — unknown jobId returns undefined.
{
  const result = getJobIssues("unknown-job-id");
  assert(result === undefined, "unknown jobId returns undefined");
}

// 2. Single-issue mapping.
{
  setJobIssues("job-abc123", [42]);
  const result = getJobIssues("job-abc123");
  assert(result !== undefined, "mapped jobId is found");
  assert(Array.isArray(result), "result is an array");
  assert(result!.length === 1, "single-issue array has one element");
  assert(result![0] === 42, "primary issue number is correct");
}

// 3. Multi-issue mapping (grouped cycle).
{
  setJobIssues("job-def456", [10, 11, 12]);
  const result = getJobIssues("job-def456");
  assert(result !== undefined, "multi-issue mapping is found");
  assert(result!.length === 3, "array length matches issue count");
  assert(result![0] === 10, "primary issue is first");
  assert(result![1] === 11, "secondary issue is second");
  assert(result![2] === 12, "tertiary issue is third");
}

// 4. Overwrite mapping — newer registration replaces older.
{
  setJobIssues("job-ghi789", [99]);
  assert(getJobIssues("job-ghi789")?.[0] === 99, "initial mapping is correct");
  setJobIssues("job-ghi789", [200, 201]);
  const updated = getJobIssues("job-ghi789");
  assert(updated !== undefined, "overwritten jobId is still found");
  assert(updated!.length === 2, "new mapping has correct length");
  assert(updated![0] === 200, "primary issue updated correctly");
}

// 5. Multiple independent jobIds don't interfere.
{
  setJobIssues("job-a", [1]);
  setJobIssues("job-b", [2]);
  setJobIssues("job-c", [3]);
  assert(getJobIssues("job-a")?.[0] === 1, "job-a resolves to issue 1");
  assert(getJobIssues("job-b")?.[0] === 2, "job-b resolves to issue 2");
  assert(getJobIssues("job-c")?.[0] === 3, "job-c resolves to issue 3");
  assert(getJobIssues("job-x") === undefined, "unknown job still returns undefined");
}

// 6. Empty array stored — should still resolve (driver may use it).
{
  setJobIssues("job-empty", []);
  const result = getJobIssues("job-empty");
  assert(Array.isArray(result), "empty mapping returns an array");
  assert(result!.length === 0, "empty mapping has zero length");
}

// 7. isIssueNumberArg — the work-status handler uses it to distinguish
// jobId from issue-number arguments. Test via the registry layer
// (the handler is integration-tested via test-command-flow).
// We test the pattern directly here since isIssueNumberArg is internal.
function isIssueNumberArg(arg: string): boolean {
  return /^[0-9]+$/.test(arg);
}
{
  assert(isIssueNumberArg("42"), "pure digits → issue number");
  assert(isIssueNumberArg("12345"), "large digits → issue number");
  assert(!isIssueNumberArg("j1x9a"), "alphanumeric → not an issue number");
  assert(!isIssueNumberArg("job-abc123"), "hyphenated string → not an issue number");
  assert(!isIssueNumberArg("--json"), "flag → not an issue number");
  assert(!isIssueNumberArg(""), "empty string → not an issue number");
  assert(!isIssueNumberArg("-1"), "negative → not an issue number (min 1 in schema)");
}

console.log(`\nexit ${exit}`);
process.exit(exit);
