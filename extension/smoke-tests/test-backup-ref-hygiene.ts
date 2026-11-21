#!/usr/bin/env bun
/**
 * #2461 — the lens-fix backup refs are issue-keyed and never overwritten, and
 * the merged step's teardown deletes exactly the merged issues' `refs/pi-rukas/*`
 * refs, and only when the driver proved the merge.
 * Real git: the overwrite was a same-second `update-ref`, which only a real ref
 * store shows.
 */
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { execp } from "../src/exec.ts";
import { backupLensFixTree } from "../src/work-driver-lens-fix-reposition-backup.ts";
import type { CycleContext } from "../src/work-driver-context.ts";
import { runMergedTeardown } from "../src/work-driver-merged-teardown.ts";
import { initialState } from "../src/workflow-state.ts";

let failed = 0;
function check(cond: boolean, msg: string) {
  console.log(`${cond ? "✓" : "✗"} ${msg}`);
  if (!cond) failed++;
}

const repo = mkdtempSync(path.join(tmpdir(), "pi-ens-2461-"));
const git = (...args: string[]) =>
  execFileSync("git", args, { cwd: repo, encoding: "utf8" }).trim();
const refs = () => git("for-each-ref", "--format=%(refname)", "refs/pi-rukas/").split("\n");

try {
  git("init", "-q", "--initial-branch=main");
  git("config", "user.email", "t@example.com");
  git("config", "user.name", "T");
  const shas: string[] = [];
  const made: (string | undefined)[] = [];
  for (const round of [1, 2, 3]) {
    writeFileSync(path.join(repo, "f.txt"), `round ${round}\n`);
    git("add", ".");
    git("commit", "-q", "-m", `round ${round}`);
    shas.push(git("rev-parse", "HEAD"));
    made.push((await backupLensFixTree(execp, repo, [7])).ref);
  }
  // A fourth backup of the same HEAD in the same second still gets its own name.
  made.push((await backupLensFixTree(execp, repo, [7])).ref);

  const prefix = "refs/pi-rukas/lens-fix-backup/issue-7/";
  check(
    made.join(",") === [1, 2, 3, 4].map((n) => `${prefix}${n}`).join(","),
    `each backup gets the next number: ${made.join(", ")}`,
  );
  const resolved = [1, 2, 3].map((n) => git("rev-parse", `${prefix}${n}`));
  check(
    resolved.join(",") === shas.join(","),
    "three rounds leave three refs, each on its own round's commit",
  );

  // Every namespace's issue-7 shape, a legacy slug, and refs that are not issue 7's.
  const head = shas[2] ?? "";
  const mine = [
    "refs/pi-rukas/retry-preserved/issue-7/lens-fix-1",
    "refs/pi-rukas/integrate-backup/issue-7",
    "refs/pi-rukas/fix-pass-strays/7-default-1",
    "refs/pi-rukas/lens-fix-backup/issue-7-old-title/2026-01-01T00-00-00",
  ];
  const others = [
    "refs/pi-rukas/integrate-backup/issue-70",
    "refs/pi-rukas/fix-pass-strays/77-default-1",
    "refs/pi-rukas/lens-fix-backup/issue-8-mentions-7/2026-01-01T00-00-00",
    "refs/pi-rukas/lens-fix-backup/hand-made/1",
  ];
  for (const ref of [...mine, ...others]) git("update-ref", ref, head);

  // The teardown reads only these context fields; a full CycleContext is a cycle.
  const ctx = { repoRoot: repo, issue: 7 } as unknown as CycleContext;
  const state = initialState(7);
  await runMergedTeardown(ctx, state, state, false);
  check(
    [...mine, `${prefix}1`].every((r) => refs().includes(r)),
    "a merge only a child reported keeps every backup ref",
  );
  await runMergedTeardown(ctx, state, state, true);
  const left = refs();
  check(
    left.every((r) => !r.startsWith(prefix) && !mine.includes(r)),
    "after merge no ref of issue 7 remains, legacy slug refs included",
  );
  check(
    others.every((r) => left.includes(r)),
    `other issues' and unparseable refs are untouched: ${left.join(", ")}`,
  );
} finally {
  rmSync(repo, { recursive: true, force: true });
}

if (failed > 0) {
  console.error(`FAIL test-backup-ref-hygiene: ${failed} check(s) failed`);
  process.exit(1);
}
console.log("PASS test-backup-ref-hygiene");
