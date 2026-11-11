#!/usr/bin/env bun
/**
 * #2181 — the merge-author gate on the driver's own merge path.
 *
 * Split out of `test-work-driver-merged-gate-files.ts` for the §12 size cap; the
 * sibling keeps the repository-declared gate-file gate. Same fixture
 * (`lib/work-driver-merged-gate-files-fixture`), same real driver, same parked-at-
 * `merged` cycle — only the gate under test differs.
 *
 * The rule these cases exist to keep: nobody lands a PR whose author the operator
 * never allowlisted, whatever the ledger and the CI board say. Each one asserts the
 * two things that make that real — the cycle PARKS at awaiting-human-merge with the
 * author gate's own field set, and NO merge command was issued — because a park that
 * still merged, or a merge that named the wrong reason, would both look like a pass
 * from the outside.
 *
 * The gate's decision TABLE (parsing, case-folding, the fail-closed refusals, the
 * stand-in logins) is `test-merge-author-allowlist.ts`; the lean `land` path is
 * `test-lean-land.ts`; the hand-run guard is `test-merge-guard.ts`. What lives here
 * is only the driver-path composition: that the merged step asks the gate, parks on
 * its answer, and reads the list at the cycle's base commit.
 */

import type { PolicyJudgeFn } from "../src/work-driver-policy.ts";
import {
	FIXTURE_AUTHOR,
	declaredDoc,
	gateFileJudge,
	gateFileRun,
	nulNameStatus,
} from "./lib/work-driver-merged-gate-files-fixture.ts";
import { setupSpawnGuard } from "./test-helpers.ts";

setupSpawnGuard();

let exit = 0;
function assert(cond: boolean, msg: string) {
	if (cond) console.log(`✓ ${msg}`);
	else {
		console.log(`✗ ${msg}`);
		exit = 1;
	}
}

/** The doctrine each case declares — irrelevant to this gate, but the cycle needs a
 * grant to reach the merge step at all. */
const BUILD_DECLARATION =
	"config/build.toml is one of this repository's gate files and must be merged by a person, never by an agent.";
const BUILD_PATH = "config/build.toml";

/** A case with a clean PR and a judge that declares the one path the cycle needs. */
const runFor = (issue: number, extra: Parameters<typeof gateFileRun>[0] = {}) =>
	gateFileRun({
		issue,
		agents: declaredDoc(BUILD_DECLARATION),
		judge: gateFileJudge({ declares: BUILD_PATH, calls: [] }) as PolicyJudgeFn,
		diff: nulNameStatus("src/whatever.ts"),
		...extra,
	});

