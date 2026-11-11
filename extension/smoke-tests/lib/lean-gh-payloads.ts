/**
 * lib/lean-gh-payloads — what the real `gh` CLI actually answers, byte for byte.
 *
 * The `ci` and `land` suites drive their steps through an injected seam, and a
 * seam shaped by the same reading of the CLI that shaped the parser proves
 * nothing: if both believe `gh pr checks` prints `{name, state, conclusion}`,
 * the test goes green while every real row is discarded as unusable. So the
 * fixtures in this file were **captured from `gh` 2.102.0 against a live PR**
 * (`gh pr view 1930 --repo <a public repo> --json mergeStateStatus,mergeable,
 * state,headRefOid` and `gh pr checks 1930 --repo <same> --json name,state,
 * bucket`), not written from memory, and the field lists are the ones the CLI
 * accepts today:
 *
 *   - `gh pr view --json` exposes `mergeable` (TRUE/FALSE/UNKNOWN/CONFLICTING)
 *     and `mergeStateStatus` (CLEAN/BLOCKED/DIRTY/DRAFT/UNKNOWN). There is no
 *     `isMergeable` field — asking for it fails the whole invocation with
 *     `Unknown JSON field: "isMergeable"`, which is why a seam must not be
 *     allowed to invent one;
 *   - `gh pr checks --json` accepts `name,state,bucket` and **rejects
 *     `conclusion`** (`Available fields: bucket, completedAt, description,
 *     event, link, name, startedAt, ...`). `state` is the raw check state
 *     (`SUCCESS`, `FAILURE`, `PENDING`, …) and `bucket` is gh's own verdict
 *     (`pass`, `fail`, `pending`, `skipping`, …). Both are carried below because
 *     the parser reads `bucket ?? state`, and a fixture that only carried the
 *     field the parser prefers would let the fallback leg rot.
 *
 * `gh` refuses `--jq`/`-q` without `--json`, so "the table form happened to be
 * asked for" is not a shape that can be argued about from here — the argv pins
 * in `test-gh-argv.ts` are what keep `--json` present.
 */

/** The live PR the payloads below were captured from. */
export const REAL_PR_NUMBER = 1930;

/**
 * The login a fixture PR carries, and the one the lean land fixtures' allowlist names
 * (#2181). Placeholder logins only — this repository is public and the real
 * allowlist is the operator's private list.
 */
export const LEAN_FIXTURE_AUTHOR = "fixture-maintainer";

/**
 * `gh pr view <n> --json mergeStateStatus,mergeable,state,headRefOid,author` —
 * verbatim key set and value domains from gh 2.102.0, plus #2181's `author`: the
 * land step reads the login out of THIS reply, so an arm that never names one is
 * exercising the gate's unreadable-author path rather than its verdict. `over` can
 * replace or delete it, which is how an arm drives a stranger or an absent author.
 */
export function realPrViewReply(
	headOid: string,
	over: Record<string, unknown> = {},
): string {
	return JSON.stringify({
		headRefOid: headOid,
		mergeStateStatus: "CLEAN",
		mergeable: "MERGEABLE",
		state: "OPEN",
		author: { login: LEAN_FIXTURE_AUTHOR },
		...over,
	});
}

/**
 * `gh pr checks <n> --json name,state,bucket` — the real rows. Two of them, in
 * the CLI's own key order, all passing, so a green here means the parser read
 * actual gh output rather than a seam's invention.
 */
export const REAL_CHECKS_PASS = [
	{ bucket: "pass", name: "quality-gate", state: "SUCCESS" },
	{ bucket: "pass", name: "offline-smoke", state: "SUCCESS" },
];

/** One real row whose bucket GitHub counts as success and we do not. */
export const REAL_CHECKS_SKIPPED = [
	{ bucket: "skipping", name: "publish-image", state: "SKIPPED" },
];

/** One real failing row. */
export const REAL_CHECKS_FAIL = [
	{ bucket: "fail", name: "quality-gate", state: "FAILURE" },
];

/**
 * Rows whose checks are still running — `bucket: "pending"`, the category
 * `gh pr checks --help` lists and the signal the wait keys on. Captured in the
 * CLI's own key order; `mergeStateStatus` for such a PR is UNSTABLE, which is
 * precisely the value the step used to read as red.
 */
export const REAL_CHECKS_PENDING = [
	{ bucket: "pending", name: "quality-gate", state: "PENDING" },
	{ bucket: "pending", name: "offline-smoke", state: "PENDING" },
];

/**
 * What `gh pr checks <n>` prints WITHOUT `--json`, captured from the same CLI:
 * a TAB-separated human table. Not JSON, so `JSON.parse` throws on it, which is
 * the whole reason the `--json` flag is load-bearing rather than cosmetic.
 */
export const REAL_CHECKS_TABLE =
	"quality-gate\tpass\t17m35s\thttps://github.com/o/r/actions/runs/1/job/1\t\n";
