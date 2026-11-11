#!/usr/bin/env bun
/**
 * #2181 — nobody lands a pull request whose author the operator never allowlisted.
 *
 * The rule: only PRs opened by a small fixed set of maintainer accounts may ever be
 * landed, by any agent, on any path. Before this, "we only land our own PRs" was
 * prose — nothing read `.pi/merge-authors`, so a cycle driven end to end by an agent
 * could land a stranger's PR on the strength of a green board and a passing ledger,
 * both of which describe the CODE rather than who opened it.
 *
 * Three things are pinned here, one per merge path, because the whole point is that
 * they cannot drift:
 *
 *   1. the reader (`merge-author-allowlist.ts`): every way the gate file can fail to
 *      answer — absent, a directory, a symlink, an unreadable blob, a file that names
 *      nobody, an unhexable base — refuses. Absence is never an empty list.
 *   2. the driver's `merged` step and lean's `land` step: a non-allowlisted author
 *      PARKS the cycle and the merge is never issued, and no override env var
 *      (`PI_ENSEMBLE_ALLOW_UNREVIEWED_MERGE`, `PI_ENSEMBLE_MERGE_AUTHORITY`,
 *      `--merge`) turns the refusal off — those speak to reviews and permission.
 *   3. the hand-run guard: the same refusal, reached through the `tool_call` hook.
 *
 * R3 — the author arrives as a READ, not a string. `merge-target` defaults a missing
 * author to the literal `"unknown"`, so a naive check would report "author `unknown`
 * is not allowlisted" for a PR whose author was simply never read: a wrong operator
 * action (open the allowlist) for a different fault (the forge did not answer). The
 * placeholder arms below are what keep the two refusals distinguishable.
 *
 * Out of scope, by R2: the GitLab author mapping. `merge-target` already folds a
 * missing `username` to the same placeholder, and the guard shares the narrowing
 * function, so the shapes above cover it without a glab fixture.
 */

import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	type AuthorRead,
	MERGE_AUTHORS_FILE,
	mergeAuthorGate,
	mergeGuardAuthorRead,
	parseMergeAuthorAllowlist,
	readMergeAuthorAllowlist,
} from "../src/merge-author-allowlist.ts";
import {
	authorFromEvidence,
	heldForMergeAuthor,
} from "../src/merge-guard-author.ts";
import { mergeEvidenceViewCmd } from "../src/forge-commands.ts";
import type { MergeEvidence } from "../src/work-driver-merge-evidence.ts";
import type { MergeTarget } from "../src/merge-target.ts";

let failures = 0;
function assert(cond: boolean, msg: string) {
	if (cond) {
		console.log(`\u2713 ${msg}`);
	} else {
		failures++;
		console.log(`\u2717 ${msg}`);
	}
}

/** A git executor that answers like git, from a fixture table rather than a repo. */
type Arm = {
	/** What `cat-file -t` prints for the spec (default `blob`). */
	type?: string;
	/** What `git show` prints (default the allowlist below). */
	body?: string;
	/** Both reads throw (an unreadable object, a wedged git, a missing repo). */
	throws?: boolean;
	/** Only the `show` throws, the probe answers (a corrupt blob). */
	showThrows?: boolean;
	/** Only the probe throws, the show answers. */
	probeThrows?: boolean;
};
const DEFAULT_BODY = "# the maintainers\nalice\nBob\n";

function gitArm(arm: Arm) {
	const calls: string[] = [];
	const exec = async (
		_cmd: string,
		opts?: { argv?: string[] },
	): Promise<{ stdout: string }> => {
		const argv = opts?.argv ?? [];
		const spec = argv[argv.length - 1] ?? "";
		calls.push(`${argv[0] ?? ""} ${spec}`);
		if (arm.throws === true) throw new Error("fatal: not a git repository");
		const isProbe = argv.includes("cat-file");
		if (isProbe) {
			if (arm.probeThrows === true)
				throw new Error("fatal: unable to read pack file");
			return { stdout: `${arm.type ?? "blob"}\n` };
		}
		if (arm.showThrows === true) throw new Error("fatal: bad object");
		return { stdout: arm.body ?? DEFAULT_BODY };
	};
	return { exec, calls };
}

const SHA = "0123456789abcdef0123456789abcdef01234567";
const ALLOWED: AuthorRead = { ok: true, login: "alice" };

