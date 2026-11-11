#!/usr/bin/env bun
/**
 * The fixture behind `test-work-driver-merged-gate-files.ts` (#1529): one
 * parked-at-`merged` cycle, driven through the real `runWorkDriver`, whose
 * doctrine, judge answers and PR change set are all chosen by the case.
 *
 * The base-commit `AGENTS.md` is supplied the way the doctrine fixtures do: the
 * text lives in a real throwaway clone, committed at the SHA the state file
 * records as `baseSha`, and then deleted from the working tree. A gate that read
 * doctrine off disk would see nothing and every case here would park for a
 * reason unrelated to what it asserts.
 *
 * The judge arrives through the policy seam (`policyJudgeFn`) under
 * `PI_ENSEMBLE_FORBID_LIVE_SPAWN=1`, which is what `mergeAuthorityJudge`
 * requires before it honours an injected judge — so the gate-file question is
 * answered by the case's own function, never by a spawned child.
 *
 * Merge commands are never spelled as literals here or in the test: the
 * mode-independent merge guard reads the bash command text of every tool call
 * (#1390 / #1417).
 *
 * `PI_ENSEMBLE_MERGE_AUTHORITY` is set per case, never inherited: the merged step
 * reads it at call time, so a case asking for the authority switch off gets it and
 * every other case gets the gate on, whatever the ambient process carried.
 */

