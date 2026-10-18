/**
 * work-driver-verify-shared — #1647: the one contract the selected verify's
 * modules share, in a leaf with no imports of its own.
 *
 * The selector, the attribution wrapper, the ci tier, the develop plan and the
 * ALWAYS_RUN detector each need the same three things: which file names are
 * safe to spell in a shell command, which smoke tests run offline (`-live.ts`
 * spawns real Pi children and never does), and the shape of the attribution a
 * cycle records. Each had its own copy and they drifted; they live here.
 */

/**
 * A smoke test named the way it may appear in a shell argument: directly under
 * `smoke-tests/`, no spaces, no quoting-sensitive characters. Every name the
 * selector emits must match, or the selection falls back to the full suite.
 */
export const SMOKE_TEST_NAME_RE = /^smoke-tests\/[A-Za-z0-9_.-]+\.ts$/;

/** A SHA-1 commit id, the only base form that may reach `git` (#1647 review). */
export const SHA_RE = /^[0-9a-f]{40}$/;

/** A smoke test the offline develop and ci tiers may run: `test-*.ts`, never `-live.ts`. */
export function isOfflineTest(rel: string): boolean {
  return /^smoke-tests\/test-[^/]+\.ts$/.test(rel) && !/-live\.ts$/.test(rel);
}

/**
 * A failing-test name the loop printed, as a path relative to `extension/`.
 * Undefined for anything else: the rule the name must satisfy is the one the
 * probe command needs, because the name is written into a shell argument.
 */
export function extensionRelative(name: string): string | undefined {
  const mark = "/extension/";
  const at = name.lastIndexOf(mark);
  if (at < 0) return undefined;
  const rel = name.slice(at + mark.length);
  return SMOKE_TEST_NAME_RE.test(rel) ? rel : undefined;
}

/** What a cycle's selected verify let through without blocking (#1647). */
export interface VerifyAttributionRecord {
  /** Tests that failed once and passed on the rerun. */
  flaky: string[];
  /** Tests that failed twice and are red on the base commit as well. */
  baselineRed: string[];
}
