/**
 * merge-guard-stub — the exec stub the merge-guard decision matrices hand the REAL
 * `registerMergeGuard` hook, split out of `merge-guard-helpers.ts` for the §12 cap.
 *
 * Both matrix files drive the real hook through `opts.execFn`; this module is that
 * `execFn` and the `MergeGuardEnv` knobs it reads. `makeHook` in the helpers stays
 * the one place that registers the guard, so a matrix has exactly one entry point.
 *
 * ## Order is the contract
 *
 * Every arm matches a substring of the joined command line, so an arm that moves can
 * silently swallow a read meant for another, and a matrix then passes against an
 * answer that was never meant for it. The load-bearing precedences:
 *
 *   - the evidence read BEFORE the wide identity read — both are `gh pr view`, told
 *     apart only by their field lists;
 *   - the allowlist read (`git cat-file -t` / `git show` of the gate file) BEFORE the
 *     generic arms, with the probe answered apart from the blob — `cat-file` reports
 *     a TYPE and `show` the BYTES;
 *   - the `^{commit}` base resolve BEFORE the generic `rev-parse <remote>/…` arms,
 *     which answer a ref question with a short fixture OID that is not a 40-hex sha
 *     and would make the author gate refuse every merge for the wrong reason;
 *   - the mainline OID resolve BEFORE the head arm's `<remote>/` prefix;
 *   - the protected diff matched through `isNulDiffRead`, derived from the
 *     production argv constant, so a command-shape drift fails the match loudly
 *     instead of falling through to `{stdout: ""}` and letting every arm pass
 *     against an empty change set.
 *
 * Anything unmatched THROWS rather than answering empty: an unrecognised read is a
 * fixture gap, and silence here is how a matrix starts asserting nothing.
 *
 * The GitLab evidence arms (#2226) are matched in `merge-guard-stub-gl.ts`, still
 * from this one function and still ahead of the git arms, so the order stays the
 * contract of this file rather than of two.
 */

import { MERGE_AUTHORS_FILE, mergeAuthorTreeLine } from "../src/merge-author-allowlist.ts";
import type { MergeTarget } from "../src/merge-target.ts";
import { commandOf } from "./lib/argv-shell.ts";
import { isNulDiffRead } from "./lib/nul-porcelain.ts";
import type { MergeGateEnv } from "./merge-guard-forge-fixture.ts";
import { evidenceHeadFor, widenOid } from "./merge-guard-forge-fixture.ts";
import { glEvidenceAnswer } from "./merge-guard-stub-gl.ts";
import { DEFAULT_AUTHOR_ALLOWLIST } from "./merge-guard-helpers.ts";

