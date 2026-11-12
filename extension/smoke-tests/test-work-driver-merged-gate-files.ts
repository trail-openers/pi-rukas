#!/usr/bin/env bun
/**
 * #1529 — the repository-declared gate-file gate (`work-driver-merged-gate-files.ts`).
 *
 * The built-in protected set (`.github/`, `.pi/`, `CODEOWNERS`, `agents.json`) is
 * one project's list. A repository that names its build manifest or a safety
 * script a gate file has another, and its own doctrine — read at the cycle's base
 * commit — is the only source for it. These cases pin what that gate means:
 *
 *   - a declared path the PR touches parks the merge and the park NAMES the path;
 *   - a directory declaration covers what is under it;
 *   - a judge entry whose quote is not in the document is not honoured, and with
 *     nothing verified the cycle parks rather than merges;
 *   - a judge that could not answer parks while the doctrine speaks of gate files
 *     (an absent answer is not a declaration of none);
 *   - doctrine that never mentions gate files asks no question and merges, having
 *     read a change set it could inspect and asked the seam nothing it could not
 *     answer;
 *   - neither `--merge` nor `PI_ENSEMBLE_MERGE_AUTHORITY=0` is an answer to this
 *     gate — the latter is the path that skips the authority judge entirely.
 *
 * Every park assertion reads the hold's reason AND the gate's own attribution —
 * six different gates park at `awaiting-human-merge`, so "it parked" establishes
 * nothing about WHICH gate parked it, and a reason that merely names the path is
 * no better: the protected gate's own park names the same path in its own sentence
 * (which this gate's park re-quotes), so a needle made of the path alone is
 * satisfied by PR 1's gate. The attribution clause is what makes the park THIS
 * gate's, and every park case requires it.
 *
 * The declared paths are deliberately OUTSIDE the built-in protected set — a
 * `.github/` diff would be caught by the protected gate first and the case would
 * then assert the wrong gate. The paths are asserted to be outside it, not assumed:
 * see the built-in-predicate guard below.
 */

import type { PolicyJudgeFn } from "../src/work-driver-policy.ts";
import { protectedPathsIn } from "../src/work-driver-doctrine.ts";
import { protectedPathsSentence } from "../src/protected-paths-text.ts";
import { setupSpawnGuard } from "./test-helpers.ts";
import {
	declaredDoc,
	FIXTURE_AUTHOR,
	gateFileJudge,
	gateFileRun,
	MERGE_GRANT,
	MENTION_WITHOUT_DECLARATION,
	nulNameStatus,
} from "./lib/work-driver-merged-gate-files-fixture.ts";

setupSpawnGuard();

let exit = 0;
function assert(cond: boolean, msg: string) {
	if (cond) console.log(`✓ ${msg}`);
	else {
		console.log(`✗ ${msg}`);
		exit = 1;
	}
}

/** The doctrine sentence each case declares, in the document's own words. */
const BUILD_DECLARATION =
	"config/build.toml is one of this repository's gate files and must be merged by a person, never by an agent.";
const DEPLOY_DECLARATION =
	"Everything under tools/deploy/ counts as a gate file: a person merges those changes.";

/** The path each of those two declarations names, and the file a case puts in the PR. */
const BUILD_PATH = "config/build.toml";
const DEPLOY_FILE = "tools/deploy/run.sh";

/** This gate's own attributions — the only wording that says WHICH gate parked. */
const GATE_ATTRIBUTION = "declared as gate files by";
/** The same gate's refusal when the list could not be established at all. */
const GATE_UNVERIFIED_ATTRIBUTION =
	"mention gate files, but no declared path could be verified";

/**
 * The built-in protected predicate must not reach either declared path.
 *
 * If it did, the protected gate (PR 1) would park the cycle first and the case
 * would be asserting that gate while reading like this one. The predicate is one
 * project's list, so this is a property of the fixture's paths, not of the code:
 * assert it here rather than trust it, because a future entry in `PROTECTED_DIRS`
 * would otherwise silently retarget three cases.
 */
{
	const declared = [BUILD_PATH, DEPLOY_FILE, "tools/deploy/"];
	const matched = protectedPathsIn(declared);
	assert(
		matched.length === 0,
		`every declared path is outside the built-in protected set, so the park can only come from this gate (${matched.join(", ") || "none matched"})`,
	);
}

