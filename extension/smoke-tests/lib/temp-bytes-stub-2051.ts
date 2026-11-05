/**
 * temp-bytes-stub-2051 — the fixture #2051's AC3 test writes its leak through,
 * kept out of the test file so that file stays an acceptance test.
 *
 * `installStubChild`'s `stub.body` hook runs at the moment the child's process
 * is created, i.e. INSIDE the operator-config guard's measurement window, so a
 * write made there is a write the child made during its own run — the exact
 * shape of the field incident (a lens that generated synthetic transcripts
 * under the temp dir and never removed them).
 */

import { writeFileSync } from "node:fs";
import { trackedTempDir } from "./git-test-env.ts";

/**
 * A scratch dir under the temp root this process's TMPDIR names, removed by
 * `git-test-env.ts`'s process-end / SIGTERM cleanup: the test that measures a
 * temp leak must not itself be a temp leak.
 */
export function childFreeTemp(tag: string): string {
  return trackedTempDir(`pi-2051-${tag}-`);
}

/**
 * Write `bytes` of REAL (allocated) content to `file`.
 *
 * Real, never `truncate`d: the measure is `st_blocks * 512`, and a sparse file
 * reports a huge apparent size for almost no blocks — a fixture that cheated
 * here would clear the threshold arm while allocating nothing at all.
 */
export function writeRealBytes(file: string, bytes: number): void {
  writeFileSync(file, Buffer.alloc(bytes, 0x78));
}