/** Every knob the stub reads, beyond the shared CI/protected-env knobs. */
export type MergeGuardEnv = {
	target: MergeTarget;
	currentPatchId: string;
	fetchedHead: string;
	calls: string[];
	failFetch?: boolean;
	failGh?: boolean;
	/** #2107 — the `timeout` each exec was given, so a test can assert the bound. */
	timeouts?: number[];
	ledgerCommonDir?: string;
	remote?: string;
	ghComments?: string;
	/** The mainline `git symbolic-ref` reports (default: the PR's base). */
	mainline?: string;
	/** What `git merge-base` prints (default `mb0000`; "" = no merge-base). */
	mergeBase?: string;
	/**
	 * #2181 — the allowlist text the base-commit read of the gate file answers
	 * with. The default is `DEFAULT_AUTHOR_ALLOWLIST` (which lists `ALLOWED_AUTHOR`,
	 * i.e. `TARGET.author`), so every arm written before #2181 keeps reaching the
	 * gates it was written to exercise rather than dying at the new one. An arm
	 * about the author gate overrides this, or asks for `noAllowlist` /
	 * `allowlistReadThrows`.
	 */
	authorAllowlist?: string;
	/**
	 * `true` — the gate file is not in the base commit at all. Since A7 this is the
	 * repository **not opting in**: the type probe fails the way git fails for a path
	 * that is not in the commit, and the author gate is not applied — every other
	 * gate still runs. `authorAllowlist` then names the text for a repo that DID
	 * commit the file (an empty string is the file-present-but-naming-nobody arm).
	 */
	noAllowlist?: boolean;
	/** `true` — the git read of the gate file throws (the unreadable-file arm). */
	allowlistReadThrows?: boolean;
	/**
	 * The tree entry's MODE the `ls-tree` read answers with. `undefined` is the regular
	 * file (`100644`) every arm that is not about the entry's shape wants; an arm about
	 * that shape names `"120000"` (a committed symlink — a `blob` to `cat-file -t`, so
	 * the type probe cannot catch it) or `"040000"` (a directory).
	 */
	allowlistTreeMode?: string;
	/**
	 * #2181 — the `author` field of the CI evidence read. `undefined` answers the
	 * target's own author (which the default allowlist lists); a string names a
	 * different login; `null` omits the field, so the gate sees an author the forge
	 * never reported rather than a person named `unknown`.
	 */
	evidenceAuthor?: string | null;
	/**
	 * #2181 — what the cycle recorded as its base commit, which is what the
	 * allowlist is read at. The guard asks for `<remote>/<mainline>`; the `/work`
	 * driver records `baseSha`, which `work-driver-branch-ops.ts` writes as a REF
	 * (`origin/main`), not a sha — so the driver's own shape is what makes the
	 * reader's `bad-base-sha` arm reachable. An arm names its own value.
	 */
	baseRef?: string;
	/** #2181 — the base-commit resolve fails: an unresolvable ref (fail-closed arm). */
	unresolvableBase?: boolean;
	/**
	 * #2181 — what the base resolve answers when it is the arm's subject:
	 * `"garbage"` = a non-OID, `"moved"` = a commit other than the run's base.
	 */
	baseResolve?: "garbage" | "moved";
	/** The mainline OID resolve fails: throws, or answers a non-OID. */
	failBaseOid?: "throws" | "garbage";
	/**
	 * What `gh pr view --json number` (the CURRENT-BRANCH resolution) does.
	 * `"throws"` (default) is the stub's error; `"empty"` makes it return no
	 * `number` field, which is the shape that leaves `resolvePrNumber` with
	 * `undefined` — the case the early-refusal seam reports.
	 */
	branchNumber?: "throws" | "empty";
} & MergeGateEnv;

/** The shape an exec seam is handed; the stub consults `argv` and `timeout` only. */
type StubOpts = {
	argv?: string[];
	cwd?: string;
	timeout?: number;
	maxBuffer?: number;
	shell?: string;
	killGroup?: boolean;
	env?: Record<string, string>;
	stdoutEncoding?: string;
};

/** The identity read's field list — what keeps it apart from the evidence read. */
const IDENTITY_FIELDS = "headRefName,headRefOid,baseRefName,author,labels";
/** The #2106 evidence read's field list, answered from the env knobs below. */
const EVIDENCE_FIELDS = "mergeStateStatus,mergeable,state,headRefOid";

/**
 * Build the stub for one matrix.
 *
 * #2107 — one head for every reader. The guard verifies `git rev-parse`'s answer
 * against the PR's `headOid` by STRING EQUALITY, then pins the CI verdict to that
 * same fetched value, and the guard's own OID comparison (`sameOid` in
 * merge-guard-reads.ts) demands >= 7 hex characters from BOTH sides. A fixture head
 * shorter than that — the shared `TARGET.headOid` is `abc123` — therefore cannot
 * satisfy the pin at all: no answer the forge stub gives is both 40 hex for the
 * gatherer and the same commit as a 6-char verified head. So the harness widens the
 * fixture head ONCE, here, and the identity read, the `rev-parse` stub and the
 * evidence read all answer with that one value: an arm is never made to agree with
 * the pin by accident, and an arm that IS testing the pin says so by naming
 * `evidenceHeadOid`.
 */
