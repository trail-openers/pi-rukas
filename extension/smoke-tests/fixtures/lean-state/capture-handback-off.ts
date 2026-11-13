/**
 * fixtures/lean-state/capture-handback-off.ts — writes the off-arm golden the
 * verified-handback switch is proven against.
 *
 * Run ONCE from the pre-change tree (`bun smoke-tests/fixtures/lean-state/
 * capture-handback-off.ts`) and commit the JSON it prints. The off-arm case in
 * `test-lean-verified-handback.ts` compares against these bytes; regenerating
 * them after the rule exists would make the comparison vacuous, the same rule
 * `capture-specify-off.ts` follows.
 *
 * The drive asserts its own shape before the file is written, so this script
 * cannot capture a run that stopped for some other reason: a refactor that moved
 * where the run dies makes the capture throw rather than bless a new value.
 */

import { writeFileSync } from "node:fs";
import path from "node:path";
import { OFF_GOLDEN_FIXTURE, driveHandbackArm } from "../../lib/lean-verified-handback-off-golden.ts";

/** The issue number the capture is filed under; the cases reuse it for symmetry. */
export const GOLDEN_ISSUE = 2242;

const golden = await driveHandbackArm(GOLDEN_ISSUE, { switchOff: true });
const file = path.resolve(import.meta.dirname, path.basename(OFF_GOLDEN_FIXTURE));
writeFileSync(file, `${JSON.stringify(golden, null, 2)}\n`, "utf8");
console.log(file);
