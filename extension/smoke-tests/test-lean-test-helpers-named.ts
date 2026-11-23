#!/usr/bin/env bun
/**
 * Both adversary prompts name the shared test code the base commit holds under the test dirs, so a child
 * told to reuse the project's harness is told WHERE it is. Real git: the listing is asked of the commit,
 * test files (basename matches the glob) are left out, the shallowest helper comes first, and a test dir
 * with no helpers renders the location sentence exactly as before.
 */
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { execp } from "../src/exec.ts";
import { testLocationInstruction } from "../src/lean/specify-prompt.ts";
import { withTestHelpers } from "../src/lean/verify-roster-base.ts";
import type { VerifyExec } from "../src/lean/verify-types.ts";

const SELF = "test-lean-test-helpers-named.ts";
let exit = 0;
function assert(cond: boolean, msg: string): void {
  if (cond) console.log(`✓ ${msg}`);
  else {
    console.error(`✗ ${SELF}: ${msg}`);
    exit = 1;
  }
}

const repo = mkdtempSync(path.join(tmpdir(), "test-helpers-"));
const write = (rel: string) => {
  mkdirSync(path.dirname(path.join(repo, rel)), { recursive: true });
  writeFileSync(path.join(repo, rel), "x\n");
};
for (const rel of [
  "tests/common/mod.rs",
  "tests/support.rs",
  "tests/it_works.rs",
  "tests/deep/a/fixture.json",
])
  write(rel);
const git = (args: string) =>
  execp(`git -c user.email=t@example.invalid -c user.name=t ${args}`, { cwd: repo });
await git("init -q");
await git("add -A");
await git("commit -q -m base");
const sha = (await git("rev-parse HEAD")).stdout.trim();
const real = ((cmd: string, opts?: object) => execp(cmd, opts ?? {})) as unknown as VerifyExec;

const loc = await withTestHelpers(real, repo, sha, { testDirs: ["tests"], testGlob: "it_*.rs" });
assert(
  JSON.stringify(loc?.helpers) ===
    JSON.stringify(["tests/support.rs", "tests/common/mod.rs", "tests/deep/a/fixture.json"]),
  `the base's non-test files under the test dir, shallowest first (${JSON.stringify(loc?.helpers)})`,
);
const said = loc === undefined ? "" : testLocationInstruction(loc);
assert(
  said.includes("`tests/common/mod.rs`") && !said.includes("it_works.rs"),
  `the prompt names the helpers and not the tests (${said.slice(-260)})`,
);

const bare = { testDirs: ["tests"], testGlob: "*" };
const none = await withTestHelpers(real, repo, sha, bare);
assert(
  none?.helpers === undefined &&
    testLocationInstruction(bare) === testLocationInstruction(none ?? bare),
  "a test dir holding only tests renders the location sentence unchanged",
);

process.exit(exit);
