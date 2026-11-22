/**
 * capture-specify-reask-off — the capture of the specify re-ask's OFF-arm record
 * (`specify-reask-off-v0.15.1.json`), kept beside it and beside the harness both sides drive
 * (`../../lib/lean-specify-reask-golden.ts`).
 *
 * Run ONCE, against a v0.15.1 tree, the release before the re-ask — never against this checkout's
 * `src/`, which would record the code under test against itself. COPY (not symlink: a symlinked module
 * may resolve its imports from its real path) the harness and this script into a worktree of the tag:
 *
 *   git worktree add <tmp>/v0.15.1 v0.15.1
 *   ln -s <this repo>/extension/node_modules <tmp>/v0.15.1/extension/node_modules
 *   cp extension/smoke-tests/lib/lean-specify-reask-golden.ts <tmp>/v0.15.1/extension/smoke-tests/lib/
 *   cp extension/smoke-tests/fixtures/lean-state/capture-specify-reask-off.ts \
 *      <tmp>/v0.15.1/extension/smoke-tests/fixtures/lean-state/
 *   bun <tmp>/v0.15.1/extension/smoke-tests/fixtures/lean-state/capture-specify-reask-off.ts <out.json>
 *
 * The record it prints IS the committed fixture, byte for byte: `cmp` before committing a replacement.
 *
 * Usage: bun <this file> <out.json>
 */

import { rmSync, writeFileSync } from "node:fs";
import { ROOTS } from "../../lib/lean-specify-fixture.ts";
import { driveOff } from "../../lib/lean-specify-reask-golden.ts";

const text = `${JSON.stringify(await driveOff(2405), null, 2)}\n`;
for (const root of ROOTS) rmSync(root, { recursive: true, force: true });
if (process.argv[2] === undefined) console.log(text);
else {
  writeFileSync(process.argv[2], text, "utf8");
  console.log(`wrote ${process.argv[2]}`);
}
process.exit(0);
