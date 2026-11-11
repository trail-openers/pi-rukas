/**
 * work-driver-merged-gate-files-arms — the forge/gate arms of `gateFileRun`'s exec
 * fake, split out of `work-driver-merged-gate-files-fixture.ts` for the §12 cap.
 *
 * The fixture drives a parked-at-`merged` cycle through the real driver, and every
 * `gh`/`git` read that step makes has to be answered or it lands in `unexpected`
 * and fails the case's clean-log assertion. The fixture keeps the arms that read
 * its own throwaway clone (doctrine, the allowlist blob); this file answers the
 * forge and the identity reads, which are tables rather than repository reads.
 *
 * ORDER IS THE CONTRACT. Each arm matches a substring, so an arm that moves can
 * silently swallow a read meant for another: the 3-field evidence probe has to
 * precede the wide `gh pr view`, and an unanswered read must fall through to the
 * caller's `unexpected` bucket rather than being answered here. An arm that returns
 * `undefined` says "not mine" and the caller decides.
 */

import { commandOf } from "./argv-shell.ts";
import { isNulDiffRead } from "./nul-porcelain.ts";
import {
	HEAD_OID,
	MERGE_BASE,
	PATCH_ID,
} from "./work-driver-merged-gate-files-fixture.ts";

/** What the caller's seam asks this arm to report. */
export interface ForgeArms {
	branch: string;
	pr: number;
	/** The login the fixture's allowlist names and its evidence read reports. */
	author: string;
	/** The committed name-status answer for the PR's own commits; absent = a clean PR. */
	diff?: string;
	/** The login to report outside the evidence read — see the fixture's `stateAuthor`. */
	stateAuthor?: string;
	/** The login the evidence read reports; `null` reports none at all. */
	evidenceAuthor?: string | null;
	/** Whether the forge merge has been asked for (the stateful OPEN → MERGED flip). */
	mergeAsked: () => boolean;
	/** `true` makes the base-commit resolve fail (a deleted branch). */
	baseUnresolvable?: boolean;
}

/** The buckets each arm records its read into, on the caller's log. */
export interface ForgeArmLog {
	mergeCmds: string[];
	diffReads: string[];
	authorReads: string[];
	baseResolves: string[];
}

/** The forge's merge command, matched without spelling it in this file. */
export function isForgeMerge(line: string): boolean {
	return /\bpr\s+merge\b/.test(line);
}

/**
 * Answer one read of the forge/gate table, or `undefined` for "not my arm".
 *
 * The recorder fields are the caller's own: each arm pushes to the bucket its case
 * asserts on, so splitting the arms moves no assertion's evidence.
 */
export function forgeArm(
	line: string,
	cmd: string,
	o: { argv?: string[] } | undefined,
	opts: ForgeArms,
	log: ForgeArmLog,
): { stdout: string } | undefined {
	// #2181 — the evidence read: `author` rides the same `gh pr view` as the head pin,
	// so the login the merge-author gate judges and the commit it pins describe one
	// moment on the forge. Matched before the wide `gh pr view` below: that arm's field
	// list also mentions `mergeStateStatus`, and handing the gatherer the identity
	// payload (no verdict, no full OID) would refuse for an unrelated reason.
	if (line.includes("mergeStateStatus,mergeable,state")) {
		const author =
			opts.evidenceAuthor === null
				? "null"
				: JSON.stringify({ login: opts.evidenceAuthor ?? opts.author });
		return {
			stdout: `{"mergeStateStatus":"CLEAN","mergeable":"MERGEABLE","state":"OPEN","headRefOid":"${HEAD_OID}","author":${author}}`,
		};
	}
	// #2181 — the shared gate resolves a ref-shaped base (`origin/main`) to an OID
	// before reading the allowlist. Matched on the `^{commit}` peel, which nothing else
	// in the merged step issues, and ahead of the caller's generic `git rev-parse` arm:
	// that one answers a ref question with a value the gate refuses as "did not resolve
	// to a commit", which would park the case for the wrong reason. Checked BEFORE the
	// answer, so an arm that asks for a denied resolve cannot be handed the default.
	if (line.includes("rev-parse") && line.includes("^{commit}")) {
		log.baseResolves.push(line);
		if (opts.baseUnresolvable === true)
			throw new Error("fatal: unknown revision");
		return { stdout: `${HEAD_OID}\n` };
	}
	if (line.includes("gh pr checks")) {
		return { stdout: '[{"name":"ci","bucket":"pass","state":"SUCCESS"}]' };
	}
	if (isForgeMerge(line)) {
		log.mergeCmds.push(line);
		return { stdout: "Merged" };
	}
	// #2181 — with the permission gate off (`PI_ENSEMBLE_MERGE_AUTHORITY=0`) the merged
	// step gathers NO evidence, so the author cannot come from the forge and the gate
	// would refuse an author it never had the chance to read. This is the one arm that
	// takes the login from the case rather than the forge, because the cases that use it
	// are about the gate-file park on that branch, and the refusal they must NOT receive
	// is the author's.
	if (opts.stateAuthor !== undefined && line.includes("--json author")) {
		log.authorReads.push(line);
		return { stdout: JSON.stringify({ author: { login: opts.stateAuthor } }) };
	}
	if (line.includes("gh pr view")) {
		return {
			stdout: JSON.stringify({
				number: opts.pr,
				title: "feat(fixture): declared gate files",
				state: opts.mergeAsked() ? "MERGED" : "OPEN",
				url: `https://github.com/f/f/pull/${opts.pr}`,
				headRefName: opts.branch,
				baseRefName: "main",
				mergeable: "TRUE",
				mergeStateStatus: "CLEAN",
				isDraft: false,
			}),
		};
	}
	if (line.includes("gh repo view")) {
		return {
			stdout:
				'{"squashMergeAllowed":true,"mergeCommitAllowed":false,"rebaseMergeAllowed":false}',
		};
	}
	// The publish seam's one visibility question: `false` = public.
	if (cmd === "gh" && o?.argv?.[0] === "api") return { stdout: "false\n" };
	if (line.includes("git config --get remote."))
		return { stdout: "https://github.com/f/f.git\n" };
	if (line.includes("git remote")) return { stdout: "origin\n" };
	if (line.includes("git symbolic-ref")) return { stdout: "origin/main\n" };
	if (line.includes("git merge-base")) return { stdout: `${MERGE_BASE}\n` };
	if (line.includes("git patch-id")) return { stdout: `${PATCH_ID} x\n` };
	// The protected-path gate resolves `origin/<ref>` to an OID before it diffs
	// anything. Keyed on the exact argv the shared OID read issues: a generic
	// catch-all that answered an OID to ANY `rev-parse …origin/` is how a drift off the
	// real command shape would keep passing.
	if (/^git rev-parse --verify origin\/(main|feature\/issue-\d+)$/.test(line))
		return { stdout: `${HEAD_OID}\n` };
	if (isNulDiffRead(commandOf(cmd, o))) {
		log.diffReads.push(line);
		return { stdout: opts.diff ?? "" };
	}
	if (line.startsWith("git fetch")) return { stdout: "" };
	return undefined;
}