export function mergeGuardExec(env: MergeGuardEnv) {
	const t = env.target;
	const headOid = widenOid(t.headOid);
	const fetched =
		env.fetchedHead === undefined ? headOid : widenOid(env.fetchedHead);
	const ghView = {
		stdout: JSON.stringify({
			headRefName: t.headBranch,
			headRefOid: headOid,
			baseRefName: t.baseBranch,
			author: { login: t.author },
			labels: t.labels.map((n) => ({ name: n })),
		}),
	};
	// #2226 — the forge this matrix drives. The fixture's own `forge` field decides
	// it, so a GitLab arm passes `target: {…TARGET, forge: "gitlab"}` and the two
	// forge-dependent answers below (the gatherer's reads, and the remote host the
	// gatherer's own detection classifies) cannot disagree with each other. The
	// helper flips `PI_ENSEMBLE_FORGE` for the duration of the decision so the
	// gatherer takes its GitLab arm; the stub itself must not READ that variable,
	// which is pinned once at module scope for the GitHub matrices.
	const isGl = env.target.forge === "gitlab";
	// #2107 — the repo scoping: the value every `gh` read must end with. A forge
	// read that dropped it answers about a different PR than the one the merge
	// acts on, so `execFn` refuses it (see below).
	const wantRepoFlag =
		env.targetRepo !== undefined ? ` -R ${env.targetRepo}` : "";
	return async (cmd0: string, opts?: StubOpts): Promise<{ stdout: string }> => {
		const cmd = commandOf(cmd0, opts);
		env.calls.push(cmd);
		// The bound is recorded into the caller's own array (created by the matrix, not
		// here), so an arm can assert the CI reads were bounded at all. Assigned rather
		// than `??=` inline: the inline form is an assignment inside an expression.
		if (opts?.timeout !== undefined) {
			if (env.timeouts === undefined) env.timeouts = [];
			env.timeouts.push(opts.timeout);
		}
		// #2107 — the repo scoping, checked AFTER the record so an unscoped read
		// still shows up in `calls` as the command the guard actually issued: an
		// arm then fails on its own `-R <repo>` assertion (or on this refusal)
		// rather than on an empty call list that hides what was asked. The matcher
		// is the whole `gh` command, not `gh pr …` — the guard appends the flag, so
		// a scoped read always ENDS with it — and it has to cover the argv form
		// (#1095) that `gh pr checks` is issued in, whose joined text a `gh pr `
		// prefix test never saw.
		if (
			wantRepoFlag &&
			/^(gh|glab) /.test(cmd) &&
			!cmd.endsWith(wantRepoFlag)
		) {
			throw new Error(`forge read not scoped to the command's repo: ${cmd}`);
		}
		// The identity read. Which forge it asks is the TARGET's business, never the
		// env pin's: gh asks `gh pr view N --json <fields>`, glab asks `glab mr view
		// N --output json` (#2226 — the guard's identity read is forge-aware, so a
		// GitLab arm asks glab and must be ANSWERED, not fallen through). Keying this
		// arm off `PI_ENSEMBLE_FORGE` instead would make the arm that withholds the
		// pin (`unsetForgeEnv`, for the gatherer's detection) fail on the harness
		// rather than on the code under test. The head comes from
		// `diff_refs.head_sha`, the field the GitLab MR reply carries it in, widened
		// to the one value every other reader answers with.
		if (cmd.includes(isGl ? "glab mr view" : "gh pr view")) {
			if (cmd.includes("--json number")) {
				if (env.branchNumber === "empty") return { stdout: "{}" };
				return { stdout: JSON.stringify({ number: t.prNumber }) };
			}
			if (isGl) {
				if (env.failGh) throw new Error("glab: not found");
				return {
					stdout: JSON.stringify({
						iid: t.prNumber,
						source_branch: t.headBranch,
						target_branch: t.baseBranch,
						author: { username: t.author },
						labels: t.labels.map((n) => ({ name: n })),
						diff_refs: { head_sha: headOid },
					}),
				};
			}
			// #2106 — the CI evidence read is a `gh pr view` too, told apart ONLY by
			// its field list. A matcher that keyed on `gh pr view` alone would hand
			// the guard its identity answer and the gate would pass on nothing.
			if (cmd.includes(`--json ${EVIDENCE_FIELDS}`))
				return evidenceAnswer(env, fetched);
			if (env.failGh) throw new Error("gh: not found");
			if (cmd.includes("--json comments")) {
				if (env.ghComments === undefined) {
					throw new Error("gh: comments not stubbed");
				}
				return { stdout: env.ghComments };
			}
			if (!cmd.includes(`--json ${IDENTITY_FIELDS}`)) {
				throw new Error(`unexpected gh pr view field list: ${cmd}`);
			}
			return ghView;
		}
		// #2106 — the check rows behind the CI evidence gate.
		if (cmd.includes("gh pr checks")) {
			if (env.hangChecks) {
				await new Promise((res) => setTimeout(res, 60_000));
			}
			if (env.failChecks) throw new Error("gh: could not read the checks");
			return {
				stdout:
					env.prChecks ??
					JSON.stringify([
						{ name: "quality-gate", state: "SUCCESS", bucket: "pass" },
					]),
			};
		}
		// ── #2226 — the GitLab evidence reads of the gatherer's GitLab arm, and
		// ONLY for a gitlab target (see `merge-guard-stub-gl.ts`, which owns their
		// argv matchers and their order). A gitlab arm that fell through to the
		// catch-all below fails on `unexpected exec`, which is how a stub that
		// answered the wrong forge shows up.
		if (isGl) {
			const answered = await glEvidenceAnswer(env, cmd, headOid);
			if (answered) return answered;
		}
		if (cmd.includes("git fetch")) {
			if (env.failFetch) throw new Error("unable to connect");
			return { stdout: "" };
		}
		// #2181 — the merge-author gate's THREE reads of the gate file at the base
		// commit: `git ls-tree <sha> -- <path>` for the entry's MODE, `git cat-file -t
		// <ref>:.pi/merge-authors` for the TYPE, and `git show` of the same spec for the
		// BYTES. Matched on the gate file's PATH rather than on a `git show` prefix, so
		// neither form can be missed: the guard issues them in argv form, whose joined
		// text `commandOf` renders without the leading `git`.
		if (cmd.includes(MERGE_AUTHORS_FILE)) return allowlistAnswer(env, cmd);
		// #2181 — resolving the cycle's recorded base to a commit, which is what the
		// allowlist is then read at. Matched on `^{commit}` — the only such read is this
		// one — and deliberately ahead of the generic `rev-parse <remote>/…` arms below.
		if (cmd.includes("^{commit}")) return baseResolveAnswer(env, fetched);
		// Remote resolution: origin → upstream → first remote. The origin host
		// follows the target's forge, so the gatherer's own detection (#2226)
		// classifies this clone the same way the arm is being driven.
		//
		// `failRemoteUrl` answers with a remote no parser claims. It is the ONLY
		// remote read an `unsetForgeEnv` arm lets through: with `PI_ENSEMBLE_FORGE`
		// withheld (`makeHook`) the guard's own forge decision no longer consults a
		// URL at all — `targetForCommand`/`resolvePrNumber` are handed
		// `{ env: { PI_ENSEMBLE_FORGE: <target forge> } }`, the precedence production
		// sets out of band — while the GATHERER is handed nothing but this URL and
		// must classify the clone itself. That asymmetry is the question the arm in
		// `test-merge-guard-ci-evidence-gitlab.ts` asks: an unreadable remote must
		// decide the gatherer's forge, nobody else's.
		if (cmd.includes("git config --get remote.origin.url")) {
			if (env.failRemoteUrl) return { stdout: "https://internal.invalid/r.git\n" };
			if (env.remote === "origin" || env.remote === undefined)
				return {
					stdout: `git@${isGl ? "gitlab" : "github"}.com:o/r.git\n`,
				};
			return { stdout: "" };
		}
		if (cmd.includes("git config --get remote.upstream.url")) {
			// Always a github.com host: the matrices whose subject is remote resolution
			// drive a GitHub target, and the origin arm above is the one that follows the
			// arm's forge. One host for both remotes would let the remote under test
			// decide the forge.
			if (env.remote === "upstream")
				return { stdout: "git@github.com:o/r.git\n" };
			return { stdout: "" };
		}
		if (cmd.includes("git config --get remote.")) {
			return { stdout: "" };
		}
		if (cmd.includes("git remote")) {
			return { stdout: `${env.remote}\n` };
		}
		// The guard resolves `<remote>/<mainline>` to an OID for the protected read,
		// through the SAME string form as its head check below. Matched FIRST, or the
		// head arm's `<remote>/` prefix would answer it with the head.
		if (
			cmd.includes(
				`rev-parse ${env.remote}/${env.mainline ?? env.target.baseBranch}`,
			)
		) {
			// Two ways that resolve can fail, and both must block: a call that throws,
			// and one that prints something which is not an object id.
			if (env.failBaseOid === "throws")
				throw new Error("git rev-parse: unknown revision");
			if (env.failBaseOid === "garbage") return { stdout: "not-an-oid\n" };
			return { stdout: widenOid(env.mergeBase ?? "mb0000") };
		}
		if (cmd.includes(`rev-parse ${env.remote}/`)) return { stdout: fetched };
		if (cmd.includes("symbolic-ref")) {
			return { stdout: `origin/${env.mainline ?? env.target.baseBranch}\n` };
		}
		// The identity arm below matches `git merge-base`; the protected read's
		// `git merge-base --end-of-options <oid> <oid>` is that SAME command and must
		// answer here, widened, or the earlier placeholder arm hands it `mb0000` and
		// the read refuses a non-OID (correctly — that is the ordering bug this arm
		// would otherwise hide).
		if (cmd.includes("merge-base --end-of-options")) {
			return { stdout: `${widenOid(env.mergeBase ?? "mb0000")}\n` };
		}
		if (cmd.includes("git merge-base"))
			return { stdout: `${env.mergeBase ?? "mb0000"}\n` };
		if (cmd.includes("patch-id"))
			return { stdout: `${env.currentPatchId} 0000` };
		// The protected-path read itself: `diff -z --name-status -M -C
		// <merge-base>..<head>`.
		if (isNulDiffRead(cmd)) {
			if (env.protectedDiffThrows)
				throw new Error("git diff: unable to read pack file");
			return { stdout: env.protectedDiff ?? "" };
		}
		if (cmd.includes("git-common-dir")) {
			return { stdout: env.ledgerCommonDir ?? "" };
		}
		throw new Error(`unexpected exec: ${cmd}`);
	};
}

