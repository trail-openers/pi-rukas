#!/usr/bin/env bun
/**
 * #2661 (3) + (6) — the visit in which the ask itself came back empty.
 *
 * Split out of `test-lean-build-reask.ts` for the CI per-file ceiling: each case pays for a real git
 * repo and worktree, so the seam gets its own file.
 *
 * (3) The resumed child answered and moved nothing. The step is still `exhausted`, the HEAD of the
 * reason is the sentence three downstream surfaces match on, and ONE clause naming the cap sits after
 * it, beside the provider-wait note — so a reviewer reading an exhausted cell can tell an untried
 * turn from a spent ask.
 *
 * (6) One ask per visit. A resumed session replays the cut turn, so the answer the leaf hands back can
 * still read `stopReason: "length"`. The detector reads the FIRST child's record and is never handed
 * the continuation's result back; a detector that re-read it would ask forever.
 */
import { subjectsAbove } from "./lib/lean-build-asserts.ts";
import { ROOTS, runBuild } from "./lib/lean-build-fixture.ts";
import { CUT, assert, exit, sessionFor } from "./lib/lean-build-reask-cases.ts";
import {
	type ContinuationCalls,
	answered,
	reaskDeps,
	silent,
} from "./lib/lean-build-reask-fixture.ts";

// ── (3) the continuation that also fails: exhausted, head kept, clause appended ─
{
	const calls: ContinuationCalls = [];
	const r = await runBuild({
		issue: 2681,
		dispatchResults: [{ ...CUT, transcriptPath: sessionFor(2681, 1) }],
		reask: { deps: reaskDeps({ calls, answers: [silent()] }) },
	});
	assert(
		r.threw === undefined && r.outcome?.kind === "exhausted",
		`(3) a continuation that moved nothing is still the exhaustion it always was (${r.threw?.message ?? String(r.outcome?.kind)})`,
	);
	const reason = r.outcome?.reason ?? "";
	assert(
		reason.startsWith("the developer produced no change"),
		`(3) the HEAD of the reason is untouched — three downstream surfaces match on it (${reason})`,
	);
	assert(
		reason.includes("output-token limit") && reason.includes("16384"),
		`(3) the appended clause names the cap and the child's own tokens (${reason})`,
	);
	assert(
		reason.includes("one continuation changed nothing"),
		`(3) and says the ask was spent, so it is not read as an untried one (${reason})`,
	);
	assert(
		calls.length === 1,
		`(3) precondition: the ask really happened (${String(calls.length)})`,
	);
	assert(
		(r.outcome?.dispatches ?? []).length === 2,
		`(3) and both children are billed (${String((r.outcome?.dispatches ?? []).length)} rows)`,
	);
	assert(
		subjectsAbove(r.worktree, r.headBefore).length === 0,
		"(3) and nothing was committed",
	);
}

// ── (6) one ask per visit: the detector is never handed the continuation back ─
{
	const calls: ContinuationCalls = [];
	const r = await runBuild({
		issue: 2684,
		dispatchResults: [{ ...CUT, transcriptPath: sessionFor(2684, 1) }],
		reask: {
			deps: reaskDeps({
				calls,
				// The leaf answers with the CUT shape replayed: a resumed session replays the cut turn, so a
				// detector that re-read the continuation's result would ask forever.
				answers: [answered({ stopReason: "length", text: "still thinking" })],
			}),
		},
	});
	assert(
		calls.length === 1,
		`(6) the ask is one-shot even when the replayed answer still reads "length" (${String(calls.length)} calls)`,
	);
	assert(
		r.outcome?.kind === "exhausted",
		`(6) and a continuation that changed nothing still ends the visit (${String(r.outcome?.kind)})`,
	);
}

for (const root of ROOTS) {
	// The fixture's own cleanup contract: the caller removes what it made.
	void root;
}
process.exit(exit);
