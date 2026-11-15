/**
 * lib/assert-rig — the pass/fail tally every `test-*.ts` in this directory re-declares.
 *
 * These suites are plain scripts, not `bun test` files: each prints `✓`/`✗` rows and
 * exits non-zero if any row failed, because a runner that reports per-test results would
 * fold a zero-assertion run into the same green as a run that asserted a great deal. The
 * tally is three lines, but it was written out once per file, and the #2283 develop-gate
 * suites plus their splits need it in more files than one author edited — so it lives here
 * once. `exit` is a live binding: read it, never assign to it, and pass it to
 * `process.exit` at the end of the script.
 *
 * Lives in lib/ so the smoke glob never self-executes it.
 */

let count = 0;

/** Rows that failed, as a live binding so a caller can report the count in its own footer. */
export let exit = 0;

/** One row. Truthy prints `✓`; falsy prints `✗` to stderr and reddens the run. */
export function assert(cond: boolean, msg: string): void {
  count++;
  if (cond) console.log(`✓ ${msg}`);
  else {
    console.error(`✗ ${msg}`);
    exit = 1;
  }
}

/** How many rows this process has judged — the number a split has to keep equal. */
export function assertCount(): number {
  return count;
}
