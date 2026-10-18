/**
 * The claim-scan path-existence probe, as a test can recognise it.
 *
 * `lens-evidence.ts`'s probe calls `execFn("git", { argv: ["cat-file", "-e",
 * treeish] })` — the argv form `execp`/`execFile` honour, and the form the
 * canary in `test-git-range-1153.ts` requires of every `git-range.ts` importer
 * (#1005: a planner- or prose-controlled path reaches git as ONE argument, never
 * through `sh -c`, where `$(…)`, backticks or `;` inside the data would execute).
 *
 * So a fixture that wants to answer the existence question cannot match on a
 * command string any more. Two suites need to (`test-claim-scan.ts` for what the
 * scan reports, `test-claim-scan-probe-cost.ts` for what the probe costs), and
 * a fixture whose fake silently fails to recognise the probe answers "the file
 * exists" for every call — which reads as the scan approving everything and
 * looks green. Shared rather than duplicated for that reason: one definition of
 * "is this the probe", asserted by both suites.
 */

/** The two leading argv elements of the existence probe. */
const PROBE_ARGV = "cat-file -e";

/** Whether this exec call is the `git cat-file -e` path-existence probe. */
export function isClaimScanProbe(
  cmd: string,
  opts?: { argv?: string[] } | undefined,
): boolean {
  return cmd === "git" && (opts?.argv ?? []).slice(0, 2).join(" ") === PROBE_ARGV;
}

/** The tree-ish (`origin/<branch>:<path>`) the probe was handed as one argv element. */
export function claimScanProbeTreeish(opts?: { argv?: string[] } | undefined): string {
  return (opts?.argv ?? [])[2] ?? "";
}
