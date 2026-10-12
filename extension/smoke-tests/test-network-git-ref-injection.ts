#!/usr/bin/env bun
/**
 * #1095 security — a branch or remote name that is not git-safe is refused
 * BEFORE any network git call, and no shell ever sees it.
 *
 * The merge guard fetches the PR's head branch on every merge. A branch name
 * carrying `$(…)` or backticks used to be interpolated into a shell string
 * (`git fetch ${remote} ${headBranch}`); it is now validated by netRefProblem
 * and, when safe, passed as argv. This drives the REAL merge-guard hook with a
 * hostile head branch and asserts: the refusal is named, no `git fetch` is
 * issued for it, and the marker file the payload would create does not exist.
 */

import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { netRefProblem } from "../src/work-driver-net-git.ts";
import { TARGET, hookDecision, setupLedgerPath } from "./merge-guard-helpers.ts";

let failures = 0;
function assert(cond: boolean, msg: string) {
  if (cond) console.log(`  ✓ ${msg}`);
  else {
    console.log(`  ✗ ${msg}`);
    failures++;
  }
}

await setupLedgerPath();
const dir = mkdtempSync(path.join(tmpdir(), "net-git-inject-"));
const marker = path.join(dir, "pwned");

console.log("1. netRefProblem");
for (const bad of [`x$(touch ${marker})`, "x`touch y`", "-oProxyCommand=evil", "a;b", "a b"]) {
  assert(netRefProblem(bad) !== undefined, `refused: ${JSON.stringify(bad)}`);
}
// git-valid names the restore allowlist refused (+, @): a PR head must not be blocked.
for (const good of ["feature/issue-1095-x", "origin", "main", "feature/x+y", "user@host-ref", "release/1.2_rc"]) {
  assert(netRefProblem(good) === undefined, `accepted: ${good}`);
}

console.log("2. merge guard refuses a hostile head branch before git");
const hostile = `feature/x$(touch ${marker})`;
const r = await hookDecision("gh pr merge 12", [], {
  target: { ...TARGET, headBranch: hostile },
});
assert(r.block === true, "merge refused");
assert(/git fetch refused/.test(r.reason ?? ""), "the refusal names the rejected fetch");
assert(
  !r.calls.some((c) => c.startsWith("git fetch")),
  "no git fetch is issued for the hostile branch",
);
assert(!existsSync(marker), "the payload's marker file was never created");

rmSync(dir, { recursive: true, force: true });
console.log(failures === 0 ? "\nAll ref-injection checks passed" : `\n${failures} failure(s)`);
process.exit(failures === 0 ? 0 : 1);
