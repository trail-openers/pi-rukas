#!/usr/bin/env bun
/**
 * #2031 AC2 (edge) — attribution. AC2's wording is `<name> created in $HOME
 * during the <role> run`: the line names the CHILD whose run made the entry.
 *
 * The frozen AC2 file runs one child at a time, so it cannot see the case the
 * concurrency model creates. `spawn_parallel` / `dispatch_parallel` run reviewer
 * children side by side, and the module header already concedes the same
 * weakness for the protected files — "two overlapping children share one
 * snapshot set, so whichever ends first restores the other's in-flight bytes".
 * For the protected files the guard still only names paths it actually owns;
 * for the listing the leak is worse: a name another child made is reported on
 * THIS result as if this child made it, which is precisely the false accusation
 * AC3 spends its whole existence forbidding for the no-baseline case.
 *
 * The case is driven deterministically: the reviewer takes no entry at all, a
 * non-reviewer child (which AC2 says is not listed) writes one inside the
 * reviewer's window, and the reviewer's own listing is what reports it.
 */

import { existsSync, mkdirSync, mkdtempSync, readdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { withOperatorConfigGuard } from "../src/spawn-operator-config.ts";
import type { DispatchResult } from "../src/types.ts";
import { withEnv } from "./lib/env-scope.ts";

const SELF = "test-AC2-home-entry-attribution.ts";
const realErrWrite = process.stderr.write.bind(process.stderr);
let exit = 0;
function assert(cond: boolean, msg: string) {
  if (cond) console.log(`✓ ${msg}`);
  else {
    realErrWrite(`✗ ${SELF}: ${msg}\n`);
    exit = 1;
  }
}

function result(): DispatchResult {
  return { role: "developer", ok: true, text: "done", toolUses: [], ms: 1, exitCode: 0 };
}

const root = mkdtempSync(path.join(tmpdir(), "pi-2031-attr-"));
const home = path.join(root, "home");
mkdirSync(home, { recursive: true });
const env = { HOME: home };

// The reviewer holds the window open; a second child writes the only new entry.
const reviewerWindow = (async () => {
  let res: DispatchResult | undefined;
  await withEnv(env, async () => {
    res = await withOperatorConfigGuard("code-review-specialist", async () => {
      await new Promise((settle) => setTimeout(settle, 80));
      return result();
    });
  });
  return res;
})();
await new Promise((settle) => setTimeout(settle, 20));
let other: DispatchResult | undefined;
await withEnv(env, async () => {
  other = await withOperatorConfigGuard("developer", async () => {
    writeFileSync(path.join(home, "not-the-reviewers.txt"), "written by the other child\n");
    return result();
  });
});
const reviewer = await reviewerWindow;

const entry = path.join(home, "not-the-reviewers.txt");
const reviewerLines = (reviewer?.operatorConfig ?? []).filter((l) => l.includes("created in $HOME"));
assert(
  existsSync(entry) && readdirSync(home).includes("not-the-reviewers.txt"),
  "AC2 attribution: the entry really exists and was made by the OTHER child",
);
assert(
  (other?.operatorConfig ?? []).length === 0,
  `AC2 attribution: the non-reviewer child is not listed (its own result stays clean) (${JSON.stringify(other?.operatorConfig ?? [])})`,
);
assert(
  !reviewerLines.some((l) => l.includes("not-the-reviewers.txt")),
  `AC2 attribution: the reviewer's result does not carry a line for an entry another child made (${JSON.stringify(reviewerLines)})`,
);
assert(reviewer?.ok === true, "AC2 attribution: the reviewer's own outcome is untouched");

console.log(`\nexit ${exit}`);
process.exit(exit);
