/**
 * review-findings-faults — the test-only fault injection for the findings
 * store's write path (#1125).
 *
 * The store's write swallows every fault into `{ok:false, reason}` and never
 * throws, so the *only* observable difference between "the write failed" and
 * "the write succeeded" is which branch the store takes — and there is no
 * production condition a test can reach that makes the atomic rename fail.
 * Without a seam, the disclosure rule this exercises (memory the round had
 * already set aside must survive a failed write, because a failed write means
 * the round never reaches its summary) would be untested, which is how a
 * disclosure rule silently becomes a comment.
 *
 * The seam is a module-global hook, cleared by every test that sets it, exactly
 * like the ledger lock's own critical-section hook: production code pays an
 * undefined check and nothing else. Its names are deliberately NOT the write
 * primitive's — the acceptance-boundary canary asserts no other `src/` file
 * names that primitive, and this module reaches it.
 */

type FaultHook = (file: string) => void;

let fault: FaultHook | undefined;

/** Make the next findings write throw, naming `file`. `undefined` clears it. */
export function setFindingsWriteFaultForTests(fn?: FaultHook): void {
  fault = fn;
}

/** Run the fault hook, if one is set. A no-op in production. */
export function raiseFindingsWriteFault(file: string): void {
  if (fault) fault(file);
}