{
	// The control first: an allowlisted author, and the cycle merges. Without this the
	// refusals below could be produced by a gate that refuses everything.
	const r = await runFor(7120);
	assert(
		r.log.mergeCmds.length > 0,
		`#2181 control: an allowlisted author merges (${r.log.mergeCmds.length} merge call(s), cap ${JSON.stringify(r.cap)})`,
	);
	assert(
		r.log.allowlistReads.some((c) => c.includes("cat-file")) &&
			r.log.allowlistReads.some((c) => c.includes("show")),
		"#2181 …and the gate probed the blob's type before reading its bytes — a directory at the path cannot answer as an allowlist",
	);
}
{
	// A login off the list. The refusal must name the file and the login (the operator
	// has to know what to change) and must NOT print the list itself (transcripts).
	const r = await runFor(7121, { evidenceAuthor: "stranger" });
	assert(
		r.cap === "awaiting-human-merge" && r.log.mergeCmds.length === 0,
		`#2181: a non-allowlisted author parks and nothing merges (cap ${JSON.stringify(r.cap)}, ${r.log.mergeCmds.length} merge call(s))`,
	);
	assert(
		(r.holdReason ?? "").includes("stranger") &&
			(r.holdReason ?? "").includes([".pi", "merge-authors"].join("/")),
		`#2181 …and the park names the login and the gate file (${JSON.stringify((r.holdReason ?? "").slice(0, 160))})`,
	);
	assert(
		!(r.holdReason ?? "").includes(FIXTURE_AUTHOR),
		"#2181 …and the park never prints the allowlisted logins — the refusal reaches transcripts, and the list is the operator's private one",
	);
}
{
	// A7 — an ABSENT allowlist is not "an open list" and not a refusal either: it is
	// a repository that never opted in, so the cycle merges and the gate says nothing.
	// The counterfoil to the two arms below (empty file, unreadable file), which are
	// repositories that DID commit the file and must still fail closed.
	const r = await runFor(7122, { noAllowlist: true });
	assert(
		r.log.mergeCmds.length > 0,
		`#2181 A7: with no gate file at the base commit the repository never opted in, so the merge is not held (cap ${JSON.stringify(r.cap)}, ${r.log.mergeCmds.length} merge call(s))`,
	);
	assert(
		r.log.allowlistReads.length > 0,
		"#2181 …and the gate still PROBED for the file — absence is a read's answer, never a skipped check",
	);
	assert(
		r.log.allowlistReads.every((c) => c.includes("cat-file")),
		"#2181 …and absence costs only the type probe, never a blob read",
	);
	assert(
		!(r.log.unexpected ?? []).some((c) => c.includes("rev-parse")),
		"#2181 …and a repository's opt-out is not a reason to go reading the working tree instead",
	);
}
{
	// The absent file is the control for the author rule too: with no allowlist the
	// gate has no subject, so even an author the forge never reported lands. The
	// unreadable-author refusal lives in the file-present arm further down.
	const r = await runFor(7127, { noAllowlist: true, evidenceAuthor: null });
	assert(
		r.log.mergeCmds.length > 0,
		`#2181 A7: no file means no author rule, so an unreadable author is no longer the gate's business (cap ${JSON.stringify(r.cap)}, ${r.log.mergeCmds.length} merge call(s))`,
	);
}
{
	// A file that exists but names nobody: same refusal family, different sentence,
	// and the one a careless parser would read as "allow everyone".
	const r = await runFor(7123, {
		authorAllowlist: "# the maintainers who may land PRs\n",
	});
	assert(
		r.cap === "awaiting-human-merge" && r.log.mergeCmds.length === 0,
		`#2181: an allowlist that names no login lands nothing (cap ${JSON.stringify(r.cap)}, ${r.log.mergeCmds.length} merge call(s))`,
	);
	assert(
		(r.holdReason ?? "").includes("names no login"),
		`#2181 …and the park says the file names no login (${JSON.stringify((r.holdReason ?? "").slice(0, 150))})`,
	);
}
{
	// The author is unreadable because the forge did not answer. Distinct refusal, so
	// the operator is not sent to the allowlist to fix a forge read.
	const r = await runFor(7124, { evidenceAuthor: null });
	assert(
		r.cap === "awaiting-human-merge" && r.log.mergeCmds.length === 0,
		`#2181: a PR whose author the forge did not report is not landed (cap ${JSON.stringify(r.cap)}, ${r.log.mergeCmds.length} merge call(s))`,
	);
	assert(
		(r.holdReason ?? "").includes("could not be read") &&
			!(r.holdReason ?? "").includes("is not listed"),
		`#2181 …and is refused as an unreadable author, never as a person named unknown (${JSON.stringify((r.holdReason ?? "").slice(0, 150))})`,
	);
}
{
	// The list must be read at the cycle's BASE COMMIT, not from the working tree: a PR
	// that adds a permissive `.pi/merge-authors` cannot widen its own allowlist. The
	// fixture's `baseSha` is a real sha, so this asserts the read's SHAPE — every read
	// is of the form `<baseSha>:<path>`, and none is a bare path the working tree would
	// answer. (The unresolvable-base refusal is covered by the absent-file arm above:
	// with a sha base there is no resolve to fail, and inventing one would test the
	// fixture rather than the gate.)
	const r = await runFor(7125);
	const specs = r.log.allowlistReads.map(
		(c) => c.trim().split(/\s+/).pop() ?? "",
	);
	assert(
		specs.length >= 2 && specs.every((s) => s.startsWith(`${r.baseSha}:`)),
		`#2181: every allowlist read is of the form <baseSha>:<gate file>, never a bare path (${JSON.stringify(specs)})`,
	);
	assert(
		specs.every((s) => !s.startsWith("./") && !s.startsWith("/")),
		"#2181 …and no read is a working-tree path, so a PR cannot widen its own allowlist by committing one",
	);
}
{
	// The rule holds with the permission gate off. `PI_ENSEMBLE_MERGE_AUTHORITY=0`
	// turns off the permission and evidence gate only; a stranger's PR must still park.
	const r = await runFor(7126, {
		authorityGate: false,
		stateAuthor: "stranger",
	});
	assert(
		r.cap === "awaiting-human-merge" && r.log.mergeCmds.length === 0,
		`#2181: the permission switch is not an answer to the author rule (cap ${JSON.stringify(r.cap)}, ${r.log.mergeCmds.length} merge call(s))`,
	);
	assert(
		(r.holdReason ?? "").includes("stranger"),
		`#2181 …and it is the author that parked it, named (${JSON.stringify((r.holdReason ?? "").slice(0, 150))})`,
	);
}

{
	// The gate's own executor rejects (a wedged `gh`, an arm that throws rather than
	// answering). The rejection must not escape `runMerged`: an uncaught throw there
	// leaves the cycle parked with NO mergeHold behind it, which is the shape the
	// sweep and the handoff cannot explain — and the one act the gate guards is
	// irreversible, so a read that could not be made is a refusal, never a pass.
	const r = await runFor(7128, { allowlistThrows: true });
	assert(
		r.cap === "awaiting-human-merge" && r.log.mergeCmds.length === 0,
		`#2181: an author gate whose git read rejects parks and nothing merges (cap ${JSON.stringify(r.cap)}, ${r.log.mergeCmds.length} merge call(s))`,
	);
	assert(
		r.state?.pipelineState.mergeHold?.authorGateReason !== undefined &&
			r.state.pipelineState.mergeHold.authorGateReason.length > 0,
		`#2181 …and the park carries the author gate's own reason, not a bare cap-hit (${JSON.stringify(r.state?.pipelineState.mergeHold?.authorGateReason ?? null).slice(0, 160)})`,
	);
}

console.log(`\nexit ${exit}`);
process.exit(exit);