/**
 * Assert a park belongs to THIS gate rather than to another of the six that park
 * at `awaiting-human-merge`. `attribution` is the phrase only this gate writes;
 * `declared` is what the park must name.
 *
 * The attribution is asserted FIRST and independently of `declared`: the protected
 * gate's park names the same path (this gate re-quotes its sentence), so without
 * this clause "it named the path" is no evidence of which gate refused.
 */
function assertParkedByGate(
	r: {
		cap: string | undefined;
		holdReason: string | undefined;
		log: { mergeCmds: string[] };
	},
	attribution: string,
	declared: string,
	label: string,
) {
	assert(
		r.cap === "awaiting-human-merge",
		`${label}: the cycle parked at awaiting-human-merge (got ${JSON.stringify(r.cap)})`,
	);
	const reason = r.holdReason ?? "";
	assert(
		reason.includes(attribution),
		`${label}: the park carries THIS gate's own wording, not another gate's (${JSON.stringify(reason.slice(0, 200))})`,
	);
	assert(
		reason.includes(declared),
		`${label}: the park names ${JSON.stringify(declared)} (got ${JSON.stringify(reason.slice(0, 200))})`,
	);
	assert(r.log.mergeCmds.length === 0, `${label}: nothing was merged`);
}

/**
 * The commands a MERGED cycle runs after the merge itself: `restoreCheckout` and the
 * branch clean-up. The fixture scripts the gate reads, not the teardown, so these
 * are the only entries `log.unexpected` may legitimately hold — and only on the
 * path that actually merged. Derived from the argv the restoration sends, so a new
 * unanswered gate read still lands outside it and fails the case.
 */
const POST_MERGE_TEARDOWN =
	/^git (checkout \S+ --|status --porcelain -z -uall|pull --ff-only \S+ \S+|check-ref-format --branch \S+|branch -d -- \S+)$/;

/** The park for a declared path the PR touched. */
function assertParkedBy(
	r: {
		cap: string | undefined;
		holdReason: string | undefined;
		log: { mergeCmds: string[] };
	},
	declared: string,
	label: string,
) {
	assertParkedByGate(r, GATE_ATTRIBUTION, declared, label);
}

/**
 * The protected gate's OWN park wording for a diff touching `path`, with this
 * gate's attribution clause absent.
 *
 * The negative control for `assertParkedBy`: a case whose needle is only the path
 * accepts this text and so cannot tell the two gates apart. See the red-evidence
 * note in the case-1 block.
 */
function protectedGateParkFor(path: string): string {
	return protectedPathsSentence([path]);
}

/** A judge that reports an entry whose quote the doctrine does not contain. */
function fabricatedQuoteJudge(
	declaredPath: string,
	calls: string[],
): PolicyJudgeFn {
	return async (prompt) => {
		calls.push(prompt);
		if (!/Which paths do these documents declare/i.test(prompt)) {
			return {
				toolUses: [
					{
						name: "report_policy",
						arguments: { verdict: "permitted", quote: MERGE_GRANT },
					},
				],
			};
		}
		// A sentence nobody wrote, and one that does not even name the path.
		return {
			toolUses: [
				{
					name: "report_policy",
					arguments: {
						verdict: "permitted",
						quote: MERGE_GRANT,
						entries: [
							{
								path: declaredPath,
								quote:
									"config/build.toml may be merged by anyone, no review required whatsoever.",
							},
						],
					},
				},
			],
		};
	};
}