/** The #2106/#2107 evidence read, whose head default is derived from the fetched OID. */
async function evidenceAnswer(
	env: MergeGuardEnv,
	fetched: string,
): Promise<{ stdout: string }> {
	if (env.failEvidence) throw new Error("gh: could not read the PR state");
	// #2107 — the head the verdict was read at. The guard compares it to the OID it
	// fetched and checked against the PR's `headOid`, so the default is a 40-hex
	// rendering of THAT head, derived from the very field the guard compares
	// (`fetchedHead`, which it has just verified equals the PR's `headOid`). A matrix
	// whose subject is not the pin thus agrees by construction and cannot fail on it
	// by accident; an arm that IS testing the pin names `evidenceHeadOid`. `null` is
	// the third state — the read answered and reported NO head at all, so the field is
	// left out of the payload, a different fault from a head that is some other commit.
	const prHeadOid =
		env.evidenceHeadOid === null
			? undefined
			: env.evidenceHeadOid === undefined
				? evidenceHeadFor(fetched)
				: evidenceHeadFor(env.evidenceHeadOid);
	if (env.hangChecks) {
		// The #2107 hang arm: the guard's bound is what answers this, so the stub
		// itself outlives every timeout an unbounded caller would have.
		await new Promise((res) => setTimeout(res, 60_000));
	}
	return {
		stdout: JSON.stringify({
			mergeStateStatus: env.mergeStateStatus ?? "CLEAN",
			mergeable: "TRUE",
			state: "OPEN",
			headRefOid: prHeadOid,
		}),
	};
}

