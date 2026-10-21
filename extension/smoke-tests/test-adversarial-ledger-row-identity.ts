#!/usr/bin/env bun
/**
 * #1557 — the adversarial smoke arms identify THEIR OWN ledger row by an
 * identity carried in the row, never by a `Date.now()` floor or a positional
 * index. This file is the CANARY half: pure text scans, no git, no fixture —
 * it is an ALWAYS_RUN member of the #1647 develop-verify selection, so every
 * develop round pays for what it does. The fixture half (the real writers on a
 * real clone: nonce persistence, the decoy data shape, the guard readers
 * staying unmoved) lives in `test-adversarial-ledger-nonce-roundtrip.ts`,
 * which the import graph selects.
 *
 * The flake this pins away: the ledger writer is fire-and-forget and stamps
 * `at` at write-START, so a straggler row from an earlier arm can stamp itself
 * at or after any floor a later arm samples and be read as that arm's row —
 * the honest arm-4 row (`passed=true, detail="approved"`) reported as arm 4b's
 * binding refusal. `waitForRowWrittenAfter` was that floor reader and had no
 * canary, so nothing kept a future test from reintroducing the shape.
 *
 * Two canaries, each at the level it lives at:
 *
 *   1. the ARMS: a static canary on `lib/arms/loop-behaviour.ts` fails if the
 *      dead floor's exact expression or the dead selector's name comes back,
 *      and fails if the arms stop selecting their rows through the nonce
 *      identity selector the arms file defines (`waitForRowsWithNonce` is
 *      module-private to that script — the canary is a source pin, not an
 *      import);
 *   2. the GUARD: `rowNonce` appears ONLY in the writer-side sources. The
 *      `LedgerEntry.rowNonce` jsdoc says the merge guard never consults the
 *      field; a comment states current behaviour and forbids nothing, so the
 *      same claim is checked at the source (the shape
 *      `test-decision-seam-grep.ts` and `test-marker-contracts.ts` already
 *      use). The scan covers EVERY file under `extension/src` — a reader in
 *      any module, whatever it is named (`merge-guard*`, `review-ledger*`,
 *      `lens-round-cap`, `lens-review-auto-delta`, or anything added later),
 *      fails the gate, and a rename of an expected writer shows up as an
 *      unexpected path rather than as silently reduced coverage.
 *
 * The rejected alternative for the whole field (why `rowNonce` exists at all):
 * the arms already wrap `appendLedgerEntry` and track every in-flight write in
 * `pendingWrites`, and arms run sequentially — so draining before the loop and
 * snapshotting the entries handed to the wrapper after it would identify this
 * arm's writes with no production change and no "never read this field"
 * invariant to maintain. It was rejected because the rows the arms assert on
 * are the rows ON DISK: an arm could then read green off a wrapper that
 * recorded a call whose write never landed, the exact class of failure these
 * arms exist to make visible. Storing the identity in the row keeps the
 * assertion target the artefact itself.
 */

import { readFileSync, readdirSync } from "node:fs";
import path from "node:path";

let exit = 0;
function assert(cond: boolean, msg: string) {
  if (cond) console.log(`✓ ${msg}`);
  else {
    console.error(`✗ ${msg}`);
    exit = 1;
  }
}

// ── 1. the canary: the floor's MECHANISM must not come back into the arms.
// `waitForRowWrittenAfter` existed only in the arms file and had no test —
// the coverage gap the issue names. What is pinned is the dead selector's
// name, the exact dead expression, and the API the arms must use — not
// speculative hazard classes: an open-ended `/\bat\s*>=/` or `Date.now() -
// N` scan would fail the suite for unrelated future code, and `Atomics.wait`
// / `Bun.sleepSync` guard a blocking-wait hazard that was never in the file.
// The patterns are narrow enough that prose cannot match them, so the scan
// reads the source directly — a comment-stripping pass would silently
// under-read (any `//` inside a string literal hides the rest of the line).
// Read relative to this file's parent (extension/) so the read is
// cwd-independent; the literal names the repo path so the ALWAYS_RUN
// detector sees this file as a reader of it.
const ARMS_REL = "smoke-tests/lib/arms/loop-behaviour.ts";
// A missing file is a hard canary failure, not a silent pass on empty text.
const armsSrc = readFileSync(path.resolve(import.meta.dirname, "..", ARMS_REL), "utf8");
assert(
  !armsSrc.includes("waitForRowWrittenAfter"),
  `arms: the timestamp-floor selector is gone (see ${ARMS_REL})`,
);
assert(
  /waitForRowsWithNonce\(\s*"job-/.test(armsSrc),
  `arms: each arm selects its rows through the nonce identity selector with its own job nonce (see waitForRowsWithNonce in ${ARMS_REL})`,
);
assert(
  !/at\s*>=\s*Date\.now\(\)\s*-\s*1\b/.test(armsSrc),
  `arms: the exact dead floor expression (\`at >= Date.now() - 1\`) is not back (${ARMS_REL})`,
);

// ── 2. the guard-blindness contract, gated rather than documented. The
// scan is inverted — every source file is read, and the set of files that
// MENTION the field must equal the writer-side allowlist exactly. A guard
// key added anywhere (whatever the file is named) fails the gate, a missing
// writer fails it too, and a name rename shows up as an unexpected path
// rather than as a quiet gap.
const srcDir = path.resolve(import.meta.dirname, "..", "src");
// The only sources that legitimately store/declare the field: the loop
// (#1557 threads its job id), the writer's params + write, the capture
// opts that thread it through, and the row interface that declares it.
const WRITER_SOURCES = [
  "adversarial.ts",
  "adversarial-ledger.ts",
  "adversarial-ledger-capture.ts",
  "review-ledger-entry.ts",
].sort();
const readers: string[] = [];
const walk = (dir: string, prefix: string): void => {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (entry.isDirectory()) walk(path.join(dir, entry.name), `${prefix}${entry.name}/`);
    else if (
      entry.name.endsWith(".ts") &&
      readFileSync(path.join(dir, entry.name), "utf8").includes("rowNonce")
    ) {
      readers.push(`${prefix}${entry.name}`);
    }
  }
};
walk(srcDir, "");
readers.sort();
assert(
  JSON.stringify(readers) === JSON.stringify(WRITER_SOURCES),
  `src/: \`rowNonce\` appears ONLY in the writer-side sources — it is test-facing provenance, never a guard key (found ${JSON.stringify(readers)}, expected exactly ${JSON.stringify(WRITER_SOURCES)})`,
);

console.log(`\nexit ${exit}`);
process.exit(exit);
