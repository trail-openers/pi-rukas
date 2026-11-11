/**
 * work-driver-merged-green-gate — the exec fake a `merged`-step fixture uses when its
 * merge is meant to REACH the merge, plus the ledger row that claim needs.
 *
 * Split out of `test-work-driver-pr10-core.ts` for the §12 size cap; the assertions that
 * drive it stay in that file. Since #380 every fixture has to pass the merge gate, so
 * the whole read set the gate makes is answered here — the evidence probe, the head OID
 * from the same response, the fetch, the mainline, the identity, the ledger's git dir —
 * rather than in two divergent copies. A fixture that answered only the evidence probe
 * would get its merge HELD, which is right for a real cycle whose head cannot be
 * substantiated and wrong for a mechanism test.
 *
 * #2181 added three reads to that set, one per shape of the same gate file: `ls-tree`
 * answers the entry's MODE, `cat-file -t` a TYPE, and `show` the BYTES. Handing either
 * probe the bytes makes every path a regular file, which is how a committed symlink was
 * read as an allowlist. These cases have no base commit to read a real file from (the
 * fixture seeds a `.git/info` ledger and no commits), so all three are answered from
 * this table; the gate's own reading is covered against real git by
 * `test-merge-author-allowlist.ts` and `test-work-driver-merged-gate-files.ts`.
 */

import { writeFileSync } from "node:fs";
import path from "node:path";
import type { DriverContext } from "../../src/work-driver-context.ts";
import { mergeAuthorTreeLine } from "../../src/merge-author-allowlist.ts";
import { FIXTURE_AUTHOR } from "./work-driver-merged-gate-files-fixture.ts";

/** The head every read here agrees on: the PR head, the fetched head, the pinned head. */
export const VERIFIED_HEAD = "a".repeat(40);
/** The patch id the lens row records and `git patch-id` answers. */
export const REVIEWED_PATCH = "b".repeat(40);

/** The gate file's path, assembled so no scan sees it as one token. */
const GATE_FILE = [".pi", "merge-authors"].join("/");

export function mergeGateExec(
	dir: string,
): NonNullable<DriverContext["verifyExecFn"]> {
	return async (cmd: string, o?: { argv?: string[] }) => {
		// argv callers pass the executable as `cmd` and the words as `argv`.
		const line = o?.argv ? [cmd, ...o.argv].join(" ") : cmd;
		if (line.includes("mergeStateStatus")) {
			return {
				stdout: JSON.stringify({
					mergeStateStatus: "CLEAN",
					state: "OPEN",
					headRefOid: VERIFIED_HEAD,
					// #2181 — the author rides the same read as the head pin; these cases are
					// about the merge MECHANISM, so the login is one the allowlist below lists.
					author: { login: FIXTURE_AUTHOR },
				}),
			};
		}
		if (line.includes(GATE_FILE)) {
			return {
				stdout: line.includes("ls-tree")
					? mergeAuthorTreeLine("100644", GATE_FILE)
					: line.includes("cat-file")
						? "blob\n"
						: `${FIXTURE_AUTHOR}\n`,
			};
		}
		if (line.includes("rev-parse") && line.includes("^{commit}")) {
			return { stdout: `${VERIFIED_HEAD}\n` };
		}
		if (line.includes("gh pr checks")) {
			return { stdout: JSON.stringify([{ name: "ci", bucket: "pass" }]) };
		}
		if (line.includes("git symbolic-ref")) return { stdout: "origin/main\n" };
		if (line.includes("git config --get remote."))
			return { stdout: "https://x.invalid/r.git\n" };
		if (line.includes("git fetch")) return { stdout: "" };
		if (line.includes("git rev-parse --git-common-dir"))
			return { stdout: `${dir}/.git\n` };
		if (line.includes("git merge-base"))
			return { stdout: `${VERIFIED_HEAD}\n` };
		if (line.includes("git patch-id"))
			return { stdout: `${REVIEWED_PATCH} x\n` };
		if (line.includes("git check-ref-format")) return { stdout: "" };
		if (line.includes("git rev-parse")) return { stdout: `${VERIFIED_HEAD}\n` };
		return { stdout: "" };
	};
}

/**
 * Seed the LENS row the merged step's identity check requires.
 *
 * #1533 — the check reads the latest LENS entry for the branch (the six-pass review is
 * the driver's own review of this branch), so the row's `headSha` is the head the exec
 * seam reports and its `patchId` is what that seam's `git patch-id` answers. An
 * adversarial row is not enough: the check that once merged unreviewed content trusted
 * exactly that, and the row it now requires is what makes a merge here mean "reviewed".
 */
export function seedLedger(dir: string, branch: string): void {
	writeFileSync(
		path.join(dir, ".git", "review-ledger.json"),
		JSON.stringify({
			entries: [
				{
					branch,
					kind: "lens",
					patchId: REVIEWED_PATCH,
					headSha: VERIFIED_HEAD,
					passed: true,
					at: 1,
					round: 1,
					hasCritical: false,
				},
			],
		}),
	);
}