// ── 1. AGENTS.md declares `config/build.toml` and the PR touches it → parks, naming it.
//
// RED EVIDENCE (item 1, captured against the previous `assertParkedBy`): with the
// needle set to the declared path alone, the assertion read
//     `true` for THIS gate's park AND `true` for the protected gate's park —
//     protected gate's text: "this PR changes 1 protected path(s) — config/build.toml
//     — which define what verification, review and permission mean for this
//     repository …" (no "declared as gate files" clause).
// So the old assertion accepted PR 1's park. `protectedGateParkFor` below re-runs
// that negative control on every run, and the attribution clause is now required.
{
	const r = await gateFileRun({
		issue: 7101,
		agents: declaredDoc(BUILD_DECLARATION),
		judge: gateFileJudge({ declares: BUILD_PATH, calls: [] }) as PolicyJudgeFn,
		diff: nulNameStatus(BUILD_PATH),
	});
	assertParkedBy(r, BUILD_PATH, "declared file in the PR");
	assert(
		r.log.diffReads.length > 0,
		"the gate read the PR's own commits before deciding — the change set was inspected, not assumed",
	);
	// The negative control: this gate's attribution is what separates its park from
	// the protected gate's, which names the very same path.
	assert(
		protectedGateParkFor(BUILD_PATH).includes(BUILD_PATH) &&
			!protectedGateParkFor(BUILD_PATH).includes(GATE_ATTRIBUTION),
		"the protected gate's own park names this path WITHOUT this gate's attribution, so the attribution assertion is the discriminator, not a tautology",
	);
}

// ── 2. AGENTS.md declares the `tools/deploy/` directory and the PR touches a file in it.
{
	const r = await gateFileRun({
		issue: 7102,
		agents: declaredDoc(DEPLOY_DECLARATION),
		judge: gateFileJudge({
			declares: "tools/deploy/",
			calls: [],
		}) as PolicyJudgeFn,
		diff: nulNameStatus(DEPLOY_FILE),
	});
	assertParkedBy(r, DEPLOY_FILE, "declared directory prefix");
}

// ── 3. A judge entry whose quote is not in the document is not honoured, and with
// nothing verified the cycle parks as unverified rather than merging.
{
	const calls: string[] = [];
	const r = await gateFileRun({
		issue: 7103,
		agents: declaredDoc(BUILD_DECLARATION),
		judge: fabricatedQuoteJudge(BUILD_PATH, calls),
		diff: nulNameStatus(BUILD_PATH),
	});
	assert(
		calls.some((p) => /Which paths do these documents declare/i.test(p)),
		"the declared-list question was asked, so the refusal is this gate's",
	);
	assert(
		r.cap === "awaiting-human-merge",
		`an unverifiable declaration parks rather than merging (got cap ${JSON.stringify(r.cap)})`,
	);
	assert(
		(r.holdReason ?? "").includes("no declared path could be verified"),
		`the park says WHY — nothing could be verified against the doctrine (got ${JSON.stringify((r.holdReason ?? "").slice(0, 220))})`,
	);
	assert(
		r.log.mergeCmds.length === 0,
		"and the fabricated quote bought no merge",
	);
}

// ── 4. The judge is unavailable while the doctrine mentions gate files → parks.
{
	const r = await gateFileRun({
		issue: 7104,
		agents: declaredDoc(BUILD_DECLARATION),
		judge: gateFileJudge({
			declares: BUILD_PATH,
			throws: true,
			calls: [],
		}) as PolicyJudgeFn,
		diff: nulNameStatus(BUILD_PATH),
	});
	assert(
		r.cap === "awaiting-human-merge",
		`an unavailable judge parks the merge while the doctrine speaks of gate files (got ${JSON.stringify(r.cap)})`,
	);
	assert(
		(r.holdReason ?? "").includes("mention gate files"),
		`the park names the doctrine that mentions gate files as the reason nothing was cleared (got ${JSON.stringify((r.holdReason ?? "").slice(0, 220))})`,
	);
	assert(
		r.log.mergeCmds.length === 0,
		"and no merge was attempted on an absent answer",
	);
}

