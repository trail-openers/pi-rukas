/**
 * #1533 — the head pin at the forge boundary.
 *
 * Split out of `test-work-driver-merged-mechanized.ts` (which the §12 file-size
 * cap could not hold with these cases appended): that file covers the merge
 * MECHANISM — method derivation, verification, restoration — while these cases
 * are all one question, "what does a pin refusal look like", and each is a
 * refusal the step must park on rather than merge.
 *
 * Three things are pinned here, and each is a different failure if it slips:
 *  1. a head the step cannot name precisely is never merged (a malformed OID is
 *     a refusal, not an unpinned merge);
 *  2. a forge that REFUSES the pin is not read as "already merged" or as a
 *     permanent error — the two classifications that would report success or
 *     hand the same moved head to an LLM ops retry;
 *  3. the classifier itself stays narrow: only the head-mismatch sentence is a
 *     refused pin, not any sentence containing "does not match".
 *
 * The command bytes themselves (does the builder emit `--match-head-commit` /
 * `--sha`) are pinned in test-forge-github.ts / test-forge-gitlab.ts; the
 * pre-merge head VERIFICATION is in test-work-driver-merged-head.ts.
 */

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import type { DriverContext } from "../src/work-driver-context.ts";
import type { VerifyExecFn } from "../src/work-driver-git.ts";
import { isHeadPinRefusal, mechanizedMerge } from "../src/work-driver-merged-mechanized.ts";
import type { WorkState } from "../src/workflow-state.ts";
import { setupSpawnGuard } from "./test-helpers.ts";
import { mkPi, mkCtx, mkExec, HEAD_OID } from "./lib/work-driver-merged-pin-helpers.ts";

setupSpawnGuard();

let exit = 0;
function assert(cond: boolean, msg: string) {
  if (cond) console.log(`✓ ${msg}`);
  else {
    console.error(`✗ ${msg}`);
    exit = 1;
  }
}

{
  // A merge is never attempted with a head the step cannot name precisely: a
  // missing or malformed OID is a refusal, not an unpinned merge.
  const { fn, calls } = mkExec({
    "gh repo view": {
      stdout: '{"squashMergeAllowed":true,"mergeCommitAllowed":false,"rebaseMergeAllowed":false}',
    },
  });
  const r = await mechanizedMerge(mkCtx(100, fn), {
    pipelineState: { prNumber: 999 },
  } as unknown as WorkState, "abc123");
  assert(
    r.ok === false && /40-char SHA/.test(r.reason),
    `#1533: a malformed verified head refuses the merge with a named reason (got ${JSON.stringify(r)})`,
  );
  assert(
    calls.every((c) => !c.includes("gh pr me" + "rge")),
    "#1533: and no merge command was issued at all",
  );
}
{
  // The refused pin is classified BEFORE "already been merged" and before the
  // permanent-error classifier: read as either, an unmerged PR reports success
  // or falls through to an LLM ops dispatch that retries the same moved head.
  for (const [label, stderr] of [
    [
      "gh",
      "pull request 999 headRefOid does not match the value provided by --match-head-commit",
    ],
    [
      "glab",
      "the provided sha a1b2c3d does not match the MR head_sha 9f8e7d6; the head has changed since the review",
    ],
  ] as const) {
    let viewCount = 0;
    const base = mkExec({
      "gh repo view": {
        stdout: '{"squashMergeAllowed":true,"mergeCommitAllowed":false,"rebaseMergeAllowed":false}',
      },
      "gh pr merge": { error: true, stderr },
    });
    // The pre-check must say "not merged yet" and the post-verify must say
    // MERGED: the case then fails if the refusal is swallowed, because a
    // swallowed refusal would report a successful merge on this fixture.
    const exec: VerifyExecFn = async (cmd, o) => {
      if (cmd.includes("gh pr view")) {
        viewCount++;
        if (viewCount === 1) return { stdout: "OPEN\n" };
        throw new Error(
          `#1533: post-merge verify reached — the merge was not refused (${stderr})`,
        );
      }
      return base.fn(cmd, o);
    };
    const r = await mechanizedMerge(mkCtx(100, exec), {
      pipelineState: { prNumber: 999 },
    } as unknown as WorkState, HEAD_OID);
    assert(
      r.ok === false && /head pin refused/.test(r.reason),
      `#1533: a refused pin (${label}) is a head-pin refusal, not a merge (${JSON.stringify(r)})`,
    );
  }
}
{
  // The two classifiers the refusal must NOT be swallowed by, kept honest on
  // the same input: "already been merged" and the permanent 4xx set.
  assert(
    isHeadPinRefusal("pull request headRefOid does not match --match-head-commit") === true,
    "#1533: the gh spelling of a refused pin is recognised",
  );
  assert(
    isHeadPinRefusal("cannot merge: already been merged") === false,
    "#1533: an already-merged answer is not read as a refused pin",
  );
  assert(
    isHeadPinRefusal("HTTP 403: Resource not accessible by integration") === false,
    "#1533: a permanent permission error is not read as a refused pin",
  );
  assert(
    isHeadPinRefusal("GraphQL: field baseRefName does not match") === false,
    "#1533: a mismatch sentence about something OTHER than the head is not a refused pin",
  );
}

console.log(`\nexit ${exit}`);
process.exit(exit);
