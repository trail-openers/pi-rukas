/**
 * work-driver-verify-signature — #1647: the failure signature of each test a
 * verify-loop run printed.
 *
 * A baseline-red verdict says a test fails on the base commit too. That is only
 * an excuse when it fails for the SAME reason: a test the change broke in a new
 * way, which also happens to be red on base, must still block. verify-loop
 * prints `FAILED: <path>` and then the test's own output, so the signature is the
 * first failure line under each marker. Digits are folded out so a timing figure
 * in an assertion message does not make two identical failures look different.
 *
 * A test with no extractable line gets no signature. The caller then keeps the
 * name-only verdict and says so in the trace, rather than treating silence as a
 * mismatch.
 */

import { extensionRelative } from "./work-driver-verify-shared.ts";

const MARKER_RE = /^FAILED: (.+?)(?: \(timed out after \d+s\))?$/;
const SUMMARY_RE = /^FAILED: \d+ test/;
const FAILURE_LINE_RE = /✗|\bError\b|\bassert|\bexpected\b/i;
const MAX_SIGNATURE = 200;

/**
 * The first failure line of each failing smoke test in `output`, keyed by its
 * extension-relative path, with up to two indented detail lines under it (the
 * assertion text is what tells two failures of one case apart). A name the loop
 * printed that cannot be placed under `extension/` is skipped; it cannot be
 * matched across runs anyway.
 */
export function failureSignatures(output: string): Map<string, string> {
  const signatures = new Map<string, string>();
  let current: string | undefined;
  let open: string[] | undefined;
  const close = () => {
    if (current !== undefined && open !== undefined) {
      signatures.set(current, open.join(" | ").replace(/\d+/g, "N").slice(0, MAX_SIGNATURE));
    }
    open = undefined;
  };
  for (const raw of output.split("\n")) {
    const line = raw.trimEnd();
    if (SUMMARY_RE.test(line)) {
      close();
      current = undefined;
      continue;
    }
    const marker = MARKER_RE.exec(line);
    if (marker?.[1] !== undefined) {
      close();
      current = extensionRelative(marker[1]);
      continue;
    }
    if (current === undefined || signatures.has(current)) continue;
    if (open === undefined) {
      if (FAILURE_LINE_RE.test(line)) open = [line.trim()];
      continue;
    }
    if (open.length < 3 && /^\s+\S/.test(line)) open.push(line.trim());
    else close();
  }
  close();
  return signatures;
}