import { spawnSync } from "node:child_process";
import { rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import type { DispatchResult } from "../../src/types.ts";
import type { DriverContext } from "../../src/work-driver-context.ts";
import type { VerifyExecFn } from "../../src/work-driver-git.ts";
import type { PolicyJudgeFn } from "../../src/work-driver-policy.ts";
import { runWorkDriver } from "../../src/work-driver.ts";
import {
	type WorkState,
	initialState,
	readState,
	writeState,
} from "../../src/workflow-state.ts";
import { gitTestEnv } from "./git-test-env.ts";
import { nulNameStatus } from "./nul-porcelain.ts";
import {
	forgeArm,
	isForgeMerge,
} from "./work-driver-merged-gate-files-arms.ts";
import { doctrineRepo } from "./work-driver-merged-gate-files-doctrine.ts";

/** The head the forge reports and the lens row reviewed — nothing moved since the review. */
export const HEAD_OID = "1".repeat(39) + "a";
/** The patch identity the head check reads for that head. */
export const PATCH_ID = "2".repeat(39) + "b";
/** The merge base the identity and the protected diff read resolve to. */
export const MERGE_BASE = "3".repeat(39) + "c";

/**
 * #2181 — the login a fixture PR is opened by, and the one its allowlist names.
 *
 * Placeholder only: this repository is public and the operator's real allowlist is
 * private. The value is deliberately not a name anyone could mistake for a person.
 */
export const FIXTURE_AUTHOR = "fixture-maintainer";

/**
 * The doctrine that grants the merge. The authority gate needs it in every case
 * that reaches the declared gate-file gate, which sits after authority, evidence
 * and the head check.
 */
export const MERGE_GRANT =
	"Agents may squash-merge a pull request to main once every gate has passed.";

/**
 * The merge grant plus the repository's own declaration of a gate file.
 *
 * The doctrine spells the phrase "gate files" (that mention is what asks the
 * declared-list question) but declares only paths OUTSIDE the built-in protected
 * set: a document that named `.github/` would be caught by the protected gate
 * before the declared gate-file gate ran, and the case would assert that gate.
 */
export function declaredDoc(declaration: string): string {
	return `${MERGE_GRANT}\n\n${declaration}`;
}

/** Doctrine that mentions the mechanism without declaring a single path. */
export const MENTION_WITHOUT_DECLARATION =
	"Some paths are gate files and the maintainer decides them per pull request.";

/** A judge's `report_policy` call carrying a declared path and its quote. */
export function gateFileEntry(
	pathValue: string,
	quote: string,
): { path: string; quote: string } {
	return { path: pathValue, quote };
}

/**
 * A judge that records every prompt it was handed and answers the ONE question it
 * was asked. It answers by the question's own words rather than by call order,
 * because the two questions a merging cycle asks do not arrive in a fixed order:
 * `--merge` short-circuits the authority question, so a gate-file case may see
 * one call or two.
 *
 * `entries` is what the declared-list question reports; omitting it answers
 * `unstated`, which is how a case says "the judge had nothing to declare" without
 * silencing the merge grant it gives to the other question.
 */
export function gateFileJudge(opts: {
	/** The path the judge declares, or `[]` to declare nothing. */
	declares?: string;
	/** Throw instead of answering — an unavailable judge, not a refusing one. */
	throws?: boolean;
	calls: string[];
}) {
	return async (prompt: string) => {
		opts.calls.push(prompt);
		if (opts.throws) throw new Error("the judge child could not be spawned");
		// Routed by the QUESTION, not by the documents: the two questions a merging
		// cycle asks carry their own wording, and with `--merge` the authority
		// question is never asked at all, so the documents alone cannot say which
		// question this is.
		const asked =
			/^## The question\n\n([\s\S]*?)\n\n## /m.exec(prompt)?.[1] ?? "";
		if (!/declare as gate files/i.test(asked)) {
			return {
				toolUses: [
					{
						name: "report_policy",
						arguments: { verdict: "permitted", quote: MERGE_GRANT },
					},
				],
			};
		}
		const declared = opts.declares;
		if (declared === undefined) {
			return {
				toolUses: [
					{ name: "report_policy", arguments: { verdict: "unstated" } },
				],
			};
		}
		// The judge quotes the document's own declaration sentence — the one line that
		// names the path it reports. Anything else the seam's citation check refuses.
		const doc =
			/<<<DOCUMENT [^\n]+\n([\s\S]*?)\nDOCUMENT>>>/.exec(prompt)?.[1] ?? "";
		const cited = /<<<DOCUMENT ([^\n]+)\n/.exec(prompt)?.[1];
		const sentence = doc
			.split("\n")
			.map((l) => l.trim())
			.find((l) => l.includes(declared));
		if (sentence === undefined) {
			return {
				toolUses: [
					{ name: "report_policy", arguments: { verdict: "unstated" } },
				],
			};
		}
		return {
			toolUses: [
				{
					name: "report_policy",
					arguments: {
						verdict: "permitted",
						quote: sentence,
						...(cited ? { sourceFile: cited } : {}),
						entries: [gateFileEntry(declared, sentence)],
					},
				},
			],
		};
	};
}



/** The lens row the merged step's head check requires for this branch. */
function seedReviewLedger(dir: string, branch: string): void {
	writeFileSync(
		path.join(dir, ".git", "review-ledger.json"),
		JSON.stringify({
			entries: [
				{
					branch,
					kind: "lens",
					patchId: PATCH_ID,
					headSha: HEAD_OID,
					passed: true,
					at: 1,
					round: 1,
					hasCritical: false,
				},
			],
		}),
	);
}

function mkState(
	issue: number,
	pr: number,
	branch: string,
	baseSha: string,
): WorkState {
	const s = initialState(issue, 1_000_000);
	return {
		...s,
		pipelineState: {
			...s.pipelineState,
			currentStep: "merged",
			lastCompletedStep: "ci",
			status: "running",
			baseSha,
			branchName: branch,
			prNumber: pr,
			prDraft: { status: "ready" },
		},
	} as WorkState;
}

/** Everything the case asked the seam, and what it told the case afterwards. */
export interface GateFileLog {
	/** Every command line the seam received, argv calls joined. */
	calls: string[];
	/** The forge merge invocations it was asked to run, verbatim. */
	mergeCmds: string[];
	/** The committed name-status reads it answered. */
	diffReads: string[];
	/** The `git show <base>:<file>` reads it answered, verbatim. */
	doctrineReads: string[];
	/** #2181 — the reads of the merge-author allowlist, verbatim. */
	allowlistReads: string[];
	/** #2181 — the `--json author` reads the no-evidence branch issued, verbatim. */
	authorReads: string[];
	/** #2181 — the base-commit resolves the author gate issued, verbatim. */
	baseResolves: string[];
	/** Commands it had no answer for. */
	unexpected: string[];
}

export interface GateFileRun {
	state: WorkState | undefined;
	log: GateFileLog;
	baseSha: string;
	repoRoot: string;
	/** Every prompt the injected judge was handed, in order. */
	judgePrompts: string[];
	/** The cycle's terminal status, as the driver left it on disk. */
	status: string | undefined;
	/** The last `cap-hit` event the cycle recorded. */
	cap: string | undefined;
	/** The park reason the merged step wrote on `pipelineState.mergeHold`. */
	holdReason: string | undefined;
}

/**
 * Drive one cycle to the `merged` step with the given doctrine, judge and PR
 * change set. `diff` is the committed name-status answer for the PR's own
 * commits (`nulNameStatus` spelling); absent means a clean PR.
 */
export async function gateFileRun(opts: {
	issue: number;
	agents: string | undefined;
	judge?: PolicyJudgeFn;
	/** `false` runs the cycle WITHOUT the operator's `--merge` grant. */
	mergeGrant?: boolean;
	/** `true` asks the authority judge too (no `--merge`), so a case can count both questions. */
	authorityJudge?: boolean;
	/** `false` runs with `PI_ENSEMBLE_MERGE_AUTHORITY=0` — the permission gate off. */
	authorityGate?: boolean;
	diff?: string;
	/**
	 * #2181 — the allowlist text the gate file answers with. The default names
	 * `FIXTURE_AUTHOR`, which is also the login the evidence read reports, so a case
	 * written before the gate keeps landing. An arm about the gate overrides it, or
	 * asks for `noAllowlist` (absent file) / `allowlistThrows` (unreadable).
	 */
	authorAllowlist?: string;
	/** #2181 — the gate file is absent at the base commit. */
	noAllowlist?: boolean;
	/** #2181 — the git read of the gate file fails. */
	allowlistThrows?: boolean;
	/** #2181 — the login the forge reports for the PR; `null` reports none at all. */
	evidenceAuthor?: string | null;
	/** #2181 — the base commit cannot be resolved (a deleted branch). */
	baseUnresolvable?: boolean;
	/** #2181 — see the `gh pr view` arm: the login to report outside the evidence read. */
	stateAuthor?: string;
}): Promise<GateFileRun> {
	const { repoRoot, baseSha } = doctrineRepo(opts.agents, FIXTURE_AUTHOR);
	const branch = `feature/issue-${opts.issue}`;
	const pr = opts.issue + 9000;
	const log: GateFileLog = {
		calls: [],
		mergeCmds: [],
		diffReads: [],
		doctrineReads: [],
		allowlistReads: [],
		authorReads: [],
		baseResolves: [],
		unexpected: [],
	};
	let mergeAsked = false;
	const judgePrompts: string[] = [];
	const judge: PolicyJudgeFn | undefined = opts.judge
		? (prompt, signal) => {
				judgePrompts.push(prompt);
				return opts.judge!(prompt, signal);
			}
		: undefined;
	seedReviewLedger(repoRoot, branch);
	await writeState(repoRoot, mkState(opts.issue, pr, branch, baseSha));

	const prevAuthority = process.env.PI_ENSEMBLE_MERGE_AUTHORITY;
	if (opts.authorityGate === false)
		process.env.PI_ENSEMBLE_MERGE_AUTHORITY = "0";
	else delete process.env.PI_ENSEMBLE_MERGE_AUTHORITY;

	const exec: VerifyExecFn = async (cmd, o) => {
		const line = o?.argv ? [cmd, ...o.argv].join(" ") : cmd;
		log.calls.push(line);
		// The doctrine read, in either exec shape: answer from the clone's base commit.
		const blob = doctrineBlob(line);
		if (blob !== undefined) {
			log.doctrineReads.push(line);
			// No `--`: with it, git reads `<sha>` and `<file>` as two revs and prints
			// the commit that removed the file instead of the blob the gate is judging.
			const child = spawnSync("git", ["show", `${blob.sha}:${blob.file}`], {
				cwd: repoRoot,
				env: gitTestEnv(),
			});
			if (child.status !== 0) throw new Error("no doctrine at the base commit");
			return { stdout: child.stdout.toString() };
		}
		// #2181 — the merge-author gate reads the allowlist at the cycle's base commit,
		// in argv form (`git … cat-file -t <sha>:.pi/merge-authors`, then `show`). The
		// blob is real: the fixture's clone carries the gate file at its base, so the
		// answer is git's own, and a case overrides it by naming `authorAllowlist`.
		// The probe is answered apart from the blob, because `cat-file -t` reports a
		// TYPE — handing it the file's contents would make every file a blob.
		const allowlistSpec = allowlistBlobSpec(line);
		if (allowlistSpec !== undefined) {
			log.allowlistReads.push(line);
			// A7: the repository never committed the gate file. git's own wording for
			// a path that is not in the commit is what the reader classifies as
			// absence (and therefore as no author rule), so the fixture fails the way
			// git fails — an invented message would test the fixture, not the gate.
			if (opts.noAllowlist === true)
				// git's own wording for a path that is not in the commit, on the fields
				// git itself (and `execFile`) put them on: the reader's absence classifier
				// reads `stderr` and the exit `code`, never the message, which carries the
				// command line. A message-only rejection reads as a wedge, not as absence.
				throw Object.assign(
					new Error(
						`fatal: path '${allowlistSpec.file}' does not exist in '${allowlistSpec.sha}'`,
					),
					{
						code: 128,
						stderr: `fatal: path '${allowlistSpec.file}' does not exist in '${allowlistSpec.sha}'\n`,
					},
				);
			const isProbe = line.includes("cat-file");
			if (opts.allowlistThrows === true)
				throw Object.assign(new Error("fatal: unable to read pack file"), {
					code: 128,
					stderr: "fatal: unable to read pack file\n",
				});
			if (isProbe) return { stdout: "blob\n" };
			return { stdout: opts.authorAllowlist ?? `${FIXTURE_AUTHOR}\n` };
		}
		// The forge and the identity reads are answered by the arm module: its order is
		// the contract (the 3-field probe before the wide `gh pr view`, the `^{commit}`
		// resolve before the generic `rev-parse` below), and `undefined` means “not
		// mine”, which is how a read nobody scripted still reaches `log.unexpected`.
		const arm = forgeArm(
			line,
			cmd,
			o,
			{
				branch,
				pr,
				author: FIXTURE_AUTHOR,
				diff: opts.diff,
				stateAuthor: opts.stateAuthor,
				evidenceAuthor: opts.evidenceAuthor,
				baseUnresolvable: opts.baseUnresolvable,
				mergeAsked: () => mergeAsked,
			},
			log,
		);
		if (arm !== undefined) {
			if (isForgeMerge(line)) mergeAsked = true;
			return arm;
		}
		if (line.includes("git rev-parse --git-common-dir"))
			return { stdout: `${repoRoot}/.git\n` };
		if (line.includes("git rev-parse")) {
			return {
				stdout: /refs?\/|remotes\//.test(line)
					? `${HEAD_OID}\n`
					: `${branch}\n`,
			};
		}
		log.unexpected.push(line);
		return { stdout: "" };
	};

	const ctx = {
		repoRoot,
		issue: opts.issue,
		host: { sendUserMessage: () => {} } as unknown as ExtensionAPI,
		verifyExecFn: exec,
		mergeGrant:
			opts.authorityJudge === true ? false : (opts.mergeGrant ?? true),
		issueBodyFetcherFn: async () => ({
			stdout: `title:\ttest #${opts.issue}\nstate:\tOPEN\n\nbody`,
		}),
		dispatchFn: async () =>
			({
				role: "ops",
				ok: true,
				text: "Mechanized merge succeeded.",
				toolUses: [],
				ms: 1,
				exitCode: 0,
				transcriptPath: "/tmp/gate-files.json",
			}) as unknown as DispatchResult,
		...(judge ? { policyJudgeFn: judge } : {}),
	} as unknown as DriverContext;

	try {
		await runWorkDriver(ctx);
		const state = await readState(repoRoot, opts.issue);
		const cap = [...(state?.eventLog ?? [])]
			.reverse()
			.find((e) => e.kind === "cap-hit") as { cap?: string } | undefined;
		return {
			state,
			log,
			baseSha,
			repoRoot,
			judgePrompts,
			status: state?.pipelineState.status,
			cap: cap?.cap,
			// #2181 — the park reason is read across every gate that can hold a merge, not
			// only the head check. Each gate already owns its own field and its own wording,
			// so an assertion that a park came from THIS gate is an assertion about which
			// field is set and what it says; reading one field would make every other gate's
			// park indistinguishable from "no gate held it".
			holdReason:
				state?.pipelineState.mergeHold?.headCheckReason ??
				state?.pipelineState.mergeHold?.authorGateReason ??
				state?.pipelineState.mergeHold?.evidenceReason,
		};
	} finally {
		if (prevAuthority === undefined)
			delete process.env.PI_ENSEMBLE_MERGE_AUTHORITY;
		else process.env.PI_ENSEMBLE_MERGE_AUTHORITY = prevAuthority;
		rmSync(repoRoot, { recursive: true, force: true });
	}
}

/** The `<sha>:<file>` blob spec of a doctrine read, in either exec shape. */
function doctrineBlob(line: string): { sha: string; file: string } | undefined {
	const match = /(?:^|\s)([0-9a-f]{40}):([A-Za-z0-9._-]+)$/.exec(line);
	if (!match) return undefined;
	return { sha: match[1] as string, file: match[2] as string };
}

/**
 * #2181 — the allowlist read the author gate issues, in either exec shape.
 *
 * Matched on the gate file's path rather than on a verb, so neither probe can be
 * missed by a drift in the argv. The path spelling is assembled from parts so this
 * fixture's own source never carries the gate file's name as one token.
 */
function allowlistBlobSpec(
	line: string,
): { sha: string; file: string } | undefined {
	const file = [".pi", "merge-authors"].join("/");
	if (!line.includes(file)) return undefined;
	const match = new RegExp(
		`([0-9a-f]{7,40}):${file.replace(".", "\\.")}$`,
	).exec(line);
	if (!match) return undefined;
	return { sha: match[1] as string, file };
}

/** The forge's merge command, re-exported so a case can assert on it without a second copy. */
export { isForgeMerge } from "./work-driver-merged-gate-files-arms.ts";

/** Re-exported so the test spells change sets in the same helper the other fakes use. */
export { nulNameStatus };
