/**
 * capture-specify-preserves-off — the capture of the OFF-arm record for the specify preservation
 * declaration (`specify-preserves-off-2668.json`), kept beside it and beside the harness both sides drive
 * (`../../lib/lean-specify-preserves-golden.ts`).
 *
 * Run ONCE, against `231491a7f8` — the commit this branch is based on, which has no `preserves` field at
 * all — never against this checkout's `src/`, which would record the code under test against itself and pin
 * nothing. COPY (the harness's `../../src/…` imports resolve by the importing file's realpath, so a
 * symlinked harness silently records this worktree's `src/` while looking like the pre-change tree) the
 * harness and this script into a detached worktree of that commit:
 *
 *   git -C <this repo> worktree add --detach <tmp>/preserves-base 231491a7f8
 *   ln -s <this repo>/extension/node_modules <tmp>/preserves-base/extension/node_modules
 *   cp extension/smoke-tests/lib/lean-specify-preserves-golden.ts \
 *      <tmp>/preserves-base/extension/smoke-tests/lib/
 *   cp extension/smoke-tests/fixtures/lean-state/capture-specify-preserves-off.ts \
 *      <tmp>/preserves-base/extension/smoke-tests/fixtures/lean-state/
 *   bun <tmp>/preserves-base/extension/smoke-tests/fixtures/lean-state/capture-specify-preserves-off.ts <out.json>
 *
 * What it captures, from the PRODUCTION path of that tree (the real `specifyPrompt`, the real
 * `submit_tests` schema text, and the real `specify` step driven over a real temp git repo, with only the
 * model faked): the kickoff prompt, the reporter's parameter block, and the specify record of a gap run and
 * of a normal freeze. A run in which every test criterion is declared preserved is captured with the field
 * PRESENT: the pre-change reader never looks at it, so what that tree recorded is the off arm's answer.
 *
 * The record it prints IS the committed fixture, byte for byte: `cmp` before committing a replacement.
 * Re-running it against THIS checkout and committing the output would make the off-arm comparison
 * self-referential, which is the failure mode the golden exists to prevent.
 *
 * Usage: bun <this file> <out.json>
 */

import { rmSync, writeFileSync } from "node:fs";
import {
  captureOffArm,
  capturePreservesPanel,
  maskPreserves,
} from "../../lib/lean-specify-preserves-golden.ts";
import { ROOTS } from "../../lib/lean-specify-fixture.ts";
import {
  PANEL_IDS,
  greenFile,
  redFile,
  testRel,
} from "../../lib/lean-specify-preservation-fixture.ts";

const PANEL_ROWS = PANEL_IDS.map((id) => ({
  id,
  script: id === "AC5" ? greenFile() : redFile(),
  ...(id === "AC5" ? { preserves: true } : {}),
  rel: testRel(id),
}));

const record = await captureOffArm(2668);
record.panel = await capturePreservesPanel(2669, PANEL_ROWS);
// The mask runs ONCE over the whole record: the texts are already masked where they were built (the prompt
// comes from the step and the record from the panel arm), and the file's bytes are what both arms compare.
const text = `${JSON.stringify(record, null, 2)}\n`;

for (const root of ROOTS) rmSync(root, { recursive: true, force: true });
if (process.argv[2] === undefined) console.log(text);
else {
  writeFileSync(process.argv[2], text, "utf8");
  console.log(`wrote ${process.argv[2]}`);
}
process.exit(0);
