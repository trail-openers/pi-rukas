#!/usr/bin/env bun
/**
 * #476 — `restoreCheckout` is REACHED on a successful merge.
 *
 * Split out of `test-work-driver-merged-mechanized.ts` along the concern seam
 * (§12 size cap): the unit blocks in that file pin the command SEQUENCE, this
 * one pins REACHABILITY. `runMerged` used to gate restoration on
 * `ctx.verifyExecFn`, a test-only seam neither production entry point sets, so
 * on a real merge the checkout was never restored, refs never pruned, and
 * `branch -d` never attempted — every sequence assertion in the sibling file
 * still passed because each one called the function directly.
 *
 * This block drives `runMerged` with `verifyExecFn` injected as a recording
 * fake: merge succeeds, restoration is observed (fetch origin --prune /
 * checkout / pull --ff-only / branch -d), and a `branch -d` refusal lands in a
 * `Checkout restoration` plumb-report rather than halting.
 *
 * The literal production shape — `verifyExecFn` absent, so the driver's
 * `ctx.verifyExecFn ?? execp` fallback resolves to the real executor — is
 * asserted in the -live sibling
 * test-work-driver-merged-mechanized-prod-restore-live.ts, which cannot run
 * offline (real execp shells out to git/gh).
 */

import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { mergeAuthorTreeLine } from "../src/merge-author-allowlist.ts";
import { runMerged } from "../src/work-driver-merged.ts";
import type { VerifyExecFn } from "../src/work-driver-git.ts";
import { setupSpawnGuard } from "./test-helpers.ts";
import { mkStateMerged } from "./work-driver-merged-fixtures.ts";
import {
	HEAD_OID,
	mkCtx,
	mkExec,
} from "./lib/work-driver-merged-pin-helpers.ts";
import { FIXTURE_AUTHOR } from "./lib/work-driver-merged-gate-files-fixture.ts";

let exit = 0;
function assert(cond: boolean, msg: string): void {
	if (cond) console.log(`✓ ${msg}`);
	else {
		console.error(`✗ ${msg}`);
		exit = 1;
	}
}

setupSpawnGuard();

