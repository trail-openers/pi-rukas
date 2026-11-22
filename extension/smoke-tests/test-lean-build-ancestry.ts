#!/usr/bin/env bun
/**
 * lean/build — the ancestry probe that decides whether the step may reset the
 * child's tree and commit. Only success means "descends" and only git's exit 1
 * means "does not"; every other rejection is "could not tell" and throws, so a
 * probe that never ran can never unlock the reset.
 *
 *   (a) the probe rejects with no exit code -> THROW before any reset or commit
 *   (b) each rejection shape, at the probe  -> exit 1 is false, the rest throw
 *
 * The real-git outcomes live in test-lean-build.ts: success in case (a), exit 1
 * in case (h).
 */

import { BuildInfraError } from "../src/lean/build-errors.ts";
import { headDescendsFrom } from "../src/lean/build-git.ts";
import type { BuildExec } from "../src/lean/build-types.ts";
import { status } from "./lib/lean-build-asserts.ts";
import { ROOTS, put, runBuild } from "./lib/lean-build-fixture.ts";

let exit = 0;
function assert(cond: boolean, msg: string): void {
  if (cond) console.log(`✓ ${msg}`);
  else {
    console.error(`✗ ${msg}`);
    exit = 1;
  }
}

// ------------------------- (a) the probe rejects with no exit code at all
{
  let probed = false;
  const r = await runBuild({
    issue: 201,
    child: (wt) => put(wt, "src/retry.ts", "export const retry = () => 4;\n"),
    execSpy: (_cmd, o) => {
      if (!(o as { argv?: string[] })?.argv?.includes("--is-ancestor")) return;
      probed = true;
      throw new Error("spawn git ENOENT");
    },
  });
  assert(
    r.threw instanceof BuildInfraError && /could not tell whether HEAD/.test(r.threw.message),
    `(a) an uncoded probe rejection is infrastructure, never "descends" (got ${r.threw?.message})`,
  );
  assert(
    probed && r.headAfter === r.headBefore && status(r.worktree) !== "",
    "(a) the probe ran, and nothing was committed or reset over the child's edit",
  );
}

// ------------------------------------------- (b) each rejection shape
for (const [shape, err] of [
  ["exit 1", { code: 1 }],
  ["no code", new Error("boom")],
  ["a kill's null", { code: null, killed: true }],
  ['the string "1"', { code: "1" }],
  ["exit 128", { code: 128 }],
] as const) {
  const exec: BuildExec = async () => Promise.reject(err);
  const got = await headDescendsFrom(exec, "/nowhere", "abc").catch((e: unknown) => e);
  const want = shape === "exit 1" ? false : "BuildInfraError";
  const seen = got instanceof BuildInfraError ? "BuildInfraError" : got;
  assert(seen === want, `(b) ${shape} -> ${String(want)} (got ${String(seen)})`);
}

for (const dir of ROOTS) {
  try {
    (await import("node:fs")).rmSync(dir, { recursive: true, force: true });
  } catch {
    /* best effort */
  }
}
process.exit(exit);
