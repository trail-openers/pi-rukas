/**
 * capture-full-tier-off — the capture of the OFF-arm golden for the full-tier operand rule
 * (`full-tier-off-2633.json`), kept beside it and beside the harness both sides drive
 * (`../../lib/lean-full-tier-golden.ts`).
 *
 * Run ONCE, against `45fb130a44` — origin/main before this change — never against this checkout's
 * `src/`, which would record the code under test against itself and pin nothing. COPY (the harness's
 * `../../src/…` imports resolve by the importing file's realpath, so a symlinked harness silently
 * records this worktree's `src/` while looking like the pre-change tree) the harness and this script
 * into a detached worktree of that commit:
 *
 *   git -C <this repo> worktree add --detach <tmp>/full-tier-base 45fb130a44
 *   ln -s <this repo>/extension/node_modules <tmp>/full-tier-base/extension/node_modules
 *   cp extension/smoke-tests/lib/lean-full-tier-golden.ts \
 *      <tmp>/full-tier-base/extension/smoke-tests/lib/
 *   cp extension/smoke-tests/fixtures/lean-state/capture-full-tier-off.ts \
 *      <tmp>/full-tier-base/extension/smoke-tests/fixtures/lean-state/
 *   bun <tmp>/full-tier-base/extension/smoke-tests/fixtures/lean-state/capture-full-tier-off.ts <out.json>
 *
 * The record it prints IS the committed fixture, byte for byte: `cmp` before committing a replacement.
 * A capture accidentally taken from the branch under review differs on exactly the rows the change was
 * made to satisfy — that difference is what `cmp` is there to catch, and what the test file's on-arm
 * `!==` assertions re-check. The capture is a one-time act; re-running it against THIS checkout and
 * committing the output would make the off-arm comparison self-referential, which is the failure mode
 * the golden exists to prevent.
 *
 * Usage: bun <this file> <out.json>
 */

import { writeFileSync } from "node:fs";
import { drive } from "../../lib/lean-full-tier-golden.ts";

const record = drive();
const text = `${JSON.stringify(record, null, 2)}\n`;
if (process.argv[2] === undefined) console.log(text);
else {
  writeFileSync(process.argv[2], text, "utf8");
  console.log(`wrote ${process.argv[2]}`);
}