// ── 5. Doctrine that never mentions gate files: no question is asked, the merge goes ahead.
{
	const judgeCalls: string[] = [];
	const r = await gateFileRun({
		issue: 7105,
		agents: declaredDoc("Nothing here names a path a person has to merge."),
		judge: gateFileJudge({
			declares: BUILD_PATH,
			calls: judgeCalls,
		}) as PolicyJudgeFn,
		authorityJudge: true,
		diff: nulNameStatus(BUILD_PATH),
	});
	assert(
		judgeCalls.length === 1 &&
			!judgeCalls.some((p) =>
				/Which paths do these documents declare/i.test(p),
			),
		`the declared-list question was never asked of a doctrine that does not mention gate files (${judgeCalls.length} judge call(s))`,
	);
	assert(
		r.log.mergeCmds.length > 0,
		`the merge command was issued (got ${r.log.mergeCmds.length})`,
	);
	assert(
		r.cap === undefined,
		`the cycle did not park (got cap ${JSON.stringify(r.cap)})`,
	);
	// The merging case proves it merged the thing a declared gate file would have
	// blocked, and that the cycle asked for nothing the seam could not answer: an
	// unanswered command here is a gate that judged an empty change set.
	assert(
		r.log.diffReads.length > 0,
		"the protected-path read still ran on the merging path — an absent read is not a clean read",
	);
	// Item 2 — nothing the merge gates ask may go unanswered: an unread command is a
	// gate that judged an EMPTY change set and still reported a verdict. `unexpected`
	// is never literally empty on this path, because a cycle that merged goes on to
	// restore the checkout and delete the branch, and the fixture scripts the gate
	// reads rather than the teardown; `POST_MERGE_TEARDOWN` is the documented
	// allowance, so the assertion that binds is the one below it.
	assert(
		r.log.unexpected.every((c) => POST_MERGE_TEARDOWN.test(c)),
		`the seam answered every command the merge gates asked — only the post-merge restoration is unsolicited (${JSON.stringify(r.log.unexpected.filter((c) => !POST_MERGE_TEARDOWN.test(c)))})`,
	);
}

// ── 6. `--merge` is not an answer to this gate: case 1's setup still parks.
{
	const r = await gateFileRun({
		issue: 7106,
		agents: declaredDoc(BUILD_DECLARATION),
		judge: gateFileJudge({ declares: BUILD_PATH, calls: [] }) as PolicyJudgeFn,
		mergeGrant: true,
		diff: nulNameStatus(BUILD_PATH),
	});
	assertParkedBy(r, BUILD_PATH, "with the operator's --merge grant");
}

// ── 7. A mention with nothing declared behind it parks, and the question WAS asked.
{
	const judgeCalls: string[] = [];
	const r = await gateFileRun({
		issue: 7107,
		agents: MENTION_WITHOUT_DECLARATION,
		judge: gateFileJudge({ calls: judgeCalls }) as PolicyJudgeFn,
		diff: nulNameStatus(BUILD_PATH),
	});
	assert(
		judgeCalls.some((p) => /Which paths do these documents declare/i.test(p)),
		`the doctrine's mention of gate files asked the declared-list question (${judgeCalls.length} call(s))`,
	);
	// The unverified-list park, not the path-hit park: this gate's other own wording.
	assertParkedByGate(
		r,
		GATE_UNVERIFIED_ATTRIBUTION,
		"no declared path could be verified",
		"a mention with no declaration",
	);
}

// ── 8. `PI_ENSEMBLE_MERGE_AUTHORITY=0` is not an answer to this gate either.
//
// The switch turns the PERMISSION and EVIDENCE gate off, which is the branch of
// `runMerged` that never reaches the authority judge — so this is the path where a
// forgotten call would merge a diff that touches a declared gate file. The park
// must carry this gate's own attribution: on this path the protected gate has run
// too, and its park would otherwise look identical.
{
	const r = await gateFileRun({
		issue: 7108,
		agents: declaredDoc(BUILD_DECLARATION),
		judge: gateFileJudge({ declares: BUILD_PATH, calls: [] }) as PolicyJudgeFn,
		authorityGate: false,
		diff: nulNameStatus(BUILD_PATH),
		// #2181 — with the permission gate off there is no evidence read, so the author
		// gate has nothing to decide on and parks the cycle before the gate-file gate is
		// ever reached (correctly — an unreadable author is a refusal). This case is about
		// the GATE-FILE park on that branch, so it supplies the allowlist and the login
		// directly and the author gate passes on the text rather than on the forge.
		authorAllowlist: `${FIXTURE_AUTHOR}\n`,
		stateAuthor: FIXTURE_AUTHOR,
	});
	assertParkedBy(r, BUILD_PATH, "with PI_ENSEMBLE_MERGE_AUTHORITY=0");
}

console.log(`\nexit ${exit}`);
process.exit(exit);
