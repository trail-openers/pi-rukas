/**
 * capture-specify-off — the capture of the committed OFF-arm golden, kept beside
 * the record it produced (`specify-off-v0.14.71.json`) and beside the harness that
 * drives both sides of the comparison (`../../lib/lean-specify-off-golden.ts`).
 *
 * Run ONCE, against a v0.14.71 tree — never against this checkout's `src/`. The
 * harness imports the step it records by RELATIVE path (`../../src/lean/…`), so the
 * trick is to let the harness and this script come from this worktree while `src/`
 * resolves inside the tag's tree:
 *
 *   git -C <this repo> worktree add tmp/issue-2212/v0.14.71 v0.14.71
 *   ln -s <this repo>/extension/node_modules tmp/issue-2212/v0.14.71/extension/node_modules
 *   mkdir -p tmp/issue-2212/v0.14.71/extension/smoke-tests/fixtures/lean-state
 *   for f in ../../lib/lean-specify-off-golden.ts ./capture-specify-off.ts; do
 *     ln -s <this repo>/extension/smoke-tests/fixtures/lean-state/../$f \
 *         tmp/issue-2212/v0.14.71/extension/smoke-tests/fixtures/lean-state/$f
 *   done
 *   bun tmp/issue-2212/v0.14.71/extension/smoke-tests/fixtures/lean-state/capture-specify-off.ts <out.json>
 *
 * With the two files symlinked in, every `src/` import the harness makes is resolved
 * by that file's own location — the tag's tree — which is what makes the record
 * v0.14.71's and not main's. Running this script from this checkout instead records
 * the code under test against itself and pins nothing: run it only over the
 * symlinked tag tree, and only into a path outside the tracked tree.
 *
 * The record it prints IS the committed fixture — byte for byte. Compare before
 * committing a replacement:
 *
 *   cmp <out.json> extension/smoke-tests/fixtures/lean-state/specify-off-v0.14.71.json
 *
 * Usage: bun <this file> <out.json>
 */

import { writeFileSync } from "node:fs";
import { GOLDEN_ISSUE, driveOffArm } from "../../lib/lean-specify-off-golden.ts";

const decline = { ran: 0, rules: [] as string[] };
const golden = await driveOffArm(GOLDEN_ISSUE, {
  switchOff: true,
  assertNoProbe: true,
  decline,
});
const text = `${JSON.stringify(golden, null, 2)}\n`;
if (process.argv[2] === undefined) console.log(text);
else {
  writeFileSync(process.argv[2], text, "utf8");
  console.log(`wrote ${process.argv[2]}`);
}