/**
 * #2181 — the author gate's three reads of the gate file at the base commit.
 *
 * The three stay apart: `ls-tree` answers the entry's MODE (the only thing that tells a
 * committed symlink — a `blob` to `cat-file` — from a regular file), `cat-file -t` the
 * TYPE, and `show` the BYTES. Handing any of them another's answer makes every path a
 * regular file or every file a blob. `noAllowlist` makes the two probes answer the way
 * git does for a path that is not in the commit (an empty tree result plus the probe's
 * rejection), which is the shape the reader must treat as the repository opting out.
 */
function allowlistAnswer(env: MergeGuardEnv, cmd: string): { stdout: string } {
	if (env.allowlistReadThrows === true)
		throw Object.assign(new Error("git: unable to read pack file"), {
			code: 128,
			stderr: "git: unable to read pack file\n",
		});
	if (cmd.includes("ls-tree")) {
		// The tree question is asked with the path as its own argument, so it arrives
		// here too (the matcher above keys on the path, and this call carries it).
		if (env.noAllowlist === true) return { stdout: "" };
		return {
			stdout:
				env.allowlistTreeMode === undefined
					? mergeAuthorTreeLine("100644", MERGE_AUTHORS_FILE)
					: mergeAuthorTreeLine(env.allowlistTreeMode, MERGE_AUTHORS_FILE),
		};
	}
	if (env.noAllowlist === true) {
		// git's own wording for a path that is not in the commit, on the fields git
		// (and `execFile`) carry it on: the reader's absence classifier reads
		// `stderr` and the exit `code`, never the message — the message is where the
		// executor puts the COMMAND LINE, and a classifier that read it could be
		// handed an unresolvable base and call it an opt-out.
		const words = `fatal: path '${MERGE_AUTHORS_FILE}' does not exist in the base commit\n`;
		throw Object.assign(new Error(words), { code: 128, stderr: words });
	}
	if (cmd.includes("cat-file")) return { stdout: "blob\n" };
	if (cmd.includes("show")) {
		// An arm may name `""` to mean "the file exists and names nobody", which is a
		// refusal; the DEFAULT is what a repository that opted in normally answers.
		return { stdout: env.authorAllowlist ?? DEFAULT_AUTHOR_ALLOWLIST };
	}
	throw new Error(`unexpected allowlist read: ${cmd}`);
}

/**
 * #2181 — resolve the cycle's recorded base to the commit the allowlist is read at.
 *
 * Answered from the SAME fixture head as every other OID reader, so a ref-shaped
 * base resolves to the commit the rest of the run is judged at. An arm whose subject
 * IS the base resolve names the answer it wants: a non-OID (`garbage`) or a commit
 * other than the run's own base (`moved`) — both shapes the gate must refuse rather
 * than read a list at an unproven commit.
 */
function baseResolveAnswer(
	env: MergeGuardEnv,
	fetched: string,
): { stdout: string } {
	if (env.unresolvableBase === true)
		throw new Error("git rev-parse: unknown revision");
	if (env.baseResolve === "garbage") return { stdout: "not-an-oid\n" };
	if (env.baseResolve === "moved")
		return { stdout: `${widenOid("deadbeef")}\n` };
	return { stdout: `${evidenceHeadFor(fetched)}\n` };
}
