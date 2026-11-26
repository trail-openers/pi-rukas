/**
 * lib/capture-verify-select-golden — produce the rows of
 * `verify-select-changed-paths-golden.ts` from the tree it is run in.
 *
 * Run this ONCE, against a detached checkout of the base commit of #2649, and paste
 * its stdout into the golden module. It imports nothing but the selector under
 * capture and the fixed table of changed-file sets, so what it prints is what that
 * tree's selector answered and nothing else.
 *
 *   cd extension && bun smoke-tests/lib/capture-verify-select-golden.ts
 */

import { selectVerifyTests } from "../../src/work-driver-verify-select.ts";
import {
  GOLDEN_CHANGED_SETS,
  type GoldenSelection,
} from "./verify-select-changed-paths-golden.ts";

const extensionDir = new URL("../../../", import.meta.url).pathname;

const rows: Record<string, GoldenSelection> = {};
for (const changed of GOLDEN_CHANGED_SETS) {
  const sel = selectVerifyTests(extensionDir, changed);
  const row: GoldenSelection = {
    mode: sel.mode,
    tests: sel.tests,
    ...(sel.fallbackReason !== undefined ? { fallbackReason: sel.fallbackReason } : {}),
  };
  rows[changed.join("+")] = row;
}
console.log(JSON.stringify(rows, null, 2));