/**
 * Drop comments, so a scan for a name asks whether the CODE reads it.
 *
 * Both gate modules document, in their own headers, the switches they deliberately
 * do NOT consult — which is the point of those paragraphs. Matching prose would fail
 * on the documentation of the guarantee rather than on its absence.
 */
function stripComments(text: string): string {
	return text
		.replace(/\/\*[\s\S]*?\*\//g, "")
		.split("\n")
		.filter((l) => !l.trimStart().startsWith("//"))
		.join("\n");
}

// ------------------------------------------------------------------ the parser
{
	const logins = parseMergeAuthorAllowlist(
		"# comment\n\n  alice  \nBob\n\t\n#another\ncarol/dan\n",
	);
	assert(
		JSON.stringify(logins) === JSON.stringify(["alice", "Bob", "carol/dan"]),
		"parser keeps logins in order, trims whitespace, and drops blanks and comments",
	);
	assert(
		parseMergeAuthorAllowlist("# nobody\n\n\n").length === 0,
		"a file of only comments yields no login — which the reader treats as a refusal, not an open list",
	);
	assert(
		parseMergeAuthorAllowlist("*").includes("*"),
		"a wildcard token is kept verbatim (matching it is the gate's decision, not the parser's)",
	);
}

// ----------------------------------------------------------------- case folding
{
	const { exec } = gitArm({});
	const read = await readMergeAuthorAllowlist(exec, "/r", SHA);
	assert(read.ok === true, "reader answers ok for a blob that names logins");
	if (read.ok) {
		assert(
			read.set.has("alice") && read.set.has("bob"),
			"the set is case-folded at parse time",
		);
		assert(
			!read.set.has("Alice"),
			"the set holds only the folded form — no caller can compare case-wise",
		);
	}
}

// ------------------------------------------------------- the fail-closed matrix
{
	const arms: Array<[string, Arm, string]> = [
		["a directory at the path", { type: "tree" }, "directory"],
		["a symlink at the path", { type: "symlink" }, "symlink"],
		["the path absent from the commit", { probeThrows: true }, "not a file"],
		[
			"an unreadable blob",
			{ probeThrows: true, body: DEFAULT_BODY },
			"not a file",
		],
		["a file naming nobody", { body: "# just a comment\n" }, "names no login"],
		["a git that cannot answer at all", { throws: true }, ""],
	];
	for (const [name, arm, expect] of arms) {
		const { exec } = gitArm(arm);
		const read = await readMergeAuthorAllowlist(exec, "/r", SHA);
		assert(read.ok === false, `reader refuses when ${name}`);
		if (!read.ok) {
			assert(
				expect.length === 0 || (read.detail ?? "").includes(expect),
				`…and the refusal names the cause for "${name}" (${read.reason}: ${read.detail ?? ""})`,
			);
		}
	}
	for (const [name, base] of [
		["no base commit was recorded", undefined],
		["the base is empty", ""],
		["the base is a ref, not a hex sha", "origin/main"],
		["the base is not hex", "not-a-sha"],
	] as Array<[string, string | undefined]>) {
		const { exec, calls } = gitArm({});
		const read = await readMergeAuthorAllowlist(exec, "/r", base);
		assert(read.ok === false, `reader refuses when ${name} (${String(base)})`);
		assert(
			calls.length === 0,
			`…and refuses WITHOUT asking git when ${name} — no read is issued against an unknown commit`,
		);
	}
}

// -------------------------------------------- the buffer bound is a refusal, not a hole
{
	const exec = async (
		_cmd: string,
		opts?: { argv?: string[]; maxBuffer?: number },
	): Promise<{ stdout: string }> => {
		if (opts?.argv?.includes("cat-file")) return { stdout: "blob\n" };
		const err = new Error("maxBuffer exceeded") as Error & {
			code?: number | null;
		};
		err.code = 1;
		throw err;
	};
	const read = await readMergeAuthorAllowlist(exec, "/r", SHA);
	assert(
		read.ok === false && read.reason === "too-large",
		"an allowlist past the read bound refuses rather than merging on a partial list",
	);
}

// ------------------------------------------------------------- the gate itself
{
	const allowlist = {
		ok: true,
		logins: ["Alice"],
		set: new Set(["alice"]),
	} as const;
	const ok = mergeAuthorGate({
		allowlist,
		author: { ok: true, login: "ALICE" },
	});
	assert(ok.ok === true, "gate allows a login that differs only by case");
	const no = mergeAuthorGate({
		allowlist,
		author: { ok: true, login: "mallory" },
	});
	assert(no.ok === false, "gate refuses a login that is not on the list");
	assert(
		(no as { reason: string }).reason.includes(MERGE_AUTHORS_FILE) &&
			(no as { reason: string }).reason.includes("mallory"),
		"…and the refusal names the file and the login so the operator knows what to change",
	);
	assert(
		!(no as { reason: string }).reason.includes("Alice"),
		"…and the refusal never prints the allowlisted logins — they are the operator's private list and this text reaches transcripts",
	);
}

// ------------------------------------- the unreadable-author case is not "not allowlisted"
{
	const allowlist = {
		ok: true,
		logins: ["alice"],
		set: new Set(["alice"]),
	} as const;
	const unreadable = mergeAuthorGate({
		allowlist,
		author: { ok: false, detail: "the forge reported no author" },
	});
	assert(
		unreadable.ok === false,
		"gate refuses an author the forge never reported",
	);
	assert(
		(unreadable as { reason: string }).reason.includes("could not be read") &&
			!(unreadable as { reason: string }).reason.includes("is not listed"),
		"…and says so, rather than calling the missing author a person who is not on the list",
	);
	const blank = mergeAuthorGate({
		allowlist,
		author: { ok: true, login: "   " },
	});
	assert(
		blank.ok === false,
		"gate refuses a whitespace-only login as unreadable, not as a stranger",
	);

	// The AUTHOR outranks the allowlist when both are missing, and the reason is the
	// operator's next minute of work: "the forge reported no author" is fixable in
	// seconds (a re-run, a `gh` login), while "no base commit is recorded" sends them
	// to a state file they cannot repair and a gate file that could not have answered
	// anyway. Both refusals block, so the ordering is purely about which action is
	// named first, and it names the one that can actually be taken.
	const both = mergeAuthorGate({
		allowlist: { ok: false, reason: "no-base" },
		author: { ok: false, detail: "the forge reported no author" },
	});
	assert(
		both.ok === false &&
			(both as { reason: string }).reason.includes("could not be read") &&
			!(both as { reason: string }).reason.includes("base commit"),
		"with neither readable, the park names the unreadable author rather than the missing base",
	);
	// …and with the author known, the allowlist's own fault is what surfaces: the
	// ordering above cannot mask a gate-file problem behind an author problem.
	const onlyAllowlist = mergeAuthorGate({
		allowlist: { ok: false, reason: "no-base" },
		author: { ok: true, login: "octocat" },
	});
	assert(
		onlyAllowlist.ok === false &&
			(onlyAllowlist as { reason: string }).reason.includes("base commit"),
		"…and a known author still gets the allowlist's own refusal, so the ordering is not a way to hide a gate-file fault",
	);
}

// -------------------------------------------------- the placeholder is never a login
{
	for (const placeholder of [
		"unknown",
		"Unknown",
		"local",
		"dev@example.com",
	]) {
		const read = mergeGuardAuthorRead(placeholder);
		assert(
			read.ok === false,
			`the stand-in ${JSON.stringify(placeholder)} is refused as an unreadable author, not compared to the list`,
		);
	}
	assert(
		mergeGuardAuthorRead("alice").ok === true,
		"a real login passes through as a read",
	);
	assert(
		mergeGuardAuthorRead(undefined).ok === false &&
			mergeGuardAuthorRead("").ok === false,
		"an absent or empty author is an unreadable read",
	);
}

// -------------------------------------- the evidence read is where the author comes from
{
	assert(
		mergeEvidenceViewCmd(17).includes("author"),
		"#2181: the author is requested by the SAME gh pr view that carries the CI verdict — two reads would let a reassignment put a green board and an allowlisted author on different PRs",
	);
	const ev = (over: Partial<MergeEvidence>): MergeEvidence =>
		({ ok: true, author: "alice", ...over }) as MergeEvidence;
	assert(
		authorFromEvidence(ev({})).ok === true,
		"authorFromEvidence lifts the login the evidence read reported",
	);
	const missing = authorFromEvidence(ev({ author: undefined }));
	assert(
		missing.ok === false,
		"a PR state read with no author field is an unreadable author, not an empty login",
	);
	const neverRead = authorFromEvidence(undefined);
	assert(
		neverRead.ok === false,
		"no evidence read at all is an unreadable author — the driver's no-authority branch, where CI was never consulted",
	);
	assert(
		authorFromEvidence(ev({ author: "  " })).ok === false,
		"a blank author field is unreadable rather than a login of spaces",
	);
}

// -------------------------------------------- the driver/lean path, on a ref-shaped base
{
	// The `/work` driver records `baseSha` as a REF (`work-driver-branch-ops.ts`
	// writes `origin/main`), and lean persists the same shape. The reader underneath
	// demands a hex sha, so the shared entry point resolves the ref first — otherwise
	// every real cycle would refuse for the wrong reason, which is the difference
	// between a gate that works and a gate that bricks the pipeline.
	const calls: string[] = [];
	const exec = async (
		_cmd: string,
		opts?: { argv?: string[] },
	): Promise<{ stdout: string }> => {
		const argv = opts?.argv ?? [];
		calls.push(argv.join(" "));
		if (argv[0] === "rev-parse") return { stdout: `${SHA}\n` };
		if (argv.includes("cat-file")) return { stdout: "blob\n" };
		return { stdout: DEFAULT_BODY };
	};
	const target = (author: string): MergeTarget =>
		({
			forge: "github",
			prNumber: 1,
			headBranch: "feature/x",
			headOid: "abc123",
			baseBranch: "main",
			author,
			labels: [],
		}) as MergeTarget;
	void target;

	const allowed = await heldForMergeAuthor({
		exec,
		cwd: "/r",
		baseSha: "origin/main",
		author: { ok: true, login: "bob" },
	});
	assert(
		allowed.ok === true,
		"a ref-shaped base resolves and the allowlist is read at that commit",
	);
	assert(
		calls.some((c) => c.includes("rev-parse") && c.includes("^{commit}")),
		"…via an executed rev-parse, so the commit judged is a commit and not a moving branch name",
	);
	assert(
		calls.some((c) => c.includes("cat-file") && c.includes(MERGE_AUTHORS_FILE)),
		"…and the blob's TYPE is probed before its bytes are read, so a directory cannot answer as an allowlist",
	);

	const stranger = await heldForMergeAuthor({
		exec,
		cwd: "/r",
		baseSha: "origin/main",
		author: { ok: true, login: "mallory" },
	});
	assert(
		stranger.ok === false && stranger.kind === "not-allowlisted",
		"a login off the list is refused and classified as such, so the handoff says the right thing",
	);
	const unreadable = await heldForMergeAuthor({
		exec,
		cwd: "/r",
		baseSha: "origin/main",
		author: { ok: false, detail: "the forge reported no author" },
	});
	assert(
		unreadable.ok === false && unreadable.kind === "author-unreadable",
		"an unreadable author is classified apart from a stranger — different operator actions",
	);
	const noBase = await heldForMergeAuthor({
		exec,
		cwd: "/r",
		baseSha: undefined,
		author: { ok: true, login: "bob" },
	});
	assert(
		noBase.ok === false && noBase.kind === "allowlist-unreadable",
		"a cycle with no recorded base commit cannot establish its own allowlist and is refused",
	);

	// A base that resolves to nothing is a refusal, never a merge on a list read
	// from somewhere else.
	const brokenBase = await heldForMergeAuthor({
		exec: async (_c, o) => {
			const argv = o?.argv ?? [];
			if (argv[0] === "rev-parse") throw new Error("fatal: unknown revision");
			return { stdout: "blob\n" };
		},
		cwd: "/r",
		baseSha: "origin/gone",
		author: ALLOWED,
	});
	assert(
		brokenBase.ok === false && brokenBase.kind === "allowlist-unreadable",
		"a base commit that does not resolve refuses rather than reading the list from the working tree",
	);
	const nonOid = await heldForMergeAuthor({
		exec: async (_c, o) => {
			const argv = o?.argv ?? [];
			if (argv[0] === "rev-parse") return { stdout: "not-an-oid\n" };
			return { stdout: "blob\n" };
		},
		cwd: "/r",
		baseSha: "origin/odd",
		author: ALLOWED,
	});
	assert(
		nonOid.ok === false,
		"a base resolve that answers something other than an OID is refused, not trusted",
	);
}

if (failures > 0) {
	console.log(`\nFAILED ${failures} assertion(s)`);
	process.exit(1);
}
console.log("\nall assertions passed");