{
	const dir = mkdtempSync(path.join(tmpdir(), "mm-prod-restore-"));
	try {
		const calls: string[] = [];
		const base = mkExec({
			// The mainline probe (#1093: a validated ref) must get the branch name;
			// the broader "gh repo view" key below answers the repo-settings query.
			"gh repo view --json defaultBranchRef": { stdout: "main\n" },
			// The merge-evidence probe is a `gh pr view` too, and it PARSES its
			// answer: the generic "gh pr view" key below (a plain `MERGED` token, for
			// the pre/post-merge state reads) would otherwise make the gate fail
			// closed with "could not read PR state" before the merge was attempted.
			// Listing it first also means the state reads never see the JSON.
			"mergeStateStatus,mergeable,state": {
				// #2181 — the author rides the same evidence read as the head pin; without
				// it the merge-author gate refuses below as an unreadable author. Answered as
				// an OBJECT (`author.login`), which is the shape gh reports and the shape the
				// gatherer reads — a bare string here is a missing author, not a login.
				stdout: `{"mergeStateStatus":"CLEAN","state":"OPEN","headRefOid":"${HEAD_OID}","author":{"login":"${FIXTURE_AUTHOR}"}}`,
			},
			// #2181 — the merge-author gate's reads. The allowlist names the same login the
			// evidence read reports, so a case written before the gate keeps reaching the
			// restoration path its assertions are about. Matched on the gate file's path
			// with the two probes answered separately, because neither may receive the blob:
			// `ls-tree` answers the entry's MODE and `cat-file -t` a TYPE — the probe keys
			// have to come first.
			"ls-tree": {
				stdout: mergeAuthorTreeLine("100644", ".pi/merge-authors"),
			},
			"cat-file": { stdout: "blob\n" },
			".pi/merge-authors": { stdout: `${FIXTURE_AUTHOR}\n` },
			"^{commit}": { stdout: `${HEAD_OID}\n` },
			"gh pr checks": { stdout: '[{"name":"ci","bucket":"pass"}]' },
			"gh repo view": {
				stdout:
					'{"squashMergeAllowed":true,"mergeCommitAllowed":false,"rebaseMergeAllowed":false}',
			},
			// executeAndVerifyMerge checks `stdout.trim() === "MERGED"` on the
			// plain-text `--jq '.state'` output — answer with the plain token.
			"gh pr view": { stdout: "MERGED\n" },
			// The identity comparison needs a git common dir to read the review ledger
			// from; this fixture's directory is not a clone, so the read fails and the
			// check degrades to the pin plus an honest note (which is what the merged
			// step does for a state file with no clone behind it).
			"git rev-parse --git-common-dir": {
				error: true,
				stderr: "not a git repository",
			},
			// The merge-time protected-path gate runs before anything merges and
			// fails closed on any read it cannot answer: remote, mainline, the merge
			// base. Its committed diff is answered by the shared fake through the
			// production argv constants, so it needs no key of its own here.
			"git config --get remote.": { stdout: "https://x.invalid/r.git\n" },
			"git remote": { stdout: "origin\n" },
			"git symbolic-ref": { stdout: "origin/main\n" },
			"git rev-parse --verify origin/": { stdout: `${HEAD_OID}\n` },
			"git merge-base": { stdout: `${"9".repeat(39)}f\n` },
			"git fetch": { stdout: "" },
			"git rev-parse": { stdout: "feature/issue-476\n" },
			// The restore's ref validation (restoreRefProblem) needs its own arm: the
			// `git rev-parse` answer above does not cover that call, and without it
			// the restore-sequence assertions lose their validate step.
			"git check-ref-format": { stdout: "" },
			"git status": { stdout: "" },
			"git checkout": { stdout: "" },
			"git pull": { stdout: "" },
			// The refusal is the point: a failed `branch -d` must become a
			// plumb-report, not a halt.
			"git branch -d": { error: true, stderr: "not fully merged" },
		});
		// The recorder is the driver's executor: every command it issues is
		// recorded, and any command the fakes above do not cover would touch the
		// outside world in production — throw instead.
		const recorder: VerifyExecFn = async (cmd, opts) => {
			// Argv calls (#1093) are recorded as the joined command line.
			const line = opts?.argv ? [cmd, ...opts.argv].join(" ") : cmd;
			calls.push(line);
			try {
				return await base.fn(cmd, opts);
			} catch (err) {
				if (line.includes("git branch -d")) throw err;
				throw new Error(`offline test: unmocked command: ${line}`);
			}
		};

		// mkCtx supplies mergeGrant + issueBodyFetcherFn; only repoRoot and the
		// dispatchFn differ from that helper's defaults here.
		const ctx = mkCtx(476, recorder, {
			repoRoot: dir,
			dispatchFn: async () => {
				// The mechanized merge must succeed so the ops fallback dispatch
				// (a real Pi spawn) is never attempted.
				throw new Error(
					"offline test: fallback dispatch should not be reached",
				);
			},
		});

		const state = mkStateMerged(476, 4761, "feature/issue-476", {
			baseSha: "HEAD",
			worktrees: { task_b: "" },
		});
		const out = await runMerged(
			ctx as unknown as Parameters<typeof runMerged>[0],
			state,
			Date.now(),
		);

		assert(
			out.pipelineState.status === "merged",
			"#476: mechanized merge succeeded → status='merged'",
		);
		assert(
			calls.some((c) => c.includes("git fetch origin --prune")),
			"#476: fetch origin --prune ran on the successful-merge path",
		);
		assert(
			calls.some((c) => c.includes("git checkout")) &&
				calls.some((c) => c.includes("git pull --ff-only")),
			"#476: checkout + pull --ff-only ran on the successful-merge path",
		);
		const branchD = calls.find((c) => c.includes("git branch -d"));
		assert(
			branchD?.includes("feature/issue-476") === true,
			"#476: branch -d targeted the cycle's feature branch",
		);
		const notes = out.eventLog.filter(
			(e) =>
				e.kind === "plumb-report" &&
				/Checkout restoration: .*branch -d/.test(e.body),
		);
		assert(
			notes.length >= 1,
			"#476: branch -d refusal emitted as a plumb-report note (restoration reached)",
		);
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
}

process.exit(exit);
