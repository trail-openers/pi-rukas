/**
 * capture-pre-verify-share-off — the capture of the OFF-arm golden for the pre-verify share
 * (`pre-verify-share-off-2634.json`), kept beside it and beside the harness both sides drive
 * (`../../lib/lean-pre-verify-share-golden.ts`).
 *
 * Run ONCE, against `c488c87cb2` — origin/main before this change — never against this checkout's
 * `src/`, which would record the code under test against itself and pin nothing. COPY (the harness's
 * `../../src/…` imports resolve by the importing file's realpath, so a symlinked harness silently
 * records this worktree's `src/` while looking like the pre-change tree) the harness and this script
 * into a worktree of that commit:
 *
 *   git -C <this repo> worktree add <tmp>/pre-verify-base c488c87cb2
 *   ln -s <this repo>/extension/node_modules <tmp>/pre-verify-base/extension/node_modules
 *   cp extension/smoke-tests/lib/lean-pre-verify-share-golden.ts \
 *      <tmp>/pre-verify-base/extension/smoke-tests/lib/
 *   cp extension/smoke-tests/fixtures/lean-state/capture-pre-verify-share-off.ts \
 *      <tmp>/pre-verify-base/extension/smoke-tests/fixtures/lean-state/
 *   bun <tmp>/pre-verify-base/extension/smoke-tests/fixtures/lean-state/capture-pre-verify-share-off.ts <out.json>
 *
 * The record it prints IS the committed fixture, byte for byte: `cmp` before committing a replacement
 * (the machine tables are the two fields this issue moves by design, so expect `pairs` and the
 * challenge kinds to differ when a capture is accidentally taken from the branch under review — that
 * difference is exactly what `cmp` is there to catch). The capture is a one-time act; re-running it
 * against THIS checkout and committing the output would make the off-arm comparison self-referential,
 * which is the failure mode the golden exists to prevent.
 *
 * Usage: bun <this file> <out.json>
 */

import { writeFileSync } from "node:fs";
import { GOLDEN_ISSUE, driveOffArm } from "../../lib/lean-pre-verify-share-golden.ts";

const record = await driveOffArm(GOLDEN_ISSUE);
const text = `${JSON.stringify(record, null, 2)}\n`;
if (process.argv[2] === undefined) console.log(text);
else {
  writeFileSync(process.argv[2], text, "utf8");
  console.log(`wrote ${process.argv[2]}`);
}
