/**
 * Shared helpers for the two offline suites that pin the review blocking bar.
 *
 * The bar is one constant (`DEFAULT_REVIEW_THRESHOLD`) read by two suites:
 * `test-lens-evidence.ts` (evidence supply plus the resolver) and
 * `test-review-bar.ts` (the bar itself, split out so neither file carries the
 * other's concern). Both locate this repository's own §1 sentence in the same
 * way and both assert through the same counter, so a rewording of §1 fails
 * loudly in both instead of leaving one asserting a quote that no longer
 * exists in the doctrine.
 */
import type { Finding } from "../../src/lens-review-types.ts";
import type { DoctrineDoc } from "../../src/work-driver-policy.ts";

let failed = 0;

/** Counted assertion: prints `✓`/`✗` and remembers a failure for the exit code. */
export function assert(cond: boolean, msg: string): void {
  if (cond) console.log(`✓ ${msg}`);
  else {
    console.error(`✗ ${msg}`);
    failed++;
  }
}

/** Non-zero when any `assert` in this process failed. */
export function failureCount(): number {
  return failed;
}

/** A one-line finding at `severity`, for verdict assertions. */
export const mkFinding = (severity: Finding["severity"], lens = "SIMPLICITY"): Finding => ({
  lens,
  severity,
  path: "src/a.ts",
  line: 1,
  title: `a ${severity} finding`,
  description: "",
});

/** One doctrine document, as the resolver's callers hand it. */
export const docs = (text: string): DoctrineDoc[] => [{ file: "AGENTS.md", text }];

/**
 * The §1 sentences that could set this repo's own blocking bar, read out of
 * AGENTS.md rather than hard-coded so a rewording cannot leave a test asserting
 * a quote that no longer exists in the doctrine.
 *
 * Split on sentence FINAL punctuation, not on every period: the paragraph's
 * first sentence ends inside markdown bold (`…and above.**`), so a bare
 * `(?<=\.)` split glues sentences 1 and 2 together and both counts lie. Bold
 * markers and whitespace are stripped by `normaliseForCitation`, so the leading
 * `**` / trailing `.` fragment still verifies as a citation.
 */
export const ownBlockingSentences = (doctrine: string): string[] => {
  const para = doctrine
    .split("\n")
    .find((line) => line.startsWith("**Six-pass review findings are blocking"));
  return (para ?? "")
    .split(/(?<=[.!?])\*\*|(?<=[.!?])\s+/)
    .map((s) => s.trim())
    .filter(Boolean);
};

/** The §1 sentence that states the bar, matched by relation rather than value. */
export const HIGH_BAR = /^\**Six-pass review findings are blocking at [A-Z]+ severity and above\.*$/;

/**
 * The repository root. Resolved from `import.meta.url` rather than the process
 * cwd, so the suite reads the doctrine of the checkout it lives in whatever
 * directory the verify loop was started from.
 */
export const repoRoot = (): string => new URL("../../../", import.meta.url).pathname.replace(/\/$/, "");
